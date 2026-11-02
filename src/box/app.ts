// Ballance Vibe Mapping 编辑器（box 版）：路面、素材件、机关、钢轨、护栏的放置与编辑
//   左键：点选 / 框选（Shift 加选）/ 拖动；Shift 拖动沿轴移动；Alt 拖动改高度；Ctrl 拖动改尺寸
//   按住 V 拖动：抓住顶点或边中点，吸附到别的元素的顶点、边中点或边上
//   格栅（G）：位置和尺寸吸附到步长 1；对齐（S）：边、中线、顶面靠近时对齐并画出辅助面
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MatName } from '../geom/floor';
import { FAKE_EXTRA, FAKE_FIX, OBJ_TYPES, fakeModel, objType } from '../model/objects';
import { stopperMesh } from '../model/stoppers';
import { type AssetPiece, fallbackBox, getAsset, getStopperMaterial, setAssetLoadedCallback } from '../view/assets';
import { floorTexturesReady, getMaterial, getRailMaterial } from '../view/materials';
import { buildRail } from '../geom/rail';
import { type RailPiece, SPIRAL_RADIUS, SPIRAL_SCREW, advance, type RailState, sampleRail } from '../model/rail';
import { Bounds, V3, boundsOf, duplicate, elemBounds, expandGroups, groupElems, mergeBoxes, rotateElem, splitBox, translateElem, ungroupElems } from './ops';
import { SCENES } from './scenes';
import { ASSET_INFO, assetInfo } from './asset-info';
import { thumbnail } from '../view/thumbs';
import { setTextureLoadedCallback } from '../view/assets';
import { GRID_THEMES, createGrid, themeGrid } from '../view/grid';
import { type P3, feats as featsRaw } from './snap';
import { solve } from './solve';
import { type Route, edgeAt, routeLen, shortPath } from './guard';
import { guardFromRoute } from '../geom/railing';
import { DEFAULT_SETTINGS } from '../model/types';
/** 全图设置：文档里改过的项覆盖默认值 */
const mapSettings = (): MapSettings => ({ ...DEFAULT_SETTINGS, ...(doc.settings ?? {}) });
import { type Loop, pathAlong, project, projectNear } from '../model/outline';
import { exportBoxNmo, exportBoxScene } from './export';
import type { MapSettings } from '../model/types';
import { Box, Dir, Doc, Elem, Obj, PieceType, RailElem, SINK_DEPTH, Style, anchorRects, baseSpec, boxTopAt, footprint, isCheckpoint, pieceLen, virtualCells } from './types';

const host = document.getElementById('viewport')!;
const statusEl = document.getElementById('status')!;
const hintsEl = document.getElementById('hints')!;
const props = document.getElementById('props')!;
const marqueeEl = document.getElementById('marquee')!;

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(window.devicePixelRatio);
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

const STORE = 'bvm.box.doc';
/** 本机偏好：素材库在哪一侧、格栅步长、机关显示方式、主题 */
interface Prefs { side: 'left' | 'right'; gridStep: number; modelView: boolean; theme: 'dark' | 'light'; tab: string }
const prefs: Prefs = (() => {
  const d: Prefs = { side: 'right', gridStep: 1, modelView: true, theme: 'dark', tab: 'road' };
  try { return { ...d, ...JSON.parse(localStorage.getItem('bvm.box.prefs') ?? '{}') }; } catch { return d; }
})();
const savePrefs = () => { try { localStorage.setItem('bvm.box.prefs', JSON.stringify(prefs)); } catch { /* 存不了就算了 */ } };
/** 按格栅步长取整 */
const snapG = (v: number) => Math.round(v / prefs.gridStep) * prefs.gridStep;
let doc: Doc = (() => { try { const s = localStorage.getItem(STORE); if (s) return JSON.parse(s) as Doc; } catch { /* 读不了就用测试场景 */ } return SCENES[0].build(); })();
let sel = new Set<number>();
let gridOn = false;
let alignOn = true; // 自动对齐默认开着，格栅默认关着
/** 新放的机关归到第几小节（顶栏的下拉框；放盘点时自动切到它的小节） */
let placeSector = 1;
let showSectors = false;
let wireOn = false;
let modelView = prefs.modelView;
let vHeld = false;
let splitMode = false;
/** 护栏工具：点路面外沿放一整条直边的护栏，按住拖动沿外沿放一段 */
let guardMode = false;
let loops: Loop[] = [];
let guardPreview: Route | null = null;
/** 护栏工具的拖动：从 s0 沿外沿拖；replace：正在拖某条护栏的端头 */
let guardDrag: { loop: number; s0: number; a: P3; replace?: number; moved: boolean } | null = null;
let splitAxis: 0 | 1 | null = null; // null：按路面较长的方向自动选
const undo: string[] = [];
const redo: string[] = [];
const snapshot = () => { undo.push(JSON.stringify(doc)); redo.length = 0; if (undo.length > 200) undo.shift(); };
const save = () => { try { localStorage.setItem(STORE, JSON.stringify(doc)); } catch { /* 存不了就算了 */ } };

let flashMsg: { text: string; until: number; warn?: boolean } | null = null;
const flash = (text: string, warn = false) => { flashMsg = { text, until: performance.now() + 3000, warn }; updateStatus(); };

// ---------------- 渲染 ----------------

let pickables: THREE.Object3D[] = [];
const lastSolve = { ms: 0, tris: 0 };
const objBoxes = new Map<number, THREE.Box3>();

function addMeshes(group: THREE.Group, pieces: AssetPiece[], id: number, place: (m: THREE.Mesh) => void) {
  for (const pc of pieces) {
    const mesh = new THREE.Mesh(pc.geometry, pc.material);
    place(mesh);
    mesh.userData.id = id;
    mesh.updateMatrixWorld();
    group.add(mesh);
    pickables.push(mesh);
  }
}

/** 清掉上一次生成的网格（资产库模型的几何体是共用的，不能释放） */
function clearWorld() {
  world.traverse((o) => { if ((o as THREE.Mesh).geometry && o.userData.own) (o as THREE.Mesh).geometry.dispose(); });
  world.clear();
}

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
  loops = solved.loops;
  lastSolve.ms = performance.now() - t0;
  let tris = 0;
  for (const m of solved.meshes.values()) {
    const g = new THREE.Group();
    for (const [mat, part] of Object.entries(m.parts) as [MatName, { pos: number[]; uv: number[] }][]) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(part.uv, 2));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, getMaterial(mat));
      mesh.userData.own = true;
      // 自动生成的转换件属于它嵌进去的那块路面
      mesh.userData.id = doc.elems[m.id] ? m.id : solved.owner.get(m.id) ?? m.id;
      g.add(mesh);
      pickables.push(mesh);
      tris += part.pos.length / 9;
      if (wireOn) { const w = new THREE.LineSegments(new THREE.WireframeGeometry(geo), WIRE_MAT); w.userData.own = true; g.add(w); }
    }
    addGroup(doc.elems[m.id] ? m.id : solved.owner.get(m.id) ?? m.id, g);
  }
  lastSolve.tris = tris;
  // 专属路块、盘点路面（资产库模型 + 火焰 / 重生点占位符）
  for (const [id, parts] of solved.assets) {
    const g = new THREE.Group();
    for (const part of parts) {
      const pieces = getAsset(part.kind, part.name) ?? (part.kind === 'asset' ? [fallbackBox(5, 5, 5)] : []);
      addMeshes(g, pieces, id, (m) => { m.position.set(...part.pos); m.rotation.z = (part.rotZ * Math.PI) / 180; });
    }
    addGroup(id, g);
    if (doc.elems[id]?.kind === 'piece' && g.children.length) objBoxes.set(id, new THREE.Box3().setFromObject(g));
  }
  // 特殊路面（资产库模型）
  for (const e of Object.values(doc.elems)) {
    if (e.kind !== 'asset') continue;
    const g = new THREE.Group();
    const pieces = getAsset('asset', e.name) ?? [];
    addMeshes(g, pieces, e.id, (m) => { m.position.set(e.x, e.y, e.z); m.rotation.z = (e.rot * Math.PI) / 2; });
    addGroup(e.id, g);
    if (g.children.length) objBoxes.set(e.id, new THREE.Box3().setFromObject(g));
  }
  // 机关、装饰、挡块
  for (const e of Object.values(doc.elems)) {
    if (e.kind !== 'obj') continue;
    const g = new THREE.Group();
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
    const st = e.noStopper ? null : stopperMesh({ id: 0, cat: 'module', type: e.type, x: e.x, y: e.y, z: e.z, rot: deg });
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
    addGroup(e.id, g);
    if (g.children.length) objBoxes.set(e.id, new THREE.Box3().setFromObject(g));
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
    const rm = buildRail(e);
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
  if (drag?.t === 'place') return [H(['LMB'], '松开放下'), H(['R'], '旋转'), H(['RMB'], '取消')];
  if (fly) return [H(['W', 'A', 'S', 'D'], '移动'), H(['Space'], '上升'), H(['Shift'], '下降'), H(['Wheel'], `速度 ${fly.speed.toFixed(0)}`), H(['RMB'], '松开退出漫游')];
  if (drag) return [H(['LMB'], '松开完成'), H(['G'], gridOn ? '格栅：开' : '格栅：关'), H(['S'], alignOn ? '对齐：开' : '对齐：关')];
  if (guardMode) return [H(['LMB'], '点路边：放整条直边'), H(['LMB'], '沿路边拖：放一段'), H(['LMB'], '拖把手：改长度'), H(['Esc'], '退出')];
  if (splitMode) return [H(['LMB'], '在鼠标处切开'), H(['Tab'], '换方向'), H(['Esc'], '退出')];
  if (vHeld) return [H(['V', 'LMB'], '抓住顶点 / 边中点拖到别的物体上吸附')];
  const hs = [H(['MMB'], '环视'), H(['Shift', 'MMB'], '平移'), H(['RMB'], '漫游'), H(['Wheel'], '缩放')];
  if (sel.size) hs.push(H(['LMB'], '移动'), H(['Shift', 'LMB'], '沿轴'), H(['Alt', 'LMB'], '高度'), H(['Ctrl', 'LMB'], '尺寸'), H(['Alt', 'Shift', 'LMB'], '拉坡'), H(['V'], '吸附'), H(['F'], '聚焦'), H(['X'], '删除'));
  else hs.push(H(['LMB'], '选择 / 框选'), H(['F'], '看全部'));
  return hs;
}
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
sectorEye.addEventListener('click', () => { showSectors = !showSectors; sectorEye.classList.toggle('active', showSectors); sectorEye.blur(); syncSectorLabels(); });
/** 机关上的小节编号（顶栏的眼睛打开时显示） */
const secLabels = new Map<number, HTMLDivElement>();
function syncSectorLabels() {
  const live = new Set<number>();
  if (showSectors) for (const e of Object.values(doc.elems)) {
    if (e.kind !== 'obj' || objType(e.type)?.cat !== 'module' || e.type === 'PE_Balloon') continue;
    live.add(e.id);
    let l = secLabels.get(e.id);
    if (!l) { l = document.createElement('div'); l.className = 'sec-label'; document.body.appendChild(l); secLabels.set(e.id, l); }
    l.textContent = String(Math.min(e.sector ?? 1, sectorCount()));
  }
  for (const [id, l] of secLabels) if (!live.has(id)) { l.remove(); secLabels.delete(id); }
}
function placeSectorLabels() {
  const r = host.getBoundingClientRect();
  for (const [id, l] of secLabels) {
    const e = doc.elems[id];
    if (e?.kind !== 'obj') continue;
    const a = anchorRects(e)[0];
    const p = new THREE.Vector3(a ? (a.x0 + a.x1) / 2 : e.x, a ? (a.y0 + a.y1) / 2 : e.y, (a ? a.top : e.z) + 4);
    const v = p.clone().project(camera);
    const sx = (v.x + 1) / 2 * r.width + r.left, sy = (1 - v.y) / 2 * r.height + r.top;
    l.style.display = v.z > 1 || sx < r.left || sx > r.right || sy < r.top || sy > r.bottom ? 'none' : '';
    l.style.left = `${sx}px`; l.style.top = `${sy}px`;
  }
}
function updateStatus() {
  syncOps();
  syncSector();
  const parts: string[] = [];
  if (flashMsg && performance.now() < flashMsg.until) parts.push(flashMsg.warn ? `<span class="warn">${flashMsg.text}</span>` : `<b>${flashMsg.text}</b>`);
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
setInterval(() => { if (flashMsg && performance.now() > flashMsg.until) { flashMsg = null; updateStatus(); } }, 500);

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
function cornersOf(e: Elem): P3[] {
  const ob = e.kind === 'obj' || e.kind === 'guard' || e.kind === 'asset' || isCheckpoint(e) ? objBoxes.get(e.id) : null;
  if (ob) {
    const a = ob.min, b = ob.max;
    return [[a.x, a.y, b.z], [b.x, a.y, b.z], [b.x, b.y, b.z], [a.x, b.y, b.z], [a.x, a.y, a.z], [b.x, a.y, a.z], [b.x, b.y, a.z], [a.x, b.y, a.z]];
  }
  const v = feats(e).verts; // boxFeats：顶面 4 个、底面 4 个，同样的顺序
  return v.length >= 8 ? v.slice(0, 8) : v;
}

function outlineOf(e: Elem, color: number, opacity = 1): THREE.Object3D {
  const c = e.kind === 'rail' ? [] : cornersOf(e);
  const segs: P3[] = [];
  if (e.kind === 'rail') {
    // 钢轨：沿两根轨（双轨最顶端的高度）画线，两头画横杠
    const ps = sampleRail(e);
    const side = (s: RailState, k: number): P3 => { const h = (s.heading * Math.PI) / 180; return [s.x - Math.sin(h) * 1.875 * k, s.y + Math.cos(h) * 1.875 * k, s.z + 0.05]; };
    for (let i = 0; i + 1 < ps.length; i++) for (const k of [1, -1]) segs.push(side(ps[i], k), side(ps[i + 1], k));
    for (const s of [ps[0], ps[ps.length - 1]]) segs.push(side(s, 1), side(s, -1));
  }
  if (c.length === 8) for (const [i, j] of [[0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7]]) segs.push(c[i], c[j]);
  const geo = new THREE.BufferGeometry().setFromPoints(segs.map((p) => new THREE.Vector3(...p)));
  const l = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
  l.renderOrder = 5;
  return l;
}

/** 选中物体的半透明包裹面 */
function hullOf(e: Elem, color: number, opacity: number): THREE.Object3D | null {
  if (e.kind === 'rail') return null; // 钢轨只沿两根轨画选中线，不画方块
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
    const z0 = r.top - 5, z1 = r.top + 0.03;
    const c = [[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]];
    for (let i = 0; i < 4; i++) {
      const [x, y] = c[i], [x2, y2] = c[(i + 1) % 4];
      segs.push(new THREE.Vector3(x, y, z1), new THREE.Vector3(x2, y2, z1), new THREE.Vector3(x, y, z0), new THREE.Vector3(x2, y2, z0), new THREE.Vector3(x, y, z0), new THREE.Vector3(x, y, z1));
    }
  }
  const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segs), new THREE.LineDashedMaterial({ color: 0xffb84c, dashSize: 0.5, gapSize: 0.35, transparent: true, opacity: 0.95, depthTest: false }));
  l.computeLineDistances();
  l.renderOrder = 6;
  return l;
}

let hoverId: number | null = null;
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
measureLabel.style.display = 'none';
document.body.appendChild(measureLabel);
const AXIS_COLOR = [0xff5a5a, 0x5adc7a, 0x5a9cff];

function drawOverlay() {
  for (const layer of [overlay, selLayer]) {
    layer.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry) m.geometry.dispose(); const mt = m.material as THREE.Material | undefined; mt?.dispose(); /* 贴图不跟着材质释放，吸附点的贴图可以复用 */ });
    layer.clear();
  }
  const hoverGroup = hoverId !== null ? expandGroups(doc, [hoverId]) : new Set<number>();
  for (const id of hoverGroup) if (!sel.has(id) && doc.elems[id]) overlay.add(outlineOf(doc.elems[id], 0x9fc2ff, 0.45));
  const selElems = anim?.preview ? anim.preview(anim.val) : [...sel].map((id) => doc.elems[id]);
  for (const e of selElems) {
    if (!e) continue;
    const c = snapping && drag ? 0x4cff8a : 0x4c8dff;
    const hull = hullOf(e, c, 0.16);
    if (hull) selLayer.add(hull);
    selLayer.add(outlineOf(e, c));
  }
  // 机关的对准方块、盘点路口的虚拟路面：悬停、选中、吸附时靠近的都画出来
  for (const id of new Set([...hoverGroup, ...sel, ...(drag ? nearVirtual : [])])) {
    const e = doc.elems[id];
    if (e && virtualCells(e).length) (sel.has(id) ? selLayer : overlay).add(anchorBoxes(e));
  }
  // 按住 V：显示鼠标下元素的顶点和边中点
  // 按住 V：有选中的东西时只显示选中物体的顶点 / 边中点（不管鼠标移到哪），否则显示鼠标下的物体
  const vIds = vHeld && !drag ? (sel.size ? [...sel] : hoverId !== null ? [hoverId] : []) : [];
  for (const id of vIds) {
    if (!doc.elems[id]) continue;
    const f = feats(doc.elems[id]);
    overlay.add(marks(f.verts, 'dot', 0xffd34c, 11), marks(f.mids, 'diamond', 0xffd34c, 10, 0.85));
  }
  if (snapGrab) overlay.add(marks([snapGrab], 'dot', 0xff8a4c, 13));
  if (snapTarget) overlay.add(marks([snapTarget.p], snapTarget.kind === 'v' ? 'dot' : snapTarget.kind === 'm' ? 'diamond' : 'ring', 0x4cff8a, 18));
  for (const gd of guides) overlay.add(guideLines(gd));
  if (axisLine) {
    const d = new THREE.Vector3(...[0, 1, 2].map((i) => (i === axisLine!.axis ? 1 : 0)));
    const geo = new THREE.BufferGeometry().setFromPoints([axisLine.p.clone().addScaledVector(d, -500), axisLine.p.clone().addScaledVector(d, 500)]);
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: AXIS_COLOR[axisLine.axis], transparent: true, opacity: 0.9, depthTest: false }));
    l.renderOrder = 6;
    overlay.add(l);
  }
  measureLabel.style.display = 'none';
  if (measure) {
    const color = measure.on5 ? 0x4cff8a : 0xe6ebf5;
    const A = new THREE.Vector3(...measure.a), B = new THREE.Vector3(...measure.b);
    const side = new THREE.Vector3(...measure.tick);
    const segs = [A, B, A.clone().sub(side), A.clone().add(side), B.clone().sub(side), B.clone().add(side)];
    const l = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(segs), new THREE.LineBasicMaterial({ color, depthTest: false }));
    l.renderOrder = 7;
    overlay.add(l);
    const m = toScreen(A.clone().add(B).multiplyScalar(0.5));
    Object.assign(measureLabel.style, { display: 'block', left: `${m.x}px`, top: `${m.y}px`, color: measure.on5 ? '#0b2a14' : '#e6ebf5', background: measure.on5 ? '#4cff8a' : 'rgba(20,26,38,.85)' });
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
      overlay.add(m);
    }
  }
  // 选中一块路面时：四条边的中点显示开口开关（实心点：封口；绿色圆环：开口），点一下切换
  if (!drag && !guardMode && !splitMode) for (const t of openToggles()) {
    overlay.add(marks([t.p], t.open ? 'ring' : 'dot', t.open ? 0x4cff8a : t.id === openHover?.id && t.side === openHover.side ? 0xffffff : 0x9aa6bd, t.id === openHover?.id && t.side === openHover.side ? 16 : 12));
  }
  // 护栏工具里：每条护栏两头的把手（拖它改长度），鼠标靠近的那个放大变绿
  if (guardMode) {
    for (const g of Object.values(doc.elems)) {
      if (g.kind !== 'guard') continue;
      ([0, 1] as const).forEach((end) => {
        const on = guardEndHover?.id === g.id && guardEndHover.end === end;
        overlay.add(marks([guardHandle(g, end)], 'dot', on ? 0x4cff8a : 0xffd34c, on ? 16 : 11));
      });
    }
  }
  if (splitPreview) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...splitPreview.a), new THREE.Vector3(...splitPreview.b)]);
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffd34c, depthTest: false }));
    l.renderOrder = 6;
    overlay.add(l, marks([splitPreview.a, splitPreview.b], 'dot', 0xffd34c, 9));
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
  ray.setFromCamera(ndc, camera);
}
function pick(e: { clientX: number; clientY: number }, skip?: Set<number>): { id: number; p: THREE.Vector3 } | null {
  setRay(e);
  for (const h of ray.intersectObjects(pickables, false)) {
    const id = h.object.userData.id as number;
    if (!skip?.has(id) && doc.elems[id]) return { id, p: h.point.clone() };
  }
  return null;
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
  const v = (Array.isArray(p) ? tmpV.set(p[0], p[1], p[2]) : tmpV.copy(p)).project(camera);
  const r = canvasRect;
  return new THREE.Vector2((v.x + 1) / 2 * r.width + r.left, (1 - v.y) / 2 * r.height + r.top);
}
/** 某一点附近一个像素对应多少世界单位 */
function worldPerPx(p: THREE.Vector3) {
  const d = camera.position.distanceTo(p);
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
    if (exclude.has(e.id)) continue;
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
  // 参与对齐的坐标：一般按包围盒（两边 + 中线、顶面 + 底面）；钢轨只用它的吸附点（两头中心、两根轨的顶端），不然太多
  const vals = (e: Elem, a: 0 | 1 | 2): number[] => {
    if (e.kind === 'rail') return [...new Set(feats(e).verts.map((v) => +v[a].toFixed(4)))];
    const x = elemBounds(e);
    return a === 0 ? [x.x0, x.x1, (x.x0 + x.x1) / 2] : a === 1 ? [x.y0, x.y1, (x.y0 + x.y1) / 2] : [x.z1, x.z0];
  };
  const others = Object.values(doc.elems).filter((e) => !sel.has(e.id));
  const selElems = [...sel].map((id) => doc.elems[id]).filter(Boolean);
  const onlyRails = selElems.length > 0 && selElems.every((e) => e.kind === 'rail');
  const hits: { a: 0 | 1 | 2; value: number; ob: Bounds }[] = [];
  for (const a of axes) {
    let best: { diff: number; value: number; ob: Bounds } | null = null;
    const base = onlyRails ? [...new Set(selElems.flatMap((e) => vals(e, a)))] : (a === 0 ? [b.x0, b.x1, (b.x0 + b.x1) / 2] : a === 1 ? [b.y0, b.y1, (b.y0 + b.y1) / 2] : [b.z1, b.z0]);
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
    if (sel.has(e.id) || e.kind !== 'box' || e.slope) continue;
    const f = footprint(e);
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
  | { t: 'move'; orig: Map<number, string>; b: Bounds; plane: THREE.Plane; start: THREE.Vector3; grab?: boolean }
  | { t: 'axis'; orig: Map<number, string>; b: Bounds; start: THREE.Vector3; sx: number; sy: number; axis: 0 | 1 | null }
  | { t: 'lift'; orig: Map<number, string>; b: Bounds; plane: THREE.Plane; start: THREE.Vector3 }
  | { t: 'size'; id: number; orig: Map<number, string>; plane: THREE.Plane; start: THREE.Vector3; side: Dir }
  | { t: 'railLen'; id: number; orig: Map<number, string>; plane: THREE.Plane; start: THREE.Vector3 }
  | { t: 'railTilt'; id: number; orig: Map<number, string>; plane: THREE.Plane; start: THREE.Vector3 }
  | { t: 'guardLen'; id: number; orig: Map<number, string>; plane: THREE.Plane; loop: number; sFixed: number; sNear: number; moveB: boolean }
  | { t: 'tilt'; id: number; orig: Map<number, string>; plane: THREE.Plane; start: THREE.Vector3; axis: 0 | 1; hi: boolean }
  | { t: 'vsnap'; orig: Map<number, string>; grab: P3; plane: THREE.Plane }
  | { t: 'marquee'; sx: number; sy: number; add: boolean }
  | { t: 'place'; ids: number[] | null; orig?: Map<number, string>; type: string; moved: boolean; rotOff: number }
  | { t: 'click'; id: number; sx: number; sy: number; orig: Map<number, string>; b: Bounds; start: THREE.Vector3 };
let drag: Drag | null = null;

const origOf = (ids: Iterable<number> = sel) => new Map([...ids].map((id) => [id, JSON.stringify(doc.elems[id])]));
function restore(orig: Map<number, string>) { for (const [id, s] of orig) doc.elems[id] = JSON.parse(s); }
/** 拖动整体平移：鼠标位置 dRaw，自动对齐给出 dSnap（和 dRaw 一样时表示没吸上） */
function moveWithSnap(orig: Map<number, string>, dRaw: V3, dSnap: V3) {
  const on = dSnap.some((v, i) => Math.abs(v - dRaw[i]) > 1e-6);
  drive(dRaw, on ? dSnap : null, (v) => moveSel(orig, v as V3), [0, 0, 0], { ids: new Set(orig.keys()) });
  const f = on ? dSnap : dRaw;
  dragInfo = `移动 ${fmt(f[0])}, ${fmt(f[1])}, ${fmt(f[2])}${on ? '（对齐）' : ''}`;
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
let fly: { keys: Set<string>; speed: number; dist: number } | null = null;
let flySpeed = 30;
el.addEventListener('pointerdown', (e) => {
  if (e.button !== 2 || drag) return;
  e.preventDefault();
  fly = { keys: new Set(), speed: flySpeed, dist: camera.position.distanceTo(controls.target) };
  controls.enabled = false;
  zoomGoal = null; camAnim = null;
  el.setPointerCapture(e.pointerId);
  el.requestPointerLock?.();
  updateStatus();
}, true);
function endFly() {
  if (!fly) return;
  // 视图中心放回相机前方原来的距离处，之后环视、缩放照常
  const dir = camera.getWorldDirection(new THREE.Vector3());
  controls.target.copy(camera.position).addScaledVector(dir, fly.dist);
  flySpeed = fly.speed;
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
  // 鼠标转视角：水平绕世界 Z 轴，竖直绕相机右方向（不翻过头顶）
  const k = 0.0025;
  const dir = camera.getWorldDirection(new THREE.Vector3());
  const yaw = -e.movementX * k, pitch = -e.movementY * k;
  dir.applyAxisAngle(new THREE.Vector3(0, 0, 1), yaw);
  const right = new THREE.Vector3().crossVectors(dir, camera.up).normalize();
  const d2 = dir.clone().applyAxisAngle(right, pitch);
  if (Math.abs(d2.z) < 0.995) dir.copy(d2);
  camera.lookAt(camera.position.clone().add(dir));
}, true);
// 漫游时键盘只管移动（不触发别的快捷键）
window.addEventListener('keydown', (e) => {
  if (!fly) return;
  const k = e.code;
  if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'ShiftLeft', 'ShiftRight', 'KeyQ', 'KeyE'].includes(k)) fly.keys.add(k);
  e.preventDefault(); e.stopImmediatePropagation();
}, true);
window.addEventListener('keyup', (e) => { if (fly) { fly.keys.delete(e.code); e.stopImmediatePropagation(); } }, true);
renderer.domElement.addEventListener('wheel', (e) => {
  if (!fly) return;
  // 漫游时滚轮调速度
  e.preventDefault(); e.stopImmediatePropagation();
  fly.speed = THREE.MathUtils.clamp(fly.speed * Math.exp(-e.deltaY * 0.0015), 2, 400);
  updateStatus();
}, { passive: false, capture: true });
function tickFly(dt: number) {
  if (!fly) return;
  const f = camera.getWorldDirection(new THREE.Vector3());
  const r = new THREE.Vector3().crossVectors(f, camera.up).normalize();
  const m = new THREE.Vector3();
  const k = fly.keys;
  if (k.has('KeyW')) m.add(f);
  if (k.has('KeyS')) m.sub(f);
  if (k.has('KeyD')) m.add(r);
  if (k.has('KeyA')) m.sub(r);
  if (k.has('Space') || k.has('KeyE')) m.z += 1;
  if (k.has('ShiftLeft') || k.has('ShiftRight') || k.has('KeyQ')) m.z -= 1;
  if (m.lengthSq() === 0) return;
  camera.position.addScaledVector(m.normalize(), fly.speed * dt);
}

el.addEventListener('pointerdown', (e) => {
  // 右键现在是环视：只在复制跟随鼠标时用来取消；护栏 / 切分工具用 Esc 或点「选择」退出
  if (e.button === 2 && drag?.t === 'move' && drag.grab) { cancelGrab(); return; }
  if (e.button !== 0) return;
  if (drag?.t === 'move' && drag.grab) { finishDrag(); return; } // 复制后跟着鼠标走：点击放下
  if (splitMode) { doSplit(e); return; }
  if (guardMode) { guardDown(e); return; }
  // 点路面边上的开口开关：切换这一侧开口 / 封口
  const tog = !e.ctrlKey && !e.altKey && !e.shiftKey && !vHeld ? openToggleAt(e) : null;
  if (tog) {
    snapshot();
    const b = doc.elems[tog.id] as Box;
    b.open = ((b.open ?? 0) ^ (1 << tog.side)) || undefined;
    flash(b.open && b.open & (1 << tog.side) ? '这一侧开口（不画边框，露出凹槽截面）' : '这一侧封口');
    rebuild();
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
    if (!inside) { drag = { t: 'marquee', sx: e.clientX, sy: e.clientY, add: e.shiftKey }; return; }
    snapshot();
    let grab: P3 | null = null, bd = Infinity;
    for (const id of sel) { const f = feats(doc.elems[id]); for (const v of [...f.verts, ...f.mids]) { const d = toScreen(v).distanceTo(at); if (d < bd) { bd = d; grab = v; } } }
    if (!grab) return;
    drag = { t: 'vsnap', orig: origOf(), grab, plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -grab[2]) };
    snapGrab = grab;
    drawOverlay(); syncProps(); updateStatus();
    return;
  }
  let h = pick(e);
  // 按住 Ctrl / Alt / V 时只操作已经选中的东西：鼠标下面就算是别的路面也不会选到它
  if ((e.ctrlKey || e.altKey || vHeld) && sel.size) {
    const others = new Set(Object.keys(doc.elems).map(Number).filter((id) => !sel.has(id)));
    const hs = pick(e, others);
    if (hs) h = hs;
    else {
      const b = boundsOf(doc, sel);
      const p = planeHit(e, new THREE.Plane(new THREE.Vector3(0, 0, 1), -b.z1)) ?? new THREE.Vector3((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.z1);
      h = { id: [...sel][0], p };
    }
  }
  el.setPointerCapture(e.pointerId);
  if (!h) { drag = { t: 'marquee', sx: e.clientX, sy: e.clientY, add: e.shiftKey }; return; }
  const group = expandGroups(doc, [h.id]);
  const hb = doc.elems[h.id];
  if (e.altKey && e.shiftKey && hb.kind === 'rail' && hb.pieces.length === 1 && hb.pieces[0].angle === 0) {
    snapshot();
    sel = new Set([h.id]);
    const n = camera.getWorldDirection(new THREE.Vector3()).setZ(0).normalize();
    drag = { t: 'railTilt', id: h.id, orig: origOf([h.id]), plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, h.p), start: h.p };
    drawOverlay(); syncProps(); updateStatus();
    return;
  }
  if (e.altKey && e.shiftKey && hb.kind === 'box') {
    // Alt+Shift：拖路面的一头上下，拉成坡（只动靠近鼠标的那一端）
    snapshot();
    sel = new Set([h.id]);
    const axis: 0 | 1 = hb.slope ? hb.slope.axis : hb.sx >= hb.sy ? 0 : 1;
    const f = footprint(hb);
    const hi = axis === 0 ? h.p.x > (f.x0 + f.x1) / 2 : h.p.y > (f.y0 + f.y1) / 2;
    const n = camera.getWorldDirection(new THREE.Vector3()).setZ(0).normalize();
    drag = { t: 'tilt', id: h.id, orig: origOf([h.id]), plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, h.p), start: h.p, axis, hi };
    drawOverlay(); syncProps(); updateStatus();
    return;
  }
  if (e.shiftKey) {
    // Shift：没拖动就是加选 / 减选，拖动就是沿轴移动
    const s = sel.has(h.id) ? sel : new Set([...sel, ...group]);
    drag = { t: 'click', id: h.id, sx: e.clientX, sy: e.clientY, orig: origOf(s), b: boundsOf(doc, s), start: h.p };
    return;
  }
  if (!sel.has(h.id)) sel = group;
  snapshot();
  const elem = doc.elems[h.id];
  if (vHeld) {
    // 按住 V：抓住离鼠标最近的顶点或边中点
    const f = feats(elem);
    let grab = f.verts[0], bd = Infinity;
    for (const v of [...f.verts, ...f.mids]) { const d = toScreen(v).distanceTo(new THREE.Vector2(e.clientX, e.clientY)); if (d < bd) { bd = d; grab = v; } }
    drag = { t: 'vsnap', orig: origOf(), grab, plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -grab[2]) };
    snapGrab = grab;
  } else if (e.altKey) {
    const n = camera.getWorldDirection(new THREE.Vector3()).setZ(0).normalize();
    drag = { t: 'lift', orig: origOf(), b: boundsOf(doc, sel), plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, h.p), start: h.p };
  } else if (e.ctrlKey && elem.kind === 'guard') {
    const a = elem.pts[0], b = elem.pts[elem.pts.length - 1];
    const end: 0 | 1 = Math.hypot(h.p.x - a[0], h.p.y - a[1]) <= Math.hypot(h.p.x - b[0], h.p.y - b[1]) ? 0 : 1;
    if (!startGuardLen(h.id, end)) { undo.pop(); return; }
  } else if (e.ctrlKey && elem.kind === 'rail' && elem.pieces.length === 1 && elem.pieces[0].angle === 0) {
    sel = new Set([h.id]);
    drag = { t: 'railLen', id: h.id, orig: origOf([h.id]), plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -h.p.z), start: h.p };
  } else if (e.ctrlKey && elem.kind === 'box') {
    sel = new Set([h.id]);
    const f = footprint(elem);
    const ds = [f.x1 - h.p.x, f.y1 - h.p.y, h.p.x - f.x0, h.p.y - f.y0].map(Math.abs);
    const side = ds.indexOf(Math.min(...ds)) as Dir;
    drag = { t: 'size', id: h.id, orig: origOf([h.id]), plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -h.p.z), start: h.p, side };
  } else {
    drag = { t: 'move', orig: origOf(), b: boundsOf(doc, sel), plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -h.p.z), start: h.p };
  }
  drawOverlay(); syncProps(); updateStatus();
});

window.addEventListener('pointermove', (e) => {
  if (!drag) {
    if (e.target !== el) return;
    if (splitMode) { splitHover(e); return; }
    if (guardMode) { guardHover(e); return; }
    // 按住 Ctrl / Alt 时不提示别的路面（这时只会操作已经选中的东西）
    const tg = openToggleAt(e);
    const th = tg ? { id: tg.id, side: tg.side } : null;
    if (th?.id !== openHover?.id || th?.side !== openHover?.side) { openHover = th; el.style.cursor = th ? 'pointer' : ''; if (th) dragInfo = '点击切换这一侧的开口'; else dragInfo = ''; drawOverlay(); updateStatus(); }
    const id = (e.ctrlKey || e.altKey) && sel.size ? null : pick(e)?.id ?? null;
    if (id !== hoverId) { hoverId = id; drawOverlay(); }
    return;
  }
  nearVirtual.clear();
  if (drag.t === 'place') { placeMove(e); return; }
  if (drag.t === 'marquee') { showMarquee(drag.sx, drag.sy, e.clientX, e.clientY); return; }
  if (drag.t === 'click') {
    if (Math.hypot(e.clientX - drag.sx, e.clientY - drag.sy) < 5) return;
    snapshot();
    sel = new Set(drag.orig.keys());
    drag = { t: 'axis', orig: drag.orig, b: drag.b, start: drag.start, sx: drag.sx, sy: drag.sy, axis: null };
  }
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
  if (drag.t === 'axis') {
    const dx = e.clientX - drag.sx, dy = e.clientY - drag.sy;
    if (drag.axis === null) {
      // 自动找用户想沿 X 还是 Y 拖：鼠标移动方向和两根轴在屏幕上的方向哪个更一致（上下移动用 Alt）
      const s0 = toScreen(drag.start);
      const md = new THREE.Vector2(dx, dy).normalize();
      let best = -1, ax: 0 | 1 = 0;
      for (const a of [0, 1] as const) {
        const q = drag.start.clone(); q.setComponent(a, q.getComponent(a) + 1);
        const v = toScreen(q).sub(s0);
        if (v.length() < 1e-6) continue;
        const c = Math.abs(v.normalize().dot(md));
        if (c > best) { best = c; ax = a; }
      }
      drag.axis = ax;
    }
    const a = drag.axis;
    const dir = new THREE.Vector3(...[0, 1, 2].map((i) => (i === a ? 1 : 0)));
    setRay(e);
    const q = rayToSegment(ray.ray.origin, ray.ray.direction, drag.start.clone().addScaledVector(dir, -1e4).toArray() as P3, drag.start.clone().addScaledVector(dir, 1e4).toArray() as P3);
    let d: V3 = [0, 0, 0];
    d[a] = q.getComponent(a) - drag.start.getComponent(a);
    d = gridDelta(drag.b, d, [a]);
    moveWithSnap(drag.orig, d, alignDelta(drag.b, d, [a], drag.start));
    axisLine = { p: drag.start.clone().add(new THREE.Vector3(...d)), axis: a };
    liveUpdate();
    return;
  }
  const p = planeHit(e, drag.plane);
  if (!p) return;
  if (drag.t === 'size') { resizeTo(drag, p); return; }
  if (drag.t === 'tilt') { tiltTo(drag, p); return; }
  if (drag.t === 'railLen') { railLenTo(drag, p); return; }
  if (drag.t === 'railTilt') { railTiltTo(drag, p); return; }
  if (drag.t === 'guardLen') { guardLenTo(drag, p); return; }
  const raw = p.clone().sub(drag.start);
  if (drag.t === 'move') {
    let d: V3 = [raw.x, raw.y, 0];
    d = gridDelta(drag.b, d, [0, 1]);
    moveWithSnap(drag.orig, d, alignDelta(drag.b, d, [0, 1], p));
  } else if (drag.t === 'lift') {
    let d: V3 = [0, 0, raw.z];
    d = gridDelta(drag.b, d, [2]);
    // 吸附到平面（一直有）：底下 / 旁边路面的顶面，凹路、细边框凹路还有下沉 0.7 的槽底
    const pz = planeSnap(drag.b, d[2], p);
    moveWithSnap(drag.orig, d, pz !== null ? [0, 0, pz] : alignDelta(drag.b, d, [2], p));
  }
  liveUpdate();
});

/** Ctrl 拖动改尺寸：拖的是离鼠标最近的那条边。对齐、长度取 5 的倍数都是磁吸（缓动 + 松手对准） */
function resizeTo(d: Extract<Drag, { t: 'size' }>, p: THREE.Vector3) {
  const o = JSON.parse(d.orig.get(d.id)!) as Box;
  const s = d.side, ax: 0 | 1 = s % 2 === 0 ? 0 : 1;
  const lo = ax === 0 ? o.x : o.y, len = ax === 0 ? o.sx : o.sy;
  const start = s < 2 ? lo + len : lo;
  let raw = start + (ax === 0 ? p.x - d.start.x : p.y - d.start.y);
  if (gridOn) raw = snapG(raw);
  raw = Math.round(raw * 1000) / 1000;
  let snap: number | null = null;
  guides = [];
  if (alignOn) {
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
  const setEdge = (b: Box, edge: number) => {
    if (s < 2) { const n = Math.max(0.1, edge - lo); if (ax === 0) b.sx = n; else b.sy = n; }
    else { const e0 = Math.min(lo + len - 0.1, edge); if (ax === 0) { b.x = e0; b.sx = lo + len - e0; } else { b.y = e0; b.sy = lo + len - e0; } }
  };
  const finalLen = Math.abs((snap ?? raw) - fixed);
  drive([raw], snap === null ? null : [snap], (v) => {
    restore(d.orig);
    const b = doc.elems[d.id] as Box;
    setEdge(b, Math.round(v[0] * 1000) / 1000);
    // 测量线：沿改尺寸的方向，放在顶面中线上；数字是松手后的长度
    const f = footprint(b);
    const mid = ax === 0 ? (f.y0 + f.y1) / 2 : (f.x0 + f.x1) / 2;
    // 坡面路：测量线画在较高那一头高度的水平虚拟面上（量的是 box 的长度，不是坡面的长度）
    const flatZ = b.slope ? Math.max(b.z, b.z + b.slope.dz) + 0.08 : null;
    const P = (t: number): P3 => { const x = ax === 0 ? t : mid, y = ax === 0 ? mid : t; return [x, y, flatZ ?? boxTopAt(b, x, y) + 0.08]; };
    const [t0, t1] = ax === 0 ? [f.x0, f.x1] : [f.y0, f.y1];
    measure = { a: P(t0), b: P(t1), tick: ax === 0 ? [0, 0.6, 0] : [0.6, 0, 0], text: fmt(finalLen), on5: snap !== null, plane: flatZ !== null ? { ...f, z0: flatZ, z1: flatZ } : undefined };
  }, [start], { preview: (v) => { const b: Box = JSON.parse(d.orig.get(d.id)!); setEdge(b, v[0]); return [b]; } });
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
  const touching = Object.values(doc.elems).filter((x): x is Box => x.kind === 'box' && x.id !== o.id).filter((x) => {
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
    measure = { a: [x, y, other], b: [x, y, cur], tick: d.axis === 0 ? [0, 0.6, 0] : [0.6, 0, 0], text: `高差 ${fmt(final - other)}${label}`, on5: snap !== null };
  }, [start], { preview: (v) => { const b: Box = JSON.parse(d.orig.get(d.id)!); setEnd(b, v[0]); return [b]; } });
  dragInfo = `坡：长 ${fmt(len)} · 高差 ${fmt(Math.abs(final - other))}`;
}

/** Shift+Alt 拖直轨：抬高 / 压低终点那一头。吸附：高差为 5 的倍数、放平、别的路面 / 钢轨在这一头的高度 */
function railTiltTo(d: Extract<Drag, { t: 'railTilt' }>, p: THREE.Vector3) {
  const o = JSON.parse(d.orig.get(d.id)!) as RailElem;
  const pc = o.pieces[0];
  const end = advance({ x: o.x, y: o.y, z: o.z, heading: o.heading }, pc);
  const start = o.z + pc.dz;
  let raw = start + (p.z - d.start.z);
  if (gridOn) raw = snapG(raw);
  raw = Math.round(raw * 1000) / 1000;
  const thr = worldPerPx(p) * SIZE5_PX;
  const cands: number[] = [o.z];
  const k5 = Math.round((raw - o.z) / 5);
  if (k5 !== 0) cands.push(o.z + k5 * 5);
  for (const x of Object.values(doc.elems)) {
    if (x.id === o.id) continue;
    if (x.kind === 'box') { const f = footprint(x); if (end.x > f.x0 - 0.5 && end.x < f.x1 + 0.5 && end.y > f.y0 - 0.5 && end.y < f.y1 + 0.5) cands.push(boxTopAt(x, Math.min(Math.max(end.x, f.x0), f.x1), Math.min(Math.max(end.y, f.y0), f.y1))); }
    if (x.kind === 'rail') for (const v of feats(x).verts) if (Math.hypot(v[0] - end.x, v[1] - end.y) < 0.5) cands.push(v[2]);
  }
  const best = cands.filter((v) => Math.abs(v - raw) < thr).sort((a, b) => Math.abs(a - raw) - Math.abs(b - raw))[0];
  const snap = best ?? null;
  const final = snap ?? raw;
  drive([raw], snap === null ? null : [snap], (v) => {
    restore(d.orig);
    const r = doc.elems[d.id] as RailElem;
    r.pieces[0].dz = Math.round((v[0] - r.z) * 1000) / 1000;
    measure = { a: [end.x, end.y, o.z], b: [end.x, end.y, v[0]], tick: [0.6, 0.6, 0], text: `高差 ${fmt(final - o.z)}`, on5: snap !== null };
  }, [start]);
  dragInfo = `直轨：长 ${fmt(pc.len)} · 高差 ${fmt(final - o.z)}`;
}

/** 开始拖护栏的一头（end：0 起点 / 1 终点）：另一头固定，沿外沿改长度 */
function startGuardLen(id: number, end: 0 | 1): boolean {
  const g = doc.elems[id] as Extract<Elem, { kind: 'guard' }>;
  const fixedP = end === 0 ? g.pts[g.pts.length - 1] : g.pts[0];
  const movP = end === 0 ? g.pts[0] : g.pts[g.pts.length - 1];
  const pf = project(loops, fixedP, 1);
  if (!pf) return false;
  const l = loops[pf.loop];
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
  const l = loops[d.loop];
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
  let st: RailState = { x: o.x, y: o.y, z: o.z, heading: o.heading };
  for (const pc of o.pieces) st = advance(st, pc);
  const h = (st.heading * Math.PI) / 180;
  const along = (p.x - d.start.x) * Math.cos(h) + (p.y - d.start.y) * Math.sin(h);
  const last = o.pieces[o.pieces.length - 1];
  const straight = !!last && last.angle === 0;
  const base = straight ? last.len : 0;
  let raw = Math.max(0.5, base + along);
  if (gridOn) raw = Math.max(prefs.gridStep, snapG(raw));
  raw = Math.round(raw * 1000) / 1000;
  const L5 = Math.round(raw / 5) * 5;
  const snap = L5 > 0 && Math.abs(raw - L5) < worldPerPx(p) * SIZE5_PX ? L5 : null;
  const setLen = (r: RailElem, v: number) => {
    if (straight) r.pieces[r.pieces.length - 1].len = v;
    else r.pieces.push({ kind: last?.kind === 'mono' ? 'mono' : 'double', len: v, radius: 0, angle: 0, dz: 0 });
  };
  drive([raw], snap === null ? null : [snap], (v) => { restore(d.orig); setLen(doc.elems[d.id] as RailElem, Math.round(v[0] * 1000) / 1000); }, [base]);
  dragInfo = `钢轨末段长 ${fmt(snap ?? raw)}`;
}

window.addEventListener('pointerup', (e) => {
  if (guardDrag && e.button === 0) { guardUp(e); return; }
  if (!drag || e.button !== 0) return;
  if (drag.t === 'move' && drag.grab) return; // 跟着鼠标走的复制，点击才放下
  if (drag.t === 'place') { placeEnd(e); return; }
  if (drag.t === 'marquee') { finishMarquee(drag, e); return; }
  if (drag.t === 'click') {
    // Shift 点击：加选 / 减选整个绑定组
    const group = expandGroups(doc, [drag.id]);
    if ([...group].every((id) => sel.has(id))) for (const id of group) sel.delete(id); else for (const id of group) sel.add(id);
    drag = null;
    drawOverlay(); syncProps(); updateStatus();
    return;
  }
  finishDrag();
});

function finishDrag() {
  // 松手：落到最终位置（能吸附就正好对准；文档里本来就是最终位置）
  if (anim && !anim.applied) anim.apply(anim.final);
  anim = null;
  snapping = false;
  if (drag && 'orig' in drag && drag.orig && !(drag.t === 'move' && drag.grab)) {
    if ([...drag.orig].every(([id, s]) => JSON.stringify(doc.elems[id]) === s)) undo.pop();
  }
  drag = null;
  guides = []; axisLine = null; snapTarget = null; snapGrab = null; dragInfo = ''; measure = null;
  rebuild();
}

function cancelGrab() {
  if (drag?.t === 'move' && drag.grab) {
    for (const id of drag.orig.keys()) delete doc.elems[id];
    undo.pop();
    sel.clear();
    drag = null; guides = []; dragInfo = ''; anim = null; snapping = false;
    rebuild();
  }
}

// ---------------- 框选 ----------------

function showMarquee(x0: number, y0: number, x1: number, y1: number) {
  // 框是画在视图里的（position: absolute），换成相对视图的坐标
  const r = host.getBoundingClientRect();
  marqueeEl.classList.add('open');
  Object.assign(marqueeEl.style, { left: `${Math.min(x0, x1) - r.left}px`, top: `${Math.min(y0, y1) - r.top}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
}
function finishMarquee(d: { sx: number; sy: number; add: boolean }, e: PointerEvent) {
  marqueeEl.classList.remove('open');
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
  if (type === 'rail') return [{ id, kind: 'rail', x: 0, y: 0, z: 0, heading: 0, pieces: [{ kind: 'double', len: 10, radius: 0, angle: 0, dz: 0 }] }];
  if (type === 'rail-curve') return [{ id, kind: 'rail', x: 0, y: 0, z: 0, heading: 0, pieces: [{ kind: 'double', len: 0, radius: 5, angle: 90, dz: 0 }] }];
  if (type === 'rail-spiral') return [{ id, kind: 'rail', x: 0, y: 0, z: 0, heading: 0, pieces: [{ kind: 'double', len: 0, radius: SPIRAL_RADIUS, angle: 360, dz: SPIRAL_SCREW }] }];
  return [{ id, kind: 'box', x: 0, y: 0, z: 0, sx: 10, sy: 5, depth: 5, style: type as Style }];
}

/** 新放的东西的「抓手」：机关是对准方块顶面中心，其余是顶面最小角 */
function handleOf(e: Elem): P3 {
  if (e.kind === 'asset') { const b = elemBounds(e); return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.z1]; }
  if (e.kind === 'rail') return [e.x, e.y, e.z];
  if (isCheckpoint(e)) return [e.x, e.y, e.z];
  if (e.kind === 'obj') {
    const a = anchorRects(e)[0];
    return a ? [(a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2, a.top] : [e.x, e.y, e.z];
  }
  const b = elemBounds(e);
  return [b.x0, b.y0, b.z1];
}

function startPlace(type: string) {
  if (type === 'start' && Object.values(doc.elems).some((e) => e.kind === 'piece' && e.type === 'start')) { flash('全图只能有一个起点', true); return; }
  drag = { t: 'place', ids: null, type, moved: false, rotOff: 0 };
  document.body.classList.add('placing');
}
function placeMove(e: PointerEvent) {
  if (drag?.t !== 'place') return;
  const over = document.elementFromPoint(e.clientX, e.clientY) === el;
  if (!over) return;
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
    if (x.kind !== 'box' || x.slope || ids.has(x.id)) continue;
    const q = ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 0, 1), -x.z), new THREE.Vector3());
    if (!q || q.x < x.x || q.x > x.x + x.sx || q.y < x.y || q.y > x.y + x.sy) continue;
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
    const axis = under?.kind === 'box' ? (under.slope ? under.slope.axis : under.sx >= under.sy ? 0 : 1) : 0;
    if (o.kind === 'rail') o.heading = ((axis + drag.rotOff) % 4) * 90;
    else o.rot = ((axis + (o.kind === 'obj' && o.type === 'P_Modul_01' ? 1 : 0) + drag.rotOff) % 4) as Dir;
    orig.set(id, JSON.stringify(o));
  }
  restore(orig);
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
  if (!drag.moved && !over) {
    // 点击按钮：放到视图中心
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
const LIB: { id: string; label: string; items: LibItem[] }[] = [
  {
    id: 'road', label: '路面', items: [
      { type: 'normal', label: '平路', hint: 'Ctrl 拖改尺寸，Alt+Shift 拖一头做坡', icon: slab(ROAD_TOP, '<path d="M14 30 L32 21 L50 30 L32 39 Z" fill="#d8c8a2"/>') },
      { type: 'sink', label: '凹路', hint: '凹槽路面', icon: slab(ROAD_TOP, `<path d="M16 30 L32 22 L48 30 L32 38 Z" fill="${SINK}"/>`) },
      { type: 'ribbon', label: '细边框凹路', hint: '细边框凹槽平台', icon: slab(ROAD_TOP, '<path d="M12 30 L32 20 L52 30 L32 40 Z" fill="#b29d79"/>') },
      { type: 'transition', label: '平凹转换', hint: '长 5，一头平路一头凹路', icon: slab(ROAD_TOP, `<path d="M20 36 L44 24 L50 27 L26 39 Z" fill="${SINK}"/>`) },
      { type: 'transition-narrow', label: '窄转换', hint: '长 2.5，凹路接细边框平台', icon: slab(ROAD_TOP, `<path d="M26 33 L44 24 L48 26 L30 35 Z" fill="${SINK}"/>`) },
    ],
  },
  {
    id: 'cp', label: '盘点', items: [
      { type: 'start', label: '起点', hint: '四火，全图一个', icon: svgThumb('<ellipse cx="32" cy="34" rx="22" ry="12" fill="#a99a86"/><ellipse cx="32" cy="32" rx="14" ry="7" fill="#e3a35a"/><path d="M28 30 L32 10 L36 30 Z" fill="#f0b46e"/>') },
      { type: 'check', label: '小节', hint: '两火，按放置顺序编小节号', icon: svgThumb('<ellipse cx="32" cy="34" rx="20" ry="11" fill="#a99a86"/><ellipse cx="32" cy="32" rx="12" ry="6" fill="#e3a35a"/><path d="M14 32 L18 14 L22 32 Z M42 32 L46 14 L50 32 Z" fill="#f0b46e"/>') },
    ],
  },
  {
    id: 'rail', label: '钢轨', items: [
      { type: 'rail', label: '直轨', hint: 'Ctrl 拖改长度，Shift+Alt 做坡', icon: svgThumb(`<path d="M8 40 L48 20 M16 44 L56 24" stroke="${RAIL}" stroke-width="4" stroke-linecap="round"/>`) },
      { type: 'rail-curve', label: '弯轨', hint: '属性里调半径、角度', icon: svgThumb(`<path d="M10 46 Q10 18 40 14 M18 50 Q18 26 46 22" stroke="${RAIL}" stroke-width="4" fill="none" stroke-linecap="round"/>`) },
      { type: 'rail-spiral', label: '螺旋', hint: '属性里调圈数、半径', icon: svgThumb(`<path d="M32 52 C10 50 10 36 32 36 C54 36 54 22 32 22 C14 22 14 12 32 10" stroke="${RAIL}" stroke-width="4" fill="none" stroke-linecap="round"/>`) },
    ],
  },
  { id: 'special', label: '特殊路面', items: ASSET_INFO.map((a) => ({ type: `asset:${a.name}`, label: a.label, hint: `${a.group === 'wood' ? '木制' : '特殊路块'} · ${a.name}` })) },
  { id: 'module', label: '机关', items: OBJ_TYPES.filter((t) => t.cat === 'module').map((t) => ({ type: `obj:${t.type}`, label: t.label, hint: `${t.type}${baseSpec(t.type) ? ' · 自带专属路块' : ''}` })) },
  { id: 'deco', label: '装饰', items: OBJ_TYPES.filter((t) => t.cat === 'deco').map((t) => ({ type: `obj:${t.type}`, label: t.label, hint: t.type })) },
];
const palette = document.getElementById('palette')!;
palette.innerHTML = `
  <div class="lib-head">
    <span class="title">素材库</span>
    <button class="fold" id="lib-fold" title="收起 / 展开"><svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" /></svg></button>
  </div>
  <div class="lib-tabs">${LIB.map((g) => `<button data-tab="${g.id}">${g.label}<small>${g.items.length}</small></button>`).join('')}</div>
  <div class="lib-search"><input type="search" placeholder="搜索名称或代号…" /></div>
  <div class="lib-body"><div class="lib-grid"></div><div class="lib-empty" hidden>没有匹配的素材</div></div>
  <div class="lib-foot">按住卡片拖到场景里放下（拖动中 R 旋转、右键取消）· 点一下放到视图中心</div>`;
const libGrid = palette.querySelector<HTMLElement>('.lib-grid')!;
const libEmpty = palette.querySelector<HTMLElement>('.lib-empty')!;
const libSearch = palette.querySelector<HTMLInputElement>('.lib-search input')!;
function renderLib() {
  const q = libSearch.value.trim().toLowerCase();
  // 搜索时跨所有标签找；不搜索时只显示当前标签
  const items = q ? LIB.flatMap((g) => g.items).filter((it) => `${it.label} ${it.hint}`.toLowerCase().includes(q)) : (LIB.find((g) => g.id === prefs.tab) ?? LIB[0]).items;
  palette.querySelectorAll<HTMLButtonElement>('.lib-tabs button').forEach((b) => b.classList.toggle('on', !q && b.dataset.tab === prefs.tab));
  libGrid.innerHTML = items.map((it) => `<div class="lib-card" data-type="${it.type}" title="${it.label}
${it.hint}"><div class="thumb">${it.icon ?? ''}</div><span>${it.label}</span></div>`).join('');
  libEmpty.hidden = items.length > 0;
  fillThumbs();
}
function fillThumbs() {
  for (const c of libGrid.querySelectorAll<HTMLElement>('.lib-card')) {
    const t = c.dataset.type!;
    if (!t.startsWith('obj:') && !t.startsWith('asset:')) continue;
    const box = c.querySelector<HTMLElement>('.thumb')!;
    const url = thumbnail(t.slice(t.indexOf(':') + 1), modelView ? 'model' : 'placeholder');
    if (url) { box.style.setProperty('--img', `url(${url})`); box.classList.add('loaded'); }
  }
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
  e.preventDefault();
  startPlace(c.dataset.type!);
});
palette.querySelector('#lib-fold')!.addEventListener('click', () => palette.classList.toggle('folded'));
setAssetLoadedCallback(fillThumbs);
setTextureLoadedCallback(fillThumbs);
/** 素材库在左边还是右边；属性面板放在另一边 */
function applySide() {
  palette.classList.toggle('left', prefs.side === 'left');
  props.classList.toggle('right', prefs.side === 'left');
}
applySide();
renderLib();
// 拖放中右键：取消
window.addEventListener('pointerdown', (e) => {
  if (e.button === 2 && drag?.t === 'place') {
    e.preventDefault(); e.stopPropagation();
    if (drag.ids) { for (const id of drag.ids) delete doc.elems[id]; undo.pop(); sel.clear(); }
    anim = null; snapping = false; drag = null; snapTarget = null;
    document.body.classList.remove('placing');
    rebuild();
  }
}, true);

// ---------------- 切分 ----------------

function splitAt(e: { clientX: number; clientY: number }): { id: number; axis: 0 | 1; t: number } | null {
  const h = pick(e);
  const b = h && doc.elems[h.id];
  if (!h || b?.kind !== 'box') return null;
  const axis: 0 | 1 = splitAxis ?? (b.sx >= b.sy ? 0 : 1);
  let t = h.p.getComponent(axis);
  t = gridOn ? snapG(t) : Math.round(t * 1000) / 1000;
  return { id: h.id, axis, t };
}
function splitHover(e: { clientX: number; clientY: number }) {
  const s = splitAt(e);
  splitPreview = null;
  if (s) {
    const b = doc.elems[s.id] as Box;
    const f = footprint(b);
    const top = (x: number, y: number): P3 => [x, y, (b.slope ? b.z + (b.slope.dz * ((b.slope.axis === 0 ? x - b.x : y - b.y) / (b.slope.axis === 0 ? b.sx : b.sy))) : b.z) + 0.02];
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
  splitHover(e);
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
function openToggles(): { id: number; side: Dir; p: P3; open: boolean }[] {
  if (sel.size !== 1) return [];
  const b = doc.elems[[...sel][0]];
  if (b?.kind !== 'box') return [];
  const f = footprint(b);
  const cx = (f.x0 + f.x1) / 2, cy = (f.y0 + f.y1) / 2;
  const at: [number, number][] = [[f.x1, cy], [cx, f.y1], [f.x0, cy], [cx, f.y0]];
  return ([0, 1, 2, 3] as Dir[]).map((side) => {
    const [x, y] = at[side];
    return { id: b.id, side, p: [x, y, boxTopAt(b, x, y) + 0.05] as P3, open: !!((b.open ?? 0) & (1 << side)) };
  });
}
let openHover: { id: number; side: Dir } | null = null;
function openToggleAt(e: { clientX: number; clientY: number }) {
  const at = new THREE.Vector2(e.clientX, e.clientY);
  return openToggles().find((t) => toScreen(t.p).distanceTo(at) < 11) ?? null;
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
      if (d < 18 && (!best || d < best.d)) best = { id: g.id, end, d };
    });
  }
  return best;
}
function guardHover(e: PointerEvent) {
  const p = surfacePoint(e);
  if (guardDrag) {
    const l = loops[guardDrag.loop];
    const pr = p ? project([l], p, 3) : null;
    if (pr) guardPreview = shortPath(l, guardDrag.s0, pr.s);
    if (pr && Math.abs(pr.s - guardDrag.s0) > 0.3) guardDrag.moved = true;
  } else {
    const end = guardEndAt(e);
    guardEndHover = end;
    el.style.cursor = end ? 'ew-resize' : '';
    guardPreview = end ? null : p ? edgeAt(loops, p) : null;
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
    el.setPointerCapture(e.pointerId);
    guardPreview = null;
    drawOverlay();
    return;
  }
  const p = surfacePoint(e);
  if (!p) return;
  const pr = project(loops, p, 1.5);
  if (!pr || pr.dist > 1.5) return;
  el.setPointerCapture(e.pointerId);
  guardDrag = { loop: pr.loop, s0: pr.s, a: pr.p, moved: false };
}
function guardUp(e: PointerEvent) {
  const gd = guardDrag!;
  guardDrag = null;
  // 点一下：整条直边；拖动：从按下的地方沿外沿走到松开的地方
  const route = gd.moved ? guardPreview : edgeAt(loops, gd.a);
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
const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('#tools button')];
const syncTools = () => { const t = guardMode ? 'guard' : splitMode ? 'split' : 'select'; toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === t)); };
function setTool(t: string) {
  if (t === 'guard') enterGuard(); else if (t === 'split') enterSplit(); else { exitGuard(); exitSplit(); }
}
toolButtons.forEach((b) => b.addEventListener('click', () => { setTool(b.dataset.tool!); b.blur(); }));
function enterGuard() { exitSplit(); guardMode = true; sel.clear(); syncTools(); drawOverlay(); updateStatus(); }
function exitGuard() { if (!guardMode) return; guardMode = false; guardPreview = null; guardDrag = null; dragInfo = ''; el.style.cursor = ''; syncTools(); drawOverlay(); updateStatus(); }

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
  for (const id of sel) rotateElem(doc.elems[id], cx, cy);
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
  snapshot();
  sel = new Set(duplicate(doc, sel));
  const b = boundsOf(doc, sel);
  const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -b.z1);
  const start = planeHit(mouse, plane) ?? new THREE.Vector3((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.z1);
  drag = { t: 'move', orig: origOf(), b, plane, start, grab: true };
  flash('复制：移动鼠标，点击放下，右键 / Esc 取消');
  rebuild();
}
function nudge(d: V3) {
  if (!sel.size) return;
  snapshot();
  for (const id of sel) translateElem(doc.elems[id], d);
  rebuild();
}
const keepSel = () => { sel = new Set([...sel].filter((id) => doc.elems[id])); };
function undoOnce() { if (undo.length) { redo.push(JSON.stringify(doc)); doc = JSON.parse(undo.pop()!); keepSel(); rebuild(); } }
function redoOnce() { if (redo.length) { undo.push(JSON.stringify(doc)); doc = JSON.parse(redo.pop()!); keepSel(); rebuild(); } }

const lastMouse = { clientX: 0, clientY: 0 };
window.addEventListener('pointermove', (e) => { lastMouse.clientX = e.clientX; lastMouse.clientY = e.clientY; }, true);

document.getElementById('merge')!.addEventListener('click', doMerge);
document.getElementById('group')!.addEventListener('click', doGroup);
document.getElementById('ungroup')!.addEventListener('click', doUngroup);
document.getElementById('dup')!.addEventListener('click', () => { const r = el.getBoundingClientRect(); doDuplicate({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }); });
document.getElementById('rot')!.addEventListener('click', doRotate);
document.getElementById('del')!.addEventListener('click', doDelete);
const gridBtn = document.getElementById('grid')!;
const toggleGrid = () => { gridOn = !gridOn; gridBtn.classList.toggle('active', gridOn); flash(gridOn ? `格栅：开（步长 ${prefs.gridStep}）` : '格栅：关'); };
gridBtn.addEventListener('click', () => { toggleGrid(); gridBtn.blur(); });
const alignBtn = document.getElementById('align')!;
const toggleAlign = () => { alignOn = !alignOn; alignBtn.classList.toggle('active', alignOn); flash(alignOn ? '自动对齐：开' : '自动对齐：关'); };
alignBtn.addEventListener('click', () => { toggleAlign(); alignBtn.blur(); });
document.getElementById('undo')!.addEventListener('click', () => undoOnce());
document.getElementById('redo')!.addEventListener('click', () => redoOnce());

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT') return;
  const k = e.key.toLowerCase();
  if (k === 'v' && !vHeld) { vHeld = true; drawOverlay(); }
  if (k === 'escape') { cancelGrab(); exitSplit(); exitGuard(); closeMenus(); }
  if (k === 'tab' && splitMode) { e.preventDefault(); splitAxis = splitAxis === null ? 1 : ((1 - splitAxis) as 0 | 1); splitHover(lastMouse); }
  if (e.ctrlKey) {
    if (k === 'z') undoOnce();
    else if (k === 'y') redoOnce();
    else if (k === 'j') { e.preventDefault(); doMerge(); }
    else if (k === 'g') { e.preventDefault(); if (e.shiftKey) doUngroup(); else doGroup(); }
    else if (k === 'd') { e.preventDefault(); doDuplicate(lastMouse); }
    else if (k === 's') { e.preventDefault(); saveFile(); }
    else if (k === 'o') { e.preventDefault(); fileInput.click(); }
    else if (k === 'a') { e.preventDefault(); sel = new Set(Object.keys(doc.elems).map(Number)); drawOverlay(); syncProps(); updateStatus(); }
    return;
  }
  if (k === 'g') toggleGrid();
  if (k === 's') toggleAlign();
  if (k === 'k' || k === '3') (splitMode ? exitSplit() : enterSplit());
  if (k === 'h' || k === '2') (guardMode ? exitGuard() : enterGuard());
  if (k === '1') setTool('select');
  if (k === 'r') { if (drag?.t === 'place') { drag.rotOff++; placeMove(lastMouse as PointerEvent); } else doRotate(); }
  if (k === 'delete' || k === 'backspace' || k === 'x') doDelete();
  if (k === 'f') frameSelection();
  const step = e.shiftKey ? 0.1 : 1;
  const arrows: Record<string, V3> = { arrowleft: [-step, 0, 0], arrowright: [step, 0, 0], arrowup: [0, step, 0], arrowdown: [0, -step, 0], pageup: [0, 0, step], pagedown: [0, 0, -step] };
  if (arrows[k]) { e.preventDefault(); nudge(arrows[k]); }
});
window.addEventListener('keyup', (e) => { if (e.key.toLowerCase() === 'v') { vHeld = false; drawOverlay(); } updateStatus(); });
// 修饰键变化时刷新按键提示
window.addEventListener('keydown', () => updateStatus());

// ---------------- 属性面板 ----------------

function syncProps() {
  const one = sel.size === 1 ? doc.elems[[...sel][0]] : null;
  if (!one) { props.hidden = true; return; }
  if (props.dataset.id === String(one.id) && props.contains(document.activeElement)) return;
  props.hidden = false;
  props.dataset.id = String(one.id);
  const num = (k: string, label: string, v: number) => `<label>${label}</label><input data-k="${k}" type="number" step="0.1" value="${+v.toFixed(4)}">`;
  let h = '';
  if (one.kind === 'box') {
    h += `<div class="title">路面${one.group !== undefined ? '（已绑定）' : ''}</div>`;
    h += num('x', 'x', one.x) + num('y', 'y', one.y) + num('z', '顶面', one.z) + num('sx', '长 (x)', one.sx) + num('sy', '宽 (y)', one.sy) + num('depth', '厚度', one.depth);
    h += `<label>样式</label><select data-k="style">${(['normal', 'sink', 'ribbon'] as Style[]).map((s) => `<option value="${s}"${s === one.style ? ' selected' : ''}>${{ normal: '平路', sink: '凹路', ribbon: '细边框凹路' }[s]}</option>`).join('')}</select>`;
    h += `<label>倾斜</label><select data-k="axis"><option value="-1">不倾斜</option><option value="0"${one.slope?.axis === 0 ? ' selected' : ''}>沿 X</option><option value="1"${one.slope?.axis === 1 ? ' selected' : ''}>沿 Y</option></select>`;
    if (one.slope) h += num('dz', '高差', one.slope.dz);
    h += `<div class="row">开口：${['+X', '+Y', '-X', '-Y'].map((n, i) => `<label><input type="checkbox" data-open="${i}"${(one.open ?? 0) & (1 << i) ? ' checked' : ''}>${n}</label>`).join('')}</div>`;
  } else if (one.kind === 'rail') {
    const pc = one.pieces[0];
    const shape = pc.angle === 0 ? '直轨' : Math.abs(pc.angle) >= 360 ? '螺旋' : '弯轨';
    h += `<div class="title">${shape}</div>`;
    h += num('x', '起点 x', one.x) + num('y', '起点 y', one.y) + num('z', '起点高', one.z);
    h += `<label>朝向</label><select data-k="heading">${[0, 90, 180, 270].map((a) => `<option value="${a}"${a === ((one.heading % 360) + 360) % 360 ? ' selected' : ''}>${['+X', '+Y', '-X', '-Y'][a / 90]}</option>`).join('')}</select>`;
    h += `<label>轨型</label><select data-rf="kind">${[['double', '双轨'], ['mono', '单轨'], ['transition', '单双转换']].map(([v, n]) => `<option value="${v}"${v === pc.kind ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
    const rnum = (f: string, label: string, v: number, step = 0.5) => `<label>${label}</label><input data-rf="${f}" type="number" step="${step}" value="${+v.toFixed(3)}">`;
    if (pc.angle === 0) h += rnum('len', '长度', pc.len) + rnum('dz', '高差', pc.dz);
    else {
      h += `<label>方向</label><select data-rf="dir"><option value="1"${pc.angle > 0 ? ' selected' : ''}>左转</option><option value="-1"${pc.angle < 0 ? ' selected' : ''}>右转</option></select>`;
      h += rnum('radius', '半径', pc.radius);
      if (Math.abs(pc.angle) >= 360) h += rnum('turns', '圈数', Math.abs(pc.angle) / 360, 0.25) + rnum('screw', '每圈升高', pc.dz / (Math.abs(pc.angle) / 360));
      else h += rnum('angle', '角度', Math.abs(pc.angle), 15) + rnum('dz', '高差', pc.dz);
    }
  } else if (one.kind === 'guard') {
    h += `<div class="title">护栏（长 ${fmt(routeLen(one))}）</div>`;
    h += `<div class="row">在护栏工具（H）里拖护栏的端头改长度</div>`;
  } else if (one.kind === 'piece' && isCheckpoint(one)) {
    const checks = Object.values(doc.elems).filter((e) => e.kind === 'piece' && e.type === 'check').sort((a, b) => a.id - b.id);
    h += `<div class="title">${one.type === 'start' ? '起点' : `小节盘点（第 ${one.sector ?? checks.indexOf(one) + 2} 小节）`}</div>`;
    h += num('x', 'x', one.x) + num('y', 'y', one.y) + num('z', '顶面', one.z);
    h += `<label>路口朝向</label><select data-k="rot">${['+X', '+Y', '-X', '-Y'].map((n, r) => `<option value="${r}"${r === one.rot ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
    const ARROW = ['→ +X', '↗', '↑ +Y', '↖', '← -X', '↙', '↓ -Y', '↘'];
    h += `<label>重生朝向</label><select data-k="spawn"><option value=""${one.spawn === undefined ? ' selected' : ''}>和路口一致</option>${ARROW.map((n, i) => `<option value="${i * 45}"${one.spawn === i * 45 ? ' selected' : ''}>${n}（${i * 45}°）</option>`).join('')}</select>`;
  } else if (one.kind === 'piece') {
    h += `<div class="title">${one.type === 'transition' ? '平凹转换' : '窄转换'}（长 ${pieceLen(one)}）</div>`;
    h += num('x', 'x', one.x) + num('y', 'y', one.y) + num('z', '顶面', one.z);
  } else if (one.kind === 'asset') {
    h += `<div class="title">${assetInfo(one.name)?.label ?? one.name}</div>`;
    h += num('x', 'x', one.x) + num('y', 'y', one.y) + num('z', 'z', one.z);
    h += `<label>朝向</label><select data-k="rot">${[0, 1, 2, 3].map((r) => `<option value="${r}"${r === one.rot ? ' selected' : ''}>${r * 90}°</option>`).join('')}</select>`;
  } else {
    const t = objType(one.type);
    h += `<div class="title">${t?.label ?? one.type}</div>`;
    h += num('x', 'x', one.x) + num('y', 'y', one.y) + num('z', 'z', one.z);
    h += `<label>朝向</label><select data-k="rot">${[0, 1, 2, 3].map((r) => `<option value="${r}"${r === one.rot ? ' selected' : ''}>${r * 90}°</option>`).join('')}</select>`;
    const extra: string[] = [];
    if (stopperMesh({ id: 0, cat: 'module', type: one.type, x: 0, y: 0, z: 0, rot: 0 })) extra.push(`<label><input type="checkbox" data-flag="noStopper"${one.noStopper ? '' : ' checked'}>挡块</label>`);
    if (baseSpec(one.type)) extra.push(`<label><input type="checkbox" data-flag="noBase"${one.noBase ? '' : ' checked'}>专属路块</label>`);
    if (t?.cat === 'module' && one.type !== 'PE_Balloon') h += `<label>小节</label><select data-k="sector">${Array.from({ length: sectorCount() }, (_, i) => `<option value="${i + 1}"${i + 1 === Math.min(one.sector ?? 1, sectorCount()) ? ' selected' : ''}>第 ${i + 1} 小节</option>`).join('')}</select>`;
    if (extra.length) h += `<div class="row">${extra.join('')}</div>`;
  }
  props.innerHTML = h;
}
props.addEventListener('change', (ev) => {
  const t = ev.target as HTMLInputElement;
  const e = sel.size === 1 ? doc.elems[[...sel][0]] : null;
  if (!e) return;
  snapshot();
  const k = t.dataset.k;
  if (t.dataset.open !== undefined && e.kind === 'box') e.open = ((e.open ?? 0) ^ (1 << +t.dataset.open)) || undefined;
  if (t.dataset.flag && e.kind === 'obj') (e as Obj)[t.dataset.flag as 'noStopper' | 'noBase'] = !t.checked || undefined;
  if (k === 'x' || k === 'y' || k === 'z') e[k] = +t.value;
  if (e.kind === 'box') {
    if (k === 'style') e.style = t.value as Style;
    else if (k === 'axis') e.slope = +t.value < 0 ? undefined : { axis: +t.value as 0 | 1, dz: e.slope?.dz || 2.5 };
    else if (k === 'dz' && e.slope) e.slope.dz = +t.value;
    else if (k === 'sx' || k === 'sy' || k === 'depth') e[k] = Math.max(0.1, +t.value);
  }
  if ((e.kind === 'obj' || e.kind === 'piece' || e.kind === 'asset') && k === 'rot') e.rot = +t.value as Dir;
  if (e.kind === 'obj' && k === 'sector') e.sector = +t.value;
  if (e.kind === 'piece' && k === 'spawn') e.spawn = t.value === '' ? undefined : +t.value;
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
    else if (f === 'turns') { const n = Math.max(1, v); pc.dz = (pc.dz / turns) * n; pc.angle = Math.sign(pc.angle) * 360 * n; }
    else if (f === 'screw') pc.dz = v * turns;
  }
  props.dataset.id = '';
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
function saveFile() { download('map.bvmbox', JSON.stringify({ format: 'bvm-box', version: 1, doc }), 'application/json'); flash('已保存 map.bvmbox'); }
const fileInput = document.getElementById('file') as HTMLInputElement;
fileInput.addEventListener('change', async () => {
  const f = fileInput.files?.[0];
  fileInput.value = '';
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    if (data.format !== 'bvm-box') throw new Error('不是 box 版工程文件');
    snapshot();
    doc = data.doc;
    sel.clear();
    frameAll();
    rebuild();
    flash(`已打开 ${f.name}`);
  } catch (e) { flash(`打开失败：${(e as Error).message}`, true); }
});
// 下拉菜单：文件、导出
const fileMenu = document.getElementById('file-menu')!, exportMenu = document.getElementById('export-menu')!;
const fileBtn = document.getElementById('file-btn')!, exportBtn = document.getElementById('export')!;
function closeMenus() { fileMenu.classList.remove('open'); exportMenu.classList.remove('open'); }
fileBtn.addEventListener('click', (e) => { e.stopPropagation(); exportMenu.classList.remove('open'); fileMenu.classList.toggle('open'); fileBtn.blur(); });
exportBtn.addEventListener('click', (e) => { e.stopPropagation(); fileMenu.classList.remove('open'); exportMenu.classList.toggle('open'); exportBtn.blur(); });
window.addEventListener('pointerdown', (e) => { const t = e.target as Node; if (!fileMenu.contains(t) && !exportMenu.contains(t) && t !== fileBtn && t !== exportBtn) closeMenus(); });
document.getElementById('scene-list')!.innerHTML = SCENES.map((sc, i) => `<button data-scene="${i}"><span>${sc.name}</span></button>`).join('');
fileMenu.addEventListener('click', (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>('button');
  if (!b) return;
  closeMenus();
  if (b.dataset.scene !== undefined) { setScene(+b.dataset.scene); return; }
  const act = b.dataset.act;
  if (act === 'new') { if (Object.keys(doc.elems).length && !confirm('清空当前地图？（可以撤销）')) return; setScene(-1); }
  else if (act === 'open') fileInput.click();
  else if (act === 'save') saveFile();
});
exportMenu.addEventListener('click', async (e) => {
  const b = (e.target as Element).closest<HTMLButtonElement>('button[data-format]');
  if (!b) return;
  closeMenus();
  const desc = exportBoxScene(doc);
  if (desc.warnings.length && !confirm(`${desc.warnings.join('\n')}\n\n仍然导出？`)) return;
  if (b.dataset.format === 'json') { download('map.scene.json', JSON.stringify(desc), 'application/json'); flash('已导出 map.scene.json'); return; }
  try {
    flash('正在生成 .nmo…');
    exportBtn.setAttribute('disabled', '');
    const { data } = await exportBoxNmo(doc);
    download('map.nmo', data as BlobPart, 'application/octet-stream');
    flash('已导出 map.nmo');
  } catch (err) { console.error(err); flash(`导出失败：${(err as Error).message}`, true); }
  finally { exportBtn.removeAttribute('disabled'); }
});

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

const settingsPanel = document.getElementById('settings-panel')!;
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
  settingsPanel.innerHTML = '<h3>全图设置</h3>'
    + SETTING_FIELDS.map((f) => `<label><span>${f.label}<small>${f.hint}</small></span><input type="number" data-key="${f.key}" step="${f.step}" value="${st[f.key]}"></label>`).join('')
    + '<h3 class="sub">编辑</h3>'
    + `<label><span>格栅步长<small>打开格栅时位置和尺寸的步长（默认 1）</small></span><input type="number" id="grid-step" step="0.25" min="0.05" value="${prefs.gridStep}"></label>`
    + '<h3 class="sub">界面</h3>'
    + `<label class="stack"><span>素材库位置<small>属性面板在另一边</small></span>${seg('lib-side', [['left', '左边'], ['right', '右边']], prefs.side)}</label>`
    + `<label class="stack"><span>机关显示<small>只影响编辑器里的显示，导出仍用占位符</small></span>${seg('module-view', [['model', '机关模型'], ['placeholder', '占位符']], modelView ? 'model' : 'placeholder')}</label>`
    + `<label class="stack"><span>路面切分线<small>调试用：显示路面内部是怎么切的</small></span>${seg('wire', [['off', '关'], ['on', '开']], wireOn ? 'on' : 'off')}</label>`
    + '<div class="row"><button id="settings-reset">恢复默认</button><button id="settings-close">关闭</button></div>';
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
  const segClick = (id: string, fn: (v: string) => void) => settingsPanel.querySelectorAll<HTMLButtonElement>(`#${id} button`).forEach((b) => b.addEventListener('click', () => { fn(b.dataset.v!); renderSettings(); }));
  segClick('lib-side', (v) => { prefs.side = v as 'left' | 'right'; savePrefs(); applySide(); });
  segClick('module-view', (v) => { modelView = v === 'model'; prefs.modelView = modelView; savePrefs(); renderLib(); rebuild(); });
  segClick('wire', (v) => { wireOn = v === 'on'; rebuild(); });
  settingsPanel.querySelector('#settings-reset')!.addEventListener('click', () => { snapshot(); delete doc.settings; prefs.gridStep = 1; savePrefs(); rebuild(); renderSettings(); });
  settingsPanel.querySelector('#settings-close')!.addEventListener('click', () => { settingsPanel.hidden = true; });
}
window.addEventListener('pointerdown', (e) => {
  const t = e.target as Element;
  if (!settingsPanel.hidden && !settingsPanel.contains(t) && !t.closest?.('#settings')) settingsPanel.hidden = true;
});
document.getElementById('settings')!.addEventListener('click', (e) => {
  settingsPanel.hidden = !settingsPanel.hidden;
  if (!settingsPanel.hidden) renderSettings();
  (e.currentTarget as HTMLButtonElement).blur();
});

// 意见与反馈：点击时顺便复制群号
document.getElementById('feedback')!.addEventListener('click', async () => {
  const id = '1005399899';
  try { await navigator.clipboard.writeText(id); flash(`已复制群号 ${id}`); } catch { flash(`QQ 群号：${id}`); }
});

// ---------------- 场景与视图 ----------------

function setScene(i: number) {
  snapshot();
  doc = i < 0 ? { elems: {}, nextId: 1 } : SCENES[i].build();
  sel.clear();
  frameAll();
  rebuild();
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
  const box = new THREE.Box3();
  for (const id of ids) {
    for (const g of elemGroups.get(id) ?? []) box.expandByObject(g);
    const b = elemBounds(doc.elems[id]);
    if (!elemGroups.get(id)?.length) box.union(new THREE.Box3(new THREE.Vector3(b.x0, b.y0, b.z0), new THREE.Vector3(b.x1, b.y1, b.z1)));
  }
  const size = box.getSize(new THREE.Vector3()).length();
  moveCamera(box.getCenter(new THREE.Vector3()), THREE.MathUtils.clamp(size * 1.4, 20, 800));
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
renderer.setAnimationLoop(() => {
  frameNo++;
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
  for (const [id, gs] of elemGroups) {
    const m = !!anim?.ids?.has(id);
    for (const g of gs) g.position.set(m ? off[0] : 0, m ? off[1] : 0, m ? off[2] : 0);
  }
  selLayer.position.set(off[0], off[1], off[2]);
  if (moving && anim?.preview) drawOverlay();
  if (measure) { const m = toScreen(new THREE.Vector3(...measure.a).add(new THREE.Vector3(...measure.b)).multiplyScalar(0.5)); measureLabel.style.left = `${m.x}px`; measureLabel.style.top = `${m.y}px`; }
  if (!fly) controls.update(); // 漫游时视角由鼠标直接控制，OrbitControls 会把相机掰回去对着视图中心
  renderer.render(scene, camera);
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
  get rebuilds() { return rebuildCount; },
  camDist: () => +camera.position.distanceTo(controls.target).toFixed(2),
  camState: () => ({ t: controls.target.toArray(), d: camera.position.distanceTo(controls.target) }),
  camPos: () => camera.position.toArray(),
  get rebuildTimes() { return rebuildTimes; },
  get doc() { return doc; },
  set doc(d: Doc) { doc = d; rebuild(); },
};
