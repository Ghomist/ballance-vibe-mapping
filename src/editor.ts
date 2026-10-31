import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { buildElem, computeChains, elemKey, type MatName } from './geom/floor';
import { buildRail } from './geom/rail';
import { getMaterial, getRailMaterial } from './view/materials';
import { Gizmo, type GizmoHandle } from './view/gizmo';
import { Snapper, type SnapResult } from './view/snap';
import { Fx, rectSegs } from './view/fx';
import { createGrid } from './view/grid';
import { FaceFx, type FaceSpec, faceSegs } from './view/face';
import { assetVersion, fallbackBox, getAsset, getStopperMaterial, setAssetLoadedCallback } from './view/assets';
import { hasStopper, stopperMesh } from './model/stoppers';
import {
  addCheckpoint, checkpoints, findStart, moveSector, placeCheckpointOnSeg, placeStartAtEnd, prefabExtent, prefabParts, rotateCheckpoint,
} from './model/checkpoint';
import { buildGuard } from './geom/railing';
import { type Loop, outlineLoops, pointAt, project, projectNear } from './model/outline';
import { baseOf, placeBase, revertBase } from './model/bases';
import { exportScene } from './export/scene';
import { addObj, autoSector, followSurfaces, objSector, objType, sectorCount, surfacesAt } from './model/objects';
import { lerpModel } from './view/tween';
import {
  CELL, DX, DY, Dir, EndKey, HALF, MNode, Model, Prefab, Seg, Style,
  axisOf, cloneModel, emptyModel, endOutDir, endPos, endZ, isFree, migrateModel, nodeHalf, nodeLinks, nodePortDirs, nodePorts, opp, portCount, zAt,
} from './model/types';
import {
  Rail, RailKind, RailPiece, RailState, SPIRAL_RADIUS, SPIRAL_SCREW, TRANSITION_LEN, extendStart, nearestPiece, nearestS,
  pieceLength, pushPiece, railEnd, railTopOffset, splitRail, stateAt,
} from './model/rail';
import {
  type MoveInfo, addBlock, addSegAtPort, applyConnection, blockToSeg, cutJoint, movePiece, pieceOf, cutSeg, deleteElem, extendFlat, extendTo,
  findConnection, insertJoint, isSloped, makeBranch, normalize, setBlockStyle, setChainStyle, setSegStyle,
  setPlatformStyle, shiftDownstream, shiftFreeEnd, toggleEnd, tryConnect,
} from './model/ops';
import {
  addSegAtPlatform, blockToPlatform, boundaryEdges, cellSet, edgeRunAt, extrudePlatform, openingFits, platformBBox, segToPlatform,
} from './model/platform';

export type Tool = 'edit' | 'cut' | 'rail' | 'object' | 'guard';

/** 护栏工具悬停的东西：护栏的端头（拖动调长度）、护栏本身、或路面外沿上的一点（新建护栏） */
type GuardHover =
  | { type: 'end'; id: number; end: 'a' | 'b' }
  | { type: 'body'; id: number }
  | { type: 'edge'; loop: number; s: number };

/** 状态栏的一条操作提示：按键（LMB / MMB / RMB / Wheel / Shift / Ctrl / Alt / 字母…）+ 简短说明 */
export interface Hint { keys: string[]; label: string }

interface Pick {
  id: number;
  kind: 'seg' | 'node' | 'rail' | 'obj' | 'guard';
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
  /** 操作的截面：画成半透明的面 + 从面中心伸出的箭头（替代 segs 线框） */
  face?: FaceSpec;
  /** 需要完整平面坐标的动作（钢轨：直线 / 圆弧由鼠标位置决定） */
  apply2?: (m: Model, x: number, y: number) => void;
}

type Drag =
  | { type: 'action'; snapshot: Model; action: Action; sx: number; sy: number; started: boolean }
  | { type: 'height'; snapshot: Model; target: HeightTarget; plane: THREE.Plane; z0: number }
  | { type: 'railHeight'; snapshot: Model; rail: number; plane: THREE.Plane; z0: number }
  | { type: 'gizmo'; snapshot: Model; target: GizmoTarget; handle: GizmoHandle; origin: THREE.Vector3; t0: number; ref: number }
  | { type: 'obj'; snapshot: Model; id: number; ox: number; oy: number; moved: boolean; sx: number; sy: number }
  | { type: 'objHeight'; snapshot: Model; id: number; plane: THREE.Plane; z0: number }
  | { type: 'marquee'; sx: number; sy: number; add: boolean }
  | { type: 'guard'; snapshot: Model; id: number | null; end: 'a' | 'b'; loop: number; s0: number; s: number; sx: number; sy: number; started: boolean }
  | { type: 'orbit' };

/** gizmo 作用对象：悬停元素所在的“一块”（两个折点之间的直路，或单个路块 / 平台）或一整条钢轨 */
type GizmoTarget =
  | { type: 'comp'; id: number }
  | { type: 'rail'; id: number }
  | { type: 'multi'; ids: number[] };

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
const GHOST_MAT = new THREE.MeshBasicMaterial({ color: 0x9fd2ff, transparent: true, opacity: 0.35, depthWrite: false });

export class Editor {
  model: Model;
  tool: Tool = 'edit';
  /** 格栅模式：一切对齐到 2.5 的倍数；关闭后自由拖动并智能吸附 */
  gridMode = true;
  /** 自动对齐：靠近其它元素的边界 / 端点 / 高度时对齐过去（与格栅相互独立；自动连接不受它影响） */
  snapMode = true;
  /** 机关工具当前要放的物件类型 */
  objType = 'P_Extra_Point';
  onStatus: (s: string) => void = () => {};
  onChange: () => void = () => {};
  onHints: (h: Hint[]) => void = () => {};

  /** 正在显示的模型（向 model 平滑过渡） */
  private display: Model;
  private meshCache = new Map<number, { key: string; meshes: THREE.Mesh[] }>();
  /** 盘点上方的小节标签 */
  private cpLabels = new Map<number, CSS2DObject>();
  /** 机关工具：跟随鼠标的半透明预览 */
  private ghost = new THREE.Group();
  private ghostType = '';
  /** 机关工具：放置时在顺路方向的基础上再转的角度（R） */
  private placeRot = 0;
  private lastRotBase = 0;
  private lastPlaceZ = 0;
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
  private gizmoHover: GizmoHandle | null = null;
  private faceFx = new FaceFx();
  /** 多选（框选） */
  private selection = new Set<number>();
  private marquee: HTMLDivElement;
  private moveInfoCache: { key: string; info: MoveInfo | null } = { key: '', info: null };

  constructor(private host: HTMLElement) {
    this.loadPrefs();
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
    this.scene.add(this.ghost);
    this.scene.add(this.faceFx.group);
    this.scene.add(this.floor, this.fx.group, this.gizmo.group);

    this.marquee = document.createElement('div');
    this.marquee.className = 'marquee';
    host.appendChild(this.marquee);
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

    setAssetLoadedCallback(() => { this.syncMeshes(); this.overlayDirty = true; });
    this.syncMeshes();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------------- 公共接口 ----------------

  setTool(t: Tool) { this.tool = t; this.overlayDirty = true; this.updateGhost(); this.updateStatus(); this.onChange(); }

  setGridMode(on: boolean) { this.gridMode = on; this.savePrefs(); this.overlayDirty = true; this.updateStatus(); this.onChange(); }
  setSnapMode(on: boolean) { this.snapMode = on; this.savePrefs(); this.overlayDirty = true; this.updateStatus(); this.onChange(); }

  private savePrefs() {
    try { localStorage.setItem('bvm.prefs', JSON.stringify({ grid: this.gridMode, snap: this.snapMode })); } catch { /* 存不了就算了 */ }
  }
  private loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem('bvm.prefs') ?? '{}');
      if (typeof p.grid === 'boolean') this.gridMode = p.grid;
      if (typeof p.snap === 'boolean') this.snapMode = p.snap;
    } catch { /* 用默认值 */ }
  }

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

  /** 全图设置 */
  get settings() { return this.model.settings; }
  /** 改全图设置（可撤销）；道具离地高度变了，已放的道具一起升降 */
  setSettings(patch: Partial<Model['settings']>) {
    this.mutate((m) => {
      if (patch.propLift !== undefined) {
        const d = patch.propLift - m.settings.propLift;
        for (const o of Object.values(m.objs)) if (objType(o.type)?.prop) o.z += d;
      }
      Object.assign(m.settings, patch);
    });
  }

  /** 导出用的场景描述（交给 Blender + BBP 生成地图） */
  exportScene() { return exportScene(this.model); }

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
    this.faceFx.tick(dt);
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
    const ids = new Set([...Object.keys(m.segs), ...Object.keys(m.nodes), ...Object.keys(m.rails), ...Object.keys(m.objs), ...Object.keys(m.guards)].map(Number));
    const loops = outlineLoops(m);
    this.loops = loops;
    const loopsKey = JSON.stringify([loops.map((l) => [l.pts, l.closed]), m.settings]);
    for (const [id, c] of this.meshCache) {
      if (ids.has(id)) continue;
      for (const mesh of c.meshes) { if (!mesh.userData.shared && mesh.geometry !== RAIL_HANDLE_GEO) mesh.geometry.dispose(); this.floor.remove(mesh); }
      this.meshCache.delete(id);
    }
    for (const id of ids) {
      const rail = m.rails[id];
      const gd = m.guards[id];
      if (gd) {
        const gkey = JSON.stringify(gd) + loopsKey + assetVersion;
        const gc = this.meshCache.get(id);
        if (gc && gc.key === gkey) continue;
        if (gc) for (const mesh of gc.meshes) { if (!mesh.userData.shared) mesh.geometry.dispose(); this.floor.remove(mesh); }
        const meshes: THREE.Mesh[] = [];
        const b = buildGuard(loops, gd, m.settings);
        if (b) {
          const g = new THREE.BufferGeometry();
          g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
          g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
          const tube = new THREE.Mesh(g, getRailMaterial());
          tube.userData = { id, kind: 'guard' };
          meshes.push(tube);
          for (const part of b.nails) {
            for (const pc of getAsset('asset', part.name) ?? []) {
              const nm = new THREE.Mesh(pc.geometry, pc.material);
              nm.position.set(...part.pos);
              nm.rotation.z = (part.rotZ * Math.PI) / 180;
              nm.userData = { id, kind: 'guard', shared: true, element: true };
              nm.updateMatrixWorld();
              meshes.push(nm);
            }
          }
          for (const mesh of meshes) this.floor.add(mesh);
        }
        this.meshCache.set(id, { key: gkey, meshes });
        continue;
      }
      const obj = m.objs[id];
      if (obj) {
        const okey = JSON.stringify(obj) + ':' + assetVersion;
        const oc = this.meshCache.get(id);
        if (oc && oc.key === okey) continue;
        if (oc) for (const mesh of oc.meshes) { if (!mesh.userData.shared) mesh.geometry.dispose(); this.floor.remove(mesh); }
        const meshes = this.objMeshes(obj);
        for (const mesh of meshes) { mesh.userData = { id, kind: 'obj', shared: !mesh.userData.ownGeo }; this.floor.add(mesh); }
        this.meshCache.set(id, { key: okey, meshes });
        continue;
      }
      const prefab = m.nodes[id]?.kind === 'checkpoint' || m.nodes[id]?.kind === 'base' ? m.nodes[id] : null;
      // 平台平移过渡：按目标形状绘制，再整体偏移（见 lerpModel）
      const off = m.nodes[id]?.kind === 'platform' && this.model.nodes[id]?.kind === 'platform' ? m.nodes[id].dispOff ?? [0, 0, 0] : null;
      const km = off ? this.model : m;
      const key = rail ? JSON.stringify(rail) : `${elemKey(km, id, chains)}:${assetVersion}`;
      const cached = this.meshCache.get(id);
      if (cached && cached.key === key) {
        if (off) for (const mesh of cached.meshes) mesh.position.set(...off);
        continue;
      }
      if (cached) for (const mesh of cached.meshes) { if (!mesh.userData.shared && mesh.geometry !== RAIL_HANDLE_GEO) mesh.geometry.dispose(); this.floor.remove(mesh); }
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
      if (prefab) {
        this.buildPrefabMeshes(m, prefab, meshes);
        this.meshCache.set(id, { key, meshes });
        continue;
      }
      const em = buildElem(km, id, chains);
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
      if (off) for (const mesh of meshes) mesh.position.set(...off);
      this.meshCache.set(id, { key, meshes });
    }
    this.pickables = [...this.meshCache.values()].flatMap((c) => c.meshes);
    this.syncCheckpointLabels(m);
  }

  /** 盘点路面：资产库模型 + 火焰 / 重生点占位符（模型未加载时先用盒子占位） */
  private buildPrefabMeshes(m: Model, n: MNode, out: THREE.Mesh[]) {
    for (const part of prefabParts(m, n)) {
      let pieces = getAsset(part.type, part.name);
      let shared = true;
      if (!pieces) {
        if (part.type !== 'asset') continue;
        const e = prefabExtent(n);
        pieces = [fallbackBox(e.along * 2, e.across * 2, 5)];
        shared = false;
      }
      for (const pc of pieces) {
        const mesh = new THREE.Mesh(pc.geometry, pc.material);
        mesh.position.set(...part.pos);
        mesh.rotation.set(0, ((part.pitch ?? 0) * Math.PI) / 180, (part.rotZ * Math.PI) / 180, 'ZYX');
        mesh.userData = { id: n.id, kind: 'node', shared, element: part.type === 'element' };
        mesh.updateMatrixWorld();
        this.floor.add(mesh);
        out.push(mesh);
      }
    }
  }

  private objMeshes(o: { type: string; x: number; y: number; z: number; rot: number }, ghost = false): THREE.Mesh[] {
    const t = objType(o.type);
    const pieces = getAsset(t?.cat === 'deco' ? 'asset' : 'element', o.type) ?? [];
    const out = pieces.map((pc) => {
      const mesh = new THREE.Mesh(pc.geometry, ghost ? GHOST_MAT : pc.material);
      mesh.position.set(o.x, o.y, o.z);
      mesh.rotation.z = (o.rot * Math.PI) / 180;
      mesh.updateMatrixWorld();
      return mesh;
    });
    // 挡块
    const st = stopperMesh({ id: 0, cat: 'module', ...o, x: ghost ? 0 : o.x, y: ghost ? 0 : o.y, z: ghost ? 0 : o.z });
    if (st) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(st.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(st.uv, 2));
      g.computeVertexNormals();
      const mesh = new THREE.Mesh(g, ghost ? GHOST_MAT : getStopperMaterial());
      if (ghost) mesh.rotation.z = (o.rot * Math.PI) / 180;
      mesh.userData.ownGeo = true;
      out.push(mesh);
    }
    return out;
  }

  /** 当前的路面外沿（随网格同步更新） */
  private loops: Loop[] = [];

  private syncCheckpointLabels(m: Model) {
    const live = new Set<number>();
    for (const n of Object.values(m.nodes)) {
      if (n.kind !== 'checkpoint') continue;
      live.add(n.id);
      let l = this.cpLabels.get(n.id);
      if (!l) {
        const div = document.createElement('div');
        div.className = 'cp-label';
        l = new CSS2DObject(div);
        this.scene.add(l);
        this.cpLabels.set(n.id, l);
      }
      const text = n.prefab === 'start' ? '起点 · 第 1 小节' : `第 ${n.sector} 小节`;
      if (l.element.textContent !== text) l.element.textContent = text;
      l.position.set(n.x, n.y, n.z + 9);
    }
    for (const [id, l] of this.cpLabels) {
      if (live.has(id)) continue;
      this.scene.remove(l);
      l.element.remove();
      this.cpLabels.delete(id);
    }
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
    if (this.selection.size) {
      const segs: number[] = [];
      for (const id of this.selection) segs.push(...this.outlineSegs(id));
      show('multi', segs, C_SELECT, { width: 2, opacity: 0.9, gradient: true });
    }

    // 动作示意（左键 / Shift）
    this.action = h && this.tool !== 'cut' && !this.mods.alt && !this.mods.ctrl ? this.actionFor(h) : null;
    const a = this.action;
    if (a) {
      const color = a.valid ? a.color : C_INVALID;
      if (a.face) show(this.mods.shift ? 'act-extrude' : 'act', faceSegs(a.face), color, { width: 2, pos: [a.face.x, a.face.y, a.face.z] });
      else show(this.mods.shift ? 'act-extrude' : 'act', a.segs, color, { width: 2.5, pos: a.pos });
    }
    this.faceFx.set(a?.face ?? null, a?.valid ? a.color : C_INVALID);

    // 护栏工具：悬停的外沿直边（点一下就沿这条边放护栏）或护栏端头
    if (this.tool === 'guard' && h && !this.drag) {
      const g = this.guardHoverAt(h);
      if (g?.type === 'edge') {
        const l = this.loops[g.loop];
        const i = pointAt(l, g.s).seg;
        show('guard-preview', this.guardFrame([l.pts[i], l.pts[(i + 1) % l.pts.length]], l.outs[i]), C_CREATE, { width: 2, opacity: 0.85 });
      } else if (g?.type === 'end') {
        const gd = this.model.guards[g.id];
        const p = gd[g.end];
        show('guard-preview', [p[0], p[1], p[2] - 1.5, p[0], p[1], p[2] + this.model.settings.guardTop + 0.6], C_SELECT, { width: 3 });
      }
    }

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
        const face: FaceSpec = { x: pos[0], y: pos[1], z: pos[2] - 0.04, dir: s.dir, w: 5, arrow: 'updown' };
        show('section', faceSegs(face), C_SECTION, { width: 2, pos: [face.x, face.y, face.z] });
        this.faceFx.set(face, C_SECTION);
      }
    }
    // Alt：哪部分会跟着升降（高亮）、哪段会变成坡道（虚线），其余保持不动
    if (this.tool === 'edit' && this.mods.alt && !this.drag && h && h.kind !== 'rail' && h.kind !== 'obj') {
      const pv = this.slopePreview(h);
      if (pv) {
        show('slope-moved', pv.moved, C_SECTION, { width: 1.5, opacity: 0.6, gradient: true });
        show('slope-ramp', pv.ramp, 0xff8a3d, { width: 2, opacity: 0.95, dashed: true });
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
    const gt = this.gizmoTarget;
    if (gt && this.gizmo.active && gt.type !== 'rail') {
      const piece = this.gizmoPieceIds(this.model, gt);
      const segs: number[] = [];
      for (const id of piece) segs.push(...this.outlineSegs(id));
      show('piece', segs, 0x9fd2ff, { width: 2, opacity: 0.8, gradient: true });
      // 移动边界：悬停在箭头上（或拖动中）时，预览哪些会整体平移、哪些会伸缩 / 变坡
      const hd = this.drag?.type === 'gizmo' ? this.drag.handle : this.gizmoHover;
      const info = hd ? this.moveInfo(gt, hd) : null;
      if (info) {
        const mv: number[] = [], st: number[] = [];
        for (const id of info.moved) if (!piece.has(id)) mv.push(...this.outlineSegs(id));
        for (const id of info.stretched) st.push(...this.outlineSegs(id));
        show('piece-moved', mv, 0x9fd2ff, { width: 1.5, opacity: 0.55 });
        show('piece-stretch', st, 0xffc640, { width: 1.5, opacity: 0.85, dashed: true });
      }
    }

    // 拖拽中：可连接提示
    const conn = this.dragConnection();
    if (conn) show('connect', rectSegs(HALF, HALF, 0), C_CONNECT, { width: 3, pulse: true, pos: [conn.x, conn.y, conn.z + 0.1] });

    for (const key of this.hintKeys) if (!shown.has(key)) fx.hide(key);
    this.updateCursor();
    this.updateHints();
    this.hintKeys = shown;
  }

  /** 护栏工具：鼠标下是什么 */
  private guardHoverAt(p: Pick): GuardHover | null {
    const m = this.model;
    if (p.kind === 'guard' && m.guards[p.id]) {
      const gd = m.guards[p.id];
      for (const end of ['a', 'b'] as const) {
        const q = gd[end];
        if (Math.hypot(q[0] - p.point.x, q[1] - p.point.y) < 2.5) return { type: 'end', id: gd.id, end };
      }
      return { type: 'body', id: gd.id };
    }
    if (p.kind === 'obj' || p.kind === 'rail') return null;
    const pr = project(this.loops, [p.point.x, p.point.y, p.point.z]);
    if (!pr || pr.dist > 2.5) return null;
    return { type: 'edge', loop: pr.loop, s: pr.s };
  }

  /** 沿外沿的一段护栏示意框：底线、顶线、两头竖线（往外偏移到护栏的位置） */
  private guardFrame(pts: [number, number, number][], out: [number, number]): number[] {
    const st = this.model.settings;
    const o = st.guardOffset;
    const res: number[] = [];
    const P = pts.map((q) => [q[0] + out[0] * o, q[1] + out[1] * o, q[2]]);
    for (let i = 0; i + 1 < P.length; i++) {
      const a = P[i], b = P[i + 1];
      res.push(a[0], a[1], a[2] + 0.05, b[0], b[1], b[2] + 0.05);
      res.push(a[0], a[1], a[2] + st.guardTop, b[0], b[1], b[2] + st.guardTop);
    }
    for (const q of [P[0], P[P.length - 1]]) res.push(q[0], q[1], q[2] - st.guardPostDepth, q[0], q[1], q[2] + st.guardTop);
    return res;
  }

  /** 护栏端点沿外沿拖动：鼠标投影到外沿上，就近展开（能绕过拐角），再按格栅 / 自动对齐吸附 */
  private guardDragS(d: Extract<Drag, { type: 'guard' }>): number | null {
    const l = this.loops[d.loop];
    if (!l) return null;
    const z = pointAt(l, d.s).p[2];
    const hit = this.rayOnPlaneZ(z);
    if (!hit) return null;
    // 只在当前位置附近连续移动（斜着拖过路面不会跳到对面的路边）
    const s = projectNear(l, hit.x, hit.y, d.s);
    // 吸附：拐角（顶点）、格栅
    const { seg } = pointAt(l, s);
    const base = l.closed ? Math.floor(s / l.len) * l.len : 0;
    const s0 = base + l.cum[seg], s1 = base + l.cum[seg + 1];
    const tol = this.snapMode ? this.snap().tol : 0;
    if (s - s0 < tol) return s0;
    if (s1 - s < tol) return s1;
    const a = l.pts[seg], b = l.pts[(seg + 1) % l.pts.length];
    const ax = Math.abs(b[0] - a[0]) >= Math.abs(b[1] - a[1]) ? 0 : 1;
    const q = pointAt(l, s).p;
    const v = this.snapEdge(q[ax], ax as 0 | 1, q);
    return Math.min(Math.max(s0 + Math.abs(v - a[ax]) * (s1 - s0) / Math.max(Math.abs(b[ax] - a[ax]), 1e-9), s0), s1);
  }

  private slopeCache: { key: string; v: { moved: number[]; ramp: number[] } | null } = { key: '', v: null };

  /** Alt 调高度的预览：试着把目标抬高一点，看哪些元素整体升降、哪些直道变成坡道 */
  private slopePreview(p: Pick): { moved: number[]; ramp: number[] } | null {
    const sec = this.hoverSection();
    const key = `${p.id}|${sec ? sec.t.toFixed(3) : ''}|${this.undoStack.length}`;
    if (this.slopeCache.key === key) return this.slopeCache.v;
    const target = this.heightTarget(p);
    let v: { moved: number[]; ramp: number[] } | null = null;
    if (target) {
      const m0 = cloneModel(this.model);
      const t = target(m0);
      if (t !== null) {
        const m1 = cloneModel(m0);
        if (typeof t === 'number') shiftDownstream(m1, t, 1); else shiftFreeEnd(m1, t.seg, t.key, 1);
        v = { moved: [], ramp: [] };
        const zs = (mm: Model, s: Seg) => [endZ(mm, s, 'a'), endZ(mm, s, 'b')];
        for (const s of Object.values(m0.segs)) {
          const s1 = m1.segs[s.id];
          if (!s1) continue;
          const [a0, b0] = zs(m0, s), [a1, b1] = zs(m1, s1);
          const ca = Math.abs(a1 - a0) > 1e-6, cb = Math.abs(b1 - b0) > 1e-6;
          if (ca && cb) v.moved.push(...topRect(m0, s));
          else if (ca || cb) v.ramp.push(...topRect(m0, s));
        }
        for (const n of Object.values(m0.nodes)) {
          const n1 = m1.nodes[n.id];
          if (!n1 || Math.abs(n1.z - n.z) < 1e-6 || n.kind === 'joint') continue;
          if (n.kind === 'platform') {
            const b = platformBBox(n);
            v.moved.push(...rectLoop(b.x0, b.y0, b.x1, b.y1, n.z));
          } else {
            const hh = nodeHalf(n);
            v.moved.push(...rectLoop(n.x - hh, n.y - hh, n.x + hh, n.y + hh, n.z));
          }
        }
      }
    }
    this.slopeCache = { key, v };
    return v;
  }

  /** 鼠标指针：按当前能做的事切换 */
  private updateCursor() {
    const d = this.drag;
    const h = d ? null : this.hover;
    let c = 'default';
    if (d) c = d.type === 'marquee' ? 'crosshair' : d.type === 'height' || d.type === 'railHeight' || d.type === 'objHeight' ? 'ns-resize' : 'grabbing';
    else if (this.gizmoHover && this.gizmo.active) c = 'grab';
    else if (this.tool === 'object') c = h?.kind === 'obj' ? 'grab' : 'copy';
    else if (this.tool === 'guard') { const g = h ? this.guardHoverAt(h) : null; c = !g ? 'default' : g.type === 'end' ? 'ew-resize' : g.type === 'body' ? 'pointer' : 'copy'; }
    else if (!h) c = 'default';
    else if (h.kind === 'obj') c = this.mods.alt ? 'ns-resize' : 'grab';
    else if (this.tool === 'cut') c = h.kind === 'seg' || h.kind === 'rail' ? 'crosshair' : 'not-allowed';
    else if (this.mods.alt) c = 'ns-resize';
    else if (this.mods.ctrl) c = 'default';
    else if (this.action) c = this.action.valid ? this.dirCursor(this.action) : 'not-allowed';
    const el = this.renderer.domElement;
    if (el.style.cursor !== c) el.style.cursor = c;
  }

  /** 按操作方向在屏幕上的朝向选双向箭头指针 */
  private dirCursor(a: Action): string {
    const p = a.face ? [a.face.x, a.face.y, a.face.z] : a.pos;
    const s0 = this.projectToClient(p[0], p[1], p[2]);
    const s1 = this.projectToClient(p[0] + DX[a.dir] * 5, p[1] + DY[a.dir] * 5, p[2]);
    const ang = ((Math.atan2(s1.y - s0.y, s1.x - s0.x) * 180) / Math.PI + 180) % 180;
    return ang < 22.5 || ang >= 157.5 ? 'ew-resize' : ang < 67.5 ? 'nwse-resize' : ang < 112.5 ? 'ns-resize' : 'nesw-resize';
  }

  private outlineSegs(id: number): number[] {
    const out: number[] = [];
    for (const mesh of this.meshCache.get(id)?.meshes ?? []) {
      if (mesh.userData.handle || mesh.userData.element) continue;
      const e = new THREE.EdgesGeometry(mesh.geometry, mesh.userData.kind === 'rail' ? 50 : 30);
      if (mesh.userData.shared) e.applyMatrix4(mesh.matrixWorld);
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
    if (!this.model.segs[id] && !this.model.nodes[id] && !this.model.rails[id] && !this.model.objs[id] && !this.model.guards[id]) return null;
    return { id, kind, point: hit.point.clone(), normal: hit.face.normal.clone() };
  }

  private rayOnPlaneZ(z: number): THREE.Vector3 | null {
    const p = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -z), p);
  }

  /** 拖动中按住 Alt：临时切换格栅 / 自由对齐（以 Alt 开始的调高度拖动除外） */
  get gridFlipped() {
    const d = this.drag;
    return !!d && this.mods.alt && !['orbit', 'height', 'railHeight', 'objHeight'].includes(d.type);
  }
  private snap(): Snapper {
    this.snapper.grid = this.gridMode !== this.gridFlipped;
    this.snapper.snap = this.snapMode;
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
  private snapEdge(c: number, axis: 0 | 1, at?: [number, number, number], step?: number) {
    const r = this.snap().axis(this.snapModel(), axis, c, undefined, step);
    this.noteGuide(r, axis, at);
    return r.v;
  }
  /** 路口中心：自由模式下连续移动，只在边沿 / 中心贴近别的特征时吸附 */
  private snapCenter(c: number, axis: 0 | 1, at?: [number, number, number]) {
    const r = this.snap().band(this.snapModel(), axis, c, HALF);
    this.noteGuide(r, axis, at);
    return r.v;
  }
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
    if (p.kind === 'obj' || p.kind === 'guard' || this.tool === 'object' || this.tool === 'guard') return null;
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
    if ((n.kind === 'checkpoint' || n.kind === 'base') && !shift) {
      // 盘点只能从延伸段末端的路口长出路：取鼠标所在一侧
      const dx = p.point.x - n.x, dy = p.point.y - n.y;
      const dot = (d: Dir) => DX[d] * dx + DY[d] * dy;
      const dir = nodePortDirs(n).reduce((a, b) => (dot(b) > dot(a) ? b : a));
      return this.blockGrowAction(n.id, dir);
    }
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
      face: { x: ex, y: ey, z: endZ(m, s, k), dir: out, w: 5 },
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
    const t0 = Math.min(Math.max(this.segLocal(s, p.point).t, HALF), s.len - HALF);
    const at0: [number, number, number] = [s.x + DX[s.dir] * t0, s.y + DY[s.dir] * t0, zAt(m, s, t0)];
    const c = this.snapCenter(axisOf(s.dir) === 0 ? p.point.x : p.point.y, axisOf(s.dir), at0);
    const tc = Math.min(Math.max(this.tOfCoord(s, c), HALF), s.len - HALF);
    const cx = s.x + DX[s.dir] * tc, cy = s.y + DY[s.dir] * tc, z = zAt(m, s, tc);
    const base = {
      segs: [...rectSegs(HALF, HALF, 0), ...arrowSegs(side, HALF, 3.5)], pos: [cx, cy, z + 0.08] as [number, number, number], color: C_CREATE, dir: side, z,
      face: { x: cx + DX[side] * HALF, y: cy + DY[side] * HALF, z, dir: side, w: 5 },
    };
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
    const base = {
      segs: arrowSegs(dir, nodeHalf(n), 3.5), pos: [n.x, n.y, n.z + 0.08] as [number, number, number], color: C_CREATE, dir, z: n.z,
      face: { x: n.x + DX[dir] * nodeHalf(n), y: n.y + DY[dir] * nodeHalf(n), z: n.z, dir, w: 5 },
    };
    if (ports[dir]) return { ...base, valid: false, reason: '这一侧已经连着路了', apply: () => null };
    const lone = n.kind === 'block' && portCount(ports) === 0;
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
    const raw = isX ? p.point.y : p.point.x;
    // 开口必须整个落在这段边上：中心限制在两端各让出 2.5 的范围里
    const lo = run.from + HALF, hi = run.to - HALF;
    const clampA = (v: number) => (hi >= lo ? Math.min(Math.max(v, lo), hi) : (run.from + run.to) / 2);
    const a0 = clampA(raw);
    let along = this.snapCenter(raw, isX ? 1 : 0, isX ? [run.line, a0, n.z] : [a0, run.line, n.z]);
    // 平台按 1.25 的小格记录，开口也对齐小格
    along = clampA(Math.round(along / CELL) * CELL);
    const cx = isX ? run.line : along, cy = isX ? along : run.line;
    const P = [-DY[run.out], DX[run.out]];
    const segs = [-P[0] * HALF, -P[1] * HALF, 0, P[0] * HALF, P[1] * HALF, 0, ...arrowSegs(run.out, 0, 3.5)];
    const valid = openingFits(cellSet(n), cx, cy, run.out);
    return {
      valid, reason: valid ? undefined : '这里放不下 5 宽的路口', segs, pos: [cx, cy, n.z + 0.08], color: C_CREATE, dir: run.out, z: n.z,
      face: { x: cx, y: cy, z: n.z, dir: run.out, w: 5 },
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
    const base = {
      segs: this.sideSegs(s.len / 2, side), pos: [ex, ey, z + 0.08] as [number, number, number], color: C_EXTRUDE, dir: side, z,
      face: { x: ex, y: ey, z, dir: side, w: s.len },
    };
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
      face: { x: ex, y: ey, z: n.z, dir, w: 5 },
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
      face: { x: ex, y: ey, z: n.z, dir: run.out, w: run.to - run.from },
      apply: (mm, coord) => {
        const w = (this.snapEdge(coord, axisOf(run.out), [ex, ey, n.z]) - run.line) * sign;
        if (Math.abs(w) < 1e-6) return null;
        // 往里推最多推过整个平台（推空即删除，推断则拆成几块）
        const b = platformBBox(mm.nodes[pid]);
        const span = isX ? b.x1 - b.x0 : b.y1 - b.y0;
        extrudePlatform(mm, pid, run, Math.max(w, -span));
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
      { label: '删除这条钢轨', hint: 'X / Del', action: () => this.mutate((mm) => { delete mm.rails[r.id]; }) },
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

  /** 屏幕矩形内的元素：直道看中点或两端，节点看中心（接头不算），钢轨看起点 / 终点 / 中点 */
  private idsInRect(x0: number, y0: number, x1: number, y1: number): number[] {
    const m = this.model;
    const inside = (p: [number, number, number]) => { const c = this.projectToClient(...p); return c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1; };
    const out: number[] = [];
    for (const s of Object.values(m.segs)) {
      if (s.len <= 1e-6) continue;
      const [ax, ay] = endPos(s, 'a'), [bx, by] = endPos(s, 'b');
      const t = s.len / 2;
      if (inside([s.x + DX[s.dir] * t, s.y + DY[s.dir] * t, zAt(m, s, t)]) || (inside([ax, ay, endZ(m, s, 'a')]) && inside([bx, by, endZ(m, s, 'b')]))) out.push(s.id);
    }
    for (const n of Object.values(m.nodes)) {
      if (n.kind === 'joint' || n.inPlatform !== undefined) continue;
      if (inside([n.x, n.y, n.z])) out.push(n.id);
    }
    for (const r of Object.values(m.rails)) {
      const E = railEnd(r);
      if (inside([r.x, r.y, r.z]) || inside([E.x, E.y, E.z])) out.push(r.id);
    }
    for (const o of Object.values(m.objs)) if (inside([o.x, o.y, o.z])) out.push(o.id);
    return out;
  }

  // ---------------- gizmo ----------------

  private gizmoTargetFor(p: Pick): GizmoTarget | null {
    if (p.kind === 'obj' || p.kind === 'guard') return null;
    return p.kind === 'rail' ? { type: 'rail', id: p.id } : { type: 'comp', id: p.id };
  }

  /** 手柄显示位置：悬停元素的中心 */
  private gizmoPos(m: Model, g: GizmoTarget): THREE.Vector3 | null {
    if (g.type === 'rail') { const r = m.rails[g.id]; return r ? new THREE.Vector3(r.x, r.y, r.z) : null; }
    if (g.type === 'multi') {
      // 多选：包围盒中心，高度取最高处
      const pts: [number, number, number][] = [];
      for (const id of g.ids) {
        const s = m.segs[id], n = m.nodes[id], r = m.rails[id], o = m.objs[id];
        if (s) for (const k of ['a', 'b'] as EndKey[]) { const [x, y] = endPos(s, k); pts.push([x, y, endZ(m, s, k)]); }
        else if (n && n.kind === 'platform') { const b = platformBBox(n); pts.push([b.x0, b.y0, n.z], [b.x1, b.y1, n.z]); }
        else if (n) pts.push([n.x, n.y, n.z]);
        else if (r) { const E = railEnd(r); pts.push([r.x, r.y, r.z], [E.x, E.y, E.z]); }
        else if (o) pts.push([o.x, o.y, o.z]);
      }
      if (!pts.length) return null;
      const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
      return new THREE.Vector3((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, Math.max(...pts.map((p) => p[2])));
    }
    const s = m.segs[g.id];
    if (s) { const t = s.len / 2; return new THREE.Vector3(s.x + DX[s.dir] * t, s.y + DY[s.dir] * t, zAt(m, s, t)); }
    const n = m.nodes[g.id];
    return n ? new THREE.Vector3(n.x, n.y, n.z) : null;
  }

  /** 吸附参照点：网格对齐的特征（直道取 a 端、节点取中心），保证移动后边沿仍落在格栅上 */
  private gizmoAnchor(m: Model, g: GizmoTarget): THREE.Vector3 | null {
    if (g.type === 'comp' && m.segs[g.id]) { const s = m.segs[g.id]; return new THREE.Vector3(s.x, s.y, endZ(m, s, 'a')); }
    if (g.type === 'multi') {
      const sid = g.ids.find((id) => m.segs[id]);
      if (sid !== undefined) { const sg = m.segs[sid]; return new THREE.Vector3(sg.x, sg.y, endZ(m, sg, 'a')); }
      const nid = g.ids.find((id) => m.nodes[id]);
      if (nid !== undefined) { const n = m.nodes[nid]; return new THREE.Vector3(n.x, n.y, n.z); }
    }
    return this.gizmoPos(m, g);
  }

  /** gizmo 要移动的路面元素：悬停的那一块，或多选的全部 */
  private gizmoPieceIds(m: Model, g: GizmoTarget): Set<number> {
    if (g.type === 'comp') return m.segs[g.id] || m.nodes[g.id] ? pieceOf(m, g.id) : new Set();
    if (g.type === 'multi') return new Set(g.ids.filter((id) => m.segs[id] || m.nodes[id]));
    return new Set();
  }

  /** 只移动这一块（或选中的这一坨）；边界外的路面自适应伸缩 / 成坡 */
  private applyGizmo(m: Model, g: GizmoTarget, axis: 0 | 1 | 2, d: number, info?: MoveInfo): boolean {
    const v = [0, 0, 0];
    v[axis] = d;
    if (g.type === 'rail') { const r = m.rails[g.id]; r.x += v[0]; r.y += v[1]; r.z += v[2]; return true; }
    const piece = this.gizmoPieceIds(m, g);
    if (piece.size && !movePiece(m, piece, v[0], v[1], v[2], info)) return false;
    if (g.type === 'multi') {
      for (const id of g.ids) {
        const r = m.rails[id];
        if (r && !info?.moved.has(id)) { r.x += v[0]; r.y += v[1]; r.z += v[2]; }
        const o = m.objs[id];
        if (o) { o.x += v[0]; o.y += v[1]; o.z += v[2]; }
      }
    }
    return piece.size > 0 || g.type === 'multi';
  }

  private moveInfo(g: GizmoTarget, hd: GizmoHandle): MoveInfo | null {
    const base = this.drag?.type === 'gizmo' ? this.drag.snapshot : this.model;
    const key = `${JSON.stringify(g)}|${hd.axis}|${hd.sign}|${this.undoStack.length}|${this.drag?.type ?? ''}`;
    if (this.moveInfoCache.key === key) return this.moveInfoCache.info;
    const info: MoveInfo = { moved: new Set(), stretched: new Set() };
    const ok = this.applyGizmo(cloneModel(base), g, hd.axis, hd.sign * 2.5, info);
    this.moveInfoCache = { key, info: ok || info.moved.size ? info : null };
    return this.moveInfoCache.info;
  }

  private updateGizmo() {
    const h = this.hover;
    const active = this.drag?.type === 'gizmo' || (this.mods.ctrl && !this.mods.alt && this.tool === 'edit' && !this.drag);
    if (!active) { this.gizmo.hide(); this.gizmoTarget = null; this.gizmoKey = ''; return; }
    if (this.drag?.type === 'gizmo') {
      const pos = this.gizmoPos(this.model, this.drag.target === this.gizmoTarget ? this.dragTargetNow() : this.drag.target);
      if (pos) this.gizmo.group.position.copy(pos);
      return;
    }
    const sel = [...this.selection].filter((id) => this.model.segs[id] || this.model.nodes[id] || this.model.rails[id] || this.model.objs[id]);
    if (!sel.length && (!h || h.kind === undefined)) { if (!this.gizmoTarget) this.gizmo.hide(); return; }
    const g: GizmoTarget | null = sel.length ? { type: 'multi', ids: sel } : this.gizmoTargetFor(h!);
    if (!g) return;
    const key = JSON.stringify(g) + '|' + this.undoStack.length;
    if (key === this.gizmoKey) return;
    this.gizmoKey = key;
    this.gizmoTarget = g;
    const pos = this.gizmoPos(this.model, g);
    if (!pos) return;
    // 逐个方向试算：会把相邻路段压成负长度的方向不可用
    const valid: boolean[] = [];
    for (const axis of [0, 1, 2] as const) for (const sg of [1, -1]) valid.push(this.applyGizmo(cloneModel(this.model), g, axis, sg * 2.5));
    this.gizmo.show(pos.add(new THREE.Vector3(0, 0, 0.3)), valid);
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

  /**
   * 自动连接（常驻，不受格栅 / 自动对齐开关影响）：拖动的端点靠近能接上的地方
   *（对面的端点、路块 / 盘点路口、平台边、直道侧面）时吸过去，显示绿色提示，松手即接上。
   */
  private pullToConnection(m: Model, g: { seg: number; key: EndKey }) {
    const s = m.segs[g.seg];
    if (!s || !isFree(s[g.key])) return;
    const out = endOutDir(s, g.key);
    const ax = axisOf(out);
    const [ex, ey] = endPos(s, g.key);
    const cur = ax === 0 ? ex : ey, lat = ax === 0 ? ey : ex;
    const tol = Math.max(this.snap().tol, 1);
    const cands: number[] = [];
    for (const o of Object.values(m.segs)) {
      if (o.id === s.id) continue;
      for (const k of ['a', 'b'] as EndKey[]) { const [x, y] = endPos(o, k); cands.push(ax === 0 ? x : y); }
      // 侧面开 T 字口：端点停在那条路边沿外
      if (axisOf(o.dir) !== ax) cands.push((ax === 0 ? o.x : o.y) - (DX[out] + DY[out]) * HALF);
    }
    for (const n of Object.values(m.nodes)) {
      if (n.kind === 'platform') {
        for (const e of boundaryEdges(cellSet(n))) if (e.out === opp(out)) cands.push(ax === 0 ? e.x : e.y);
      } else if (n.kind === 'block' || n.kind === 'checkpoint') {
        const h = nodeHalf(n);
        cands.push((ax === 0 ? n.x : n.y) - (DX[out] + DY[out]) * h);
      }
    }
    const near = [...new Set(cands.map((c) => Math.round(c * 1e4) / 1e4))]
      .filter((c) => Math.abs(c - cur) < tol).sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));
    const save = { x: s.x, y: s.y, len: s.len };
    for (const c of near) {
      extendTo(m, s.id, g.key, c);
      const [nx, ny] = endPos(s, g.key);
      if (Math.abs((ax === 0 ? nx : ny) - c) < 1e-6 && Math.abs((ax === 0 ? ny : nx) - lat) < 1e-6 && findConnection(m, s.id, g.key, true)) return;
      Object.assign(s, save);
    }
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
    // gizmo 手柄优先（按住 Ctrl）
    if (e.ctrlKey && this.gizmoTarget) {
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
    // 机关工具：点到路面（或空地）就放下一个，按住可以继续拖动调整位置
    if (this.tool === 'object' && (!p || p.kind !== 'obj')) {
      e.preventDefault();
      const at = this.objPlacement(this.objType);
      if (!at) return;
      const snapshot = cloneModel(this.model);
      const id = addObj(this.model, this.objType, at.x, at.y, at.z, at.rot);
      if (id === null) { this.flashStatus(`${objType(this.objType)?.label ?? this.objType} 只能有一个`); return; }
      this.setModel(this.model);
      this.select(id);
      this.drag = { type: 'obj', snapshot, id, ox: 0, oy: 0, moved: true, sx: e.clientX, sy: e.clientY };
      return;
    }
    if (this.tool === 'guard' && p) {
      const g = this.guardHoverAt(p);
      if (g) {
        e.preventDefault();
        this.hover = p;
        const snapshot = cloneModel(this.model);
        if (g.type === 'body') { this.select(g.id); return; }
        if (g.type === 'end') {
          const gd = this.model.guards[g.id];
          const pa = project(this.loops, gd.a), pb = pa ? project([this.loops[pa.loop]], gd.b) : null;
          if (!pa || !pb) return;
          let sb = pb.s;
          const l = this.loops[pa.loop];
          if (l.closed && sb <= pa.s) sb += l.len;
          const [fixed, moving] = g.end === 'a' ? [sb, pa.s] : [pa.s, sb];
          this.select(g.id);
          this.drag = { type: 'guard', snapshot, id: g.id, end: g.end, loop: pa.loop, s0: fixed, s: moving, sx: e.clientX, sy: e.clientY, started: false };
          return;
        }
        this.drag = { type: 'guard', snapshot, id: null, end: 'b', loop: g.loop, s0: g.s, s: g.s, sx: e.clientX, sy: e.clientY, started: false };
        return;
      }
    }
    if (!p) {
      // 空白处按下不松：拖出选框多选（Shift 追加）；只是点一下则清空选择
      if (this.tool === 'edit' || this.tool === 'cut') {
        this.drag = { type: 'marquee', sx: e.clientX, sy: e.clientY, add: e.shiftKey };
        return;
      }
      this.select(null);
      return;
    }
    e.preventDefault();
    this.hover = p;
    const snapshot = cloneModel(this.model);
    if (p.kind === 'obj' && this.tool !== 'cut') {
      const o = this.model.objs[p.id];
      this.select(o.id);
      if (e.altKey) {
        const n = new THREE.Vector3().subVectors(this.camera.position, p.point).setZ(0).normalize();
        this.drag = { type: 'objHeight', snapshot, id: o.id, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, p.point), z0: p.point.z };
      } else {
        this.drag = { type: 'obj', snapshot, id: o.id, ox: o.x - p.point.x, oy: o.y - p.point.y, moved: false, sx: e.clientX, sy: e.clientY };
      }
      return;
    }

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

  private lastMove: { clientX: number; clientY: number } | null = null;

  private onMove(e: PointerEvent) {
    this.lastMove = { clientX: e.clientX, clientY: e.clientY };
    this.syncMods(e);
    this.setMouse(e);
    const d = this.drag;
    this.guides = [];
    if (!d) {
      // 悬停在 gizmo 手柄上时保持当前目标
      const hd = this.mods.ctrl && this.gizmoTarget ? this.pickGizmo() : null;
      this.gizmo.setHovered(hd);
      if ((hd?.axis ?? -1) !== (this.gizmoHover?.axis ?? -1) || (hd?.sign ?? 0) !== (this.gizmoHover?.sign ?? 0)) { this.gizmoHover = hd; this.overlayDirty = true; }
      if (hd) return;
      const p = this.pick();
      const changed = (p?.id ?? null) !== (this.hover?.id ?? null);
      this.hover = p;
      this.updateGhost();
      if (changed || p) this.overlayDirty = true;
      if (changed) this.updateStatus();
      return;
    }
    if (d.type === 'orbit') return;
    if (d.type === 'guard') {
      if (!d.started && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
      d.started = true;
      const s = this.guardDragS(d);
      if (s === null) return;
      d.s = s;
      const l = this.loops[d.loop];
      const m = cloneModel(d.snapshot);
      const lo = Math.min(d.s0, d.s), hi = Math.max(d.s0, d.s);
      if (hi - lo < 0.5) return;
      const id = d.id ?? m.nextId++;
      if (d.id === null) d.id = id;
      m.nextId = Math.max(m.nextId, id + 1);
      m.guards[id] = guardFromS(id, l, lo, hi);
      this.setModel(m);
      this.onStatus(`护栏长 ${fmt(hi - lo)}`);
      return;
    }
    if (d.type === 'marquee') {
      const r = this.host.getBoundingClientRect();
      const x0 = Math.min(d.sx, e.clientX), y0 = Math.min(d.sy, e.clientY);
      const w = Math.abs(e.clientX - d.sx), h = Math.abs(e.clientY - d.sy);
      Object.assign(this.marquee.style, { left: `${x0 - r.left}px`, top: `${y0 - r.top}px`, width: `${w}px`, height: `${h}px` });
      this.marquee.classList.toggle('open', w > 4 || h > 4);
      if (w > 4 || h > 4) {
        const ids = this.idsInRect(x0, y0, x0 + w, y0 + h);
        this.selection = d.add ? new Set([...this.selection, ...ids]) : new Set(ids);
        this.selected = null;
        this.overlayDirty = true;
        this.onStatus(`选中 ${this.selection.size} 个 · 按住 Ctrl 拖箭头整体移动 · Del 删除`);
      }
      return;
    }
    if (d.type === 'obj') {
      if (!d.moved && Math.hypot(e.clientX - d.sx, e.clientY - d.sy) < 4) return;
      d.moved = true;
      const o = this.model.objs[d.id];
      if (!o) return;
      const at = this.objPlacement(o.type, { ox: d.ox, oy: d.oy, rot: o.rot }, o.z);
      if (!at) return;
      const m = cloneModel(this.model);
      Object.assign(m.objs[d.id], { x: at.x, y: at.y, z: at.z, rot: at.rot });
      this.setModel(m);
      this.overlayDirty = true;
      return;
    }
    if (d.type === 'objHeight') {
      const hit = new THREE.Vector3();
      if (!this.raycaster.ray.intersectPlane(d.plane, hit)) return;
      const m = cloneModel(d.snapshot);
      const o = m.objs[d.id];
      o.z = this.snapZ(o.z + hit.z - d.z0);
      this.setModel(m);
      this.onStatus(`高度 ${fmt(o.z)}`);
      return;
    }
    if (d.type === 'gizmo') {
      const raw = d.ref + this.axisParam(d.origin, d.handle.axis) - d.t0;
      const at = d.origin.toArray() as [number, number, number];
      const v = d.handle.axis === 2 ? this.snapZ(raw, at) : this.snapEdge(raw, d.handle.axis, at);
      const m = cloneModel(d.snapshot);
      if (this.applyGizmo(m, d.target, d.handle.axis, v - d.ref)) {
        this.setModel(m);
        this.onStatus(`移动 ${'XYZ'[d.handle.axis]} ${v - d.ref >= 0 ? '+' : ''}${fmt(v - d.ref)}`);
      } else this.onStatus('⚠ 再移动会把相邻路段压成负长度');
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
      else {
        this.growEnd = d.action.apply(m, axisOf(d.action.dir) === 0 ? hit.x : hit.y);
        if (this.growEnd) this.pullToConnection(m, this.growEnd);
      }
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
    const wasFlipped = this.gridFlipped;
    this.drag = null;
    if (wasFlipped) this.onChange();
    this.overlayDirty = true;
    if (d?.type === 'guard') {
      const m = this.model;
      // 只是点了一下外沿：沿这条直边（拐角到拐角）放一段护栏
      if (!d.started && d.id === null) {
        const l = this.loops[d.loop];
        const { seg } = pointAt(l, d.s0);
        const id = m.nextId++;
        const base = l.closed ? Math.floor(d.s0 / l.len) * l.len : 0;
        m.guards[id] = guardFromS(id, l, base + l.cum[seg], base + l.cum[seg + 1]);
        this.select(id);
      }
      if (JSON.stringify(d.snapshot) === JSON.stringify(m)) return;
      this.pushUndo(d.snapshot);
      this.commitView(d.snapshot);
      return;
    }
    if (d?.type === 'marquee') {
      const moved = this.marquee.classList.contains('open');
      this.marquee.classList.remove('open');
      if (!moved && !d.add) { this.selection.clear(); this.select(null); }
      this.updateStatus();
      return;
    }
    if (!d || d.type === 'orbit') return;
    const before = d.snapshot;
    const m = this.model;
    if (d.type === 'obj' || d.type === 'objHeight') {
      this.guides = [];
      if (d.type === 'obj') { rebaseObj(m, d.id); normalize(m); }
      if (JSON.stringify(before) === JSON.stringify(m)) return;
      this.pushUndo(before);
      this.commitView(before);
      return;
    }
    if (d.type === 'action' && this.growEnd && m.segs[this.growEnd.seg]) {
      tryConnect(m, this.growEnd.seg, this.growEnd.key, true);
    }
    this.growEnd = null;
    this.guides = [];
    normalize(m);
    this.alignRailsToRoads(m);
    followSurfaces(before, m);
    if (JSON.stringify(before) === JSON.stringify(m)) return;
    this.pushUndo(before);
    this.commitView(before);
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const flipped = this.gridFlipped;
    this.syncMods(e);
    if (e.key === 'Alt') e.preventDefault();
    // 拖动中切换了临时对齐模式：按新模式重新计算一次
    if (this.gridFlipped !== flipped && this.drag && this.lastMove) {
      const lm = this.lastMove;
      this.onMove({ clientX: lm.clientX, clientY: lm.clientY, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey } as PointerEvent);
      this.onChange();
    }
    if (!down) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && k === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); return; }
    if (e.ctrlKey && k === 'y') { e.preventDefault(); this.redo(); return; }
    if (k === 'delete' || k === 'backspace' || (k === 'x' && !e.ctrlKey && !e.altKey && !this.drag)) {
      if (this.selection.size) {
        const ids = [...this.selection];
        this.mutate((m) => { for (const id of ids) { if (m.rails[id]) delete m.rails[id]; else if (m.guards[id]) delete m.guards[id]; else if (m.objs[id]) delete m.objs[id]; else if (m.segs[id] || m.nodes[id]) deleteElem(m, id); } });
        this.selection.clear();
        this.select(null);
        return;
      }
      // 没有选中时删除鼠标下的元素
      const id = this.selected ?? this.hover?.id ?? null;
      if (id === null) return;
      this.mutate((m) => { if (m.rails[id]) delete m.rails[id]; else if (m.guards[id]) delete m.guards[id]; else if (m.objs[id]) delete m.objs[id]; else deleteElem(m, id); });
      this.select(null);
      return;
    }
    if (k === 'e') this.toggleHoveredEnd();
    if (k === '1') this.setTool('edit');
    if (k === '2') this.setTool('cut');
    if (k === '3') this.setTool('rail');
    if (k === '4') this.setTool('object');
    if (k === '5') this.setTool('guard');
    if (k === 'r') {
      const id = this.hover?.kind === 'obj' ? this.hover.id : this.selected;
      // 机关工具里没指着已放的物件：转的是待放置的朝向
      if (this.tool === 'object' && this.hover?.kind !== 'obj') { this.placeRot = (this.placeRot + (e.shiftKey ? 270 : 90)) % 360; this.updateGhost(); return; }
      if (id !== null && this.model.objs[id]) this.mutate((m) => { m.objs[id].rot = (m.objs[id].rot + (e.shiftKey ? -1 : 1) * (this.gridMode ? 90 : 15) + 360) % 360; rebaseObj(m, id); });
    }
    if (k === 'g') this.setGridMode(!this.gridMode);
    if (k === 's' && !e.ctrlKey) this.setSnapMode(!this.snapMode);
    if (k === 'escape') {
      if (!this.drag && this.selection.size) { this.selection.clear(); this.overlayDirty = true; this.updateStatus(); }
      this.cancelDrag();
      this.hideMenu();
      this.marquee.classList.remove('open');
    }
  }

  private cancelDrag() {
    const d = this.drag;
    if (d && 'snapshot' in d) this.setModel(d.snapshot);
    this.drag = null;
    this.onChange();
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
    const items: (MenuItem | null)[] = p ? (p.kind === 'rail' ? this.railMenu(p) : p.kind === 'obj' ? this.objMenu(p.id) : p.kind === 'guard' ? [{ label: '删除护栏', hint: 'X / Del', action: () => this.mutate((mm) => { delete mm.guards[p.id]; }) }] : this.menuItemsFor(p)) : [
      {
        label: '在此新建路块', hint: '双击空白处也可以', disabled: !ground,
        action: () => { if (ground) this.newBlockAt(ground); },
      },
      {
        label: '在此新建起点', hint: findStart(this.model) ? '已经有起点了' : '四火 + 第 1 小节重生点', disabled: !ground || !!findStart(this.model),
        action: () => { if (ground) this.newPrefabAt(ground, 'start'); },
      },
      {
        label: '在此新建小节盘点', hint: `第 ${checkpoints(this.model).length + 2} 小节`, disabled: !ground,
        action: () => { if (ground) this.newPrefabAt(ground, 'check'); },
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
        items.push({
          label: '在端点接上起点', hint: findStart(m) ? '已经有起点了' : undefined, disabled: !!findStart(m),
          action: () => this.mutate((mm) => { placeStartAtEnd(mm, s.id, k); }),
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
        items.push({
          label: '在此放置小节盘点', hint: isSloped(m, s) ? '坡道上不能放' : `第 ${checkpoints(m).length + 2} 小节`, disabled: isSloped(m, s),
          action: () => this.mutate((mm) => { placeCheckpointOnSeg(mm, s.id, ts); }),
        });
      }
      items.push(null);
      items.push(...styleItems(s.style, (mm, st) => setSegStyle(mm, s.id, st)));
      const other: Style = s.style === 'sink' ? 'normal' : 'sink';
      items.push({ label: `整条直路改为${other === 'sink' ? '凹槽' : '普通'}`, hint: '跨过截面接头', action: () => this.mutate((mm) => setChainStyle(mm, s.id, other)) });
      items.push(null);
      items.push(setRoot(s.id));
      items.push({ label: '删除这段路', hint: 'X / Del', action: () => this.mutate((mm) => deleteElem(mm, s.id)) });
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
      if (n.kind === 'checkpoint') {
        const linked = nodeLinks(m, n.id).length > 0;
        items.push({ label: '旋转 90°', hint: linked ? '接着路时不能转' : undefined, disabled: linked, action: () => this.mutate((mm) => { rotateCheckpoint(mm, n.id, 1); }) });
        if (n.prefab === 'check') {
          const list = checkpoints(m);
          items.push({ label: '掉头', hint: '重生点朝向反过来', action: () => this.mutate((mm) => { rotateCheckpoint(mm, n.id, 2); }) });
          items.push(null);
          items.push({ label: '小节提前', hint: `当前第 ${n.sector} 小节`, disabled: n.sector === 2, action: () => this.mutate((mm) => { moveSector(mm, n.id, -1); }) });
          items.push({ label: '小节推后', disabled: n.sector === list.length + 1, action: () => this.mutate((mm) => { moveSector(mm, n.id, 1); }) });
        }
        items.push(null);
      }
      items.push(setRoot(n.id));
      const name = n.kind === 'checkpoint' ? (n.prefab === 'start' ? '删除起点' : '删除小节盘点') : n.kind === 'transition' ? '删除转换块' : n.kind === 'platform' ? `删除平台（连着 ${nodeLinks(m, n.id).length} 条路）` : '删除路块';
      items.push({ label: name, hint: 'X / Del', action: () => this.mutate((mm) => deleteElem(mm, n.id)) });
    }
    return items;
  }

  private objMenu(id: number): (MenuItem | null)[] {
    const m = this.model;
    const o = m.objs[id];
    const t = objType(o.type);
    const items: (MenuItem | null)[] = [
      { label: '旋转 90°', hint: 'R', action: () => this.mutate((mm) => { mm.objs[id].rot = (mm.objs[id].rot + 90) % 360; rebaseObj(mm, id); }) },
      { label: '旋转 -90°', hint: 'Shift+R', action: () => this.mutate((mm) => { mm.objs[id].rot = (mm.objs[id].rot + 270) % 360; rebaseObj(mm, id); }) },
    ];
    if (hasStopper(o.type)) {
      items.push(null);
      items.push({
        label: o.noStopper ? '加上挡块' : '去掉挡块', hint: 'Phys_FloorStopper',
        action: () => this.mutate((mm) => { if (o.noStopper) delete mm.objs[id].noStopper; else mm.objs[id].noStopper = true; }),
      });
    }
    if (o.cat === 'module' && o.type !== 'PE_Balloon') {
      items.push(null);
      const auto = autoSector(m, o);
      items.push({
        label: `小节：自动（第 ${auto} 小节）`, hint: o.sector === undefined ? '当前' : undefined, disabled: o.sector === undefined,
        action: () => this.mutate((mm) => { delete mm.objs[id].sector; }),
      });
      for (let s = 1; s <= sectorCount(m); s++) {
        items.push({
          label: `小节：固定为第 ${s} 小节`, hint: o.sector === s ? '当前' : undefined, disabled: o.sector === s,
          action: () => this.mutate((mm) => { mm.objs[id].sector = s; }),
        });
      }
    }
    items.push(null);
    items.push({ label: `删除${t?.label ?? o.type}`, hint: 'X / Del', action: () => this.mutate((mm) => { delete mm.objs[id]; }) });
    return items;
  }

  /**
   * 物件放置位置：物件跟着鼠标走，机关的对准方块（占位符里 5×5 的方块）吸附到路面格子上——
   * 哪个方块离某个路面格子最近就用哪个对齐：方块落在格子中心、顶面与路面齐平。
   * 有好几个方块的机关（秋千、跷跷板等）因此可以跨在两段路之间对齐。没有对准方块的装饰底部贴住路面。
   * 朝向默认顺着鼠标下那段路，R 再转 90°；拖动已放的物件时传入 grab（抓取点相对原点的偏移、原朝向）。
   */
  private objPlacement(type: string, grab?: { ox: number; oy: number; rot: number }, zKeep?: number): { x: number; y: number; z: number; rot: number } | null {
    const t = objType(type);
    const floorHit = this.raycaster.intersectObjects(this.pickables.filter((p) => p.userData.kind !== 'obj' && p.userData.kind !== 'guard'), false)[0];
    const onFloor = !!floorHit && !!floorHit.face && floorHit.face.normal.z > 0.5;
    const refZ = onFloor ? this.surfaceTop(floorHit!.point.x, floorHit!.point.y, floorHit!.point.z) : zKeep ?? this.lastPlaceZ;
    const hit = onFloor ? floorHit!.point : this.rayOnPlaneZ(refZ);
    if (!hit) return null;
    if (onFloor) this.lastPlaceZ = refZ;
    // 朝向：鼠标在直道上就顺着它
    const under = onFloor ? surfacesAt(this.model, hit.x, hit.y).find((sf) => Math.abs(sf.z - refZ) < 0.01) : undefined;
    let useg = under ? this.model.segs[under.id] : undefined;
    if (!useg) {
      // 鼠标在空中（例如两段路之间的缺口）：顺着离得最近的那段路
      let bd = 15;
      for (const sg of Object.values(this.model.segs)) {
        if (sg.len < 1e-6) continue;
        const t = Math.max(0, Math.min(sg.len, (hit.x - sg.x) * DX[sg.dir] + (hit.y - sg.y) * DY[sg.dir]));
        const d = Math.hypot(sg.x + DX[sg.dir] * t - hit.x, sg.y + DY[sg.dir] * t - hit.y);
        if (d < bd) { bd = d; useg = sg; }
      }
    }
    if (useg) this.lastRotBase = axisOf(useg.dir) * 90;
    const rot = grab ? grab.rot : (this.lastRotBase + this.placeRot) % 360;
    const r = (rot * Math.PI) / 180, c = Math.cos(r), sn = Math.sin(r);
    const R = (v: [number, number, number]) => [v[0] * c - v[1] * sn, v[0] * sn + v[1] * c] as [number, number];
    const anchors = t?.anchor ? [t.anchor, ...(t.more ?? [])] : [];
    // 原点的估计：拖动时按抓取偏移；放置时让方块的中心落在鼠标处
    let ox: number, oy: number;
    if (grab) { ox = hit.x + grab.ox; oy = hit.y + grab.oy; }
    else if (anchors.length) {
      const cx = anchors.reduce((a, v) => a + v[0], 0) / anchors.length, cy = anchors.reduce((a, v) => a + v[1], 0) / anchors.length;
      const w = R([cx, cy, 0]);
      ox = hit.x - w[0]; oy = hit.y - w[1];
    } else { ox = hit.x; oy = hit.y; }
    const lift = t?.prop ? this.model.settings.propLift : 0;
    if (!anchors.length) {
      const at: [number, number, number] = [ox, oy, refZ];
      return { x: this.snapEdge(ox, 0, at, 1.25), y: this.snapEdge(oy, 1, at, 1.25), z: refZ, rot };
    }
    // 每个对准方块试着吸附到它下面的路面格子，取挪动最少的那个
    let best: { x: number; y: number; z: number; d: number } | null = null;
    for (const a of anchors) {
      const w = R(a);
      const gx = ox + w[0], gy = oy + w[1];
      const cell = this.cellUnder(gx, gy, refZ);
      if (!cell) continue;
      const d = Math.hypot(cell.x - gx, cell.y - gy);
      if (!best || d < best.d) best = { x: cell.x - w[0], y: cell.y - w[1], z: cell.z - a[2] + lift, d };
    }
    if (best) return { x: best.x, y: best.y, z: best.z, rot };
    // 哪个方块下面都没有路：跟着鼠标，高度按主对准方块
    const at: [number, number, number] = [ox, oy, refZ];
    return { x: this.snapEdge(ox, 0, at, 1.25), y: this.snapEdge(oy, 1, at, 1.25), z: refZ - t!.anchor![2] + lift, rot };
  }

  /** (x,y) 处、高度接近 z 的路面格子：直道取路中线上（纵向按格栅 / 自动对齐），路块取中心，平台取 5×5 格中心 */
  private cellUnder(x: number, y: number, z: number): { x: number; y: number; z: number } | null {
    const sfs = surfacesAt(this.model, x, y).filter((sf) => Math.abs(sf.z - z) < 3);
    if (!sfs.length) return null;
    const sf = sfs.reduce((a, b) => (Math.abs(b.z - z) < Math.abs(a.z - z) ? b : a));
    const seg = this.model.segs[sf.id], node = this.model.nodes[sf.id];
    if (seg) {
      const ax = axisOf(seg.dir);
      const along = this.snapEdge(ax === 0 ? x : y, ax, [x, y, sf.z]);
      return ax === 0 ? { x: along, y: seg.y, z: sf.z } : { x: seg.x, y: along, z: sf.z };
    }
    if (node && node.kind !== 'platform') return { x: node.x, y: node.y, z: node.z };
    if (this.gridMode) return { x: Math.floor(x / 5) * 5 + 2.5, y: Math.floor(y / 5) * 5 + 2.5, z: sf.z };
    return { x: this.snapEdge(x, 0, [x, y, sf.z]), y: this.snapEdge(y, 1, [x, y, sf.z]), z: sf.z };
  }

  /** 路面顶面高度（凹槽里点到的是槽底，取路面标称高度） */
  private surfaceTop(x: number, y: number, hz: number): number {
    const near = surfacesAt(this.model, x, y).filter((sf) => Math.abs(sf.z - hz) < 1);
    return near.length ? near.reduce((p, c) => (Math.abs(c.z - hz) < Math.abs(p.z - hz) ? c : p)).z : hz;
  }

  private updateGhost() {
    const show = this.tool === 'object' && !this.drag && this.hover?.kind !== 'obj';
    if (!show) { this.ghost.visible = false; return; }
    const at = this.objPlacement(this.objType);
    if (!at) { this.ghost.visible = false; return; }
    if (this.ghostType !== this.objType || this.ghost.children.length === 0) {
      this.ghost.clear();
      for (const mesh of this.objMeshes({ type: this.objType, x: 0, y: 0, z: 0, rot: 0 }, true)) this.ghost.add(mesh);
      this.ghostType = this.ghost.children.length ? this.objType : '';
    }
    this.ghost.position.set(at.x, at.y, at.z);
    this.ghost.rotation.z = (at.rot * Math.PI) / 180;
    this.ghost.visible = true;
  }

  setObjType(t: string) { this.objType = t; this.ghostType = ''; this.setTool('object'); }

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

  private newPrefabAt(p: THREE.Vector3, prefab: Prefab) {
    const cx = this.snapEdge(p.x - HALF, 0) + HALF;
    const cy = this.snapEdge(p.y - HALF, 1) + HALF;
    this.guides = [];
    this.mutate((mm) => { addCheckpoint(mm, prefab, cx, cy, 0, 0); });
  }

  private focusRoot() {
    const c = this.elemCenter(this.model, this.model.root) ?? [0, 0, 0];
    const off = this.camera.position.clone().sub(this.controls.target);
    this.controls.target.set(...c);
    this.camera.position.copy(this.controls.target).add(off);
  }

  // ---------------- 状态与提交 ----------------

  private select(id: number | null) {
    if (id !== null && !this.selection.has(id)) this.selection.clear();
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
    followSurfaces(before, this.model);
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
    if (this.selected !== null && !this.model.segs[this.selected] && !this.model.nodes[this.selected] && !this.model.rails[this.selected] && !this.model.objs[this.selected] && !this.model.guards[this.selected]) this.selected = null;
    for (const id of this.selection) if (!this.model.segs[id] && !this.model.nodes[id] && !this.model.rails[id] && !this.model.objs[id] && !this.model.guards[id]) this.selection.delete(id);
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
    if (h && h.kind === 'obj' && m.objs[h.id]) {
      const o = m.objs[h.id];
      const t = objType(o.type);
      info = `${t?.label ?? o.type}（${o.type}）  高 ${fmt(o.z)}  朝向 ${o.rot}°`;
      if (o.cat === 'module' && o.type !== 'PE_Balloon') info += `  第 ${objSector(m, o)} 小节${o.sector === undefined ? '（自动）' : '（手动）'}`;
    } else if (h && h.kind === 'rail' && m.rails[h.id]) {
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
      if (n.kind === 'checkpoint') {
        const two = (v: number) => String(v).padStart(2, '0');
        info = n.prefab === 'start' ? `起点 · PS_FourFlames_01 + PR_Resetpoint_01  高 ${fmt(n.z)}`
          : `小节盘点 · 第 ${n.sector} 小节 · PC_TwoFlames_${two(n.sector! - 1)} + PR_Resetpoint_${two(n.sector!)}  高 ${fmt(n.z)}`;
      } else if (n.kind === 'platform') {
        const b = platformBBox(n);
        info = `平台 #${n.id}  ${fmt(b.x1 - b.x0)}×${fmt(b.y1 - b.y0)}  高 ${fmt(n.z)}  ${n.style === 'normal' ? '普通' : n.ribbon ? '细边花纹' : '凹槽'}`;
      } else {
        const cnt = portCount(nodePorts(m, n.id));
        const kind = n.kind === 'transition' ? (n.narrow ? '窄平凹转换' : '平凹转换') : cnt === 0 ? '1×1' : cnt === 2 ? '拐角' : cnt === 3 ? 'T 字路口' : '十字路口';
        info = `${kind} #${n.id}  高 ${fmt(n.z)}  ${n.style === 'sink' ? '凹槽' : '普通'}`;
      }
    }
    this.onStatus(info);
    this.updateHints();
  }

  private hintsKey = '';

  /** 重新发送状态栏内容（界面刚挂好回调时用） */
  refreshStatus() { this.hintsKey = ''; this.updateStatus(); }

  /** 状态栏左侧的按键提示（类似 Blender）：随工具、修饰键、拖动状态变化 */
  private updateHints() {
    const H = (keys: string[], label: string): Hint => ({ keys, label });
    const d = this.drag;
    let hs: Hint[];
    if (d && d.type !== 'orbit') {
      if (d.type === 'marquee') hs = [H(['LMB'], '框选'), H(['Shift'], '追加'), H(['Esc'], '取消')];
      else {
        hs = [H(['LMB'], '确认'), H(['Esc'], '取消')];
        if (!['height', 'railHeight', 'objHeight'].includes(d.type)) hs.push(H(['Alt'], this.gridMode !== this.gridFlipped ? '临时关格栅' : '临时开格栅'));
      }
    } else if (this.tool === 'edit') {
      if (this.mods.shift) hs = [H(['Shift', 'LMB'], '侧面拉成平台 / 推平台边')];
      else if (this.mods.ctrl) hs = [H(['Ctrl', 'LMB'], this.selection.size ? `移动选中的 ${this.selection.size} 个` : '沿箭头移动这一块'), H([], '蓝框整体平移 · 黄虚线伸缩 / 成坡')];
      else if (this.mods.alt) hs = [H(['Alt', 'LMB'], '调高度成坡'), H([], '绿框升降 · 橙虚线变坡 · 其余不动')];
      else hs = [
        H(['LMB'], '拉长 / 开路口'), H(['LMB'], '空白处框选'), H(['Shift'], '平台'), H(['Alt'], '坡面'), H(['Ctrl'], '移动'),
        H(['RMB'], '菜单'), H(['MMB'], '环视'), H(['Wheel'], '缩放'), H(['E'], '端点开合'), H(['G'], '格栅'), H(['S'], '自动对齐'),
      ];
    } else if (this.tool === 'cut') hs = [H(['LMB'], '点截面分隔'), H(['LMB'], '空白处框选'), H(['RMB'], '菜单'), H(['MMB'], '环视')];
    else if (this.tool === 'object') hs = [
      H(['LMB'], `放置「${objType(this.objType)?.label ?? this.objType}」`), H(['LMB'], '拖动物件'), H(['Alt', 'LMB'], '调高度'), H(['R'], '旋转'), H(['RMB'], '小节 / 删除'),
    ];
    else if (this.tool === 'guard') hs = [H(['LMB'], '点路边：沿这条直边放护栏'), H(['LMB'], '沿路边拖：自由长度、可跨拐角'), H(['LMB'], '拖护栏端头：调长度'), H(['X'], '删除'), H(['MMB'], '环视')];
    else hs = [H(['LMB'], '从路端拖出钢轨'), H(['LMB'], '端头拉长 / 侧面拐弯'), H(['Alt', 'LMB'], '末端坡度'), H(['RMB'], '单双轨 / 螺旋')];
    if (this.selection.size && !d) hs.push(H(['X'], '删除选中'), H(['Esc'], '取消选择'));
    const key = JSON.stringify(hs);
    if (key === this.hintsKey) return;
    this.hintsKey = key;
    this.onHints(hs);
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

/** 外沿上 lo→hi 一段的护栏；端点离拐角让开一点点，免得投影回外沿时分不清是拐角哪一边 */
function guardFromS(id: number, l: Loop, lo: number, hi: number) {
  const e = hi - lo > 0.4 ? 0.05 : 0;
  return { id, a: pointAt(l, lo + e).p, b: pointAt(l, hi - e).p };
}

/** 需要专属路面的机关：拆掉原来的底座，在当前位置重新铺（位置不在路上时就不铺） */
function rebaseObj(m: Model, id: number) {
  const o = m.objs[id];
  if (!o || !baseOf(o.type)) return;
  if (o.base !== undefined) revertBase(m, o.base);
  placeBase(m, id);
}

/** 直道顶面的外框（随坡度） */
function topRect(m: Model, s: Seg): number[] {
  const P = [-DY[s.dir], DX[s.dir]];
  const [ax, ay] = endPos(s, 'a'), [bx, by] = endPos(s, 'b');
  const za = endZ(m, s, 'a') + 0.05, zb = endZ(m, s, 'b') + 0.05;
  const c = [
    [ax + P[0] * HALF, ay + P[1] * HALF, za], [bx + P[0] * HALF, by + P[1] * HALF, zb],
    [bx - P[0] * HALF, by - P[1] * HALF, zb], [ax - P[0] * HALF, ay - P[1] * HALF, za],
  ];
  const out: number[] = [];
  for (let i = 0; i < 4; i++) out.push(...c[i], ...c[(i + 1) % 4]);
  return out;
}

function rectLoop(x0: number, y0: number, x1: number, y1: number, z: number): number[] {
  const zz = z + 0.05;
  return [x0, y0, zz, x1, y0, zz, x1, y0, zz, x1, y1, zz, x1, y1, zz, x0, y1, zz, x0, y1, zz, x0, y0, zz];
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
