import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { buildElem, computeChains, elemKey, type MatName } from './geom/floor';
import { buildRail } from './geom/rail';
import { getMaterial, getRailMaterial } from './view/materials';
import { Gizmo, type GizmoHandle } from './view/gizmo';
import { Snapper, type SnapResult } from './view/snap';
import { Fx, rectSegs } from './view/fx';
import { createGrid } from './view/grid';
import { lerpModel } from './view/tween';
import {
  DX, DY, Dir, EndKey, HALF, Model, Seg, Style,
  axisOf, cloneModel, emptyModel, endPos, endZ, isFree, migrateModel, nodeLinks, nodePorts, opp, portCount, zAt,
} from './model/types';
import {
  Rail, RailKind, RailPiece, RailState, SPIRAL_RADIUS, SPIRAL_SCREW, TRANSITION_LEN, extendStart, nearestPiece, nearestS,
  pieceLength, pushPiece, railEnd, railTopOffset, splitRail, stateAt,
} from './model/rail';
import {
  addBlock, addSegAtPort, applyConnection, blockToSeg, component, cutJoint, moveDownstream, cutSeg, deleteElem, extendFlat, extendTo,
  findConnection, insertJoint, isSloped, makeBranch, normalize, setBlockStyle, setChainStyle, setSegStyle,
  setPlatformStyle, shiftDownstream, shiftFreeEnd, toggleEnd, tryConnect,
} from './model/ops';
import {
  addSegAtPlatform, blockToPlatform, cellSet, edgeRunAt, extrudePlatform, openingFits, platformBBox, segToPlatform,
} from './model/platform';

export type Tool = 'edit' | 'cut' | 'rail';

interface Pick {
  id: number;
  kind: 'seg' | 'node' | 'rail';
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
  /** 需要完整平面坐标的动作（钢轨：直线 / 圆弧由鼠标位置决定） */
  apply2?: (m: Model, x: number, y: number) => void;
}

type Drag =
  | { type: 'action'; snapshot: Model; action: Action; sx: number; sy: number; started: boolean }
  | { type: 'height'; snapshot: Model; target: HeightTarget; plane: THREE.Plane; z0: number }
  | { type: 'railHeight'; snapshot: Model; rail: number; plane: THREE.Plane; z0: number }
  | { type: 'gizmo'; snapshot: Model; target: GizmoTarget; handle: GizmoHandle; origin: THREE.Vector3; t0: number; ref: number }
  | { type: 'orbit' };

/** gizmo 作用对象：一整段路（悬停元素所在的连通块）或一整条钢轨 */
type GizmoTarget =
  | { type: 'comp'; id: number }
  | { type: 'rail'; id: number };

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
const C_RAIL = 0x9be7ff;
const RAIL_HANDLE_GEO = new THREE.BoxGeometry(5, 5, 1.6).translate(-1.5, 0, 0);
const RAIL_HANDLE_MAT = new THREE.MeshBasicMaterial({ visible: false });

export class Editor {
  model: Model;
  tool: Tool = 'edit';
  /** 格栅模式：一切对齐到 2.5 的倍数；关闭后自由拖动并智能吸附。按住 Ctrl 临时切换 */
  gridMode = true;
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
  private snapper = new Snapper();
  private guides: number[] = [];
  private gizmo = new Gizmo();
  private gizmoTarget: GizmoTarget | null = null;
  private gizmoKey = '';

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
    this.scene.add(this.floor, this.fx.group, this.gizmo.group);

    this.menu = document.createElement('div');
    this.menu.className = 'ctx-menu';
    host.appendChild(this.menu);

    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (e) => this.onDown(e));
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    el.addEventListener('dblclick', (e) => {
      this.setMouse(e);
      if (this.pick()) return;
      const g = this.rayOnPlaneZ(0);
      if (g) this.newBlockAt(g);
    });
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

  setGridMode(on: boolean) { this.gridMode = on; this.overlayDirty = true; this.updateStatus(); this.onChange(); }

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
    this.model = migrateModel(data.model);
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
    this.gizmo.tick(dt, this.camera);
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
    const ids = new Set([...Object.keys(m.segs), ...Object.keys(m.nodes), ...Object.keys(m.rails)].map(Number));
    for (const [id, c] of this.meshCache) {
      if (ids.has(id)) continue;
      for (const mesh of c.meshes) { if (mesh.geometry !== RAIL_HANDLE_GEO) mesh.geometry.dispose(); this.floor.remove(mesh); }
      this.meshCache.delete(id);
    }
    for (const id of ids) {
      const rail = m.rails[id];
      const key = rail ? JSON.stringify(rail) : elemKey(m, id, chains);
      const cached = this.meshCache.get(id);
      if (cached && cached.key === key) continue;
      if (cached) for (const mesh of cached.meshes) { if (mesh.geometry !== RAIL_HANDLE_GEO) mesh.geometry.dispose(); this.floor.remove(mesh); }
      const meshes: THREE.Mesh[] = [];
      if (rail) {
        const rm = buildRail(rail);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.Float32BufferAttribute(rm.pos, 3));
        g.setAttribute('normal', new THREE.Float32BufferAttribute(rm.nrm, 3));
        const mesh = new THREE.Mesh(g, getRailMaterial());
        mesh.userData = { id, kind: 'rail' };
        this.floor.add(mesh);
        meshes.push(mesh);
        // 末端的隐形拾取块：双轨中间是空的，方便点中末端继续延伸
        const E = railEnd(rail);
        const handle = new THREE.Mesh(RAIL_HANDLE_GEO, RAIL_HANDLE_MAT);
        handle.position.set(E.x, E.y, E.z + 0.3);
        handle.rotation.z = (E.heading * Math.PI) / 180;
        handle.userData = { id, kind: 'rail', handle: true };
        handle.updateMatrixWorld();
        this.floor.add(handle);
        meshes.push(handle);
        this.meshCache.set(id, { key, meshes });
        continue;
      }
      const em = buildElem(m, id, chains);
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
    this.action = h && this.tool !== 'cut' && !this.mods.alt ? this.actionFor(h) : null;
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

    // 钢轨分隔预览
    if (this.tool === 'cut' && h && h.kind === 'rail' && this.model.rails[h.id]) {
      const r = this.model.rails[h.id];
      const st = stateAt(r, this.snap().length(nearestS(r, h.point.x, h.point.y)));
      const a = (st.heading * Math.PI) / 180;
      const px = -Math.sin(a) * 3, py = Math.cos(a) * 3;
      show('section', [-px, -py, 0, px, py, 0], C_CUT, { width: 3, pos: [st.x, st.y, st.z] });
    }

    // 自由模式下的对齐参考线
    if (this.guides.length) show('guides', this.guides, 0xffe28a, { width: 1.2, opacity: 0.85, dashed: true });

    this.updateGizmo();

    // 拖拽中：可连接提示
    const conn = this.dragConnection();
    if (conn) show('connect', rectSegs(HALF, HALF, 0), C_CONNECT, { width: 3, pulse: true, pos: [conn.x, conn.y, conn.z + 0.1] });

    for (const key of this.hintKeys) if (!shown.has(key)) fx.hide(key);
    this.hintKeys = shown;
  }

  private outlineSegs(id: number): number[] {
    const out: number[] = [];
    for (const mesh of this.meshCache.get(id)?.meshes ?? []) {
      if (mesh.userData.handle) continue;
      const e = new THREE.EdgesGeometry(mesh.geometry, mesh.userData.kind === 'rail' ? 50 : 30);
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
    if (!this.model.segs[id] && !this.model.nodes[id] && !this.model.rails[id]) return null;
    return { id, kind, point: hit.point.clone(), normal: hit.face.normal.clone() };
  }

  private rayOnPlaneZ(z: number): THREE.Vector3 | null {
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), p);
  }

  /** 当前生效的吸附器（Ctrl 临时切换格栅 / 自由） */
  private snap(): Snapper {
    this.snapper.grid = this.gridMode !== this.mods.ctrl;
    const dist = this.camera.position.distanceTo(this.controls.target);
    this.snapper.tol = THREE.MathUtils.clamp(dist * 0.015, 0.3, 2.5);
    return this.snapper;
  }
  /** 吸附所参照的模型：拖动中用拖动开始时的快照，避免吸附到自己 */
  private snapModel() { const d = this.drag; return d && 'snapshot' in d ? d.snapshot : this.model; }
  private noteGuide(r: SnapResult, axis: 0 | 1 | 2, at?: [number, number, number]) {
    if (!r.from || !at) return;
    const p = [...at] as [number, number, number];
    p[axis] = r.v;
    this.guides.push(...r.from, ...p);
  }
  /** 水平坐标吸附（截面、端点、边沿、路块中心——格栅模式下都是 2.5 的倍数） */
  private snapEdge(c: number, axis: 0 | 1, at?: [number, number, number]) {
    const r = this.snap().axis(this.snapModel(), axis, c);
    this.noteGuide(r, axis, at);
    return r.v;
  }
  private snapCenter(c: number, axis: 0 | 1, at?: [number, number, number]) { return this.snapEdge(c, axis, at); }
  private snapZ(z: number, at?: [number, number, number]) {
    const r = this.snap().z(this.snapModel(), z);
    this.noteGuide(r, 2, at);
    return r.v;
  }

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
    const t = this.tOfCoord(s, this.snapEdge(axisOf(s.dir) === 0 ? this.hover.point.x : this.hover.point.y, axisOf(s.dir)));
    if (t < -1e-6 || t > s.len + 1e-6) return null;
    return { s, t };
  }

  // ---------------- 动作判定 ----------------

  /** 悬停位置对应的动作：左键 = 拉长 / 开分叉 / 长出新路；Shift = 整个侧面拉成平台 */
  private actionFor(p: Pick): Action | null {
    const m = this.model;
    const shift = this.mods.shift;
    if (p.kind === 'rail') return this.railEndAction(p);
    if (this.tool === 'rail') {
      if (p.kind !== 'seg') return null;
      const s = m.segs[p.id];
      const { t } = this.segLocal(s, p.point);
      const k: EndKey = t < s.len / 2 ? 'a' : 'b';
      return isFree(s[k]) ? this.railStartAction(s, k) : null;
    }
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
        const c = this.snapEdge(coord, axisOf(out), [ex, ey, endZ(m, s, k)]);
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
    const c = this.snapCenter(axisOf(s.dir) === 0 ? p.point.x : p.point.y, axisOf(s.dir));
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
        extendTo(mm, id, 'b', this.snapEdge(coord, axisOf(side), [cx, cy, z]));
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
        extendTo(mm, id, 'b', this.snapEdge(coord, axisOf(dir), [n.x, n.y, n.z]));
        return { seg: id, key: 'b' };
      },
    };
  }

  private platformBranchAction(pid: number, p: Pick): Action | null {
    const n = this.model.nodes[pid];
    const run = edgeRunAt(n, p.point.x, p.point.y);
    if (!run) return null;
    const isX = axisOf(run.out) === 0;
    const along = this.snapCenter(isX ? p.point.y : p.point.x, isX ? 1 : 0);
    const cx = isX ? run.line : along, cy = isX ? along : run.line;
    const P = [-DY[run.out], DX[run.out]];
    const segs = [-P[0] * HALF, -P[1] * HALF, 0, P[0] * HALF, P[1] * HALF, 0, ...arrowSegs(run.out, 0, 3.5)];
    const valid = openingFits(cellSet(n), cx, cy, run.out);
    return {
      valid, reason: valid ? undefined : '这里放不下 5 宽的路口', segs, pos: [cx, cy, n.z + 0.08], color: C_CREATE, dir: run.out, z: n.z,
      apply: (mm, coord) => {
        const id = addSegAtPlatform(mm, pid, cx, cy, run.out);
        if (id === null) return null;
        extendTo(mm, id, 'b', this.snapEdge(coord, axisOf(run.out), [cx, cy, n.z]));
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
        const w = (this.snapEdge(coord, axisOf(side), [ex, ey, z]) - line) * sign;
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
        const w = (this.snapEdge(coord, axisOf(dir), [ex, ey, n.z]) - line) * sign;
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
        const w = (this.snapEdge(coord, axisOf(run.out), [ex, ey, n.z]) - run.line) * sign;
        if (Math.abs(w) < 1e-6) return null;
        // 往里推不能把平台推没
        const b = platformBBox(mm.nodes[pid]);
        const span = isX ? b.x1 - b.x0 : b.y1 - b.y0;
        extrudePlatform(mm, pid, run, Math.max(w, -span + 1.25));
        return null;
      },
    };
  }

  // ---------------- 钢轨 ----------------

  /** 由鼠标位置算出下一段钢轨。arc=false：直线；arc=true：与当前方向相切的圆弧 */
  private railPieceTo(E: RailState, mx: number, my: number, kind: RailKind, arc: boolean): RailPiece | null {
    const h = (E.heading * Math.PI) / 180;
    const fx = Math.cos(h), fy = Math.sin(h);
    const dx = mx - E.x, dy = my - E.y;
    const fwd = dx * fx + dy * fy, lat = -dx * fy + dy * fx;
    const sn = this.snap();
    if (!arc) {
      // 朝向与坐标轴平行时，按终点坐标吸附（可与其它元素对齐）；否则按长度吸附
      const hd = (((Math.round(E.heading) % 360) + 360) % 360);
      if (hd % 90 === 0) {
        const ax = (hd / 90) % 2 as 0 | 1;
        const sg = hd === 0 || hd === 90 ? 1 : -1;
        const start = ax === 0 ? E.x : E.y;
        const v = this.snapEdge(start + sg * fwd, ax, [E.x + fx * fwd, E.y + fy * fwd, E.z]);
        return { kind, len: (v - start) * sg, radius: 0, angle: 0, dz: 0 };
      }
      return { kind, len: sn.length(fwd), radius: 0, angle: 0, dz: 0 };
    }
    if (Math.abs(lat) < 0.5) return null;
    const R = (fwd * fwd + lat * lat) / (2 * Math.abs(lat));
    let th = Math.atan2(fwd, R - Math.abs(lat));
    if (th <= 0) th += Math.PI * 2;
    const st = sn.angleStep();
    const deg = Math.min(Math.max(Math.round((th * 180) / Math.PI / st) * st, st), 270);
    const radius = Math.max(sn.length(R), 2.5);
    return { kind, len: 0, radius, angle: deg * Math.sign(lat), dz: 0 };
  }

  /** 钢轨工具：从路面自由端拖出一条新钢轨（双轨，最顶端与路面顶面对齐） */
  private railStartAction(s: Seg, k: EndKey): Action {
    const m = this.model;
    const [ex, ey] = endPos(s, k);
    const out = k === 'a' ? opp(s.dir) : s.dir;
    const z = endZ(m, s, k);
    const E: RailState = { x: ex, y: ey, z: z - railTopOffset('double'), heading: out * 90 };
    return {
      valid: true, segs: arrowSegs(out, 0, 4), pos: [ex, ey, z + 0.3], color: C_RAIL, dir: out, z,
      apply: () => null,
      apply2: (mm, x, y) => {
        const p = this.railPieceTo(E, x, y, 'double', false);
        if (!p || p.len <= 1e-6) return;
        const id = mm.nextId++;
        mm.rails[id] = { id, ...E, pieces: [p] };
      },
    };
  }

  /** 钢轨端点：靠近端头 = 沿方向拉长 / 缩短（缩到 0 删除）；末端侧面 = 拐弯（圆弧）。中段不能开分叉。 */
  private railEndAction(p: Pick): Action | null {
    const r = this.model.rails[p.id];
    if (!r || !r.pieces.length) return null;
    const E = railEnd(r);
    const S: RailState = { x: r.x, y: r.y, z: r.z, heading: r.heading };
    const dE = Math.hypot(p.point.x - E.x, p.point.y - E.y), dS = Math.hypot(p.point.x - S.x, p.point.y - S.y);
    if (Math.min(dE, dS) > 6) return null;
    const atEnd = dE <= dS;
    const P = atEnd ? E : S;
    const h = (P.heading * Math.PI) / 180;
    const outSign = atEnd ? 1 : -1;
    // 相对端头：沿出口方向的距离、横向偏移
    const rx = p.point.x - P.x, ry = p.point.y - P.y;
    const back = -(rx * Math.cos(h) + ry * Math.sin(h)) * outSign;
    const lat = -rx * Math.sin(h) + ry * Math.cos(h);
    const turn = atEnd && back > 2;
    const rot = (q: number[], ang: number) => { for (let i = 0; i < q.length; i += 3) { const x = q[i], y = q[i + 1]; q[i] = x * Math.cos(ang) - y * Math.sin(ang); q[i + 1] = x * Math.sin(ang) + y * Math.cos(ang); } return q; };
    const dir = (((Math.round(P.heading / 90) % 4) + 4) % 4) as Dir;
    const last = r.pieces[r.pieces.length - 1];
    const kind: RailKind = last.kind === 'transition' ? 'mono' : last.kind;
    if (turn) {
      const sideAng = h + (lat >= 0 ? Math.PI / 2 : -Math.PI / 2);
      return {
        valid: true, segs: rot(arrowSegs(0, 0, 3.5), sideAng), pos: [E.x, E.y, E.z + 0.3], color: C_RAIL, dir, z: E.z,
        apply: () => null,
        apply2: (mm, x, y) => {
          const piece = this.railPieceTo(E, x, y, kind, true);
          if (piece) pushPiece(mm.rails[r.id], piece);
        },
      };
    }
    return {
      valid: true, segs: rot(arrowSegs(0, 0, 4), atEnd ? h : h + Math.PI), pos: [P.x, P.y, P.z + 0.3], color: C_RAIL, dir, z: P.z,
      apply: () => null,
      apply2: (mm, x, y) => {
        const rr = mm.rails[r.id];
        if (!atEnd) {
          // 起点：沿反方向延伸 / 缩短
          const piece = this.railPieceTo({ ...S, heading: S.heading + 180 }, x, y, kind, false);
          if (piece) extendStart(rr, piece.len);
          if (!rr.pieces.length) delete mm.rails[r.id];
          return;
        }
        const piece = this.railPieceTo(E, x, y, kind, false);
        if (!piece) return;
        if (piece.len < 0) {
          // 往回拖：缩短末段直线，缩到 0 就去掉这一段
          let backLen = -piece.len;
          while (backLen > 1e-6 && rr.pieces.length) {
            const lp = rr.pieces[rr.pieces.length - 1];
            if (lp.angle !== 0) break;
            const cut = Math.min(backLen, lp.len);
            lp.dz *= lp.len > 0 ? (lp.len - cut) / lp.len : 0;
            lp.len -= cut;
            backLen -= cut;
            if (lp.len <= 1e-6) rr.pieces.pop();
          }
          if (!rr.pieces.length) delete mm.rails[r.id];
          return;
        }
        if (piece.len > 1e-6) pushPiece(rr, piece);
      },
    };
  }

  private railMenu(p: Pick): (MenuItem | null)[] {
    const r = this.model.rails[p.id];
    const piece = nearestPiece(r, p.point.x, p.point.y);
    const cur = r.pieces[piece]?.kind ?? 'double';
    const names: Record<RailKind, string> = { double: '双轨', mono: '单轨', transition: '单双转换' };
    const editRail = (fn: (rr: Rail) => void) => () => this.mutate((mm) => { const rr = mm.rails[r.id]; if (rr) fn(rr); if (rr && !rr.pieces.length) delete mm.rails[r.id]; });
    const last = r.pieces[r.pieces.length - 1];
    const endKind: RailKind = last?.kind === 'transition' ? 'mono' : last?.kind ?? 'double';
    const spiral = (sg: number, up: number): MenuItem => ({
      label: `末端接螺旋：${sg > 0 ? '左' : '右'}旋${up > 0 ? '上升' : '下降'}`, hint: `半径 ${SPIRAL_RADIUS}，每圈 ${SPIRAL_SCREW}`,
      action: editRail((rr) => rr.pieces.push({ kind: endKind, len: 0, radius: SPIRAL_RADIUS, angle: 360 * sg, dz: SPIRAL_SCREW * up })),
    });
    const isSpiral = last && Math.abs(last.angle) >= 360;
    const kindItem = (k: RailKind): MenuItem => ({
      label: `这一段改为${names[k]}`, hint: cur === k ? '当前' : undefined, disabled: cur === k,
      action: editRail((rr) => { rr.pieces[piece].kind = k; }),
    });
    const sAt = nearestS(r, p.point.x, p.point.y);
    return [
      kindItem('double'), kindItem('mono'), kindItem('transition'),
      { label: '末端接单双转换', hint: `长 ${TRANSITION_LEN}`, action: editRail((rr) => rr.pieces.push({ kind: 'transition', len: TRANSITION_LEN, radius: 0, angle: 0, dz: 0 })) },
      null,
      spiral(1, -1), spiral(-1, -1), spiral(1, 1), spiral(-1, 1),
      { label: '螺旋加一圈', disabled: !isSpiral, action: editRail((rr) => { const q = rr.pieces[rr.pieces.length - 1]; const sg = Math.sign(q.angle); const per = q.dz / (Math.abs(q.angle) / 360); q.angle += 360 * sg; q.dz += per; }) },
      null,
      { label: '在此分隔', action: () => this.cutRailAt(r.id, sAt) },
      { label: '删除末段', action: editRail((rr) => { rr.pieces.pop(); }) },
      { label: '删除这条钢轨', hint: 'Del', action: () => this.mutate((mm) => { delete mm.rails[r.id]; }) },
    ];
  }

  private cutRailAt(id: number, s: number) {
    this.mutate((mm) => {
      const rr = mm.rails[id];
      const sn = this.snap();
      const tail = splitRail(rr, sn.length(s), mm.nextId);
      if (tail) { mm.rails[tail.id] = tail; mm.nextId++; }
    });
  }

  /** 钢轨端点落在路面自由端上时，调整高度让钢轨最顶端与路面顶面对齐 */
  private alignRailsToRoads(m: Model) {
    const roadEnds: { x: number; y: number; z: number; out: number }[] = [];
    for (const s of Object.values(m.segs)) for (const k of ['a', 'b'] as EndKey[]) {
      if (!isFree(s[k])) continue;
      const [x, y] = endPos(s, k);
      roadEnds.push({ x, y, z: endZ(m, s, k), out: (k === 'a' ? opp(s.dir) : s.dir) * 90 });
    }
    const same = (a: number, b: number) => ((((a - b) % 360) + 360) % 360) < 1e-3;
    for (const r of Object.values(m.rails)) {
      if (!r.pieces.length) continue;
      const first = r.pieces[0];
      for (const e of roadEnds) {
        if (Math.hypot(e.x - r.x, e.y - r.y) < 0.02 && same(e.out, r.heading)) r.z = e.z - railTopOffset(first.kind);
      }
      const E = railEnd(r);
      const last = r.pieces[r.pieces.length - 1];
      if (last.angle !== 0) continue;
      for (const e of roadEnds) {
        if (Math.hypot(e.x - E.x, e.y - E.y) < 0.02 && same(e.out, E.heading + 180)) last.dz += e.z - railTopOffset(last.kind) - E.z;
      }
    }
  }

  // ---------------- gizmo ----------------

  private gizmoTargetFor(p: Pick): GizmoTarget | null {
    return p.kind === 'rail' ? { type: 'rail', id: p.id } : { type: 'comp', id: p.id };
  }

  /** 手柄显示位置：悬停元素的中心 */
  private gizmoPos(m: Model, g: GizmoTarget): THREE.Vector3 | null {
    if (g.type === 'rail') { const r = m.rails[g.id]; return r ? new THREE.Vector3(r.x, r.y, r.z) : null; }
    const s = m.segs[g.id];
    if (s) { const t = s.len / 2; return new THREE.Vector3(s.x + DX[s.dir] * t, s.y + DY[s.dir] * t, zAt(m, s, t)); }
    const n = m.nodes[g.id];
    return n ? new THREE.Vector3(n.x, n.y, n.z) : null;
  }

  /** 吸附参照点：网格对齐的特征（直道取 a 端、节点取中心），保证移动后边沿仍落在格栅上 */
  private gizmoAnchor(m: Model, g: GizmoTarget): THREE.Vector3 | null {
    if (g.type === 'comp' && m.segs[g.id]) { const s = m.segs[g.id]; return new THREE.Vector3(s.x, s.y, endZ(m, s, 'a')); }
    return this.gizmoPos(m, g);
  }

  /** 整体平移：连通块内的路面、平台，以及端点搭在这段路上的钢轨 */
  private applyGizmo(m: Model, g: GizmoTarget, axis: 0 | 1 | 2, d: number): boolean {
    const v = [0, 0, 0];
    v[axis] = d;
    if (g.type === 'rail') { const r = m.rails[g.id]; r.x += v[0]; r.y += v[1]; r.z += v[2]; return true; }
    const ids = component(m, g.id);
    const ends: [number, number][] = [];
    for (const id of ids) {
      const s = m.segs[id];
      if (s) {
        for (const k of ['a', 'b'] as EndKey[]) { if (isFree(s[k])) ends.push(endPos(s, k)); }
        s.x += v[0]; s.y += v[1];
        for (const k of ['a', 'b'] as EndKey[]) { const e = s[k]; if (isFree(e)) e.z += v[2]; }
      }
      const n = m.nodes[id];
      if (n) {
        n.x += v[0]; n.y += v[1]; n.z += v[2];
        if (n.kind === 'platform' && n.cells) {
          const di = Math.round(v[0] / 1.25), dj = Math.round(v[1] / 1.25);
          n.cells = n.cells.map((c) => { const [i, j] = c.split(',').map(Number); return `${i + di},${j + dj}`; });
        }
      }
    }
    for (const r of Object.values(m.rails)) {
      const E = railEnd(r);
      if (ends.some(([x, y]) => Math.hypot(x - r.x, y - r.y) < 0.02 || Math.hypot(x - E.x, y - E.y) < 0.02)) { r.x += v[0]; r.y += v[1]; r.z += v[2]; }
    }
    return true;
  }

  private updateGizmo() {
    const h = this.hover;
    const active = this.mods.alt && this.tool === 'edit' && (!this.drag || this.drag.type === 'gizmo');
    if (!active) { this.gizmo.hide(); this.gizmoTarget = null; this.gizmoKey = ''; return; }
    if (this.drag?.type === 'gizmo') {
      const pos = this.gizmoPos(this.model, this.drag.target === this.gizmoTarget ? this.dragTargetNow() : this.drag.target);
      if (pos) this.gizmo.group.position.copy(pos);
      return;
    }
    if (!h || h.kind === undefined) { if (!this.gizmoTarget) this.gizmo.hide(); return; }
    const g = this.gizmoTargetFor(h);
    if (!g) return;
    const key = JSON.stringify(g) + '|' + this.undoStack.length;
    if (key === this.gizmoKey) return;
    this.gizmoKey = key;
    this.gizmoTarget = g;
    const pos = this.gizmoPos(this.model, g);
    if (!pos) return;
    this.gizmo.show(pos.add(new THREE.Vector3(0, 0, 0.3)), [true, true, true, true, true, true]);
  }

  /** 拖动中目标的当前位置（截面在拖动开始时已变成接头） */
  private dragTargetNow(): GizmoTarget {
    const d = this.drag as Extract<Drag, { type: 'gizmo' }>;
    return d.target;
  }

  private pickGizmo(): GizmoHandle | null {
    const hit = this.raycaster.intersectObjects(this.gizmo.pickables(), false)[0];
    return hit ? (hit.object.userData.gizmo as GizmoHandle) : null;
  }

  /** 鼠标射线在 gizmo 轴线上的投影参数 */
  private axisParam(origin: THREE.Vector3, axis: 0 | 1 | 2): number {
    const dir = new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0);
    const r = this.raycaster.ray;
    const w0 = new THREE.Vector3().subVectors(origin, r.origin);
    const a = dir.dot(dir), b = dir.dot(r.direction), c = r.direction.dot(r.direction);
    const dd = dir.dot(w0), e = r.direction.dot(w0);
    const den = a * c - b * b;
    if (Math.abs(den) < 1e-9) return 0;
    return (b * e - c * dd) / den;
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
    // gizmo 手柄优先
    if (e.altKey && this.gizmoTarget) {
      const hd = this.pickGizmo();
      if (hd) {
        e.preventDefault();
        const snapshot = cloneModel(this.model);
        const origin = this.gizmo.group.position.clone();
        const anchor = this.gizmoAnchor(this.model, this.gizmoTarget)!;
        this.drag = { type: 'gizmo', snapshot, target: this.gizmoTarget, handle: hd, origin, t0: this.axisParam(origin, hd.axis), ref: anchor.getComponent(hd.axis) };
        return;
      }
    }
    const p = this.pick();
    if (!p) { this.select(null); return; }
    e.preventDefault();
    this.hover = p;
    const snapshot = cloneModel(this.model);

    if (this.tool === 'cut') {
      if (p.kind === 'seg') this.cutAt(p);
      if (p.kind === 'rail') { const r = this.model.rails[p.id]; this.cutRailAt(r.id, nearestS(r, p.point.x, p.point.y)); }
      return;
    }
    if (e.altKey && p.kind === 'rail') {
      const r = this.model.rails[p.id];
      const n = new THREE.Vector3().subVectors(this.camera.position, p.point).setZ(0).normalize();
      if (r.pieces.length) this.drag = { type: 'railHeight', snapshot, rail: r.id, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, p.point), z0: p.point.z };
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
    const a = this.actionFor(p);
    this.select(p.id);
    if (!a) return;
    if (!a.valid) { if (a.reason) this.flashStatus(a.reason); return; }
    this.drag = { type: 'action', snapshot, action: a, sx: e.clientX, sy: e.clientY, started: false };
    this.overlayDirty = true;
  }

  private onMove(e: PointerEvent) {
    this.syncMods(e);
    this.setMouse(e);
    const d = this.drag;
    this.guides = [];
    if (!d) {
      // 悬停在 gizmo 手柄上时保持当前目标
      const hd = this.mods.alt && this.gizmoTarget ? this.pickGizmo() : null;
      this.gizmo.setHovered(hd);
      if (hd) return;
      const p = this.pick();
      const changed = (p?.id ?? null) !== (this.hover?.id ?? null);
      this.hover = p;
      if (changed || p) this.overlayDirty = true;
      if (changed) this.updateStatus();
      return;
    }
    if (d.type === 'orbit') return;
    if (d.type === 'gizmo') {
      const raw = d.ref + this.axisParam(d.origin, d.handle.axis) - d.t0;
      const at = d.origin.toArray() as [number, number, number];
      const v = d.handle.axis === 2 ? this.snapZ(raw, at) : this.snapEdge(raw, d.handle.axis, at);
      const m = cloneModel(d.snapshot);
      if (this.applyGizmo(m, d.target, d.handle.axis, v - d.ref)) {
        this.setModel(m);
        this.onStatus(`移动 ${'XYZ'[d.handle.axis]} ${v - d.ref >= 0 ? '+' : ''}${fmt(v - d.ref)}`);
      }
      this.overlayDirty = true;
      return;
    }
    if (d.type === 'action') {
      // 防止单击就改动结构：移动超过几个像素才开始
      if (!d.started && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
      d.started = true;
      const hit = this.rayOnPlaneZ(d.action.z);
      if (!hit) return;
      const m = cloneModel(d.snapshot);
      if (d.action.apply2) d.action.apply2(m, hit.x, hit.y);
      else this.growEnd = d.action.apply(m, axisOf(d.action.dir) === 0 ? hit.x : hit.y);
      this.setModel(m);
    } else if (d.type === 'railHeight') {
      const hit = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(d.plane, hit)) return;
      const m = cloneModel(d.snapshot);
      const r = m.rails[d.rail];
      const lp = r.pieces[r.pieces.length - 1];
      const endZ0 = railEnd(d.snapshot.rails[d.rail]).z;
      lp.dz += this.snapZ(endZ0 + hit.z - d.z0) - endZ0;
      this.setModel(m);
      this.onStatus(`末段高差 ${fmt(lp.dz)}，坡度 ${fmt(lp.dz / Math.max(pieceLength(lp), 1e-6))}`);
    } else if (d.type === 'height') {
      const hit = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(d.plane, hit)) return;
      const m = cloneModel(d.snapshot);
      const t = d.target(m);
      if (t === null) return;
      // 吸附的是目标高度本身（而不是变化量），这样斜坡中段也能调回整齐的高度
      const zt = typeof t === 'number' ? m.nodes[t].z : endZ(m, m.segs[t.seg], t.key);
      const dz = this.snapZ(zt + hit.z - d.z0) - zt;
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
    this.guides = [];
    normalize(m);
    this.alignRailsToRoads(m);
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
      this.mutate((m) => { if (m.rails[id]) delete m.rails[id]; else deleteElem(m, id); });
      this.select(null);
      return;
    }
    if (k === 'e') this.toggleHoveredEnd();
    if (k === '1') this.setTool('edit');
    if (k === '2') this.setTool('cut');
    if (k === '3') this.setTool('rail');
    if (k === 'g') this.setGridMode(!this.gridMode);
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
    const ts = this.tOfCoord(s, this.snapEdge(axisOf(s.dir) === 0 ? p.point.x : p.point.y, axisOf(s.dir)));
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
    const ts = this.tOfCoord(s, this.snapEdge(axisOf(s.dir) === 0 ? p.point.x : p.point.y, axisOf(s.dir)));
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
    const ground = this.rayOnPlaneZ(0);
    const items: (MenuItem | null)[] = p ? (p.kind === 'rail' ? this.railMenu(p) : this.menuItemsFor(p)) : [
      {
        label: '在此新建路块', hint: '双击空白处也可以', disabled: !ground,
        action: () => { if (ground) this.newBlockAt(ground); },
      },
      null,
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
        const ts = this.tOfCoord(s, this.snapEdge(axisOf(s.dir) === 0 ? p.point.x : p.point.y, axisOf(s.dir)));
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

  /** 新建独立的 1×1 路块：格栅模式下边沿对齐 2.5 的倍数 */
  private newBlockAt(p: THREE.Vector3) {
    const cx = this.snapEdge(p.x - HALF, 0) + HALF;
    const cy = this.snapEdge(p.y - HALF, 1) + HALF;
    this.guides = [];
    this.mutate((mm) => { addBlock(mm, cx, cy, 0); });
  }

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
    if (this.selected !== null && !this.model.segs[this.selected] && !this.model.nodes[this.selected] && !this.model.rails[this.selected]) this.selected = null;
    this.hover = null;
    this.display = this.model;
    this.syncMeshes();
    if (before) {
      for (const id of [...Object.keys(this.model.segs), ...Object.keys(this.model.nodes), ...Object.keys(this.model.rails)].map(Number)) {
        if (before.segs[id] || before.nodes[id] || before.rails?.[id]) continue;
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
      return s ? migrateModel(JSON.parse(s)) : null;
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
    if (h && h.kind === 'rail' && m.rails[h.id]) {
      const r = m.rails[h.id];
      const total = r.pieces.reduce((a, q) => a + pieceLength(q), 0);
      const kinds = new Set(r.pieces.map((q) => q.kind));
      info = `钢轨 #${r.id}  ${r.pieces.length} 段  长 ${fmt(total)}  ${[...kinds].map((k) => ({ double: '双轨', mono: '单轨', transition: '单双转换' })[k]).join('+')}`;
    } else if (h && h.kind === 'seg' && m.segs[h.id]) {
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
        const kind = n.kind === 'transition' ? (n.narrow ? '窄平凹转换' : '平凹转换') : cnt === 0 ? '1×1' : cnt === 2 ? '拐角' : cnt === 3 ? 'T 字路口' : '十字路口';
        info = `${kind} #${n.id}  高 ${fmt(n.z)}  ${n.style === 'sink' ? '凹槽' : '普通'}`;
      }
    }
    const hints: Record<Tool, string> = {
      edit: this.mods.shift ? 'Shift：拖动整个侧面拉成平台（平台边可往里推）'
        : this.mods.alt ? 'Alt：拖箭头沿 X/Y/Z 整体移动这一段路（不切断、不改坡度）；直接拖路面调高度 / 坡度'
        : '左键按示意方向拖：拉长 / 开路口（拉回 0 即删除）· Shift：拉平台 · Alt：改高度 · 中键：环视 · 右键：更多',
      cut: '点击截面：把花纹分开成两个封闭端点',
      rail: '从路面端点拖出钢轨 · 钢轨端头：沿方向拉长（拉回 0 删除）· 末端侧面：拐弯 · Alt 拖末端改坡度 · 右键：单轨/双轨/单双转换、螺旋',
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
