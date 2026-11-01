import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { buildElem, computeChains, elemKey, type MatName } from './geom/floor';
import { buildRail } from './geom/rail';
import { followRails } from './model/rail-follow';
import { getMaterial, getRailMaterial } from './view/materials';
import { Gizmo, type GizmoHandle } from './view/gizmo';
import { Snapper, type SnapResult } from './view/snap';
import { Fx, rectSegs } from './view/fx';
import { GRID_THEMES, createGrid, themeGrid } from './view/grid';
import { FaceFx, type FaceSpec, faceSegs } from './view/face';
import { assetVersion, fallbackBox, getAsset, getStopperMaterial, setAssetLoadedCallback } from './view/assets';
import { hasStopper, stopperMesh } from './model/stoppers';
import {
  addCheckpoint, checkpoints, findStart, newMapModel, moveSector, placeCheckpointOnSeg, placeStartAtEnd, prefabExtent, prefabParts, rotateCheckpoint, rotateSpawn,
} from './model/checkpoint';
import { buildGuard } from './geom/railing';
import { type Loop, outlineLoops, pointAt, project, projectNear } from './model/outline';
import { baseOf, placeBase, placeFreeBase, revertBase } from './model/bases';
import { cutForObj, isSplitObj, uncutObj } from './model/gaps';
import { exportScene } from './export/scene';
import { exportNmo } from './export/nmo-scene';
import { FAKE_FIX, addObj, anchorBlocks, autoSector, fakeModel, followSurfaces, objSector, objType, sectorCount, surfacesAt } from './model/objects';
import { lerpModel } from './view/tween';
import {
  CELL, DX, DY, Dir, EndKey, HALF, MNode, nodeRect, Model, Prefab, Seg, Style,
  axisOf, cloneModel, emptyModel, endOutDir, endPos, endZ, isFree, migrateModel, nodeHalf, nodeLinks, nodePortDirs, nodePorts, opp, portCount, zAt, SINK_DEPTH,
} from './model/types';
import {
  RAIL_RADIUS, RAIL_SPAN, Rail, RailKind, RailPiece, RailState, SPIRAL_RADIUS, SPIRAL_SCREW, TRANSITION_LEN, extendStart, nearestPiece, nearestS,
  appendRail, canAppend, pieceLength, pushPiece, railEnd, railTopOffset, reverseRail, splitRail, stateAt,
} from './model/rail';
import {
  type MoveInfo, addBlock, addSegAtPort, applyConnection, blockToSeg, cutJoint, movePiece, pieceOf, cutSeg, deleteElem, extendFlat, extendTo,
  findConnection, insertJoint, isSloped, makeBranch, normalize, setBlockStyle, setChainStyle, setSegStyle,
  setPlatformStyle, shiftDownstream, shiftFreeEnd, toggleEnd, tryConnect,
} from './model/ops';
import {
  addSegAtPlatform, blockToPlatform, boundaryEdges, cellSet, edgeRunAt, extrudePlatform, openingFits, platformBBox, segToPlatform,
} from './model/platform';

export type Tool = 'edit' | 'cut' | 'rail' | 'guard';

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
  /** 需要完整平面坐标的动作（钢轨：直线 / 圆弧由鼠标位置决定；坡道还要用到鼠标射线） */
  apply2?: (m: Model, x: number, y: number, ray?: THREE.Ray) => void;
  /** 钢轨端头的动作：拉法随按键实时切换 */
  anchor?: RailAnchor;
}

/** 钢轨从哪儿接着长：端点（路径高度 = 双轨最顶端）、朝外的方向、轨型；已有钢轨的哪一头，新钢轨为 null */
interface RailAnchor {
  E: RailState; kind: RailKind; rail: number | null; end: 'a' | 'b';
  /** Alt 竖直拖动：按下时鼠标所在的高度（拖动中记下） */
  z0?: number;
}
/** 钢轨的拉法：直线伸缩、Shift 拐弯、Alt 坡道、Shift+Alt 螺旋 */
type RailMode = 'line' | 'arc' | 'slope' | 'spiral';

type Drag =
  | { type: 'action'; snapshot: Model; action: Action; sx: number; sy: number; started: boolean }
  | { type: 'height'; snapshot: Model; target: HeightTarget; plane: THREE.Plane; z0: number }
  | { type: 'railHeight'; snapshot: Model; rail: number; plane: THREE.Plane; z0: number }
  | { type: 'gizmo'; snapshot: Model; target: GizmoTarget; handle: GizmoHandle; origin: THREE.Vector3; t0: number; ref: number }
  | { type: 'obj'; snapshot: Model; id: number; ox: number; oy: number; moved: boolean; sx: number; sy: number }
  | { type: 'objHeight'; snapshot: Model; id: number; plane: THREE.Plane; z0: number }
  | { type: 'marquee'; sx: number; sy: number; add: boolean }
  | { type: 'guard'; snapshot: Model; id: number | null; end: 'a' | 'b'; loop: number; s0: number; s: number; sx: number; sy: number; started: boolean }
  | { type: 'orbit'; pivot?: THREE.Vector3; lx: number; ly: number };

/** gizmo 作用对象：悬停元素所在的“一块”（两个折点之间的直路，或单个路块 / 平台）或一整条钢轨 */
type GizmoTarget =
  | { type: 'comp'; id: number }
  | { type: 'rail'; id: number }
  | { type: 'obj'; id: number }
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
/** 机关的对准方块 */
const C_ANCHOR = 0x5cf2d6;
const RAIL_HANDLE_GEO = new THREE.BoxGeometry(5, 5, 1.6).translate(-1.5, 0, 0);
const RAIL_HANDLE_MAT = new THREE.MeshBasicMaterial({ visible: false });
const GHOST_MAT = new THREE.MeshBasicMaterial({ color: 0x9fd2ff, transparent: true, opacity: 0.35, depthWrite: false });

export class Editor {
  model: Model;
  private baseTool: Tool = 'edit';
  /** 按住 C：临时进入分隔模式，松开回到原来的工具 */
  private cutHeld = false;
  get tool(): Tool { return this.cutHeld ? 'cut' : this.baseTool; }
  /** 格栅模式：一切对齐到 2.5 的倍数；关闭后自由拖动并智能吸附 */
  gridMode = true;
  /** 自动对齐：靠近其它元素的边界 / 端点 / 高度时对齐过去（与格栅相互独立；自动连接不受它影响） */
  snapMode = true;
  /** 正在从机关库拖出来放置的物件类型（没有在放置时为 null） */
  placing: string | null = null;
  /** 放置拖动中，鼠标是否在视图上 */
  private placingOver = false;
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
  /** 拖放中的机关放在哪（显示对准方块用） */
  private ghostAt: { type: string; x: number; y: number; z: number; rot: number } | null = null;
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
  private grid!: THREE.Group;
  theme: 'dark' | 'light' = 'dark';
  /** 多选（框选） */
  private selection = new Set<number>();
  private marquee: HTMLDivElement;
  private moveInfoCache: { key: string; info: MoveInfo | null } = { key: '', info: null };

  constructor(private host: HTMLElement) {
    this.loadPrefs();
    this.model = this.loadLocal() ?? newMapModel();
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
    this.controls.dampingFactor = 0.1; // 环视 / 平移的惯性缓动
    this.controls.enableZoom = false; // 滚轮缩放自己做，带缓动
    this.controls.target.set(5, 5, 0);
    this.loadView();

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-0.4, -0.7, 1);
    this.scene.add(sun);
    this.grid = createGrid();
    this.scene.add(this.grid);
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
    // 捕获阶段先于 OrbitControls：有选中的东西时，中键环视由我们绕选中物体来转
    host.addEventListener('pointerdown', (e) => {
      if (e.button === 1) this.controls.enableRotate = e.shiftKey || !this.orbitPivot();
    }, true);
    el.addEventListener('pointerdown', (e) => {
      this.onDown(e);
      if (this.downInfo && this.drag?.type === 'marquee') this.downInfo.marquee = true;
    });
    el.addEventListener('wheel', (e) => {
      e.preventDefault();
      const cur = this.zoomGoal ?? this.camera.position.distanceTo(this.controls.target);
      this.zoomGoal = THREE.MathUtils.clamp(cur * Math.exp(e.deltaY * 0.0012), 2, 3000);
    }, { passive: false });
    window.addEventListener('pointermove', (e) => this.onMove(e));
    window.addEventListener('pointerup', (e) => {
      // 点选（没拖动、没改东西）了新的东西：视图平移过去
      const down = this.downInfo;
      this.downInfo = null;
      this.onUp(e);
      if (!down || this.selKey() === down.sel || !this.focusBox()) return;
      const clicked = Math.hypot(e.clientX - down.x, e.clientY - down.y) < 4;
      if ((clicked && this.undoStack.length === down.undo) || down.marquee) this.panToSelection();
    });
    el.addEventListener('contextmenu', (e) => this.onContextMenu(e));
    el.addEventListener('dblclick', (e) => {
      this.setMouse(e);
      if (this.pick()) return;
      const g = this.rayOnPlaneZ(0);
      if (g) this.newBlockAt(g);
    });
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => { this.mods = { ctrl: false, shift: false, alt: false }; this.setCutHeld(false); this.overlayDirty = true; });
    window.addEventListener('pointerdown', (e) => { if (!this.menu.contains(e.target as Node)) this.hideMenu(); });
    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();

    setAssetLoadedCallback(() => { this.syncMeshes(); this.overlayDirty = true; });
    this.syncMeshes();
    this.renderer.setAnimationLoop(() => this.frame());
  }

  // ---------------- 公共接口 ----------------

  setTool(t: Tool) { this.baseTool = t; this.overlayDirty = true; this.updateGhost(); this.updateStatus(); this.onChange(); }

  private setCutHeld(on: boolean) {
    if (this.cutHeld === on) return;
    this.cutHeld = on;
    this.overlayDirty = true;
    this.updateStatus();
    this.onChange();
  }

  setGridMode(on: boolean) { this.gridMode = on; this.savePrefs(); this.overlayDirty = true; this.updateStatus(); this.onChange(); }
  setSnapMode(on: boolean) { this.snapMode = on; this.savePrefs(); this.overlayDirty = true; this.updateStatus(); this.onChange(); }

  /** 新放的机关归到哪个小节（工具栏选单；放盘点时自动切到它的小节） */
  placeSector = 1;
  setPlaceSector(v: number) { this.placeSector = v; this.onChange(); }

  /** 在机关上显示所属小节的序号 */
  showSectors = false;
  setShowSectors(on: boolean) { this.showSectors = on; this.savePrefs(); this.syncSectorLabels(this.display); this.onChange(); }

  private savePrefs() {
    try { localStorage.setItem('bvm.prefs', JSON.stringify({ grid: this.gridMode, snap: this.snapMode, sectors: this.showSectors })); } catch { /* 存不了就算了 */ }
  }
  private loadPrefs() {
    try {
      const p = JSON.parse(localStorage.getItem('bvm.prefs') ?? '{}');
      if (typeof p.grid === 'boolean') this.gridMode = p.grid;
      if (typeof p.snap === 'boolean') this.snapMode = p.snap;
      if (typeof p.sectors === 'boolean') this.showSectors = p.sectors;
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
    this.model = newMapModel();
    this.commitView();
  }

  exportJSON(): string { return JSON.stringify({ format: 'bvm', version: 1, model: this.model }, null, 1); }

  /** 亮色 / 暗色：场景背景与网格跟着换 */
  setTheme(t: 'dark' | 'light') {
    this.theme = t;
    const g = GRID_THEMES[t];
    (this.scene.background as THREE.Color).set(g.bg);
    themeGrid(this.grid, g);
    this.onChange();
  }

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
  /** 直接生成 .nmo（浏览器里，不需要 Blender） */
  exportNmo() { return exportNmo(this.model); }

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
    this.tickCamera(dt);
    this.saveViewSoon(dt);
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
        const okey = JSON.stringify(obj) + ':' + assetVersion + ':' + this.moduleView;
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
    this.syncSectorLabels(m);
  }

  private secLabels = new Map<number, CSS2DObject>();
  /** 机关头顶的小节序号（打开「显示小节」时）；手动指定的实线框，自动判断的虚线框 */
  private syncSectorLabels(m: Model) {
    const live = new Set<number>();
    if (this.showSectors) {
      for (const o of Object.values(m.objs)) {
        if (o.cat !== 'module') continue;
        live.add(o.id);
        let l = this.secLabels.get(o.id);
        if (!l) {
          const div = document.createElement('div');
          l = new CSS2DObject(div);
          this.scene.add(l);
          this.secLabels.set(o.id, l);
        }
        const text = String(objSector(m, o));
        if (l.element.textContent !== text) l.element.textContent = text;
        const cls = `sec-label${o.sector === undefined ? ' auto' : ''}`;
        if (l.element.className !== cls) l.element.className = cls;
        l.element.title = o.sector === undefined ? `第 ${text} 小节（自动判断）` : `第 ${text} 小节`;
        // 放在模型顶上
        const box = new THREE.Box3();
        for (const mesh of this.meshCache.get(o.id)?.meshes ?? []) { mesh.updateMatrixWorld(); box.expandByObject(mesh); }
        const top = box.isEmpty() ? o.z + 3 : box.max.z;
        l.position.set(o.x, o.y, top + 1.5);
      }
    }
    for (const [id, l] of this.secLabels) {
      if (live.has(id)) continue;
      this.scene.remove(l);
      l.element.remove();
      this.secLabels.delete(id);
    }
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

  /** 机关显示成机关模型（资产库的假机关）还是 BBP 占位符；存在本地 */
  moduleView: 'model' | 'placeholder' = (() => { try { return localStorage.getItem('bvm.moduleView') === 'placeholder' ? 'placeholder' : 'model'; } catch { return 'model'; } })();

  setModuleView(v: 'model' | 'placeholder') {
    if (v === this.moduleView) return;
    this.moduleView = v;
    try { localStorage.setItem('bvm.moduleView', v); } catch { /* 存不了就算了 */ }
    this.ghostType = '';
    this.syncMeshes();
    this.overlayDirty = true;
    window.dispatchEvent(new Event('bvm-moduleview'));
  }

  private objMeshes(o: { type: string; x: number; y: number; z: number; rot: number }, ghost = false): THREE.Mesh[] {
    const t = objType(o.type);
    // 机关模型只用来显示（加载完之前先显示占位符）；吸附、断路、导出都按占位符的对准方块
    const fake = t?.cat === 'module' && this.moduleView === 'model' ? fakeModel(o.type) : null;
    const fakePieces = fake ? getAsset('fake', fake) : null;
    const pieces = fakePieces ?? getAsset(t?.cat === 'deco' ? 'asset' : 'element', o.type) ?? [];
    const fix = (fakePieces && FAKE_FIX[fake!]) || {};
    const rot = o.rot + (fix.rot ?? 0);
    const out = pieces.map((pc) => {
      const mesh = new THREE.Mesh(pc.geometry, ghost ? GHOST_MAT : pc.material);
      mesh.position.set(o.x, o.y, o.z + (fix.dz ?? 0));
      // 先绕本地 Y 倾斜，再绕 Z 转
      mesh.rotation.order = 'ZYX';
      mesh.rotation.y = ((fix.pitch ?? 0) * Math.PI) / 180;
      mesh.rotation.z = (rot * Math.PI) / 180;
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

    // 机关的对准方块：悬停、选中、拖动、拖放中的机关（制图逻辑按这些方块吸附 / 断路）
    const anchorOf: { type: string; x: number; y: number; z: number; rot: number }[] = [];
    const objAt = (id: number | null | undefined) => { const o = id != null ? m.objs[id] : undefined; if (o && !anchorOf.includes(o)) anchorOf.push(o); };
    if (h?.kind === 'obj') objAt(h.id);
    objAt(this.selected);
    const dg = this.drag;
    if (dg?.type === 'obj' || dg?.type === 'objHeight') objAt(dg.id);
    if (dg?.type === 'gizmo' && dg.target.type === 'obj') objAt(dg.target.id);
    if (this.placing && this.ghost.visible && this.ghostAt) anchorOf.push(this.ghostAt);
    const anc: number[] = [];
    for (const o of anchorOf) for (const b of anchorBlocks(o)) anc.push(...boxSegs(b.x - b.hx, b.y - b.hy, b.top - 5, b.x + b.hx, b.y + b.hy, b.top + 0.03));
    if (anc.length) show('anchors', anc, C_ANCHOR, { width: 1.5, opacity: 0.9, dashed: true });

    // 动作示意（左键 / Shift）
    const railCtx = !!h && (this.tool === 'rail' || h.kind === 'rail');
    this.action = h && this.tool !== 'cut' && (!this.mods.alt || railCtx) && !this.mods.ctrl ? this.actionFor(h) : null;
    const a = this.action;
    if (a) {
      const color = a.valid ? a.color : C_INVALID;
      if (a.face) show(this.mods.shift ? 'act-extrude' : 'act', faceSegs(a.face), color, { width: 2, pos: [a.face.x, a.face.y, a.face.z] });
      else show(this.mods.shift ? 'act-extrude' : 'act', a.segs, color, { width: 2.5, pos: a.pos });
      if (a.face?.arrow === 'none' && a.segs.length) show(`act-mode:${this.railMode()}`, a.segs, color, { width: 2.5, pos: a.pos });
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
    return this.snapGuardS(l, projectNear(l, hit.x, hit.y, d.s));
  }

  /** 外沿上的位置吸附：先吸拐角（顶点），再按格栅 / 自动对齐（护栏的起点、终点都用它） */
  private snapGuardS(l: Loop, s: number): number {
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
    else if (this.placing) c = this.placingOver ? 'copy' : 'no-drop';
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
      mesh.updateMatrixWorld();
      e.applyMatrix4(mesh.matrixWorld);
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
    if (d?.type === 'action' && d.action.anchor) return false;
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
    // 拖动中的物件不吸附到它自己原来的位置
    const d = this.drag;
    let ex: Set<number> | undefined;
    if (d?.type === 'obj') ex = new Set([d.id]);
    else if (d?.type === 'gizmo' && d.target.type === 'obj') {
      const o = d.snapshot.objs[d.target.id];
      ex = new Set([d.target.id, ...(o?.base !== undefined ? [o.base] : [])]);
    }
    const r = this.snap().axis(this.snapModel(), axis, c, ex, step);
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
    if (p.kind === 'obj' || p.kind === 'guard' || this.tool === 'guard') return null;
    if (p.kind === 'rail') return this.railEndAction(p);
    if (this.tool === 'rail') return this.railToolAction(p);
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
      segs: arrowSegs(dir, nodeHalf(n, dir), 3.5), pos: [n.x, n.y, n.z + 0.08] as [number, number, number], color: C_CREATE, dir, z: n.z,
      face: { x: n.x + DX[dir] * nodeHalf(n, dir), y: n.y + DY[dir] * nodeHalf(n, dir), z: n.z, dir, w: 5 },
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

  /**
   * 钢轨工具的悬停判定，和路块完全一样：直道靠近哪条边就从哪条边出去（自由端端面，或侧面上鼠标所在的位置），
   * 路块 / 底座 / 盘点从鼠标所在那一侧的空路口出去，平台从鼠标所在的边出去。新钢轨顶端与路面顶面对齐。
   */
  private railToolAction(p: Pick): Action | null {
    const m = this.model;
    const s = m.segs[p.id];
    if (s) {
      const { t, lat } = this.segLocal(s, p.point);
      const D: [number, number] = [DX[s.dir], DY[s.dir]];
      const nd = p.normal;
      const cands: { what: EndKey | 'L' | 'R'; d: number }[] = [{ what: 'L', d: HALF - lat }, { what: 'R', d: HALF + lat }];
      if (isFree(s.a)) cands.push({ what: 'a', d: t });
      if (isFree(s.b)) cands.push({ what: 'b', d: s.len - t });
      let what = cands.reduce((x, y) => (y.d < x.d ? y : x)).what;
      if (Math.abs(nd.x * D[0] + nd.y * D[1]) > 0.7 && isFree(s[t < s.len / 2 ? 'a' : 'b'])) what = t < s.len / 2 ? 'a' : 'b';
      if (Math.abs(nd.x * -D[1] + nd.y * D[0]) > 0.7) what = lat >= 0 ? 'L' : 'R';
      if (what === 'a' || what === 'b') {
        const [ex, ey] = endPos(s, what);
        return this.railStartAction(ex, ey, endZ(m, s, what), endOutDir(s, what));
      }
      const left = ((s.dir + 1) % 4) as Dir;
      const side = what === 'L' ? left : opp(left);
      // 侧面上的位置：和开路口一样，格栅 / 自动对齐
      const t0 = Math.min(Math.max(t, 0), s.len);
      const at0: [number, number, number] = [s.x + D[0] * t0, s.y + D[1] * t0, zAt(m, s, t0)];
      const c = this.snapEdge(axisOf(s.dir) === 0 ? p.point.x : p.point.y, axisOf(s.dir), at0);
      const tc = Math.min(Math.max(this.tOfCoord(s, c), 0), s.len);
      const cx = s.x + D[0] * tc + DX[side] * HALF, cy = s.y + D[1] * tc + DY[side] * HALF;
      return this.railStartAction(cx, cy, zAt(m, s, tc), side);
    }
    const n = m.nodes[p.id];
    if (!n) return null;
    if (n.kind === 'platform') {
      const run = edgeRunAt(n, p.point.x, p.point.y);
      if (!run) return null;
      const isX = axisOf(run.out) === 0;
      const raw = isX ? p.point.y : p.point.x;
      const a0 = Math.min(Math.max(raw, run.from), run.to);
      let along = this.snapEdge(raw, isX ? 1 : 0, isX ? [run.line, a0, n.z] : [a0, run.line, n.z]);
      along = Math.min(Math.max(along, run.from), run.to);
      return this.railStartAction(isX ? run.line : along, isX ? along : run.line, n.z, run.out);
    }
    if (n.kind === 'block' || n.kind === 'base' || n.kind === 'checkpoint' || n.kind === 'transition') {
      const dx = p.point.x - n.x, dy = p.point.y - n.y;
      const dot = (d: Dir) => DX[d] * dx + DY[d] * dy;
      const dirs = n.kind === 'transition' ? ([0, 1, 2, 3] as Dir[]).filter((d) => axisOf(d) !== n.axis) : nodePortDirs(n);
      const dir = dirs.reduce((a, b) => (dot(b) > dot(a) ? b : a));
      const h = n.kind === 'transition' ? HALF : nodeHalf(n, dir);
      const act = this.railStartAction(n.x + DX[dir] * h, n.y + DY[dir] * h, n.z, dir);
      if (nodePorts(m, n.id)[dir]) return { ...act, valid: false, reason: '这一侧接着路' };
      return act;
    }
    return null;
  }

  /** 从 (x,y) 处、顶面高度 topZ 朝 out 拖出一条新钢轨（双轨，最顶端与路面顶面对齐） */
  private railStartAction(ex: number, ey: number, topZ: number, out: Dir, p?: Pick): Action {
    return this.railAnchorAction({ E: { x: ex, y: ey, z: topZ - railTopOffset('double'), heading: out * 90 }, kind: 'double', rail: null, end: 'b' }, p);
  }

  /** 钢轨两头：悬停在端头附近就可以接着拉（和路面端头一样） */
  private railEndAction(p: Pick): Action | null {
    const r = this.model.rails[p.id];
    if (!r || !r.pieces.length) return null;
    const E = railEnd(r);
    const dE = Math.hypot(p.point.x - E.x, p.point.y - E.y), dS = Math.hypot(p.point.x - r.x, p.point.y - r.y);
    if (Math.min(dE, dS) > 6) return null;
    const atEnd = dE <= dS;
    const piece = atEnd ? r.pieces[r.pieces.length - 1] : r.pieces[0];
    const kind: RailKind = piece.kind === 'transition' ? (atEnd ? 'mono' : 'double') : piece.kind;
    const A: RailAnchor = atEnd
      ? { E, kind, rail: r.id, end: 'b' }
      : { E: { x: r.x, y: r.y, z: r.z, heading: r.heading + 180 }, kind, rail: r.id, end: 'a' };
    return this.railAnchorAction(A, p);
  }

  /** 当前按键对应的钢轨拉法：直线（伸缩）、Shift 拐弯、Alt 坡道、Shift+Alt 螺旋 */
  private railMode(): RailMode {
    const { shift, alt } = this.mods;
    return shift && alt ? 'spiral' : shift ? 'arc' : alt ? 'slope' : 'line';
  }

  /** 钢轨端头的动作：截面（扁平的蓝色块）+ 当前拉法的示意箭头 */
  private railAnchorAction(A: RailAnchor, p?: Pick): Action {
    const { E, kind } = A;
    const top = E.z + railTopOffset(kind);
    const h = (E.heading * Math.PI) / 180, fx = Math.cos(h), fy = Math.sin(h);
    const mode = this.railMode();
    // 拐弯示意朝鼠标所在的一侧
    const side = p ? (-(p.point.x - E.x) * fy + (p.point.y - E.y) * fx >= 0 ? 1 : -1) : 1;
    const hh = RAIL_RADIUS * 2;
    const local = railModeSegs(mode, side, -hh / 2);
    const segs: number[] = [];
    for (let i = 0; i < local.length; i += 3) segs.push(local[i] * fx - local[i + 1] * fy, local[i] * fy + local[i + 1] * fx, local[i + 2]);
    const dir = (((Math.round(E.heading / 90) % 4) + 4) % 4) as Dir;
    return {
      valid: true, segs, pos: [E.x, E.y, top], color: C_RAIL, dir, z: top,
      face: { x: E.x, y: E.y, z: top, dir, ang: E.heading, w: kind === 'mono' ? hh : RAIL_SPAN + hh, h: hh, arrow: 'none' },
      anchor: A,
      apply: () => null,
      apply2: (mm, x, y, ray) => this.railDrag(mm, A, x, y, ray),
    };
  }

  /** 在模型 mm 里拿到要接着长的钢轨，末端朝外（起点那头先倒过来）；新钢轨先建一条空的 */
  private railForAnchor(mm: Model, A: RailAnchor): Rail {
    if (A.rail === null) {
      const id = mm.nextId++;
      return (mm.rails[id] = { id, ...A.E, pieces: [] });
    }
    const r = mm.rails[A.rail];
    if (A.end === 'a') reverseRail(r);
    return r;
  }
  private railAnchorDone(mm: Model, A: RailAnchor, r: Rail) {
    if (!mm.rails[r.id]) return;
    if (A.end === 'a') reverseRail(r);
    if (!r.pieces.length) delete mm.rails[r.id];
  }

  /** 拖动钢轨端头：按当前按键决定拉法（拖动中切换按键会立刻换） */
  private railDrag(mm: Model, A: RailAnchor, x: number, y: number, ray?: THREE.Ray) {
    const mode = this.railMode();
    if (mode === 'spiral') return; // 螺旋在按下时弹出对话框
    const r = this.railForAnchor(mm, A);
    const E = r.pieces.length ? railEnd(r) : A.E;
    const last = r.pieces[r.pieces.length - 1];
    const stretchable = !!last && last.angle === 0 && last.kind !== 'transition';
    const MIN = 0.5;
    let msg = '';
    if (mode === 'line') {
      const p = this.railPieceTo(E, x, y, A.kind, false);
      if (p) {
        if (stretchable && Math.abs(last.dz) > 1e-6 && p.len > 1e-6) {
          // 坡顶往外拉：接一段水平的
          r.pieces.push(p);
        } else if (stretchable) {
          // 和路面一样：末段直线直接伸缩（往回缩时坡度不变）
          const nl = last.len + p.len;
          if (nl >= MIN) { if (last.len > 0) last.dz *= nl / last.len; last.len = nl; }
          else if (r.pieces.length > 1) r.pieces.pop();
          else { if (last.len > 0) last.dz *= MIN / last.len; last.len = MIN; }
        } else if (p.len > 1e-6) r.pieces.push(p);
      }
      const joined = this.railConnect(mm, r);
      const L = r.pieces[r.pieces.length - 1];
      msg = joined ?? (L ? `末段长 ${fmt(pieceLength(L))}` : '');
    } else if (mode === 'arc') {
      const p = this.railPieceTo(E, x, y, A.kind, true);
      if (p) { r.pieces.push(p); msg = `拐弯 ${fmt(Math.abs(p.angle))}°，半径 ${fmt(p.radius)}`; }
    } else if (mode === 'slope' && ray && last) {
      // 已有钢轨：和路面一样，端头上下移动，末段变成坡（圆弧、螺旋也一样带上高差）
      const o = new THREE.Vector3(E.x, E.y, E.z);
      const n = new THREE.Vector3().subVectors(this.camera.position, o).setZ(0).normalize();
      const hit = new THREE.Vector3();
      if (ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, o), hit)) {
        A.z0 ??= hit.z;
        const dz = this.snapZ(E.z + hit.z - A.z0) - E.z;
        last.dz += dz;
        msg = `端头高 ${fmt(E.z + dz)}（${dz >= 0 ? '+' : ''}${fmt(dz)}）`;
      }
    } else if (mode === 'slope' && ray) {
      // 新钢轨：在过起点、沿钢轨方向的竖直面上取鼠标位置，拉出一段坡（这个面几乎侧对视线时改用正对相机的竖直面）
      const h = (E.heading * Math.PI) / 180, fx = Math.cos(h), fy = Math.sin(h);
      const o = new THREE.Vector3(E.x, E.y, E.z);
      let n = new THREE.Vector3(-fy, fx, 0);
      if (Math.abs(ray.direction.dot(n)) < 0.2) n = new THREE.Vector3().subVectors(this.camera.position, o).setZ(0).normalize();
      const hit = new THREE.Vector3();
      if (ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(n, o), hit)) {
        const fwd = (hit.x - E.x) * fx + (hit.y - E.y) * fy;
        const p = this.railPieceTo(E, E.x + fx * fwd, E.y + fy * fwd, A.kind, false);
        const dz = this.snapZ(hit.z) - E.z;
        if (p && p.len >= MIN) { r.pieces.push({ ...p, dz }); msg = `坡道长 ${fmt(p.len)}，高差 ${dz >= 0 ? '+' : ''}${fmt(dz)}`; }
        else if (stretchable) { last.dz += dz; msg = `末段高差 ${fmt(last.dz)}`; }
      }
    }
    this.railAnchorDone(mm, A, r);
    this.alignRailsToRoads(mm);
    if (msg) this.onStatus(msg);
  }

  /**
   * 直线拉到别的钢轨端头 / 路面边上附近时吸过去：
   * 正对着另一条钢轨的端头（同一直线、同高）就连成一条；正对着路面外沿就刚好接到路边。
   */
  private railConnect(mm: Model, r: Rail): string | null {
    const last = r.pieces[r.pieces.length - 1];
    if (!last || last.angle !== 0) return null;
    const E = railEnd(r);
    const h = (E.heading * Math.PI) / 180, fx = Math.cos(h), fy = Math.sin(h);
    const tol = Math.max(1.5, this.snap().tol);
    const same = (a: number, b: number) => Math.abs(((((a - b) % 360) + 540) % 360) - 180) < 0.5;
    for (const o of Object.values(mm.rails)) {
      if (o.id === r.id || !o.pieces.length) continue;
      const OE = railEnd(o);
      for (const [S, rev] of [[{ x: o.x, y: o.y, z: o.z, heading: o.heading }, false], [{ ...OE, heading: OE.heading + 180 }, true]] as [RailState, boolean][]) {
        if (!same(S.heading, E.heading)) continue;
        const dx = S.x - E.x, dy = S.y - E.y;
        const along = dx * fx + dy * fy, lat = -dx * fy + dy * fx;
        if (Math.abs(lat) > 0.05 || Math.abs(along) > tol || last.len + along < 0.5) continue;
        const slope = last.len > 0 ? last.dz / last.len : 0;
        if (Math.abs(E.z + slope * along - S.z) > 0.05) continue;
        last.dz += slope * along;
        last.len += along;
        if (rev) reverseRail(o);
        appendRail(r, o);
        delete mm.rails[o.id];
        return '接上另一条钢轨';
      }
    }
    // 路面外沿：朝着钢轨的那条边
    for (const l of this.loops) {
      for (let i = 0; i < l.outs.length; i++) {
        const a = l.pts[i], b = l.pts[(i + 1) % l.pts.length], o = l.outs[i];
        const d = o[0] * fx + o[1] * fy;
        if (d > -0.999) continue;
        const t = ((a[0] - E.x) * o[0] + (a[1] - E.y) * o[1]) / d;
        if (Math.abs(t) > tol || last.len + t < 0.5) continue;
        const px = E.x + fx * t, py = E.y + fy * t;
        const ex = b[0] - a[0], ey = b[1] - a[1], L2 = ex * ex + ey * ey;
        const u = ((px - a[0]) * ex + (py - a[1]) * ey) / L2;
        if (u < 0 || u > 1) continue;
        if (last.len > 0) last.dz *= (last.len + t) / last.len;
        last.len += t;
        return '接到路边';
      }
    }
    return null;
  }

  /** Shift+Alt：螺旋对话框（方向、半径、每圈高度、圈数），边改边预览 */
  private openSpiral(A: RailAnchor | null, edit?: { rail: number; index: number }) {
    this.closeSpiral();
    const snapshot = cloneModel(this.model);
    const init = edit ? snapshot.rails[edit.rail]?.pieces[edit.index] : null;
    if (!A && !init) return;
    const v = {
      sg: init ? Math.sign(init.angle) || 1 : 1,
      radius: init?.radius ?? SPIRAL_RADIUS,
      turns: init ? Math.abs(init.angle) / 360 : 1,
      pitch: init ? init.dz / Math.max(Math.abs(init.angle) / 360, 1e-6) : -SPIRAL_SCREW,
    };
    const build = () => {
      const mm = cloneModel(snapshot);
      const piece: RailPiece = { kind: init?.kind ?? A?.kind ?? 'double', len: 0, radius: Math.max(v.radius, 1), angle: 360 * v.turns * v.sg, dz: v.pitch * v.turns };
      if (edit) mm.rails[edit.rail].pieces[edit.index] = piece;
      else if (A) {
        const r = this.railForAnchor(mm, A);
        r.pieces.push(piece);
        this.railAnchorDone(mm, A, r);
      }
      this.alignRailsToRoads(mm);
      return mm;
    };
    const el = document.createElement('div');
    el.className = 'settings-panel spiral-dlg';
    el.innerHTML = `<h3>${edit ? '编辑螺旋' : '接一段螺旋'}</h3>
      <label><span>方向</span><span class="seg-toggle"><button data-sg="1">左旋</button><button data-sg="-1">右旋</button></span></label>
      <label><span>半径<small>螺旋中线的半径（原版 5）</small></span><input data-k="radius" type="number" step="0.5" min="1"></label>
      <label><span>每圈高度<small>正数上升、负数下降（原版 5）</small></span><input data-k="pitch" type="number" step="0.5"></label>
      <label><span>圈数<small>可以是小数，如 0.5 圈</small></span><input data-k="turns" type="number" step="0.25" min="0.25"></label>
      <div class="row"><button class="ghost" data-act="cancel">取消</button><button class="primary" data-act="ok">确定</button></div>`;
    type K = 'radius' | 'pitch' | 'turns';
    const inputs = el.querySelectorAll<HTMLInputElement>('input');
    const sync = () => {
      for (const i of inputs) i.value = String(Math.round(v[i.dataset.k as K] * 1000) / 1000);
      for (const b of el.querySelectorAll<HTMLButtonElement>('[data-sg]')) b.classList.toggle('on', Number(b.dataset.sg) === v.sg);
    };
    const preview = () => this.setModel(build());
    for (const i of inputs) i.addEventListener('input', () => {
      const x = parseFloat(i.value);
      if (!Number.isFinite(x)) return;
      v[i.dataset.k as K] = i.dataset.k === 'turns' ? Math.max(0.05, x) : x;
      preview();
    });
    for (const b of el.querySelectorAll<HTMLButtonElement>('[data-sg]')) b.addEventListener('click', () => { v.sg = Number(b.dataset.sg); sync(); preview(); });
    const finish = (ok: boolean) => {
      this.closeSpiral();
      if (ok) {
        this.model = build();
        normalize(this.model);
        this.pushUndo(snapshot);
        this.commitView(snapshot);
      } else {
        this.model = snapshot;
        this.commitView();
      }
    };
    el.querySelector('[data-act="ok"]')!.addEventListener('click', () => finish(true));
    el.querySelector('[data-act="cancel"]')!.addEventListener('click', () => finish(false));
    el.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    // 放在左下角，不挡视图
    this.host.appendChild(el);
    this.hover = null;
    this.overlayDirty = true;
    this.spiralEl = el;
    sync();
    preview();
    inputs[0].focus();
    inputs[0].select();
  }
  private spiralEl: HTMLElement | null = null;
  private closeSpiral() { this.spiralEl?.remove(); this.spiralEl = null; }

  private railMenu(p: Pick): (MenuItem | null)[] {
    const r = this.model.rails[p.id];
    const piece = nearestPiece(r, p.point.x, p.point.y);
    const cur = r.pieces[piece]?.kind ?? 'double';
    const names: Record<RailKind, string> = { double: '双轨', mono: '单轨', transition: '单双转换' };
    const editRail = (fn: (rr: Rail) => void) => () => this.mutate((mm) => { const rr = mm.rails[r.id]; if (rr) fn(rr); if (rr && !rr.pieces.length) delete mm.rails[r.id]; });
    const last = r.pieces[r.pieces.length - 1];
    const endKind: RailKind = last?.kind === 'transition' ? 'mono' : last?.kind ?? 'double';
    const hp = r.pieces[piece];
    const isSpiral = !!hp && hp.angle !== 0 && (Math.abs(hp.angle) >= 360 || Math.abs(hp.dz) > 1e-6);
    const E = railEnd(r);
    // 与另一条钢轨首尾相接（分隔后、或拉到一起）：可以合并成一条
    const joinable = Object.values(this.model.rails).find((o) => o.id !== r.id && (canAppend(r, o) || canAppend(o, r) || canAppend(r, reversed(o)) || canAppend(reversed(o), r)));
    const kindItem = (k: RailKind): MenuItem => ({
      label: `这一段改为${names[k]}`, hint: cur === k ? '当前' : undefined, disabled: cur === k,
      action: editRail((rr) => { rr.pieces[piece].kind = k; }),
    });
    const sAt = nearestS(r, p.point.x, p.point.y);
    return [
      kindItem('double'), kindItem('mono'), kindItem('transition'),
      { label: '末端接单双转换', hint: `长 ${TRANSITION_LEN}`, action: editRail((rr) => rr.pieces.push({ kind: 'transition', len: TRANSITION_LEN, radius: 0, angle: 0, dz: 0 })) },
      null,
      { label: '末端接螺旋…', hint: 'Shift+Alt 拖端头', action: () => this.openSpiral({ E, kind: endKind, rail: r.id, end: 'b' }) },
      { label: '编辑这段螺旋…', disabled: !isSpiral, action: () => this.openSpiral(null, { rail: r.id, index: piece }) },
      null,
      { label: '在此分隔', hint: 'C', action: () => this.cutRailAt(r.id, sAt) },
      { label: '与相接的钢轨合并', disabled: !joinable, action: () => this.mutate((mm) => { if (joinable) joinRails(mm, r.id, joinable.id); }) },
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
  /**
   * 钢轨跟着路面高度走：起点（或直线末段的终点）落在路面外沿上、并且朝外（终点朝里）时，
   * 把钢轨顶端对齐到那里的路面顶面。外沿包括直道端面和侧面、路块空边、平台边。
   */
  private alignRailsToRoads(m: Model) {
    const loops = outlineLoops(m);
    const edgeZ = (x: number, y: number, heading: number): number | null => {
      const h = (heading * Math.PI) / 180, hx = Math.cos(h), hy = Math.sin(h);
      for (const l of loops) {
        for (let i = 0; i < l.outs.length; i++) {
          const a = l.pts[i], b = l.pts[(i + 1) % l.pts.length], o = l.outs[i];
          if (o[0] * hx + o[1] * hy < 0.999) continue;
          const dx = b[0] - a[0], dy = b[1] - a[1], L2 = dx * dx + dy * dy;
          const t = ((x - a[0]) * dx + (y - a[1]) * dy) / L2;
          if (t < -1e-6 || t > 1 + 1e-6) continue;
          if (Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y) > 0.02) continue;
          return a[2] + (b[2] - a[2]) * t;
        }
      }
      return null;
    };
    for (const r of Object.values(m.rails)) {
      if (!r.pieces.length) continue;
      const first = r.pieces[0];
      const zs = edgeZ(r.x, r.y, r.heading);
      if (zs !== null) r.z = zs - railTopOffset(first.kind);
      const E = railEnd(r);
      const last = r.pieces[r.pieces.length - 1];
      if (last.angle !== 0) continue;
      const ze = edgeZ(E.x, E.y, E.heading + 180);
      if (ze !== null) last.dz += ze - railTopOffset(last.kind) - E.z;
    }
  }

  /** 屏幕矩形内的元素：直道看中点或两端，节点看中心（接头不算），钢轨看起点 / 终点 / 中点 */
  /**
   * 框选：按每个元素实际画出来的包围盒判断——包围盒中心在框内，或整个包围盒都在框内。
   * （平台的 x、y 不是中心，机关的原点也可能离模型很远，例如柱子、秋千，所以不能只看坐标点）
   */
  private idsInRect(x0: number, y0: number, x1: number, y1: number): number[] {
    const m = this.model;
    const inside = (v: THREE.Vector3) => { const c = this.projectToClient(v.x, v.y, v.z); return c.x >= x0 && c.x <= x1 && c.y >= y0 && c.y <= y1; };
    const out: number[] = [];
    const box = new THREE.Box3(), v = new THREE.Vector3();
    for (const [id, c] of this.meshCache) {
      const n = m.nodes[id];
      if (n && (n.kind === 'joint' || n.inPlatform !== undefined)) continue;
      if (!n && !m.segs[id] && !m.rails[id] && !m.objs[id] && !m.guards[id]) continue;
      box.makeEmpty();
      for (const mesh of c.meshes) {
        if (mesh.userData.handle) continue;
        mesh.updateMatrixWorld();
        box.expandByObject(mesh);
      }
      if (box.isEmpty()) continue;
      let hit = inside(box.getCenter(v));
      // 机关：对准方块（脚下那一格路面）在框内也算
      const o = m.objs[id];
      if (!hit && o) hit = anchorBlocks(o).some((b) => inside(v.set(b.x, b.y, b.top)));
      if (!hit) {
        hit = true;
        for (let k = 0; k < 8 && hit; k++) hit = inside(v.set(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z));
      }
      if (hit) out.push(id);
    }
    return out;
  }

  // ---------------- gizmo ----------------

  private gizmoTargetFor(p: Pick): GizmoTarget | null {
    if (p.kind === 'guard') return null;
    if (p.kind === 'obj') return { type: 'obj', id: p.id };
    return p.kind === 'rail' ? { type: 'rail', id: p.id } : { type: 'comp', id: p.id };
  }

  /** 手柄显示位置：悬停元素的中心 */
  private gizmoPos(m: Model, g: GizmoTarget): THREE.Vector3 | null {
    if (g.type === 'rail') { const r = m.rails[g.id]; return r ? new THREE.Vector3(r.x, r.y, r.z) : null; }
    if (g.type === 'obj') { const o = m.objs[g.id]; return o ? new THREE.Vector3(o.x, o.y, o.z) : null; }
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
    if (g.type === 'obj' && m.objs[g.id]) {
      // 有对准方块的机关按方块的边沿对齐（方块中心落在格点上时边沿也在格栅上）
      const o = m.objs[g.id];
      const b = anchorBlocks(o)[0];
      return b ? new THREE.Vector3(b.x - b.hx, b.y - b.hy, b.top) : new THREE.Vector3(o.x, o.y, o.z);
    }
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
    if (g.type === 'obj') {
      const o = m.objs[g.id];
      if (!o) return false;
      if (o.base !== undefined) revertBase(m, o.base);
      uncutObj(m, o.id);
      o.x += v[0]; o.y += v[1]; o.z += v[2];
      this.settleObj(m, o.id);
      return true;
    }
    const piece = this.gizmoPieceIds(m, g);
    if (piece.size && !movePiece(m, piece, v[0], v[1], v[2], info)) return false;
    if (g.type === 'multi') {
      for (const id of g.ids) {
        const r = m.rails[id];
        if (r && !info?.moved.has(id)) { r.x += v[0]; r.y += v[1]; r.z += v[2]; }
        const o = m.objs[id];
        if (o) {
          // 底座不在一起移动的路面里：跟着机关走（离路面近就吸上去，否则单独放）
          const baseMoves = o.base !== undefined && piece.has(o.base);
          if (o.base !== undefined && !baseMoves) revertBase(m, o.base);
          o.x += v[0]; o.y += v[1]; o.z += v[2];
          if (isSplitObj(o.type)) { uncutObj(m, o.id); this.settleObj(m, o.id); }
          else if (!baseMoves) this.settleObj(m, o.id);
        }
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
   * 自动连接（常驻，不受格栅 / 自动对齐开关影响）：只接同一高度的；按住 Alt 时高度不同的也接（本段变成坡）。
   * 拖动的端点靠近能接上的地方
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
        const h = nodeHalf(n, opp(out));
        cands.push((ax === 0 ? n.x : n.y) - (DX[out] + DY[out]) * h);
      }
    }
    const near = [...new Set(cands.map((c) => Math.round(c * 1e4) / 1e4))]
      .filter((c) => Math.abs(c - cur) < tol).sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur));
    const save = { x: s.x, y: s.y, len: s.len };
    for (const c of near) {
      extendTo(m, s.id, g.key, c);
      const [nx, ny] = endPos(s, g.key);
      if (Math.abs((ax === 0 ? nx : ny) - c) < 1e-6 && Math.abs((ax === 0 ? ny : nx) - lat) < 1e-6 && findConnection(m, s.id, g.key, this.mods.alt)) return;
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
    const c = findConnection(m, seg, key, this.mods.alt);
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

  /** 左键按下时的位置与选择（松开时判断是不是点选了新的东西） */
  private downInfo: { x: number; y: number; sel: string; undo: number; marquee: boolean } | null = null;
  private selKey() { return `${this.selected}|${[...this.selection].sort().join(',')}`; }

  private onDown(e: PointerEvent) {
    this.syncMods(e);
    if (e.button === 0) {
      this.downInfo = { x: e.clientX, y: e.clientY, sel: this.selKey(), undo: this.undoStack.length, marquee: false };
    }
    if (e.button === 1) {
      // 有选中的东西时绕着它转（只换环绕点，视图不挪）；没有时由 OrbitControls 绕视图中心转
      const pivot = e.shiftKey ? null : this.orbitPivot(); // Shift+中键是平移
      this.drag = { type: 'orbit', pivot: pivot ?? undefined, lx: e.clientX, ly: e.clientY };
      return;
    }
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
        const s0 = this.snapGuardS(this.loops[g.loop], g.s);
        this.drag = { type: 'guard', snapshot, id: null, end: 'b', loop: g.loop, s0, s: s0, sx: e.clientX, sy: e.clientY, started: false };
        return;
      }
    }
    if (!p) {
      // 空白处按下不松：拖出选框多选（Shift 追加）；只是点一下则清空选择
      if (this.tool === 'edit' || this.tool === 'cut') {
        this.drag = { type: 'marquee', sx: e.clientX, sy: e.clientY, add: e.shiftKey };
        return;
      }
      // 钢轨工具：空地上按住拖，从地面（高度 0）拉出一条钢轨，方向按拖动的方向
      const g = this.tool === 'rail' ? this.rayOnPlaneZ(0) : null;
      if (g) {
        e.preventDefault();
        const sx = this.snapEdge(g.x, 0, [g.x, g.y, 0]), sy = this.snapEdge(g.y, 1, [g.x, g.y, 0]);
        const action: Action = {
          valid: true, segs: [], pos: [sx, sy, 0], color: C_RAIL, dir: 0, z: 0,
          apply: () => null,
          apply2: (mm, x, y) => {
            const dx = x - sx, dy = y - sy;
            if (Math.hypot(dx, dy) < 0.5) return;
            const dir: Dir = Math.abs(dx) >= Math.abs(dy) ? (dx >= 0 ? 0 : 2) : (dy >= 0 ? 1 : 3);
            const E: RailState = { x: sx, y: sy, z: -railTopOffset('double'), heading: dir * 90 };
            const piece = this.railPieceTo(E, x, y, 'double', false);
            if (!piece || piece.len <= 1e-6) return;
            const id = mm.nextId++;
            mm.rails[id] = { id, ...E, pieces: [piece] };
          },
        };
        this.drag = { type: 'action', snapshot: cloneModel(this.model), action, sx: e.clientX, sy: e.clientY, started: false };
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
        // 抓取偏移按对准方块顶面（路面）所在的水平面算：拖动时鼠标也是落在路面上的，
        // 直接用点中模型的那一点（例如风扇的风柱高处）会让机关偏到路外
        const top = anchorBlocks(o)[0]?.top ?? o.z;
        const g = this.rayOnPlaneZ(top) ?? p.point;
        this.drag = { type: 'obj', snapshot, id: o.id, ox: o.x - g.x, oy: o.y - g.y, moved: false, sx: e.clientX, sy: e.clientY };
      }
      return;
    }

    if (this.tool === 'cut') {
      if (p.kind === 'seg') this.cutAt(p);
      if (p.kind === 'rail') { const r = this.model.rails[p.id]; this.cutRailAt(r.id, nearestS(r, p.point.x, p.point.y)); }
      return;
    }
    // 钢轨端头（或钢轨工具从路边起轨）：直线 / Shift 拐弯 / Alt 坡道直接拖；Shift+Alt 弹出螺旋对话框
    if (this.tool === 'rail' || p.kind === 'rail') {
      const ra = this.actionFor(p);
      if (ra?.anchor && ra.valid) {
        this.select(p.id);
        if (e.shiftKey && e.altKey) { this.openSpiral(ra.anchor); return; }
        this.drag = { type: 'action', snapshot, action: ra, sx: e.clientX, sy: e.clientY, started: false };
        this.overlayDirty = true;
        return;
      }
      if (ra && !ra.valid) { if (ra.reason) this.flashStatus(ra.reason); return; }
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
    if (d.type === 'orbit') {
      // 绕选中物体环视：先攒着，每帧缓动地转过去（与 OrbitControls 的阻尼手感一致）
      if (d.pivot) { this.orbitPending.p = d.pivot; this.orbitPending.dx += e.clientX - d.lx; this.orbitPending.dy += e.clientY - d.ly; }
      d.lx = e.clientX; d.ly = e.clientY;
      return;
    }
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
      if (!d.moved) {
        // 开始拖：先把它断开的路接回去、专属底座变回普通路面（否则路被底座打断，拖动时只能整格跳），
        // 松手时在新位置重新断开 / 铺底座
        const m0 = cloneModel(this.model);
        uncutObj(m0, d.id);
        const ob = m0.objs[d.id];
        if (ob?.base !== undefined) revertBase(m0, ob.base);
        normalize(m0);
        this.setModel(m0);
      }
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
      if (d.action.apply2) d.action.apply2(m, hit.x, hit.y, this.raycaster.ray);
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
    if (d?.type === 'orbit') { this.controls.enableRotate = true; return; }
    if (!d) return;
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
      tryConnect(m, this.growEnd.seg, this.growEnd.key, this.mods.alt);
    }
    this.growEnd = null;
    this.guides = [];
    normalize(m);
    if (!this.dragMovesRails(d)) followRails(before, m);
    this.alignRailsToRoads(m);
    followSurfaces(before, m);
    if (JSON.stringify(before) === JSON.stringify(m)) return;
    this.pushUndo(before);
    this.commitView(before);
  }

  private onKey(e: KeyboardEvent, down: boolean) {
    const flipped = this.gridFlipped;
    const railMode = this.railMode();
    this.syncMods(e);
    if (e.key === 'Alt') e.preventDefault();
    const railSwitch = this.drag?.type === 'action' && !!this.drag.action.anchor && this.railMode() !== railMode;
    // 拖动中切换了临时对齐模式（或钢轨的拉法）：按新模式重新计算一次
    if ((this.gridFlipped !== flipped || railSwitch) && this.drag && this.lastMove) {
      const lm = this.lastMove;
      this.onMove({ clientX: lm.clientX, clientY: lm.clientY, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, altKey: e.altKey } as PointerEvent);
      this.onChange();
    }
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    const k = e.key.toLowerCase();
    // 按住 C 分隔，松开恢复
    if (k === 'c' && !e.ctrlKey && !e.altKey) { if (!e.repeat) this.setCutHeld(down); return; }
    if (!down) return;
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
    if (k === '2') this.setTool('rail');
    if (k === '3') this.setTool('guard');
    if (k === 'r') {
      // 指着盘点：转重生朝向
      const hn = this.hover?.kind === 'node' ? this.model.nodes[this.hover.id] : undefined;
      if (!this.placing && hn?.kind === 'checkpoint') { const nid = hn.id; this.mutate((m) => { rotateSpawn(m, nid, e.shiftKey ? 3 : 1); }); return; }
      const id = this.hover?.kind === 'obj' ? this.hover.id : this.selected;
      // 机关工具里没指着已放的物件：转的是待放置的朝向
      if (this.placing) { this.placeRot = (this.placeRot + (e.shiftKey ? 270 : 90)) % 360; this.updateGhost(); return; }
      if (id !== null && this.model.objs[id]) this.mutate((m) => { m.objs[id].rot = (Math.round(m.objs[id].rot / 90) * 90 + (e.shiftKey ? 270 : 90)) % 360; rebaseObj(m, id); });
    }
    if (k === 'g') this.setGridMode(!this.gridMode);
    if (k === 'f') this.frameSelection();
    if (k === 's' && !e.ctrlKey) this.setSnapMode(!this.snapMode);
    if (k === 'escape' && this.placing) { this.cancelPlace(); return; }
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
        items.push({ label: '路面旋转 90°', hint: linked ? '接着路时不能转' : '重生朝向一起转', disabled: linked, action: () => this.mutate((mm) => { rotateCheckpoint(mm, n.id, 1); }) });
        items.push({ label: '重生朝向转 90°', hint: 'R', action: () => this.mutate((mm) => { rotateSpawn(mm, n.id, 1); }) });
        items.push({ label: '重生朝向掉头', action: () => this.mutate((mm) => { rotateSpawn(mm, n.id, 2); }) });
        if (n.prefab === 'check') {
          const list = checkpoints(m);
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
    // 每个对准方块试着贴到它下面的路面上，取挪动最少的那个
    const blocks = anchorBlocks({ type, x: ox, y: oy, z: 0, rot });
    let best: { x: number; y: number; z: number; d: number } | null = null;
    blocks.forEach((bl, i) => {
      const a = anchors[i];
      const cell = this.alignBlock(bl.x, bl.y, refZ, bl.hx, bl.hy);
      if (!cell) return;
      const d = Math.hypot(cell.x - bl.x, cell.y - bl.y);
      if (!best || d < best.d) best = { x: ox + cell.x - bl.x, y: oy + cell.y - bl.y, z: blockTopZ(cell, type) - a[2] + lift, d };
    });
    if (best) { const b = best as { x: number; y: number; z: number }; return { x: b.x, y: b.y, z: b.z, rot }; }
    // 哪个方块下面都没有路：跟着鼠标，高度按主对准方块
    const at: [number, number, number] = [ox, oy, refZ];
    return { x: this.snapEdge(ox, 0, at, 1.25), y: this.snapEdge(oy, 1, at, 1.25), z: refZ - t!.anchor![2] + lift, rot };
  }

  /**
   * 对准方块落到 (x,y) 下面的路面上，返回方块中心（路面高度、横向居中总是生效）。沿路方向：
   *   1. 自动对齐开着时，方块的面与路的两头（直道端面、截面接头、路块边沿）贴齐；
   *   2. 格栅开着时方块的边落在 2.5 的格线上，自动对齐开着时吸附到附近的特征；两个都关着时跟着鼠标连续移动；
   * 横向：方块和路一样宽时落在路中线上。
   */
  private alignBlock(x: number, y: number, z: number, hx: number, hy: number, model: Model = this.model): { x: number; y: number; z: number; sink: boolean } | null {
    const sfs = surfacesAt(model, x, y).filter((sf) => Math.abs(sf.z - z) < 3);
    if (!sfs.length) return null;
    const sf = sfs.reduce((a, b) => (Math.abs(b.z - z) < Math.abs(a.z - z) ? b : a));
    const seg = model.segs[sf.id], node = model.nodes[sf.id];
    const tol = Math.min(1.25, this.snap().tol);
    /** 一维：区间 [lo, hi] 内放半宽 h 的方块，优先贴两头 */
    const fit = (c: number, lo: number, hi: number, h: number, axis: 0 | 1, at: [number, number, number]) => {
      const cands = this.snapMode ? [lo + h, hi - h].filter((v) => v >= lo + h - 1e-6 && v <= hi - h + 1e-6) : [];
      const near = cands.filter((v) => Math.abs(v - c) < tol).sort((p, q) => Math.abs(p - c) - Math.abs(q - c))[0];
      if (near !== undefined) return near;
      const v = Math.abs(h - HALF) < 1e-6 ? this.snapEdge(c, axis, at) : this.snapEdge(c - h, axis, at) + h;
      return Math.min(Math.max(v, lo + h), Math.max(hi - h, lo + h));
    };
    if (seg) {
      const ax = axisOf(seg.dir);
      const [ex, ey] = endPos(seg, 'b');
      const lo = Math.min(ax === 0 ? seg.x : seg.y, ax === 0 ? ex : ey), hi = Math.max(ax === 0 ? seg.x : seg.y, ax === 0 ? ex : ey);
      const h = ax === 0 ? hx : hy, w = ax === 0 ? hy : hx;
      const along = fit(ax === 0 ? x : y, lo, hi, h, ax, [x, y, sf.z]);
      // 横向：和路一样宽就落在中线上，否则贴路边
      const mid = ax === 0 ? seg.y : seg.x;
      const latC = ax === 0 ? y : x;
      const lat = Math.abs(w - HALF) < 1e-6 ? mid : fit(latC, mid - HALF, mid + HALF, w, (1 - ax) as 0 | 1, [x, y, sf.z]);
      const sink = seg.style === 'sink';
      return ax === 0 ? { x: along, y: lat, z: sf.z, sink } : { x: lat, y: along, z: sf.z, sink };
    }
    if (node && node.kind !== 'platform') {
      const r = nodeRect(node);
      return { x: fit(x, r.x0, r.x1, hx, 0, [x, y, sf.z]), y: fit(y, r.y0, r.y1, hy, 1, [x, y, sf.z]), z: node.z, sink: node.style === 'sink' };
    }
    // 平台：方块的边按格栅（2.5）/ 吸附；嵌入底座时再对齐到平台的 1.25 小格（见 bases.ts）
    const sink = node?.style === 'sink';
    return { x: this.snapEdge(x - hx, 0, [x, y, sf.z]) + hx, y: this.snapEdge(y - hy, 1, [x, y, sf.z]) + hy, z: sf.z, sink };
  }

  /**
   * 自由移动后的机关：对准方块离路面很近（水平 1.25、高度 0.5 以内）就吸到路上并替换路面，
   * 否则需要专属底座的机关在原地单独放一块底座。
   */
  private settleObj(m: Model, id: number) {
    const o = m.objs[id];
    const split = !!o && isSplitObj(o.type);
    if (!o || (!baseOf(o.type) && !split)) return;
    const b = anchorBlocks(o)[0];
    const cell = b ? this.alignBlock(b.x, b.y, b.top, b.hx, b.hy, m) : null;
    const near = !!b && !!cell && Math.hypot(cell.x - b.x, cell.y - b.y) < 1.25 && Math.abs(blockTopZ(cell, o.type) - b.top) < 0.5;
    if (near) { o.x += cell!.x - b!.x; o.y += cell!.y - b!.y; o.z += blockTopZ(cell!, o.type) - b!.top; }
    // 从中间断开的机关：落在直路中间就把跨着的那段路去掉
    if (split) { cutForObj(m, id); return; }
    if (near && placeBase(m, id) !== null) return;
    placeFreeBase(m, id);
  }

  /** 路面顶面高度（凹槽里点到的是槽底，取路面标称高度） */
  private surfaceTop(x: number, y: number, hz: number): number {
    const near = surfacesAt(this.model, x, y).filter((sf) => Math.abs(sf.z - hz) < 1);
    return near.length ? near.reduce((p, c) => (Math.abs(c.z - hz) < Math.abs(p.z - hz) ? c : p)).z : hz;
  }

  private updateGhost() {
    const type = this.placing;
    const show = !!type && this.placingOver;
    if (!show) { this.ghost.visible = false; return; }
    const at = this.objPlacement(type!);
    if (!at) { this.ghost.visible = false; return; }
    if (this.ghostType !== type || this.ghost.children.length === 0) {
      this.ghost.clear();
      for (const mesh of this.objMeshes({ type: type!, x: 0, y: 0, z: 0, rot: 0 }, true)) this.ghost.add(mesh);
      this.ghostType = this.ghost.children.length ? type! : '';
    }
    this.ghost.position.set(at.x, at.y, at.z);
    this.ghostAt = { type: type!, ...at };
    this.ghost.rotation.z = (at.rot * Math.PI) / 180;
    this.ghost.visible = true;
  }

  // ---------------- 机关库拖放 ----------------

  /** 从机关库按下一张卡片：开始拖放 */
  beginPlace(type: string) {
    this.cancelDrag();
    this.placing = type;
    this.placingOver = false;
    this.ghostType = '';
    this.updateStatus();
    this.overlayDirty = true;
  }

  /** 拖放中鼠标移动（over：是否在视图上） */
  placeMove(clientX: number, clientY: number, over: boolean) {
    if (!this.placing) return;
    this.placingOver = over;
    if (over) {
      this.setMouse({ clientX, clientY } as MouseEvent);
      this.hover = this.pick();
    }
    this.updateGhost();
    this.overlayDirty = true;
  }

  /** 松开：在视图上就放下，否则取消 */
  endPlace(clientX: number, clientY: number, over: boolean) {
    const type = this.placing;
    if (!type) return;
    this.placeMove(clientX, clientY, over);
    const at = over ? this.objPlacement(type) : null;
    this.placing = null;
    this.ghost.visible = false;
    this.updateStatus();
    if (!at) return;
    const before = cloneModel(this.model);
    const m = this.model;
    const id = addObj(m, type, at.x, at.y, at.z, at.rot);
    if (id === null) { this.flashStatus(`${objType(type)?.label ?? type}只能有一个`); return; }
    // 新放的机关归到工具栏选的小节
    if (m.objs[id].cat === 'module') m.objs[id].sector = Math.min(this.placeSector, sectorCount(m));
    rebaseObj(m, id);
    normalize(m);
    this.pushUndo(before);
    this.commitView(before);
    this.select(id);
  }

  /** 右键 / Esc：取消放置 */
  cancelPlace() {
    if (!this.placing) return;
    this.placing = null;
    this.ghost.visible = false;
    this.overlayDirty = true;
    this.updateStatus();
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

  private newPrefabAt(p: THREE.Vector3, prefab: Prefab) {
    const cx = this.snapEdge(p.x - HALF, 0) + HALF;
    const cy = this.snapEdge(p.y - HALF, 1) + HALF;
    this.guides = [];
    this.mutate((mm) => { addCheckpoint(mm, prefab, cx, cy, 0, 0); });
  }

  // ---------------- 视角 ----------------

  private camAnim: { dT: THREE.Vector3; dP: THREE.Vector3; k: number } | null = null;
  /** 滚轮缩放的目标距离（相机到视图中心），每帧缓动过去 */
  private zoomGoal: number | null = null;
  /** 绕选中物体环视时还没转完的量（像素） */
  private orbitPending: { p: THREE.Vector3 | null; dx: number; dy: number } = { p: null, dx: 0, dy: 0 };

  /** 正在操作 / 选中的东西的包围盒（多选、单选，或拖动中的那个） */
  private focusBox(): THREE.Box3 | null {
    const ids = this.selection.size ? [...this.selection] : this.selected !== null ? [this.selected] : [];
    const box = new THREE.Box3(), one = new THREE.Box3();
    for (const id of ids) {
      one.makeEmpty();
      for (const mesh of this.meshCache.get(id)?.meshes ?? []) {
        if (mesh.userData.handle) continue;
        mesh.updateMatrixWorld();
        one.expandByObject(mesh);
      }
      // 很高的机关 / 装饰（例如柱子长三百多）：只看对准方块附近，免得视图中心跑到地下很远的地方
      const o = this.model.objs[id];
      const blocks = o ? anchorBlocks(o) : [];
      if (blocks.length && !one.isEmpty() && one.max.z - one.min.z > 40) {
        const top = Math.max(...blocks.map((b) => b.top));
        one.min.z = Math.max(one.min.z, Math.min(...blocks.map((b) => b.top)) - 10);
        one.max.z = Math.min(one.max.z, top + 20);
      }
      box.union(one);
    }
    return box.isEmpty() ? null : box;
  }

  /** 平滑地把视图中心移到 center；dist 不为空时同时调整到这个观察距离（视线方向不变） */
  private moveCamera(center: THREE.Vector3, dist: number | null) {
    const t = this.controls.target;
    const off = this.camera.position.clone().sub(t);
    if (dist !== null) off.setLength(dist);
    const dT = center.clone().sub(t);
    const dP = center.clone().add(off).sub(this.camera.position);
    if (dT.lengthSq() < 1e-6 && dP.lengthSq() < 1e-6) return;
    this.camAnim = { dT, dP, k: 0 };
    if (dist !== null) this.zoomGoal = null;
  }

  /** 每帧按增量推进（与用户同时进行的环视 / 平移叠加，不会互相打架） */
  private tickCamera(dt: number) {
    const op = this.orbitPending;
    if (op.p && (Math.abs(op.dx) > 0.01 || Math.abs(op.dy) > 0.01)) {
      const k = 1 - Math.exp(-dt / 0.06);
      const dx = op.dx * k, dy = op.dy * k;
      op.dx -= dx; op.dy -= dy;
      this.orbitAround(op.p, dx, dy);
    }
    if (this.zoomGoal !== null) {
      const off = this.camera.position.clone().sub(this.controls.target);
      const cur = off.length();
      const next = cur + (this.zoomGoal - cur) * (1 - Math.exp(-dt / 0.07));
      this.camera.position.copy(this.controls.target).add(off.setLength(next));
      if (Math.abs(this.zoomGoal - next) < Math.max(0.005, cur * 1e-4)) this.zoomGoal = null;
      this.overlayDirty = true;
    }
    const a = this.camAnim;
    if (!a) return;
    const ease = (x: number) => 1 - (1 - x) ** 3;
    const k1 = Math.min(a.k + dt / 0.28, 1);
    const f = ease(k1) - ease(a.k);
    a.k = k1;
    this.controls.target.addScaledVector(a.dT, f);
    this.camera.position.addScaledVector(a.dP, f);
    if (k1 >= 1) this.camAnim = null;
    this.overlayDirty = true;
  }

  /**
   * 绕任意点 P 环视：相机和视图中心一起绕 P 转（水平绕世界 Z 轴、竖直绕相机右方向），
   * 视线方向随之转动，P 在屏幕上的位置基本不变，不会把它拉到画面中间。
   */
  private orbitAround(p: THREE.Vector3, dx: number, dy: number) {
    const h = this.renderer.domElement.clientHeight || 1;
    const yaw = (-2 * Math.PI * dx) / h, pitch = (-2 * Math.PI * dy) / h;
    const cam = this.camera.position, tgt = this.controls.target;
    const rot = (q: THREE.Quaternion) => {
      cam.sub(p).applyQuaternion(q).add(p);
      tgt.sub(p).applyQuaternion(q).add(p);
    };
    rot(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw));
    const fwd = tgt.clone().sub(cam).normalize();
    const right = fwd.clone().cross(new THREE.Vector3(0, 0, 1)).normalize();
    // 竖直方向别转过头顶 / 脚底
    const next = fwd.clone().applyAxisAngle(right, pitch);
    if (Math.abs(next.z) < 0.995 && right.lengthSq() > 1e-6) rot(new THREE.Quaternion().setFromAxisAngle(right, pitch));
    this.overlayDirty = true;
  }

  private viewSaveT = 0;
  private viewKey = '';

  /** 视角（相机位置与环绕点）记在本地，刷新后恢复；每半秒最多存一次 */
  private saveViewSoon(dt: number) {
    this.viewSaveT += dt;
    if (this.viewSaveT < 0.5) return;
    this.viewSaveT = 0;
    const v = [...this.camera.position.toArray(), ...this.controls.target.toArray()].map((x) => Math.round(x * 100) / 100);
    const key = v.join(',');
    if (key === this.viewKey) return;
    this.viewKey = key;
    try { localStorage.setItem('bvm.view', key); } catch { /* 存不了就算了 */ }
  }

  private loadView() {
    let s: string | null = null;
    try { s = localStorage.getItem('bvm.view'); } catch { return; }
    const v = s?.split(',').map(Number);
    if (!v || v.length !== 6 || v.some((x) => !Number.isFinite(x))) return;
    this.camera.position.set(v[0], v[1], v[2]);
    this.controls.target.set(v[3], v[4], v[5]);
    this.controls.update();
    this.viewKey = s!;
  }

  /** 环绕点：选中的东西的中心；没有选中时取离画面中心最近的物体 */
  private orbitPivot(): THREE.Vector3 | null {
    const f = this.focusBox();
    if (f) return f.getCenter(new THREE.Vector3());
    return this.centerPivot();
  }

  /** 画面正中的物体：视线正中打到的那一点；没打到时取包围盒中心在屏幕上离画面中心最近的物体 */
  private centerPivot(): THREE.Vector3 | null {
    const rc = new THREE.Raycaster();
    rc.setFromCamera(new THREE.Vector2(0, 0), this.camera);
    const hit = rc.intersectObjects(this.pickables.filter((o) => o.visible), false)[0];
    if (hit) return hit.point.clone();
    let best: THREE.Vector3 | null = null, bd = Infinity;
    const box = new THREE.Box3(), c = new THREE.Vector3(), q = new THREE.Vector3();
    for (const { meshes } of this.meshCache.values()) {
      box.makeEmpty();
      for (const mesh of meshes) { if (mesh.userData.handle) continue; mesh.updateMatrixWorld(); box.expandByObject(mesh); }
      if (box.isEmpty()) continue;
      box.getCenter(c);
      q.copy(c).project(this.camera);
      if (q.z < -1 || q.z > 1) continue; // 在相机后面
      const d = q.x * q.x + q.y * q.y;
      if (d < bd) { bd = d; best = c.clone(); }
    }
    return best;
  }

  /** 点选了东西：视图中心平移过去（不拉近；按 F 才拉近） */
  private panToSelection() {
    const box = this.focusBox();
    if (box) this.moveCamera(box.getCenter(new THREE.Vector3()), null);
  }

  /** F：视角对正选中的东西 */
  frameSelection() {
    const box = this.focusBox();
    if (!box) { this.flashStatus('没有选中的东西'); return; }
    const size = box.getSize(new THREE.Vector3()).length();
    this.moveCamera(box.getCenter(new THREE.Vector3()), THREE.MathUtils.clamp(size * 1.4, 20, 800));
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
    // 拖动路面时，接在路面端头上的钢轨跟着伸缩 / 移动（拖钢轨本身时不跟）
    const d = this.drag;
    if (d && 'snapshot' in d && !this.dragMovesRails(d)) followRails(d.snapshot, m);
    this.model = m;
    this.overlayDirty = true;
  }

  /** 这次拖动改的是钢轨本身（钢轨端头、钢轨高度、用 gizmo 移动钢轨） */
  private dragMovesRails(d: Drag) {
    return (d.type === 'action' && !!d.action.anchor) || d.type === 'railHeight' || (d.type === 'gizmo' && d.target.type === 'rail');
  }

  private mutate(fn: (m: Model) => void) {
    const before = cloneModel(this.model);
    fn(this.model);
    normalize(this.model);
    followRails(before, this.model);
    this.alignRailsToRoads(this.model);
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
      // 新放了盘点：工具栏的当前小节切到它激活的小节
      for (const n of Object.values(this.model.nodes)) {
        if (n.kind === 'checkpoint' && n.prefab === 'check' && !before.nodes[n.id] && n.sector) this.placeSector = n.sector;
      }
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
    if (this.placing) {
      hs = [H(['LMB'], `松开放下「${objType(this.placing)?.label ?? this.placing}」`), H(['RMB'], '取消'), H(['R'], '旋转'), H(['Esc'], '取消')];
    } else if (d && d.type !== 'orbit') {
      if (d.type === 'marquee') hs = [H(['LMB'], '框选'), H(['Shift'], '追加'), H(['Esc'], '取消')];
      else {
        hs = [H(['LMB'], '确认'), H(['Esc'], '取消')];
        if (!['height', 'railHeight', 'objHeight'].includes(d.type)) hs.push(H(['Alt'], (this.gridMode !== this.gridFlipped ? '临时关格栅' : '临时开格栅') + ' · 允许连成坡'));
      }
    } else if (this.tool === 'edit' && this.hover?.kind === 'rail' && this.action?.anchor) {
      hs = [H(['LMB'], '直线伸缩'), H(['Shift', 'LMB'], '拐弯'), H(['Alt', 'LMB'], '坡道'), H(['Shift', 'Alt', 'LMB'], '螺旋'), H(['RMB'], '菜单')];
    } else if (this.tool === 'edit') {
      if (this.mods.shift) hs = [H(['Shift', 'LMB'], '侧面拉成平台 / 推平台边')];
      else if (this.mods.ctrl) hs = [H(['Ctrl', 'LMB'], this.selection.size ? `移动选中的 ${this.selection.size} 个` : '沿箭头移动这一块'), H([], '蓝框整体平移 · 黄虚线伸缩 / 成坡')];
      else if (this.mods.alt) hs = [H(['Alt', 'LMB'], '调高度成坡'), H([], '绿框升降 · 橙虚线变坡 · 其余不动')];
      else hs = [
        H(['LMB'], '拉长 / 开路口'), H(['LMB'], '空白处框选'), H(['Shift'], '平台'), H(['Alt'], '坡面'), H(['Ctrl'], '移动'),
        H(['RMB'], '菜单'), H(['MMB'], '环视'), H(['Wheel'], '缩放'), H(['C'], '按住分隔'), H(['E'], '端点开合'), H(['F'], '拉近选中'), H(['G'], '格栅对齐'), H(['S'], '自动对齐'),
      ];
    } else if (this.tool === 'cut') hs = [H(['C', 'LMB'], '点截面分隔（路面 / 钢轨）'), H([], '松开 C 回到原来的工具'), H(['MMB'], '环视')];
    else if (this.tool === 'guard') hs = [H(['LMB'], '点路边：沿这条直边放护栏'), H(['LMB'], '沿路边拖：自由长度、可跨拐角'), H(['LMB'], '拖护栏端头：调长度'), H(['X'], '删除'), H(['MMB'], '环视')];
    else hs = [
      H(['LMB'], '从路边 / 钢轨端头拉：直线伸缩'), H(['Shift'], '拐弯'), H(['Alt'], '坡道'), H(['Shift', 'Alt'], '螺旋'),
      H(['Ctrl'], '移动'), H(['C'], '按住分隔'), H(['RMB'], '单双轨 / 合并'), H(['X'], '删除'),
    ];
    if (this.selection.size && !d) hs.push(H(['X'], '删除选中'), H(['Esc'], '取消选择'));
    const key = JSON.stringify(hs);
    if (key === this.hintsKey) return;
    this.hintsKey = key;
    this.onHints(hs);
  }
}

function reversed(r: Rail): Rail {
  const c: Rail = JSON.parse(JSON.stringify(r));
  reverseRail(c);
  return c;
}

/** 把首尾相接的两条钢轨合并成一条（必要时倒过来接） */
function joinRails(m: Model, aId: number, bId: number) {
  const a = m.rails[aId], b = m.rails[bId];
  if (!a || !b) return;
  for (const [x, y] of [[a, b], [b, a]] as [Rail, Rail][]) {
    for (const flipY of [false, true]) {
      for (const flipX of [false, true]) {
        const X: Rail = flipX ? reversed(x) : x, Y: Rail = flipY ? reversed(y) : y;
        if (!canAppend(X, Y)) continue;
        appendRail(X, Y);
        X.id = aId;
        m.rails[aId] = X;
        delete m.rails[bId];
        return;
      }
    }
  }
}

/** 钢轨拉法的示意（本地坐标：x 沿钢轨朝外、y 朝左、z 朝上，zc 为截面中心高度） */
function railModeSegs(mode: RailMode, side: number, zc: number): number[] {
  const out: number[] = [];
  const line = (a: number[], b: number[]) => out.push(...a, ...b);
  /** 箭头头部：尖端 t，方向 d（单位向量），两翼沿 n 张开 */
  const head = (t: number[], d: number[], n: number[]) => {
    for (const s of [1, -1]) line(t, [t[0] - d[0] * 1.1 + n[0] * 0.8 * s, t[1] - d[1] * 1.1 + n[1] * 0.8 * s, t[2] - d[2] * 1.1 + n[2] * 0.8 * s]);
  };
  if (mode === 'line') {
    line([0.4, 0, zc], [4, 0, zc]);
    head([4, 0, zc], [1, 0, 0], [0, 1, 0]);
  } else if (mode === 'arc') {
    const R = 3.5, N = 12, th1 = (80 * Math.PI) / 180;
    const P = (t: number) => [R * Math.sin(t), side * (R - R * Math.cos(t)), zc];
    for (let i = 0; i < N; i++) line(P((th1 * i) / N), P((th1 * (i + 1)) / N));
    head(P(th1), [Math.cos(th1), side * Math.sin(th1), 0], [-side * Math.sin(th1), Math.cos(th1), 0]);
  } else if (mode === 'slope') {
    const t = [3.6, 0, zc + 2.2], L = Math.hypot(3.2, 2.2), d = [3.2 / L, 0, 2.2 / L];
    line([0.4, 0, zc], t);
    head(t, d, [-d[2], 0, d[0]]);
  } else {
    // 螺旋：一圈半往上绕
    const N = 36, R = 1.3, cx = 2.4, H = 2.6;
    const P = (i: number) => { const t = (i / N) * Math.PI * 3; return [cx - R * Math.cos(t), R * Math.sin(t), zc + (H * i) / N]; };
    for (let i = 0; i < N; i++) line(P(i), P(i + 1));
  }
  return out;
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

/**
 * 需要专属路面的机关：拆掉原来的底座，在当前位置重新铺（位置不在路上时就不铺）；
 * 从中间断开的机关：把原来断开的路接回去，在当前位置重新断开
 */
function rebaseObj(m: Model, id: number) {
  const o = m.objs[id];
  if (!o) return;
  if (isSplitObj(o.type)) { uncutObj(m, id); cutForObj(m, id); return; }
  if (!baseOf(o.type)) return;
  if (o.base !== undefined) revertBase(m, o.base);
  // 不在路面上（或放不下）：单独放一块底座
  if (placeBase(m, id) === null) placeFreeBase(m, id);
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

/** 长方体的 12 条棱 */
function boxSegs(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number[] {
  const out: number[] = [];
  for (const z of [z0, z1]) out.push(x0, y0, z, x1, y0, z, x1, y0, z, x1, y1, z, x1, y1, z, x0, y1, z, x0, y1, z, x0, y0, z);
  for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) out.push(x, y, z0, x, y, z1);
  return out;
}

/**
 * 对准方块的顶面高度：凹槽路面、凹槽平台（含细边花纹平台）上对准下沉 0.7 的槽底，机关才能融进凹槽里
 * （风扇、变球器的底座也嵌在槽底）；栅栏的专属路面是两格长的整块，仍对准路面标称高度
 */
function blockTopZ(cell: { z: number; sink: boolean }, type: string) {
  return cell.sink && baseOf(type)?.kind !== 'fence' ? cell.z - SINK_DEPTH : cell.z;
}
