import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { buildElem, computeChains, elemKey, type MatName } from './geom/floor';
import { getMaterial } from './view/materials';
import { Fx, rectSegs } from './view/fx';
import { lerpModel } from './view/tween';
import {
  DX, DY, Dir, EndKey, HALF, HEIGHT_STEP, Model, Seg,
  axisOf, cloneModel, emptyModel, endPos, endZ, isFree, nodePorts, opp, portCount, zAt,
} from './model/types';
import {
  addSegAtPort, applyConnection, blockToSeg, component, cutJoint, cutSeg, deleteElem, extendTo,
  findConnection, insertJoint, isSloped, makeBranch, makeCorner, moveIds, normalize, setBlockStyle,
  setChainStyle, shiftDownstream, shiftFreeEnd, toggleEnd, tryConnect,
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

/** Shift 悬停时的分叉候选 */
interface BranchCand {
  valid: boolean;
  reason?: string;
  grow: Grow;
  /** 示意框中心与朝向 */
  cx: number; cy: number; z: number; dir: Dir;
  /** 是否要画出新路块（在已有路块的空端口上开分叉时不需要） */
  newBlock: boolean;
}

type Drag =
  | { type: 'pending'; pick: Pick; sx: number; sy: number; snapshot: Model }
  | { type: 'grow'; snapshot: Model; grow: Grow; planeZ: number; axis: 0 | 1 }
  | { type: 'move'; snapshot: Model; ids: Set<number>; start: THREE.Vector3 }
  | { type: 'height'; snapshot: Model; target: HeightTarget; plane: THREE.Plane; z0: number }
  | { type: 'orbit' };

interface MenuItem { label: string; hint?: string; action?: () => void; disabled?: boolean }

const STORAGE_KEY = 'bvm.model';
const MOVE_TAU = 0.045;

const C_HOVER = 0xdfe8ff;
const C_SELECT = 0xffc640;
const C_SECTION = 0x66ffaa;
const C_CUT = 0xff5d73;
const C_BRANCH = 0x5cc8ff;
const C_INVALID = 0xff5d73;
const C_CONNECT = 0x7dff9a;
const C_END = 0xffb15c;
const C_JOINT = 0x55ccff;
const C_ROOT = 0xffd76a;

export class Editor {
  model: Model;
  tool: Tool = 'edit';
  /** 长度吸附步长；按住 Ctrl 时临时使用 1.25 */
  step = 5;
  onStatus: (s: string) => void = () => {};
  onChange: () => void = () => {};

  /** 正在显示的模型（向 model 平滑过渡） */
  private display: Model;
  private meshCache = new Map<number, { key: string; meshes: THREE.Mesh[] }>();
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private floor = new THREE.Group();
  private fx = new Fx();
  private pickables: THREE.Mesh[] = [];
  private raycaster = new THREE.Raycaster();
  private drag: Drag | null = null;
  private hover: Pick | null = null;
  private selected: number | null = null;
  private mouse = new THREE.Vector2();
  private mods = { ctrl: false, shift: false, alt: false };
  private branch: BranchCand | null = null;
  private growEnd: { seg: number; key: EndKey } | null = null;
  private menu: HTMLDivElement;
  private flash: { text: string; until: number } | null = null;
  private clock = new THREE.Clock();
  private overlayDirty = true;
  private hintKeys = new Set<string>();

  constructor(private host: HTMLElement) {
    this.model = this.loadLocal() ?? emptyModel();
    this.display = this.model;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    host.appendChild(this.renderer.domElement);

    this.scene.background = new THREE.Color(0x1d2330);
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 4000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(-30, -40, 40);

    // 中键环视，Shift+中键平移（OrbitControls 内置行为），滚轮缩放；左键编辑，右键菜单
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = { LEFT: -1 as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: -1 as THREE.MOUSE };
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.18;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-0.4, -0.7, 1);
    this.scene.add(sun);

    const grid = new THREE.GridHelper(400, 80, 0x3a4458, 0x2a3242);
    grid.rotation.x = Math.PI / 2;
    grid.position.set(2.5, 2.5, -0.08);
    this.scene.add(grid);

    this.scene.add(this.floor, this.fx.group);

    this.menu = document.createElement('div');
    this.menu.className = 'ctx-menu';
    host.appendChild(this.menu);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => { this.mods = { ctrl: false, shift: false, alt: false }; this.overlayDirty = true; });
    window.addEventListener('pointerdown', (e) => { if (!this.menu.contains(e.target as Node)) this.hideMenu(); });
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();

    this.syncMeshes();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------------- 公共接口 ----------------

  setTool(t: Tool) { this.tool = t; this.overlayDirty = true; this.updateStatus(); this.onChange(); }

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

  // ---------------- 渲染循环 ----------------

  private frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.display !== this.model) {
      const r = lerpModel(this.display, this.model, 1 - Math.exp(-dt / MOVE_TAU));
      this.display = r.done ? this.model : r.model;
      this.syncMeshes();
      this.overlayDirty = true;
    }
    if (this.overlayDirty) { this.overlayDirty = false; this.updateOverlay(); }
    this.fx.tick(dt);
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / Math.max(h, 1);
    this.camera.updateProjectionMatrix();
    this.fx.setResolution(w, h);
  }

  /** 按缓存键增量重建网格 */
  private syncMeshes() {
    const m = this.display;
    const chains = computeChains(m);
    const ids = new Set([...Object.keys(m.segs), ...Object.keys(m.nodes)].map(Number));
    for (const [id, c] of this.meshCache) {
      if (ids.has(id)) continue;
      for (const mesh of c.meshes) { mesh.geometry.dispose(); this.floor.remove(mesh); }
      this.meshCache.delete(id);
    }
    for (const id of ids) {
      const key = elemKey(m, id, chains);
      const cached = this.meshCache.get(id);
      if (cached && cached.key === key) continue;
      if (cached) for (const mesh of cached.meshes) { mesh.geometry.dispose(); this.floor.remove(mesh); }
      const em = buildElem(m, id, chains);
      const meshes: THREE.Mesh[] = [];
      for (const [mat, part] of Object.entries(em?.parts ?? {})) {
        if (!part || part.pos.length === 0) continue;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
        g.setAttribute('uv', new THREE.Float32BufferAttribute(part.uv, 2));
        g.computeVertexNormals();
        const mesh = new THREE.Mesh(g, getMaterial(mat as MatName));
        mesh.userData = { id, kind: em!.kind };
        this.floor.add(mesh);
        meshes.push(mesh);
      }
      this.meshCache.set(id, { key, meshes });
    }
    this.pickables = [...this.meshCache.values()].flatMap((c) => c.meshes);
  }

  // ---------------- 叠加层 ----------------

  private updateOverlay() {
    const m = this.display;
    const fx = this.fx;
    const shown = new Set<string>();
    const show = (key: string, segs: number[], color: number, opts: Parameters<Fx['set']>[3]) => {
      fx.set(key, segs, color, opts);
      shown.add(key);
    };

    // 截面接头
    const joints: number[] = [];
    for (const n of Object.values(m.nodes)) {
      if (n.kind !== 'joint') continue;
      const [px, py] = n.axis === 0 ? [0, 1] : [1, 0];
      joints.push(n.x - px * HALF, n.y - py * HALF, n.z + 0.03, n.x + px * HALF, n.y + py * HALF, n.z + 0.03);
    }
    show('joints', joints, C_JOINT, { width: 1.5, opacity: 0.7 });

    // 高度基准（根）
    const rc = this.elemCenter(m, m.root);
    if (rc) show('root', diamondSegs(1.1), C_ROOT, { width: 2, opacity: 0.8, pos: [rc[0], rc[1], rc[2] + 0.06] });

    // 悬停 / 选中
    const h = this.drag ? null : this.hover;
    if (h && h.id !== this.selected) {
      show(`hover:${h.id}`, this.outlineSegs(h.id), C_HOVER, { width: 1.5, opacity: 0.45, gradient: true });
    }
    if (this.selected !== null) show('select', this.outlineSegs(this.selected), C_SELECT, { width: 2.5, gradient: true });

    // Shift：分叉示意框
    this.branch = null;
    if (h && this.tool === 'edit' && this.mods.shift && !this.mods.alt) {
      const b = this.branchCandidate(h);
      this.branch = b;
      if (b) show('branch', branchSegs(b), b.valid ? C_BRANCH : C_INVALID, { width: 2.5, pos: [b.cx, b.cy, b.z + 0.08] });
    }

    // Alt / 分隔工具：截面预览
    const sec = this.hoverSection();
    if (sec) {
      const { s, t } = sec;
      const P = [-DY[s.dir], DX[s.dir]];
      show('section', [-P[0] * HALF, -P[1] * HALF, 0, P[0] * HALF, P[1] * HALF, 0],
        this.tool === 'cut' ? C_CUT : C_SECTION,
        { width: 3, pos: [s.x + DX[s.dir] * t, s.y + DY[s.dir] * t, zAt(this.model, s, t) + 0.06] });
    }

    // 普通悬停在端点区域：高亮将被拖动的端点截面
    if (h && this.tool === 'edit' && !this.mods.shift && !this.mods.alt && h.kind === 'seg') {
      const s = this.model.segs[h.id];
      const k = s ? this.endRegion(s, this.segLocal(s, h.point).t) : null;
      if (s && k) {
        const [ex, ey] = endPos(s, k);
        const P = [-DY[s.dir], DX[s.dir]];
        show('end', [
          -P[0] * HALF, -P[1] * HALF, 0, P[0] * HALF, P[1] * HALF, 0,
          -P[0] * HALF, -P[1] * HALF, 0, -P[0] * HALF, -P[1] * HALF, -1.5,
          P[0] * HALF, P[1] * HALF, 0, P[0] * HALF, P[1] * HALF, -1.5,
        ], C_END, { width: 3, gradient: true, pos: [ex, ey, endZ(this.model, s, k) + 0.04] });
      }
    }

    // 拖拽中：可连接提示
    const conn = this.dragConnection();
    if (conn) show('connect', rectSegs(HALF, HALF, 0), C_CONNECT, { width: 3, pulse: true, pos: [conn.x, conn.y, conn.z + 0.1] });

    for (const key of this.hintKeys) if (!shown.has(key)) fx.hide(key);
    this.hintKeys = shown;
  }

  private outlineSegs(id: number): number[] {
    const out: number[] = [];
    for (const mesh of this.meshCache.get(id)?.meshes ?? []) {
      const e = new THREE.EdgesGeometry(mesh.geometry, 30);
      out.push(...(e.getAttribute('position').array as Float32Array));
      e.dispose();
    }
    return out;
  }

  private elemCenter(m: Model, id: number | null): [number, number, number] | null {
    if (id === null) return null;
    const n = m.nodes[id];
    if (n) return [n.x, n.y, n.z];
    const s = m.segs[id];
    if (!s) return null;
    const t = Math.min(HALF, s.len / 2);
    return [s.x + DX[s.dir] * t, s.y + DY[s.dir] * t, zAt(m, s, t)];
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
    const { id, kind } = hit.object.userData;
    if (!this.model.segs[id] && !this.model.nodes[id]) return null;
    return { id, kind, point: hit.point.clone(), normal: hit.face.normal.clone() };
  }

  private rayOnPlaneZ(z: number): THREE.Vector3 | null {
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), p);
  }

  private curStep() { return this.mods.ctrl ? 1.25 : this.step; }
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

  /** 点击位置所属的自由端（端点区域最多 3.75，短路段取三成，中间留给平移） */
  private endRegion(s: Seg, t: number): EndKey | null {
    const r = Math.min(3.75, s.len * 0.3);
    const da = isFree(s.a) && t < r ? t : Infinity;
    const db = isFree(s.b) && t > s.len - r ? s.len - t : Infinity;
    if (da === Infinity && db === Infinity) return null;
    return da <= db ? 'a' : 'b';
  }

  private hoverSection(): { s: Seg; t: number } | null {
    if (this.drag || !this.hover || this.hover.kind !== 'seg') return null;
    if (!(this.tool === 'cut' || (this.tool === 'edit' && this.mods.alt))) return null;
    const s = this.model.segs[this.hover.id];
    if (!s) return null;
    const { t: tr } = this.segLocal(s, this.hover.point);
    if (tr < 1 && !isFree(s.a)) return { s, t: 0 };
    if (tr > s.len - 1 && !isFree(s.b)) return { s, t: s.len };
    const t = this.tOfCoord(s, this.snapEdge(axisOf(s.dir) === 0 ? this.hover.point.x : this.hover.point.y));
    if (t < -1e-6 || t > s.len + 1e-6) return null;
    return { s, t };
  }

  private branchCandidate(p: Pick): BranchCand | null {
    const m = this.model;
    if (p.kind === 'seg') {
      const s = m.segs[p.id];
      if (!s) return null;
      const { lat } = this.segLocal(s, p.point);
      const left = ((s.dir + 1) % 4) as Dir;
      const dir = lat >= 0 ? left : opp(left);
      const c = this.snapCenter(axisOf(s.dir) === 0 ? p.point.x : p.point.y);
      const tc = Math.min(Math.max(this.tOfCoord(s, c), HALF), s.len - HALF);
      const base = { cx: s.x + DX[s.dir] * tc, cy: s.y + DY[s.dir] * tc, z: zAt(m, s, tc), dir, newBlock: true };
      if (isSloped(m, s)) return { ...base, valid: false, reason: '斜坡上不能开分叉', grow: () => null };
      if (s.len < 5 - 1e-6) return { ...base, valid: false, reason: '路段太短，放不下路口', grow: () => null };
      return { ...base, valid: true, grow: (mm) => { const id = makeBranch(mm, s.id, tc, dir); return id === null ? null : { seg: id, key: 'b' }; } };
    }
    const n = m.nodes[p.id];
    if (!n || n.kind !== 'block') return null;
    const dx = p.point.x - n.x, dy = p.point.y - n.y;
    const dir: Dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : (dy >= 0 ? 1 : 3);
    const ports = nodePorts(m, n.id);
    const base = { cx: n.x, cy: n.y, z: n.z, dir, newBlock: false };
    if (ports[dir]) return { ...base, valid: false, reason: '这一侧已经连着路了', grow: () => null };
    if (portCount(ports) === 0) return { ...base, valid: true, grow: (mm) => ({ seg: blockToSeg(mm, n.id, dir), key: 'b' }) };
    return { ...base, valid: true, grow: (mm) => { const id = addSegAtPort(mm, n.id, dir); return id === null ? null : { seg: id, key: 'b' }; } };
  }

  /** 拖拽中可连接的位置：方框画在连接截面外侧那一格 */
  private dragConnection(): { x: number; y: number; z: number } | null {
    const d = this.drag;
    if (!d) return null;
    const m = this.model;
    const box = (segId: number, k: EndKey, z: number) => {
      const s = m.segs[segId];
      const [x, y] = endPos(s, k);
      const out = k === 'a' ? opp(s.dir) : s.dir;
      return { x: x + DX[out] * HALF, y: y + DY[out] * HALF, z };
    };
    if (d.type === 'grow' && this.growEnd && m.segs[this.growEnd.seg]) {
      const c = findConnection(m, this.growEnd.seg, this.growEnd.key, true);
      return c ? box(this.growEnd.seg, this.growEnd.key, c.z) : null;
    }
    if (d.type === 'move') {
      for (const id of d.ids) {
        const s = m.segs[id];
        if (!s) continue;
        for (const k of ['a', 'b'] as EndKey[]) {
          if (!isFree(s[k])) continue;
          const c = findConnection(m, s.id, k, false);
          if (c) return box(s.id, k, c.z);
        }
      }
    }
    return null;
  }

  // ---------------- 输入 ----------------

  private syncMods(e: { ctrlKey: boolean; shiftKey: boolean; altKey: boolean }) {
    if (e.ctrlKey === this.mods.ctrl && e.shiftKey === this.mods.shift && e.altKey === this.mods.alt) return;
    this.mods = { ctrl: e.ctrlKey, shift: e.shiftKey, alt: e.altKey };
    this.overlayDirty = true;
    this.updateStatus();
  }

  private onDown(e: PointerEvent) {
    this.syncMods(e);
    if (e.button === 1) { this.drag = { type: 'orbit' }; return; }
    if (e.button !== 0) return;
    this.setMouse(e);
    const p = this.pick();
    if (!p) { this.select(null); return; }
    e.preventDefault();
    const snapshot = cloneModel(this.model);

    if (this.tool !== 'edit') { this.clickTool(p); return; }
    if (e.altKey) {
      const target = this.heightTarget(p);
      if (!target) return;
      const n = new THREE.Vector3().subVectors(this.camera.position, p.point).setZ(0).normalize();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p.point);
      this.drag = { type: 'height', snapshot, target, plane, z0: p.point.z };
      return;
    }
    if (e.shiftKey) {
      const b = this.branchCandidate(p);
      if (!b || !b.valid) { if (b?.reason) this.flashStatus(b.reason); return; }
      this.drag = { type: 'grow', snapshot, grow: b.grow, planeZ: b.z, axis: axisOf(b.dir) };
      this.overlayDirty = true;
      return;
    }
    this.drag = { type: 'pending', pick: p, sx: e.clientX, sy: e.clientY, snapshot };
  }

  private onMove(e: PointerEvent) {
    this.syncMods(e);
    this.setMouse(e);
    const d = this.drag;
    if (!d) {
      const p = this.pick();
      const changed = (p?.id ?? null) !== (this.hover?.id ?? null);
      this.hover = p;
      if (changed || p) this.overlayDirty = true;
      if (changed) this.updateStatus();
      return;
    }
    if (d.type === 'orbit') return;
    if (d.type === 'pending') {
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 6) return;
      this.drag = this.classifyDrag(d);
      this.overlayDirty = true;
      if (!this.drag) return;
    }
    const dd = this.drag!;
    if (dd.type === 'grow') {
      const hit = this.rayOnPlaneZ(dd.planeZ);
      if (!hit) return;
      const m = cloneModel(dd.snapshot);
      const r = dd.grow(m);
      if (!r) return;
      extendTo(m, r.seg, r.key, this.snapEdge(dd.axis === 0 ? hit.x : hit.y));
      this.growEnd = r;
      this.setModel(m);
    } else if (dd.type === 'move') {
      const hit = this.rayOnPlaneZ(dd.start.z);
      if (!hit) return;
      const st = this.curStep();
      const m = cloneModel(dd.snapshot);
      moveIds(m, dd.ids, Math.round((hit.x - dd.start.x) / st) * st, Math.round((hit.y - dd.start.y) / st) * st);
      this.setModel(m);
    } else if (dd.type === 'height') {
      const hit = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(dd.plane, hit)) return;
      const dz = Math.round((hit.z - dd.z0) / HEIGHT_STEP) * HEIGHT_STEP;
      const m = cloneModel(dd.snapshot);
      const t = dd.target(m);
      if (t === null) return;
      if (typeof t === 'number') shiftDownstream(m, t, dz);
      else shiftFreeEnd(m, t.seg, t.key, dz);
      this.setModel(m);
      this.onStatus(`高度变化 ${dz >= 0 ? '+' : ''}${dz}`);
    }
  }

  private onUp(e: PointerEvent) {
    this.syncMods(e);
    const d = this.drag;
    this.drag = null;
    this.overlayDirty = true;
    if (!d || d.type === 'orbit') return;
    if (d.type === 'pending') { this.select(d.pick.id); return; }
    const before = d.snapshot;
    const m = this.model;
    if (d.type === 'grow' && this.growEnd && m.segs[this.growEnd.seg]) {
      tryConnect(m, this.growEnd.seg, this.growEnd.key, true);
    }
    if (d.type === 'move') {
      for (const id of d.ids) {
        for (const k of ['a', 'b'] as EndKey[]) if (m.segs[id] && isFree(m.segs[id][k])) tryConnect(m, id, k, false);
      }
    }
    this.growEnd = null;
    normalize(m);
    if (JSON.stringify(before) === JSON.stringify(m)) return;
    this.pushUndo(before);
    this.commitView(before);
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    this.syncMods(e);
    if (e.key === 'Alt') e.preventDefault();
    if (!down) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (e.ctrlKey && k === 'y') { e.preventDefault(); this.redo(); return; }
    if (k === 'delete' || k === 'backspace') {
      if (this.selected === null) return;
      const id = this.selected;
      this.mutate((m) => deleteElem(m, id));
      this.select(null);
      return;
    }
    if (k === 'e') this.toggleHoveredEnd();
    if (k === '1') this.setTool('edit');
    if (k === '2') this.setTool('sink');
    if (k === '3') this.setTool('cut');
    if (k === 'escape') { this.cancelDrag(); this.hideMenu(); }
  }

  private cancelDrag() {
    const d = this.drag;
    if (d && 'snapshot' in d) this.setModel(d.snapshot);
    this.drag = null;
    this.growEnd = null;
    this.overlayDirty = true;
  }

  // ---------------- 操作分派 ----------------

  /** 左键拖动超过阈值后，根据起点和方向决定：拉长 / 拐弯 / 平移 */
  private classifyDrag(d: Extract<Drag, { type: 'pending' }>): Drag | null {
    const p = d.pick;
    const m = d.snapshot;
    const cur = this.rayOnPlaneZ(p.point.z);
    if (!cur) return null;
    const dx = cur.x - p.point.x, dy = cur.y - p.point.y;
    const dm: Dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : (dy >= 0 ? 1 : 3);
    const growDrag = (grow: Grow, z: number): Drag => ({ type: 'grow', snapshot: m, grow, planeZ: z, axis: axisOf(dm) });
    const moveDrag = (): Drag => ({ type: 'move', snapshot: m, ids: component(m, p.id), start: p.point.clone() });

    if (p.kind === 'seg') {
      const s = m.segs[p.id];
      const { t } = this.segLocal(s, p.point);
      const k = this.endRegion(s, t);
      if (!k) return moveDrag();
      if (axisOf(dm) === axisOf(s.dir)) return growDrag(() => ({ seg: s.id, key: k }), endZ(m, s, k));
      if (isSloped(m, s)) { this.flashStatus('斜坡末端不能直接拐弯，先拉出一段平路'); return null; }
      if (s.len < 5 - 1e-6) { this.flashStatus('路段太短，放不下拐角'); return null; }
      return growDrag((mm) => { const id = makeCorner(mm, s.id, k, dm); return id === null ? null : { seg: id, key: 'b' }; }, endZ(m, s, k));
    }
    const n = m.nodes[p.id];
    if (!n) return null;
    if (n.kind === 'block') {
      const ports = nodePorts(m, n.id);
      if (portCount(ports) === 0) return growDrag((mm) => ({ seg: blockToSeg(mm, n.id, dm), key: 'b' }), n.z);
    }
    return moveDrag();
  }

  private heightTarget(p: Pick): HeightTarget | null {
    const m = this.model;
    if (p.kind === 'node') return () => p.id;
    const s = m.segs[p.id];
    const { t } = this.segLocal(s, p.point);
    if (t < 1 && !isFree(s.a)) { const id = s.a.node; return () => id; }
    if (t > s.len - 1 && !isFree(s.b)) { const id = s.b.node; return () => id; }
    const ts = this.tOfCoord(s, this.snapEdge(axisOf(s.dir) === 0 ? p.point.x : p.point.y));
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
    if (this.tool === 'cut' && p.kind === 'seg') this.cutAt(p);
  }

  private cutAt(p: Pick) {
    const m = this.model;
    const s = m.segs[p.id];
    const { t } = this.segLocal(s, p.point);
    if (t < 1 && !isFree(s.a) && m.nodes[s.a.node].kind === 'joint') { const id = s.a.node; this.mutate((mm) => cutJoint(mm, id)); return; }
    if (t > s.len - 1 && !isFree(s.b) && m.nodes[s.b.node].kind === 'joint') { const id = s.b.node; this.mutate((mm) => cutJoint(mm, id)); return; }
    const ts = this.tOfCoord(s, this.snapEdge(axisOf(s.dir) === 0 ? p.point.x : p.point.y));
    this.mutate((mm) => cutSeg(mm, s.id, ts));
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

  // ---------------- 右键菜单 ----------------

  private onContextMenu(e: MouseEvent) {
    e.preventDefault();
    if (this.drag) return;
    this.setMouse(e);
    const p = this.pick();
    const items: (MenuItem | null)[] = p ? this.menuItemsFor(p) : [
      { label: '撤销', hint: 'Ctrl+Z', action: () => this.undo(), disabled: !this.undoStack.length },
      { label: '重做', hint: 'Ctrl+Y', action: () => this.redo(), disabled: !this.redoStack.length },
      null,
      { label: '视角对准高度基准', action: () => this.focusRoot() },
    ];
    if (p) this.select(p.id);
    this.showMenu(e.clientX, e.clientY, items);
  }

  private menuItemsFor(p: Pick): (MenuItem | null)[] {
    const m = this.model;
    const items: (MenuItem | null)[] = [];
    const setRoot = (id: number): MenuItem => ({
      label: '设为高度基准', hint: '改高度时它保持不动', disabled: m.root === id,
      action: () => this.mutate((mm) => { mm.root = id; }),
    });
    if (p.kind === 'seg') {
      const s = m.segs[p.id];
      const { t } = this.segLocal(s, p.point);
      const k = this.endRegion(s, t);
      if (k) {
        const e = s[k] as { style: string };
        items.push({ label: `端点改为${e.style === 'closed' ? '开放' : '封闭'}`, hint: 'E', action: () => this.mutate((mm) => toggleEnd(mm, s.id, k)) });
        const c = findConnection(m, s.id, k, true);
        items.push({
          label: '连接到相邻路面', hint: c && Math.abs(c.z - endZ(m, s, k)) > 1e-6 ? '本段会变成坡道' : undefined,
          disabled: !c, action: () => this.mutate((mm) => { const cc = findConnection(mm, s.id, k, true); if (cc) applyConnection(mm, s.id, k, cc); }),
        });
        items.push(null);
      }
      const jointEnd = t < 1 && !isFree(s.a) && m.nodes[s.a.node].kind === 'joint' ? s.a.node
        : t > s.len - 1 && !isFree(s.b) && m.nodes[s.b.node].kind === 'joint' ? s.b.node : null;
      if (jointEnd !== null) {
        items.push({ label: '删除截面（合并两段）', action: () => this.mutate((mm) => deleteElem(mm, jointEnd)) });
        items.push({ label: '从此截面分隔', action: () => this.mutate((mm) => cutJoint(mm, jointEnd)) });
      } else {
        const ts = this.tOfCoord(s, this.snapEdge(axisOf(s.dir) === 0 ? p.point.x : p.point.y));
        const inside = ts > 1e-6 && ts < s.len - 1e-6;
        items.push({ label: '在此插入截面', hint: '坡度转折点', disabled: !inside, action: () => this.mutate((mm) => { insertJoint(mm, s.id, ts); }) });
        items.push({ label: '在此分隔', disabled: !inside, action: () => this.cutAt(p) });
      }
      items.push(null);
      items.push({ label: s.style === 'sink' ? '改为普通路面' : '改为凹槽路面', action: () => this.mutate((mm) => setChainStyle(mm, s.id, s.style === 'sink' ? 'normal' : 'sink')) });
      items.push(setRoot(s.id));
      items.push(null);
      items.push({ label: '删除这段路', hint: 'Del', action: () => this.mutate((mm) => deleteElem(mm, s.id)) });
    } else {
      const n = m.nodes[p.id];
      if (n.kind === 'block') {
        items.push({ label: n.style === 'sink' ? '改为普通路面' : '改为凹槽路面', action: () => this.mutate((mm) => setBlockStyle(mm, n.id, n.style === 'sink' ? 'normal' : 'sink')) });
      }
      items.push(setRoot(n.id));
      items.push(null);
      items.push({ label: n.kind === 'transition' ? '删除转换块' : '删除路块', hint: 'Del', action: () => this.mutate((mm) => deleteElem(mm, n.id)) });
    }
    return items;
  }

  private showMenu(x: number, y: number, items: (MenuItem | null)[]) {
    const menu = this.menu;
    menu.innerHTML = '';
    for (const it of items) {
      if (!it) { const hr = document.createElement('div'); hr.className = 'sep'; menu.appendChild(hr); continue; }
      const b = document.createElement('button');
      b.disabled = !!it.disabled;
      b.innerHTML = `<span>${it.label}</span>${it.hint ? `<small>${it.hint}</small>` : ''}`;
      b.addEventListener('click', () => { this.hideMenu(); it.action?.(); });
      menu.appendChild(b);
    }
    const r = this.host.getBoundingClientRect();
    menu.classList.add('open');
    const mw = menu.offsetWidth, mh = menu.offsetHeight;
    menu.style.left = `${Math.max(4, Math.min(x - r.left, r.width - mw - 4))}px`;
    menu.style.top = `${Math.max(4, Math.min(y - r.top, r.height - mh - 4))}px`;
  }

  private hideMenu() { this.menu.classList.remove('open'); }

  private focusRoot() {
    const c = this.elemCenter(this.model, this.model.root) ?? [0, 0, 0];
    const off = this.camera.position.clone().sub(this.controls.target);
    this.controls.target.set(...c);
    this.camera.position.copy(this.controls.target).add(off);
  }

  // ---------------- 状态与提交 ----------------

  private select(id: number | null) {
    this.selected = id;
    this.overlayDirty = true;
    this.updateStatus();
  }

  private setModel(m: Model) {
    this.model = m;
    this.overlayDirty = true;
  }

  private mutate(fn: (m: Model) => void) {
    const before = cloneModel(this.model);
    fn(this.model);
    normalize(this.model);
    if (JSON.stringify(before) === JSON.stringify(this.model)) return;
    this.pushUndo(before);
    this.commitView(before);
  }

  private pushUndo(m: Model) {
    this.undoStack.push(JSON.stringify(m));
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  /**
   * 提交后刷新视图。规范化可能改变结构（路块变接头等），此时直接跳到最终状态，避免过渡中出现缝隙；
   * 新出现的元素闪一下轮廓作为反馈。
   */
  private commitView(before?: Model) {
    if (this.selected !== null && !this.model.segs[this.selected] && !this.model.nodes[this.selected]) this.selected = null;
    this.hover = null;
    this.display = this.model;
    this.syncMeshes();
    if (before) {
      for (const id of [...Object.keys(this.model.segs), ...Object.keys(this.model.nodes)].map(Number)) {
        if (before.segs[id] || before.nodes[id]) continue;
        this.fx.pop(this.outlineSegs(id), 0xffffff);
      }
    }
    this.overlayDirty = true;
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

  private flashStatus(text: string) {
    this.flash = { text, until: performance.now() + 2200 };
    this.updateStatus();
    setTimeout(() => this.updateStatus(), 2300);
  }

  private updateStatus() {
    if (this.flash && performance.now() < this.flash.until) { this.onStatus(`⚠ ${this.flash.text}`); return; }
    const h = this.hover;
    const m = this.model;
    let info = '';
    if (h && h.kind === 'seg' && m.segs[h.id]) {
      const s = m.segs[h.id];
      const ends = (['a', 'b'] as EndKey[]).map((k) => {
        const e = s[k];
        return isFree(e) ? (e.style === 'closed' ? '封闭' : '开放') : '连接';
      });
      info = `直道 #${s.id}  长 ${fmt(s.len)}  高 ${fmt(endZ(m, s, 'a'))}→${fmt(endZ(m, s, 'b'))}  ${s.style === 'sink' ? '凹槽' : '普通'}  端点 ${ends.join(' / ')}`;
    } else if (h && m.nodes[h.id]) {
      const n = m.nodes[h.id];
      const ports = nodePorts(m, n.id);
      const cnt = portCount(ports);
      const kind = n.kind === 'transition' ? '平凹转换' : cnt === 0 ? '1×1' : cnt === 2 ? '拐角' : cnt === 3 ? 'T 字路口' : '十字路口';
      info = `${kind} #${n.id}  高 ${fmt(n.z)}  ${n.style === 'sink' ? '凹槽' : '普通'}`;
    }
    const hints: Record<Tool, string> = {
      edit: this.mods.shift ? '按住 Shift：左键从示意框处拖出分叉路'
        : this.mods.alt ? 'Alt：拖动截面或路块调整高度（步长 1.25），下游跟随'
        : '拖端点：拉长 · 端点侧向拖：拐弯 · 拖路中段：平移 · Shift：开分叉 · Alt：改高度 · 中键：环视 · 右键：更多',
      sink: '点击直道或路块：切换普通/凹槽（自动插入平凹转换）',
      cut: '点击截面：把花纹分开成两个端点',
    };
    this.onStatus(`${info ? info + '　|　' : ''}${hints[this.tool]}`);
  }
}

function diamondSegs(r: number): number[] {
  const p = [[r, 0], [0, r], [-r, 0], [0, -r]];
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4];
    out.push(a[0], a[1], 0, b[0], b[1], 0);
  }
  return out;
}

/** 分叉示意：新路块方框 + 朝外的箭头（相对路块中心） */
function branchSegs(b: BranchCand): number[] {
  const segs = b.newBlock ? rectSegs(HALF, HALF, 0) : [];
  const ox = DX[b.dir], oy = DY[b.dir];
  const px = -oy, py = ox;
  const sx = ox * HALF, sy = oy * HALF;
  const tx = sx + ox * 3.5, ty = sy + oy * 3.5;
  segs.push(sx, sy, 0, tx, ty, 0);
  segs.push(tx, ty, 0, tx - ox * 1.1 + px * 0.9, ty - oy * 1.1 + py * 0.9, 0);
  segs.push(tx, ty, 0, tx - ox * 1.1 - px * 0.9, ty - oy * 1.1 - py * 0.9, 0);
  return segs;
}

const fmt = (v: number) => (Math.round(v * 1000) / 1000).toString();
