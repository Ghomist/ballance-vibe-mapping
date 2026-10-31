import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { buildElem, computeChains, elemKey, type MatName } from './geom/floor';
import { getMaterial } from './view/materials';
import { Fx, rectSegs } from './view/fx';
import { createGrid } from './view/grid';
import { lerpModel } from './view/tween';
import {
  DX, DY, Dir, EndKey, HALF, HEIGHT_STEP, Model, Seg, Style,
  axisOf, cloneModel, emptyModel, endPos, endZ, isFree, nodeLinks, nodePorts, opp, portCount, zAt,
} from './model/types';
import {
  addSegAtPort, applyConnection, blockToSeg, cutJoint, cutSeg, deleteElem, extendFlat, extendTo,
  findConnection, insertJoint, isSloped, makeBranch, normalize, setBlockStyle, setChainStyle, setSegStyle,
  setPlatformStyle, shiftDownstream, shiftFreeEnd, toggleEnd, tryConnect,
} from './model/ops';
import {
  addSegAtPlatform, blockToPlatform, cellSet, edgeRunAt, extrudePlatform, openingFits, platformBBox, segToPlatform,
} from './model/platform';

export type Tool = 'edit' | 'cut';

interface Pick {
  id: number;
  kind: 'seg' | 'node';
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

type GrowEnd = { seg: number; key: EndKey } | null;

/**
 * 悬停时计算出的“动作”：示意图形 + 拖动时如何修改模型。
 * 拖动时把鼠标投影到 dir 所在轴上，得到世界坐标 coord，交给 apply。
 */
interface Action {
  valid: boolean;
  reason?: string;
  /** 示意线框（相对 pos） */
  segs: number[];
  pos: [number, number, number];
  color: number;
  dir: Dir;
  z: number;
  apply: (m: Model, coord: number) => GrowEnd;
}

type Drag =
  | { type: 'action'; snapshot: Model; action: Action }
  | { type: 'height'; snapshot: Model; target: HeightTarget; plane: THREE.Plane; z0: number }
  | { type: 'orbit' };

type HeightTarget = (m: Model) => number | { seg: number; key: EndKey } | null;

interface MenuItem { label: string; hint?: string; action?: () => void; disabled?: boolean }

const STORAGE_KEY = 'bvm.model';
const MOVE_TAU = 0.045;

const C_HOVER = 0xdfe8ff;
const C_SELECT = 0xffc640;
const C_SECTION = 0x66ffaa;
const C_CUT = 0xff5d73;
const C_CREATE = 0x5cc8ff;
const C_EXTRUDE = 0xb48cff;
const C_INVALID = 0xff5d73;
const C_CONNECT = 0x7dff9a;
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
  private labels = new CSS2DRenderer();
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private floor = new THREE.Group();
  private fx = new Fx();
  private pickables: THREE.Mesh[] = [];
  private raycaster = new THREE.Raycaster();
  private drag: Drag | null = null;
  private hover: Pick | null = null;
  private action: Action | null = null;
  private growEnd: GrowEnd = null;
  private selected: number | null = null;
  private mouse = new THREE.Vector2();
  private mods = { ctrl: false, shift: false, alt: false };
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
    this.labels.domElement.className = 'label-layer';
    host.appendChild(this.labels.domElement);

    this.scene.background = new THREE.Color(0x1d2330);
    this.camera = new THREE.PerspectiveCamera(50, 1, 1, 4000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(-25, -40, 40);

    // 中键环视，Shift+中键平移（OrbitControls 内置行为），滚轮缩放；左键编辑，右键菜单
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.mouseButtons = { LEFT: -1 as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: -1 as THREE.MOUSE };
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.18;
    this.controls.target.set(5, 5, 0);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-0.4, -0.7, 1);
    this.scene.add(sun);
    this.scene.add(createGrid());
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
    this.labels.render(this.scene, this.camera);
  }

  private resize() {
    const w = this.host.clientWidth, h = this.host.clientHeight;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
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
    if (h && h.id !== this.selected) show(`hover:${h.id}`, this.outlineSegs(h.id), C_HOVER, { width: 1.5, opacity: 0.4, gradient: true });
    if (this.selected !== null) show('select', this.outlineSegs(this.selected), C_SELECT, { width: 2.5, gradient: true });

    // 动作示意（左键 / Shift）
    this.action = h && this.tool === 'edit' && !this.mods.alt ? this.actionFor(h) : null;
    const a = this.action;
    if (a) show(this.mods.shift ? 'act-extrude' : 'act', a.segs, a.valid ? a.color : C_INVALID, { width: 2.5, pos: a.pos });

    // Alt：截面预览；分隔工具：整个截面 + 斜线
    const sec = this.hoverSection();
    if (sec) {
      const { s, t } = sec;
      const P = [-DY[s.dir], DX[s.dir]];
      const pos: [number, number, number] = [s.x + DX[s.dir] * t, s.y + DY[s.dir] * t, zAt(this.model, s, t) + 0.04];
      if (this.tool === 'cut') {
        const L = [-P[0] * HALF, -P[1] * HALF], R = [P[0] * HALF, P[1] * HALF];
        show('cut-rect', [L[0], L[1], 0, R[0], R[1], 0, R[0], R[1], 0, R[0], R[1], -5, R[0], R[1], -5, L[0], L[1], -5, L[0], L[1], -5, L[0], L[1], 0],
          C_CUT, { width: 2.5, pos });
        show('cut-hatch', hatchSegs(P), C_CUT, { width: 1.5, opacity: 0.8, dashed: true, pos });
      } else {
        show('section', [-P[0] * HALF, -P[1] * HALF, 0, P[0] * HALF, P[1] * HALF, 0], C_SECTION, { width: 3, pos });
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

  // ---------------- 拾取与吸附 ----------------

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
  /** 截面 / 端点 / 边沿吸附：落在 k·step 上 */
  private snapEdge(c: number) { const s = this.curStep(); return Math.round(c / s) * s; }
  /** 路块中心吸附：边沿落在网格上时，中心在 2.5 + k·step */
  private snapCenter(c: number) { const s = this.curStep(); return HALF + Math.round((c - HALF) / s) * s; }

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

  // ---------------- 动作判定 ----------------

  /** 悬停位置对应的动作：左键 = 拉长 / 开分叉 / 长出新路；Shift = 整个侧面拉成平台 */
  private actionFor(p: Pick): Action | null {
    const m = this.model;
    const shift = this.mods.shift;
    if (p.kind === 'seg') {
      const s = m.segs[p.id];
      if (!s) return null;
      const { t, lat } = this.segLocal(s, p.point);
      const D: [number, number] = [DX[s.dir], DY[s.dir]];
      // 最近的边：自由端端面或左右侧面
      const nd = p.normal;
      const onEndFace = Math.abs(nd.x * D[0] + nd.y * D[1]) > 0.7;
      const onSideFace = Math.abs(nd.x * -D[1] + nd.y * D[0]) > 0.7;
      const cands: { what: EndKey | 'L' | 'R'; d: number }[] = [
        { what: 'L', d: HALF - lat }, { what: 'R', d: HALF + lat },
      ];
      if (!shift && isFree(s.a)) cands.push({ what: 'a', d: t });
      if (!shift && isFree(s.b)) cands.push({ what: 'b', d: s.len - t });
      let what = cands.reduce((x, y) => (y.d < x.d ? y : x)).what;
      if (onEndFace && !shift) what = t < s.len / 2 ? 'a' : 'b';
      if (onSideFace) what = lat >= 0 ? 'L' : 'R';
      if ((what === 'a' || what === 'b') && !isFree(s[what])) what = lat >= 0 ? 'L' : 'R';
      const left = ((s.dir + 1) % 4) as Dir;
      const side = what === 'L' ? left : opp(left);

      if (shift) return this.extrudeSegAction(s, side);
      if (what === 'a' || what === 'b') return this.extendAction(s, what);
      return this.branchAction(s, p, side);
    }
    const n = m.nodes[p.id];
    if (!n) return null;
    if (n.kind === 'block') {
      const dx = p.point.x - n.x, dy = p.point.y - n.y;
      const dir: Dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : (dy >= 0 ? 1 : 3);
      if (shift) return this.extrudeBlockAction(n.id, dir);
      return this.blockGrowAction(n.id, dir);
    }
    if (n.kind === 'platform') return shift ? this.extrudePlatformAction(n.id, p) : this.platformBranchAction(n.id, p);
    return null;
  }

  /** 沿路方向拉长 / 缩短端点；缩到 0 的分支会被删除；斜坡端点往外拉会续接一段平路 */
  private extendAction(s: Seg, k: EndKey): Action {
    const m = this.model;
    const [ex, ey] = endPos(s, k);
    const out = k === 'a' ? opp(s.dir) : s.dir;
    const P = [-DY[out], DX[out]];
    const segs = [-P[0] * HALF, -P[1] * HALF, 0, P[0] * HALF, P[1] * HALF, 0, ...arrowSegs(out, 0, 3.5)];
    const sloped = isSloped(m, s);
    const sign = DX[out] + DY[out];
    const endCoord = axisOf(out) === 0 ? ex : ey;
    return {
      valid: true, segs, pos: [ex, ey, endZ(m, s, k) + 0.06], color: C_CREATE, dir: out, z: endZ(m, s, k),
      apply: (mm, coord) => {
        const c = this.snapEdge(coord);
        if (sloped && (c - endCoord) * sign > 1e-6) {
          const ns = extendFlat(mm, s.id, k);
          if (ns === null) return null;
          extendTo(mm, ns, 'b', c);
          return { seg: ns, key: 'b' };
        }
        extendTo(mm, s.id, k, c);
        return { seg: s.id, key: k };
      },
    };
  }

  private branchAction(s: Seg, p: Pick, side: Dir): Action {
    const m = this.model;
    const c = this.snapCenter(axisOf(s.dir) === 0 ? p.point.x : p.point.y);
    const tc = Math.min(Math.max(this.tOfCoord(s, c), HALF), s.len - HALF);
    const cx = s.x + DX[s.dir] * tc, cy = s.y + DY[s.dir] * tc, z = zAt(m, s, tc);
    const base = { segs: [...rectSegs(HALF, HALF, 0), ...arrowSegs(side, HALF, 3.5)], pos: [cx, cy, z + 0.08] as [number, number, number], color: C_CREATE, dir: side, z };
    if (isSloped(m, s)) return { ...base, valid: false, reason: '斜坡上不能开分叉', apply: () => null };
    if (s.len < 5 - 1e-6) return { ...base, valid: false, reason: '路段太短，放不下路口', apply: () => null };
    return {
      ...base, valid: true,
      apply: (mm, coord) => {
        const id = makeBranch(mm, s.id, tc, side);
        if (id === null) return null;
        extendTo(mm, id, 'b', this.snapEdge(coord));
        return { seg: id, key: 'b' };
      },
    };
  }

  private blockGrowAction(nodeId: number, dir: Dir): Action {
    const m = this.model;
    const n = m.nodes[nodeId];
    const ports = nodePorts(m, nodeId);
    const base = { segs: arrowSegs(dir, HALF, 3.5), pos: [n.x, n.y, n.z + 0.08] as [number, number, number], color: C_CREATE, dir, z: n.z };
    if (ports[dir]) return { ...base, valid: false, reason: '这一侧已经连着路了', apply: () => null };
    const lone = portCount(ports) === 0;
    return {
      ...base, valid: true,
      apply: (mm, coord) => {
        const id = lone ? blockToSeg(mm, nodeId, dir) : addSegAtPort(mm, nodeId, dir);
        if (id === null) return null;
        extendTo(mm, id, 'b', this.snapEdge(coord));
        return { seg: id, key: 'b' };
      },
    };
  }

  private platformBranchAction(pid: number, p: Pick): Action | null {
    const n = this.model.nodes[pid];
    const run = edgeRunAt(n, p.point.x, p.point.y);
    if (!run) return null;
    const isX = axisOf(run.out) === 0;
    const along = this.snapCenter(isX ? p.point.y : p.point.x);
    const cx = isX ? run.line : along, cy = isX ? along : run.line;
    const P = [-DY[run.out], DX[run.out]];
    const segs = [-P[0] * HALF, -P[1] * HALF, 0, P[0] * HALF, P[1] * HALF, 0, ...arrowSegs(run.out, 0, 3.5)];
    const valid = openingFits(cellSet(n), cx, cy, run.out);
    return {
      valid, reason: valid ? undefined : '这里放不下 5 宽的路口', segs, pos: [cx, cy, n.z + 0.08], color: C_CREATE, dir: run.out, z: n.z,
      apply: (mm, coord) => {
        const id = addSegAtPlatform(mm, pid, cx, cy, run.out);
        if (id === null) return null;
        extendTo(mm, id, 'b', this.snapEdge(coord));
        return { seg: id, key: 'b' };
      },
    };
  }

  /** 侧面整体示意：沿边的长线 + 中点箭头 */
  private sideSegs(halfLen: number, out: Dir) {
    const P = [-DY[out], DX[out]];
    return [-P[0] * halfLen, -P[1] * halfLen, 0, P[0] * halfLen, P[1] * halfLen, 0, ...arrowSegs(out, 0, 3)];
  }

  private extrudeSegAction(s: Seg, side: Dir): Action {
    const m = this.model;
    const mid = s.len / 2;
    const ex = s.x + DX[s.dir] * mid + DX[side] * HALF, ey = s.y + DY[s.dir] * mid + DY[side] * HALF;
    const z = zAt(m, s, mid);
    const base = { segs: this.sideSegs(s.len / 2, side), pos: [ex, ey, z + 0.08] as [number, number, number], color: C_EXTRUDE, dir: side, z };
    if (isSloped(m, s)) return { ...base, valid: false, reason: '斜坡不能拉成平台', apply: () => null };
    const line = axisOf(side) === 0 ? ex : ey;
    const sign = DX[side] + DY[side];
    return {
      ...base, valid: true,
      apply: (mm, coord) => {
        const w = (this.snapEdge(coord) - line) * sign;
        if (w <= 1e-6) return null;
        segToPlatform(mm, s.id, side, w);
        return null;
      },
    };
  }

  private extrudeBlockAction(nodeId: number, dir: Dir): Action {
    const n = this.model.nodes[nodeId];
    const ex = n.x + DX[dir] * HALF, ey = n.y + DY[dir] * HALF;
    const line = axisOf(dir) === 0 ? ex : ey;
    const sign = DX[dir] + DY[dir];
    return {
      valid: true, segs: this.sideSegs(HALF, dir), pos: [ex, ey, n.z + 0.08], color: C_EXTRUDE, dir, z: n.z,
      apply: (mm, coord) => {
        const w = (this.snapEdge(coord) - line) * sign;
        if (w <= 1e-6) return null;
        blockToPlatform(mm, nodeId, dir, w);
        return null;
      },
    };
  }

  private extrudePlatformAction(pid: number, p: Pick): Action | null {
    const n = this.model.nodes[pid];
    const run = edgeRunAt(n, p.point.x, p.point.y);
    if (!run) return null;
    const isX = axisOf(run.out) === 0;
    const midA = (run.from + run.to) / 2;
    const ex = isX ? run.line : midA, ey = isX ? midA : run.line;
    const sign = DX[run.out] + DY[run.out];
    return {
      valid: true, segs: this.sideSegs((run.to - run.from) / 2, run.out), pos: [ex, ey, n.z + 0.08], color: C_EXTRUDE, dir: run.out, z: n.z,
      apply: (mm, coord) => {
        const w = (this.snapEdge(coord) - run.line) * sign;
        if (Math.abs(w) < 1e-6) return null;
        // 往里推不能把平台推没
        const b = platformBBox(mm.nodes[pid]);
        const span = isX ? b.x1 - b.x0 : b.y1 - b.y0;
        extrudePlatform(mm, pid, run, Math.max(w, -span + 1.25));
        return null;
      },
    };
  }

  /** 拖拽中可连接的位置：方框画在连接截面外侧那一格 */
  private dragConnection(): { x: number; y: number; z: number } | null {
    const d = this.drag;
    if (!d || d.type !== 'action' || !this.growEnd) return null;
    const m = this.model;
    const { seg, key } = this.growEnd;
    const s = m.segs[seg];
    if (!s || !isFree(s[key])) return null;
    const c = findConnection(m, seg, key, true);
    if (!c) return null;
    const [x, y] = endPos(s, key);
    const out = key === 'a' ? opp(s.dir) : s.dir;
    return { x: x + DX[out] * HALF, y: y + DY[out] * HALF, z: c.z };
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
    this.hover = p;
    const snapshot = cloneModel(this.model);

    if (this.tool === 'cut') { if (p.kind === 'seg') this.cutAt(p); return; }
    if (e.altKey) {
      const target = this.heightTarget(p);
      if (!target) return;
      const n = new THREE.Vector3().subVectors(this.camera.position, p.point).setZ(0).normalize();
      const plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, p.point);
      this.drag = { type: 'height', snapshot, target, plane, z0: p.point.z };
      return;
    }
    const a = this.actionFor(p);
    this.select(p.id);
    if (!a) return;
    if (!a.valid) { if (a.reason) this.flashStatus(a.reason); return; }
    this.drag = { type: 'action', snapshot, action: a };
    this.overlayDirty = true;
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
    if (d.type === 'action') {
      const hit = this.rayOnPlaneZ(d.action.z);
      if (!hit) return;
      const m = cloneModel(d.snapshot);
      this.growEnd = d.action.apply(m, axisOf(d.action.dir) === 0 ? hit.x : hit.y);
      this.setModel(m);
    } else if (d.type === 'height') {
      const hit = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(d.plane, hit)) return;
      const m = cloneModel(d.snapshot);
      const t = d.target(m);
      if (t === null) return;
      // 目标高度吸附到 1.25 的整数倍（而不是变化量），这样斜坡中段也能调回整齐的高度
      const zt = typeof t === 'number' ? m.nodes[t].z : endZ(m, m.segs[t.seg], t.key);
      const dz = Math.round((zt + hit.z - d.z0) / HEIGHT_STEP) * HEIGHT_STEP - zt;
      if (typeof t === 'number') shiftDownstream(m, t, dz);
      else shiftFreeEnd(m, t.seg, t.key, dz);
      this.setModel(m);
      this.onStatus(`高度 ${fmt(zt + dz)}（${dz >= 0 ? '+' : ''}${fmt(dz)}）`);
    }
  }

  private onUp(e: PointerEvent) {
    this.syncMods(e);
    const d = this.drag;
    this.drag = null;
    this.overlayDirty = true;
    if (!d || d.type === 'orbit') return;
    const before = d.snapshot;
    const m = this.model;
    if (d.type === 'action' && this.growEnd && m.segs[this.growEnd.seg]) {
      tryConnect(m, this.growEnd.seg, this.growEnd.key, true);
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
    if (k === '2') this.setTool('cut');
    if (k === 'escape') { this.cancelDrag(); this.hideMenu(); }
  }

  private cancelDrag() {
    const d = this.drag;
    if (d && 'snapshot' in d) this.setModel(d.snapshot);
    this.drag = null;
    this.growEnd = null;
    this.overlayDirty = true;
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
    const styleItems = (cur: Style, set: (mm: Model, st: Style) => void): MenuItem[] => [
      { label: '普通路面', hint: cur === 'normal' ? '当前' : undefined, disabled: cur === 'normal', action: () => this.mutate((mm) => set(mm, 'normal')) },
      { label: '凹槽路面', hint: cur === 'sink' ? '当前' : '自动插入平凹转换', disabled: cur === 'sink', action: () => this.mutate((mm) => set(mm, 'sink')) },
    ];
    if (p.kind === 'seg') {
      const s = m.segs[p.id];
      const { t } = this.segLocal(s, p.point);
      const k: EndKey | null = isFree(s.a) && t < Math.min(3.75, s.len * 0.3) ? 'a'
        : isFree(s.b) && t > s.len - Math.min(3.75, s.len * 0.3) ? 'b' : null;
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
      items.push(...styleItems(s.style, (mm, st) => setSegStyle(mm, s.id, st)));
      const other: Style = s.style === 'sink' ? 'normal' : 'sink';
      items.push({ label: `整条直路改为${other === 'sink' ? '凹槽' : '普通'}`, hint: '跨过截面接头', action: () => this.mutate((mm) => setChainStyle(mm, s.id, other)) });
      items.push(null);
      items.push(setRoot(s.id));
      items.push({ label: '删除这段路', hint: 'Del', action: () => this.mutate((mm) => deleteElem(mm, s.id)) });
    } else {
      const n = m.nodes[p.id];
      if (n.kind === 'block') {
        items.push(...styleItems(n.style, (mm, st) => setBlockStyle(mm, n.id, st)));
        items.push(null);
      }
      if (n.kind === 'platform') {
        const cur = n.style === 'normal' ? 'normal' : n.ribbon ? 'ribbon' : 'sink';
        const opt = (label: string, key: string, st: Style, ribbon: boolean): MenuItem => ({
          label, hint: cur === key ? '当前' : undefined, disabled: cur === key,
          action: () => this.mutate((mm) => setPlatformStyle(mm, n.id, st, ribbon)),
        });
        items.push(opt('普通平台', 'normal', 'normal', false), opt('凹槽平台', 'sink', 'sink', false), opt('细边花纹平台', 'ribbon', 'sink', true));
        items.push(null);
      }
      items.push(setRoot(n.id));
      const name = n.kind === 'transition' ? '删除转换块' : n.kind === 'platform' ? `删除平台（连着 ${nodeLinks(m, n.id).length} 条路）` : '删除路块';
      items.push({ label: name, hint: 'Del', action: () => this.mutate((mm) => deleteElem(mm, n.id)) });
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
      if (n.kind === 'platform') {
        const b = platformBBox(n);
        info = `平台 #${n.id}  ${fmt(b.x1 - b.x0)}×${fmt(b.y1 - b.y0)}  高 ${fmt(n.z)}  ${n.style === 'normal' ? '普通' : n.ribbon ? '细边花纹' : '凹槽'}`;
      } else {
        const cnt = portCount(nodePorts(m, n.id));
        const kind = n.kind === 'transition' ? '平凹转换' : cnt === 0 ? '1×1' : cnt === 2 ? '拐角' : cnt === 3 ? 'T 字路口' : '十字路口';
        info = `${kind} #${n.id}  高 ${fmt(n.z)}  ${n.style === 'sink' ? '凹槽' : '普通'}`;
      }
    }
    const hints: Record<Tool, string> = {
      edit: this.mods.shift ? 'Shift：拖动整个侧面拉成平台（平台边可往里推）'
        : this.mods.alt ? 'Alt：拖动截面或路块调整高度（吸附到 1.25 的倍数），下游跟随'
        : '左键按示意方向拖：拉长 / 开路口（拉回 0 即删除）· Shift：拉平台 · Alt：改高度 · 中键：环视 · 右键：更多',
      cut: '点击截面：把花纹分开成两个封闭端点',
    };
    this.onStatus(`${info ? info + '　|　' : ''}${hints[this.tool]}`);
  }
}

/** 从中心沿 dir 偏移 start 处开始、长 len 的箭头 */
function arrowSegs(dir: Dir, start: number, len: number): number[] {
  const ox = DX[dir], oy = DY[dir];
  const px = -oy, py = ox;
  const sx = ox * start, sy = oy * start;
  const tx = sx + ox * len, ty = sy + oy * len;
  return [
    sx, sy, 0, tx, ty, 0,
    tx, ty, 0, tx - ox * 1.1 + px * 0.9, ty - oy * 1.1 + py * 0.9, 0,
    tx, ty, 0, tx - ox * 1.1 - px * 0.9, ty - oy * 1.1 - py * 0.9, 0,
  ];
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

/** 截面上的斜线：在宽 5、高 5 的竖直截面内，P 为横向单位向量 */
function hatchSegs(P: number[]): number[] {
  const out: number[] = [];
  const pt = (l: number, z: number) => [P[0] * l, P[1] * l, z];
  for (let k = -5; k <= 5; k += 1.25) {
    // 直线 l - z' = k（z' = -z ∈ [0,5]，l ∈ [-2.5,2.5]）裁剪到矩形内
    const ps: number[][] = [];
    for (const l of [-HALF, HALF]) { const zz = l - k; if (zz >= 0 && zz <= 5) ps.push([l, zz]); }
    for (const zz of [0, 5]) { const l = zz + k; if (l > -HALF && l < HALF) ps.push([l, zz]); }
    if (ps.length < 2) continue;
    out.push(...pt(ps[0][0], -ps[0][1]), ...pt(ps[1][0], -ps[1][1]));
  }
  return out;
}

const fmt = (v: number) => (Math.round(v * 1000) / 1000).toString();
