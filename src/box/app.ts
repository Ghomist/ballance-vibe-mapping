// Ballance Vibe Mapping 编辑器（box 版）：路面、素材件、机关、钢轨、护栏的放置与编辑
//   左键：点选 / 框选（Shift 加选）/ 拖动；Shift 拖动沿轴移动；Alt 拖动改高度；Ctrl 拖动改尺寸
//   按住 V 拖动：抓住顶点或边中点，吸附到别的元素的顶点、边中点或边上
//   格栅（G）：位置和尺寸吸附到步长 1；对齐（S）：边、中线、顶面靠近时对齐并画出辅助面
import * as THREE from 'three';
import { KEY_DEFS, actionFor, assignKey, comboOf, flyActionFor, holdModeOf, isBareModifier, keyDef, keyName, keyOf, keyText, keysOf, loadKeys, resetKeys, savedKeys, setKey, tokens } from './keymap';
import { CURSOR_TINT, installCursors, toolCursor, type CursorBase } from './cursors';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MatName } from '../geom/floor';
import { FAKE_EXTRA, FAKE_FIX, OBJ_TYPES, fakeModel, objType } from '../model/objects';
import { stopperCount, stopperMesh, stopperOff, stopperTops } from '../model/stoppers';
import { type AssetPiece, fallbackBox, getAsset, getStopperMaterial, setAssetLoadedCallback } from '../view/assets';
import { floorTexturesReady, getMaterial, getRailMaterial } from '../view/materials';
import { buildRail } from '../geom/rail';
import { RAIL_RADIUS, type RailPiece, SIDE_SPIRAL_SCREW, SPIRAL_RADIUS, SPIRAL_SCREW, advance, type RailState } from '../model/rail';
import { Bounds, V3, boundsOf, duplicate, elemBounds, expandGroups, groupElems, mergeBoxes, rotateWorld, splitBox, translateElem, ungroupElems, uprightElem } from './ops';
import { type M3, I3, apply, fromQuat, mul, rotAxis, rotZ } from './xform';
import { zoneTris } from './export';
import { initTooltips } from '../view/tooltip';
import { initHelp } from './help';
import { MoveGizmo, RotateGizmo } from '../view/move-gizmo';
import { stretchUV } from '../view/uvstretch';
import { cutBoxes } from '../view/clipmesh';
import { SCENES } from './scenes';
import { decodeShare, encodeShare } from './share';
import { type MapEntry, listMaps, newMapId, putMap, removeMap, renameMap } from './maps';
import { ASSET_INFO, assetInfo } from './asset-info';
import { ASSET_SNAP } from './asset-snap';
import { renderThumb, thumbnail } from '../view/thumbs';
import { setTextureLoadedCallback } from '../view/assets';
import { AXIS_COLORS, GRID_THEMES, createGrid, setGridAxes, themeGrid } from '../view/grid';
import { type P3, feats as featsRaw } from './snap';
import { solve, solveStats } from './solve';
import { type Route, edgeAt, routeLen, shortPath } from './guard';
import { guardFromRoute } from '../geom/railing';
import { DEFAULT_SETTINGS } from '../model/types';
/** 全图设置：文档里改过的项覆盖默认值 */
const mapSettings = (): MapSettings => ({ ...DEFAULT_SETTINGS, ...(doc.settings ?? {}) });
import { type Loop, pathAlong, project, projectNear } from '../model/outline';
import { exportBoxNmo, exportBoxScene } from './export';
import type { MapSettings } from '../model/types';
import {
  AssetElem, Box, DX, DY, Dir, Doc, Elem, Obj, PieceType, RailElem, SINK_DEPTH, Style, ZoneElem, anchorRects, baseSpec, boxTopAt, canTilt, dirToLocal, elemXf,
  footprint, isCheckpoint, isOriented, pieceLen, pivotOf, railPath, toLocal, toWorld, virtualCells, yawDeg,
  emptyDoc,
} from './types';

const host = document.getElementById('viewport')!;
const statusEl = document.getElementById('status')!;
const hintsEl = document.getElementById('hints')!;
const props = document.getElementById('props')!;
props.classList.add('fade');
const marqueeEl = document.getElementById('marquee')!;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);

// 按需渲染：画面没变就不画。下面这些都会要一帧：相机或画布变了、拖动 / 缓动 / 淡入进行中、刚有输入、场景重建、贴图加载完
let renderOnce = true, renderUntil = 0, renderCount = 0;
/** 要重画：下一帧画一次；ms 是接下来这段时间内每帧都画 */
function invalidate(ms = 0) {
  renderOnce = true;
  if (ms) renderUntil = Math.max(renderUntil, performance.now() + ms);
}
for (const t of ['pointerdown', 'pointerup', 'pointermove', 'wheel', 'keydown', 'keyup']) window.addEventListener(t, () => invalidate(300), { capture: true, passive: true });
for (const t of ['resize', 'focus']) window.addEventListener(t, () => invalidate(100));
document.addEventListener('visibilitychange', () => invalidate(100));
renderer.domElement.addEventListener('webglcontextrestored', () => invalidate(100));
THREE.DefaultLoadingManager.onProgress = () => invalidate(100);
host.appendChild(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1d2330);
const camera = new THREE.PerspectiveCamera(50, 1, 0.5, 4000);
camera.up.set(0, 0, 1);
camera.position.set(-20, -45, 45);
const controls = new OrbitControls(camera, renderer.domElement);
// 中键环视、Shift+中键平移（OrbitControls 自带：按着 Shift 的旋转键就是平移）；右键按住是漫游（见下面的 fly）
controls.mouseButtons = { LEFT: -1 as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: -1 as THREE.MOUSE };
controls.target.set(20, 10, 0);
controls.enableDamping = true;
// 滚轮缩放自己做，带缓动（每帧把相机到目标点的距离朝 zoomGoal 靠一部分）
controls.enableZoom = false;
let zoomGoal: number | null = null;
renderer.domElement.addEventListener('wheel', (e) => {
  e.preventDefault();
  const cur = zoomGoal ?? camera.position.distanceTo(controls.target);
  zoomGoal = THREE.MathUtils.clamp(cur * Math.exp(e.deltaY * 0.0012), 2, 3000);
}, { passive: false });
let lastFrame = performance.now();
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-0.4, -0.7, 1);
scene.add(sun);

const gridGroup = createGrid();
scene.add(gridGroup);

const world = new THREE.Group();
const overlay = new THREE.Group();
/** 选中物体的边框、包裹面、对准方块：拖动时跟着物体的缓动一起走 */
const selLayer = new THREE.Group();
scene.add(world, overlay, selLayer);

// ---------------- 状态 ----------------

// 帮助要在编辑器的键盘监听之前装上：开着时键盘留给它
initHelp(document.getElementById('help')!);
const STORE = 'bvm.box.doc';
/** 素材库默认的宽度（在两边时）和高度（在底部时） */
const LIB_W = 284, LIB_H = 236;
/** 本机偏好：素材库在哪一侧、格栅步长、机关显示方式、主题 */
/** 本机偏好，连同顶栏开关这些临时状态（格栅、对齐、小节、死亡区显示、漫游速度、素材库收起），刷新后保持 */
interface Prefs {
  side: 'left' | 'right' | 'bottom'; gridStep: number; modelView: boolean; theme: 'dark' | 'light'; tab: string;
  grid: boolean; align: boolean; sectors: boolean; sector: number; flySpeed: number; folded: boolean;
  /** 移动手柄（选中后的 X / Y / Z 箭头）一直显示：没设过时手机上开、电脑上关（关着时按住 Shift 临时显示） */
  gizmo: boolean | null;
  /** 护栏工具点一下放整条直边时，两头各往里缩多少 */
  guardInset: number;
  /** 自动追踪：点选时视图中心移到点中的东西上（只拉远不拉近），默认关；换过键名，之前存下的 follow / autoFollow 不沿用 */
  followPick: boolean;
  /** 改过的快捷键（只存和默认不同的） */
  keys: Record<string, string>;
  /** 设置弹窗上次看的那一页 */
  settingsPage: string;
  /** 坐标系（只影响显示和 X / Y / Z 按键，内部数据一直是 Z 朝上）：game = 游戏坐标系，Y 朝上；math = 数学坐标系，Z 朝上 */
  coordSys: 'game' | 'math';
  /** 素材库的宽度（在两边时）、高度（在底部时） */
  libW: number; libH: number;
  /** 显示死亡区（换了键名：之前默认隐藏时存下的 zones 不再沿用，默认显示） */
  zonesShown: boolean;
  skyShown: boolean;
  gridShown: boolean;
}
const prefs: Prefs = (() => {
  const d: Prefs = { keys: {}, settingsPage: 'map', side: 'right', gridStep: 1, modelView: true, theme: 'dark', tab: 'road', grid: false, align: true, sectors: false, sector: 1, zonesShown: true, skyShown: true, gridShown: true, flySpeed: 80, folded: false, followPick: false, coordSys: 'game', gizmo: null, guardInset: 1.5, libW: LIB_W, libH: LIB_H };
  try { return { ...d, ...JSON.parse(localStorage.getItem('bvm.box.prefs') ?? '{}') }; } catch { return d; }
})();
loadKeys(prefs.keys);
/**
 * 触摸屏界面：手机尺寸（横屏时高度、竖屏时宽度不超过 600）的触摸设备，平板和电脑不算。
 * 网址加 ?touch 可以在电脑上强制打开，方便调试。打开时 body 有 touch-ui 类（布局见 app.css）
 */
const TOUCH_MQ = matchMedia('(pointer: coarse) and (max-height: 600px), (pointer: coarse) and (max-width: 600px)');
const TOUCH_FORCED = new URLSearchParams(location.search).has('touch');
let touchUI = TOUCH_FORCED || TOUCH_MQ.matches;
document.body.classList.toggle('touch-ui', touchUI);
TOUCH_MQ.addEventListener('change', () => {
  touchUI = TOUCH_FORCED || TOUCH_MQ.matches;
  document.body.classList.toggle('touch-ui', touchUI);
  applySide(); updateStatus();
});
/** 触摸屏的框选开关：打开时单指在空白处拖是框选，关着是环视（按钮在文件末尾） */
let touchMarquee = false;
/** 手指按下时要做的单击操作：等手指抬起、确认没有变成拖动或双指才执行 */
let touchTap: { fn: () => void } | null = null;
/** 手机上正在拖着摆放的那根手指 */
let grabTouchId: number | null = null;
/** 鼠标立刻执行；手指等抬起（双指时第一根手指碰到开关不算数） */
const tapOr = (e: PointerEvent, fn: () => void) => { if (e.pointerType === 'touch') touchTap = { fn }; else fn(); };
/** 拉伸 / 坡面的按住键是 Ctrl、Alt 时，按着它直接拖（改绑成别的键后，Ctrl、Alt 不再有这个作用） */
const modBound = (id: string, e: { ctrlKey: boolean; altKey: boolean }) => { const k = keyOf(id); return (k === 'control' && e.ctrlKey) || (k === 'alt' && e.altKey); };
const stretchMod = (e: { ctrlKey: boolean; altKey: boolean }) => modBound('hold.stretch', e);
const slopeMod = (e: { ctrlKey: boolean; altKey: boolean }) => modBound('hold.slope', e);
/** 这次点选是加选：按着 Shift，或者手机上开着多选 */
const addPick = (e: PointerEvent) => e.shiftKey || (touchMarquee && e.pointerType === 'touch');
/**
 * 编辑模式（顶栏）：什么都不选是选择模式。点按钮或按数字键 1～6 是永久切换（蓝色），再点一次取消；
 * 按住 G / Ctrl / Alt / R / K / P 是临时切换（橙色），松开回到原来的模式。每个模式有自己的手柄（见文件末尾）。
 *   拉伸 = 一直按着 Ctrl，坡面 = 一直按着 Alt：拖法和按修饰键拖完全一样（modDrag）
 */
type Mode = 'move' | 'stretch' | 'slope' | 'rotate' | 'split' | 'pattern';
const MODES: Mode[] = ['move', 'stretch', 'slope', 'rotate', 'split', 'pattern'];
const MODE_NAME: Record<Mode, string> = { move: '移动', stretch: '拉伸', slope: '坡面', rotate: '旋转', split: '切分', pattern: '花纹' };
let permMode: Mode | null = null;
let tempMode: Mode | null = null;
const mode = (): Mode | null => tempMode ?? permMode;
/** 鼠标正停在哪个拉伸 / 坡面抓点上（「种类:坐标」） */
let handleHover: string | null = null;
/** 手指点的容差比鼠标大：场景里的小圆圈开关、护栏把手 */
const hitPx = (mouse: number) => (touchUI ? Math.max(mouse * 2, 24) : mouse);
const savePrefs = () => { try { localStorage.setItem('bvm.box.prefs', JSON.stringify(prefs)); } catch { /* 存不了就算了 */ } };
/** 按格栅步长取整 */
const snapG = (v: number) => Math.round(v / prefs.gridStep) * prefs.gridStep;
let doc: Doc = (() => { try { const s = localStorage.getItem(STORE); if (s) return JSON.parse(s) as Doc; } catch { /* 读不了就从空白开始 */ } return emptyDoc(); })();
let sel = new Set<number>();
let gridOn = prefs.grid;
let alignOn = prefs.align; // 自动对齐默认开着，格栅默认关着
/** 新放的机关归到第几小节（顶栏的下拉框；放盘点时自动切到它的小节） */
let placeSector = prefs.sector;
let showSectors = prefs.sectors;
let wireOn = false;
let modelView = prefs.modelView;
let vHeld = false;
let splitMode = false;
/** 护栏工具：点路面外沿放一整条直边的护栏，按住拖动沿外沿放一段 */
let guardMode = false;
/** 上一次的求解结果：外沿环（护栏用）是用到时才算的 */
let lastSolved: { loops: Loop[] } = { loops: [] };
let guardPreview: Route | null = null;
/** 护栏工具的拖动：从 s0 沿外沿拖；replace：正在拖某条护栏的端头 */
let guardDrag: { loop: number; s0: number; a: P3; replace?: number; moved: boolean } | null = null;
let splitAxis: 0 | 1 | null = null; // null：按路面较长的方向自动选
const undo: string[] = [];
// 当前地图在历史里的记录：编辑后过一会儿自动存（第一次打开、没动过的图不存）
const UNNAMED = '未命名地图';
const MAP_ID = 'bvm.box.mapId';
let mapId = (() => { try { return localStorage.getItem(MAP_ID); } catch { return null; } })() ?? newMapId();
try { localStorage.setItem(MAP_ID, mapId); } catch { /* 存不了就算了 */ }
/** 这张图换进来时的内容；没改过就不进历史。null：不管改没改都存 */
let cleanDoc: string | null = JSON.stringify(emptyDoc());
let mapTimer = 0;
async function flushMap() {
  clearTimeout(mapTimer);
  const id = mapId, json = JSON.stringify(doc), name = doc.name ?? '', count = Object.keys(doc.elems).length;
  if (!count || json === cleanDoc) return;
  const code = await encodeShare(doc);
  if (!putMap(localStorage, { id, name, code, count, updated: Date.now() })) flash('浏览器存储满了，历史地图没存上，删掉几张吧', true);
}
const scheduleMap = () => { clearTimeout(mapTimer); mapTimer = window.setTimeout(() => void flushMap(), 800); };
const mapNameEl = document.getElementById('map-name') as HTMLInputElement;
const syncMapName = () => { mapNameEl.value = doc.name ?? ''; };
function setMapName(name: string) {
  if (name) doc.name = name; else delete doc.name;
  syncMapName();
  cleanDoc = null;
  save();
}
mapNameEl.addEventListener('change', () => { setMapName(mapNameEl.value.trim()); renameMap(localStorage, mapId, doc.name ?? ''); });
mapNameEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === 'Escape') mapNameEl.blur(); });
syncMapName();
const redo: string[] = [];
const snapshot = () => { undo.push(JSON.stringify(doc)); redo.length = 0; if (undo.length > 200) undo.shift(); };
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(doc)); } catch { /* 存不了就算了 */ } scheduleMap(); };

/** 提示消息：顶栏下方居中，新的排在下面，最多同时三条；同样的话连着说只把时间续上，轻轻跳一下 */
const toastHost = document.createElement('div');
toastHost.id = 'toasts';
document.getElementById('viewport')!.appendChild(toastHost);
const toasts: { el: HTMLDivElement; text: string; timer: number }[] = [];
function dropToast(t: (typeof toasts)[number]) {
  toasts.splice(toasts.indexOf(t), 1);
  clearTimeout(t.timer);
  // 先把高度定住再收起来，下面的消息跟着平滑上移
  t.el.style.height = `${t.el.offsetHeight}px`;
  void t.el.offsetHeight;
  t.el.classList.add('leave');
  setTimeout(() => t.el.remove(), 220);
}
function flash(text: string, warn = false) {
  const ms = warn ? 4000 : 2600;
  const same = toasts.find((t) => t.text === text);
  if (same) {
    clearTimeout(same.timer);
    same.timer = window.setTimeout(() => dropToast(same), ms);
    same.el.classList.remove('bump');
    void same.el.offsetWidth; // 重新触发动画
    same.el.classList.add('bump');
    return;
  }
  const el = document.createElement('div');
  el.className = `toast${warn ? ' warn' : ''}`;
  el.textContent = text;
  toastHost.appendChild(el);
  const t = { el, text, timer: 0 };
  t.timer = window.setTimeout(() => dropToast(t), ms);
  toasts.push(t);
  if (toasts.length > 3) dropToast(toasts[0]);
}

// ---------------- 渲染 ----------------

let pickables: THREE.Object3D[] = [];
const lastSolve = { ms: 0, tris: 0 };
const objBoxes = new Map<number, THREE.Box3>();

/** 转过的元素：网格按元素自己的坐标摆好，再整体套上元素 → 世界的变换 */
function xfGroup(e: Elem): THREE.Group {
  const g = new THREE.Group();
  if (isOriented(e) && (e.ang || e.q)) {
    const { m, t } = elemXf(e);
    g.matrixAutoUpdate = false;
    g.matrix.set(m[0], m[1], m[2], t[0], m[3], m[4], m[5], t[1], m[6], m[7], m[8], t[2], 0, 0, 0, 1);
  }
  return g;
}
/** 死亡区是否显示（顶栏的开关；导出时总是隐藏） */
let zonesOn = prefs.zonesShown; // 死亡区默认显示
let skyOn = prefs.skyShown; // 云层默认显示
const isSky = (e: Elem) => e.kind === 'asset' && !!assetInfo(e.name)?.sky;
/** 顶栏关掉显示的东西：不画、不能选、不参与吸附 */
const hiddenElem = (e: Elem) => (e.kind === 'zone' && !zonesOn) || (!skyOn && isSky(e));
const ZONE_MAT = new THREE.MeshBasicMaterial({ color: 0xff4040, transparent: true, opacity: 0.12, depthWrite: false, side: THREE.DoubleSide });
const ZONE_EDGE = new THREE.LineBasicMaterial({ color: 0xff6a6a, transparent: true, opacity: 0.85 });

/** 灯塔 / 柱子的长柱子：只做视觉效果，选不到，F 聚焦、包围盒都不算它 */
const COLUMN_PARTS = new Set(['Colums_blue', 'Colums_beige', 'Columns_beige_fade']);
function addMeshes(group: THREE.Group, pieces: AssetPiece[], id: number, place: (m: THREE.Mesh) => void) {
  for (const pc of pieces) {
    const mesh = new THREE.Mesh(pc.geometry, pc.material);
    place(mesh);
    mesh.userData.id = id;
    mesh.updateMatrixWorld();
    group.add(mesh);
    if (pc.name && COLUMN_PARTS.has(pc.name)) mesh.userData.visualOnly = true;
    else pickables.push(mesh);
  }
}
/** 拉伸过的木制件：UV 补偿成平铺（贴图重复，不被拉长）；按模型名 + 缩放缓存 */
const stretchCache = new Map<string, AssetPiece[]>();
function stretchedPieces(name: string, pieces: AssetPiece[], s: [number, number]): AssetPiece[] {
  if (!pieces.length) return pieces; // 模型还没加载好：别把空的缓存起来
  const key = `${name}@${s[0]},${s[1]}`;
  let hit = stretchCache.get(key);
  if (!hit) {
    hit = pieces.map((pc) => {
      const g = pc.geometry.clone();
      const pos = g.getAttribute('position'), uv = g.getAttribute('uv');
      if (uv) g.setAttribute('uv', new THREE.BufferAttribute(stretchUV(pos.array, uv.array, s[0], s[1]), 2));
      return { ...pc, geometry: g };
    });
    if (stretchCache.size > 64) stretchCache.clear();
    stretchCache.set(key, hit);
  }
  return hit;
}
/** 盘点路面裁掉延伸路：按模型名 + 裁剪范围缓存 */
const cropCache = new Map<string, AssetPiece[]>();
function croppedPieces(name: string, pieces: AssetPiece[], c: [number, number, number, number][]): AssetPiece[] {
  const key = `${name}#${JSON.stringify(c)}`;
  let hit = cropCache.get(key);
  if (!hit) {
    hit = pieces.map((pc) => {
      const g = pc.geometry.index ? pc.geometry.toNonIndexed() : pc.geometry;
      const pa = g.getAttribute('position'), n = g.getAttribute('normal'), t = g.getAttribute('uv');
      const r = cutBoxes({ pos: Array.from(pa.array), uv: t ? Array.from(t.array) : new Array(pa.count * 2).fill(0), nrm: n ? Array.from(n.array) : undefined }, c);
      const out = new THREE.BufferGeometry();
      out.setAttribute('position', new THREE.Float32BufferAttribute(r.pos, 3));
      out.setAttribute('uv', new THREE.Float32BufferAttribute(r.uv, 2));
      if (r.nrm) out.setAttribute('normal', new THREE.Float32BufferAttribute(r.nrm, 3)); else out.computeVertexNormals();
      return { ...pc, geometry: out };
    });
    cropCache.set(key, hit);
  }
  return hit;
}
/** 一组网格的包围盒，不算只做视觉效果的部分 */
function solidBox(g: THREE.Object3D): THREE.Box3 {
  g.updateMatrixWorld(true);
  const b = new THREE.Box3();
  g.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !m.userData.visualOnly) b.expandByObject(m); });
  return b;
}
/** 看不见、只用来点选的方块（柱子整根都是视觉效果，靠顶上那一格选中它） */
const PROXY_MAT = new THREE.MeshBasicMaterial({ visible: false });

/** 清掉上一次生成的网格（资产库模型的几何体是共用的，不能释放） */
function clearWorld() {
  // keep：路面网格按签名缓存，下一次没变就接着用，不在这里释放（换掉时再释放）
  world.traverse((o) => { if ((o as THREE.Mesh).geometry && o.userData.own && !o.userData.keep) (o as THREE.Mesh).geometry.dispose(); });
  world.clear();
}
/** 路面网格缓存：求解结果的签名（加上切分线开关）→ 上次生成的 three.js 组 */
let floorGroups = new Map<string, THREE.Group>();

/** 每个元素的网格组（拖动时直接平移它们，不用每次都重算整张图） */
const elemGroups = new Map<number, THREE.Group[]>();
const addGroup = (id: number, g: THREE.Group) => { world.add(g); const l = elemGroups.get(id); if (l) l.push(g); else elemGroups.set(id, [g]); };

/** 拖动中：鼠标事件只改文档，每帧画之前重算一次（一帧里来几个事件也只算一次），画面始终是最新的状态 */
let rebuildWanted = false;

let rebuildCount = 0;
const rebuildTimes: number[] = [];
function rebuild() {
  const tStart = performance.now();
  rebuildInner();
  rebuildTimes.push(performance.now() - tStart);
  if (rebuildTimes.length > 200) rebuildTimes.shift();
}
const featsCache = new Map<number, { e: Elem; f: ReturnType<typeof featsRaw>; b: Bounds }>();
function cached(e: Elem) {
  let c = featsCache.get(e.id);
  if (!c || c.e !== e) { c = { e, f: featsRaw(e), b: elemBounds(e) }; featsCache.set(e.id, c); }
  return c;
}
/** 元素的吸附点（顶点、边中点、边）：元素对象没变就用缓存 */
const feats = (e: Elem) => cached(e).f;
function rebuildInner() {
  featsCache.clear();
  rebuildCount++;
  rebuildWanted = false;
  clearWorld();
  elemGroups.clear();
  pickables = [];
  objBoxes.clear();
  const t0 = performance.now();
  const solved = solve(doc);
  lastSolved = solved;
  lastSolve.ms = performance.now() - t0;
  let tris = 0;
  const usedGroups = new Map<string, THREE.Group>();
  for (const m of solved.meshes.values()) {
    const ownerId = doc.elems[m.id] ? m.id : solved.owner.get(m.id) ?? m.id;
    const gk = m.sig ? `${m.sig}|${wireOn}` : null;
    const reuse = gk ? floorGroups.get(gk) : undefined;
    if (reuse && gk) {
      // 网格没变：直接沿用（拖动时大部分路面都是这样，省掉重新建几何体）
      usedGroups.set(gk, reuse);
      reuse.position.set(0, 0, 0);
      reuse.traverse((o) => { if ((o as THREE.Mesh).isMesh) { pickables.push(o); tris += ((o as THREE.Mesh).geometry.getAttribute('position').count) / 3; } });
      addGroup(ownerId, reuse);
      continue;
    }
    const g = new THREE.Group();
    // 连通的一片路面是一个网格：记下它包含哪些元素（拖动的缓动只在它们全都在动时才挪这个网格）
    const owners = new Set<number>();
    for (const [mat, part] of Object.entries(m.parts) as [MatName, { pos: number[]; uv: number[]; own?: number[] }][]) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(part.uv, 2));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, getMaterial(mat));
      mesh.userData.own = true;
      if (gk) mesh.userData.keep = true;
      // 自动生成的转换件属于它嵌进去的那块路面
      mesh.userData.id = doc.elems[m.id] ? m.id : solved.owner.get(m.id) ?? m.id;
      // 每个三角形属于哪个元素：点选时按点中的三角形分出是哪一块路面
      if (part.own) { mesh.userData.faceOwner = part.own; for (const o of part.own) owners.add(o); }
      g.add(mesh);
      pickables.push(mesh);
      tris += part.pos.length / 9;
      if (wireOn) { const w = new THREE.LineSegments(new THREE.WireframeGeometry(geo), WIRE_MAT); w.userData.own = true; g.add(w); }
    }
    if (owners.size > 1) g.userData.owners = owners;
    if (gk) { g.traverse((o) => { o.userData.keep = true; }); usedGroups.set(gk, g); }
    addGroup(ownerId, g);
  }
  // 这次没用上的缓存网格：释放
  for (const [k, g] of floorGroups) if (!usedGroups.has(k)) g.traverse((o) => { const me = o as THREE.Mesh; if (me.geometry) me.geometry.dispose(); });
  floorGroups = usedGroups;
  lastSolve.tris = tris;
  // 专属路块、盘点路面（资产库模型 + 火焰 / 重生点占位符）
  for (const [id, parts] of solved.assets) {
    const g = new THREE.Group();
    for (const part of parts) {
      const raw = getAsset(part.kind, part.name) ?? (part.kind === 'asset' ? [fallbackBox(5, 5, 5)] : []);
      const pieces = part.crop && raw.length && getAsset(part.kind, part.name) ? croppedPieces(part.name, raw, part.crop) : raw;
      addMeshes(g, pieces, id, (m) => { m.position.set(...part.pos); m.rotation.z = (part.rotZ * Math.PI) / 180; });
    }
    addGroup(id, g);
    if (doc.elems[id]?.kind === 'piece' && g.children.length) objBoxes.set(id, new THREE.Box3().setFromObject(g));
  }
  // 特殊路面（资产库模型）
  for (const e of Object.values(doc.elems)) {
    if (e.kind !== 'asset' || hiddenElem(e)) continue;
    const g = new THREE.Group(), xg = xfGroup(e);
    g.add(xg);
    const pieces = getAsset('asset', e.name) ?? [];
    addMeshes(xg, e.scale ? stretchedPieces(e.name, pieces, e.scale) : pieces, e.id, (m) => { m.position.set(e.x, e.y, e.z); m.rotation.z = (e.rot * Math.PI) / 2; if (e.scale) m.scale.set(e.scale[0], e.scale[1], 1); });
    addGroup(e.id, g);
    if (g.children.length) objBoxes.set(e.id, new THREE.Box3().setFromObject(g));
  }
  // 机关、装饰、挡块
  for (const e of Object.values(doc.elems)) {
    if (e.kind !== 'obj') continue;
    const outer = new THREE.Group(), g = xfGroup(e);
    outer.add(g);
    const t = objType(e.type);
    const deg = e.rot * 90;
    const fake = t?.cat === 'module' && modelView ? fakeModel(e.type) : null;
    const fakePieces = fake ? getAsset('fake', fake) : null;
    const pieces = fakePieces ?? getAsset(t?.cat === 'deco' ? 'asset' : 'element', e.type) ?? [];
    const fix = (fakePieces && FAKE_FIX[fake!]) || {};
    const r = (deg * Math.PI) / 180, fx = fix.dx ?? 0, fy = fix.dy ?? 0;
    addMeshes(g, pieces, e.id, (m) => {
      m.position.set(e.x + fx * Math.cos(r) - fy * Math.sin(r), e.y + fx * Math.sin(r) + fy * Math.cos(r), e.z + (fix.dz ?? 0));
      m.rotation.order = 'ZYX';
      m.rotation.y = ((fix.pitch ?? 0) * Math.PI) / 180;
      m.rotation.z = ((deg + (fix.rot ?? 0)) * Math.PI) / 180;
    });
    // 一起显示的附加模型（终点飞船前面的软木桥）：只显示，不导出
    if (fakePieces) for (const ex of FAKE_EXTRA[fake!] ?? []) {
      addMeshes(g, getAsset('fake', ex.name) ?? [], e.id, (m) => {
        m.position.set(e.x + ex.dx * Math.cos(r) - ex.dy * Math.sin(r), e.y + ex.dx * Math.sin(r) + ex.dy * Math.cos(r), e.z + ex.dz);
        m.rotation.z = r;
      });
    }
    const st = e.noStopper || e.q ? null : stopperMesh({ id: 0, cat: 'module', type: e.type, x: e.x, y: e.y, z: e.z, rot: deg, stopOff: e.stopOff });
    if (st) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(st.pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(st.uv, 2));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, getStopperMaterial());
      mesh.userData.id = e.id;
      mesh.userData.own = true;
      g.add(mesh);
      pickables.push(mesh);
    }
    // 整个模型都只是柱子（柱子（支撑））：用顶上对准的那一格当点选的方块
    if (g.children.length && g.children.every((c) => c.userData.visualOnly)) {
      for (const a of anchorRects(e)) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(a.x1 - a.x0, a.y1 - a.y0, a.depth), PROXY_MAT);
        m.position.set((a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2, a.top - a.depth / 2);
        m.userData.id = e.id;
        m.userData.own = true;
        g.add(m);
        pickables.push(m);
      }
    }
    addGroup(e.id, outer);
    const sb = solidBox(outer);
    if (!sb.isEmpty()) objBoxes.set(e.id, sb);
  }
  // 死亡区：半透明的红色长方体（顶栏可以一键隐藏）
  if (zonesOn) for (const e of Object.values(doc.elems)) {
    if (e.kind !== 'zone') continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(zoneTris(e), 3));
    const mesh = new THREE.Mesh(geo, ZONE_MAT);
    mesh.userData.id = e.id;
    mesh.userData.own = true;
    mesh.renderOrder = 2;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), ZONE_EDGE);
    edges.userData.own = true;
    const g = new THREE.Group();
    g.add(mesh, edges);
    pickables.push(mesh);
    addGroup(e.id, g);
  }
  // 护栏：钢管 + 两头的铆钉
  for (const e of Object.values(doc.elems)) {
    if (e.kind !== 'guard') continue;
    const gm = guardFromRoute({ pts: e.pts, outs: e.outs }, mapSettings());
    if (!gm) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(gm.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(gm.nrm, 3));
    const mesh = new THREE.Mesh(geo, getRailMaterial());
    mesh.userData.id = e.id;
    mesh.userData.own = true;
    const g = new THREE.Group();
    g.add(mesh);
    pickables.push(mesh);
    for (const n of gm.nails) addMeshes(g, getAsset('asset', n.name) ?? [], e.id, (m) => { m.position.set(...n.pos); m.rotation.z = (n.rotZ * Math.PI) / 180; });
    addGroup(e.id, g);
    objBoxes.set(e.id, new THREE.Box3().setFromObject(g));
  }
  // 钢轨
  for (const e of Object.values(doc.elems)) {
    if (e.kind !== 'rail') continue;
    const rm = buildRail(e, mapSettings().guardPostDepth);
    if (!rm.pos.length) continue;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(rm.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(rm.nrm, 3));
    const mesh = new THREE.Mesh(geo, getRailMaterial());
    mesh.userData.id = e.id;
    mesh.userData.own = true;
    const g = new THREE.Group();
    g.add(mesh);
    pickables.push(mesh);
    addGroup(e.id, g);
    objBoxes.set(e.id, new THREE.Box3().setFromObject(g));
  }
  if (!drag) save();
  syncSectorLabels();
  drawOverlay();
  updateStatus();
  if (!drag) syncProps(); // 拖动中不重写属性面板，松手时再更新
}
const WIRE_MAT = new THREE.LineBasicMaterial({ color: 0x00e0ff, transparent: true, opacity: 0.45 });
// 模型是一个个异步加载的：同一帧里加载完的合并成一次重建，不要每来一个就把整张图重算一遍
let assetRebuild = 0;
setAssetLoadedCallback(() => { if (!assetRebuild) assetRebuild = requestAnimationFrame(() => { assetRebuild = 0; if (!drag) rebuild(); }); });

// ---------------- 状态栏 ----------------

let dragInfo = '';
/**
 * 拖动的缓动与磁吸：鼠标给出原始值 raw，能吸附时给出吸附值 snap。
 *   画面上的值 val 每帧朝 goal 走一部分（EASE，缓动）；
 *   能吸附时 goal = snap + (raw - snap) × MAGNET：物体被轻轻吸向标准点，鼠标在附近小幅晃动时物体基本停在标准点上；
 *   松手时落到 final（能吸附就是 snap，正好对准）。所有拖动（移动、沿轴、改高度、V 吸附、改尺寸、拉坡、拖放）都走这一套。
 */
/**
 * 底层（文档、花纹求解）只认最终值 final：吸附住以后鼠标再怎么小幅晃动，final 不变，就不重算、花纹也不变；
 * 缓动只是画面上的：平移类拖动把这些元素的网格整体挪 (val - final)；改形状的拖动（改尺寸、拉坡）只让选中框缓动。
 */
interface Anim {
  val: number[]; goal: number[]; final: number[]; applied: number[] | null;
  apply: (v: number[]) => void;
  /** 平移类拖动：跟着缓动平移网格的元素 */
  ids?: Set<number>;
  /** 改形状的拖动：画面值 val 对应的形状（画选中框用） */
  preview?: (v: number[]) => Elem[];
}
let anim: Anim | null = null;
/** 当前是否处在吸附范围内（选中框变成绿色） */
let snapping = false;
const EASE = 0.35;
const MAGNET = 0.22;
function drive(raw: number[], snap: number[] | null, apply: (v: number[]) => void, init: number[], opt: { ids?: Set<number>; preview?: (v: number[]) => Elem[] } = {}) {
  const goal = snap ? snap.map((v, i) => v + (raw[i] - v) * MAGNET) : raw;
  const final = snap ?? raw;
  if (!anim) anim = { val: [...init], goal, final, applied: null, apply, ...opt };
  else Object.assign(anim, { goal, final, apply, ...opt });
  if (snapping !== !!snap) { snapping = !!snap; drawOverlay(); }
  // 最终值变了才改文档、重算花纹
  if (!anim.applied || anim.applied.some((v, i) => Math.abs(v - final[i]) > 1e-9)) {
    anim.apply(final);
    anim.applied = [...final];
    rebuildWanted = true;
  }
}
let lastStatus = '';
let lastHints = '';
type Hint = { keys: string[]; label: string };
const MOUSE: Record<string, string> = { LMB: 'l', MMB: 'm', RMB: 'r', Wheel: 'm' };
const mouseIcon = (b: string) => {
  const fill = (k: string) => (MOUSE[b] === k ? 'currentColor' : 'none');
  return `<svg class="mouse" viewBox="0 0 10 14" width="10" height="14"><rect x="0.6" y="0.6" width="8.8" height="12.8" rx="4.4" fill="none" stroke="currentColor" stroke-width="1"/>`
    + `<path d="M5 0.6 V5.5" stroke="currentColor" stroke-width="0.8"/>`
    + `<path d="M5 0.6 A4.4 4.4 0 0 0 0.6 5 V5.5 H5 Z" fill="${fill('l')}" opacity="0.9"/>`
    + `<path d="M5 0.6 A4.4 4.4 0 0 1 9.4 5 V5.5 H5 Z" fill="${fill('r')}" opacity="0.9"/>`
    + (b === 'MMB' || b === 'Wheel' ? '<rect x="4" y="2" width="2" height="3" rx="1" fill="currentColor"/>' : '')
    + '</svg>';
};
const keyHtml = (k: string) => (k in MOUSE ? mouseIcon(k) : `<kbd>${k}</kbd>`);
/** 当前情况下的按键提示（Blender 式） */
function currentHints(): Hint[] {
  const H = (keys: string[], label: string): Hint => ({ keys, label });
  const K = keysOf;
  if (touchUI) {
    // 手机：只提示手势，没有键盘和鼠标
    const t = drag?.t;
    if (t === 'marquee') return [H(['拖动'], '框选范围'), H(['松手'], '完成框选')];
    if (t === 'place') return [H(['拖动'], '摆放位置'), H(['松手'], '放下')];
    if (drag?.t === 'grab' && !drag.gz) return [H(['单指拖'], '移动'), H(['轻点'], '放下'), H(['双指'], '平移 / 缩放')];
    if (drag?.t === 'rotate' && !drag.gz) return [H(['轻点'], '确定')];
    if (t && t !== 'click') {
      const what = t === 'grab' || t === 'vsnap' ? '移动' : t === 'rotate' ? '旋转' : t === 'thick' ? '改厚度' : t === 'tilt' || t === 'railTilt' ? '拉坡' : '改尺寸';
      return [H(['拖动'], what), H(['松手'], '完成')];
    }
    if (guardMode) return [H(['轻点路边'], '放整条直边'), H(['沿路边拖'], '放一段'), H(['拖把手'], '改长度'), H(['护栏按钮'], '退出')];
    if (splitMode) return [H(['轻点路面'], '切开'), H(['切分按钮'], '退出')];
    const m = mode();
    return [H(['单指拖'], touchMarquee ? '框选' : '环视'), ...(touchMarquee ? [] : [H(['长按再拖'], '框选')]), H(['双指'], '平移 / 缩放'), H(['轻点'], touchMarquee ? '加选 / 减选' : '选中'), ...(m ? [H([MODE_NAME[m]], modeHint(m))] : [])];
  }
  if (drag?.t === 'place') return [H(['LMB'], '松开放下'), H(K('hold.rotate'), '旋转'), H(['RMB'], '取消')];
  if (drag?.t === 'grab') {
    const d = drag;
    const lock = d.axis !== null ? `沿 ${AXIS_NAME[d.axis]}` : d.excl !== null ? `排除 ${AXIS_NAME[d.excl]}` : '水平';
    return [H(['LMB'], '确定'), H(['RMB'], '取消'), H(['X', 'Y', 'Z'], `限制轴向（${lock}）`), H(['Shift', 'X'], '排除轴'), H(K('vsnap'), '吸附顶点'), H(['0'], d.num ? `输入 ${d.num}` : '输入距离'), H(K('align'), alignOn ? '对齐：开' : '对齐：关')];
  }
  if (drag?.t === 'rotate') {
    const d = drag;
    return [H(['LMB'], '确定'), H(['RMB'], '取消'), H(['X', 'Y', 'Z'], `换轴（绕 ${AXIS_NAME[d.axis]}）`), H(['Ctrl'], alignOn ? '按住自由旋转' : '按住每 15° 吸附'), H(K('align'), alignOn ? '对齐：开（每 15°）' : '对齐：关'), H(['0'], d.num ? `输入 ${d.num}°` : '输入角度')];
  }
  if (fly) return [H([...K('fly.forward'), ...K('fly.left'), ...K('fly.back'), ...K('fly.right')], '移动'), H(K('fly.up'), '上升'), H(K('fly.down'), '下降'), H(['Wheel'], `速度 ${fly.speed.toFixed(0)}`), H(['RMB'], '松开退出漫游')];
  if (drag) return [H(['LMB'], '松开完成'), H(K('grid'), gridOn ? '格栅：开' : '格栅：关'), H(K('align'), alignOn ? '对齐：开' : '对齐：关')];
  if (guardMode) return [H(['LMB'], '点路边：放整条直边'), H(['LMB'], '沿路边拖：放一段'), H(['LMB'], '拖把手：改长度'), H(['Esc'], '退出')];
  if (splitMode) return [H(['LMB'], '在鼠标处切开'), H(K('split.dir'), '换方向'), H(['RMB'], '退出'), H(['Esc'], '退出')];
  if (vHeld) return [H([...K('vsnap'), 'LMB'], '抓住顶点 / 边中点拖到别的物体上吸附')];
  const hs = [H(['MMB'], '环视'), H(['Shift', 'MMB'], '平移'), H(['RMB'], '漫游'), H(['Wheel'], '缩放')];
  const m = mode();
  if (m) return [...hs, H(['LMB'], modeHint(m))];
  if (sel.size) hs.push(H(K('focus'), '聚焦'), H(K('dup'), '复制'), H(K('delete'), '删除'));
  else hs.push(H(['LMB'], '点选 / 框选'), H(['Shift', 'LMB'], '加选'), H(K('focus'), '看全部'));
  return hs;
}
/** 手机上切分没有 Tab 和右键，提示换成手势 */
const modeHint = (m: Mode) => (touchUI && m === 'split' ? '点路面切开，再点一次按钮退出' : MODE_HINT[m].replace('Tab', keyText('split.dir')));
/** 每个编辑模式在状态栏上的一句话 */
const MODE_HINT: Record<Mode, string> = {
  move: '拖东西或箭头：移动',
  stretch: '拖蓝色方块或路面的边：改尺寸；拖橙色方块或侧面下半截：改厚度',
  slope: '拖边上的圆圈：上下拉成坡',
  rotate: '拖圆环：绕那根轴转，拖东西：绕竖直轴转',
  split: '点路面：在鼠标处切开（Tab 换方向，右键退出）',
  pattern: '点边上的圆圈：自动 / 开口 / 封口；点挡块上的圆圈：开关挡块',
};
/** 顶栏的编辑按钮：只有选中的东西能做这件事时才亮 */
function syncOps() {
  const es = [...sel].map((id) => doc.elems[id]).filter(Boolean);
  const set = (id: string, on: boolean) => { (document.getElementById(id) as HTMLButtonElement).disabled = !on; };
  set('merge', es.length >= 2 && es.every((e) => e.kind === 'box' && !e.slope && e.style === (es[0] as Box).style));
  set('group', es.length >= 2 && !(es.every((e) => e.group !== undefined && e.group === es[0].group)));
  set('ungroup', es.some((e) => e.group !== undefined));
  for (const id of ['dup', 'rot', 'del']) set(id, es.length > 0);
}
// ---- 小节（和上一版一样：顶栏选当前小节，新放的机关归到这个小节；不自动推断）----
const checksSorted = () => Object.values(doc.elems).filter((e): e is Extract<Elem, { kind: 'piece' }> => e.kind === 'piece' && e.type === 'check').sort((a, b) => a.id - b.id);
const sectorCount = () => 1 + checksSorted().length;
const sectorOfCheck = (id: number) => { const c = checksSorted(); const p = c.find((x) => x.id === id); return p?.sector ?? c.indexOf(p!) + 2; };
const sectorBtn = document.getElementById('sector')!, sectorMenu = document.getElementById('sector-menu')!, sectorEye = document.getElementById('sector-eye')!;
let lastSectorKey = '';
function syncSector() {
  const n = sectorCount();
  if (placeSector > n) placeSector = n;
  const key = `${n}:${placeSector}`;
  if (key === lastSectorKey) return;
  lastSectorKey = key;
  document.getElementById('sector-label')!.textContent = `第 ${placeSector} 小节`;
  if (prefs.sector !== placeSector) { prefs.sector = placeSector; savePrefs(); }
  sectorMenu.innerHTML = Array.from({ length: n }, (_, i) => `<button data-s="${i + 1}" class="${i + 1 === placeSector ? 'on' : ''}"><span>第 ${i + 1} 小节</span><small>${i === 0 ? '从起点开始' : `从第 ${i} 个盘点开始`}</small></button>`).join('');
}
sectorBtn.addEventListener('click', (e) => { e.stopPropagation(); sectorMenu.classList.toggle('open'); sectorBtn.blur(); });
sectorMenu.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>('button[data-s]');
  if (!b) return;
  placeSector = +b.dataset.s!;
  // 选中了机关时，顺便把它们改到这个小节
  const mods = [...sel].map((id) => doc.elems[id]).filter((x): x is Obj => x?.kind === 'obj' && objType(x.type)?.cat === 'module' && x.type !== 'PE_Balloon');
  if (mods.length) { snapshot(); for (const o of mods) o.sector = placeSector; flash(`已把 ${mods.length} 个机关改到第 ${placeSector} 小节`); rebuild(); }
  sectorMenu.classList.remove('open');
  syncSector();
});
window.addEventListener('pointerdown', (e) => { if (!sectorMenu.contains(e.target as Node) && !sectorBtn.contains(e.target as Node)) sectorMenu.classList.remove('open'); });
sectorEye.addEventListener('click', () => { showSectors = !showSectors; prefs.sectors = showSectors; savePrefs(); sectorEye.classList.toggle('active', showSectors); sectorEye.blur(); syncSectorLabels(); });
sectorEye.classList.toggle('active', showSectors);
// 死亡区：一键显示 / 隐藏（隐藏时也选不到它们）
const viewBtn = document.getElementById('view-btn')!;
/** 东西隐藏着还要放：让顶栏的「显示」闪几下 */
function viewAttn() {
  viewBtn.classList.remove('attn');
  void viewBtn.offsetWidth; // 重新触发动画
  viewBtn.classList.add('attn');
}
const gridEye = document.getElementById('grid-eye')!;
gridGroup.visible = prefs.gridShown;
gridEye.classList.toggle('active', prefs.gridShown);
gridEye.addEventListener('click', () => {
  prefs.gridShown = gridGroup.visible = !gridGroup.visible; savePrefs();
  gridEye.classList.toggle('active', prefs.gridShown);
  gridEye.blur();
});
const zoneEye = document.getElementById('zone-eye')!;
zoneEye.classList.toggle('active', zonesOn);
zoneEye.addEventListener('click', () => {
  viewBtn.classList.remove('attn');
  zonesOn = !zonesOn;
  prefs.zonesShown = zonesOn; savePrefs();
  zoneEye.classList.toggle('active', zonesOn);
  zoneEye.blur();
  if (!zonesOn) for (const id of [...sel]) if (doc.elems[id]?.kind === 'zone') sel.delete(id);
  flash(zonesOn ? '显示死亡区' : '隐藏死亡区（导出时总是隐藏）');
  rebuild();
});
const skyEye = document.getElementById('sky-eye')!;
skyEye.classList.toggle('active', skyOn);
skyEye.addEventListener('click', () => {
  viewBtn.classList.remove('attn');
  skyOn = !skyOn;
  prefs.skyShown = skyOn; savePrefs();
  skyEye.classList.toggle('active', skyOn);
  skyEye.blur();
  if (!skyOn) for (const id of [...sel]) if (isSky(doc.elems[id])) sel.delete(id);
  flash(skyOn ? '显示云层' : '隐藏云层（导出时总是显示）');
  rebuild();
});
/** 机关上的小节编号（顶栏的「小节」打开时显示）：起点是 1，小节盘点是过了它进入的小节，终点气球显示「终点」 */
const secLabels = new Map<number, HTMLDivElement>();
function syncSectorLabels() {
  const live = new Set<number>();
  if (showSectors) for (const e of Object.values(doc.elems)) {
    const text = isCheckpoint(e) ? String(e.kind === 'piece' && e.type === 'start' ? 1 : sectorOfCheck(e.id))
      : e.kind !== 'obj' || objType(e.type)?.cat !== 'module' ? null
        : e.type === 'PE_Balloon' ? '终点' : String(Math.min(e.sector ?? 1, sectorCount()));
    if (text === null) continue;
    live.add(e.id);
    let l = secLabels.get(e.id);
    if (!l) { l = document.createElement('div'); l.className = 'sec-label fade'; document.body.appendChild(l); secLabels.set(e.id, l); requestAnimationFrame(() => l!.classList.add('shown')); }
    l.textContent = text;
  }
  for (const [id, l] of secLabels) if (!live.has(id)) { l.classList.remove('shown'); setTimeout(() => l.remove(), 160); secLabels.delete(id); }
}
function placeSectorLabels() {
  const r = host.getBoundingClientRect();
  for (const [id, l] of secLabels) {
    const e = doc.elems[id];
    if (!e) continue;
    const a = e.kind === 'obj' ? anchorRects(e)[0] : null;
    const p = new THREE.Vector3(...toWorld(e as Obj, [a ? (a.x0 + a.x1) / 2 : (e as Obj).x, a ? (a.y0 + a.y1) / 2 : (e as Obj).y, (a ? a.top : (e as Obj).z) + 4]));
    const v = p.clone().project(viewCam());
    const sx = (v.x + 1) / 2 * r.width + r.left, sy = (1 - v.y) / 2 * r.height + r.top;
    l.classList.toggle('shown', !(v.z > 1 || sx < r.left || sx > r.right || sy < r.top || sy > r.bottom));
    l.style.left = `${sx}px`; l.style.top = `${sy}px`;
  }
}
function updateStatus() {
  syncOps();
  syncMod();
  syncSector();
  const parts: string[] = [];
  if (dragInfo) parts.push(`<b>${dragInfo}</b>`);
  if (sel.size) {
    const b = boundsOf(doc, sel);
    parts.push(`选中 ${sel.size} 个 · ${fmt(b.x1 - b.x0)} × ${fmt(b.y1 - b.y0)} · 顶面 ${fmt(b.z1)}`);
  } else parts.push(`${Object.keys(doc.elems).length} 个元素`);
  const html = parts.join('　·　');
  if (html !== lastStatus) { statusEl.innerHTML = html; lastStatus = html; }
  const hs = currentHints().map((h) => `<span class="hint">${h.keys.map(keyHtml).join('')}<span>${h.label}</span></span>`).join('');
  if (hs !== lastHints) { hintsEl.innerHTML = hs; lastHints = hs; }
}
const fmt = (v: number) => String(+v.toFixed(3));
initTooltips();

// ---------------- 叠加层：选中框、吸附点、辅助面 ----------------

/** 吸附点的样式：圆点（顶点）、菱形（边中点）、圆环（边上的点） */
function spriteTex(shape: 'dot' | 'diamond' | 'ring'): THREE.Texture {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.lineWidth = 7;
  g.strokeStyle = 'rgba(12,16,26,0.95)';
  g.fillStyle = '#ffffff';
  g.beginPath();
  if (shape === 'diamond') { g.moveTo(32, 6); g.lineTo(58, 32); g.lineTo(32, 58); g.lineTo(6, 32); g.closePath(); g.fill(); g.stroke(); }
  else if (shape === 'dot') { g.arc(32, 32, 22, 0, Math.PI * 2); g.fill(); g.stroke(); }
  else { g.arc(32, 32, 20, 0, Math.PI * 2); g.lineWidth = 16; g.stroke(); g.lineWidth = 8; g.strokeStyle = '#ffffff'; g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
const TEX = { dot: spriteTex('dot'), diamond: spriteTex('diamond'), ring: spriteTex('ring') };
function marks(ps: P3[], shape: keyof typeof TEX, color: number, size: number, opacity = 1) {
  const g = new THREE.BufferGeometry().setFromPoints(ps.map((p) => new THREE.Vector3(...p)));
  const m = new THREE.Points(g, new THREE.PointsMaterial({ map: TEX[shape], color, size, sizeAttenuation: false, transparent: true, opacity, depthTest: false, alphaTest: 0.05 }));
  m.renderOrder = 10;
  return m;
}

/** 自动对齐的吸附距离（屏幕像素）：小一点，靠近了才轻轻贴上，免得拖起来一顿一顿的 */
const ALIGN_PX = 5;

/** 元素外形的 8 个角：顶面 4 个（x0y0、x1y0、x1y1、x0y1），再是底面 4 个；机关按模型的包围盒 */
/**
 * 钢轨的包围盒：按钢轨自己的朝向（倾斜的跟着转）把网格框起来，直轨就是贴着轨的长方体。
 * 拉坡的钢轨和拉坡的路面一样，方块跟着坡度错切：用网格拟合一个斜面 z = a·x + b·y，整圈以上的螺旋没有整体坡度，不错切
 */
function railCorners(e: RailElem): P3[] {
  const { pos } = buildRail(e, mapSettings().guardPostDepth);
  if (!pos.length) return [];
  const M = mul(e.q ? fromQuat(e.q) : I3, rotZ(e.heading));
  const ps: P3[] = [];
  // 转置就是逆旋转：钢轨自己坐标里的点
  for (let i = 0; i < pos.length; i += 3) ps.push([0, 1, 2].map((k) => M[k] * pos[i] + M[3 + k] * pos[i + 1] + M[6 + k] * pos[i + 2]) as P3);
  let a = 0, b = 0;
  if (e.pieces.every((p) => Math.abs(p.angle) < 360) && e.pieces.some((p) => p.dz)) {
    const c = [0, 1, 2].map((k) => ps.reduce((s, p) => s + p[k], 0) / ps.length);
    let xx = 0, yy = 0, xy = 0, xz = 0, yz = 0;
    for (const p of ps) { const x = p[0] - c[0], y = p[1] - c[1], z = p[2] - c[2]; xx += x * x; yy += y * y; xy += x * y; xz += x * z; yz += y * z; }
    const det = xx * yy - xy * xy;
    if (det > 1e-9) { a = (xz * yy - yz * xy) / det; b = (yz * xx - xz * xy) / det; }
  }
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of ps) {
    const q = [p[0], p[1], p[2] - a * p[0] - b * p[1]];
    for (let k = 0; k < 3; k++) { if (q[k] < lo[k]) lo[k] = q[k]; if (q[k] > hi[k]) hi[k] = q[k]; }
  }
  const at = (x: number, y: number, z: number) => apply(M, [x, y, z + a * x + b * y]) as P3;
  const ring = (z: number) => [at(lo[0], lo[1], z), at(hi[0], lo[1], z), at(hi[0], hi[1], z), at(lo[0], hi[1], z)];
  return [...ring(hi[2]), ...ring(lo[2])];
}

function cornersOf(e: Elem): P3[] {
  if (e.kind === 'rail') return railCorners(e);
  const ob = e.kind === 'obj' || e.kind === 'guard' || e.kind === 'asset' || isCheckpoint(e) ? objBoxes.get(e.id) : null;
  if (ob) {
    const a = ob.min, b = ob.max;
    return [[a.x, a.y, b.z], [b.x, a.y, b.z], [b.x, b.y, b.z], [a.x, b.y, b.z], [a.x, a.y, a.z], [b.x, a.y, a.z], [b.x, b.y, a.z], [a.x, b.y, a.z]];
  }
  const v = feats(e).verts; // boxFeats：顶面 4 个、底面 4 个，同样的顺序
  return v.length >= 8 ? v.slice(0, 8) : v;
}

function outlineOf(e: Elem, color: number, opacity = 1): THREE.Object3D {
  const c = cornersOf(e);
  const segs: P3[] = [];
  if (c.length === 8) for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) segs.push(c[i], c[j]);
  const geo = new THREE.BufferGeometry().setFromPoints(segs.map((p) => new THREE.Vector3(...p)));
  const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
  l.renderOrder = 5;
  return l;
}

/** 选中物体的半透明包裹面 */
function hullOf(e: Elem, color: number, opacity: number): THREE.Object3D | null {
  const c = cornersOf(e);
  if (c.length !== 8) return null;
  const quads = [[0, 1, 2, 3], [4, 7, 6, 5], [0, 4, 5, 1], [1, 5, 6, 2], [2, 6, 7, 3], [3, 7, 4, 0]];
  const pts: THREE.Vector3[] = [];
  for (const [a, b, cc, d] of quads) for (const i of [a, b, cc, a, cc, d]) pts.push(new THREE.Vector3(...c[i]));
  const m = new THREE.Mesh(new THREE.BufferGeometry().setFromPoints(pts), new THREE.MeshBasicMaterial({
    color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
  }));
  m.renderOrder = 3;
  return m;
}

/** 对准方块：虚线框，顶面就是路面、往下 5 */
function anchorBoxes(o: Elem): THREE.Object3D {
  const segs: THREE.Vector3[] = [];
  for (const r of virtualCells(o)) {
    const z0 = r.top - (r.depth ?? 5), z1 = r.top + 0.03;
    const c = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
    for (let i = 0; i < 4; i++) {
      const [x, y] = c[i], [x2, y2] = c[(i + 1) % 4];
      for (const q of [[x, y, z1], [x2, y2, z1], [x, y, z0], [x2, y2, z0], [x, y, z0], [x, y, z1]] as P3[]) segs.push(new THREE.Vector3(...toWorld(o, q)));
    }
  }
  const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segs), new THREE.LineDashedMaterial({ color: 0xffb84c, dashSize: 0.5, gapSize: 0.35, transparent: true, opacity: 0.95, depthTest: false }));
  l.computeLineDistances();
  l.renderOrder = 6;
  return l;
}

let hoverId: number | null = null;
/** 鼠标正停在模式手柄（箭头、圆环、抓点）上 */
let handleHot = false;
/** 鼠标正停在选中路面的侧面下半截（Ctrl / 拉伸模式下拖它是改厚度） */
let thickHover = false;
/** 鼠标不在抓点上时，现在按下去拖会操作的那个抓点（和抓点悬停一样高亮） */
let handleAim: string | null = null;
/** 拖动时要画的东西 */
/** 对齐：沿 axis 在 value 处对齐；m 是正在操作的物体（对齐后的位置），o 是对齐到的物体 */
let guides: { axis: 0 | 1 | 2; value: number; m: Bounds; o: Bounds }[] = [];
let axisLine: { p: THREE.Vector3; axis: 0 | 1 | 2 } | null = null;
let snapTarget: { p: P3; kind: 'v' | 'm' | 'e' } | null = null;
let snapGrab: P3 | null = null;
let splitPreview: { a: P3; b: P3 } | null = null;
/** Ctrl 改尺寸时顶面的测量线（on5：长度正好是 5 的整数倍） */
let measure: { a: P3; b: P3; tick: P3; text: string; on5: boolean; plane?: Bounds } | null = null;
/** 改尺寸时长度吸附到 5 的整数倍的距离（屏幕像素） */
const SIZE5_PX = 7;
const measureLabel = document.createElement('div');
measureLabel.className = 'measure-label';
measureLabel.classList.add('fade');
document.body.appendChild(measureLabel);
/** 按内部的轴（0、1 水平，2 竖直）取颜色：跟着显示的轴名走，X 红、Y 绿、Z 蓝 */
const axisLineColors = (game: boolean) => (game ? [0xff5a5a, 0x5a9cff, 0x5adc7a] : [0xff5a5a, 0x5adc7a, 0x5a9cff]);
let AXIS_COLOR = axisLineColors(prefs.coordSys !== 'math');

/**
 * 叠加层的淡入淡出：每次重画时，叠加层里的东西按「键」（这是什么提示：哪个物体的选中框、哪种辅助线……）对上号，
 * 新出现的从透明淡入，消失的留在 fadeLayer 里淡出后再释放，一直都在的直接换成新的（不闪）。
 */
const FADE_MS = 120;
const fadeLayer = new THREE.Group();
scene.add(fadeLayer);
const fading: { obj: THREE.Object3D; t0: number; from: number; to: number }[] = [];
const disposeObj = (o: THREE.Object3D) => o.traverse((x) => { const m = x as THREE.Mesh; if (m.geometry) m.geometry.dispose(); (m.material as THREE.Material | undefined)?.dispose(); /* 贴图不跟着材质释放，吸附点的贴图可以复用 */ });
/** 按比例 k 设置一个物体里所有材质的不透明度（基准不透明度第一次用时记下来） */
function setFade(o: THREE.Object3D, k: number) {
  o.traverse((x) => {
    const mt = (x as THREE.Mesh).material as THREE.Material | undefined;
    if (!mt) return;
    if (mt.userData.baseOpacity === undefined) { mt.userData.baseOpacity = mt.opacity; mt.transparent = true; }
    mt.opacity = mt.userData.baseOpacity * k;
  });
}
function tickFades(now: number) {
  for (let i = fading.length - 1; i >= 0; i--) {
    const f = fading[i];
    const k = Math.min(1, (now - f.t0) / FADE_MS);
    setFade(f.obj, f.from + (f.to - f.from) * k);
    if (k >= 1) {
      fading.splice(i, 1);
      if (f.to === 0) { f.obj.parent?.remove(f.obj); disposeObj(f.obj); }
    }
  }
}
let overlayKeys = new Map<string, THREE.Object3D>();
/** 把一个提示放进叠加层，并给它一个键（同一个键的提示视为同一个东西） */
function put(layer: THREE.Group, key: string, ...objs: THREE.Object3D[]) {
  const g = new THREE.Group();
  g.userData.fkey = key;
  g.add(...objs);
  layer.add(g);
}
/** DOM 面板 / 标签的淡入淡出：显示时先去掉 hidden 再加 .shown；隐藏时去掉 .shown，过渡完再 hidden */
function showEl(el: HTMLElement, on: boolean) {
  if (on) {
    if (el.classList.contains('shown') && !el.hidden) return;
    el.hidden = false;
    clearTimeout(Number(el.dataset.fadeT));
    requestAnimationFrame(() => el.classList.add('shown'));
  } else {
    if (!el.classList.contains('shown')) { if (!el.dataset.fadeT) el.hidden = true; return; }
    el.classList.remove('shown');
    el.dataset.fadeT = String(setTimeout(() => { if (!el.classList.contains('shown')) el.hidden = true; delete el.dataset.fadeT; }, 160));
  }
}
function drawOverlay() {
  invalidate();
  const prev = overlayKeys;
  const old: THREE.Object3D[] = [];
  for (const layer of [overlay, selLayer]) { old.push(...layer.children); layer.clear(); }
  drawOverlayInner();
  const now = performance.now();
  const next = new Map<string, THREE.Object3D>();
  for (const layer of [overlay, selLayer]) for (const o of layer.children) {
    const key = o.userData.fkey as string | undefined;
    if (!key) continue;
    next.set(key, o);
    if (!prev.has(key)) { setFade(o, 0); fading.push({ obj: o, t0: now, from: 0, to: 1 }); }
    else {
      // 一直都在：如果它刚才还在淡入，接着淡入
      const f = fading.find((x) => x.obj === prev.get(key) && x.to === 1);
      if (f) { const k = Math.min(1, (now - f.t0) / FADE_MS); setFade(o, k); fading.push({ obj: o, t0: now - k * FADE_MS, from: 0, to: 1 }); }
    }
  }
  for (const o of old) {
    const key = o.userData.fkey as string | undefined;
    const i = fading.findIndex((x) => x.obj === o);
    if (i >= 0) fading.splice(i, 1);
    if (key && !next.has(key)) {
      // 消失了：留在淡出层里淡出
      fadeLayer.add(o);
      fading.push({ obj: o, t0: now, from: 1, to: 0 });
    } else disposeObj(o);
  }
  overlayKeys = next;
}
function drawOverlayInner() {
  const hoverGroup = hoverId !== null ? expandGroups(doc, [hoverId]) : new Set<number>();
  for (const id of hoverGroup) if (!sel.has(id) && doc.elems[id]) put(overlay, `hover:${id}`, outlineOf(doc.elems[id], 0x9fc2ff, 0.45));
  const selElems = (anim?.preview ? anim.preview(anim.val) : [...sel].map((id) => doc.elems[id])).filter((e) => e && !hiddenElem(e));
  for (const e of selElems) {
    if (!e) continue;
    const c = snapping && drag ? 0x4cff8a : 0x4c8dff;
    const hull = hullOf(e, c, 0.16);
    put(selLayer, `sel:${e.id}`, ...(hull ? [hull] : []), outlineOf(e, c));
  }
  // 机关的对准方块、盘点路口的虚拟路面：悬停、选中、吸附时靠近的都画出来
  for (const id of new Set([...hoverGroup, ...sel, ...(drag ? nearVirtual : [])])) {
    const e = doc.elems[id];
    if (e && virtualCells(e).length) put(sel.has(id) ? selLayer : overlay, `anchor:${id}`, anchorBoxes(e));
  }
  // 按住 V：显示鼠标下元素的顶点和边中点
  // 按住 V：有选中的东西时只显示选中物体的顶点 / 边中点（不管鼠标移到哪），否则显示鼠标下的物体
  const vIds = vHeld && !drag ? (sel.size ? [...sel] : hoverId !== null ? [hoverId] : []) : [];
  for (const id of vIds) {
    if (!doc.elems[id]) continue;
    const f = feats(doc.elems[id]);
    put(overlay, `v:${id}`, marks(f.verts, 'dot', 0xffd34c, 11), marks(f.mids, 'diamond', 0xffd34c, 10, 0.85));
  }
  if (snapGrab) put(overlay, 'grab', marks([snapGrab], 'dot', 0xff8a4c, 13));
  if (snapTarget) put(overlay, `snap:${snapTarget.p.map((v) => v.toFixed(3)).join(',')}`, marks([snapTarget.p], snapTarget.kind === 'v' ? 'dot' : snapTarget.kind === 'm' ? 'diamond' : 'ring', 0x4cff8a, 18));
  for (const gd of guides) put(overlay, `guide:${gd.axis}:${gd.value.toFixed(3)}`, guideLines(gd));
  if (axisLine) {
    const d = new THREE.Vector3(...[0, 1, 2].map((i) => (i === axisLine!.axis ? 1 : 0)));
    const geo = new THREE.BufferGeometry().setFromPoints([axisLine.p.clone().addScaledVector(d, -500), axisLine.p.clone().addScaledVector(d, 500)]);
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: AXIS_COLOR[axisLine.axis], transparent: true, opacity: 0.9, depthTest: false }));
    l.renderOrder = 6;
    put(overlay, `axis:${axisLine.axis}`, l);
  }
  showEl(measureLabel, !!measure);
  if (measure) {
    const color = measure.on5 ? 0x4cff8a : 0xe6ebf5;
    const A = new THREE.Vector3(...measure.a), B = new THREE.Vector3(...measure.b);
    const side = new THREE.Vector3(...measure.tick);
    const segs = [A, B, A.clone().sub(side), A.clone().add(side), B.clone().sub(side), B.clone().add(side)];
    const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segs), new THREE.LineBasicMaterial({ color, depthTest: false }));
    l.renderOrder = 7;
    put(overlay, 'measure', l);
    const m = toScreen(A.clone().add(B).multiplyScalar(0.5));
    Object.assign(measureLabel.style, { left: `${m.x}px`, top: `${m.y}px`, color: measure.on5 ? '#0b2a14' : '#e6ebf5', background: measure.on5 ? '#4cff8a' : 'rgba(20,26,38,.85)' });
    measureLabel.textContent = measure.text;
  }
  if (guardPreview && guardPreview.pts.length > 1) {
    // 预览就是放下后的护栏本身（同一套几何：往外偏、拐角圆弧、两头立柱），半透明绿色
    const gm = guardFromRoute(guardPreview, mapSettings());
    if (gm) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(gm.pos, 3));
      geo.setAttribute('normal', new THREE.Float32BufferAttribute(gm.nrm, 3));
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x4cff8a, transparent: true, opacity: 0.6, depthTest: false, depthWrite: false }));
      m.renderOrder = 7;
      put(overlay, 'guardPreview', m);
    }
  }
  // 拉伸 / 坡面模式的抓点：拉伸是蓝色方块（底边上橙色的是厚度），坡面是黄色圆圈；悬停的变白、变大
  if (!drag && !guardMode && !splitMode) for (const hd of modeHandles()) {
    const hot = handleHover === `${hd.kind}:${hd.p.join()}` || handleAim === `${hd.kind}:${hd.p.join()}`;
    const size = (hot ? 19 : 15) * (touchUI ? 1.4 : 1);
    put(overlay, `hd:${hd.kind}:${hd.p.join()}:${hot}`, marks([hd.p], hd.kind === 'tilt' ? 'ring' : 'diamond', hot ? 0xffffff : hd.kind === 'size' ? 0x5b8def : hd.kind === 'thick' ? 0xff9a3c : 0xffd34c, size));
  }
  // 选中一个带挡块的机关时：每块挡块顶上一个开关（实心绿点：生成；灰色圆环：不生成），关掉的挡块画成红色虚影
  if (!drag && !guardMode && !splitMode) for (const t of stopToggles()) {
    const hov = t.id === stopHover?.id && t.part === stopHover.part;
    put(overlay, `stop:${t.id}:${t.part}:${t.on}:${hov}`, marks([t.p], t.on ? 'dot' : 'ring', t.on ? 0x4cff8a : hov ? 0xffffff : 0xc4ccda, hov ? 16 : 13));
    if (!t.on) put(overlay, `stopghost:${t.id}:${t.part}`, stopGhost(t.id, t.part));
  }
  // 选中一块路面时：四条边的中点显示开口开关（实心点：封口；绿色圆环：开口），点一下切换
  if (!drag && !guardMode && !splitMode) for (const t of openToggles()) {
    const hov = t.id === openHover?.id && t.side === openHover.side;
    // 自动：灰点；开口：绿色圆环；封口：橙色菱形
    put(overlay, `open:${t.id}:${t.side}:${t.mode}`, marks([t.p], t.mode === 'open' ? 'ring' : t.mode === 'closed' ? 'diamond' : 'dot', t.mode === 'open' ? 0x4cff8a : t.mode === 'closed' ? 0xffa64c : hov ? 0xffffff : 0x9aa6bd, hov ? 16 : 12));
  }
  // 护栏工具里：每条护栏两头的把手（拖它改长度），鼠标靠近的那个放大变绿
  if (guardMode) {
    for (const g of Object.values(doc.elems)) {
      if (g.kind !== 'guard') continue;
      ([0, 1] as const).forEach((end) => {
        const on = guardEndHover?.id === g.id && guardEndHover.end === end;
        put(overlay, `gh:${g.id}:${end}`, marks([guardHandle(g, end)], 'dot', on ? 0x4cff8a : 0xffd34c, on ? 16 : 11));
      });
    }
  }
  if (splitPreview) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...splitPreview.a), new THREE.Vector3(...splitPreview.b)]);
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffd34c, depthTest: false }));
    l.renderOrder = 6;
    put(overlay, 'split', l, marks([splitPreview.a, splitPreview.b], 'dot', 0xffd34c, 9));
  }
}

/**
 * 对齐提示：只用线条，不画面。
 *   两个物体在对齐面上的那条边画成实线（各自的高度），再用一条虚线把它们连起来、两头各伸出 1；
 *   高度对齐时，两个物体在那个高度的顶面轮廓画实线，中心之间连一条虚线。
 */
function guideLines(gd: { axis: 0 | 1 | 2; value: number; m: Bounds; o: Bounds }): THREE.Object3D {
  const g = new THREE.Group();
  const C = 0x4cff8a;
  const solid: THREE.Vector3[] = [], dashed: THREE.Vector3[] = [];
  const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);
  const { m, o } = gd;
  if (gd.axis === 2) {
    const z = gd.value + 0.04;
    for (const b of [m, o]) {
      const c = [V(b.x0, b.y0, z), V(b.x1, b.y0, z), V(b.x1, b.y1, z), V(b.x0, b.y1, z)];
      for (let i = 0; i < 4; i++) solid.push(c[i], c[(i + 1) % 4]);
    }
    dashed.push(V((m.x0 + m.x1) / 2, (m.y0 + m.y1) / 2, z), V((o.x0 + o.x1) / 2, (o.y0 + o.y1) / 2, z));
  } else {
    // 对齐面是 x = value（axis 0）或 y = value（axis 1）；w 是面上的另一个水平方向
    const P = (w: number, z: number) => (gd.axis === 0 ? V(gd.value, w, z) : V(w, gd.value, z));
    const lo = (b: Bounds) => (gd.axis === 0 ? b.y0 : b.x0), hi = (b: Bounds) => (gd.axis === 0 ? b.y1 : b.x1);
    for (const b of [m, o]) solid.push(P(lo(b), b.z1 + 0.04), P(hi(b), b.z1 + 0.04), P(lo(b), b.z1 + 0.04), P(lo(b), b.z0), P(hi(b), b.z1 + 0.04), P(hi(b), b.z0));
    const z = Math.max(m.z1, o.z1) + 0.04;
    const w0 = Math.min(lo(m), lo(o)) - 1, w1 = Math.max(hi(m), hi(o)) + 1;
    dashed.push(P(w0, z), P(w1, z));
    // 高度不同时，矮的那个的顶边往上连一条竖的虚线
    for (const b of [m, o]) if (b.z1 + 0.04 < z - 0.01) { const w = (lo(b) + hi(b)) / 2; dashed.push(P(w, b.z1 + 0.04), P(w, z)); }
  }
  const sl = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(solid), new THREE.LineBasicMaterial({ color: C, depthTest: false }));
  const dl = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(dashed), new THREE.LineDashedMaterial({ color: C, dashSize: 0.5, gapSize: 0.35, depthTest: false }));
  dl.computeLineDistances();
  sl.renderOrder = dl.renderOrder = 7;
  g.add(sl, dl);
  return g;
}

// ---------------- 拾取与投影 ----------------

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function setRay(e: { clientX: number; clientY: number }) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, viewCam());
}
function pick(e: { clientX: number; clientY: number }, skip?: Set<number>): { id: number; p: THREE.Vector3 } | null {
  setRay(e);
  for (const h of ray.intersectObjects(pickables, false)) {
    const id = hitOwner(h);
    if (!skip?.has(id) && doc.elems[id]) return { id, p: h.point.clone() };
  }
  return null;
}
/**
 * 点中的是哪个元素。连通的一片路面是一个网格，三角形可能跨过两块路面的分界，所以按点中的位置判断：
 * 这片里包含这个点的路面中 id 最小的（和求解器分格子的规则一样）；都不包含时用三角形记下的元素。
 */
function hitOwner(h: THREE.Intersection): number {
  const fo = h.object.userData.faceOwner as number[] | undefined;
  const byFace = fo && h.faceIndex != null ? fo[h.faceIndex] : undefined;
  const owners = h.object.parent?.userData.owners as Set<number> | undefined;
  if (owners) {
    let best: number | null = null;
    for (const o of owners) {
      const e = doc.elems[o];
      if (e?.kind !== 'box') continue;
      const [x, y] = toLocal(e, [h.point.x, h.point.y, h.point.z]);
      if (x >= e.x - 1e-4 && x <= e.x + e.sx + 1e-4 && y >= e.y - 1e-4 && y <= e.y + e.sy + 1e-4 && (best === null || o < best)) best = o;
    }
    if (best !== null) return best;
  }
  return byFace ?? (h.object.userData.id as number);
}
function planeHit(e: { clientX: number; clientY: number }, plane: THREE.Plane) {
  setRay(e);
  return ray.ray.intersectPlane(plane, new THREE.Vector3());
}
/** 画布在页面上的位置：每帧取一次（getBoundingClientRect 会触发排版，吸附时要投影几百个点，不能每个点都取） */
let canvasRect: DOMRect | null = null;
let canvasRectFrame = -1;
let frameNo = 0;
const tmpV = new THREE.Vector3();
function toScreen(p: P3 | THREE.Vector3): THREE.Vector2 {
  if (canvasRectFrame !== frameNo || !canvasRect) { canvasRect = renderer.domElement.getBoundingClientRect(); canvasRectFrame = frameNo; }
  const v = (Array.isArray(p) ? tmpV.set(p[0], p[1], p[2]) : tmpV.copy(p)).project(viewCam());
  const r = canvasRect;
  return new THREE.Vector2((v.x + 1) / 2 * r.width + r.left, (1 - v.y) / 2 * r.height + r.top);
}
/** 某一点附近一个像素对应多少世界单位 */
function worldPerPx(p: THREE.Vector3) {
  // 正交视图：处处一样，按到视图中心的距离算
  const d = orthoOn ? camera.position.distanceTo(controls.target) : camera.position.distanceTo(p);
  return (2 * d * Math.tan((camera.fov * Math.PI) / 360)) / renderer.domElement.clientHeight;
}

/** 射线与线段最近的点 */
function rayToSegment(o: THREE.Vector3, d: THREE.Vector3, a: P3, b: P3): THREE.Vector3 {
  const A = new THREE.Vector3(...a), u = new THREE.Vector3(...b).sub(A);
  const w = o.clone().sub(A);
  const uu = u.dot(u), ud = u.dot(d), dd = d.dot(d), uw = u.dot(w), dw = d.dot(w);
  const den = uu * dd - ud * ud;
  let s = den > 1e-12 ? (uw * dd - ud * dw) / den : 0;
  s = Math.max(0, Math.min(1, s));
  return A.addScaledVector(u, s);
}

type Target = { p: P3; kind: 'v' | 'm' | 'e'; d: number };
/** 鼠标附近别的元素上的吸附目标：顶点优先，其次边中点，再次边上最近的点 */
/** 吸附时附近的机关 / 盘点：画出它们的虚拟路面，方便对准 */
const nearVirtual = new Set<number>();
function findTarget(x: number, y: number, exclude: Set<number>, px = 12): Target | null {
  let best: Target | null = null;
  const rank = { v: 0, m: 1, e: 2 };
  const at = new THREE.Vector2(x, y);
  const consider = (p: P3, kind: 'v' | 'm' | 'e', lim: number) => {
    const d = toScreen(p).distanceTo(at);
    if (d > lim) return;
    if (!best || rank[kind] < rank[best.kind] || (rank[kind] === rank[best.kind] && d < best.d)) best = { p, kind, d };
  };
  setRay({ clientX: x, clientY: y });
  const r = canvasRect ?? renderer.domElement.getBoundingClientRect();
  const far = Math.max(r.width, r.height);
  for (const e of Object.values(doc.elems)) {
    if (exclude.has(e.id) || hiddenElem(e)) continue;
    // 包围盒中心在屏幕上离鼠标比包围盒本身大得多：不可能有点在鼠标附近，跳过
    const b = cached(e).b;
    const cs = toScreen([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2]);
    const rad = toScreen([b.x1, b.y1, b.z1]).distanceTo(cs) + toScreen([b.x0, b.y0, b.z0]).distanceTo(cs);
    if (cs.distanceTo(at) > rad + px * 6 && rad < far) continue;
    const f = feats(e);
    if (virtualCells(e).length && !nearVirtual.has(e.id) && f.verts.some((v) => toScreen(v).distanceTo(at) < px * 5)) nearVirtual.add(e.id);
    for (const v of f.verts) consider(v, 'v', px);
    for (const m of f.mids) consider(m, 'm', px);
    for (const [a, b] of f.edges) { const q = rayToSegment(ray.ray.origin, ray.ray.direction, a, b); consider([q.x, q.y, q.z], 'e', px * 0.75); }
  }
  return best;
}

// ---------------- 移动的约束：格栅、对齐 ----------------

/** 移动量按格栅取整：让选中整体的最小角（高度看顶面）落在整数上 */
function gridDelta(b: Bounds, d: V3, axes: (0 | 1 | 2)[] = [0, 1, 2]): V3 {
  if (!gridOn) return d;
  const lo = [b.x0, b.y0, b.z1];
  return d.map((v, i) => (axes.includes(i as 0 | 1 | 2) ? snapG(lo[i] + v) - lo[i] : v)) as V3;
}

const unionB = (a: Bounds, b: Bounds): Bounds => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), z0: Math.min(a.z0, b.z0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), z1: Math.max(a.z1, b.z1) });
const shiftB = (b: Bounds, d: V3): Bounds => ({ x0: b.x0 + d[0], x1: b.x1 + d[0], y0: b.y0 + d[1], y1: b.y1 + d[1], z0: b.z0 + d[2], z1: b.z1 + d[2] });

/** 自动对齐：选中整体的边 / 中线 / 顶面与别的元素足够近时对齐，返回修正后的移动量，并记下辅助面 */
function alignDelta(b: Bounds, d: V3, axes: (0 | 1 | 2)[], near: THREE.Vector3): V3 {
  guides = [];
  if (!alignOn) return d;
  const thr = worldPerPx(near) * ALIGN_PX;
  const out = [...d] as V3;
  // 参与对齐的坐标：一般按包围盒（两边 + 中线、顶面 + 底面）；钢轨、机关和有预设吸附点的素材只用预设的吸附点
  const presetOnly = (e: Elem) => e.kind === 'rail' || e.kind === 'obj' || (e.kind === 'asset' && (assetInfo(e.name)?.snapTop !== undefined || e.name in ASSET_SNAP));
  const vals = (e: Elem, a: 0 | 1 | 2): number[] => {
    if (presetOnly(e)) { const f = feats(e); return [...new Set([...f.verts, ...f.mids].map((v) => +v[a].toFixed(4)))]; }
    const x = elemBounds(e);
    return a === 0 ? [x.x0, x.x1, (x.x0 + x.x1) / 2] : a === 1 ? [x.y0, x.y1, (x.y0 + x.y1) / 2] : [x.z1, x.z0];
  };
  const others = Object.values(doc.elems).filter((e) => !sel.has(e.id));
  const selElems = [...sel].map((id) => doc.elems[id]).filter(Boolean);
  const onlyPresets = selElems.length > 0 && selElems.every(presetOnly);
  const hits: { a: 0 | 1 | 2; value: number; ob: Bounds }[] = [];
  for (const a of axes) {
    let best: { diff: number; value: number; ob: Bounds } | null = null;
    const base = onlyPresets ? [...new Set(selElems.flatMap((e) => vals(e, a)))] : (a === 0 ? [b.x0, b.x1, (b.x0 + b.x1) / 2] : a === 1 ? [b.y0, b.y1, (b.y0 + b.y1) / 2] : [b.z1, b.z0]);
    const mine = base.map((v) => v + d[a]);
    for (const oe of others) for (const v of vals(oe, a)) for (const m of mine) {
      const ob = elemBounds(oe);
      const diff = v - m;
      if (Math.abs(diff) < thr && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, value: v, ob };
    }
    if (!best) continue;
    out[a] += best.diff;
    hits.push({ a, value: best.value, ob: best.ob });
  }
  // 辅助面盖住正在操作的物体和对齐到的物体，一眼看出是和谁对齐
  for (const h of hits) guides.push({ axis: h.a, value: h.value, m: shiftB(b, out), o: h.ob });
  return out;
}

/** 选中整体（顶面 b.z1 + dz）靠近的平面：和选中东西在平面上有重叠的路面的顶面、凹槽的槽底。返回吸附后的 dz */
function planeSnap(b: Bounds, dz: number, near: THREE.Vector3): number | null {
  const z = b.z1 + dz, thr = worldPerPx(near) * SIZE5_PX;
  let best: { v: number; d: number; ob: Bounds } | null = null;
  for (const e of Object.values(doc.elems)) {
    if (sel.has(e.id) || e.kind !== 'box' || e.slope || e.q) continue;
    const f = elemBounds(e);
    if (Math.min(f.x1, b.x1) - Math.max(f.x0, b.x0) <= 0 || Math.min(f.y1, b.y1) - Math.max(f.y0, b.y0) <= 0) continue;
    for (const v of e.style === 'normal' ? [e.z] : [e.z, e.z - SINK_DEPTH]) {
      const dd = Math.abs(v - z);
      if (dd < thr && (!best || dd < best.d)) best = { v, d: dd, ob: elemBounds(e) };
    }
  }
  if (!best) { guides = []; return null; }
  guides = [{ axis: 2, value: best.v, m: shiftB(b, [0, 0, best.v - b.z1]), o: best.ob }];
  return best.v - b.z1;
}

// ---------------- 拖动 ----------------

type Drag =
  /** G：移动模式（跟着鼠标走，X / Y / Z 限制轴向，Shift+轴 排除这根轴；左键 / 回车确定，右键 / Esc 取消）；dup：复制出来的，取消就删掉 */
  | { t: 'grab'; orig: Map<number, string>; b: Bounds; start: THREE.Vector3; axis: 0 | 1 | 2 | null; excl: 0 | 1 | 2 | null; grab: P3 | null; num: string; dup?: boolean; /** 按住移动手柄的箭头拖：松手就确定 */ gz?: boolean; /** 手机：手指上一次在移动平面上的落点（世界坐标） */ touchHit?: THREE.Vector3 }
  /** R：旋转模式（绕选中整体的中心，默认绕 Z，X / Y / Z 换轴，Ctrl 按 15° 吸附） */
  | { t: 'rotate'; orig: Map<number, string>; pivot: THREE.Vector3; axis: 0 | 1 | 2; prev: number; acc: number; num: string; /** 按住圆环或东西拖：松手就确定 */ gz?: boolean }
  | { t: 'size'; id: number; orig: Map<number, string>; plane: THREE.Plane; start: THREE.Vector3; side: Dir }
  | { t: 'thick'; id: number; orig: Map<number, string>; plane: THREE.Plane; start: THREE.Vector3; steep?: { y: number; k: number } }
  /** Ctrl 拉伸木制件：沿模型本地 axis 轴，拖的是正方向（pos）还是负方向那一头 */
  | { t: 'stretch'; id: number; orig: Map<number, string>; plane: THREE.Plane; start: THREE.Vector3; axis: 0 | 1; pos: boolean }
  | { t: 'railLen'; id: number; orig: Map<number, string>; plane: THREE.Plane; start: THREE.Vector3; end: 0 | 1 }
  | { t: 'railTilt'; id: number; orig: Map<number, string>; plane: THREE.Plane; start: THREE.Vector3; end: 0 | 1 }
  | { t: 'guardLen'; id: number; orig: Map<number, string>; plane: THREE.Plane; loop: number; sFixed: number; sNear: number; moveB: boolean }
  | { t: 'tilt'; id: number; orig: Map<number, string>; plane: THREE.Plane; start: THREE.Vector3; axis: 0 | 1; hi: boolean }
  | { t: 'vsnap'; orig: Map<number, string>; grab: P3; plane: THREE.Plane }
  | { t: 'marquee'; sx: number; sy: number; add: boolean }
  | { t: 'place'; ids: number[] | null; orig?: Map<number, string>; type: string; moved: boolean; rotOff: number; /** 手指长按或横拖开始的：松手没拖进场景就什么都不放 */ touch?: boolean }
  /** 左键按下：没拖动就是点选（Shift 加选 / 减选），拖动了就变成框选 */
  | { t: 'click'; id: number | null; sx: number; sy: number; add: boolean };
let drag: Drag | null = null;

const origOf = (ids: Iterable<number> = sel) => new Map([...ids].map((id) => [id, JSON.stringify(doc.elems[id])]));
function restore(orig: Map<number, string>) { for (const [id, s] of orig) doc.elems[id] = JSON.parse(s); }
/** 拖动整体平移：鼠标位置 dRaw，自动对齐给出 dSnap（和 dRaw 一样时表示没吸上） */
function moveWithSnap(orig: Map<number, string>, dRaw: V3, dSnap: V3) {
  const on = dSnap.some((v, i) => Math.abs(v - dRaw[i]) > 1e-6);
  drive(dRaw, on ? dSnap : null, (v) => moveSel(orig, v as V3), [0, 0, 0], { ids: new Set(orig.keys()) });
  const f = on ? dSnap : dRaw;
  const shown = prefs.coordSys !== 'math' ? [f[0], f[2], f[1]] : f; // 按显示的坐标系排：x、y、z
  dragInfo = `移动 ${fmt(shown[0])}, ${fmt(shown[1])}, ${fmt(shown[2])}${on ? '（对齐）' : ''}`;
}

function moveSel(orig: Map<number, string>, d: V3) {
  restore(orig);
  d = d.map((v) => Math.round(v * 1000) / 1000) as V3; // 只保留到 0.001，免得坐标一长串小数
  for (const id of orig.keys()) translateElem(doc.elems[id], d);
}

/** 拖动中的刷新：交给动画循环，在下一帧画之前重算（重算里会顺带更新叠加层和状态栏） */
function liveUpdate() {
  rebuildWanted = true;
}

const el = renderer.domElement;
el.addEventListener('contextmenu', (e) => e.preventDefault());
// ---------------- 漫游：右键按住时，鼠标转视角，WASD 前后左右，空格上升、Shift 下降 ----------------
/** 漫游：vel 是当前速度（带缓动地追目标速度），look 是还没转完的鼠标视角（每帧转掉一部分，带一点缓动） */
let fly: { keys: Set<string>; speed: number; dist: number; vel: THREE.Vector3; look: [number, number] } | null = null;
let flySpeed = prefs.flySpeed;
el.addEventListener('pointerdown', (e) => {
  if (e.button !== 2 || drag) return;
  // 切分模式里右键：退出切分（不进漫游）
  if (splitMode) { e.preventDefault(); e.stopImmediatePropagation(); clearModes(); return; }
  e.preventDefault();
  fly = { keys: new Set(), speed: flySpeed, dist: camera.position.distanceTo(controls.target), vel: new THREE.Vector3(), look: [0, 0] };
  controls.enabled = false;
  zoomGoal = null; camAnim = null;
  el.setPointerCapture(e.pointerId);
  el.requestPointerLock?.();
  showEl(flyHud, true);
  syncFlyHud();
  updateStatus();
}, true);
// 漫游时叠在画面上的 HUD：准星、四角取景框、按键（按下的亮起）、速度
const flyHud = document.createElement('div');
flyHud.id = 'fly-hud';
flyHud.className = 'fade';
flyHud.hidden = true;
flyHud.innerHTML = `
  <div class="corner tl"></div><div class="corner tr"></div><div class="corner bl"></div><div class="corner br"></div>
  <div class="cross"></div>
  <div class="panel">
    <div class="title">漫游</div>
    <div class="keys">
      <span></span><kbd data-a="fly.forward"></kbd><span></span><kbd data-a="fly.up" data-alias>E</kbd>
      <kbd data-a="fly.left"></kbd><kbd data-a="fly.back"></kbd><kbd data-a="fly.right"></kbd><kbd data-a="fly.down" data-alias>Q</kbd>
    </div>
    <div class="ud"><kbd data-a="fly.up" data-suffix=" 上升"></kbd><kbd data-a="fly.down" data-suffix=" 下降"></kbd></div>
    <div class="speed"><span>速度</span><div class="bar"><i></i></div><b></b></div>
    <div class="tip">滚轮调速度 · 松开右键退出</div>
  </div>`;
host.appendChild(flyHud);
function syncFlyHud() {
  if (!fly) return;
  flyHud.querySelectorAll<HTMLElement>('kbd[data-a]').forEach((k) => {
    const a = k.dataset.a!;
    if (!('alias' in k.dataset)) k.textContent = `${keyOf(a) === 'space' ? '空格' : keyText(a)}${k.dataset.suffix ?? ''}`;
    k.classList.toggle('on', fly!.keys.has(a));
  });
  // 速度条按对数刻度（2～400）
  const f = Math.log(fly.speed / 2) / Math.log(200);
  flyHud.querySelector<HTMLElement>('.bar i')!.style.width = `${(f * 100).toFixed(1)}%`;
  flyHud.querySelector('.speed b')!.textContent = fly.speed.toFixed(0);
}
function endFly() {
  if (!fly) return;
  showEl(flyHud, false);
  // 视图中心放回相机前方原来的距离处，之后环视、缩放照常
  const dir = camera.getWorldDirection(new THREE.Vector3());
  controls.target.copy(camera.position).addScaledVector(dir, fly.dist);
  flySpeed = fly.speed;
  prefs.flySpeed = Math.round(flySpeed); savePrefs();
  fly = null;
  controls.enabled = true;
  controls.update();
  if (document.pointerLockElement) document.exitPointerLock();
  updateStatus();
}
window.addEventListener('pointerup', (e) => { if (e.button === 2) endFly(); }, true);
window.addEventListener('blur', endFly);
window.addEventListener('pointermove', (e) => {
  if (!fly) return;
  // 鼠标转视角：先记下要转多少，每帧转掉一部分（tickFly）
  const k = 0.0025;
  fly.look[0] += -e.movementX * k;
  fly.look[1] += -e.movementY * k;
}, true);
// 漫游时键盘只管移动（不触发别的快捷键）
window.addEventListener('keydown', (e) => {
  if (!fly) return;
  const a = flyActionFor(keyName(e));
  if (a) { fly.keys.add(a); syncFlyHud(); }
  e.preventDefault(); e.stopImmediatePropagation();
}, true);
window.addEventListener('keyup', (e) => { if (fly) { const a = flyActionFor(keyName(e)); if (a) fly.keys.delete(a); syncFlyHud(); e.stopImmediatePropagation(); } }, true);
renderer.domElement.addEventListener('wheel', (e) => {
  if (!fly) return;
  // 漫游时滚轮调速度
  e.preventDefault(); e.stopImmediatePropagation();
  fly.speed = THREE.MathUtils.clamp(fly.speed * Math.exp(-e.deltaY * 0.0015), 2, 400);
  syncFlyHud();
  updateStatus();
}, { passive: false, capture: true });
function tickFly(dt: number) {
  if (!fly) return;
  // 视角：转掉剩下的一部分（约 50 ms 追上）；水平绕世界 Z 轴，竖直绕相机右方向（不翻过头顶）
  const kl = 1 - Math.exp(-dt / 0.05);
  const yaw = fly.look[0] * kl, pitch = fly.look[1] * kl;
  fly.look[0] -= yaw; fly.look[1] -= pitch;
  if (yaw || pitch) {
    const dir = camera.getWorldDirection(new THREE.Vector3());
    dir.applyAxisAngle(new THREE.Vector3(0, 0, 1), yaw);
    const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
    const d2 = dir.clone().applyAxisAngle(right, pitch);
    if (Math.abs(d2.z) < 0.995) dir.copy(d2);
    camera.lookAt(camera.position.clone().add(dir));
  }
  const f = camera.getWorldDirection(new THREE.Vector3());
  const r = new THREE.Vector3().crossVectors(f, camera.up).normalize();
  const m = new THREE.Vector3();
  const k = fly.keys;
  if (k.has('fly.forward')) m.add(f);
  if (k.has('fly.back')) m.sub(f);
  if (k.has('fly.right')) m.add(r);
  if (k.has('fly.left')) m.sub(r);
  if (k.has('fly.up')) m.z += 1;
  if (k.has('fly.down')) m.z -= 1;
  // 移动：速度带缓动地追目标速度（约 100 ms 起步 / 停下）
  const goal = m.lengthSq() ? m.normalize().multiplyScalar(fly.speed) : m;
  fly.vel.lerp(goal, 1 - Math.exp(-dt / 0.1));
  if (fly.vel.lengthSq() < 1e-6) return;
  camera.position.addScaledVector(fly.vel, dt);
}

el.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  if (e.pointerType === 'touch' && touchPos.size > 1) return; // 双指手势：别的操作都不响应
  if (drag?.t === 'grab' || drag?.t === 'rotate') { // 移动 / 旋转模式里：左键确定（手机：轻点确定，拖动摆放）
    tapOr(e, finishDrag);
    if (e.pointerType === 'touch' && drag.t === 'grab' && !drag.gz) beginTouchGrab(e, drag);
    return;
  }
  if (splitMode) { tapOr(e, () => doSplit(e)); return; }
  if (guardMode) { guardDown(e); return; }
  // 模式的手柄：移动的箭头、旋转的圆环、拉伸 / 坡面的抓点（按着 Ctrl / Alt / V 时是别的拖法）
  if (!stretchMod(e) && !slopeMod(e) && !vHeld) {
    const gax = gizmoAt(e);
    if (gax !== null) { startGizmoDrag(e, gax); return; }
    const rax = rotGizmoAt(e);
    if (rax !== null) { startRingDrag(e, rax); return; }
  }
  // 拉伸 / 坡面的抓点：临时模式是按着 Ctrl / Alt 进来的，所以修饰键不挡它
  if (!vHeld) {
    const hd = handleAt(e);
    if (hd) {
      el.setPointerCapture(e.pointerId); pauseControls();
      // 抓点就是一个现成的落点：拉伸、厚度 = Ctrl 拖（厚度的抓点在底边，落在下半截），坡面 = Alt 拖，从这个点开始
      if (modDrag(e, { id: hd.id, p: new THREE.Vector3(...hd.p) }, hd.kind !== 'tilt', hd.kind === 'tilt')) { drawOverlay(); syncProps(); updateStatus(); }
      return;
    }
  }
  // 点机关挡块上的开关：这块挡块生成 / 不生成
  const stog = !stretchMod(e) && !slopeMod(e) && !e.shiftKey && !vHeld ? stopToggleAt(e) : null;
  if (stog) {
    tapOr(e, () => {
      snapshot();
      toggleStopper(doc.elems[stog.id] as Obj, stog.part);
      rebuild();
    });
    return;
  }
  // 点路面边上的开口开关：切换这一侧开口 / 封口
  const tog = !stretchMod(e) && !slopeMod(e) && !e.shiftKey && !vHeld ? openToggleAt(e) : null;
  if (tog) {
    tapOr(e, () => {
      snapshot();
      const b = doc.elems[tog.id] as Box;
      // 点一下依次切换：自动 → 开口 → 封口 → 自动
      const next: SideMode = ({ auto: 'open', open: 'closed', closed: 'auto' } as const)[sideMode(b, tog.side)];
      setSideMode(b, tog.side, next);
      flash(SIDE_MSG[next]);
      rebuild();
    });
    return;
  }
  if (vHeld && sel.size) {
    const at = new THREE.Vector2(e.clientX, e.clientY);
    const inside = [...sel].some((id) => {
      const b = elemBounds(doc.elems[id]);
      const ss = [b.x0, b.x1].flatMap((x) => [b.y0, b.y1].flatMap((y) => [b.z0, b.z1].map((z) => toScreen([x, y, z]))));
      const m = 14;
      return at.x >= Math.min(...ss.map((q) => q.x)) - m && at.x <= Math.max(...ss.map((q) => q.x)) + m && at.y >= Math.min(...ss.map((q) => q.y)) - m && at.y <= Math.max(...ss.map((q) => q.y)) + m;
    });
    el.setPointerCapture(e.pointerId);
    if (!inside) { drag = { t: 'marquee', sx: e.clientX, sy: e.clientY, add: addPick(e) }; return; }
    snapshot();
    const grab = nearestSelPoint(at);
    if (!grab) { undo.pop(); return; }
    drag = { t: 'vsnap', orig: origOf(), grab, plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -grab[2]) };
    snapGrab = grab;
    drawOverlay(); syncProps(); updateStatus();
    return;
  }
  let h = pick(e);
  const m = mode();
  // 移动 / 旋转模式：按在东西上直接拖（没选中的先选上），松手确定
  if (h && (m === 'move' || m === 'rotate') && !stretchMod(e) && !slopeMod(e) && !vHeld) {
    const group = expandGroups(doc, [h.id]);
    if (!sel.has(h.id)) sel = e.shiftKey ? new Set([...sel, ...group]) : group;
    el.setPointerCapture(e.pointerId); pauseControls();
    if (m === 'move') startGrab(e); else startRotate(e);
    const d = drag as Drag | null;
    if (d?.t === 'grab' || d?.t === 'rotate') d.gz = true;
    return;
  }
  // 拉伸模式 = 一直按着 Ctrl，坡面模式 = 一直按着 Alt
  const ctrlV = stretchMod(e) || m === 'stretch', altV = slopeMod(e) || m === 'slope';
  // 模式里按在没选中的东西上：先选中它（不是拉它）
  if (h && (ctrlV || altV) && !(stretchMod(e) || slopeMod(e)) && !sel.has(h.id)) { drag = { t: 'click', id: h.id, sx: e.clientX, sy: e.clientY, add: addPick(e) }; return; }
  // 按住 Ctrl / Alt 时只操作已经选中的东西：鼠标下面就算是别的路面也不会选到它
  if ((stretchMod(e) || slopeMod(e)) && sel.size) h = modHit(e);
  el.setPointerCapture(e.pointerId);
  // 不带修饰键（或者鼠标下什么都没有）：只负责点选 / 框选；移动用 G，旋转用 R
  if (!h || !(ctrlV || altV || vHeld)) { drag = { t: 'click', id: h?.id ?? null, sx: e.clientX, sy: e.clientY, add: addPick(e) }; return; }
  if (!modDrag(e, h, ctrlV, altV)) { drag = { t: 'click', id: h.id, sx: e.clientX, sy: e.clientY, add: addPick(e) }; return; }
  pauseControls(); // 拉伸、拉坡是单指拖的，这时候不环视
  drawOverlay(); syncProps(); updateStatus();
});

/**
 * 按修饰键拖（拉伸 / 坡面模式和它们的抓点也走这里）：ctrl 拉伸尺寸（按在侧面下半截是改厚度）、alt 拉坡、按住 V 是顶点吸附。
 * h 是落点：拉哪条边、哪一头，按离落点最近的算。开始了一种拖动返回 true；这里没有对应的拖法返回 false（当作点选）
 */
function modDrag(e: PointerEvent, h: { id: number; p: THREE.Vector3 }, ctrl: boolean, alt: boolean): boolean {
  if (ctrl) alt = false; // 两个都按（比如坡面模式里按 Ctrl）按 Ctrl 算
  const group = expandGroups(doc, [h.id]);
  const hb = doc.elems[h.id];
  const camN = () => camera.getWorldDirection(new THREE.Vector3()).setZ(0).normalize();
  if ((alt || ctrl) && hb.kind === 'rail' && hb.q) { flash('倾斜的钢轨请在属性面板里改长度和高差', true); return true; }
  if (alt && !ctrl && hb.kind === 'rail' && hb.pieces.length === 1 && hb.pieces[0].angle === 0) {
    snapshot();
    sel = new Set([h.id]);
    drag = { t: 'railTilt', id: h.id, orig: origOf([h.id]), plane: new THREE.Plane().setFromNormalAndCoplanarPoint(camN(), h.p), start: h.p, end: railEndAt(hb, h.p) };
    drawOverlay(); syncProps(); updateStatus();
    return true;
  }
  if (alt && !ctrl && hb.kind === 'box') {
    // Alt：拖路面的一头上下，拉成坡（只动靠近鼠标的那一端）
    if (hb.q) { flash('倾斜的路面不能拉坡（属性面板里可以摆正）', true); return true; }
    snapshot();
    sel = new Set([h.id]);
    const { axis, hi } = tiltTarget(hb, h.p);
    drag = { t: 'tilt', id: h.id, orig: origOf([h.id]), plane: new THREE.Plane().setFromNormalAndCoplanarPoint(camN(), h.p), start: h.p, axis, hi };
    drawOverlay(); syncProps(); updateStatus();
    return true;
  }
  const elem = doc.elems[h.id];
  if (ctrl && !vHeld && (elem.kind === 'box' || elem.kind === 'zone') && !elem.q && onLowerHalf(elem, h.p)) {
    // Ctrl 按在侧面下半截：上下拖改厚度（顶面不动，底面跟着走）。相机接近俯视时竖直平面算不准，改按屏幕上下拖的距离算
    snapshot();
    sel = new Set([h.id]);
    const steep = Math.abs(camera.getWorldDirection(new THREE.Vector3()).z) > 0.85;
    drag = { t: 'thick', id: h.id, orig: origOf([h.id]), plane: new THREE.Plane().setFromNormalAndCoplanarPoint(camN(), h.p), start: h.p, steep: steep ? { y: e.clientY, k: worldPerPx(h.p) } : undefined };
  } else if (vHeld) {
    // 按住 V：抓住离鼠标最近的顶点或边中点
    if (!sel.has(h.id)) sel = group;
    snapshot();
    const f = feats(elem);
    let grab = f.verts[0], bd = Infinity;
    for (const v of [...f.verts, ...f.mids]) { const d = toScreen(v).distanceTo(new THREE.Vector2(e.clientX, e.clientY)); if (d < bd) { bd = d; grab = v; } }
    drag = { t: 'vsnap', orig: origOf(), grab, plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -grab[2]) };
    snapGrab = grab;
  } else if (ctrl && !alt && elem.kind === 'guard') {
    snapshot();
    sel = new Set([h.id]);
    const a = elem.pts[0], b = elem.pts[elem.pts.length - 1];
    const end: 0 | 1 = Math.hypot(h.p.x - a[0], h.p.y - a[1]) <= Math.hypot(h.p.x - b[0], h.p.y - b[1]) ? 0 : 1;
    if (!startGuardLen(h.id, end)) { undo.pop(); return true; }
  } else if (ctrl && !alt && elem.kind === 'rail' && elem.pieces.length === 1 && elem.pieces[0].angle === 0) {
    snapshot();
    sel = new Set([h.id]);
    drag = { t: 'railLen', id: h.id, orig: origOf([h.id]), plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -h.p.z), start: h.p, end: railEndAt(elem, h.p) };
  } else if (ctrl && !alt && elem.kind === 'asset' && assetInfo(elem.name)?.stretch) {
    // Ctrl：拉伸木制件（木板、木制斜坡、凹凸木轨道、长 / 宽木桥），拖的是离鼠标最近的那一头
    if (elem.q) { flash('倾斜的东西不能拉伸', true); return true; }
    snapshot();
    sel = new Set([h.id]);
    const inf = assetInfo(elem.name)!, sc = elem.scale ?? [1, 1];
    const lp = toLocal(elem, [h.p.x, h.p.y, h.p.z]);
    const a = (elem.rot * Math.PI) / 2, dx = lp[0] - elem.x, dy = lp[1] - elem.y;
    const u = dx * Math.cos(a) + dy * Math.sin(a), v = -dx * Math.sin(a) + dy * Math.cos(a);
    const ds = [inf.max[0] * sc[0] - u, inf.max[1] * sc[1] - v, u - inf.min[0] * sc[0], v - inf.min[1] * sc[1]].map(Math.abs);
    const k = ds.indexOf(Math.min(...ds));
    drag = { t: 'stretch', id: h.id, orig: origOf([h.id]), plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -h.p.z), start: h.p, axis: (k % 2) as 0 | 1, pos: k < 2 };
  } else if (ctrl && !alt && (elem.kind === 'box' || elem.kind === 'zone')) {
    if (elem.q) { flash('倾斜的东西请在属性面板里改尺寸', true); return true; }
    snapshot();
    sel = new Set([h.id]);
    const side = nearSide(elem, h.p) as Dir;
    drag = { t: 'size', id: h.id, orig: origOf([h.id]), plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -h.p.z), start: h.p, side };
  } else return false;
  return true;
}

/** 按着 Ctrl / Alt 时操作的落点：只看选中的东西；鼠标下面没有的话算在选中范围的顶面高度上 */
function modHit(e: { clientX: number; clientY: number }): { id: number; p: THREE.Vector3 } {
  const others = new Set(Object.keys(doc.elems).map(Number).filter((id) => !sel.has(id)));
  const hs = pick(e, others);
  if (hs) return hs;
  const b = boundsOf(doc, sel);
  const p = planeHit(e, new THREE.Plane(new THREE.Vector3(0, 0, 1), -b.z1)) ?? new THREE.Vector3((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.z1);
  return { id: [...sel][0], p };
}
/** 离这个点最近的一条边（0：+x 1：+y 2：-x 3：-y） */
function nearSide(e: Box | ZoneElem, p: THREE.Vector3): 0 | 1 | 2 | 3 {
  const f = footprint(e), lp = toLocal(e, [p.x, p.y, p.z]);
  const ds = [f.x1 - lp[0], f.y1 - lp[1], lp[0] - f.x0, lp[1] - f.y0].map(Math.abs);
  return ds.indexOf(Math.min(...ds)) as 0 | 1 | 2 | 3;
}
/** 拉坡拉的是哪一头：已经是坡的只有两头，平的拉离鼠标最近的那条边 */
function tiltTarget(b: Box, p: THREE.Vector3): { axis: 0 | 1; hi: boolean } {
  if (b.slope) {
    const f = footprint(b), lp = toLocal(b, [p.x, p.y, p.z]), axis = b.slope.axis;
    return { axis, hi: axis === 0 ? lp[0] > (f.x0 + f.x1) / 2 : lp[1] > (f.y0 + f.y1) / 2 };
  }
  const side = nearSide(b, p);
  return { axis: (side % 2) as 0 | 1, hi: side < 2 };
}
/** 这个点在路面 / 死亡区侧面的下半截（顶面和上半截还是改尺寸）。厚度抓点可能挪到边外面，顶面高度按边上算 */
function onLowerHalf(e: Box | ZoneElem, p: THREE.Vector3): boolean {
  const lp = toLocal(e, [p.x, p.y, p.z]), f = footprint(e);
  const x = Math.min(f.x1, Math.max(f.x0, lp[0])), y = Math.min(f.y1, Math.max(f.y0, lp[1]));
  return lp[2] < (e.kind === 'box' ? boxTopAt(e, x, y) : e.z) - e.depth / 2;
}

/** 选中物体上离鼠标最近的顶点 / 边中点（V 吸附的抓手） */
function nearestSelPoint(at: THREE.Vector2): P3 | null {
  let grab: P3 | null = null, bd = Infinity;
  for (const id of sel) { const f = feats(doc.elems[id]); for (const v of [...f.verts, ...f.mids]) { const d = toScreen(v).distanceTo(at); if (d < bd) { bd = d; grab = v; } } }
  return grab;
}

// ---------------- G 移动 / R 旋转（Blender 式） ----------------

/** 内部的轴（0、1 水平，2 竖直）显示成什么名字；游戏坐标系里竖直的是 Y */
const axisNames = (game: boolean) => (game ? ['X', 'Z', 'Y'] : ['X', 'Y', 'Z']);
let AXIS_NAME = axisNames(prefs.coordSys !== 'math');
/** G：进入移动模式。dup：刚复制出来的（取消就删掉；复制时已经记过撤销） */
function startGrab(mouse: { clientX: number; clientY: number }, dup = false) {
  if (!sel.size || drag) return;
  if (!dup) snapshot();
  const b = boundsOf(doc, sel);
  const start = planeHit(mouse, new THREE.Plane(new THREE.Vector3(0, 0, 1), -b.z1)) ?? new THREE.Vector3((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.z1);
  drag = { t: 'grab', orig: origOf(), b, start, axis: null, excl: null, grab: nearestSelPoint(new THREE.Vector2(mouse.clientX, mouse.clientY)), num: '', dup };
  hoverId = null;
  grabMove(mouse);
  drawOverlay(); syncProps(); updateStatus();
}
function grabMove(e: { clientX: number; clientY: number }) {
  const d = drag;
  if (d?.t !== 'grab') return;
  guides = []; snapTarget = null; axisLine = null;
  const ax = d.axis, ex = d.excl;
  const n = parseFloat(d.num);
  // 打字输入：限制了轴向时就是沿这根轴的距离
  if (d.num && Number.isFinite(n) && ax !== null) {
    const v: V3 = [0, 0, 0]; v[ax] = n;
    moveWithSnap(d.orig, v, v);
    axisLine = { p: d.start.clone().add(new THREE.Vector3(...v)), axis: ax };
    dragInfo = `移动 ${AXIS_NAME[ax]} ${d.num}`;
    liveUpdate();
    return;
  }
  // 按住 V：选中物体上的抓手吸到别的物体的顶点 / 边中点 / 边上
  if (vHeld && d.grab) {
    const tg = findTarget(e.clientX, e.clientY, sel);
    if (tg) {
      const g = d.grab;
      const v: V3 = [tg.p[0] - g[0], tg.p[1] - g[1], tg.p[2] - g[2]];
      drive(v, v, (x) => moveSel(d.orig, x as V3), [0, 0, 0], { ids: new Set(d.orig.keys()) });
      snapTarget = tg;
      dragInfo = `吸附到${tg.kind === 'v' ? '顶点' : tg.kind === 'm' ? '边中点' : '边上'}`;
      liveUpdate();
      return;
    }
  }
  let raw: V3 = [0, 0, 0];
  let axes: (0 | 1 | 2)[] = [0, 1];
  let near = d.start;
  if (ax === 0 || ax === 1) {
    const dir = new THREE.Vector3(ax === 0 ? 1 : 0, ax === 1 ? 1 : 0, 0);
    setRay(e);
    const q = rayToSegment(ray.ray.origin, ray.ray.direction, d.start.clone().addScaledVector(dir, -1e4).toArray() as P3, d.start.clone().addScaledVector(dir, 1e4).toArray() as P3);
    raw[ax] = q.getComponent(ax) - d.start.getComponent(ax);
    axes = [ax];
  } else if (ax === 2 || (ex !== null && ex !== 2)) {
    // 竖直方向：在一个竖直的平面上拖（Z：朝着相机；Shift+X / Shift+Y：垂直于被排除的那根轴）
    const nrm = ax === 2 ? camera.getWorldDirection(new THREE.Vector3()).setZ(0).normalize() : new THREE.Vector3(ex === 0 ? 1 : 0, ex === 1 ? 1 : 0, 0);
    const p = planeHit(e, new THREE.Plane().setFromNormalAndCoplanarPoint(nrm, d.start));
    if (!p) return;
    const v = p.clone().sub(d.start);
    raw = [ax === 2 || ex === 0 ? 0 : v.x, ax === 2 || ex === 1 ? 0 : v.y, v.z];
    axes = ax === 2 ? [2] : ex === 0 ? [1, 2] : [0, 2];
    near = p;
  } else {
    const p = planeHit(e, new THREE.Plane(new THREE.Vector3(0, 0, 1), -d.start.z));
    if (!p) return;
    raw = [p.x - d.start.x, p.y - d.start.y, 0];
    near = p;
  }
  raw = gridDelta(d.b, raw, axes);
  // 竖直移动：吸附到底下 / 旁边路面的顶面、凹槽槽底；其余按自动对齐
  const pz = ax === 2 ? planeSnap(d.b, raw[2], near) : null;
  moveWithSnap(d.orig, raw, pz !== null ? [0, 0, pz] : alignDelta(d.b, raw, axes, near));
  if (ax !== null) axisLine = { p: d.start.clone().add(new THREE.Vector3(...raw)), axis: ax };
  liveUpdate();
}

/** R：进入旋转模式（转轴过选中整体包围盒的中心） */
function startRotate(mouse: { clientX: number; clientY: number }) {
  if (!sel.size || drag) return;
  snapshot();
  const b = boundsOf(doc, sel);
  const pivot = new THREE.Vector3((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
  drag = { t: 'rotate', orig: origOf(), pivot, axis: 2, prev: screenAngle(pivot, mouse), acc: 0, num: '' };
  hoverId = null;
  rotateMove(mouse);
  drawOverlay(); syncProps(); updateStatus();
}
function screenAngle(p: THREE.Vector3, m: { clientX: number; clientY: number }) {
  const s = toScreen(p);
  return Math.atan2(-(m.clientY - s.y), m.clientX - s.x);
}
let rotCtrl = false;
function rotateMove(e: { clientX: number; clientY: number }) {
  const d = drag;
  if (d?.t !== 'rotate') return;
  const a = screenAngle(d.pivot, e);
  let da = a - d.prev;
  if (da > Math.PI) da -= 2 * Math.PI; else if (da < -Math.PI) da += 2 * Math.PI;
  d.acc += da; d.prev = a;
  // 屏幕上逆时针 = 绕朝着相机的那个方向的轴正转
  const axisV = new THREE.Vector3(d.axis === 0 ? 1 : 0, d.axis === 1 ? 1 : 0, d.axis === 2 ? 1 : 0);
  const toward = axisV.dot(camera.getWorldDirection(new THREE.Vector3())) < 0 ? 1 : -1;
  const raw = ((d.acc * 180) / Math.PI) * toward;
  const n = parseFloat(d.num);
  // 开着对齐时每次吸附 15°；按住 Ctrl 临时反过来（对齐开着时自由转，关着时按 15°）
  const step15 = alignOn !== rotCtrl;
  let snap: number | null = null;
  if (d.num && Number.isFinite(n)) snap = n;
  else if (step15) snap = Math.round(raw / 15) * 15;
  else if (Math.abs(raw - Math.round(raw / 90) * 90) < 3) snap = Math.round(raw / 90) * 90; // 自由转时靠近 90° 的整数倍轻轻吸住
  const final = snap ?? Math.round(raw * 100) / 100;
  drive([raw], [final], (v) => {
    restore(d.orig);
    const R: M3 = rotAxis(d.axis, v[0]);
    for (const id of d.orig.keys()) rotateWorld(doc.elems[id], R, [d.pivot.x, d.pivot.y, d.pivot.z]);
  }, [0]);
  const on = snap !== null && !d.num;
  if (snapping !== on) { snapping = on; drawOverlay(); }
  axisLine = { p: d.pivot.clone(), axis: d.axis };
  dragInfo = `旋转 ${d.num ? `${d.num}°` : `${fmt(final)}°`}（绕 ${AXIS_NAME[d.axis]}${step15 ? ' · 每 15°' : ' · 自由'}）`;
  syncRotLine(e);
  liveUpdate();
}
/** 旋转时从转轴中心连到鼠标的虚线（屏幕上） */
const rotLine = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
rotLine.id = 'rot-line';
rotLine.innerHTML = '<line /><circle r="4" />';
document.body.appendChild(rotLine);
function syncRotLine(m?: { clientX: number; clientY: number }) {
  const d = drag;
  const on = d?.t === 'rotate' && !!m;
  rotLine.classList.toggle('on', on);
  if (!on || d?.t !== 'rotate' || !m) return;
  const s = toScreen(d.pivot);
  const l = rotLine.querySelector('line')!, c = rotLine.querySelector('circle')!;
  l.setAttribute('x1', String(s.x)); l.setAttribute('y1', String(s.y)); l.setAttribute('x2', String(m.clientX)); l.setAttribute('y2', String(m.clientY));
  c.setAttribute('cx', String(s.x)); c.setAttribute('cy', String(s.y));
}
/** 移动 / 旋转模式里的按键：轴向、打字输入、确定、取消。返回 true 表示已处理（其它快捷键不再响应） */
function transformKey(e: KeyboardEvent): boolean {
  const d = drag;
  if (d?.t !== 'grab' && d?.t !== 'rotate') return false;
  const k = e.key.toLowerCase();
  if (k === 'escape') { cancelTransform(); return true; }
  if (k === 'enter') { finishDrag(); return true; }
  if (k === 'control') { rotCtrl = true; if (d.t === 'rotate') rotateMove(lastMouse); updateStatus(); return true; }
  if (k === 'x' || k === 'y' || k === 'z') {
    const a = AXIS_NAME.indexOf(k.toUpperCase()) as 0 | 1 | 2; // 按的是显示的轴名
    if (d.t === 'grab') {
      if (e.shiftKey) { d.excl = d.excl === a ? null : a; d.axis = null; }
      else { d.axis = d.axis === a ? null : a; d.excl = null; }
      grabMove(lastMouse);
    } else {
      if (a !== 2 && [...d.orig.keys()].some((id) => !canTilt(doc.elems[id]))) { flash('护栏、盘点只能绕竖直轴转', true); return true; }
      d.axis = a; d.acc = 0; d.prev = screenAngle(d.pivot, lastMouse);
      rotateMove(lastMouse);
    }
    drawOverlay(); updateStatus();
    return true;
  }
  if (/^[0-9.]$/.test(k) || k === '-' || k === 'backspace') {
    e.preventDefault();
    if (k === 'backspace') d.num = d.num.slice(0, -1);
    else if (k === '-') d.num = d.num.startsWith('-') ? d.num.slice(1) : `-${d.num}`;
    else d.num += k;
    if (d.t === 'grab') { if (d.axis === null && d.num) { d.axis = 0; d.excl = null; } grabMove(lastMouse); } else rotateMove(lastMouse);
    updateStatus();
    return true;
  }
  // 模式里还能用：对齐开关、顶点吸附、格栅开关（按当前的快捷键）
  const pass = actionFor(comboOf(e));
  return !(pass === 'align' || pass === 'grid' || keyName(e) === keyOf('vsnap') || k === 'tab' || k === 'shift');
}
function cancelTransform() {
  const d = drag;
  if (!d || !('orig' in d) || d.t === 'place') return;
  anim = null; snapping = false;
  if (d.t === 'grab' && d.dup) { for (const id of d.orig.keys()) delete doc.elems[id]; sel.clear(); }
  else restore(d.orig);
  undo.pop();
  drag = null; guides = []; axisLine = null; snapTarget = null; dragInfo = ''; measure = null;
  syncRotLine();
  rebuild();
}
// 移动 / 旋转模式里右键取消（在漫游之前拦下来）
window.addEventListener('pointerdown', (e) => {
  if (e.button === 2 && (drag?.t === 'grab' || drag?.t === 'rotate')) { e.preventDefault(); e.stopImmediatePropagation(); cancelTransform(); }
}, true);
window.addEventListener('keyup', (e) => { if (e.key === 'Control' && rotCtrl) { rotCtrl = false; if (drag?.t === 'rotate') rotateMove(lastMouse); updateStatus(); } });

window.addEventListener('pointermove', (e) => {
  if (!drag) {
    // 手指没有悬停：环视、双指时什么都不高亮（只有沿路边拖护栏要跟着手指）
    if (e.pointerType === 'touch') { if (guardDrag) guardHover(e); return; }
    if (e.target !== el) { setHandleAim(null); return; }
    if (splitMode) { splitHover(e); return; }
    // 悬停在模式手柄上：高亮，鼠标变成手形
    const free = !stretchMod(e) && !slopeMod(e) && !vHeld;
    const gh = free ? gizmoAt(e) : null, rh = free && gh === null ? rotGizmoAt(e) : null, hh = !vHeld && gh === null && rh === null ? handleAt(e) : null;
    const hk = hh ? `${hh.kind}:${hh.p.join()}` : null;
    const ch1 = moveGizmo.setHot(gh), ch2 = rotGizmo.setHot(rh), ch3 = hk !== handleHover;
    if (ch1 || ch2 || ch3) {
      handleHover = hk;
      handleHot = gh !== null || rh !== null || !!hh;
      dragInfo = gh !== null ? `拖动：沿 ${AXIS_NAME[gh]} 移动` : rh !== null ? `拖动：绕 ${AXIS_NAME[rh]} 转` : hh ? HANDLE_INFO[hh.kind] : '';
      if (ch3) drawOverlay();
      invalidate(); updateStatus();
    }
    thickHover = false;
    if (gh !== null || rh !== null || hh) { setHandleAim(null); return; }
    if (guardMode) { guardHover(e); return; }
    updateAim(e, stretchMod(e) || slopeMod(e));
    // 按住 Ctrl / Alt 时不提示别的路面（这时只会操作已经选中的东西）
    const sg = stopToggleAt(e);
    const sh = sg ? { id: sg.id, part: sg.part } : null;
    const tg = sg ? null : openToggleAt(e);
    const th = tg ? { id: tg.id, side: tg.side } : null;
    if (sh?.id !== stopHover?.id || sh?.part !== stopHover?.part || th?.id !== openHover?.id || th?.side !== openHover?.side) {
      stopHover = sh; openHover = th;
      dragInfo = sh ? '点击切换这块挡块：生成 / 不生成' : th ? '点击切换这一侧：自动 → 开口 → 封口' : '';
      drawOverlay(); updateStatus();
    }
    const id = (stretchMod(e) || slopeMod(e)) && sel.size ? null : pick(e)?.id ?? null;
    if (id !== hoverId) { hoverId = id; drawOverlay(); }
    return;
  }
  // 双指手势时不动；手机上复制后的放置模式：按下它的那根手指拖动才摆放（手指还没动的时候可能只是轻点确定）
  if (e.pointerType === 'touch') {
    if (touchPos.size > 1) return;
    if ((drag.t === 'grab' || drag.t === 'rotate') && !drag.gz) {
      if (drag.t !== 'grab' || e.pointerId !== grabTouchId || touchTap) return;
      drag.touchHit = planeHit(e, grabPlane(drag)) ?? drag.touchHit;
    }
  }
  nearVirtual.clear();
  if (drag.t === 'grab') { grabMove(e); return; }
  if (drag.t === 'rotate') { rotateMove(e); return; }
  if (drag.t === 'place') { placeMove(e); return; }
  if (drag.t === 'click') {
    // 按下后拖动：变成框选（触摸屏上单指拖是环视：手指一动就不算点选了，除非打开了框选）
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < (e.pointerType === 'touch' ? 10 : 5)) return;
    if (e.pointerType === 'touch' && !touchMarquee) { drag = null; return; }
    drag = { t: 'marquee', sx: drag.sx, sy: drag.sy, add: drag.add };
  }
  if (drag.t === 'marquee') { showMarquee(drag.sx, drag.sy, e.clientX, e.clientY); return; }
  if (drag.t === 'vsnap') {
    const p = planeHit(e, drag.plane);
    if (!p) return;
    const tg = findTarget(e.clientX, e.clientY, sel);
    const g = drag.grab;
    const raw: V3 = [p.x - g[0], p.y - g[1], 0];
    drive(raw, tg ? [tg.p[0] - g[0], tg.p[1] - g[1], tg.p[2] - g[2]] : null, (v) => moveSel((drag as { orig: Map<number, string> }).orig, v as V3), [0, 0, 0], { ids: new Set(drag.orig.keys()) });
    snapTarget = tg;
    snapGrab = tg ? null : [p.x, p.y, g[2]];
    dragInfo = tg ? `吸附到${tg.kind === 'v' ? '顶点' : tg.kind === 'm' ? '边中点' : '边上'}` : '';
    return;
  }
  if (drag.t === 'thick' && drag.steep) { thickTo(drag, drag.start.clone().setZ(drag.start.z - (e.clientY - drag.steep.y) * drag.steep.k)); return; }
  const p = planeHit(e, drag.plane);
  if (!p) return;
  if (drag.t === 'size') { resizeTo(drag, p); return; }
  if (drag.t === 'thick') { thickTo(drag, p); return; }
  if (drag.t === 'stretch') { stretchTo(drag, p); return; }
  if (drag.t === 'tilt') { tiltTo(drag, p); return; }
  if (drag.t === 'railLen') { railLenTo(drag, p); return; }
  if (drag.t === 'railTilt') { railTiltTo(drag, p); return; }
  if (drag.t === 'guardLen') { guardLenTo(drag, p); return; }
});

/** Ctrl 拉伸木制件：另一头不动，长度靠近 5 的整数倍时磁吸；格栅开着时长度取整 */
function stretchTo(d: Extract<Drag, { t: 'stretch' }>, p: THREE.Vector3) {
  const o = JSON.parse(d.orig.get(d.id)!) as AssetElem;
  const inf = assetInfo(o.name)!;
  const ax = d.axis, s0 = (o.scale ?? [1, 1])[ax], mn = inf.min[ax], mx = inf.max[ax], base = mx - mn;
  // 模型本地的这根轴在朝向坐标系里的方向
  const a = (o.rot * Math.PI) / 2;
  const axv: [number, number] = ax === 0 ? [Math.cos(a), Math.sin(a)] : [-Math.sin(a), Math.cos(a)];
  const dl = dirToLocal(o, [p.x - d.start.x, p.y - d.start.y, 0]);
  const along = dl[0] * axv[0] + dl[1] * axv[1];
  const fixed = d.pos ? mn * s0 : mx * s0, moving = (d.pos ? mx * s0 : mn * s0) + along;
  let raw = Math.max(0.5, d.pos ? moving - fixed : fixed - moving);
  if (gridOn) raw = Math.max(prefs.gridStep, snapG(raw));
  raw = Math.round(raw * 1000) / 1000;
  const L5 = Math.round(raw / 5) * 5;
  const snap = L5 > 0 && Math.abs(raw - L5) < worldPerPx(p) * SIZE5_PX ? L5 : null;
  const apply = (e: AssetElem, len: number) => {
    const s1 = len / base;
    const shift = (d.pos ? mn : mx) * (s0 - s1);
    const sc: [number, number] = [...(o.scale ?? [1, 1])] as [number, number];
    sc[ax] = Math.round(s1 * 1e6) / 1e6;
    e.scale = sc[0] === 1 && sc[1] === 1 ? undefined : sc;
    e.x = Math.round((e.x + axv[0] * shift) * 1e6) / 1e6;
    e.y = Math.round((e.y + axv[1] * shift) * 1e6) / 1e6;
    return { s1, shift };
  };
  drive([raw], snap === null ? null : [snap], (v) => {
    restore(d.orig);
    const e = doc.elems[d.id] as AssetElem;
    const { s1 } = apply(e, v[0]);
    // 测量线：沿拉伸的方向，放在模型顶上
    const top = elemBounds(e).z1 + 0.08;
    const P = (t: number): P3 => toWorld(e, [e.x + axv[0] * t, e.y + axv[1] * t, top]);
    measure = { a: P(mn * s1), b: P(mx * s1), tick: [0.6 * -axv[1], 0.6 * axv[0], 0], text: fmt(snap ?? raw), on5: snap !== null };
  }, [raw], { preview: (v) => { const e: AssetElem = JSON.parse(d.orig.get(d.id)!); apply(e, v[0]); return [e]; } });
  dragInfo = `${inf.label} 长 ${fmt(snap ?? raw)}（原长 ${fmt(base)}）`;
}

/** Ctrl 拖侧面下半截：改厚度（顶面不动）。厚度靠近 5 的整数倍时磁吸；格栅开着时取整 */
function thickTo(d: Extract<Drag, { t: 'thick' }>, p: THREE.Vector3) {
  const o = JSON.parse(d.orig.get(d.id)!) as Box | ZoneElem;
  let raw = Math.max(0.1, o.depth - (p.z - d.start.z));
  if (gridOn) raw = Math.max(prefs.gridStep, snapG(raw));
  raw = Math.round(raw * 1000) / 1000;
  const L5 = Math.round(raw / 5) * 5;
  const snap = L5 > 0 && Math.abs(raw - L5) < worldPerPx(p) * SIZE5_PX ? L5 : null;
  const final = snap ?? raw;
  drive([raw], snap === null ? null : [snap], (v) => {
    restore(d.orig);
    const b = doc.elems[d.id] as Box | ZoneElem;
    b.depth = Math.max(0.1, Math.round(v[0] * 1000) / 1000);
    // 测量线：在离相机最近的那个角上，从顶面竖到底面
    const lb = elemBounds(b);
    const cs: [number, number][] = [[lb.x0, lb.y0], [lb.x1, lb.y0], [lb.x1, lb.y1], [lb.x0, lb.y1]];
    const [x, y] = cs.sort((u, w) => Math.hypot(u[0] - camera.position.x, u[1] - camera.position.y) - Math.hypot(w[0] - camera.position.x, w[1] - camera.position.y))[0];
    measure = { a: [x, y, lb.z1], b: [x, y, lb.z1 - b.depth], tick: [0.6, 0.6, 0], text: `厚度 ${fmt(final)}`, on5: snap !== null };
  }, [o.depth]);
  dragInfo = `厚度 ${fmt(final)}${final > 5 ? '（侧面：上 5 带边框、往下无边框）' : ''}`;
}

/** Ctrl 拖动改尺寸：拖的是离鼠标最近的那条边。对齐、长度取 5 的倍数都是磁吸（缓动 + 松手对准） */
function resizeTo(d: Extract<Drag, { t: 'size' }>, p: THREE.Vector3) {
  const o = JSON.parse(d.orig.get(d.id)!) as Box | ZoneElem;
  const s = d.side, ax: 0 | 1 = s % 2 === 0 ? 0 : 1;
  const lo = ax === 0 ? o.x : o.y, len = ax === 0 ? o.sx : o.sy;
  const start = s < 2 ? lo + len : lo;
  // 鼠标位移换到路面自己的坐标系（转过的路面沿它自己的边改尺寸）
  const dl = dirToLocal(o, [p.x - d.start.x, p.y - d.start.y, 0]);
  let raw = start + dl[ax];
  if (gridOn && !o.ang) raw = snapG(raw);
  raw = Math.round(raw * 1000) / 1000;
  let snap: number | null = null;
  guides = [];
  if (alignOn && !o.ang) {
    const thr = worldPerPx(p) * ALIGN_PX;
    let best: { diff: number; ob: Bounds } | null = null;
    for (const ob of Object.values(doc.elems).filter((x) => x.id !== o.id).map(elemBounds)) {
      for (const v of ax === 0 ? [ob.x0, ob.x1] : [ob.y0, ob.y1]) { const diff = v - raw; if (Math.abs(diff) < thr && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, ob }; }
    }
    if (best) { snap = raw + best.diff; guides.push({ axis: ax, value: snap, m: elemBounds(o), o: best.ob }); }
  }
  // 长度接近 5 的整数倍时吸附（不管开没开格栅、对齐都有）
  const fixed = s < 2 ? lo : lo + len;
  const L0 = Math.abs(raw - fixed), L5 = Math.round(L0 / 5) * 5;
  const on5 = L5 > 0 && Math.abs(L0 - L5) < worldPerPx(p) * SIZE5_PX;
  if (on5) { snap = fixed + (s < 2 ? L5 : -L5); guides = []; }
  const setEdge = (b: Box | ZoneElem, edge: number) => {
    if (s < 2) { const n = Math.max(0.1, edge - lo); if (ax === 0) b.sx = n; else b.sy = n; }
    else { const e0 = Math.min(lo + len - 0.1, edge); if (ax === 0) { b.x = e0; b.sx = lo + len - e0; } else { b.y = e0; b.sy = lo + len - e0; } }
  };
  const finalLen = Math.abs((snap ?? raw) - fixed);
  drive([raw], snap === null ? null : [snap], (v) => {
    restore(d.orig);
    const b = doc.elems[d.id] as Box | ZoneElem;
    setEdge(b, Math.round(v[0] * 1000) / 1000);
    // 测量线：沿改尺寸的方向，放在顶面中线上；数字是松手后的长度
    const f = footprint(b);
    const mid = ax === 0 ? (f.y0 + f.y1) / 2 : (f.x0 + f.x1) / 2;
    // 坡面路：测量线画在较高那一头高度的水平虚拟面上（量的是 box 的长度，不是坡面的长度）
    const flatZ = b.kind === 'box' && b.slope ? Math.max(b.z, b.z + b.slope.dz) + 0.08 : null;
    const P = (t: number): P3 => { const x = ax === 0 ? t : mid, y = ax === 0 ? mid : t; return toWorld(b, [x, y, flatZ ?? (b.kind === 'box' ? boxTopAt(b, x, y) : b.z) + 0.08]); };
    const [t0, t1] = ax === 0 ? [f.x0, f.x1] : [f.y0, f.y1];
    const tk = toWorld(b, ax === 0 ? [b.x, b.y + 0.6, 0] : [b.x + 0.6, b.y, 0]), t00 = toWorld(b, [b.x, b.y, 0]);
    measure = { a: P(t0), b: P(t1), tick: [tk[0] - t00[0], tk[1] - t00[1], 0], text: fmt(finalLen), on5: snap !== null };
  }, [start], { preview: (v) => { const b: Box | ZoneElem = JSON.parse(d.orig.get(d.id)!); setEdge(b, v[0]); return [b]; } });
  const w = ax === 0 ? o.sy : o.sx;
  dragInfo = `尺寸 ${ax === 0 ? `${fmt(finalLen)} × ${fmt(w)}` : `${fmt(w)} × ${fmt(finalLen)}`}`;
}

/**
 * Alt+Shift 拖动：抬高 / 压低路面的一头。磁吸（缓动 + 松手对准）的高度：贴着 / 插进去的路面的高度、
 * 和另一头一样高（放平）、高差是 5 的整数倍、开着对齐时别的路面的顶面。格栅开着时高度取整。
 */
function tiltTo(d: Extract<Drag, { t: 'tilt' }>, p: THREE.Vector3) {
  const o = JSON.parse(d.orig.get(d.id)!) as Box;
  const len = d.axis === 0 ? o.sx : o.sy;
  const odz = o.slope && o.slope.axis === d.axis ? o.slope.dz : 0;
  const zLo = o.z, zHi = o.z + odz;
  const other = d.hi ? zLo : zHi;
  const start = d.hi ? zHi : zLo;
  let raw = start + (p.z - d.start.z);
  if (gridOn) raw = snapG(raw);
  raw = Math.round(raw * 1000) / 1000;
  const thr = worldPerPx(p) * SIZE5_PX;
  guides = [];
  // 这一头贴着的路面（端面相接），或者这一头插进去的路面（坡顶插进平台）
  const fo = footprint(o);
  const dEnd = (d.hi ? d.axis : d.axis + 2) as Dir;
  const line = [fo.x1, fo.y1, fo.x0, fo.y0][dEnd];
  const touching = Object.values(doc.elems).filter((x): x is Box => x.kind === 'box' && x.id !== o.id && !x.q && (x.ang ?? 0) === (o.ang ?? 0)).filter((x) => {
    const g = footprint(x);
    const near = [g.x0, g.y0, g.x1, g.y1][dEnd];
    const [a0, a1, b0, b1] = d.axis === 0 ? [fo.y0, fo.y1, g.y0, g.y1] : [fo.x0, fo.x1, g.x0, g.x1];
    const [g0, g1] = d.axis === 0 ? [g.x0, g.x1] : [g.y0, g.y1];
    const inside = line > g0 + 0.01 && line < g1 + 0.01;
    return (Math.abs(near - line) < 0.01 || inside) && Math.min(a1, b1) - Math.max(a0, b0) > 0.01;
  });
  const meet = touching.map((x) => { const g = footprint(x); const [px, py] = d.axis === 0 ? [line, (g.y0 + g.y1) / 2] : [(g.x0 + g.x1) / 2, line]; return boxTopAt(x, px, py); })
    .filter((z) => Math.abs(z - raw) < thr).sort((u, v) => Math.abs(u - raw) - Math.abs(v - raw))[0];
  const k5 = Math.round((raw - other) / 5);
  let snap: number | null = null;
  let label = '';
  if (meet !== undefined) { snap = meet; label = ' · 接上'; }
  else if (Math.abs(raw - other) < thr) { snap = other; label = ' · 水平'; }
  else if (k5 !== 0 && Math.abs(raw - other - k5 * 5) < thr) snap = other + k5 * 5;
  else if (alignOn) {
    let best: { diff: number; v: number; ob: Bounds } | null = null;
    for (const ob of Object.values(doc.elems).filter((x) => x.id !== o.id).map(elemBounds)) {
      const diff = ob.z1 - raw;
      if (Math.abs(diff) < worldPerPx(p) * ALIGN_PX && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, v: ob.z1, ob };
    }
    if (best) { snap = best.v; guides.push({ axis: 2, value: snap, m: elemBounds(o), o: best.ob }); }
  }
  const final = snap ?? raw;
  const setEnd = (x: Box, v: number) => {
    const dz = d.hi ? v - zLo : zHi - v;
    x.z = d.hi ? zLo : v;
    x.slope = Math.abs(dz) < 1e-6 ? undefined : { axis: d.axis, dz };
  };
  drive([raw], snap === null ? null : [snap], (v) => {
    restore(d.orig);
    const b = doc.elems[d.id] as Box;
    const cur = Math.round(v[0] * 1000) / 1000;
    setEnd(b, cur);
    // 测量线：在动的那一头，从另一头的高度竖到这一头的高度；数字是松手后的高差
    const f = footprint(b);
    const t = d.hi ? (d.axis === 0 ? f.x1 : f.y1) : (d.axis === 0 ? f.x0 : f.y0);
    const mid = d.axis === 0 ? (f.y0 + f.y1) / 2 : (f.x0 + f.x1) / 2;
    const [x, y] = d.axis === 0 ? [t, mid] : [mid, t];
    measure = { a: toWorld(b, [x, y, other]), b: toWorld(b, [x, y, cur]), tick: [0.6, 0.6, 0], text: `高差 ${fmt(final - other)}${label}`, on5: snap !== null };
  }, [start], { preview: (v) => { const b: Box = JSON.parse(d.orig.get(d.id)!); setEnd(b, v[0]); return [b]; } });
  dragInfo = `坡：长 ${fmt(len)} · 高差 ${fmt(Math.abs(final - other))}`;
}

/** 鼠标在直轨的哪一头：Ctrl / Alt 拖动时改靠近鼠标的那头 */
function railEndAt(r: RailElem, p: THREE.Vector3): 0 | 1 {
  const h = (r.heading * Math.PI) / 180;
  return (p.x - r.x) * Math.cos(h) + (p.y - r.y) * Math.sin(h) < r.pieces[0].len / 2 ? 0 : 1;
}

/** Alt 拖直轨：抬高 / 压低靠近鼠标的那一头，另一头不动。吸附：高差为 5 的倍数、放平、别的路面 / 钢轨在这一头的高度 */
function railTiltTo(d: Extract<Drag, { t: 'railTilt' }>, p: THREE.Vector3) {
  const o = JSON.parse(d.orig.get(d.id)!) as RailElem;
  const pc = o.pieces[0];
  const s1 = advance({ x: o.x, y: o.y, z: o.z, heading: o.heading }, pc);
  const end = d.end ? s1 : { x: o.x, y: o.y };
  const start = d.end ? s1.z : o.z, other = d.end ? o.z : s1.z;
  let raw = start + (p.z - d.start.z);
  if (gridOn) raw = snapG(raw);
  raw = Math.round(raw * 1000) / 1000;
  const thr = worldPerPx(p) * SIZE5_PX;
  const cands: number[] = [other];
  const k5 = Math.round((raw - other) / 5);
  if (k5 !== 0) cands.push(other + k5 * 5);
  const top = o.side ? RAIL_RADIUS : 0; // 侧轨的路径比路面低一个钢轨半径
  for (const x of Object.values(doc.elems)) {
    if (x.id === o.id) continue;
    if (x.kind === 'box' && !x.q) { const f = footprint(x); const [ex, ey] = toLocal(x, [end.x, end.y, 0]); if (ex > f.x0 - 0.5 && ex < f.x1 + 0.5 && ey > f.y0 - 0.5 && ey < f.y1 + 0.5) cands.push(boxTopAt(x, Math.min(Math.max(ex, f.x0), f.x1), Math.min(Math.max(ey, f.y0), f.y1)) - top); }
    if (x.kind === 'rail' && !x.q) {
      // 别的钢轨在这一头的高度：两根轨的截面中心对齐（侧轨的路径就是截面中心，普通钢轨的路径是轨顶）
      let s: RailState = { x: x.x, y: x.y, z: x.z, heading: x.heading };
      const ends = [s];
      for (const pc2 of x.pieces) s = advance(s, pc2);
      ends.push(s);
      for (const q of ends) if (Math.hypot(q.x - end.x, q.y - end.y) < 0.5) cands.push(q.z + (x.side ? 0 : -RAIL_RADIUS) + (o.side ? 0 : RAIL_RADIUS));
    }
  }
  const best = cands.filter((v) => Math.abs(v - raw) < thr).sort((a, b) => Math.abs(a - raw) - Math.abs(b - raw))[0];
  const snap = best ?? null;
  const final = snap ?? raw;
  drive([raw], snap === null ? null : [snap], (v) => {
    restore(d.orig);
    const r = doc.elems[d.id] as RailElem;
    const cur = Math.round(v[0] * 1000) / 1000;
    if (d.end) r.pieces[0].dz = Math.round((cur - r.z) * 1000) / 1000;
    else { r.z = cur; r.pieces[0].dz = Math.round((other - cur) * 1000) / 1000; }
    measure = { a: [end.x, end.y, other], b: [end.x, end.y, v[0]], tick: [0.6, 0.6, 0], text: `高差 ${fmt(final - other)}`, on5: snap !== null };
  }, [start]);
  dragInfo = `直轨：长 ${fmt(pc.len)} · 高差 ${fmt(final - other)}`;
}

/** 开始拖护栏的一头（end：0 起点 / 1 终点）：另一头固定，沿外沿改长度 */
function startGuardLen(id: number, end: 0 | 1): boolean {
  const g = doc.elems[id] as Extract<Elem, { kind: 'guard' }>;
  const fixedP = end === 0 ? g.pts[g.pts.length - 1] : g.pts[0];
  const movP = end === 0 ? g.pts[0] : g.pts[g.pts.length - 1];
  const pf = project(lastSolved.loops, fixedP, 1);
  if (!pf) return false;
  const l = lastSolved.loops[pf.loop];
  const pm = project([l], movP, 1);
  if (!pm) return false;
  // 展开弧长：终点在起点之后（闭合环上可能要加一圈）
  let sNear = pm.s;
  if (l.closed) { if (end === 1 && sNear <= pf.s) sNear += l.len; if (end === 0 && sNear >= pf.s) sNear -= l.len; }
  drag = { t: 'guardLen', id, orig: origOf([id]), plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -movP[2]), loop: pf.loop, sFixed: pf.s, sNear, moveB: end === 1 };
  return true;
}

/** 拖护栏的一头：沿外沿走；格栅开着时长度取整；长度靠近 5 的倍数、或者走到外沿的拐角时磁吸 */
function guardLenTo(d: Extract<Drag, { t: 'guardLen' }>, p: THREE.Vector3) {
  const l = lastSolved.loops[d.loop];
  if (!l) return;
  const sgn = d.moveB ? 1 : -1;
  let s = projectNear(l, p.x, p.y, d.sNear);
  // 不能越过固定的那一头
  if ((s - d.sFixed) * sgn < 0.2) s = d.sFixed + sgn * 0.2;
  if (l.closed && Math.abs(s - d.sFixed) > l.len - 0.2) s = d.sFixed + sgn * (l.len - 0.2);
  d.sNear = s;
  let len = Math.abs(s - d.sFixed);
  if (gridOn) len = Math.max(prefs.gridStep, snapG(len));
  const raw = d.sFixed + sgn * len;
  const thr = worldPerPx(p) * SIZE5_PX;
  const cands: number[] = [];
  const L5 = Math.round(len / 5) * 5;
  if (L5 > 0) cands.push(d.sFixed + sgn * L5);
  // 外沿的拐角（展开到 raw 附近）
  const base = l.closed ? Math.floor(raw / l.len) * l.len : 0;
  for (const c of l.cum) for (const k of l.closed ? [-1, 0, 1] : [0]) cands.push(base + c + k * l.len);
  const snap = cands.filter((c) => Math.abs(c - raw) < thr && (c - d.sFixed) * sgn > 0.2).sort((a, b) => Math.abs(a - raw) - Math.abs(b - raw))[0] ?? null;
  const final = snap ?? raw;
  drive([raw], snap === null ? null : [snap], (v) => {
    restore(d.orig);
    const g = doc.elems[d.id] as Extract<Elem, { kind: 'guard' }>;
    const r = d.moveB ? pathAlong(l, d.sFixed, v[0]) : pathAlong(l, v[0], d.sFixed);
    if (r.pts.length < 2) return;
    g.pts = r.pts.map((q) => [...q] as P3);
    g.outs = r.outs.map((o) => [...o] as [number, number]);
    [g.x, g.y, g.z] = g.pts[0];
  }, [raw]);
  dragInfo = `护栏长 ${fmt(Math.abs(final - d.sFixed))}${snap !== null ? '（吸附）' : ''}`;
}

/** Ctrl 拖钢轨：沿钢轨末端方向拉长 / 缩短最后一段直线（最后一段是弯道时接一段新的直线）；长度靠近 5 的倍数时磁吸 */
function railLenTo(d: Extract<Drag, { t: 'railLen' }>, p: THREE.Vector3) {
  const o = JSON.parse(d.orig.get(d.id)!) as RailElem;
  const h = (o.heading * Math.PI) / 180, cx = Math.cos(h), cy = Math.sin(h);
  const along = (p.x - d.start.x) * cx + (p.y - d.start.y) * cy;
  const base = o.pieces[0].len;
  let raw = Math.max(0.5, base + (d.end ? along : -along));
  if (gridOn) raw = Math.max(prefs.gridStep, snapG(raw));
  raw = Math.round(raw * 1000) / 1000;
  const L5 = Math.round(raw / 5) * 5;
  const snap = L5 > 0 && Math.abs(raw - L5) < worldPerPx(p) * SIZE5_PX ? L5 : null;
  drive([raw], snap === null ? null : [snap], (v) => {
    restore(d.orig);
    const r = doc.elems[d.id] as RailElem;
    const len = Math.round(v[0] * 1000) / 1000;
    // 拖起点那头：终点不动，起点沿轨道挪
    if (!d.end) { r.x = o.x + cx * (base - len); r.y = o.y + cy * (base - len); }
    r.pieces[0].len = len;
    // 测量线：沿轨道，数字是松手后的长度
    const s0 = { x: r.x, y: r.y, z: r.z, heading: r.heading }, s1 = advance(s0, r.pieces[0]);
    measure = { a: [s0.x, s0.y, s0.z + 0.05], b: [s1.x, s1.y, s1.z + 0.05], tick: [-cy * 0.6, cx * 0.6, 0], text: fmt(snap ?? raw), on5: snap !== null };
  }, [base]);
  dragInfo = `钢轨长 ${fmt(snap ?? raw)}`;
}

window.addEventListener('pointerup', (e) => {
  if (guardDrag && e.button === 0) { guardUp(e); return; }
  if (!drag || e.button !== 0) return;
  if ((drag.t === 'grab' || drag.t === 'rotate') && drag.gz) { finishDrag(); moveGizmo.setHot(null); rotGizmo.setHot(null); return; } // 拖手柄 / 在模式里拖东西：松手就确定
  if (drag.t === 'grab' || drag.t === 'rotate') return; // 移动 / 旋转模式：按下时已经确定，或者还在模式里
  if (drag.t === 'place') { placeEnd(e); return; }
  if (drag.t === 'marquee') { finishMarquee(drag, e); return; }
  if (drag.t === 'click') {
    // 点选：点中的东西（连同绑定组）成为选择；Shift 加选 / 减选；点空白处清空
    const { id, add } = drag;
    drag = null;
    if (id === null) { if (!add) sel.clear(); }
    else {
      const group = expandGroups(doc, [id]);
      if (!add) sel = group;
      else if ([...group].every((g) => sel.has(g))) for (const g of group) sel.delete(g);
      else for (const g of group) sel.add(g);
    }
    drawOverlay(); syncProps(); updateStatus();
    // 自动追踪：点中的东西（连同绑定组）移到视图中心；Shift 减选掉的不追
    if (prefs.followPick && id !== null && sel.has(id)) followTo(expandGroups(doc, [id]));
    return;
  }
  finishDrag();
});

function finishDrag() {
  // 松手：落到最终位置（能吸附就正好对准；文档里本来就是最终位置）
  if (anim && !anim.applied) anim.apply(anim.final);
  anim = null;
  snapping = false;
  if (drag && 'orig' in drag && drag.orig && !(drag.t === 'grab' && drag.dup)) {
    if ([...drag.orig].every(([id, s]) => JSON.stringify(doc.elems[id]) === s)) undo.pop();
  }
  drag = null;
  guides = []; axisLine = null; snapTarget = null; snapGrab = null; dragInfo = ''; measure = null;
  syncRotLine();
  rebuild();
}

// ---------------- 框选 ----------------

function showMarquee(x0: number, y0: number, x1: number, y1: number) {
  // 框是画在视图里的（position: absolute），换成相对视图的坐标
  const r = host.getBoundingClientRect();
  marqueeEl.classList.add('open', 'shown');
  Object.assign(marqueeEl.style, { left: `${Math.min(x0, x1) - r.left}px`, top: `${Math.min(y0, y1) - r.top}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
}
function finishMarquee(d: { sx: number; sy: number; add: boolean }, e: PointerEvent) {
  marqueeEl.classList.remove('shown');
  setTimeout(() => { if (!marqueeEl.classList.contains('shown')) marqueeEl.classList.remove('open'); }, 120);
  drag = null;
  const [x0, x1] = [Math.min(d.sx, e.clientX), Math.max(d.sx, e.clientX)], [y0, y1] = [Math.min(d.sy, e.clientY), Math.max(d.sy, e.clientY)];
  if (x1 - x0 < 4 && y1 - y0 < 4) { if (!d.add) sel.clear(); drawOverlay(); syncProps(); updateStatus(); return; }
  // 框住元素顶面的中心、或者它的任何一个顶点就算选中
  const hit: number[] = [];
  const inRect = (s: THREE.Vector2) => s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1;
  for (const it of Object.values(doc.elems)) {
    const b = elemBounds(it);
    if (inRect(toScreen([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.z1])) || feats(it).verts.some((v) => inRect(toScreen(v)))) hit.push(it.id);
  }
  const got = expandGroups(doc, hit);
  sel = d.add ? new Set([...sel, ...got]) : got;
  drawOverlay(); syncProps(); updateStatus();
}

// ---------------- 从顶栏拖进来放置 ----------------

function newElems(type: string): Elem[] {
  const id = doc.nextId++;
  if (type === 'transition' || type === 'transition-narrow' || type === 'start' || type === 'check') return [{ id, kind: 'piece', type: type as PieceType, x: 0, y: 0, z: 0, rot: 0 }];
  if (type.startsWith('obj:')) {
    const t = type.slice(4);
    return [{ id, kind: 'obj', type: t, x: 0, y: 0, z: 0, rot: 0, sector: objType(t)?.cat === 'module' && t !== 'PE_Balloon' ? placeSector : undefined }];
  }
  if (type.startsWith('asset:')) return [{ id, kind: 'asset', name: type.slice(6), x: 0, y: 0, z: 0, rot: 0 }];
  if (type === 'zone') return [{ id, kind: 'zone', x: 0, y: 0, z: 0, sx: 10, sy: 10, depth: 5 }];
  if (type === 'rail') return [{ id, kind: 'rail', x: 0, y: 0, z: 0, heading: 0, pieces: [{ kind: 'double', len: 10, radius: 0, angle: 0, dz: 0 }] }];
  if (type === 'rail-curve') return [{ id, kind: 'rail', x: 0, y: 0, z: 0, heading: 0, pieces: [{ kind: 'double', len: 0, radius: 5, angle: 90, dz: 0 }] }];
  if (type === 'side-rail') return [{ id, kind: 'rail', x: 0, y: 0, z: 0, heading: 0, pieces: [{ kind: 'double', len: 20, radius: 0, angle: 0, dz: 0 }], side: { dir: -1, ends: [false, false] } }];
  if (type === 'side-spiral') return [{ id, kind: 'rail', x: 0, y: 0, z: 0, heading: 0, pieces: [{ kind: 'mono', len: 0, radius: SPIRAL_RADIUS, angle: 720, dz: 2 * SIDE_SPIRAL_SCREW }], sideSpiral: true }];
  if (type === 'rail-spiral') return [{ id, kind: 'rail', x: 0, y: 0, z: 0, heading: 0, pieces: [{ kind: 'double', len: 0, radius: SPIRAL_RADIUS, angle: 360, dz: SPIRAL_SCREW }] }];
  return [{ id, kind: 'box', x: 0, y: 0, z: 0, sx: 10, sy: 5, depth: 5, style: type as Style }];
}

/** 新放的东西的「抓手」：机关是对准方块顶面中心，其余是顶面最小角 */
function handleOf(e: Elem): P3 {
  if (e.kind === 'asset') { const b = elemBounds(e), st = assetInfo(e.name)?.snapTop; return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, st === undefined ? b.z1 : e.z + st]; }
  if (e.kind === 'rail') return [e.x, e.y, e.z];
  if (isCheckpoint(e)) return toWorld(e, [e.x, e.y, e.z]);
  if (e.kind === 'obj') {
    const a = anchorRects(e)[0];
    return toWorld(e, a ? [(a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2, a.top] : [e.x, e.y, e.z]);
  }
  const b = elemBounds(e);
  return [b.x0, b.y0, b.z1];
}

function startPlace(type: string) {
  if (type === 'start' && Object.values(doc.elems).some((e) => e.kind === 'piece' && e.type === 'start')) { flash('全图只能有一个起点', true); return; }
  // 死亡区正隐藏着：放下去也看不到，提醒一下，顶栏的「死亡区」按钮闪几下
  if (type === 'zone' && !zonesOn) {
    flash('死亡区当前是隐藏的，放下后看不到——在顶栏的「显示」里打开', true);
    viewAttn();
  }

  if (!skyOn && type.startsWith('asset:') && assetInfo(type.slice(6))?.sky) {
    flash('云层当前是隐藏的，放下后看不到——在顶栏的「显示」里打开', true);
    viewAttn();
  }
  drag = { t: 'place', ids: null, type, moved: false, rotOff: 0 };
  document.body.classList.add('placing');
}
function placeMove(e: PointerEvent) {
  if (drag?.t !== 'place') return;
  const over = document.elementFromPoint(e.clientX, e.clientY) === el;
  if (!over) return;
  // 触摸屏：卡片真的拖进视图了，素材库收起来，整个视图都能放（轻点卡片放到视图中心时不收）
  if (!drag.moved && touchUI && !prefs.folded) toggleFold();
  drag.moved = true;
  if (drag.ids === null) {
    snapshot();
    const es = newElems(drag.type);
    for (const n of es) doc.elems[n.id] = n;
    drag.ids = es.map((n) => n.id);
    drag.orig = origOf(drag.ids);
    sel = new Set(drag.ids);
  }
  const ids = new Set(drag.ids);
  const orig = drag.orig!;
  // 鼠标下的路面顶面（或地面）
  // 鼠标下的路面：按每块平路面的顶面平面求交（不看网格，凹槽里被底座挖掉的洞也算在路面上）
  let h = pick(e, ids);
  setRay(e);
  let top: { id: number; p: THREE.Vector3; d: number } | null = null;
  for (const x of Object.values(doc.elems)) {
    if (x.kind !== 'box' || x.slope || x.q || ids.has(x.id)) continue;
    const q = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -x.z), new THREE.Vector3());
    const lq = q && toLocal(x, [q.x, q.y, q.z]);
    if (!q || !lq || lq[0] < x.x || lq[0] > x.x + x.sx || lq[1] < x.y || lq[1] > x.y + x.sy) continue;
    const d = q.distanceTo(camera.position);
    if (!top || d < top.d) top = { id: x.id, p: q, d };
  }
  if (top && (!h || top.d <= h.p.distanceTo(camera.position) + 0.01)) h = { id: top.id, p: top.p };
  const p = h?.p ?? planeHit(e, new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)) ?? new THREE.Vector3();
  // 机关按鼠标下那条路的方向摆（沿路）；栅栏横跨路面；拖动中按 R 再转 90°
  const under = h ? doc.elems[h.id] : null;
  for (const [id, js] of orig) {
    const o = JSON.parse(js) as Elem;
    if (o.kind !== 'obj' && o.kind !== 'rail' && o.kind !== 'asset') continue;
    // 顺着鼠标下那块路面摆（转过的路面上也是顺着路）
    const axis = under?.kind === 'box' ? (under.slope ? under.slope.axis : under.sx >= under.sy ? 0 : 1) : 0;
    const frame = under?.kind === 'box' && !under.q ? under.ang : undefined;
    if (o.kind === 'rail') o.heading = ((axis + drag.rotOff) % 4) * 90 + (frame ?? 0);
    else { o.rot = ((axis + (o.kind === 'obj' && o.type === 'P_Modul_01' ? 1 : 0) + drag.rotOff) % 4) as Dir; o.ang = frame; }
    orig.set(id, JSON.stringify(o));
  }
  restore(orig);
  const sr = doc.elems[drag.ids[0]];
  if (sr.kind === 'rail' && sr.side && under?.kind === 'box' && !under.q && !under.slope) {
    // 侧轨：贴住鼠标下那块路面离鼠标最近的那条边——下轨嵌在棱角里（外接正方形靠上轨的顶点在棱角上），顺着这条边，上轨偏向路外
    const f = footprint(under);
    const lp = toLocal(under, [p.x, p.y, p.z]);
    const ds = [f.x1 - lp[0], f.y1 - lp[1], lp[0] - f.x0, lp[1] - f.y0];
    const d = ds.indexOf(Math.min(...ds)) as Dir;
    const n = [DX[d], DY[d]], tdir = [-n[1], n[0]];
    const len = sr.pieces[0].len;
    const along = d % 2 === 0 ? lp[1] : lp[0];
    const lo = d % 2 === 0 ? f.y0 : f.x0, hi = d % 2 === 0 ? f.y1 : f.x1;
    // 起点：鼠标所在位置往回半段，夹在这条边的范围里（边比侧轨短时从边的一头开始）
    let t0 = along - (tdir[d % 2 === 0 ? 1 : 0] * len) / 2;
    const tMin = tdir[d % 2 === 0 ? 1 : 0] > 0 ? lo : lo + len, tMax = tdir[d % 2 === 0 ? 1 : 0] > 0 ? hi - len : hi;
    t0 = tMin <= tMax ? Math.min(Math.max(t0, tMin), tMax) : tMin;
    // 靠近这条边的两头时对齐到头
    if (Math.abs(t0 - tMin) < 1) t0 = tMin;
    else if (Math.abs(t0 - tMax) < 1) t0 = tMax;
    const edge = [f.x1, f.y1, f.x0, f.y0][d] - RAIL_RADIUS * (d < 2 ? 1 : -1);
    const local: P3 = d % 2 === 0 ? [edge, t0, under.z - RAIL_RADIUS] : [t0, edge, under.z - RAIL_RADIUS];
    const w = toWorld(under, local);
    const hdg = (Math.atan2(tdir[1], tdir[0]) * 180) / Math.PI + (under.ang ?? 0);
    // 上轨偏向路外：路外是 n，路径左侧是 tdir 转 90°
    const left = [-tdir[1], tdir[0]];
    const o = JSON.parse(orig.get(sr.id)!) as RailElem;
    Object.assign(o, { x: w[0], y: w[1], z: w[2], heading: ((hdg % 360) + 360) % 360, side: { ...o.side!, dir: left[0] * n[0] + left[1] * n[1] > 0 ? 1 : -1 } });
    doc.elems[sr.id] = o;
    anim = null;
    snapTarget = null;
    dragInfo = '侧轨贴住路边';
    rebuildWanted = true;
    return;
  }
  const hd = handleOf(doc.elems[drag.ids[0]]);
  // 变球器 / 风扇拖到凹路、细边框凹路上：底座顶面直接放到下沉 0.7 的槽底，嵌进凹槽
  const first = doc.elems[drag.ids[0]];
  let pz = p.z;
  if (first.kind === 'obj' && baseSpec(first.type)?.kind !== 'fence' && baseSpec(first.type) && under?.kind === 'box' && under.style !== 'normal' && !under.slope) pz = under.z - SINK_DEPTH;
  let raw: V3 = [p.x - hd[0], p.y - hd[1], pz - hd[2]];
  if (gridOn) { const b = boundsOf(doc, ids); raw = [snapG(b.x0 + raw[0]) - b.x0, snapG(b.y0 + raw[1]) - b.y0, raw[2]]; }
  // 自动吸附：新元素的顶点 / 边中点靠近别的元素的顶点、边中点或边就吸过去（磁吸，松手对准）
  moveSel(orig, raw);
  let best: { from: P3; to: P3; d: number; kind: 'v' | 'm' | 'e' } | null = null;
  for (const id of ids) {
    const f = feats(doc.elems[id]);
    for (const v of [...f.verts, ...f.mids]) {
      const s = toScreen(v);
      const t = findTarget(s.x, s.y, ids, 16);
      // 只吸差不多一样高的点：屏幕上挨着的点可能在路面底下（侧面、底边），吸过去会把东西埋进路里
      if (t && Math.abs(t.p[2] - v[2]) > 1) continue;
      if (t && (!best || t.d < best.d)) best = { from: v, to: t.p, d: t.d, kind: t.kind };
    }
  }
  const snap: V3 | null = best ? [raw[0] + best.to[0] - best.from[0], raw[1] + best.to[1] - best.from[1], raw[2] + best.to[2] - best.from[2]] : null;
  if (anim?.applied) moveSel(orig, anim.applied as V3); // 上面为了找吸附点临时挪过，先放回文档里的最终位置
  drive(raw, snap, (v) => moveSel(orig, v as V3), raw, { ids });
  snapTarget = best ? { p: best.to, kind: best.kind } : null;
}
function placeEnd(e: PointerEvent) {
  if (drag?.t !== 'place') return;
  const over = document.elementFromPoint(e.clientX, e.clientY) === el;
  document.body.classList.remove('placing');
  if (!drag.moved && !over && !drag.touch) {
    // 点击按钮：放到视图中心（手指按住又松开不算）
    snapshot();
    const es = newElems(drag.type);
    for (const n of es) doc.elems[n.id] = n;
    const ids = es.map((n) => n.id);
    const b = boundsOf(doc, ids);
    const g = (v: number) => (gridOn ? snapG(v) : v);
    for (const id of ids) translateElem(doc.elems[id], [g(controls.target.x - (b.x1 - b.x0) / 2) - b.x0, g(controls.target.y - (b.y1 - b.y0) / 2) - b.y0, 0]);
    sel = new Set(ids);
  } else if (drag.ids !== null && !over) { for (const id of drag.ids) delete doc.elems[id]; undo.pop(); sel.clear(); }
  // 放了小节盘点：顶栏的小节切到它激活的那个小节
  const placed = drag.ids?.map((id) => doc.elems[id]).find((x) => x?.kind === 'piece' && x.type === 'check');
  if (placed) placeSector = sectorOfCheck(placed.id);
  anim = null; snapping = false;
  drag = null; snapTarget = null;
  rebuild();
}
// ---------------- 素材库（侧边，可左可右；分标签） ----------------

/** 素材库里的一项：type 是 newElems 认的类型名 */
interface LibItem { type: string; label: string; hint: string; icon?: string }
const svgThumb = (body: string) => `<svg viewBox="0 0 64 64">${body}</svg>`;
// 路面 / 素材件 / 钢轨的简图（等轴测的小方块），机关和装饰用模型渲染的预览图
const ROAD_TOP = '#c9b48a', ROAD_SIDE = '#8a7558', SINK = '#9c8665', RAIL = '#aab4c2';
const slab = (top: string, inner?: string) => svgThumb(`<path d="M8 30 L32 18 L56 30 L32 42 Z" fill="${top}"/><path d="M8 30 L32 42 L32 52 L8 40 Z" fill="${ROAD_SIDE}"/><path d="M56 30 L32 42 L32 52 L56 40 Z" fill="#76634a"/>${inner ?? ''}`);
/** 道具：分数球、生命球、箱子、道具球 */
const PROP_TYPES = new Set(['P_Extra_Point', 'P_Extra_Life', 'P_Box', 'P_Ball_Paper', 'P_Ball_Stone', 'P_Ball_Wood']);
const ZONE_ICON = svgThumb('<path d="M32 10 L54 22 L54 44 L32 56 L10 44 L10 22 Z" fill="rgba(255,64,64,0.28)" stroke="#ff6a6a" stroke-width="2" stroke-linejoin="round"/><path d="M10 22 L32 34 L54 22 M32 34 V56" fill="none" stroke="#ff6a6a" stroke-width="1.6" opacity="0.8"/><path d="M26 39 l12 7 M38 39 l-12 7" stroke="#ff8a8a" stroke-width="2.4" stroke-linecap="round"/>');
/** 资产库里的特殊路面：tab 指定了放在哪个标签（特殊路块、旋转门放路面，交叉轨放钢轨），其余（木制件）在「木制」 */
function assetItems(tab?: 'road' | 'rail' | 'deco'): LibItem[] {
  return ASSET_INFO.filter((a) => a.tab === tab).map((a) => ({
    type: `asset:${a.name}`, label: a.label,
    hint: `${a.group === 'wood' ? '木制' : tab === 'rail' ? '钢轨' : tab === 'deco' ? '装饰' : '特殊路块'} · ${a.name}${a.stretch ? ' · Ctrl 拖可拉伸' : ''}`,
  }));
}
const LIB: { id: string; label: string; items: LibItem[] }[] = [
  {
    id: 'road', label: '路面', items: [
      { type: 'normal', label: '平路', hint: 'Ctrl 拖改尺寸，拖侧面下半截改厚度，Alt 拖一头做坡', icon: slab(ROAD_TOP, '<path d="M14 30 L32 21 L50 30 L32 39 Z" fill="#d8c8a2"/>') },
      { type: 'sink', label: '凹路', hint: '凹槽路面', icon: slab(ROAD_TOP, `<path d="M16 30 L32 22 L48 30 L32 38 Z" fill="${SINK}"/>`) },
      { type: 'ribbon', label: '细边框凹路', hint: '细边框凹槽平台', icon: slab(ROAD_TOP, '<path d="M12 30 L32 20 L52 30 L32 40 Z" fill="#b29d79"/>') },
      { type: 'transition', label: '平凹转换', hint: '长 5，一头平路一头凹路', icon: slab(ROAD_TOP, `<path d="M20 36 L44 24 L50 27 L26 39 Z" fill="${SINK}"/>`) },
      { type: 'transition-narrow', label: '窄转换', hint: '长 2.5，凹路接细边框平台', icon: slab(ROAD_TOP, `<path d="M26 33 L44 24 L48 26 L30 35 Z" fill="${SINK}"/>`) },
      ...assetItems('road'),
    ],
  },
  {
    id: 'rail', label: '钢轨', items: [
      { type: 'rail', label: '直轨', hint: 'Ctrl 拖改长度，Alt 拖做坡', icon: svgThumb(`<path d="M8 40 L48 20 M16 44 L56 24" stroke="${RAIL}" stroke-width="4" stroke-linecap="round"/>`) },
      { type: 'rail-curve', label: '弯轨', hint: '属性里调半径、角度', icon: svgThumb(`<path d="M10 46 Q10 18 40 14 M18 50 Q18 26 46 22" stroke="${RAIL}" stroke-width="4" fill="none" stroke-linecap="round"/>`) },
      { type: 'rail-spiral', label: '螺旋', hint: '属性里调圈数、半径', icon: svgThumb(`<path d="M32 52 C10 50 10 36 32 36 C54 36 54 22 32 22 C14 22 14 12 32 10" stroke="${RAIL}" stroke-width="4" fill="none" stroke-linecap="round"/>`) },
      { type: 'side-rail', label: '侧轨', hint: '两根成角度的钢轨，拖到路面上会贴住最近的路边；属性里可以让上轨两头弯下去固定在路边', icon: svgThumb(`<path d="M8 46 L48 26" stroke="${RAIL}" stroke-width="4" stroke-linecap="round"/><path d="M14 30 L54 10" stroke="${RAIL}" stroke-width="4" stroke-linecap="round"/>`) },
      { type: 'side-spiral', label: '螺旋侧轨', hint: '单轨螺旋，层间距固定 3.6', icon: svgThumb(`<path d="M32 50 C12 48 12 38 32 38 C52 38 52 28 32 28 C14 28 14 18 32 16" stroke="${RAIL}" stroke-width="4" fill="none" stroke-linecap="round"/>`) },
      ...assetItems('rail'),
    ],
  },
  { id: 'wood', label: '木制', items: assetItems() },
  {
    id: 'module', label: '机关', items: [
      { type: 'start', label: '起点', hint: '四火，全图一个', icon: svgThumb('<ellipse cx="32" cy="34" rx="22" ry="12" fill="#a99a86"/><ellipse cx="32" cy="32" rx="14" ry="7" fill="#e3a35a"/><path d="M28 30 L32 10 L36 30 Z" fill="#f0b46e"/>') },
      { type: 'check', label: '小节', hint: '两火，按放置顺序编小节号', icon: svgThumb('<ellipse cx="32" cy="34" rx="20" ry="11" fill="#a99a86"/><ellipse cx="32" cy="32" rx="12" ry="6" fill="#e3a35a"/><path d="M14 32 L18 14 L22 32 Z M42 32 L46 14 L50 32 Z" fill="#f0b46e"/>') },
      ...OBJ_TYPES.filter((t) => t.cat === 'module' && !PROP_TYPES.has(t.type)).map((t) => ({ type: `obj:${t.type}`, label: t.label, hint: `${t.type}${baseSpec(t.type) ? ' · 自带专属路块' : ''}` })),
      { type: 'zone', label: '死亡区', hint: '球碰到就死 · 导出时自动隐藏（DepthTestCubes）', icon: ZONE_ICON },
    ],
  },
  { id: 'prop', label: '道具', items: OBJ_TYPES.filter((t) => PROP_TYPES.has(t.type)).map((t) => ({ type: `obj:${t.type}`, label: t.label, hint: `${t.type}${baseSpec(t.type) ? ' · 自带专属路块' : ''}` })) },
  { id: 'deco', label: '装饰', items: [...OBJ_TYPES.filter((t) => t.cat === 'deco').map((t) => ({ type: `obj:${t.type}`, label: t.label, hint: t.type })), ...assetItems('deco')] },
];
/** 素材卡片悬停时按 F1 跳到哪一节教程 */
function helpOf(type: string): string {
  if (type === 'zone') return '2.5';
  if (type.startsWith('rail') || type.startsWith('side-') || /^asset:(Rail|Monorail)/.test(type)) return '2.2';
  if (type === 'start' || type === 'check' || type.startsWith('obj:')) return objType(type.slice(4))?.cat === 'deco' ? '2.4' : '2.3';
  if (type.startsWith('asset:') && assetInfo(type.slice(6))?.tab === 'deco') return '2.4';
  return '2.1';
}
const palette = document.getElementById('palette')!;
palette.innerHTML = `
  <div class="lib-head">
    <span class="title">素材库</span>
    <span class="lib-dock">
      <button data-dock="left" title="停靠在左边"><svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.5" /><path class="fill" d="M3 4h3.5v8H3z" /></svg></button>
      <button data-dock="bottom" title="停靠在底部"><svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.5" /><path class="fill" d="M3 8.5h10V12H3z" /></svg></button>
      <button data-dock="right" title="停靠在右边"><svg viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="1.5" /><path class="fill" d="M9.5 4H13v8H9.5z" /></svg></button>
    </span>
    <button class="fold" id="lib-fold" title="收起 / 展开"><svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" /></svg></button>
  </div>
  <div class="lib-tabs">${LIB.map((g) => `<button data-tab="${g.id}">${g.label}<small>${g.items.length}</small></button>`).join('')}</div>
  <div class="lib-search"><input type="search" placeholder="搜索名称或代号…" /></div>
  <div class="lib-body"><div class="lib-grid"></div><div class="lib-empty" hidden>没有匹配的素材</div></div>
  <div class="lib-foot">按住卡片拖到场景里放下（拖动中 R 旋转、右键取消）· 点一下放到视图中心</div>`;
const libGrid = palette.querySelector<HTMLElement>('.lib-grid')!;
const libEmpty = palette.querySelector<HTMLElement>('.lib-empty')!;
const libSearch = palette.querySelector<HTMLInputElement>('.lib-search input')!;
/** 卡片说明里写的 Ctrl、Alt 换成现在的按键 */
const keyHint = (t: string) => t.replace(/\bCtrl\b/g, keyText('hold.stretch')).replace(/\bAlt\b/g, keyText('hold.slope'));
function renderLib() {
  const q = libSearch.value.trim().toLowerCase();
  // 搜索时跨所有标签找；不搜索时只显示当前标签
  const items = q ? LIB.flatMap((g) => g.items).filter((it) => `${it.label} ${it.hint}`.toLowerCase().includes(q)) : (LIB.find((g) => g.id === prefs.tab) ?? LIB[0]).items;
  palette.querySelectorAll<HTMLButtonElement>('.lib-tabs button').forEach((b) => b.classList.toggle('on', !q && b.dataset.tab === prefs.tab));
  libGrid.innerHTML = items.map((it) => `<div class="lib-card" data-type="${it.type}" data-help="${helpOf(it.type)}" title="${it.label}
${keyHint(it.hint)}"><div class="thumb">${it.icon ?? ''}</div><span>${it.label}</span></div>`).join('');
  libEmpty.hidden = items.length > 0;
  fillThumbs();
}
function fillThumbs() {
  for (const c of libGrid.querySelectorAll<HTMLElement>('.lib-card')) {
    const t = c.dataset.type!;
    const box = c.querySelector<HTMLElement>('.thumb')!;
    const url = ROAD_TYPES.has(t) ? roadThumb(t) : t.startsWith('obj:') || t.startsWith('asset:') ? thumbnail(t.slice(t.indexOf(':') + 1), modelView ? 'model' : 'placeholder') : null;
    // 已经是这张图就不动（改 DOM 会打断鼠标悬停的提示）
    if (url && box.dataset.img !== url) { box.dataset.img = url; box.innerHTML = ''; box.style.setProperty('--img', `url(${url})`); box.classList.add('loaded'); }
  }
}
/** 路面类素材的预览：一块 5×5×5 的方块（窄转换长 2.5），用求解器生成网格、真实的路面贴图渲染 */
const ROAD_TYPES = new Set(['normal', 'sink', 'ribbon', 'transition', 'transition-narrow']);
const roadThumbCache = new Map<string, string>();
let roadTexReady = false;
floorTexturesReady().then(() => { roadTexReady = true; fillThumbs(); });
function roadThumb(type: string): string | null {
  const hit = roadThumbCache.get(type);
  if (hit) return hit;
  if (!roadTexReady) return null;
  const e: Elem = type === 'transition' || type === 'transition-narrow'
    ? { id: 1, kind: 'piece', type, x: 0, y: 0, z: 0, rot: 0 }
    : { id: 1, kind: 'box', x: -2.5, y: -2.5, z: 0, sx: 5, sy: 5, depth: 5, style: type as Style };
  const g = new THREE.Group();
  for (const m of solve({ elems: { 1: e }, nextId: 2 }).meshes.values()) {
    for (const [mat, part] of Object.entries(m.parts) as [MatName, { pos: number[]; uv: number[] }][]) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(part.uv, 2));
      geo.computeVertexNormals();
      g.add(new THREE.Mesh(geo, getMaterial(mat)));
    }
  }
  const url = renderThumb(g);
  g.traverse((o) => (o as THREE.Mesh).geometry?.dispose());
  roadThumbCache.set(type, url);
  return url;
}
palette.querySelector('.lib-tabs')!.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>('button[data-tab]');
  if (!b) return;
  prefs.tab = b.dataset.tab!; savePrefs();
  libSearch.value = '';
  renderLib();
});
libSearch.addEventListener('input', renderLib);
libGrid.addEventListener('pointerdown', (e) => {
  const c = (e.target as Element).closest<HTMLElement>('.lib-card');
  if (!c || e.button !== 0) return;
  if (e.pointerType === 'touch') {
    const quiet = libFling !== 0; // 正在惯性滚动：这一下只是按停，不算点卡片
    cancelAnimationFrame(libFling); libFling = 0;
    cardPress = { id: e.pointerId, type: c.dataset.type!, x: e.clientX, y: e.clientY, timer: window.setTimeout(liftCard, CARD_HOLD_MS), quiet, scroll: null };
    return;
  }
  e.preventDefault();
  startPlace(c.dataset.type!);
});
// 手机上卡片要让位给滑动翻页：竖着滑是翻页，轻点什么都不放；按住一会儿，或者横着拖出来，才开始摆放。
// 滚动自己做（卡片是 touch-action: none）：交给浏览器的话，按住之后再竖着拖会被它抢去滚动，停靠在底部时就拖不上去了
const CARD_HOLD_MS = 300;
let cardPress: { id: number; type: string; x: number; y: number; timer: number; quiet: boolean; scroll: { top: number; y0: number; y: number; t: number; v: number } | null } | null = null;
let libFling = 0;
const libBody = palette.querySelector<HTMLElement>('.lib-body')!;
function liftCard() {
  if (!cardPress) return;
  clearTimeout(cardPress.timer);
  const { type } = cardPress;
  cardPress = null;
  if (drag) return;
  startPlace(type);
  const d = drag as Drag | null; // startPlace 刚设的，TS 看不出来
  if (d?.t === 'place') { d.touch = true; navigator.vibrate?.(12); }
}
function dropCardPress() { if (cardPress) { clearTimeout(cardPress.timer); cardPress = null; } }
/** 松手后接着滑一段，慢慢停下 */
function flingLib(v: number) {
  let last = performance.now();
  const step = (now: number) => {
    const dt = now - last;
    last = now;
    libBody.scrollTop += v * dt;
    v *= Math.pow(0.95, dt / 16);
    libFling = Math.abs(v) > 0.03 ? requestAnimationFrame(step) : 0;
  };
  libFling = requestAnimationFrame(step);
}
window.addEventListener('pointermove', (e) => {
  const p = cardPress;
  if (!p || e.pointerId !== p.id) return;
  if (!p.scroll) {
    const dx = Math.abs(e.clientX - p.x), dy = Math.abs(e.clientY - p.y);
    if (dx > 12 && dx > dy) { liftCard(); return; }
    if (dy <= 8) return;
    clearTimeout(p.timer);
    p.scroll = { top: libBody.scrollTop, y0: e.clientY, y: e.clientY, t: performance.now(), v: 0 };
    return;
  }
  const sc = p.scroll, now = performance.now(), dt = Math.max(1, now - sc.t);
  libBody.scrollTop = sc.top - (e.clientY - sc.y0);
  sc.v = sc.v * 0.6 + ((sc.y - e.clientY) / dt) * 0.4;
  sc.y = e.clientY; sc.t = now;
}, true);
window.addEventListener('pointerup', (e) => {
  const p = cardPress;
  if (!p || e.pointerId !== p.id) return;
  dropCardPress();
  if (p.scroll) { if (performance.now() - p.scroll.t < 80 && Math.abs(p.scroll.v) > 0.1) flingLib(p.scroll.v); }
  else if (!p.quiet) flash('按住卡片，或者横着拖出来，放到场景里');
}, true);
window.addEventListener('pointercancel', (e) => {
  if (e.pointerId === cardPress?.id) dropCardPress();
  if (e.pointerType === 'touch' && drag?.t === 'place' && drag.touch) placeEnd(e);
}, true);
libGrid.addEventListener('contextmenu', (e) => e.preventDefault());
/** 收起 / 展开：内容先淡出，大小缓动到位后再换内容淡入（见 app.css 的 .hiding / .narrow / .folded） */
const FOLD_MS = 200;
let foldSeq = 0;
function toggleFold() {
  const fold = !prefs.folded;
  prefs.folded = fold; savePrefs();
  const t = ++foldSeq;
  palette.classList.add('hiding');
  if (fold) palette.classList.add('narrow');
  else palette.classList.remove('folded', 'narrow');
  setTimeout(() => {
    if (t !== foldSeq) return; // 动画中途又点了一下，以后一次为准
    if (fold) palette.classList.add('folded');
    palette.classList.remove('hiding');
  }, FOLD_MS);
}
palette.querySelector('#lib-fold')!.addEventListener('click', (e) => { e.stopPropagation(); toggleFold(); });
// 收起时点哪里都能展开
palette.addEventListener('click', () => { if (palette.classList.contains('folded')) toggleFold(); });
palette.classList.toggle('folded', prefs.folded);
palette.classList.toggle('narrow', prefs.folded);
palette.querySelector<HTMLElement>('.lib-head .title')!.title = touchUI ? '竖着滑动翻页；按住卡片或横着拖出来，放到场景里' : '按住卡片拖到场景里放下（拖动中 R 旋转、右键取消），点一下放到视图中心';
// 拖素材库的内侧边缘改宽度（在底部时改高度），双击恢复默认
const libResize = document.createElement('div');
libResize.className = 'lib-resize';
libResize.title = '拖动改大小，双击恢复默认';
palette.appendChild(libResize);
function applyLibSize() {
  palette.style.setProperty('--lib-w', `${prefs.libW}px`);
  palette.style.setProperty('--lib-h', `${prefs.libH}px`);
}
libResize.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  libResize.setPointerCapture(e.pointerId);
  libResize.classList.add('on');
  document.body.classList.add('lib-resizing');
  document.body.classList.toggle('ns', prefs.side === 'bottom');
  const r = palette.getBoundingClientRect(), work = palette.parentElement!.getBoundingClientRect();
  const move = (ev: PointerEvent) => {
    if (prefs.side === 'bottom') prefs.libH = Math.round(Math.min(Math.max(r.bottom - ev.clientY, 120), work.height * 0.7));
    else prefs.libW = Math.round(Math.min(Math.max(prefs.side === 'right' ? r.right - ev.clientX : ev.clientX - r.left, 200), Math.min(640, work.width * 0.5)));
    applyLibSize();
  };
  const up = () => {
    libResize.classList.remove('on');
    document.body.classList.remove('lib-resizing', 'ns');
    libResize.removeEventListener('pointermove', move);
    savePrefs();
  };
  libResize.addEventListener('pointermove', move);
  libResize.addEventListener('pointerup', up, { once: true });
  libResize.addEventListener('pointercancel', up, { once: true });
});
libResize.addEventListener('dblclick', () => {
  if (prefs.side === 'bottom') prefs.libH = LIB_H; else prefs.libW = LIB_W;
  applyLibSize(); savePrefs();
});
applyLibSize();
setAssetLoadedCallback(fillThumbs);
setTextureLoadedCallback(fillThumbs);
/** 素材库在左边、右边还是底部：嵌在视图旁边。属性面板放在视图里素材库的另一边（素材库在底部时放左边） */
function applySide() {
  const work = document.getElementById('work')!;
  // 触摸屏横着拿时太矮，停靠底部按右边算
  const side = touchUI && prefs.side === 'bottom' ? 'right' : prefs.side;
  work.classList.remove('dock-left', 'dock-right', 'dock-bottom');
  work.classList.add(`dock-${side}`);
  props.classList.toggle('right', side === 'left');
  palette.querySelectorAll<HTMLButtonElement>('.lib-dock button').forEach((b) => b.classList.toggle('on', b.dataset.dock === side));
}
// 标题栏上的停靠按钮：左 / 下 / 右
palette.querySelector('.lib-dock')!.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>('button[data-dock]');
  if (!b) return;
  e.stopPropagation();
  b.blur();
  if (prefs.side === b.dataset.dock) return;
  prefs.side = b.dataset.dock as Prefs['side']; savePrefs();
  applySide();
});
applySide();
renderLib();
// 拖放中右键：取消。按住左键拖着卡片时再按右键，浏览器不发 pointerdown（同一个指针的第二个键只发 pointermove，
// button 是 2），所以两种都要接住
function cancelPlace(e: PointerEvent) {
  if (e.button !== 2 || drag?.t !== 'place') return;
  e.preventDefault(); e.stopPropagation();
  if (drag.ids) { for (const id of drag.ids) delete doc.elems[id]; undo.pop(); sel.clear(); }
  anim = null; snapping = false; drag = null; snapTarget = null;
  document.body.classList.remove('placing');
  rebuild();
}
window.addEventListener('pointerdown', cancelPlace, true);
window.addEventListener('pointermove', (e) => { if (e.button === 2 && e.buttons & 2) cancelPlace(e); }, true);

// ---------------- 切分 ----------------

function splitAt(e: { clientX: number; clientY: number }): { id: number; axis: 0 | 1; t: number } | null {
  const h = pick(e);
  const b = h && doc.elems[h.id];
  if (!h || b?.kind !== 'box' || b.q) return null;
  const axis: 0 | 1 = splitAxis ?? (b.sx >= b.sy ? 0 : 1);
  let t = toLocal(b, [h.p.x, h.p.y, h.p.z])[axis];
  t = gridOn && !b.ang ? snapG(t) : Math.round(t * 1000) / 1000;
  return { id: h.id, axis, t };
}
function splitHover(e: { clientX: number; clientY: number }) {
  const s = splitAt(e);
  splitPreview = null;
  if (s) {
    const b = doc.elems[s.id] as Box;
    const f = footprint(b);
    const top = (x: number, y: number): P3 => toWorld(b, [x, y, boxTopAt(b, x, y) + 0.02]);
    splitPreview = s.axis === 0 ? { a: top(s.t, f.y0), b: top(s.t, f.y1) } : { a: top(f.x0, s.t), b: top(f.x1, s.t) };
    const lo = s.axis === 0 ? f.x0 : f.y0, hi = s.axis === 0 ? f.x1 : f.y1;
    dragInfo = `切成 ${fmt(s.t - lo)} + ${fmt(hi - s.t)}`;
  } else dragInfo = '';
  hoverId = s?.id ?? null;
  drawOverlay(); updateStatus();
}
function doSplit(e: PointerEvent) {
  const s = splitAt(e);
  if (!s) return;
  snapshot();
  const n = splitBox(doc, s.id, s.axis, s.t);
  if (n === null) { undo.pop(); flash('太靠边了，切不开', true); return; }
  rebuild();
  if (e.pointerType !== 'touch') splitHover(e);
}
// ---------------- 护栏 ----------------

/** 鼠标下的路面顶面上的点（护栏工具用来找最近的外沿） */
function surfacePoint(e: { clientX: number; clientY: number }): P3 | null {
  const h = pick(e);
  if (h) return [h.p.x, h.p.y, h.p.z];
  return null;
}
/** 护栏工具里，鼠标下的护栏端头（屏幕上 18 像素以内）：可以拖它改长度 */
/** 路面开口的开关：选中一块路面时，四条边顶面的中点 */
type SideMode = 'auto' | 'open' | 'closed';
const sideMode = (b: Box, d: Dir): SideMode => ((b.open ?? 0) & (1 << d) ? 'open' : (b.closed ?? 0) & (1 << d) ? 'closed' : 'auto');
function setSideMode(b: Box, d: Dir, m: SideMode) {
  b.open = ((b.open ?? 0) & ~(1 << d)) | (m === 'open' ? 1 << d : 0) || undefined;
  b.closed = ((b.closed ?? 0) & ~(1 << d)) | (m === 'closed' ? 1 << d : 0) || undefined;
}
const SIDE_MSG: Record<SideMode, string> = { auto: '这一侧自动（贴着同样的路面就连成一片）', open: '这一侧开口（不画边框，露出凹槽截面）', closed: '这一侧封口（一定画边框，不和旁边的路面连起来）' };
function openToggles(): { id: number; side: Dir; p: P3; mode: SideMode }[] {
  if (sel.size !== 1 || mode() !== 'pattern') return [];
  const b = doc.elems[[...sel][0]];
  if (b?.kind !== 'box' || b.q) return [];
  const f = footprint(b);
  const cx = (f.x0 + f.x1) / 2, cy = (f.y0 + f.y1) / 2;
  const at: [number, number][] = [[f.x1, cy], [cx, f.y1], [f.x0, cy], [cx, f.y0]];
  return ([0, 1, 2, 3] as Dir[]).map((side) => {
    const [x, y] = at[side];
    return { id: b.id, side, p: toWorld(b, [x, y, boxTopAt(b, x, y) + 0.05]), mode: sideMode(b, side) };
  });
}
let openHover: { id: number; side: Dir } | null = null;
function openToggleAt(e: { clientX: number; clientY: number }) {
  const at = new THREE.Vector2(e.clientX, e.clientY);
  return openToggles().find((t) => toScreen(t.p).distanceTo(at) < hitPx(11)) ?? null;
}

/** 选中一个带挡块的机关时，每块挡块顶上的开关（倾斜的机关没有挡块，不显示） */
function stopToggles(): { id: number; part: number; p: P3; on: boolean }[] {
  if (sel.size !== 1 || mode() !== 'pattern') return [];
  const o = doc.elems[[...sel][0]];
  if (o?.kind !== 'obj' || o.q || !stopperCount(o.type)) return [];
  const r = (o.rot * Math.PI) / 2, c = Math.cos(r), s = Math.sin(r);
  return stopperTops(o.type).map(([x, y, z], part) => ({
    id: o.id, part, on: !stopperOff(o, part),
    p: toWorld(o, [o.x + x * c - y * s, o.y + x * s + y * c, o.z + z + 0.05]),
  }));
}
let stopHover: { id: number; part: number } | null = null;
function stopToggleAt(e: { clientX: number; clientY: number }) {
  const at = new THREE.Vector2(e.clientX, e.clientY);
  return stopToggles().find((t) => toScreen(t.p).distanceTo(at) < hitPx(11)) ?? null;
}
/** 关掉的那块挡块：红色半透明虚影，看得出关的是哪一块 */
function stopGhost(id: number, part: number): THREE.Object3D {
  const o = doc.elems[id] as Obj;
  const m = stopperMesh({ id: 0, cat: 'module', type: o.type, x: o.x, y: o.y, z: o.z, rot: o.rot * 90 }, (i) => i === part)!;
  const pos: number[] = [];
  for (let i = 0; i < m.pos.length; i += 3) pos.push(...toWorld(o, [m.pos[i], m.pos[i + 1], m.pos[i + 2]]));
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff6a6a, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
  mesh.renderOrder = 6; // 挡块多半嵌在路面里，透过路面也要看得见
  return mesh;
}
/** 切换一块挡块：以前整体关掉的（noStopper）先换成逐块的记法 */
function toggleStopper(o: Obj, part: number) {
  const n = stopperCount(o.type);
  let mask = o.noStopper ? 2 ** n - 1 : o.stopOff ?? 0;
  mask ^= 1 << part;
  delete o.noStopper;
  if (mask) o.stopOff = mask; else delete o.stopOff;
  const on = !stopperOff(o, part);
  flash(n > 1 ? `第 ${part + 1} 块挡块：${on ? '生成' : '不生成'}` : `挡块：${on ? '生成' : '不生成'}`);
}

/** 护栏端头的把手位置：立柱顶上（和实际的护栏一样往外偏 guardOffset） */
function guardHandle(g: Extract<Elem, { kind: 'guard' }>, end: 0 | 1): P3 {
  const p = end === 0 ? g.pts[0] : g.pts[g.pts.length - 1];
  const o = end === 0 ? g.outs[0] : g.outs[g.outs.length - 1];
  const st = mapSettings();
  return [p[0] + o[0] * st.guardOffset, p[1] + o[1] * st.guardOffset, p[2] + st.guardTop];
}
let guardEndHover: { id: number; end: 0 | 1 } | null = null;
function guardEndAt(e: { clientX: number; clientY: number }): { id: number; end: 0 | 1 } | null {
  const at = new THREE.Vector2(e.clientX, e.clientY);
  let best: { id: number; end: 0 | 1; d: number } | null = null;
  for (const g of Object.values(doc.elems)) {
    if (g.kind !== 'guard') continue;
    ([0, 1] as const).forEach((end) => {
      const d = toScreen(guardHandle(g, end)).distanceTo(at);
      if (d < hitPx(18) && (!best || d < best.d)) best = { id: g.id, end, d };
    });
  }
  return best;
}
function guardHover(e: PointerEvent) {
  const p = surfacePoint(e);
  if (guardDrag) {
    const l = lastSolved.loops[guardDrag.loop];
    const pr = p ? project([l], p, 3) : null;
    if (pr) guardPreview = shortPath(l, guardDrag.s0, pr.s);
    if (pr && Math.abs(pr.s - guardDrag.s0) > 0.3) guardDrag.moved = true;
  } else {
    const end = guardEndAt(e);
    guardEndHover = end;
    guardPreview = end ? null : p ? edgeAt(lastSolved.loops, p, prefs.guardInset) : null;
  }
  dragInfo = guardPreview ? `护栏长 ${fmt(routeLen(guardPreview))}` : '';
  drawOverlay(); updateStatus();
}
function guardDown(e: PointerEvent) {
  // 拖护栏的端头：另一头固定，沿外沿改长度（可以跨拐角）
  const end = guardEndAt(e);
  if (end) {
    snapshot();
    sel = new Set([end.id]);
    if (!startGuardLen(end.id, end.end)) { undo.pop(); return; }
    el.setPointerCapture(e.pointerId); pauseControls();
    guardPreview = null;
    drawOverlay();
    return;
  }
  const p = surfacePoint(e);
  if (!p) return;
  const pr = project(lastSolved.loops, p, 1.5);
  if (!pr || pr.dist > 1.5) return;
  el.setPointerCapture(e.pointerId);
  guardDrag = { loop: pr.loop, s0: pr.s, a: pr.p, moved: false };
  pauseControls();
}
function guardUp(e: PointerEvent) {
  const gd = guardDrag!;
  guardDrag = null;
  // 点一下：整条直边；拖动：从按下的地方沿外沿走到松开的地方
  const route = gd.moved ? guardPreview : edgeAt(lastSolved.loops, gd.a, prefs.guardInset);
  if (route && route.pts.length > 1 && routeLen(route) > 0.2) {
    snapshot();
    const id = gd.replace ?? doc.nextId++;
    const p0 = route.pts[0];
    doc.elems[id] = { id, kind: 'guard', pts: route.pts.map((q) => [...q] as P3), outs: route.outs.map((o) => [...o] as [number, number]), x: p0[0], y: p0[1], z: p0[2] };
  }
  guardPreview = null;
  rebuild();
  guardHover(e);
}
const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('button[data-tool]')];
const syncTools = () => { toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === 'guard' && guardMode)); };
function setTool(t: string) {
  // 护栏工具：再点一次退出
  if (t === 'guard') (guardMode ? exitGuard() : enterGuard());
}
toolButtons.forEach((b) => b.addEventListener('click', () => { setTool(b.dataset.tool!); b.blur(); }));
syncTools(); // 打开时就选中「选择」
function enterGuard() { permMode = tempMode = null; applyMode(); guardMode = true; sel.clear(); syncTools(); drawOverlay(); updateStatus(); }
function exitGuard() { if (!guardMode) return; guardMode = false; guardPreview = null; guardDrag = null; dragInfo = ''; syncTools(); drawOverlay(); updateStatus(); }

function enterSplit() { exitGuard(); splitMode = true; splitAxis = null; sel.clear(); syncTools(); drawOverlay(); updateStatus(); }
function exitSplit() { if (!splitMode) return; splitMode = false; splitPreview = null; dragInfo = ''; syncTools(); drawOverlay(); updateStatus(); }

// ---------------- 命令 ----------------

function doMerge() {
  snapshot();
  const r = mergeBoxes(doc, [...sel]);
  if (!r.ok) { undo.pop(); flash(r.msg, true); return; }
  sel = new Set([r.id]);
  flash('已合并');
  rebuild();
}
function doGroup() {
  if (sel.size < 2) { flash('至少选两个东西才能绑定', true); return; }
  snapshot(); groupElems(doc, sel); flash(`已绑定 ${sel.size} 个元素`); rebuild();
}
function doUngroup() {
  if (![...sel].some((id) => doc.elems[id].group !== undefined)) { flash('选中的东西没有绑定', true); return; }
  snapshot(); ungroupElems(doc, sel); flash('已解除绑定'); rebuild();
}
function doRotate() {
  if (!sel.size) return;
  snapshot();
  const b = boundsOf(doc, sel);
  const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
  for (const id of sel) rotateWorld(doc.elems[id], rotZ(90), [cx, cy, 0]);
  // 开着格栅时，转完的最小角仍落在格栅上
  if (gridOn) { const nb = boundsOf(doc, sel); for (const id of sel) translateElem(doc.elems[id], [snapG(nb.x0) - nb.x0, snapG(nb.y0) - nb.y0, 0]); }
  rebuild();
}
function doDelete() {
  if (!sel.size) return;
  snapshot();
  for (const id of sel) delete doc.elems[id];
  sel.clear();
  rebuild();
}
function doDuplicate(mouse: { clientX: number; clientY: number }) {
  if (!sel.size) return;
  if (drag) return;
  snapshot();
  sel = new Set(duplicate(doc, sel));
  rebuild();
  // 复制出来的直接进入移动模式（和 Blender 的 Shift+D 一样）
  startGrab(mouse, true);
  flash(touchUI ? '复制：单指拖动摆放，轻点放下' : '复制：移动鼠标，左键放下，右键 / Esc 取消');
}
function nudge(d: V3) {
  if (!sel.size) return;
  snapshot();
  for (const id of sel) translateElem(doc.elems[id], d);
  rebuild();
}
const keepSel = () => { sel = new Set([...sel].filter((id) => doc.elems[id])); };
/** 撤销、重做不动地图名字（改名不算一步编辑） */
const restoreDoc = (s: string) => { const name = doc.name; doc = JSON.parse(s); if (name) doc.name = name; else delete doc.name; };
function undoOnce() { if (undo.length) { redo.push(JSON.stringify(doc)); restoreDoc(undo.pop()!); keepSel(); rebuild(); } }
function redoOnce() { if (redo.length) { undo.push(JSON.stringify(doc)); restoreDoc(redo.pop()!); keepSel(); rebuild(); } }

const lastMouse = { clientX: 0, clientY: 0 };
let lastPointerTouch = false;
window.addEventListener('pointermove', (e) => { lastMouse.clientX = e.clientX; lastMouse.clientY = e.clientY; lastPointerTouch = e.pointerType === 'touch'; }, true);

document.getElementById('merge')!.addEventListener('click', doMerge);
document.getElementById('group')!.addEventListener('click', doGroup);
document.getElementById('ungroup')!.addEventListener('click', doUngroup);
document.getElementById('dup')!.addEventListener('click', () => { const r = el.getBoundingClientRect(); doDuplicate({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }); });
document.getElementById('rot')!.addEventListener('click', doRotate);
document.getElementById('del')!.addEventListener('click', doDelete);
const gridBtn = document.getElementById('grid')!;
gridBtn.classList.toggle('active', gridOn);
const toggleGrid = () => { gridOn = !gridOn; prefs.grid = gridOn; savePrefs(); gridBtn.classList.toggle('active', gridOn); flash(gridOn ? `格栅：开（步长 ${prefs.gridStep}）` : '格栅：关'); };
gridBtn.addEventListener('click', () => { toggleGrid(); gridBtn.blur(); });
const alignBtn = document.getElementById('align')!;
alignBtn.classList.toggle('active', alignOn);
const toggleAlign = () => { alignOn = !alignOn; prefs.align = alignOn; savePrefs(); alignBtn.classList.toggle('active', alignOn); flash(alignOn ? '自动对齐：开' : '自动对齐：关'); if (drag?.t === 'rotate') rotateMove(lastMouse); };
alignBtn.addEventListener('click', () => { toggleAlign(); alignBtn.blur(); });
document.getElementById('undo')!.addEventListener('click', () => undoOnce());
document.getElementById('redo')!.addEventListener('click', () => redoOnce());

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || document.querySelector('.confirm-mask')) return;
  const k = e.key.toLowerCase(), name = keyName(e);
  const act = actionFor(comboOf(e));
  if (name === keyOf('vsnap') && !vHeld) { vHeld = true; drawOverlay(); if (drag?.t === 'grab') grabMove(lastMouse); }
  // 移动 / 旋转模式里：轴向、打字输入、确定、取消
  if (transformKey(e)) { e.preventDefault(); return; }
  if (k === 'escape') { clearModes(); exitGuard(); closeMenus(); }
  // 按住模式键：过一会儿（HOLD_MS）还按着就临时切到对应模式；松开时再看是轻按还是按住（见 keyup）。组合键占用的不算
  const holdMode = act === null || act.startsWith('hold.') ? holdModeOf(name) as Mode | null : null;
  if (!e.repeat && holdMode && !held && !drag && !guardMode) {
    held = { key: name, temp: false, timer: window.setTimeout(() => { if (held?.key === name && !drag) { held.temp = true; tempMode = holdMode; applyMode(); } }, HOLD_MS) };
  }
  if (act && (e.ctrlKey || e.altKey || name === 'tab')) e.preventDefault();
  if (act === 'grid') { toggleGrid(); return; }
  if (act === 'split.dir' && splitMode) { splitAxis = splitAxis === null ? 1 : ((1 - splitAxis) as 0 | 1); splitHover(lastMouse); }
  if (act === 'undo') undoOnce();
  else if (act === 'redo') redoOnce();
  else if (act === 'merge') doMerge();
  else if (act === 'group') doGroup();
  else if (act === 'ungroup') doUngroup();
  else if (act === 'dup') doDuplicate(lastMouse);
  else if (act === 'save') { void flushMap(); flash('地图会自动存到历史里'); }
  else if (act === 'history') void openHistory();
  else if (act === 'selectAll') { sel = new Set(Object.keys(doc.elems).map(Number)); drawOverlay(); syncProps(); updateStatus(); }
  else if (act === 'align') toggleAlign();
  else if (act === 'guard') (guardMode ? exitGuard() : enterGuard());
  else if (act === 'focus') frameSelection();
  else if (act === 'delete' && !drag) doDelete();
  else if (act?.startsWith('mode.')) setPermMode(act.slice(5) as Mode);
  if (e.ctrlKey) return;
  // 拖着素材卡片时按旋转键转向（其它用法看 keyup）
  if (name === keyOf('hold.rotate') && drag?.t === 'place') { drag.rotOff++; placeMove(lastMouse as PointerEvent); }
  const step = e.shiftKey ? 0.1 : 1;
  const arrows: Record<string, V3> = { arrowleft: [-step, 0, 0], arrowright: [step, 0, 0], arrowup: [0, step, 0], arrowdown: [0, -step, 0], pageup: [0, 0, step], pagedown: [0, 0, -step] };
  if (arrows[k] && !drag) { e.preventDefault(); nudge(arrows[k]); }
});
window.addEventListener('keyup', (e) => { if (keyName(e) === keyOf('vsnap')) { vHeld = false; drawOverlay(); if (drag?.t === 'grab') grabMove(lastMouse); } updateStatus(); });
// 松开按住的模式键：按住过就回到原来的模式；只是轻按的话，移动 / 旋转键是自由移动 / 旋转，切分 / 花纹键是永久切换
window.addEventListener('keyup', (e) => {
  const k = keyName(e);
  if (!held || held.key !== k) return;
  clearTimeout(held.timer);
  const wasTemp = held.temp;
  held = null;
  if (wasTemp) { tempMode = null; applyMode(); return; }
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || drag || guardMode) return;
  const tapped = holdModeOf(k);
  if (tapped === 'move' && !splitMode) { if (sel.size) startGrab(lastMouse); else flash('先选中要移动的东西', true); }
  else if (tapped === 'rotate' && !splitMode) { if (sel.size) startRotate(lastMouse); else flash('先选中要旋转的东西', true); }
  else if (tapped === 'split') setPermMode('split');
  else if (tapped === 'pattern') setPermMode('pattern');
});
window.addEventListener('blur', () => { if (held) { clearTimeout(held.timer); held = null; } if (tempMode) { tempMode = null; applyMode(); } });
// 修饰键变化时刷新按键提示
window.addEventListener('keydown', () => updateStatus());

// ---------------- 属性面板 ----------------

/** 属性面板里显示的位置：转过的元素换成世界坐标（路面、死亡区是最小角，其它是原点） */
const propPos = (e: Elem): P3 => (isOriented(e) ? toWorld(e, [e.x, e.y, e.z]) : [e.x, e.y, e.z]);
/** 绕 Z 的朝向（度）；倾斜的元素没有 */
function yawOfElem(e: Elem): number | null {
  if (!isOriented(e) || e.q) return null;
  return e.kind === 'box' || e.kind === 'zone' ? e.ang ?? 0 : yawDeg(e);
}

function syncProps() {
  const one = sel.size === 1 ? doc.elems[[...sel][0]] : null;
  if (!one || drag?.t === 'grab' || drag?.t === 'rotate') { showEl(props, false); return; }
  if (props.dataset.id === String(one.id) && props.contains(document.activeElement)) return;
  showEl(props, true);
  props.dataset.id = String(one.id);
  const num = (k: string, label: string, v: number, step = 0.1) => `<label>${label}</label><input data-k="${k}" type="number" step="${step}" value="${+v.toFixed(4)}">`;
  /** 分段开关（和设置面板里的一样） */
  const seg = (key: string, opts: [string, string][], cur: string) => `<span class="seg-toggle" data-seg="${key}">${opts.map(([v, n]) => `<button type="button" data-v="${v}" class="${v === cur ? 'on' : ''}">${n}</button>`).join('')}</span>`;
  /** 开 / 关的小药丸 */
  const chip = (flag: string, label: string, on: boolean) => `<button type="button" class="chip${on ? ' on' : ''}" data-flag="${flag}">${label}</button>`;
  const [px, py, pz] = propPos(one);
  // 字段的 data-k 一直是内部的轴；游戏坐标系里按 x、y（高度）、z 的顺序排
  const game = prefs.coordSys !== 'math';
  const pos = () => (game ? num('x', 'x', px) + num('z', 'y', pz) + num('y', 'z', py) : num('x', 'x', px) + num('y', 'y', py) + num('z', 'z', pz));
  // 朝向：只绕 Z 转过的填角度（R 键可以自由旋转）；倾斜的显示「摆正」按钮
  const yaw = yawOfElem(one);
  const orient = () => ((isOriented(one) || one.kind === 'rail') && one.q
    ? '<label>朝向</label><div class="inline"><span class="muted">已倾斜</span><button data-act="upright" title="去掉绕水平轴的旋转，只保留朝向（中心不动）">摆正</button></div>'
    : yaw !== null ? num('yaw', '朝向 °', yaw, 15) : '');
  let h = '';
  if (one.kind === 'box') {
    h += `<div class="title">路面${one.group !== undefined ? '（已绑定）' : ''}${one.q ? '<small>倾斜：不参与花纹解算</small>' : ''}</div>`;
    h += pos() + num('sx', '长', one.sx) + num('sy', '宽', one.sy) + num('depth', '厚度', one.depth) + orient();
    h += `<label>样式</label><select data-k="style">${(['normal', 'sink', 'ribbon'] as Style[]).map((s) => `<option value="${s}"${s === one.style ? ' selected' : ''}>${{ normal: '平路', sink: '凹路', ribbon: '细边框凹路' }[s]}</option>`).join('')}</select>`;
    h += `<label>倾斜</label><select data-k="axis"><option value="-1">不倾斜</option><option value="0"${one.slope?.axis === 0 ? ' selected' : ''}>沿长</option><option value="1"${one.slope?.axis === 1 ? ' selected' : ''}>沿宽</option></select>`;
    if (one.slope) h += num('dz', '高差', one.slope.dz);
    h += `<div class="sub">四边<small>自动：贴着同样的路面就连成一片</small></div>`;
    h += (['+长', '+宽', '-长', '-宽'] as const).map((n, i) => `<label>${n}</label>${seg(`side-${i}`, [['auto', '自动'], ['open', '开口'], ['closed', '封口']], sideMode(one, i as Dir))}`).join('');
  } else if (one.kind === 'zone') {
    h += `<div class="title">死亡区<small>球碰到包围盒就死；导出时隐藏</small></div>`;
    h += pos() + num('sx', '长', one.sx) + num('sy', '宽', one.sy) + num('depth', '高', one.depth) + orient();
  } else if (one.kind === 'rail') {
    const pc = one.pieces[0];
    const shape = one.side ? '侧轨' : one.sideSpiral ? '螺旋侧轨' : pc.angle === 0 ? '直轨' : Math.abs(pc.angle) >= 360 ? '螺旋' : '弯轨';
    h += `<div class="title">${shape}</div>`;
    h += num('x', '起点 x', one.x) + (game ? num('z', '起点 y', one.z) + num('y', '起点 z', one.y) : num('y', '起点 y', one.y) + num('z', '起点 z', one.z));
    h += one.q ? orient() : num('heading', '朝向 °', one.heading, 15);
    if (one.side) {
      h += `<label>类型</label>${seg('side-type', [['normal', '普通'], ['stone', '石球']], one.side.stone ? 'stone' : 'normal')}`;
      h += `<label>上轨</label>${seg('side-dir', [['1', '偏左'], ['-1', '偏右']], String(one.side.dir))}`;
      const bend = [['flat', '平直'], ['bend', '弯下']] as [string, string][];
      h += `<label>起点上轨</label>${seg('end-0', bend, one.side.ends?.[0] ? 'bend' : 'flat')}<label>终点上轨</label>${seg('end-1', bend, one.side.ends?.[1] ? 'bend' : 'flat')}`;
    } else if (!one.sideSpiral) h += `<label>轨型</label><select data-rf="kind">${[['double', '双轨'], ['mono', '单轨'], ['transition', '单双转换']].map(([v, n]) => `<option value="${v}"${v === pc.kind ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
    const closure = [['flat', '平直'], ['round', '球形']] as [string, string][];
    h += `<label>起点闭合</label>${seg('tip-0', closure, one.tips?.[0] ? 'round' : 'flat')}<label>终点闭合</label>${seg('tip-1', closure, one.tips?.[1] ? 'round' : 'flat')}`;
    const rnum = (f: string, label: string, v: number, step = 0.5) => `<label>${label}</label><input data-rf="${f}" type="number" step="${step}" value="${+v.toFixed(3)}">`;
    if (pc.angle === 0) h += rnum('len', '长度', pc.len) + rnum('dz', '高差', pc.dz);
    else {
      h += `<label>方向</label><select data-rf="dir"><option value="1"${pc.angle > 0 ? ' selected' : ''}>左转</option><option value="-1"${pc.angle < 0 ? ' selected' : ''}>右转</option></select>`;
      h += rnum('radius', '半径', pc.radius);
      if (Math.abs(pc.angle) >= 360) h += rnum('turns', '圈数', Math.abs(pc.angle) / 360, 0.25) + (one.sideSpiral ? `<label>每圈升高</label><span class="muted">${SIDE_SPIRAL_SCREW}（固定）</span>` : rnum('screw', '每圈升高', pc.dz / (Math.abs(pc.angle) / 360)));
      else h += rnum('angle', '角度', Math.abs(pc.angle), 15) + rnum('dz', '高差', pc.dz);
    }
  } else if (one.kind === 'guard') {
    h += `<div class="title">护栏（长 ${fmt(routeLen(one))}）</div>`;
    h += `<div class="row">在护栏工具（H）里拖护栏的端头改长度</div>`;
  } else if (one.kind === 'piece' && isCheckpoint(one)) {
    const checks = Object.values(doc.elems).filter((e) => e.kind === 'piece' && e.type === 'check').sort((a, b) => a.id - b.id);
    h += `<div class="title">${one.type === 'start' ? '起点' : `小节盘点（第 ${one.sector ?? checks.indexOf(one) + 2} 小节）`}</div>`;
    h += pos() + num('yaw', '路口朝向 °', yawDeg(one), 15);
    const ARROW = ['→', '↗', '↑', '↖', '←', '↙', '↓', '↘'];
    const base = one.ang ?? 0;
    h += `<label>重生朝向</label><select data-k="spawn"><option value=""${one.spawn === undefined ? ' selected' : ''}>和路口一致</option>${ARROW.map((n, i) => `<option value="${i * 45}"${one.spawn !== undefined && Math.abs(((one.spawn + base) % 360) - i * 45) < 1e-6 ? ' selected' : ''}>${n}（${i * 45}°）</option>`).join('')}</select>`;
  } else if (one.kind === 'piece') {
    h += `<div class="title">${one.type === 'transition' ? '平凹转换' : '窄转换'}（长 ${pieceLen(one)}）</div>`;
    h += pos() + orient();
  } else if (one.kind === 'asset') {
    h += `<div class="title">${assetInfo(one.name)?.label ?? one.name}</div>`;
    h += pos() + orient();
  } else {
    const t = objType(one.type);
    h += `<div class="title">${t?.label ?? one.type}${one.q ? '<small>倾斜：没有专属路块和挡块</small>' : ''}</div>`;
    h += pos() + orient();
    const extra: string[] = [];
    if (baseSpec(one.type)) extra.push(chip('noBase', '专属路块', !one.noBase));
    if (t?.cat === 'module' && one.type !== 'PE_Balloon') h += `<label>小节</label><select data-k="sector">${Array.from({ length: sectorCount() }, (_, i) => `<option value="${i + 1}"${i + 1 === Math.min(one.sector ?? 1, sectorCount()) ? ' selected' : ''}>第 ${i + 1} 小节</option>`).join('')}</select>`;
    if (extra.length) h += `<label>附带</label><div class="chips">${extra.join('')}</div>`;
    if (!one.q && stopperCount(one.type)) {
      const n = stopperCount(one.type), on = Array.from({ length: n }, (_, i) => !stopperOff(one, i)).filter(Boolean).length;
      h += `<label>挡块</label><div class="muted">${on} / ${n} 块生成 · 点场景里的圆圈开关</div>`;
    }
  }
  props.innerHTML = h;
  enhanceFields(props);
}
props.addEventListener('change', (ev) => {
  const t = ev.target as HTMLInputElement;
  const e = sel.size === 1 ? doc.elems[[...sel][0]] : null;
  if (!e) return;
  if (!numDrag) snapshot();
  const k = t.dataset.k;
  if ((k === 'x' || k === 'y' || k === 'z') && e.kind !== 'guard') {
    // 位置按世界坐标改：算出位移再平移（转过的元素也对）
    const cur = propPos(e), d: V3 = [0, 0, 0];
    d[{ x: 0, y: 1, z: 2 }[k]] = +t.value - cur[{ x: 0, y: 1, z: 2 }[k]];
    if (e.kind === 'rail') e[k] = +t.value; else translateElem(e, d);
  }
  if (k === 'yaw') {
    // 绕 Z 转到给定的朝向：路面、死亡区绕中心转，其它绕原点
    const cur = yawOfElem(e);
    if (cur !== null && isOriented(e)) rotateWorld(e, rotZ(+t.value - cur), toWorld(e, pivotOf(e)));
  }
  if (e.kind === 'box') {
    if (k === 'style') e.style = t.value as Style;
    else if (k === 'axis') e.slope = +t.value < 0 ? undefined : { axis: +t.value as 0 | 1, dz: e.slope?.dz || 2.5 };
    else if (k === 'dz' && e.slope) e.slope.dz = +t.value;
  }
  if ((e.kind === 'box' || e.kind === 'zone') && (k === 'sx' || k === 'sy' || k === 'depth')) e[k] = Math.max(0.1, +t.value);
  if (e.kind === 'obj' && k === 'sector') e.sector = +t.value;
  if (e.kind === 'piece' && k === 'spawn') e.spawn = t.value === '' ? undefined : ((+t.value - (e.ang ?? 0)) % 360 + 360) % 360;
  if (e.kind === 'rail') {
    if (k === 'heading') e.heading = +t.value;
    const pc = e.pieces[0];
    const f = t.dataset.rf, v = +t.value;
    const turns = Math.abs(pc.angle) / 360;
    if (f === 'kind') pc.kind = t.value as RailPiece['kind'];
    else if (f === 'len') pc.len = Math.max(0.1, v);
    else if (f === 'dz') pc.dz = v;
    else if (f === 'radius') pc.radius = Math.max(0.5, v);
    else if (f === 'dir') pc.angle = Math.abs(pc.angle) * (v > 0 ? 1 : -1);
    else if (f === 'angle') pc.angle = Math.sign(pc.angle) * Math.min(359, Math.max(1, v));
    else if (f === 'turns') { const n = Math.max(1, v); pc.dz = e.sideSpiral ? SIDE_SPIRAL_SCREW * n * Math.sign(pc.dz || 1) : (pc.dz / turns) * n; pc.angle = Math.sign(pc.angle) * 360 * n; }
    else if (f === 'screw') pc.dz = v * turns;
  }
  props.dataset.id = '';
  rebuild();
});
const ARROW_ICON = (d: string) => `<svg viewBox="0 0 16 16"><path d="${d}"/></svg>`;
/** 换掉浏览器自带的数字框上下按钮和下拉：数字框两头加箭头，下拉换成自己画的按钮（原来的 select 留着存值、发 change） */
function enhanceFields(root: Element) {
  root.querySelectorAll<HTMLInputElement>('input[type=number]').forEach((inp) => {
    if (inp.parentElement!.classList.contains('num-field')) return;
    const w = document.createElement('span');
    w.className = 'num-field';
    inp.replaceWith(w);
    w.innerHTML = `<button type="button" data-d="-1" tabindex="-1">${ARROW_ICON('M10 4L6 8l4 4')}</button><button type="button" data-d="1" tabindex="-1">${ARROW_ICON('M6 4l4 4-4 4')}</button>`;
    w.insertBefore(inp, w.lastChild);
  });
  root.querySelectorAll<HTMLSelectElement>('select').forEach((s) => {
    if (s.classList.contains('native')) return;
    s.classList.add('native');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'sel-btn';
    b.innerHTML = `<span>${s.selectedOptions[0]?.text ?? ''}</span>${ARROW_ICON('M4 6l4 4 4-4')}`;
    s.after(b);
  });
}

const selPop = document.createElement('div');
selPop.className = 'dropdown-menu sel-pop';
document.body.appendChild(selPop);
let selOpen: { btn: HTMLElement; sel: HTMLSelectElement } | null = null;
function closeSel() {
  selOpen?.btn.classList.remove('open');
  selOpen = null;
  selPop.classList.remove('open');
}
function openSel(btn: HTMLElement) {
  const sel = btn.previousElementSibling as HTMLSelectElement;
  selOpen = { btn, sel };
  btn.classList.add('open');
  selPop.innerHTML = [...sel.options].map((o, i) => `<button type="button" data-i="${i}" class="${o.selected ? 'on' : ''}"><span>${o.text}</span></button>`).join('');
  const r = btn.getBoundingClientRect();
  selPop.style.minWidth = `${r.width}px`;
  selPop.classList.add('open');
  // 下面放不下就往上开
  const hgt = selPop.offsetHeight;
  const top = r.bottom + 4 + hgt > window.innerHeight ? r.top - 4 - hgt : r.bottom + 4;
  selPop.style.left = `${Math.min(r.left, window.innerWidth - selPop.offsetWidth - 8)}px`;
  selPop.style.top = `${Math.max(8, top)}px`;
  selPop.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}
selPop.addEventListener('click', (ev) => {
  const b = (ev.target as Element).closest<HTMLButtonElement>('button');
  if (!b || !selOpen) return;
  const { sel, btn } = selOpen;
  closeSel();
  if (sel.selectedIndex === +b.dataset.i!) return;
  sel.selectedIndex = +b.dataset.i!;
  btn.querySelector('span')!.textContent = sel.selectedOptions[0].text;
  sel.dispatchEvent(new Event('change', { bubbles: true }));
});
document.addEventListener('pointerdown', (ev) => {
  const t = ev.target as Element;
  const btn = t.closest?.<HTMLElement>('.sel-btn');
  if (selPop.contains(t)) return;
  const again = !!btn && selOpen?.btn === btn;
  closeSel();
  if (btn) { ev.preventDefault(); if (!again) openSel(btn); }
  if (t.closest?.('.num-field button')) ev.preventDefault(); // 不抢焦点：焦点在面板里时面板不刷新
}, true);
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeSel(); }, true);
window.addEventListener('resize', closeSel);

/** 数字框一步的大小：长度一个格栅步长，角度、圈数和设置面板里的值按自己的 step */
function numUnit(inp: HTMLInputElement): number {
  const step = +inp.step || 1;
  return inp.closest('#props') && step < 1 && inp.dataset.rf !== 'turns' ? prefs.gridStep : step;
}
document.addEventListener('click', (ev) => {
  const b = (ev.target as Element).closest?.<HTMLButtonElement>('.num-field button');
  if (!b) return;
  const inp = b.parentElement!.querySelector('input')!;
  inp.value = String(+(+inp.value + +b.dataset.d! * numUnit(inp)).toFixed(4));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
});

// 数字框像 Blender 一样按住左右拖：在当前值上一步一步加减（长度 ±1 格，角度 ±15°，Shift 一步 0.1）；
// 没拖动就是点进去打字。改完面板会重画，所以每步按属性重新找输入框
const NUM_DRAG_PX = 8;
let numDrag = false;
document.addEventListener('pointerdown', (ev) => {
  const inp = (ev.target as Element).closest?.<HTMLInputElement>('#props input[type=number], .settings-panel input[type=number]');
  if (!inp || ev.button !== 0 || document.activeElement === inp) return;
  ev.preventDefault();
  const root = inp.closest('#props, .settings-panel')!;
  const attr = ['data-k', 'data-rf', 'data-key', 'id'].find((a) => inp.hasAttribute(a))!;
  const query = `input[${attr}="${inp.getAttribute(attr)}"]`;
  const unit = numUnit(inp);
  const sx = ev.clientX, sy = ev.clientY, v0 = +inp.value;
  let moved = false;
  const stop = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointercancel', stop);
    document.body.classList.remove('num-drag');
    numDrag = false;
  };
  const move = (e: PointerEvent) => {
    const dx = e.clientX - sx;
    if (!moved) {
      // 手指竖着滑：是在滚动面板，不改数值
      if (e.pointerType === 'touch' && Math.abs(e.clientY - sy) >= 3 && Math.abs(e.clientY - sy) > Math.abs(dx)) { stop(); return; }
      if (Math.abs(dx) < 3) return;
      moved = true;
      document.body.classList.add('num-drag');
      if (root === props) { snapshot(); numDrag = true; }
    }
    const text = String(+(v0 + Math.round(dx / NUM_DRAG_PX) * (e.shiftKey ? 0.1 : unit)).toFixed(4));
    const cur = root.querySelector<HTMLInputElement>(query);
    if (!cur || cur.value === text) return;
    cur.value = text;
    cur.dispatchEvent(new Event('change', { bubbles: true }));
  };
  const up = () => {
    stop();
    if (!moved) { inp.focus(); inp.select(); }
  };
  window.addEventListener('pointercancel', stop);
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
});

// 分段开关（四边的自动 / 开口 / 封口）、药丸（挡块、专属路块）
props.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement;
  const e = sel.size === 1 ? doc.elems[[...sel][0]] : null;
  if (!e) return;
  const segBtn = t.closest<HTMLButtonElement>('.seg-toggle button');
  const chipBtn = t.closest<HTMLButtonElement>('button.chip');
  const tip = /^tip-(\d)$/.exec(segBtn?.parentElement!.dataset.seg ?? '');
  if (e.kind === 'rail' && tip) {
    const k = +tip[1], round = segBtn!.dataset.v === 'round';
    if (!!e.tips?.[k] === round) return;
    snapshot();
    const tips: [boolean, boolean] = [...(e.tips ?? [false, false])] as [boolean, boolean];
    tips[k] = round;
    e.tips = tips[0] || tips[1] ? tips : undefined;
    props.dataset.id = '';
    rebuild();
    return;
  }
  if (e.kind === 'rail' && e.side && segBtn) {
    snapshot();
    const s = e.side;
    const key = segBtn.parentElement!.dataset.seg, v = segBtn.dataset.v;
    if (key === 'side-type') s.stone = v === 'stone' || undefined;
    else if (key === 'side-dir') s.dir = v === '1' ? 1 : -1;
    else if (key === 'end-0' || key === 'end-1') {
      const ends: [boolean, boolean] = [...(s.ends ?? [false, false])] as [boolean, boolean];
      ends[key === 'end-0' ? 0 : 1] = v === 'bend';
      s.ends = ends[0] || ends[1] ? ends : undefined;
    }
    props.dataset.id = '';
    rebuild();
    return;
  }
  if (segBtn) {
    const key = segBtn.parentElement!.dataset.seg!;
    const m = /^side-(\d)$/.exec(key);
    if (!m || e.kind !== 'box') return;
    const d = +m[1] as Dir, mode = segBtn.dataset.v as SideMode;
    if (sideMode(e, d) === mode) return;
    snapshot(); setSideMode(e, d, mode);
  } else if (chipBtn && e.kind === 'obj') {
    const f = chipBtn.dataset.flag as 'noStopper' | 'noBase';
    snapshot(); e[f] = e[f] ? undefined : true;
  } else return;
  props.dataset.id = '';
  rebuild();
});
// 摆正：去掉倾斜
props.addEventListener('click', (ev) => {
  const b = (ev.target as Element).closest<HTMLButtonElement>('button[data-act="upright"]');
  const e = sel.size === 1 ? doc.elems[[...sel][0]] : null;
  if (!b || !e) return;
  snapshot();
  uprightElem(e);
  props.dataset.id = '';
  flash('已摆正');
  rebuild();
});

// 钢轨的段：添加 / 删除（按钮）
props.addEventListener('click', (ev) => {
  const t = ev.target as HTMLElement;
  const e = sel.size === 1 ? doc.elems[[...sel][0]] : null;
  if (e?.kind !== 'rail' || (t.dataset.rpadd === undefined && t.dataset.rpdel === undefined)) return;
  snapshot();
  if (t.dataset.rpdel !== undefined) { if (e.pieces.length > 1) e.pieces.splice(+t.dataset.rpdel, 1); }
  else {
    const kind = e.pieces[e.pieces.length - 1]?.kind === 'mono' ? 'mono' : 'double';
    const a = t.dataset.rpadd;
    e.pieces.push(a === 'straight' ? { kind, len: 10, radius: 0, angle: 0, dz: 0 }
      : a === 'spiral' ? { kind, len: 0, radius: SPIRAL_RADIUS, angle: 360, dz: SPIRAL_SCREW }
        : { kind, len: 0, radius: 5, angle: a === 'left' ? 90 : -90, dz: 0 });
  }
  props.dataset.id = '';
  rebuild();
});

// ---------------- 文件 ----------------

function download(name: string, data: BlobPart, type: string) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
// 下拉菜单：文件、导出
const fileMenu = document.getElementById('file-menu')!;
const fileBtn = document.getElementById('file-btn')!;
const viewMenu = document.getElementById('view-menu')!;
function closeMenus() { fileMenu.classList.remove('open'); viewMenu.classList.remove('open'); }
viewBtn.addEventListener('click', (e) => { e.stopPropagation(); const open = viewMenu.classList.contains('open'); closeMenus(); viewMenu.classList.toggle('open', !open); viewBtn.blur(); });
fileBtn.addEventListener('click', (e) => { e.stopPropagation(); viewMenu.classList.remove('open'); fileMenu.classList.toggle('open'); fileBtn.blur(); });
window.addEventListener('pointerdown', (e) => { const t = e.target as Node; if (!fileMenu.contains(t) && !viewMenu.contains(t) && !viewBtn.contains(t) && t !== fileBtn) closeMenus(); });
document.getElementById('scene-list')!.innerHTML = SCENES.map((sc, i) => `<button data-scene="${i}"><span>${sc.name}</span></button>`).join('');
/** 确认框（和设置面板一个样，不用浏览器自带的 confirm）：Enter 确定、Esc 或点外面取消 */
function askConfirm(text: string, ok = '确定'): Promise<boolean> {
  return new Promise((resolve) => {
    const mask = document.createElement('div');
    mask.className = 'confirm-mask';
    mask.innerHTML = `<div class="confirm-box"><p></p><div class="row"><button data-r="0">取消</button><button data-r="1" class="primary">${ok}</button></div></div>`;
    mask.querySelector('p')!.textContent = text;
    const done = (r: boolean) => { window.removeEventListener('keydown', key, true); mask.remove(); resolve(r); };
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' && e.key !== 'Escape') return;
      e.preventDefault(); e.stopPropagation();
      done(e.key === 'Enter');
    };
    mask.addEventListener('click', (e) => {
      const b = (e.target as Element).closest<HTMLButtonElement>('button');
      if (b) done(b.dataset.r === '1');
      else if (e.target === mask) done(false);
    });
    window.addEventListener('keydown', key, true);
    document.body.appendChild(mask);
  });
}

fileMenu.addEventListener('click', async (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>('button');
  if (!b) return;
  closeMenus();
  if (b.dataset.scene !== undefined) { setScene(+b.dataset.scene); return; }
  const act = b.dataset.act;
  if (act === 'new') setScene(-1);
  else if (act === 'history') void openHistory();
  else if (act === 'import') openImport();
  else if (act === 'copy') void copyMapCode();
  else if (act === 'nmo') void exportNmo();
});
/** 把当前地图的地图码放进剪贴板 */
async function copyMapCode() {
  if (!Object.keys(doc.elems).length) { flash('地图是空的', true); return; }
  try {
    const code = await encodeShare(doc);
    await navigator.clipboard.writeText(code);
    flash(`已复制地图码（${code.length} 个字符）`);
  } catch (e) { flash(`复制失败：${(e as Error).message}`, true); }
}

/** 弹一个对话框（和确认框一个样）：点外面、按 Esc 关闭 */
function openModal(html: string, cls: string): { box: HTMLElement; close: () => void } {
  const mask = document.createElement('div');
  mask.className = 'confirm-mask';
  mask.innerHTML = `<div class="confirm-box ${cls}">${html}</div>`;
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && document.querySelectorAll('.confirm-mask').length === 1) { e.stopPropagation(); close(); } };
  const close = () => { window.removeEventListener('keydown', key, true); mask.remove(); };
  mask.addEventListener('pointerdown', (e) => { if (e.target === mask) close(); });
  window.addEventListener('keydown', key, true);
  document.body.appendChild(mask);
  return { box: mask.firstElementChild as HTMLElement, close };
}

function openImport() {
  const { box, close } = openModal('<h3>导入地图码</h3><textarea rows="6" placeholder="把地图码粘贴到这里" spellcheck="false"></textarea><div class="row"><button data-r="0">取消</button><button data-r="1" class="primary">导入</button></div>', 'import-box');
  const text = box.querySelector('textarea')!;
  text.focus();
  box.addEventListener('click', async (e) => {
    const b = (e.target as Element).closest<HTMLButtonElement>('button');
    if (!b) return;
    if (b.dataset.r === '0') { close(); return; }
    try {
      const d = await decodeShare(text.value.replace(/\s+/g, ''));
      close();
      await switchMap(d);
      cleanDoc = null; // 导入的图直接进历史
      save();
      flash(`已导入${d.name ? `「${d.name}」` : '地图'}`);
    } catch { flash('这段地图码打不开，可能复制得不完整', true); }
  });
}

const escHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const mapTime = (t: number) => new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

async function openHistory() {
  await flushMap();
  const { box, close } = openModal('<h3>历史地图</h3><p class="hist-warn">清除本地网站数据或者更换设备会丢失记录，建议保存地图码！</p><div class="hist-list"></div><div class="row"><button data-close>关闭</button></div>', 'hist-box');
  const list = box.querySelector<HTMLElement>('.hist-list')!;
  const render = () => {
    const maps = listMaps(localStorage);
    list.innerHTML = maps.length ? maps.map((m) => `<div class="hist-row${m.id === mapId ? ' on' : ''}" data-id="${m.id}">
      <div class="hist-main"><b>${escHtml(m.name || UNNAMED)}</b><small>${m.count} 个元素 · ${mapTime(m.updated)}${m.id === mapId ? ' · 正在编辑' : ''}</small></div>
      <button data-a="rename">重命名</button>${m.id === mapId ? '' : '<button data-a="del">删除</button>'}
    </div>`).join('') : '<div class="hist-empty">还没有历史地图，编辑后会自动存在这里</div>';
  };
  render();
  const rename = (m: MapEntry, row: HTMLElement) => {
    const main = row.querySelector<HTMLElement>('.hist-main')!;
    main.innerHTML = `<input type="text" maxlength="40" value="${escHtml(m.name)}" placeholder="${UNNAMED}" spellcheck="false" />`;
    const inp = main.querySelector('input')!;
    inp.focus(); inp.select();
    let done = false;
    const commit = () => {
      if (done) return;
      done = true;
      const name = inp.value.trim();
      renameMap(localStorage, m.id, name);
      if (m.id === mapId) setMapName(name);
      render();
    };
    inp.addEventListener('blur', commit);
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') commit(); e.stopPropagation(); });
  };
  box.addEventListener('click', async (e) => {
    const t = e.target as Element;
    if (t.closest('[data-close]')) { close(); return; }
    const row = t.closest<HTMLElement>('.hist-row');
    if (!row || t.closest('input')) return;
    const m = listMaps(localStorage).find((x) => x.id === row.dataset.id);
    if (!m) return;
    const a = t.closest<HTMLElement>('button')?.dataset.a;
    if (a === 'rename') { rename(m, row); return; }
    if (a === 'del') {
      if (await askConfirm(`删除「${m.name || UNNAMED}」？删除后找不回来`, '删除')) { removeMap(localStorage, m.id); render(); }
      return;
    }
    if (m.id === mapId) { close(); return; }
    try {
      const d = await decodeShare(m.code);
      close();
      await switchMap(d, m.id);
      flash(`已打开「${m.name || UNNAMED}」`);
    } catch { flash('这张地图打不开了', true); }
  });
}

let exporting = false;
async function exportNmo() {
  if (exporting) return;
  const desc = exportBoxScene(doc);
  if (desc.warnings.length && !await askConfirm(`${desc.warnings.join('\n')}\n\n仍然导出？`, '仍然导出')) return;
  const file = `${(doc.name ?? '').replace(/[\\/:*?"<>|]/g, '_').trim() || 'map'}.nmo`;
  try {
    exporting = true;
    flash('正在生成 .nmo…');
    const { data } = await exportBoxNmo(doc);
    download(file, data as BlobPart, 'application/octet-stream');
    flash(`已导出 ${file}`);
  } catch (err) { console.error(err); flash(`导出失败：${(err as Error).message}`, true); }
  finally { exporting = false; }
}

// ---------------- 主题、设置 ----------------

function applyTheme(t: 'dark' | 'light') {
  prefs.theme = t; savePrefs();
  document.documentElement.dataset.theme = t;
  const g = GRID_THEMES[t];
  (scene.background as THREE.Color).set(g.bg);
  themeGrid(gridGroup, g);
  document.querySelector('#theme .theme-label')!.textContent = t === 'dark' ? '暗色' : '亮色';
}
applyTheme(prefs.theme);
document.getElementById('theme')!.addEventListener('click', (e) => { applyTheme(prefs.theme === 'dark' ? 'light' : 'dark'); (e.currentTarget as HTMLButtonElement).blur(); });

// 设置：和帮助一样占满页面的半透明弹窗，左边分页，右边内容。点弹窗外面、右上角、Esc 关闭，记住上次看的那一页
const SET_PAGES: [string, string][] = [['map', '全图设置'], ['edit', '编辑'], ['ui', '界面'], ['keys', '快捷键'], ['about', '关于']];
/** 手机没有键盘，不显示快捷键这一页 */
const setPages = () => (touchUI ? SET_PAGES.filter(([id]) => id !== 'keys') : SET_PAGES);
const settingsModal = document.createElement('div');
settingsModal.id = 'settings-modal';
settingsModal.hidden = true;
settingsModal.innerHTML = `
  <div class="help-win" role="dialog" aria-label="设置">
    <nav class="help-nav"></nav>
    <article class="help-body"><div id="settings-panel" class="settings-panel help-doc"></div></article>
    <button class="help-close" title="关闭（Esc）"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
  </div>`;
document.body.appendChild(settingsModal);
const settingsPanel = settingsModal.querySelector<HTMLElement>('#settings-panel')!;
const settingsNav = settingsModal.querySelector<HTMLElement>('.help-nav')!;
const settingsBody = settingsModal.querySelector<HTMLElement>('.help-body')!;
const aboutHtml = (document.getElementById('about-tpl') as HTMLTemplateElement).innerHTML;
const settingsOpen = () => !settingsModal.hidden;
/** 切到某一页：往后从右边滑进来，往前从左边（0 是不要动效，重新渲染时用） */
function showSetPage(id: string, dir: number | null = 0) {
  const pages = setPages().map(([p]) => p);
  const page = pages.includes(id) ? id : pages[0];
  if (prefs.settingsPage !== page) { prefs.settingsPage = page; savePrefs(); }
  settingsPanel.querySelectorAll<HTMLElement>('section[data-page]').forEach((p) => { p.hidden = p.dataset.page !== page; });
  settingsNav.querySelectorAll<HTMLElement>('a').forEach((a) => a.classList.toggle('on', a.dataset.set === page));
  if (dir === null) return;
  settingsBody.scrollTop = 0;
  settingsPanel.classList.remove('enter-next', 'enter-prev', 'enter');
  void settingsPanel.offsetWidth; // 重新触发动画
  settingsPanel.classList.add(dir > 0 ? 'enter-next' : dir < 0 ? 'enter-prev' : 'enter');
}
function openSettings() {
  settingsNav.innerHTML = `<div class="help-brand"><span class="logo"></span>设置</div>${setPages().map(([id, n]) => `<a href="#" data-set="${id}">${n}</a>`).join('')}`;
  renderSettings();
  settingsModal.hidden = false;
  requestAnimationFrame(() => settingsModal.classList.add('shown'));
  showSetPage(prefs.settingsPage);
}
function closeSettings() {
  if (!settingsOpen()) return;
  keyCapture = null; pendingBare = null;
  settingsModal.classList.remove('shown');
  setTimeout(() => { if (!settingsModal.classList.contains('shown')) settingsModal.hidden = true; }, 180);
}
settingsModal.addEventListener('click', (e) => {
  const t = e.target as Element;
  const go = t.closest<HTMLElement>('[data-set]');
  if (go) {
    e.preventDefault();
    const ids = setPages().map(([p]) => p);
    showSetPage(go.dataset.set!, Math.sign(ids.indexOf(go.dataset.set!) - ids.indexOf(prefs.settingsPage)));
    return;
  }
  if (t === settingsModal || t.closest('.help-close')) closeSettings();
});

// 快捷键这一页：点按键进入等待，按下新的键就改绑；被占用的动作变成未设置
let keyCapture: { id: string } | null = null;
/** 等待中按下了单独的修饰键：松开时还没按别的键，才算绑定这个修饰键 */
let pendingBare: string | null = null;
function keysHtml() {
  const row = (d: (typeof KEY_DEFS)[number]) => {
    const k = keyOf(d.id), caps = tokens(k).map((c) => `<kbd>${c}</kbd>`).join('');
    const also = d.alias?.length ? `也可以按 ${d.alias.map((a) => tokens(a).join('+')).join(' / ')}` : '';
    const note = [d.note, also].filter(Boolean).join('，');
    return `<div class="key-row" data-key-id="${d.id}"><span>${d.label}${note ? `<small>${note}</small>` : ''}</span><span class="key-acts">`
      + `${k !== d.def ? '<button class="key-reset" title="恢复默认">↺</button>' : ''}${k ? '<button class="key-clear" title="清除">×</button>' : ''}`
      + `<button class="key-bind${k ? '' : ' none'}">${caps || '未设置'}</button></span></div>`;
  };
  return `<section data-page="keys"><h1>快捷键</h1><p class="set-note">点右边的按键，再按新的键，Esc 取消。按键被别的动作占用时，那个动作会变成未设置。</p>`
    + [...new Set(KEY_DEFS.map((d) => d.group))].map((g) => `<h3 class="sub">${g}</h3>${KEY_DEFS.filter((d) => d.group === g).map(row).join('')}`).join('')
    + '<h3 class="sub">固定的按键</h3><p class="set-note"><kbd>Esc</kbd> 取消、退出模式，<kbd>Enter</kbd> 确定，移动和旋转时 <kbd>X</kbd> <kbd>Y</kbd> <kbd>Z</kbd> 限轴、数字键输入距离和角度，方向键和 <kbd>PageUp</kbd> <kbd>PageDown</kbd> 微调位置，<kbd>F1</kbd> 帮助。</p>'
    + '<div class="row"><button id="keys-reset">全部恢复默认</button></div></section>';
}
function keysChanged() { prefs.keys = savedKeys(); savePrefs(); syncKeyLabels(); }
function endKeyCapture() { keyCapture = null; pendingBare = null; renderSettings(); }
function commitKey(combo: string) {
  const id = keyCapture!.id;
  const taken = assignKey(id, combo);
  keysChanged();
  endKeyCapture();
  if (taken.length) flash(`已从「${taken.map((d) => d.label).join('、')}」上移走这个按键，它现在未设置`, true);
}
/** 等待改绑时按下的键。按住类和漫游只能是单个键；单独的修饰键松开时才算 */
function captureKey(e: KeyboardEvent) {
  e.preventDefault();
  if (e.repeat) return;
  const name = keyName(e), d = keyDef(keyCapture!.id);
  if (name === 'escape') { endKeyCapture(); return; }
  if (name === 'f1') { flash('F1 固定是帮助，不能改绑', true); return; }
  if (isBareModifier(name)) {
    if (d.single && name !== 'meta' && (d.fly || name !== 'shift')) pendingBare = name;
    return;
  }
  pendingBare = null;
  if (d.single && (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey)) { flash('这一项只能用单个键', true); return; }
  commitKey(d.single ? name : comboOf(e));
}
settingsModal.addEventListener('pointerdown', (e) => {
  if (keyCapture && !(e.target as Element).closest('.key-bind')) endKeyCapture();
}, true);
settingsPanel.addEventListener('click', (e) => {
  const t = e.target as Element;
  const id = t.closest<HTMLElement>('[data-key-id]')?.dataset.keyId;
  if (id && t.closest('.key-bind')) {
    if (keyCapture) renderSettings();
    keyCapture = { id };
    const b = settingsPanel.querySelector(`[data-key-id="${id}"] .key-bind`)!;
    b.classList.add('wait');
    b.textContent = '按下新按键…';
  } else if (id && t.closest('.key-reset')) { assignKey(id, keyDef(id).def); keysChanged(); renderSettings(); }
  else if (id && t.closest('.key-clear')) { setKey(id, ''); keysChanged(); renderSettings(); }
  else if (t.closest('#keys-reset')) { resetKeys(); keysChanged(); renderSettings(); }
  // 意见与反馈：点击时顺便复制群号
  const qq = t.closest<HTMLElement>('a.qq');
  if (qq) void navigator.clipboard.writeText(qq.dataset.qq!).then(() => flash(`已复制群号 ${qq.dataset.qq}`), () => flash(`QQ 群号：${qq.dataset.qq}`));
});
// 开着设置时键盘只给弹窗：Esc 关闭，别的键不传给编辑器（数字框照常输入）
window.addEventListener('keydown', (e) => {
  if (!settingsOpen()) return;
  e.stopImmediatePropagation();
  if (keyCapture) captureKey(e);
  else if (e.key === 'Escape') { e.preventDefault(); closeSettings(); }
}, true);
window.addEventListener('keyup', (e) => {
  if (!settingsOpen()) return;
  e.stopImmediatePropagation();
  if (keyCapture && pendingBare === keyName(e)) commitKey(pendingBare);
}, true);
const SETTING_FIELDS: { key: keyof MapSettings; label: string; hint: string; step: number }[] = [
  { key: 'guardTop', label: '护栏顶部高度', hint: '横杆顶部离路面（默认 2.6）', step: 0.05 },
  { key: 'guardPostDepth', label: '护栏立柱深度', hint: '立柱伸到路面以下（默认 2）', step: 0.05 },
  { key: 'guardOffset', label: '护栏离路边', hint: '管中心在路边外侧多远', step: 0.05 },
  { key: 'guardRadius', label: '护栏管半径', hint: '', step: 0.01 },
  { key: 'nailDepth', label: '铆钉深度', hint: '铆钉顶部在路面以下', step: 0.05 },
];
function renderSettings() {
  const st = mapSettings();
  const seg = (id: string, opts: [string, string][], cur: string) => `<span class="seg-toggle" id="${id}">${opts.map(([v, n]) => `<button data-v="${v}" class="${v === cur ? 'on' : ''}">${n}</button>`).join('')}</span>`;
  const scrolled = settingsBody.scrollTop;
  settingsPanel.innerHTML = '<section data-page="map"><h1>全图设置</h1>'
    + SETTING_FIELDS.map((f) => `<label><span>${f.label}<small>${f.hint}</small></span><input type="number" data-key="${f.key}" step="${f.step}" value="${st[f.key]}"></label>`).join('')
    + '<div class="row"><button id="settings-reset-map">恢复默认</button></div></section><section data-page="edit"><h1>编辑</h1>'
    + `<label><span>格栅步长<small>打开格栅时位置和尺寸的步长（默认 1）</small></span><input type="number" id="grid-step" step="0.25" min="0.05" value="${prefs.gridStep}"></label>`
    + `<label><span>护栏端头内缩<small>点路边放整条直边时，两头各往里缩（默认 1.5）</small></span><input type="number" id="guard-inset" step="0.25" min="0" value="${prefs.guardInset}"></label>`
    + `<label class="stack"><span>自动追踪<small>点选时视角移到它上面：不拉近，太近时按 F 的距离拉远</small></span>${seg('follow', [['off', '关'], ['on', '开']], prefs.followPick ? 'on' : 'off')}</label>`
    + `<label class="stack"><span>坐标系<small>游戏坐标系 Y 朝上，数字和 Ballance 里一致；数学坐标系 Z 朝上</small></span>${seg('coord', [['game', '游戏坐标系'], ['math', '数学坐标系']], prefs.coordSys === 'math' ? 'math' : 'game')}</label>`
    + '<div class="row"><button id="settings-reset-edit">恢复默认</button></div></section><section data-page="ui"><h1>界面</h1>'
    + `<label class="stack"><span>机关显示<small>只影响编辑器里的显示，导出仍用占位符</small></span>${seg('module-view', [['model', '机关模型'], ['placeholder', '占位符']], modelView ? 'model' : 'placeholder')}</label>`
    + `<label class="stack"><span>路面切分线<small>调试用：显示路面内部是怎么切的</small></span>${seg('wire', [['off', '关'], ['on', '开']], wireOn ? 'on' : 'off')}</label>`
    + `</section>${keysHtml()}<section data-page="about" class="about-panel">${aboutHtml}</section>`;
  enhanceFields(settingsPanel);
  settingsPanel.querySelectorAll<HTMLInputElement>('input[data-key]').forEach((inp) => inp.addEventListener('change', () => {
    const v = Number(inp.value);
    if (!Number.isFinite(v)) return;
    snapshot();
    doc.settings = { ...(doc.settings ?? {}), [inp.dataset.key!]: v };
    rebuild();
  }));
  settingsPanel.querySelector<HTMLInputElement>('#grid-step')!.addEventListener('change', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    if (Number.isFinite(v) && v > 0) { prefs.gridStep = v; savePrefs(); } else (e.target as HTMLInputElement).value = String(prefs.gridStep);
  });
  settingsPanel.querySelector<HTMLInputElement>('#guard-inset')!.addEventListener('change', (e) => {
    const v = Number((e.target as HTMLInputElement).value);
    if (Number.isFinite(v) && v >= 0) { prefs.guardInset = v; savePrefs(); } else (e.target as HTMLInputElement).value = String(prefs.guardInset);
  });
  const segClick = (id: string, fn: (v: string) => void) => settingsPanel.querySelectorAll<HTMLButtonElement>(`#${id} button`).forEach((b) => b.addEventListener('click', () => { fn(b.dataset.v!); renderSettings(); }));
  segClick('module-view', (v) => { modelView = v === 'model'; prefs.modelView = modelView; savePrefs(); renderLib(); rebuild(); });
  segClick('wire', (v) => { wireOn = v === 'on'; rebuild(); });
  segClick('follow', (v) => { prefs.followPick = v === 'on'; savePrefs(); });
  segClick('coord', (v) => { prefs.coordSys = v === 'math' ? 'math' : 'game'; savePrefs(); applyCoordSys(); });
  settingsPanel.querySelector('#settings-reset-map')!.addEventListener('click', () => { snapshot(); delete doc.settings; rebuild(); renderSettings(); });
  settingsPanel.querySelector('#settings-reset-edit')!.addEventListener('click', () => { prefs.gridStep = 1; prefs.guardInset = 1.5; savePrefs(); renderSettings(); });
  showSetPage(prefs.settingsPage, null);
  settingsBody.scrollTop = scrolled;
}
document.getElementById('settings')!.addEventListener('click', (e) => {
  (e.currentTarget as HTMLButtonElement).blur();
  openSettings();
});


// ---------------- 视图立方体（右上角）：显示 XYZ 朝向，点一个面切到这个方向的正交视图，转视角时自动回到透视 ----------------

/** 正交视图：开着时画面和拾取都用 orthoCam（每帧跟着透视相机的位置、朝向，视野按到视图中心的距离算） */
let orthoOn = false;
let orthoFace = '';
const orthoCam = new THREE.OrthographicCamera(-1, 1, 1, -1, -5000, 5000);
orthoCam.up.set(0, 0, 1);
function viewCam(): THREE.Camera { return orthoOn ? orthoCam : camera; }
function syncOrtho() {
  if (!orthoOn) return;
  const h = camera.position.distanceTo(controls.target) * Math.tan((camera.fov * Math.PI) / 360);
  orthoCam.left = -h * camera.aspect; orthoCam.right = h * camera.aspect; orthoCam.top = h; orthoCam.bottom = -h;
  orthoCam.position.copy(camera.position);
  orthoCam.quaternion.copy(camera.quaternion);
  orthoCam.updateProjectionMatrix();
  orthoCam.updateMatrixWorld();
}
function setOrtho(on: boolean, face = '') {
  if (orthoOn === on && orthoFace === face) return;
  orthoOn = on; orthoFace = face;
  syncOrtho();
  cubeLabel.textContent = on ? `正交 · ${face}` : '透视';
  cubeWrap.classList.toggle('ortho', on);
}

const cubeWrap = document.createElement('div');
cubeWrap.id = 'viewcube';
cubeWrap.innerHTML = '<div class="vc-label">透视</div>';
host.appendChild(cubeWrap);
const cubeLabel = cubeWrap.querySelector<HTMLElement>('.vc-label')!;
const CUBE_PX = 112;
const cubeRenderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
cubeRenderer.setPixelRatio(window.devicePixelRatio);
cubeRenderer.setSize(CUBE_PX, CUBE_PX);
cubeWrap.prepend(cubeRenderer.domElement);
const cubeScene = new THREE.Scene();
const cubeCam = new THREE.OrthographicCamera(-2.05, 2.05, 2.05, -2.05, 0.1, 20);
/** 六个面：BoxGeometry 的面顺序 +X、-X、+Y、-Y、+Z、-Z */
const FACES: { n: THREE.Vector3; label: string; name: string }[] = [
  { n: new THREE.Vector3(1, 0, 0), label: '右', name: '右（+X）' },
  { n: new THREE.Vector3(-1, 0, 0), label: '左', name: '左（-X）' },
  { n: new THREE.Vector3(0, 1, 0), label: '后', name: '后（+Y）' },
  { n: new THREE.Vector3(0, -1, 0), label: '前', name: '前（-Y）' },
  { n: new THREE.Vector3(0, 0, 1), label: '顶', name: '顶（+Z）' },
  { n: new THREE.Vector3(0, 0, -1), label: '底', name: '底（-Z）' },
];
function faceTex(label: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 128, 128);
  g.fillStyle = '#26324a';
  g.font = '600 54px system-ui, "Microsoft YaHei", sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(label, 64, 68);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}
const FACE_COLOR = 0xc9d6ee, FACE_HOVER = 0x8fb4ff, FACE_ON = 0x6fe0a0;
const faceMats = FACES.map((f) => new THREE.MeshBasicMaterial({ map: faceTex(f.label), color: FACE_COLOR, transparent: true, opacity: 0.92 }));
const cubeMesh = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.5, 1.5), faceMats);
cubeScene.add(cubeMesh);
cubeScene.add(new THREE.LineSegments(new THREE.EdgesGeometry(cubeMesh.geometry), new THREE.LineBasicMaterial({ color: 0x3a4660 })));
// 坐标轴：从立方体的一个角伸出去，末端标 X / Y / Z
function axisLabel(text: string, color: string) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = color; g.beginPath(); g.arc(32, 32, 26, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#0d1424'; g.font = '700 34px system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 32, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false }));
  s.scale.setScalar(0.42);
  s.renderOrder = 2;
  return s;
}
const O = new THREE.Vector3(-0.75, -0.75, -0.75);
const cubeAxes = new THREE.Group();
cubeScene.add(cubeAxes);
/** 立方体旁边的三根轴：方向不变，名字和颜色跟着坐标系 */
function syncCubeAxes() {
  cubeAxes.clear();
  const COL: Record<string, string> = { X: '#ff6b6b', Y: '#6bdc87', Z: '#6ba4ff' };
  ([[1, 0, 0], [0, 1, 0], [0, 0, 1]] as const).forEach(([x, y, z], i) => {
    const d = new THREE.Vector3(x, y, z), t = AXIS_NAME[i], col = COL[t];
    const end = O.clone().addScaledVector(d, 1.95);
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints([O, end]), new THREE.LineBasicMaterial({ color: col, depthTest: false }));
    l.renderOrder = 1;
    const s = axisLabel(t, col);
    s.position.copy(end).addScaledVector(d, 0.18);
    cubeAxes.add(l, s);
  });
}
syncCubeAxes();
let cubeHover = -1;
const cubeRay = new THREE.Raycaster();
function cubePick(e: MouseEvent): number {
  const r = cubeRenderer.domElement.getBoundingClientRect();
  cubeRay.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), cubeCam);
  const h = cubeRay.intersectObject(cubeMesh)[0];
  return h?.face ? h.face.materialIndex : -1;
}
cubeRenderer.domElement.addEventListener('pointermove', (e) => { cubeHover = cubePick(e); cubeRenderer.domElement.style.cursor = cubeHover >= 0 ? 'var(--cur-pointer, pointer)' : ''; });
cubeRenderer.domElement.addEventListener('pointerleave', () => { cubeHover = -1; });
cubeRenderer.domElement.addEventListener('pointerdown', (e) => {
  e.stopPropagation();
  const i = cubePick(e);
  if (i >= 0) viewFrom(i);
});
cubeLabel.addEventListener('click', () => setOrtho(false));
cubeLabel.title = '点击回到透视视图';

/** 平滑转到某个面的方向（视图中心、距离不变），转完切成正交 */
let viewAnim: { q0: THREE.Quaternion; q1: THREE.Quaternion; off: THREE.Vector3; k: number; face: number } | null = null;
function viewFrom(i: number) {
  if (fly) return;
  const off = camera.position.clone().sub(controls.target);
  // 正上 / 正下方差一点点，免得朝上的方向和视线平行
  const to = FACES[i].n.clone();
  if (Math.abs(to.z) > 0.5) to.y = -1e-4 * Math.sign(to.z || 1);
  to.normalize();
  viewAnim = { q0: new THREE.Quaternion(), q1: new THREE.Quaternion().setFromUnitVectors(off.clone().normalize(), to), off, k: 0, face: i };
  zoomGoal = null; camAnim = null;
}
function tickViewAnim(dt: number) {
  if (!viewAnim) return;
  const a = viewAnim;
  a.k = Math.min(1, a.k + dt / 0.3);
  const e = 1 - (1 - a.k) ** 3;
  const q = a.q0.clone().slerp(a.q1, e);
  camera.position.copy(controls.target).add(a.off.clone().applyQuaternion(q));
  camera.lookAt(controls.target);
  if (a.k >= 1) { viewAnim = null; setOrtho(true, FACES[a.face].name); }
}
// 转视角（中键环视，不按 Shift）、进入漫游：回到透视
el.addEventListener('pointerdown', (e) => {
  if ((e.button === 1 && !e.shiftKey) || e.button === 2) { viewAnim = null; setOrtho(false); }
}, true);

/** 立方体在视图右上角；属性面板在右边时让开它 */
let cubeRight = -1;
function placeViewCube() {
  let right = 12;
  if (prefs.side === 'left' && !props.hidden && props.classList.contains('shown')) right = props.offsetWidth + 20;
  if (right !== cubeRight) { cubeRight = right; cubeWrap.style.right = `${right}px`; }
}
/** 帧数：一秒里真正画了多少帧（画面没变不画，所以静止时是 0）。放在视图左上角，左边有面板时让开 */
const fpsEl = document.createElement('div');
fpsEl.id = 'fps';
fpsEl.textContent = '0 FPS';
host.appendChild(fpsEl);
let fpsLeft = -1, fpsAt = performance.now(), fpsBase = 0;
function tickFps(now: number) {
  let left = 12;
  if (prefs.side !== 'left' && !props.hidden && props.classList.contains('shown')) left = props.offsetWidth + 20;
  if (left !== fpsLeft) { fpsLeft = left; fpsEl.style.left = `${left}px`; }
  if (now - fpsAt < 1000) return;
  fpsEl.textContent = `${Math.round(((renderCount - fpsBase) * 1000) / (now - fpsAt))} FPS`;
  fpsAt = now;
  fpsBase = renderCount;
}
const tmpQ = new THREE.Quaternion();
function renderViewCube() {
  tmpQ.copy(camera.quaternion);
  cubeCam.position.set(0, 0, 6).applyQuaternion(tmpQ);
  cubeCam.quaternion.copy(tmpQ);
  cubeCam.updateMatrixWorld();
  faceMats.forEach((m, i) => m.color.setHex(i === cubeHover ? FACE_HOVER : orthoOn && FACES[i].name === orthoFace ? FACE_ON : FACE_COLOR));
  cubeRenderer.render(cubeScene, cubeCam);
}

// ---------------- 修饰键：Ctrl 改尺寸（侧面下半截改厚度）/ Alt 拉坡，换鼠标指针并在指针旁边显示当前模式 ----------------

type ModMode = 'size' | 'slope' | 'thick' | null;
const MOD_ICON: Record<Exclude<ModMode, null>, string> = {
  size: 'M4 14h20M4 14l4-4M4 14l4 4M24 14l-4-4M24 14l-4 4M10 6v16M18 6v16',
  slope: 'M4 21L24 9M4 21h20M24 9v12M15 6l3-3 3 3',
  thick: 'M14 4v20M14 4l-4 4M14 4l4 4M14 24l-4-4M14 24l4-4M6 4h16M6 24h16',
};
const MOD_LABEL: Record<Exclude<ModMode, null>, string> = {
  size: '拖动改尺寸，拖侧面下半截改厚度',
  slope: '拖动一头拉坡',
  thick: '上下拖改厚度',
};
const modChip = document.createElement('div');
modChip.id = 'mod-chip';
modChip.className = 'fade';
modChip.hidden = true;
document.body.appendChild(modChip);
let modShown: ModMode = null;
const modKeys = { ctrl: false, alt: false };
function currentMod(): ModMode {
  if (drag) return drag.t === 'size' || drag.t === 'stretch' || drag.t === 'railLen' ? 'size' : drag.t === 'tilt' || drag.t === 'railTilt' ? 'slope' : drag.t === 'thick' ? 'thick' : null;
  if (!sel.size || fly || guardMode || splitMode) return null;
  return modKeys.ctrl ? 'size' : modKeys.alt ? 'slope' : null;
}
function syncMod(e?: { clientX: number; clientY: number }) {
  const m = currentMod();
  if (m !== modShown) {
    modShown = m;
    if (m) {
      const label = MOD_LABEL[m], keys = keysOf(m === 'slope' ? 'hold.slope' : 'hold.stretch');
      modChip.innerHTML = `<svg viewBox="0 0 28 28" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="${MOD_ICON[m]}"/></svg>${keys.map((k) => `<kbd>${k}</kbd>`).join('')}<span>${label}</span>`;
    }
    showEl(modChip, !!m);
  }
  const p = e ?? lastMouse;
  if (m) { modChip.style.left = `${p.clientX + 18}px`; modChip.style.top = `${p.clientY + 20}px`; }
}
window.addEventListener('keydown', (e) => {
  if (e.key === 'Alt') e.preventDefault(); // 单按 Alt 不要激活浏览器菜单
  if (e.key === 'Control' || e.key === 'Alt') { modKeys.ctrl = stretchMod(e); modKeys.alt = slopeMod(e); syncMod(); }
});
window.addEventListener('keyup', (e) => { if (e.key === 'Control' || e.key === 'Alt') { modKeys.ctrl = stretchMod(e); modKeys.alt = slopeMod(e); syncMod(); } });
window.addEventListener('pointermove', (e) => { modKeys.ctrl = stretchMod(e); modKeys.alt = slopeMod(e); syncMod(e); });
window.addEventListener('blur', () => { modKeys.ctrl = modKeys.alt = false; syncMod(); });

// ---------------- 场景与视图 ----------------

/** 换一张地图：当前的先存进历史，撤销记录清掉（不能撤销到别的地图上） */
async function switchMap(d: Doc, id = newMapId()) {
  await flushMap();
  doc = d;
  mapId = id;
  try { localStorage.setItem(MAP_ID, id); } catch { /* 存不了就算了 */ }
  cleanDoc = JSON.stringify(d);
  undo.length = 0;
  redo.length = 0;
  sel.clear();
  syncMapName();
  frameAll();
  rebuild();
}
function setScene(i: number) {
  const d: Doc = i < 0 ? { elems: {}, nextId: 1 } : SCENES[i].build();
  if (i >= 0) d.name = SCENES[i].name;
  void switchMap(d);
}

/** 平滑移动视图：视图中心移到 center，观察距离改成 dist（视线方向不变） */
let camAnim: { dT: THREE.Vector3; dP: THREE.Vector3; k: number } | null = null;
function moveCamera(center: THREE.Vector3, dist: number) {
  const t = controls.target;
  const off = camera.position.clone().sub(t).setLength(dist);
  camAnim = { dT: center.clone().sub(t), dP: center.clone().add(off).sub(camera.position), k: 0 };
  zoomGoal = null;
}
/** F：聚焦到选中的东西（按画出来的包围盒，距离 = 尺寸 × 1.4，限制在 20～800）；没选中时看全部 */
function frameSelection() {
  const ids = sel.size ? [...sel] : Object.keys(doc.elems).map(Number);
  if (!ids.length) { flash('场景是空的'); return; }
  const f = frameOf(ids);
  moveCamera(f.center, f.dist);
}
/** 自动追踪：视图中心移到这些东西上；距离取 F 的距离和现在的距离里远的那个（F 会拉近时不拉近，会拉远时照 F 拉远） */
function followTo(ids: Iterable<number>) {
  const f = frameOf([...ids]);
  moveCamera(f.center, Math.max(f.dist, camera.position.distanceTo(controls.target)));
}
/** F 的取景：包围盒中心，距离 = 尺寸 × 1.4，限制在 20～800 */
function frameOf(ids: number[]): { center: THREE.Vector3; dist: number } {
  const box = new THREE.Box3();
  for (const id of ids) {
    // 路面按它自己的范围（它的网格可能是和别的路面连在一起的一整片）
    if (doc.elems[id]?.kind === 'box') { const b = elemBounds(doc.elems[id]); box.union(new THREE.Box3(new THREE.Vector3(b.x0, b.y0, b.z0), new THREE.Vector3(b.x1, b.y1, b.z1))); continue; }
    for (const g of elemGroups.get(id) ?? []) box.union(solidBox(g));
    const b = elemBounds(doc.elems[id]);
    if (!elemGroups.get(id)?.length) box.union(new THREE.Box3(new THREE.Vector3(b.x0, b.y0, b.z0), new THREE.Vector3(b.x1, b.y1, b.z1)));
  }
  const size = box.getSize(new THREE.Vector3()).length();
  return { center: box.getCenter(new THREE.Vector3()), dist: THREE.MathUtils.clamp(size * 1.4, 20, 800) };
}
function frameAll() {
  const ids = sel.size ? [...sel] : Object.keys(doc.elems).map(Number);
  if (!ids.length) return;
  const b = boundsOf(doc, ids);
  const c = new THREE.Vector3((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.z1);
  const r = Math.max(b.x1 - b.x0, b.y1 - b.y0, 5);
  controls.target.copy(c);
  camera.position.copy(c).add(new THREE.Vector3(-0.2, -0.55, 1).normalize().multiplyScalar(r * 1.05 + 8));
}

function resize() {
  canvasRect = null;
  const w = host.clientWidth, h = host.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
// 素材库收起、改大小、换位置时视图也会变大小。这个回调在排版之后、上屏之前：改了画布大小马上画一帧，不然会闪一下空白
new ResizeObserver(() => {
  if (renderer.domElement.width === Math.round(host.clientWidth * renderer.getPixelRatio()) && renderer.domElement.height === Math.round(host.clientHeight * renderer.getPixelRatio())) return;
  resize();
  syncOrtho();
  renderer.render(scene, viewCam());
  invalidate(100);
}).observe(host);
resize();
(() => {
  try {
    const v = JSON.parse(localStorage.getItem('bvm.box.view') ?? 'null');
    if (v) { camera.position.fromArray(v.p); controls.target.fromArray(v.t); controls.update(); return; }
  } catch { /* 用默认视角 */ }
  frameAll();
})();
setInterval(() => { try { localStorage.setItem('bvm.box.view', JSON.stringify({ p: camera.position.toArray(), t: controls.target.toArray() })); } catch { /* 存不了就算了 */ } }, 1500);
rebuild();
updateStatus();
// 路面贴图加载好之前先不显示（最多等 1.5 秒），免得先闪一下纯色的路面
renderer.domElement.style.opacity = '0';
Promise.race([floorTexturesReady(), new Promise((r) => setTimeout(r, 1500))]).then(() => {
  renderer.domElement.style.transition = 'opacity .15s';
  renderer.domElement.style.opacity = '1';
});
/** 上一次画的时候相机和画布的样子：比矩阵本身，阻尼、视图切换、窗口大小都不用单独记 */
const viewSig = new Float64Array(34);
function viewChanged(cam: THREE.Camera) {
  const c = renderer.domElement, w = cam.matrixWorld.elements, q = cam.projectionMatrix.elements;
  let changed = viewSig[32] !== c.width || viewSig[33] !== c.height;
  viewSig[32] = c.width; viewSig[33] = c.height;
  // OrbitControls 每帧重算相机位置，末位有浮点抖动，差得比这小的不算动（慢慢累积到这么大时还是会画）
  for (let i = 0; i < 16; i++) {
    if (Math.abs(viewSig[i] - w[i]) > 1e-6) { viewSig[i] = w[i]; changed = true; }
    if (Math.abs(viewSig[16 + i] - q[i]) > 1e-6) { viewSig[16 + i] = q[i]; changed = true; }
  }
  return changed;
}
let groupsMoved = false;
renderer.setAnimationLoop(() => {
  frameNo++;
  syncCursor();
  syncHandles();
  // 这一帧开始时就在动的：最后一步在这一帧里结束，也要画出来
  const busy = fading.length > 0 || !!fly || !!camAnim || zoomGoal !== null || !!drag || rebuildWanted;
  if (fading.length) tickFades(performance.now());
  if (fly) tickFly(Math.min(0.05, (performance.now() - lastFrame) / 1000));
  const now = performance.now(), dt = Math.min(0.1, (now - lastFrame) / 1000);
  lastFrame = now;
  if (camAnim) {
    const a = camAnim, ease = (x: number) => 1 - (1 - x) ** 3;
    const k1 = Math.min(a.k + dt / 0.28, 1), f = ease(k1) - ease(a.k);
    a.k = k1;
    controls.target.addScaledVector(a.dT, f);
    camera.position.addScaledVector(a.dP, f);
    if (k1 >= 1) camAnim = null;
  }
  if (zoomGoal !== null) {
    const dir = camera.position.clone().sub(controls.target);
    const cur = dir.length();
    const next = cur + (zoomGoal - cur) * (1 - Math.exp(-dt / 0.07));
    camera.position.copy(controls.target).add(dir.setLength(next));
    if (Math.abs(zoomGoal - next) < Math.max(0.005, cur * 1e-4)) zoomGoal = null;
  }
  let moving = false;
  if (anim) {
    for (let i = 0; i < anim.val.length; i++) {
      const dv = anim.goal[i] - anim.val[i];
      if (Math.abs(dv) > 1e-4) { anim.val[i] += dv * EASE; moving = true; } else anim.val[i] = anim.goal[i];
    }
  }
  if (rebuildWanted) rebuild();
  // 画面上的缓动：平移类拖动把网格挪 (val - final)，选中框一起挪；改形状的拖动重画选中框
  const off = anim?.ids ? anim.val.map((v, i) => v - anim!.final[i]) : [0, 0, 0];
  // 没有缓动时不用每帧走一遍所有元素，缓动刚结束时再走一次把网格放回原位
  if (anim?.ids || groupsMoved) {
    for (const [id, gs] of elemGroups) {
      for (const g of gs) {
        const own = g.userData.owners as Set<number> | undefined;
        const m = !!anim?.ids && (own ? [...own].every((o) => anim!.ids!.has(o)) : anim.ids.has(id));
        g.position.set(m ? off[0] : 0, m ? off[1] : 0, m ? off[2] : 0);
      }
    }
    groupsMoved = !!anim?.ids;
  }
  selLayer.position.set(off[0], off[1], off[2]);
  if (moving && anim?.preview) drawOverlay();
  if (measure) { const m = toScreen(new THREE.Vector3(...measure.a).add(new THREE.Vector3(...measure.b)).multiplyScalar(0.5)); measureLabel.style.left = `${m.x}px`; measureLabel.style.top = `${m.y}px`; }
  tickViewAnim(dt);
  if (!fly) controls.update(); // 漫游时视角由鼠标直接控制，OrbitControls 会把相机掰回去对着视图中心
  syncOrtho();
  // 面板淡入淡出不经过重画，立方体和帧数每帧都看一下要不要让开
  placeViewCube();
  tickFps(performance.now());
  const cam = viewCam();
  cam.updateMatrixWorld();
  const camMoved = viewChanged(cam);
  if (!busy && !moving && !camMoved && !renderOnce && performance.now() > renderUntil) return;
  renderOnce = false;
  renderCount++;
  syncGizmo(cam);
  renderer.render(scene, cam);
  renderViewCube();
  if (secLabels.size) placeSectorLabels();
});

// 截图脚本用
(window as unknown as Record<string, unknown>).__proto = {
  setScene,
  view: (pos: number[], target: number[]) => { camera.position.set(pos[0], pos[1], pos[2]); controls.target.set(target[0], target[1], target[2]); controls.update(); },
  project: (p: number[]) => { const s = toScreen([p[0], p[1], p[2]]); return { x: s.x, y: s.y }; },
  wire: (on: boolean) => { wireOn = on; rebuild(); },
  select: (ids: number[]) => { sel = new Set(ids); drawOverlay(); syncProps(); },
  toggle: (k: 'grid' | 'align') => (k === 'grid' ? toggleGrid() : toggleAlign()),
  get sel() { return [...sel]; },
  get handleAim() { return handleAim; },
  get rebuilds() { return rebuildCount; },
  get renders() { return renderCount; },
  camDist: () => +camera.position.distanceTo(controls.target).toFixed(2),
  camState: () => ({ t: controls.target.toArray(), d: camera.position.distanceTo(controls.target) }),
  camPos: () => camera.position.toArray(),
  get rebuildTimes() { return rebuildTimes; },
  get solveMs() { return lastSolve.ms; },
  get solveStats() { return { ...solveStats }; },
  get groups() { return elemGroups; },
  get doc() { return doc; },
  set doc(d: Doc) { doc = d; rebuild(); },
  get prefs() { return prefs; },
  /** 手柄现在在哪、多大（演示和测试找箭头、圆环用）：mode 是当前编辑模式 */
  gizmoInfo: () => ({
    mode: mode(),
    move: moveGizmo.group.visible ? { p: moveGizmo.group.position.toArray(), s: moveGizmo.group.scale.x } : null,
    rot: rotGizmo.group.visible ? { p: rotGizmo.group.position.toArray(), s: rotGizmo.group.scale.x } : null,
    handles: modeHandles(),
  }),
};
// 帮助里的实时演示：网址带 ?demo=名字 时按分镜自动操作（见 demo.ts）
{
  const demo = new URLSearchParams(location.search).get('demo');
  if (demo) void import('./demo').then((m) => m.runDemo(demo));
}

// 第一次打开编辑器：提示一下有教程
try {
  if (!localStorage.getItem('bvm.box.helpTip')) {
    localStorage.setItem('bvm.box.helpTip', '1');
    setTimeout(() => flash('第一次用？点右上角的「帮助」或按 F1 看图文教程'), 1200);
  }
} catch { /* 存不了就算了 */ }

// ---------------- 触摸屏 ----------------
// 单指拖：环视（OrbitControls）；双指：平移和缩放；轻点：选中（第一根手指按下时照常走点选，见上面的 pointerdown / pointermove）。
// 第二根手指落下时，第一根手指开始的点选 / 框选作废，交给 OrbitControls 平移缩放。
// 双指缩放自己做：滚轮缩放是自己实现的（平滑缩放，OrbitControls 的缩放关着），捏合也走同一套（两指距离变成几分之几，镜头距离就变成几倍）
const touchPos = new Map<number, { x: number; y: number }>();
// 长按再拖：框选一次（手指没怎么动地按住一会儿才算，手指一动就还是环视）；手机上没有 Shift，所以框选一律是加选，轻点空白处取消选择
const LONG_PRESS_MS = 320;
let pressTimer = 0, pressAt = { x: 0, y: 0 };
/** 手机上放置模式的移动平面：物体顶面的高度 */
const grabPlane = (d: { start: THREE.Vector3 }) => new THREE.Plane(new THREE.Vector3(0, 0, 1), -d.start.z);
/** 手指按下开始摆放：手指按在哪里都行，物体从现在的位置跟着手指的位移走，不跳到手指下面。落点用世界坐标记，中途双指调过视角也对得上 */
function beginTouchGrab(e: PointerEvent, d: Extract<Drag, { t: 'grab' }>) {
  const hit = planeHit(e, grabPlane(d));
  if (!hit) return;
  d.start.add(hit.clone().sub(d.touchHit ?? d.start));
  d.touchHit = hit;
  grabTouchId = e.pointerId;
  el.setPointerCapture(e.pointerId);
  pauseControls();
}
/** 第二根手指落下：双指手势优先。第一根手指已经开始的编辑作废并撤回，视图操作交还给 OrbitControls（要赶在它处理这根手指之前） */
function yieldToGesture() {
  touchTap = null;
  grabTouchId = null;
  clearTimeout(pressTimer);
  if (guardDrag) { guardDrag = null; guardPreview = null; dragInfo = ''; drawOverlay(); }
  if (drag?.t === 'click' || drag?.t === 'marquee') { drag = null; marqueeEl.classList.remove('shown', 'open'); }
  else if (drag && drag.t !== 'place' && !((drag.t === 'grab' || drag.t === 'rotate') && !drag.gz)) {
    cancelTransform();
    snapGrab = null;
    moveGizmo.setHot(null); rotGizmo.setHot(null);
    syncProps();
  }
  if (gizmoPausedControls) {
    gizmoPausedControls = false;
    if (!fly) controls.enabled = true;
    // 暂停期间 OrbitControls 没记手指位置：补上，不然双指一开始视图会跳
    const known = (controls as unknown as { _pointerPositions: Record<number, THREE.Vector2> })._pointerPositions;
    for (const [id, p] of touchPos) known[id]?.set(p.x, p.y);
  }
  updateStatus();
}
function pressMarquee() {
  if (drag?.t !== 'click') return;
  const { sx, sy } = drag;
  drag = { t: 'marquee', sx, sy, add: true };
  pauseControls();
  navigator.vibrate?.(12);
  showMarquee(sx, sy, sx, sy);
  updateStatus();
}
let pinchDist = 0;
const fingerDist = () => { const [a, b] = [...touchPos.values()]; return Math.hypot(a.x - b.x, a.y - b.y); };
el.addEventListener('pointerdown', (e) => {
  if (e.pointerType !== 'touch') return;
  touchPos.set(e.pointerId, { x: e.clientX, y: e.clientY });
  pinchDist = touchPos.size === 2 ? fingerDist() : 0;
  clearTimeout(pressTimer);
  pressAt = { x: e.clientX, y: e.clientY };
  if (touchPos.size === 1 && !touchMarquee) pressTimer = window.setTimeout(pressMarquee, LONG_PRESS_MS);
  if (touchPos.size > 1) yieldToGesture();
}, true);
window.addEventListener('pointermove', (e) => {
  if (e.pointerType !== 'touch' || !touchPos.has(e.pointerId)) return;
  touchPos.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (Math.hypot(e.clientX - pressAt.x, e.clientY - pressAt.y) >= 10) { clearTimeout(pressTimer); touchTap = null; }
  if (touchPos.size !== 2) return;
  const d = fingerDist();
  if (pinchDist > 0 && d > 0) {
    const cur = zoomGoal ?? camera.position.distanceTo(controls.target);
    zoomGoal = THREE.MathUtils.clamp(cur * (pinchDist / d), 2, 3000);
  }
  pinchDist = d;
}, true);
for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, (e) => {
  if ((e as PointerEvent).pointerType !== 'touch') return;
  clearTimeout(pressTimer);
  touchPos.delete((e as PointerEvent).pointerId);
  pinchDist = touchPos.size === 2 ? fingerDist() : 0;
  if (touchTap && touchPos.size === 0) { const t = touchTap; touchTap = null; if (e.type === 'pointerup') t.fn(); }
  if (touchPos.size === 0) {
    grabTouchId = null;
    // 放置模式抬手后还没结束：环视要还回去，下一根手指 OrbitControls 才记得住
    if (gizmoPausedControls && drag?.t === 'grab' && !drag.gz) { gizmoPausedControls = false; controls.enabled = true; }
  }
}, true);
window.addEventListener('blur', () => { touchPos.clear(); touchTap = null; pinchDist = 0; });
// 双指操作视图时，别的手指碰到面板、按钮都不算（手掌、拇指误触）
for (const t of ['pointerdown', 'click']) window.addEventListener(t, (e) => {
  if (touchPos.size >= 2 && e.target !== el) { e.stopImmediatePropagation(); e.preventDefault(); }
}, true);
// iOS Safari 不认 user-scalable=no：双指缩放整个页面要另外拦住
document.addEventListener('gesturestart', (e) => e.preventDefault());

/** 框选开关（touchMarquee 在文件开头）：触摸屏上打开时单指拖是框选（这时单指不环视，双指照常平移缩放） */
const touchMarqueeBtn = document.getElementById('touch-marquee')!;
touchMarqueeBtn.addEventListener('click', () => {
  touchMarquee = !touchMarquee;
  touchMarqueeBtn.classList.toggle('active', touchMarquee);
  controls.touches.ONE = (touchMarquee ? -1 : THREE.TOUCH.ROTATE) as THREE.TOUCH;
  announceTool(touchMarqueeBtn, touchMarquee ? '多选 · 单指拖动框选，轻点加选 / 减选' : '退出多选 · 单指拖动环视', true);
  updateStatus();
  touchMarqueeBtn.blur();
  updateStatus();
});

/** 属性面板：触摸屏上点标题收起 / 展开（只剩标题一行，不挡视图） */
props.addEventListener('click', (ev) => {
  if (!touchUI || !(ev.target as Element).closest('.title')) return;
  props.classList.toggle('mini');
});

/** 全屏（安卓上进了全屏才能锁定横屏；iPhone 的 Safari 没有网页全屏） */
const canFullscreen = !!document.documentElement.requestFullscreen && !/iPad|iPhone|iPod/.test(navigator.userAgent);
async function fullscreenLandscape() {
  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    await (screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> }).lock?.('landscape');
  } catch { /* 不支持锁定方向就算了，全屏也行 */ }
}

/** 窄屏（电脑上 1260 宽以下）：顶栏和手机一样，次要按钮收进「更多」（body.narrow，样式见 app.css） */
const NARROW_MQ = matchMedia('(max-width: 1260px)');
const syncNarrow = () => document.body.classList.toggle('narrow', NARROW_MQ.matches);
NARROW_MQ.addEventListener('change', syncNarrow);
syncNarrow();
/** 顶栏放不下的按钮收在「更多」里：点菜单项就是点对应的按钮 */
const moreBtn = document.getElementById('more-btn')!, moreMenu = document.getElementById('more-menu')!;
moreMenu.querySelector<HTMLElement>('[data-more="fullscreen"]')!.hidden = !canFullscreen;
const MORE_TARGET: Record<string, string> = { help: 'help', settings: 'settings', theme: 'theme', merge: 'merge', group: 'group', ungroup: 'ungroup', gizmo: 'gizmo', align: 'align', grid: 'grid' };
moreBtn.addEventListener('click', (ev) => {
  ev.stopPropagation();
  // 合并、绑定、解绑：和顶栏按钮一样，选中的东西不能做时变灰
  for (const k of ['merge', 'group', 'ungroup']) (moreMenu.querySelector(`[data-more="${k}"]`) as HTMLButtonElement).disabled = (document.getElementById(k) as HTMLButtonElement).disabled;
  // 手柄、对齐、格栅：开着的打个勾
  for (const k of ['gizmo', 'align', 'grid']) moreMenu.querySelector(`[data-more="${k}"]`)!.classList.toggle('on', document.getElementById(k)!.classList.contains('active'));
  moreMenu.classList.toggle('open');
});
moreMenu.addEventListener('click', (ev) => {
  const b = (ev.target as Element).closest<HTMLButtonElement>('button[data-more]');
  if (!b || b.disabled) return;
  ev.stopPropagation();
  moreMenu.classList.remove('open');
  if (b.dataset.more === 'fullscreen') { void fullscreenLandscape(); return; }
  document.getElementById(MORE_TARGET[b.dataset.more!])!.click();
});
document.addEventListener('click', (ev) => { if (!(ev.target as Element).closest?.('#more-menu, #more-btn')) moreMenu.classList.remove('open'); });

/** 竖屏提示里的「全屏并横屏」：只有能全屏的浏览器才显示；iPhone 上提示关掉方向锁定 */
const rotateLock = document.getElementById('rotate-lock')!;
rotateLock.hidden = !canFullscreen;
document.getElementById('rotate-ios')!.hidden = canFullscreen;
rotateLock.addEventListener('click', () => void fullscreenLandscape());

// ---------------- 移动手柄：选中后的 X / Y / Z 三根箭头，按住拖动沿那根轴移动 ----------------
const moveGizmo = new MoveGizmo();
scene.add(moveGizmo.group);
let gizmoPausedControls = false;
/** 手柄放在哪：选中整体的顶面中心 */
function gizmoOrigin(): THREE.Vector3 | null {
  if (!sel.size) return null;
  const b = boundsOf(doc, sel);
  return new THREE.Vector3((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.z1);
}
/** 现在该不该显示手柄：开着、选中了东西、不在别的工具或拖动里（拖手柄时照常显示） */
/** 手柄开关开着（默认开） */
const gizmoOn = () => prefs.gizmo ?? true;
const gizmoShown = () => gizmoOn() && mode() === 'move' && sel.size > 0 && !guardMode && !splitMode && !fly && (!drag || (drag.t === 'grab' && !!drag.gz));
/** 每帧画之前：放到选中整体的顶面中心，屏幕上保持大约 80 像素长（手指操作时再大一些） */
function syncGizmo(cam: THREE.Camera) {
  // 拖手柄时暂停了环视（手指按在手柄上，OrbitControls 也会开始转）：拖完（松手、右键、Esc）恢复
  if (gizmoPausedControls && !drag && !guardDrag) { gizmoPausedControls = false; if (!fly) controls.enabled = true; moveGizmo.setHot(null); rotGizmo.setHot(null); }
  syncRotGizmo(cam);
  const o = gizmoShown() ? gizmoOrigin() : null;
  moveGizmo.group.visible = !!o;
  if (!o) return;
  // 一个世界单位在屏幕上多长：把原点和沿相机上方向挪 1 的点投影过去量一下（透视、正交都适用）
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  const a = o.clone().project(cam), b = o.clone().add(up).project(cam);
  const pxPerUnit = Math.hypot((b.x - a.x) * renderer.domElement.clientWidth / 2, (b.y - a.y) * renderer.domElement.clientHeight / 2);
  const px = touchUI ? 96 : 80;
  moveGizmo.place(o, pxPerUnit > 1e-6 ? px / pxPerUnit : 1, touchUI ? 1.8 : 1);
}
/** 鼠标 / 手指下面是哪根箭头 */
function gizmoAt(e: { clientX: number; clientY: number }): 0 | 1 | 2 | null {
  if (!gizmoShown() || drag) return null;
  // 刚按下 Shift 时手柄还没画过（下一帧才摆好位置）：先摆好再拾取
  if (!moveGizmo.group.visible) syncGizmo(viewCam());
  setRay(e);
  return moveGizmo.hit(ray);
}
/** 按住箭头开始拖：就是限了轴的 G 移动，起点取按下的地方在这根轴上的位置（不会一按就跳），松手确定 */
function startGizmoDrag(e: { clientX: number; clientY: number }, axis: 0 | 1 | 2) {
  const o = gizmoOrigin();
  if (!o) return;
  snapshot();
  const b = boundsOf(doc, sel);
  let start = o.clone();
  if (axis === 2) {
    // 竖直：在朝着相机的竖直平面上拖（和 G 再按 Z 一样）
    const nrm = camera.getWorldDirection(new THREE.Vector3()).setZ(0).normalize();
    const p = planeHit(e, new THREE.Plane().setFromNormalAndCoplanarPoint(nrm, o));
    if (p) start = new THREE.Vector3(o.x, o.y, p.z);
  } else {
    const dir = new THREE.Vector3(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, 0);
    setRay(e);
    start = rayToSegment(ray.ray.origin, ray.ray.direction, o.clone().addScaledVector(dir, -1e4).toArray() as P3, o.clone().addScaledVector(dir, 1e4).toArray() as P3);
  }
  drag = { t: 'grab', orig: origOf(), b, start, axis, excl: null, grab: null, num: '', gz: true };
  moveGizmo.setHot(axis);
  pauseControls();
  el.setPointerCapture?.((e as PointerEvent).pointerId);
  hoverId = null;
  drawOverlay(); syncProps(); updateStatus();
}
/** 顶栏的开关 */
const gizmoBtn = document.getElementById('gizmo')!;
gizmoBtn.classList.toggle('active', gizmoOn());
gizmoBtn.addEventListener('click', () => {
  prefs.gizmo = !gizmoOn(); savePrefs();
  gizmoBtn.classList.toggle('active', prefs.gizmo);
  gizmoBtn.blur();
  flash(prefs.gizmo ? '手柄：开（移动、旋转、拉伸、坡面模式里显示）' : '手柄：关');
  invalidate();
});

// ---------------- 编辑模式（顶栏的模式按钮，状态在文件开头） ----------------
const HOLD_MS = 220;
/** 按住临时切换的键（e.key 小写） */
let held: { key: string; timer: number; temp: boolean } | null = null;
const modeButtons = [...document.querySelectorAll<HTMLButtonElement>('button[data-mode]')];
/** 按钮提示里的 {动作} 换成现在的按键（提示接管组件可能已经把 title 挪到 data-tip，两处都看） */
const keyTitles = [...document.querySelectorAll<HTMLElement>('[title*="{"], [data-tip*="{"]')].map((b) => ({ b, tpl: b.getAttribute('title') ?? b.dataset.tip! }));
/** 改了快捷键：按钮提示、模式按钮上的键帽、素材卡片说明、状态栏 */
function syncKeyLabels() {
  for (const { b, tpl } of keyTitles) b.setAttribute('title', tpl.replace(/\{([\w.]+)\}/g, (_, id: string) => keyText(id)));
  modeButtons.forEach((b) => { b.querySelector('kbd')!.textContent = keysOf(`mode.${b.dataset.mode}`).join('+'); });
  renderLib();
  updateStatus();
}
syncKeyLabels();
modeButtons.forEach((b) => b.addEventListener('click', () => {
  const m = b.dataset.mode as Mode;
  setPermMode(m);
  announceTool(b, permMode === m ? `${MODE_NAME[m]} · ${modeHint(m)}` : `退出${MODE_NAME[m]}，回到选择`);
  b.blur();
}));
const guardToolBtn = document.getElementById('guard-btn')!;
guardToolBtn.addEventListener('click', () => announceTool(guardToolBtn, guardMode ? '护栏 · 点路边放整条直边，沿路边拖放一段' : '退出护栏'));

/** 按钮只剩图标时（手机、窄窗口）看不出点的是什么：顶上说一声切到了哪个工具，连续切换只留最后一条 */
let toolNote: (typeof toasts)[number] | null = null;
function announceTool(b: HTMLElement, text: string, always = false) {
  if (!always && parseFloat(getComputedStyle(b).fontSize) !== 0) return;
  if (toolNote && toasts.includes(toolNote) && toolNote.text !== text) dropToast(toolNote);
  flash(text);
  toolNote = toasts[toasts.length - 1];
}

// ---------------- 鼠标指针：跟着工具和状态走 ----------------
installCursors();
const glyphOf = (sel: string) => document.querySelector(`${sel} svg`)?.innerHTML ?? '';
const MODE_GLYPH = Object.fromEntries(modeButtons.map((b) => [b.dataset.mode, b.querySelector('svg')!.innerHTML])) as Record<Mode, string>;
const GUARD_GLYPH = glyphOf('#guard-btn'), MARQUEE_GLYPH = glyphOf('#touch-marquee');
const THICK_GLYPH = '<path d="M8 3v10M8 3L6.3 4.7M8 3l1.7 1.7M8 13l-1.7-1.7M8 13l1.7-1.7M3 1.5h10M3 14.5h10"/>';
const EYE_GLYPH = '<path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"/><circle cx="8" cy="8" r="2"/>';
const MOD_GLYPH = { size: MODE_GLYPH.stretch, slope: MODE_GLYPH.slope, thick: THICK_GLYPH };
/** 中键环视 / Shift+中键平移（漫游是右键，单独处理） */
let camDrag: 'orbit' | 'pan' | null = null;
el.addEventListener('pointerdown', (e) => { if (e.button === 1) camDrag = e.shiftKey ? 'pan' : 'orbit'; }, true);
window.addEventListener('pointerup', (e) => { if (!(e.buttons & 4)) camDrag = null; }, true);

/** 现在 3D 视图该是什么指针：优先级从高到低是 漫游、拖动中、环视平移、护栏、悬停的手柄和开关、当前工具 */
function cursorNow(): string {
  if (fly) return 'none'; // 漫游只看屏幕中间的准星
  const mod = currentMod();
  const color = tempMode || (!permMode && mod) ? CURSOR_TINT.temp : CURSOR_TINT.accent;
  const tool = (base: CursorBase, glyph: string) => toolCursor(base, glyph, color);
  const t = drag?.t;
  if (t && t !== 'click') {
    if (t === 'marquee') return toolCursor('cross', MARQUEE_GLYPH, CURSOR_TINT.accent);
    if (t === 'rotate') return tool('fist', MODE_GLYPH.rotate);
    if (t === 'grab' || t === 'vsnap' || t === 'place') return tool('fist', MODE_GLYPH.move);
    if (t === 'thick') return tool('fist', THICK_GLYPH);
    if (t === 'tilt' || t === 'railTilt') return tool('fist', MODE_GLYPH.slope);
    return tool('fist', MODE_GLYPH.stretch);
  }
  if (camDrag) return camDrag === 'orbit' ? toolCursor('arrow', EYE_GLYPH, CURSOR_TINT.muted) : 'var(--cur-grabbing, grabbing)';
  if (guardMode) return guardEndHover ? 'var(--cur-ew-resize, ew-resize)' : tool('arrow', GUARD_GLYPH);
  const m = mode();
  const glyph = m ? MODE_GLYPH[m] : mod ? MOD_GLYPH[mod] : null;
  // 手柄上，或者已经识别出这次拖动要操作哪个手柄：都是能抓的手
  const aimed = handleHot ? handleHover : handleAim;
  const thickAimed = aimed?.startsWith('thick:') || (thickHover && (m === 'stretch' || mod === 'size'));
  if (aimed || thickAimed) return glyph ? tool('open', thickAimed ? THICK_GLYPH : glyph) : 'var(--cur-grab, grab)';
  if (stopHover || openHover) return glyph ? tool('hand', glyph) : 'var(--cur-pointer, pointer)';
  if (!glyph) return '';
  return tool(hoverId !== null && (m === 'move' || m === 'rotate') ? 'open' : 'arrow', glyph);
}
let cursorShown = '';
function syncCursor() {
  const v = cursorNow();
  if (v !== cursorShown) { cursorShown = v; el.style.cursor = v; }
}
/** 永久切换：选中的模式再选一次就取消（回到选择模式） */
function setPermMode(m: Mode) {
  exitGuard();
  permMode = permMode === m ? null : m;
  applyMode();
}
function clearModes() { permMode = tempMode = null; applyMode(); }
/** 模式变了：切分模式进出、按钮高亮（永久蓝色、临时橙色）、手柄和提示重画 */
function applyMode() {
  const m = mode();
  if (m === 'split' && !splitMode) enterSplit();
  else if (m !== 'split' && splitMode) exitSplit();
  modeButtons.forEach((b) => {
    b.classList.toggle('active', b.dataset.mode === permMode);
    b.classList.toggle('temp', b.dataset.mode === tempMode);
  });
  handleHover = null;
  moveGizmo.setHot(null); rotGizmo.setHot(null);
  handleHot = false;
  handleAim = null;
  dragInfo = '';
  drawOverlay(); updateStatus(); invalidate();
}
/** 坐标系：轴名、颜色、按键、属性面板跟着换；场景、存档和导出都不受影响 */
function applyCoordSys() {
  const game = prefs.coordSys !== 'math';
  AXIS_NAME = axisNames(game);
  AXIS_COLOR = axisLineColors(game);
  const cs = game ? [AXIS_COLORS.x, AXIS_COLORS.z, AXIS_COLORS.y] : [AXIS_COLORS.x, AXIS_COLORS.y, AXIS_COLORS.z];
  moveGizmo.setColors(cs); rotGizmo.setColors(cs);
  setGridAxes(gridGroup, game);
  themeGrid(gridGroup, GRID_THEMES[prefs.theme]);
  syncCubeAxes();
  props.dataset.id = '';
  syncProps(); updateStatus(); drawOverlay(); invalidate();
}
/** 手柄拖动期间暂停环视（手指按在手柄上，OrbitControls 也会开始转），拖完自动恢复（syncGizmo） */
function pauseControls() { controls.enabled = false; gizmoPausedControls = true; }

// 旋转模式的圆环
const rotGizmo = new RotateGizmo();
scene.add(rotGizmo.group);
applyCoordSys();
/** 旋转的轴心：选中整体的中心（和 R 旋转一样） */
function rotPivot(): THREE.Vector3 | null {
  if (!sel.size) return null;
  const b = boundsOf(doc, sel);
  return new THREE.Vector3((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
}
const rotShown = () => gizmoOn() && mode() === 'rotate' && sel.size > 0 && !guardMode && !fly && (!drag || (drag.t === 'rotate' && !!drag.gz));
function syncRotGizmo(cam: THREE.Camera) {
  const o = rotShown() ? rotPivot() : null;
  rotGizmo.group.visible = !!o;
  if (!o) return;
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(cam.quaternion);
  const a = o.clone().project(cam), b = o.clone().add(up).project(cam);
  const pxPerUnit = Math.hypot((b.x - a.x) * renderer.domElement.clientWidth / 2, (b.y - a.y) * renderer.domElement.clientHeight / 2);
  // 只能绕竖直轴转的（护栏、盘点）只显示 Z 环
  const tilt = [...sel].every((id) => canTilt(doc.elems[id]));
  rotGizmo.place(o, pxPerUnit > 1e-6 ? (touchUI ? 84 : 70) / pxPerUnit : 1, [tilt, tilt, true]);
}
function rotGizmoAt(e: { clientX: number; clientY: number }): 0 | 1 | 2 | null {
  if (!rotShown() || drag) return null;
  if (!rotGizmo.group.visible) syncRotGizmo(viewCam());
  return rotGizmo.hit(e.clientX, e.clientY, hitPx(8), (p) => { const q = toScreen([p.x, p.y, p.z]); return { x: q.x, y: q.y }; });
}
/** 按住圆环开始转：就是 R 旋转，转轴换成这个圆环的轴，松手确定 */
function startRingDrag(e: PointerEvent, axis: 0 | 1 | 2) {
  el.setPointerCapture(e.pointerId); pauseControls();
  startRotate(e);
  if (drag?.t !== 'rotate') return;
  drag.gz = true;
  drag.axis = axis; drag.acc = 0; drag.prev = screenAngle(drag.pivot, e);
  rotGizmo.setHot(axis);
  updateStatus();
}

// 拉伸 / 坡面模式的抓点（只对选中的一个东西）
type Handle = { kind: 'size' | 'thick' | 'tilt'; id: number; p: P3; side?: number };
const HANDLE_INFO: Record<Handle['kind'], string> = { size: '拖动：改尺寸', thick: '拖动：改厚度', tilt: '拖动：上下拉成坡' };
function modeHandles(): Handle[] {
  const m = mode();
  if ((m !== 'stretch' && m !== 'slope') || sel.size !== 1 || !gizmoOn()) return [];
  const e = doc.elems[[...sel][0]];
  if (!e) return [];
  const out: Handle[] = [];
  if ((e.kind === 'box' || e.kind === 'zone') && !e.q) {
    const f = footprint(e);
    const cx = (f.x0 + f.x1) / 2, cy = (f.y0 + f.y1) / 2;
    const top = (x: number, y: number) => (e.kind === 'box' ? boxTopAt(e, x, y) : e.z);
    // 四条边的中点（0：+x 1：+y 2：-x 3：-y）
    const mids: [number, number][] = [[f.x1, cy], [cx, f.y1], [f.x0, cy], [cx, f.y0]];
    if (m === 'stretch') {
      mids.forEach(([x, y], side) => out.push({ kind: 'size', id: e.id, p: toWorld(e, [x, y, top(x, y)]), side }));
      // 厚度：朝向相机那一面的底边中点；快俯视时底边和顶边在屏幕上叠在一起，往边外挪开，两个抓点都点得到
      const cam = toLocal(e, [camera.position.x, camera.position.y, camera.position.z]);
      const gaps = [cam[0] - f.x1, cam[1] - f.y1, f.x0 - cam[0], f.y0 - cam[1]];
      const sd = gaps.indexOf(Math.max(...gaps));
      const [mx, my] = mids[sd], [ox, oy] = ([[1, 0], [0, 1], [-1, 0], [0, -1]] as const)[sd];
      const z = top(mx, my) - e.depth;
      const bottom = toScreen(toWorld(e, [mx, my, z]));
      const gap = toScreen(toWorld(e, [mx, my, top(mx, my)])).distanceTo(bottom);
      const perUnit = bottom.distanceTo(toScreen(toWorld(e, [mx + ox, my + oy, z])));
      const need = hitPx(12) * 2 + 4;
      const push = gap < need && perUnit > 1e-6 ? (need + gap) / perUnit : 0;
      out.push({ kind: 'thick', id: e.id, p: toWorld(e, [mx + ox * push, my + oy * push, z]) });
    } else if (e.kind === 'box') {
      // 已经是坡的只能拉它的两头
      const sides = e.slope ? (e.slope.axis === 0 ? [0, 2] : [1, 3]) : [0, 1, 2, 3];
      for (const sd of sides) { const [x, y] = mids[sd]; out.push({ kind: 'tilt', id: e.id, p: toWorld(e, [x, y, top(x, y)]), side: sd }); }
    }
  } else if (e.kind === 'rail' && !e.q && e.pieces.length === 1 && e.pieces[0].angle === 0) {
    // 直轨：两头（拉伸改长度，坡面改高差）
    const ps = railPath(e);
    for (const q of [ps[0], ps[ps.length - 1]]) out.push({ kind: m === 'stretch' ? 'size' : 'tilt', id: e.id, p: [q.x, q.y, q.z] });
  }
  return out;
}
function setHandleAim(k: string | null) {
  if (k === handleAim) return;
  handleAim = k;
  drawOverlay(); invalidate();
}
/** 鼠标移动（或刚进拉伸 / 坡面模式）时：算出现在按下去拖的是哪个操作，判断规则和 modDrag 一样 */
function updateAim(e: { clientX: number; clientY: number }, mod: boolean) {
  thickHover = false;
  const m = mode();
  const h = sel.size === 1 && !vHeld && (m === 'stretch' || m === 'slope' || mod) ? (mod ? modHit(e) : pick(e)) : null;
  const it = h && sel.has(h.id) ? doc.elems[h.id] : null;
  if (!h || !it) { setHandleAim(null); return; }
  const flat = it.kind === 'box' || it.kind === 'zone' ? it : null;
  thickHover = !!flat && !flat.q && onLowerHalf(flat, h.p);
  const hs = modeHandles();
  let aim: Handle | undefined;
  if (flat && m === 'stretch' && thickHover) aim = hs.find((x) => x.kind === 'thick');
  else if (flat) {
    let side: number = nearSide(flat, h.p);
    if (m === 'slope' && flat.kind === 'box') { const t = tiltTarget(flat, h.p); side = t.axis + (t.hi ? 0 : 2); }
    aim = hs.find((x) => x.side === side);
  } else {
    // 钢轨：离鼠标最近的那一头
    const dist = (x: Handle) => Math.hypot(x.p[0] - h.p.x, x.p[1] - h.p.y, x.p[2] - h.p.z);
    aim = [...hs].sort((a, b) => dist(a) - dist(b))[0];
  }
  setHandleAim(aim ? `${aim.kind}:${aim.p.join()}` : null);
}
/** 厚度抓点跟着相机换边：相机动了要重画 */
let handlesKey = '';
function syncHandles() {
  const k = !drag && mode() === 'stretch' ? modeHandles().map((h) => h.p.join()).join('|') : '';
  if (k === handlesKey) return;
  handlesKey = k;
  if (k) {
    drawOverlay(); invalidate();
    // 按住 Ctrl / Alt 进模式时鼠标可能没动，这里也算一次
    if (!lastPointerTouch && document.elementFromPoint(lastMouse.clientX, lastMouse.clientY) === el) updateAim(lastMouse, modKeys.ctrl || modKeys.alt);
  }
}
function handleAt(e: { clientX: number; clientY: number }): Handle | null {
  if (drag) return null;
  const at = new THREE.Vector2(e.clientX, e.clientY);
  let best: Handle | null = null, bd = hitPx(12);
  for (const hd of modeHandles()) { const d = toScreen(hd.p).distanceTo(at); if (d < bd) { bd = d; best = hd; } }
  return best;
}
applyMode();
