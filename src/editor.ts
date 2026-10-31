import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildFloorMeshes, type MatName } from './geom/floor';
import { getMaterial } from './view/materials';
import {
  DX, DY, Dir, EndKey, HALF, HEIGHT_STEP, Model, Seg,
  axisOf, cloneModel, emptyModel, endZ, isFree, nodePorts, portCount, zAt,
} from './model/types';
import {
  addSegAtPort, blockToSeg, cutJoint, cutSeg, deleteElem, extendTo, insertJoint, makeBranch,
  makeCorner, normalize, setBlockStyle, setChainStyle, shiftDownstream, shiftFreeEnd, toggleEnd, tryConnect,
} from './model/ops';

export type Tool = 'edit' | 'sink' | 'cut';

interface Pick {
  id: number;
  kind: 'seg' | 'node';
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

type Grow = (m: Model) => { seg: number; key: EndKey } | null;
type HeightTarget = (m: Model) => number | { seg: number; key: EndKey } | null;

type Drag =
  | { type: 'pending'; pick: Pick; sx: number; sy: number; snapshot: Model }
  | { type: 'grow'; snapshot: Model; grow: Grow; planeZ: number; axis: 0 | 1 }
  | { type: 'height'; snapshot: Model; target: HeightTarget; plane: THREE.Plane; z0: number }
  | { type: 'orbit' };

const STORAGE_KEY = 'bvm.model';

export class Editor {
  model: Model;
  tool: Tool = 'edit';
  /** 长度吸附步长；按住 Ctrl 时临时使用 1.25 */
  step = 5;
  onStatus: (s: string) => void = () => {};
  onChange: () => void = () => {};

  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private floor = new THREE.Group();
  private overlay = new THREE.Group();
  private pickables: THREE.Mesh[] = [];
  private raycaster = new THREE.Raycaster();
  private drag: Drag | null = null;
  private hover: Pick | null = null;
  private selected: number | null = null;
  private mouse = new THREE.Vector2();
  private ctrl = false;

  constructor(private host: HTMLElement) {
    this.model = this.loadLocal() ?? emptyModel();

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x1d2330);
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 4000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(-30, -40, 40);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = { LEFT: -1 as THREE.MOUSE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.controls.target.set(0, 0, 0);
    this.controls.enableDamping = false;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-0.4, -0.7, 1);
    this.scene.add(sun);

    const grid = new THREE.GridHelper(400, 80, 0x3a4458, 0x2a3242);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(2.5, 2.5, -0.08);
    this.scene.add(grid);

    this.scene.add(this.floor, this.overlay);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('keydown', (e) => this.onKey(e));
    window.addEventListener('keyup', (e) => { this.ctrl = e.ctrlKey; });
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();

    this.rebuild();
    this.renderer.setAnimationLoop(() => this.renderer.render(this.scene, this.camera));
  }

  // ---------------- 公共接口 ----------------

  setTool(t: Tool) { this.tool = t; this.updateStatus(); }

  undo() {
    const s = this.undoStack.pop();
    if (!s) return;
    this.redoStack.push(JSON.stringify(this.model));
    this.model = JSON.parse(s);
    this.commitView();
  }

  redo() {
    const s = this.redoStack.pop();
    if (!s) return;
    this.undoStack.push(JSON.stringify(this.model));
    this.model = JSON.parse(s);
    this.commitView();
  }

  reset() {
    this.pushUndo(this.model);
    this.model = emptyModel();
    this.commitView();
  }

  exportJSON(): string { return JSON.stringify({ format: 'bvm', version: 1, model: this.model }, null, 1); }

  importJSON(text: string) {
    const data = JSON.parse(text);
    if (data.format !== 'bvm') throw new Error('不是 bvm 工程文件');
    this.pushUndo(this.model);
    this.model = data.model;
    this.commitView();
  }

  /** 世界坐标 -> 页面像素坐标（调试 / 自动化测试用） */
  projectToClient(x: number, y: number, z: number) {
    this.camera.updateMatrixWorld();
    const v = new THREE.Vector3(x, y, z).project(this.camera);
    const r = this.renderer.domElement.getBoundingClientRect();
    return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
  }

  setView(target: [number, number, number], pos: [number, number, number]) {
    this.controls.target.set(...target);
    this.camera.position.set(...pos);
    this.controls.update();
  }

  // ---------------- 渲染 ----------------

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
  }

  private rebuild() {
    for (const c of this.floor.children) (c as THREE.Mesh).geometry.dispose();
    this.floor.clear();
    this.pickables = [];
    for (const em of buildFloorMeshes(this.model)) {
      for (const [mat, part] of Object.entries(em.parts)) {
        if (!part || part.pos.length === 0) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(part.uv, 2));
        g.computeVertexNormals();
        const mesh = new THREE.Mesh(g, getMaterial(mat as MatName));
        mesh.userData = { id: em.id, kind: em.kind };
        this.floor.add(mesh);
        this.pickables.push(mesh);
      }
    }
    this.rebuildOverlay();
  }

  private rebuildOverlay() {
    for (const c of this.overlay.children) (c as THREE.Line).geometry?.dispose();
    this.overlay.clear();
    const m = this.model;
    // 截面接头
    const pts: number[] = [];
    for (const n of Object.values(m.nodes)) {
      if (n.kind !== 'joint') continue;
      const ax = n.axis ?? 0;
      const px = ax === 0 ? 0 : 1, py = ax === 0 ? 1 : 0;
      pts.push(n.x - px * HALF, n.y - py * HALF, n.z + 0.03, n.x + px * HALF, n.y + py * HALF, n.z + 0.03);
    }
    if (pts.length) this.overlay.add(lines(pts, 0x55ccff));
    // 悬停与选中
    if (this.hover && !this.drag) this.overlay.add(this.outline(this.hover.id, 0xffffff, 0.35));
    if (this.selected !== null) this.overlay.add(this.outline(this.selected, 0xffcc33, 1));
    // 截面预览（Alt 改高度 / 分隔工具）
    const sec = this.hoverSection();
    if (sec) {
      const { s, t } = sec;
      const D = [DX[s.dir], DY[s.dir]], P = [-D[1], D[0]];
      const cx = s.x + D[0] * t, cy = s.y + D[1] * t, z = zAt(m, s, t) + 0.05;
      this.overlay.add(lines([cx - P[0] * HALF, cy - P[1] * HALF, z, cx + P[0] * HALF, cy + P[1] * HALF, z],
        this.tool === 'cut' ? 0xff5566 : 0x66ff99));
    }
  }

  private outline(id: number, color: number, opacity: number) {
    const g = new THREE.Group();
    for (const mesh of this.pickables) {
      if (mesh.userData.id !== id) continue;
      const e = new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry, 30),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
      e.renderOrder = 10;
      g.add(e);
    }
    return g;
  }

  // ---------------- 拾取 ----------------

  private setMouse(e: PointerEvent | MouseEvent) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.mouse.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(this.mouse, this.camera);
  }

  private pick(): Pick | null {
    const hit = this.raycaster.intersectObjects(this.pickables, false)[0];
    if (!hit || !hit.face) return null;
    return { id: hit.object.userData.id, kind: hit.object.userData.kind, point: hit.point.clone(), normal: hit.face.normal.clone() };
  }

  private rayOnPlaneZ(z: number): THREE.Vector3 | null {
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), p);
  }

  private curStep() { return this.ctrl ? 1.25 : this.step; }
  /** 截面 / 端点吸附：落在路块边界网格（2.5 + k·step）上 */
  private snapEdge(c: number) { const s = this.curStep(); return HALF + Math.round((c - HALF) / s) * s; }
  /** 路块中心吸附 */
  private snapCenter(c: number) { const s = this.curStep(); return Math.round(c / s) * s; }

  private segLocal(s: Seg, p: THREE.Vector3) {
    const t = (p.x - s.x) * DX[s.dir] + (p.y - s.y) * DY[s.dir];
    const lat = (p.x - s.x) * -DY[s.dir] + (p.y - s.y) * DX[s.dir];
    return { t, lat };
  }

  /** 世界轴向坐标 -> 直道参数 t */
  private tOfCoord(s: Seg, c: number) {
    return axisOf(s.dir) === 0 ? (c - s.x) * DX[s.dir] : (c - s.y) * DY[s.dir];
  }

  private hoverSection(): { s: Seg; t: number } | null {
    if (this.drag || !this.hover || this.hover.kind !== 'seg') return null;
    if (!(this.tool === 'cut' || this.altHeld)) return null;
    const s = this.model.segs[this.hover.id];
    if (!s) return null;
    const c = this.snapEdge(axisOf(s.dir) === 0 ? this.hover.point.x : this.hover.point.y);
    const t = this.tOfCoord(s, c);
    if (t < -1e-6 || t > s.len + 1e-6) return null;
    return { s, t };
  }

  private altHeld = false;

  // ---------------- 输入 ----------------

  private onDown(e: PointerEvent) {
    this.ctrl = e.ctrlKey;
    if (e.button !== 0) { this.drag = { type: 'orbit' }; return; }
    this.setMouse(e);
    const p = this.pick();
    if (!p) { this.selected = null; this.rebuildOverlay(); return; }
    e.preventDefault();
    const snapshot = cloneModel(this.model);

    if (this.tool !== 'edit') {
      this.clickTool(p);
      return;
    }
    if (e.altKey) {
      const target = this.heightTarget(p);
      if (!target) return;
      const n = new THREE.Vector3().subVectors(this.camera.position, p.point).setZ(0).normalize();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p.point);
      this.drag = { type: 'height', snapshot, target, plane, z0: p.point.z };
      return;
    }
    this.drag = { type: 'pending', pick: p, sx: e.clientX, sy: e.clientY, snapshot };
  }

  private onMove(e: PointerEvent) {
    this.ctrl = e.ctrlKey;
    this.altHeld = e.altKey;
    this.setMouse(e);
    const d = this.drag;
    if (!d) {
      const p = this.pick();
      const changed = (p?.id ?? null) !== (this.hover?.id ?? null);
      this.hover = p;
      if (changed || this.tool === 'cut' || e.altKey) this.rebuildOverlay();
      this.updateStatus();
      return;
    }
    if (d.type === 'orbit') return;
    if (d.type === 'pending') {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) return;
      const next = this.classifyDrag(d, e.shiftKey);
      this.drag = next;
      if (!next) return;
    }
    const dd = this.drag!;
    if (dd.type === 'grow') {
      const hit = this.rayOnPlaneZ(dd.planeZ);
      if (!hit) return;
      const m = cloneModel(dd.snapshot);
      const r = dd.grow(m);
      if (!r) return;
      extendTo(m, r.seg, r.key, this.snapEdge(dd.axis === 0 ? hit.x : hit.y));
      this.model = m;
      this.rebuild();
    } else if (dd.type === 'height') {
      const hit = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(dd.plane, hit)) return;
      const dz = Math.round((hit.z - dd.z0) / HEIGHT_STEP) * HEIGHT_STEP;
      const m = cloneModel(dd.snapshot);
      const t = dd.target(m);
      if (t === null) return;
      if (typeof t === 'number') shiftDownstream(m, t, dz);
      else shiftFreeEnd(m, t.seg, t.key, dz);
      this.model = m;
      this.rebuild();
      this.onStatus(`高度变化 ${dz >= 0 ? '+' : ''}${dz}`);
    }
  }

  private onUp(e: PointerEvent) {
    const d = this.drag;
    this.drag = null;
    if (!d || d.type === 'orbit') return;
    if (d.type === 'pending') {
      // 单击：选中
      this.selected = d.pick.id;
      this.rebuildOverlay();
      this.updateStatus();
      return;
    }
    if (d.type === 'grow') {
      const m = this.model;
      // 找出正在生长的端点，尝试与已有路面连接
      const probe = cloneModel(d.snapshot);
      const r = d.grow(probe);
      if (r && m.segs[r.seg]) tryConnect(m, r.seg, r.key);
    }
    normalize(this.model);
    this.pushUndo(d.snapshot);
    this.commitView();
    void e;
  }

  private onKey(e: KeyboardEvent) {
    this.ctrl = e.ctrlKey;
    if (e.key === 'Alt') { e.preventDefault(); this.altHeld = true; this.rebuildOverlay(); }
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === 'z') { e.preventDefault(); e.shiftKey ? this.redo() : this.undo(); return; }
    if (e.ctrlKey && k === 'y') { e.preventDefault(); this.redo(); return; }
    if (k === 'delete' || k === 'backspace') {
      if (this.selected === null) return;
      this.mutate((m) => deleteElem(m, this.selected!));
      this.selected = null;
      this.rebuildOverlay();
      return;
    }
    if (k === 'e') this.toggleHoveredEnd();
    if (k === '1') this.setTool('edit');
    if (k === '2') this.setTool('sink');
    if (k === '3') this.setTool('cut');
    if (k === 'escape') this.cancelDrag();
    this.onChange();
  }

  private cancelDrag() {
    const d = this.drag;
    if (d && 'snapshot' in d) { this.model = d.snapshot; this.rebuild(); }
    this.drag = null;
  }

  // ---------------- 操作分派 ----------------

  /** 拖动超过阈值后，根据起点和拖动方向决定是拉长、拐弯还是开路口。 */
  private classifyDrag(d: Extract<Drag, { type: 'pending' }>, shift: boolean): Drag | null {
    const p = d.pick;
    const m = d.snapshot;
    const cur = this.rayOnPlaneZ(p.point.z);
    if (!cur) return null;
    const dx = cur.x - p.point.x, dy = cur.y - p.point.y;
    const dm: Dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : (dy >= 0 ? 1 : 3);
    const growDrag = (grow: Grow, z: number): Drag => ({ type: 'grow', snapshot: m, grow, planeZ: z, axis: axisOf(dm) });

    if (p.kind === 'seg') {
      const s = m.segs[p.id];
      const { t } = this.segLocal(s, p.point);
      if (axisOf(dm) === axisOf(s.dir)) {
        const k: EndKey = t > s.len / 2 ? 'b' : 'a';
        if (!isFree(s[k])) return null;
        return growDrag(() => ({ seg: s.id, key: k }), endZ(m, s, k));
      }
      let endK: EndKey | null = null;
      if (isFree(s.b) && t > s.len - 5) endK = 'b';
      else if (isFree(s.a) && t < 5) endK = 'a';
      if (endK && !shift && s.len >= 5) {
        const k = endK;
        return growDrag((mm) => { const id = makeCorner(mm, s.id, k, dm); return id === null ? null : { seg: id, key: 'b' }; }, zAt(m, s, k === 'b' ? s.len - HALF : HALF));
      }
      const c = this.snapCenter(axisOf(s.dir) === 0 ? p.point.x : p.point.y);
      const tc = Math.min(Math.max(this.tOfCoord(s, c), HALF), s.len - HALF);
      return growDrag((mm) => { const id = makeBranch(mm, s.id, tc, dm); return id === null ? null : { seg: id, key: 'b' }; }, zAt(m, s, tc));
    }
    const n = m.nodes[p.id];
    if (!n || n.kind !== 'block') return null;
    const ports = nodePorts(m, n.id);
    if (portCount(ports) === 0) return growDrag((mm) => ({ seg: blockToSeg(mm, n.id, dm), key: 'b' }), n.z);
    if (ports[dm]) return null;
    return growDrag((mm) => { const id = addSegAtPort(mm, n.id, dm); return id === null ? null : { seg: id, key: 'b' }; }, n.z);
  }

  private heightTarget(p: Pick): HeightTarget | null {
    const m = this.model;
    if (p.kind === 'node') return () => p.id;
    const s = m.segs[p.id];
    const { t } = this.segLocal(s, p.point);
    // 靠近接头 / 节点时优先选中它
    if (t < 1 && !isFree(s.a)) { const id = s.a.node; return () => id; }
    if (t > s.len - 1 && !isFree(s.b)) { const id = s.b.node; return () => id; }
    const c = this.snapEdge(axisOf(s.dir) === 0 ? p.point.x : p.point.y);
    const ts = this.tOfCoord(s, c);
    if (ts <= 1e-6) return isFree(s.a) ? () => ({ seg: s.id, key: 'a' }) : () => (s.a as { node: number }).node;
    if (ts >= s.len - 1e-6) return isFree(s.b) ? () => ({ seg: s.id, key: 'b' }) : () => (s.b as { node: number }).node;
    return (mm) => insertJoint(mm, s.id, ts);
  }

  private clickTool(p: Pick) {
    const m = this.model;
    if (this.tool === 'sink') {
      if (p.kind === 'seg') {
        const s = m.segs[p.id];
        this.mutate((mm) => setChainStyle(mm, s.id, s.style === 'sink' ? 'normal' : 'sink'));
      } else {
        const n = m.nodes[p.id];
        if (n.kind === 'block') this.mutate((mm) => setBlockStyle(mm, n.id, n.style === 'sink' ? 'normal' : 'sink'));
      }
      return;
    }
    if (this.tool === 'cut' && p.kind === 'seg') {
      const s = m.segs[p.id];
      const { t } = this.segLocal(s, p.point);
      if (t < 1 && !isFree(s.a) && m.nodes[s.a.node].kind === 'joint') { const id = s.a.node; this.mutate((mm) => cutJoint(mm, id)); return; }
      if (t > s.len - 1 && !isFree(s.b) && m.nodes[s.b.node].kind === 'joint') { const id = s.b.node; this.mutate((mm) => cutJoint(mm, id)); return; }
      const ts = this.tOfCoord(s, this.snapEdge(axisOf(s.dir) === 0 ? p.point.x : p.point.y));
      this.mutate((mm) => cutSeg(mm, s.id, ts));
    }
  }

  private toggleHoveredEnd() {
    const h = this.hover;
    if (!h || h.kind !== 'seg') return;
    const s = this.model.segs[h.id];
    const { t } = this.segLocal(s, h.point);
    const k: EndKey = t > s.len / 2 ? 'b' : 'a';
    if (!isFree(s[k])) return;
    this.mutate((m) => toggleEnd(m, s.id, k));
  }

  private mutate(fn: (m: Model) => void) {
    const before = cloneModel(this.model);
    fn(this.model);
    normalize(this.model);
    this.pushUndo(before);
    this.commitView();
  }

  private pushUndo(m: Model) {
    this.undoStack.push(JSON.stringify(m));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  private commitView() {
    for (const id of [this.selected]) if (id !== null && !this.model.segs[id] && !this.model.nodes[id]) this.selected = null;
    this.hover = null;
    this.rebuild();
    this.saveLocal();
    this.updateStatus();
    this.onChange();
  }

  private saveLocal() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.model)); } catch { /* 忽略 */ }
  }

  private loadLocal(): Model | null {
    try {
      const s = localStorage.getItem(STORAGE_KEY);
      return s ? JSON.parse(s) : null;
    } catch { return null; }
  }

  private updateStatus() {
    const h = this.hover;
    const m = this.model;
    let info = '';
    if (h) {
      if (h.kind === 'seg' && m.segs[h.id]) {
        const s = m.segs[h.id];
        const za = endZ(m, s, 'a'), zb = endZ(m, s, 'b');
        const ends = (['a', 'b'] as EndKey[]).map((k) => {
          const e = s[k];
          return isFree(e) ? (e.style === 'closed' ? '封闭' : '开放') : '连接';
        });
        info = `直道 #${s.id}  长 ${fmt(s.len)}  高 ${fmt(za)}→${fmt(zb)}  ${s.style === 'sink' ? '凹槽' : '普通'}  端点 ${ends.join(' / ')}`;
      } else if (m.nodes[h.id]) {
        const n = m.nodes[h.id];
        const kind = n.kind === 'transition' ? '平凹转换' : ['1×1', '端头', '直通', '拐角/直通', 'T 字路口', '十字路口'][portCount(nodePorts(m, n.id))] ?? '路块';
        info = `${kind} #${n.id}  高 ${fmt(n.z)}  ${n.style === 'sink' ? '凹槽' : '普通'}`;
      }
    }
    const hints: Record<Tool, string> = {
      edit: '拖端点：拉长 · 从侧面拖：拐弯/路口（Shift 强制路口）· Alt+拖：改高度 · E：切换端点封闭/开放 · Ctrl：精细步长',
      sink: '点击直道或路块：切换普通/凹槽（自动插入平凹转换）',
      cut: '点击截面：把花纹分开成两个端点',
    };
    this.onStatus(`${info ? info + '　|　' : ''}${hints[this.tool]}`);
  }
}

function lines(pts: number[], color: number) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  const l = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, depthTest: false }));
  l.renderOrder = 11;
  return l;
}

const fmt = (v: number) => (Math.round(v * 1000) / 1000).toString();
