// box 制图原型：路面、素材件、机关的放置与编辑
//   左键：点选 / 框选（Shift 加选）/ 拖动；Shift 拖动沿轴移动；Alt 拖动改高度；Ctrl 拖动改尺寸
//   按住 V 拖动：抓住顶点或边中点，吸附到别的元素的顶点、边中点或边上
//   格栅（G）：位置和尺寸吸附到步长 1；对齐（S）：边、中线、顶面靠近时对齐并画出辅助面
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MatName } from '../geom/floor';
import { FAKE_FIX, OBJ_TYPES, fakeModel, objType } from '../model/objects';
import { stopperMesh } from '../model/stoppers';
import { type AssetPiece, fallbackBox, getAsset, getStopperMaterial, setAssetLoadedCallback } from '../view/assets';
import { floorTexturesReady, getMaterial } from '../view/materials';
import { Bounds, V3, boundsOf, duplicate, elemBounds, expandGroups, groupElems, mergeBoxes, rotateElem, splitBox, translateElem, ungroupElems } from './ops';
import { SCENES } from './scenes';
import { type P3, feats } from './snap';
import { solve } from './solve';
import { exportBoxNmo } from './export';
import { Box, Dir, Doc, Elem, Obj, PieceType, Style, anchorRects, baseSpec, boxTopAt, footprint, isCheckpoint, pieceLen } from './types';

const host = document.getElementById('view')!;
const statusEl = document.getElementById('status')!;
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
controls.mouseButtons = { LEFT: -1 as THREE.MOUSE, MIDDLE: THREE.MOUSE.ROTATE, RIGHT: THREE.MOUSE.PAN };
controls.target.set(20, 10, 0);
controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xffffff, 0x445566, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.position.set(-0.4, -0.7, 1);
scene.add(sun);

const gridHelper = new THREE.GridHelper(400, 400, 0x3a4560, 0x2a3245);
gridHelper.rotation.x = Math.PI / 2;
gridHelper.position.z = -5.02;
scene.add(gridHelper);

const world = new THREE.Group();
const overlay = new THREE.Group();
/** 选中物体的边框、包裹面、对准方块：拖动时跟着物体的缓动一起走 */
const selLayer = new THREE.Group();
scene.add(world, overlay, selLayer);

// ---------------- 状态 ----------------

const STORE = 'bvm.box.doc';
let doc: Doc = (() => { try { const s = localStorage.getItem(STORE); if (s) return JSON.parse(s) as Doc; } catch { /* 读不了就用测试场景 */ } return SCENES[0].build(); })();
let sel = new Set<number>();
let gridOn = false;
let alignOn = false;
let wireOn = false;
let modelView = true;
let vHeld = false;
let splitMode = false;
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
function rebuildInner() {
  rebuildCount++;
  rebuildWanted = false;
  clearWorld();
  elemGroups.clear();
  pickables = [];
  objBoxes.clear();
  const t0 = performance.now();
  const solved = solve(doc);
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
  if (!drag) save();
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
function updateStatus() {
  const parts: string[] = [];
  if (flashMsg && performance.now() < flashMsg.until) parts.push(flashMsg.warn ? `<span class="warn">${flashMsg.text}</span>` : `<b>${flashMsg.text}</b>`);
  if (dragInfo) parts.push(`<b>${dragInfo}</b>`);
  if (sel.size) {
    const b = boundsOf(doc, sel);
    parts.push(`选中 ${sel.size} 个 · ${fmt(b.x1 - b.x0)} × ${fmt(b.y1 - b.y0)} · 顶面 ${fmt(b.z1)}`);
  }
  parts.push(`${Object.keys(doc.elems).length} 个元素 · ${lastSolve.tris} 个三角形 · 求解 ${lastSolve.ms.toFixed(1)} ms`);
  parts.push(splitMode
    ? '切分：点路面在鼠标处切开 · Tab 换方向 · Esc / 右键退出'
    : '中键旋转 · 右键平移 · 滚轮缩放 · 拖空白处框选 · Shift 沿轴移动 · Alt 改高度 · Alt+Shift 拖一头拉坡 · Ctrl 改尺寸 · 按住 V 吸附 · 方向键微调');
  if (gridOn) parts.push('格栅 1');
  if (alignOn) parts.push('自动对齐');
  const html = parts.join('　|　');
  if (html !== lastStatus) { statusEl.innerHTML = html; lastStatus = html; }
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
  const ob = e.kind === 'obj' || isCheckpoint(e) ? objBoxes.get(e.id) : null;
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
function anchorBoxes(o: Obj): THREE.Object3D {
  const segs: THREE.Vector3[] = [];
  for (const r of anchorRects(o)) {
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
let guides: { axis: 0 | 1 | 2; value: number; b: Bounds }[] = [];
let axisLine: { p: THREE.Vector3; axis: 0 | 1 | 2 } | null = null;
let snapTarget: { p: P3; kind: 'v' | 'm' | 'e' } | null = null;
let snapGrab: P3 | null = null;
let splitPreview: { a: P3; b: P3 } | null = null;
/** Ctrl 改尺寸时顶面的测量线（on5：长度正好是 5 的整数倍） */
let measure: { a: P3; b: P3; tick: P3; text: string; on5: boolean } | null = null;
/** 改尺寸时长度吸附到 5 的整数倍的距离（屏幕像素） */
const SIZE5_PX = 7;
const measureLabel = document.createElement('div');
Object.assign(measureLabel.style, { position: 'fixed', pointerEvents: 'none', zIndex: '2', font: '600 13px "Microsoft YaHei UI", sans-serif', padding: '2px 8px', borderRadius: '5px', transform: 'translate(-50%, -130%)', display: 'none' });
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
  // 机关的对准方块（辅助方块）：悬停、选中的机关都画出来
  for (const id of new Set([...hoverGroup, ...sel])) {
    const e = doc.elems[id];
    if (e?.kind === 'obj') (sel.has(id) ? selLayer : overlay).add(anchorBoxes(e));
  }
  // 按住 V：显示鼠标下元素的顶点和边中点
  if (vHeld && hoverId !== null && doc.elems[hoverId] && !drag) {
    const f = feats(doc.elems[hoverId]);
    overlay.add(marks(f.verts, 'dot', 0xffd34c, 11), marks(f.mids, 'diamond', 0xffd34c, 10, 0.85));
  }
  if (snapGrab) overlay.add(marks([snapGrab], 'dot', 0xff8a4c, 13));
  if (snapTarget) overlay.add(marks([snapTarget.p], snapTarget.kind === 'v' ? 'dot' : snapTarget.kind === 'm' ? 'diamond' : 'ring', 0x4cff8a, 18));
  for (const gd of guides) overlay.add(guidePlane(gd));
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
  if (splitPreview) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...splitPreview.a), new THREE.Vector3(...splitPreview.b)]);
    const l = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffd34c, depthTest: false }));
    l.renderOrder = 6;
    overlay.add(l, marks([splitPreview.a, splitPreview.b], 'dot', 0xffd34c, 9));
  }
}

/** 斜线填充的贴图（对齐辅助面用） */
const HATCH = (() => {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.strokeStyle = '#ffffff';
  g.lineWidth = 6;
  g.beginPath();
  for (const o of [-64, 0, 64]) { g.moveTo(o, 64); g.lineTo(o + 64, 0); }
  g.stroke();
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
})();

/** 对齐辅助面：在对齐的那个坐标上画一块斜线填充的面，范围盖住对齐的两个元素 */
function guidePlane(gd: { axis: 0 | 1 | 2; value: number; b: Bounds }): THREE.Object3D {
  const { b } = gd, pad = 1.5;
  // 面上的两个方向（u、v）对应的世界坐标分量
  const [ua, va] = gd.axis === 0 ? [1, 2] : gd.axis === 1 ? [0, 2] : [0, 1];
  const lo = [b.x0 - pad, b.y0 - pad, b.z0 - pad], hi = [b.x1 + pad, b.y1 + pad, b.z1 + pad];
  const P = (u: number, v: number) => { const p = [0, 0, 0]; p[gd.axis] = gd.value; p[ua] = u; p[va] = v; return new THREE.Vector3(...p); };
  const c = [P(lo[ua], lo[va]), P(hi[ua], lo[va]), P(hi[ua], hi[va]), P(lo[ua], hi[va])];
  const S = 1.6; // 每 1.6 个单位一条斜线
  const uv = [[lo[ua], lo[va]], [hi[ua], lo[va]], [hi[ua], hi[va]], [lo[ua], hi[va]]].map(([u, v]) => [u / S, v / S]);
  const geo = new THREE.BufferGeometry().setFromPoints([c[0], c[1], c[2], c[0], c[2], c[3]]);
  geo.setAttribute('uv', new THREE.Float32BufferAttribute([0, 1, 2, 0, 2, 3].flatMap((i) => uv[i]), 2));
  const g = new THREE.Group();
  const face = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: AXIS_COLOR[gd.axis], map: HATCH, transparent: true, opacity: 0.55, side: THREE.DoubleSide, depthWrite: false }));
  const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(c), new THREE.LineDashedMaterial({ color: AXIS_COLOR[gd.axis], dashSize: 0.6, gapSize: 0.4, transparent: true, opacity: 0.9, depthTest: false }));
  edge.computeLineDistances();
  face.renderOrder = 4; edge.renderOrder = 5;
  g.add(face, edge);
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
function toScreen(p: P3 | THREE.Vector3): THREE.Vector2 {
  const v = (Array.isArray(p) ? new THREE.Vector3(...p) : p.clone()).project(camera);
  const r = renderer.domElement.getBoundingClientRect();
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
  for (const e of Object.values(doc.elems)) {
    if (exclude.has(e.id)) continue;
    const f = feats(e);
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
  return d.map((v, i) => (axes.includes(i as 0 | 1 | 2) ? Math.round(lo[i] + v) - lo[i] : v)) as V3;
}

const unionB = (a: Bounds, b: Bounds): Bounds => ({ x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), z0: Math.min(a.z0, b.z0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), z1: Math.max(a.z1, b.z1) });
const shiftB = (b: Bounds, d: V3): Bounds => ({ x0: b.x0 + d[0], x1: b.x1 + d[0], y0: b.y0 + d[1], y1: b.y1 + d[1], z0: b.z0 + d[2], z1: b.z1 + d[2] });

/** 自动对齐：选中整体的边 / 中线 / 顶面与别的元素足够近时对齐，返回修正后的移动量，并记下辅助面 */
function alignDelta(b: Bounds, d: V3, axes: (0 | 1 | 2)[], near: THREE.Vector3): V3 {
  guides = [];
  if (!alignOn) return d;
  const thr = worldPerPx(near) * ALIGN_PX;
  const out = [...d] as V3;
  const others = Object.values(doc.elems).filter((e) => !sel.has(e.id)).map(elemBounds);
  const vals = (x: Bounds, a: 0 | 1 | 2) => (a === 0 ? [x.x0, x.x1, (x.x0 + x.x1) / 2] : a === 1 ? [x.y0, x.y1, (x.y0 + x.y1) / 2] : [x.z1, x.z0]);
  const hits: { a: 0 | 1 | 2; value: number; ob: Bounds }[] = [];
  for (const a of axes) {
    let best: { diff: number; value: number; ob: Bounds } | null = null;
    const mine = vals(b, a).map((v) => v + d[a]);
    for (const ob of others) for (const v of vals(ob, a)) for (const m of mine) {
      const diff = v - m;
      if (Math.abs(diff) < thr && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, value: v, ob };
    }
    if (!best) continue;
    out[a] += best.diff;
    hits.push({ a, value: best.value, ob: best.ob });
  }
  for (const h of hits) guides.push({ axis: h.a, value: h.value, b: unionB(shiftB(b, out), h.ob) });
  return out;
}

// ---------------- 拖动 ----------------

type Drag =
  | { t: 'move'; orig: Map<number, string>; b: Bounds; plane: THREE.Plane; start: THREE.Vector3; grab?: boolean }
  | { t: 'axis'; orig: Map<number, string>; b: Bounds; start: THREE.Vector3; sx: number; sy: number; axis: 0 | 1 | null }
  | { t: 'lift'; orig: Map<number, string>; b: Bounds; plane: THREE.Plane; start: THREE.Vector3 }
  | { t: 'size'; id: number; orig: Map<number, string>; plane: THREE.Plane; start: THREE.Vector3; side: Dir }
  | { t: 'tilt'; id: number; orig: Map<number, string>; plane: THREE.Plane; start: THREE.Vector3; axis: 0 | 1; hi: boolean }
  | { t: 'vsnap'; orig: Map<number, string>; grab: P3; plane: THREE.Plane }
  | { t: 'marquee'; sx: number; sy: number; add: boolean }
  | { t: 'place'; ids: number[] | null; orig?: Map<number, string>; type: string; moved: boolean }
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
el.addEventListener('pointerdown', (e) => {
  if (e.button === 2 && (splitMode || (drag?.t === 'move' && drag.grab))) { cancelGrab(); exitSplit(); return; }
  if (e.button !== 0) return;
  if (drag?.t === 'move' && drag.grab) { finishDrag(); return; } // 复制后跟着鼠标走：点击放下
  if (splitMode) { doSplit(e); return; }
  const h = pick(e);
  el.setPointerCapture(e.pointerId);
  if (!h) { drag = { t: 'marquee', sx: e.clientX, sy: e.clientY, add: e.shiftKey }; return; }
  const group = expandGroups(doc, [h.id]);
  const hb = doc.elems[h.id];
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
    const id = pick(e)?.id ?? null;
    if (id !== hoverId || vHeld) { hoverId = id; drawOverlay(); }
    return;
  }
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
  const raw = p.clone().sub(drag.start);
  if (drag.t === 'move') {
    let d: V3 = [raw.x, raw.y, 0];
    d = gridDelta(drag.b, d, [0, 1]);
    moveWithSnap(drag.orig, d, alignDelta(drag.b, d, [0, 1], p));
  } else if (drag.t === 'lift') {
    let d: V3 = [0, 0, raw.z];
    d = gridDelta(drag.b, d, [2]);
    moveWithSnap(drag.orig, d, alignDelta(drag.b, d, [2], p));
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
  if (gridOn) raw = Math.round(raw);
  raw = Math.round(raw * 1000) / 1000;
  let snap: number | null = null;
  guides = [];
  if (alignOn) {
    const thr = worldPerPx(p) * ALIGN_PX;
    let best: { diff: number; ob: Bounds } | null = null;
    for (const ob of Object.values(doc.elems).filter((x) => x.id !== o.id).map(elemBounds)) {
      for (const v of ax === 0 ? [ob.x0, ob.x1] : [ob.y0, ob.y1]) { const diff = v - raw; if (Math.abs(diff) < thr && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, ob }; }
    }
    if (best) { snap = raw + best.diff; guides.push({ axis: ax, value: snap, b: unionB(elemBounds(o), best.ob) }); }
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
    const P = (t: number): P3 => { const x = ax === 0 ? t : mid, y = ax === 0 ? mid : t; return [x, y, boxTopAt(b, x, y) + 0.08]; };
    const [t0, t1] = ax === 0 ? [f.x0, f.x1] : [f.y0, f.y1];
    measure = { a: P(t0), b: P(t1), tick: ax === 0 ? [0, 0.6, 0] : [0.6, 0, 0], text: fmt(finalLen), on5: snap !== null };
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
  if (gridOn) raw = Math.round(raw);
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
    if (best) { snap = best.v; guides.push({ axis: 2, value: snap, b: unionB(elemBounds(o), best.ob) }); }
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

window.addEventListener('pointerup', (e) => {
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
  marqueeEl.hidden = false;
  Object.assign(marqueeEl.style, { left: `${Math.min(x0, x1)}px`, top: `${Math.min(y0, y1)}px`, width: `${Math.abs(x1 - x0)}px`, height: `${Math.abs(y1 - y0)}px` });
}
function finishMarquee(d: { sx: number; sy: number; add: boolean }, e: PointerEvent) {
  marqueeEl.hidden = true;
  drag = null;
  const [x0, x1] = [Math.min(d.sx, e.clientX), Math.max(d.sx, e.clientX)], [y0, y1] = [Math.min(d.sy, e.clientY), Math.max(d.sy, e.clientY)];
  if (x1 - x0 < 4 && y1 - y0 < 4) { if (!d.add) sel.clear(); drawOverlay(); syncProps(); updateStatus(); return; }
  // 框住元素顶面的中心就算选中
  const hit: number[] = [];
  for (const it of Object.values(doc.elems)) {
    const b = elemBounds(it);
    const s = toScreen([(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, b.z1]);
    if (s.x >= x0 && s.x <= x1 && s.y >= y0 && s.y <= y1) hit.push(it.id);
  }
  const got = expandGroups(doc, hit);
  sel = d.add ? new Set([...sel, ...got]) : got;
  drawOverlay(); syncProps(); updateStatus();
}

// ---------------- 从顶栏拖进来放置 ----------------

function newElems(type: string): Elem[] {
  const id = doc.nextId++;
  if (type === 'transition' || type === 'transition-narrow' || type === 'start' || type === 'check') return [{ id, kind: 'piece', type: type as PieceType, x: 0, y: 0, z: 0, rot: 0 }];
  if (type.startsWith('obj:')) return [{ id, kind: 'obj', type: type.slice(4), x: 0, y: 0, z: 0, rot: 0 }];
  return [{ id, kind: 'box', x: 0, y: 0, z: 0, sx: 10, sy: 5, depth: 5, style: type as Style }];
}

/** 新放的东西的「抓手」：机关是对准方块顶面中心，其余是顶面最小角 */
function handleOf(e: Elem): P3 {
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
  drag = { t: 'place', ids: null, type, moved: false };
}
function placeMove(e: PointerEvent) {
  if (drag?.t !== 'place') return;
  const r = el.getBoundingClientRect();
  const over = e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom;
  if (!over) return;
  drag.moved = true;
  palette.hidden = true;
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
  const h = pick(e, ids);
  const p = h?.p ?? planeHit(e, new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)) ?? new THREE.Vector3();
  restore(orig);
  const hd = handleOf(doc.elems[drag.ids[0]]);
  let raw: V3 = [p.x - hd[0], p.y - hd[1], p.z - hd[2]];
  if (gridOn) { const b = boundsOf(doc, ids); raw = [Math.round(b.x0 + raw[0]) - b.x0, Math.round(b.y0 + raw[1]) - b.y0, raw[2]]; }
  // 自动吸附：新元素的顶点 / 边中点靠近别的元素的顶点、边中点或边就吸过去（磁吸，松手对准）
  moveSel(orig, raw);
  let best: { from: P3; to: P3; d: number; kind: 'v' | 'm' | 'e' } | null = null;
  for (const id of ids) {
    const f = feats(doc.elems[id]);
    for (const v of [...f.verts, ...f.mids]) {
      const s = toScreen(v);
      const t = findTarget(s.x, s.y, ids, 16);
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
  const r = el.getBoundingClientRect();
  const over = e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom;
  if (!drag.moved && !over) {
    // 点击按钮：放到视图中心
    snapshot();
    const es = newElems(drag.type);
    for (const n of es) doc.elems[n.id] = n;
    const ids = es.map((n) => n.id);
    const b = boundsOf(doc, ids);
    const g = (v: number) => (gridOn ? Math.round(v) : v);
    for (const id of ids) translateElem(doc.elems[id], [g(controls.target.x - (b.x1 - b.x0) / 2) - b.x0, g(controls.target.y - (b.y1 - b.y0) / 2) - b.y0, 0]);
    sel = new Set(ids);
    palette.hidden = true;
  } else if (drag.ids !== null && !over) { for (const id of drag.ids) delete doc.elems[id]; undo.pop(); sel.clear(); }
  anim = null; snapping = false;
  drag = null; snapTarget = null;
  rebuild();
}
for (const b of document.querySelectorAll<HTMLButtonElement>('.add')) {
  b.addEventListener('pointerdown', (e) => { e.preventDefault(); startPlace(b.dataset.add!); });
}

// 机关面板
const palette = document.getElementById('palette')!;
palette.innerHTML = (['module', 'deco'] as const).map((cat) => `<div class="cat">${cat === 'module' ? '机关' : '装饰'}</div>`
  + OBJ_TYPES.filter((t) => t.cat === cat).map((t) => `<div class="item" data-type="${t.type}" title="拖进视图放置">${t.label}${baseSpec(t.type) ? ' · 带专属路块' : ''}</div>`).join('')).join('');
palette.addEventListener('pointerdown', (e) => {
  const it = (e.target as HTMLElement).closest<HTMLElement>('.item');
  if (!it) return;
  e.preventDefault();
  startPlace(`obj:${it.dataset.type}`);
});
const modsBtn = document.getElementById('mods')!;
modsBtn.addEventListener('click', () => {
  const r = modsBtn.getBoundingClientRect();
  palette.style.left = `${r.left}px`;
  palette.hidden = !palette.hidden;
});
window.addEventListener('pointerdown', (e) => { if (!palette.contains(e.target as Node) && e.target !== modsBtn) palette.hidden = true; });

// ---------------- 切分 ----------------

function splitAt(e: { clientX: number; clientY: number }): { id: number; axis: 0 | 1; t: number } | null {
  const h = pick(e);
  const b = h && doc.elems[h.id];
  if (!h || b?.kind !== 'box') return null;
  const axis: 0 | 1 = splitAxis ?? (b.sx >= b.sy ? 0 : 1);
  let t = h.p.getComponent(axis);
  t = gridOn ? Math.round(t) : Math.round(t * 1000) / 1000;
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
function enterSplit() { splitMode = true; splitAxis = null; document.getElementById('split')!.classList.add('on'); sel.clear(); drawOverlay(); updateStatus(); }
function exitSplit() { if (!splitMode) return; splitMode = false; splitPreview = null; dragInfo = ''; document.getElementById('split')!.classList.remove('on'); drawOverlay(); updateStatus(); }

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
  if (gridOn) { const nb = boundsOf(doc, sel); for (const id of sel) translateElem(doc.elems[id], [Math.round(nb.x0) - nb.x0, Math.round(nb.y0) - nb.y0, 0]); }
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

document.getElementById('split')!.addEventListener('click', () => (splitMode ? exitSplit() : enterSplit()));
document.getElementById('merge')!.addEventListener('click', doMerge);
document.getElementById('group')!.addEventListener('click', doGroup);
document.getElementById('ungroup')!.addEventListener('click', doUngroup);
document.getElementById('dup')!.addEventListener('click', () => { const r = el.getBoundingClientRect(); doDuplicate({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }); });
document.getElementById('rot')!.addEventListener('click', doRotate);
document.getElementById('del')!.addEventListener('click', doDelete);
const gridBtn = document.getElementById('grid')!;
const toggleGrid = () => { gridOn = !gridOn; gridBtn.classList.toggle('on', gridOn); updateStatus(); };
gridBtn.addEventListener('click', toggleGrid);
const alignBtn = document.getElementById('align')!;
const toggleAlign = () => { alignOn = !alignOn; alignBtn.classList.toggle('on', alignOn); updateStatus(); };
alignBtn.addEventListener('click', toggleAlign);
const wireBtn = document.getElementById('wire')!;
wireBtn.addEventListener('click', () => { wireOn = !wireOn; wireBtn.classList.toggle('on', wireOn); rebuild(); });
const viewBtn = document.getElementById('view-mode')!;
viewBtn.addEventListener('click', () => { modelView = !modelView; viewBtn.textContent = modelView ? '机关模型' : '占位符'; rebuild(); });

window.addEventListener('keydown', (e) => {
  const tag = (e.target as HTMLElement).tagName;
  if (tag === 'INPUT' || tag === 'SELECT') return;
  const k = e.key.toLowerCase();
  if (k === 'v' && !vHeld) { vHeld = true; drawOverlay(); }
  if (k === 'escape') { cancelGrab(); exitSplit(); }
  if (k === 'tab' && splitMode) { e.preventDefault(); splitAxis = splitAxis === null ? 1 : ((1 - splitAxis) as 0 | 1); splitHover(lastMouse); }
  if (e.ctrlKey) {
    if (k === 'z') undoOnce();
    else if (k === 'y') redoOnce();
    else if (k === 'j') { e.preventDefault(); doMerge(); }
    else if (k === 'g') { e.preventDefault(); if (e.shiftKey) doUngroup(); else doGroup(); }
    else if (k === 'd') { e.preventDefault(); doDuplicate(lastMouse); }
    else if (k === 'a') { e.preventDefault(); sel = new Set(Object.keys(doc.elems).map(Number)); drawOverlay(); syncProps(); updateStatus(); }
    return;
  }
  if (k === 'g') toggleGrid();
  if (k === 's') toggleAlign();
  if (k === 'k') (splitMode ? exitSplit() : enterSplit());
  if (k === 'r') doRotate();
  if (k === 'delete' || k === 'backspace' || k === 'x') doDelete();
  if (k === 'f') frameAll();
  const step = e.shiftKey ? 0.1 : 1;
  const arrows: Record<string, V3> = { arrowleft: [-step, 0, 0], arrowright: [step, 0, 0], arrowup: [0, step, 0], arrowdown: [0, -step, 0], pageup: [0, 0, step], pagedown: [0, 0, -step] };
  if (arrows[k]) { e.preventDefault(); nudge(arrows[k]); }
});
window.addEventListener('keyup', (e) => { if (e.key.toLowerCase() === 'v') { vHeld = false; drawOverlay(); } });

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
  } else if (one.kind === 'piece' && isCheckpoint(one)) {
    const checks = Object.values(doc.elems).filter((e) => e.kind === 'piece' && e.type === 'check').sort((a, b) => a.id - b.id);
    h += `<div class="title">${one.type === 'start' ? '起点' : `小节盘点（第 ${one.sector ?? checks.indexOf(one) + 2} 小节）`}</div>`;
    h += num('x', 'x', one.x) + num('y', 'y', one.y) + num('z', '顶面', one.z);
    h += `<label>路口朝向</label><select data-k="rot">${['+X', '+Y', '-X', '-Y'].map((n, r) => `<option value="${r}"${r === one.rot ? ' selected' : ''}>${n}</option>`).join('')}</select>`;
  } else if (one.kind === 'piece') {
    h += `<div class="title">${one.type === 'transition' ? '平凹转换' : '窄转换'}（长 ${pieceLen(one)}）</div>`;
    h += num('x', 'x', one.x) + num('y', 'y', one.y) + num('z', '顶面', one.z);
  } else {
    const t = objType(one.type);
    h += `<div class="title">${t?.label ?? one.type}</div>`;
    h += num('x', 'x', one.x) + num('y', 'y', one.y) + num('z', 'z', one.z);
    h += `<label>朝向</label><select data-k="rot">${[0, 1, 2, 3].map((r) => `<option value="${r}"${r === one.rot ? ' selected' : ''}>${r * 90}°</option>`).join('')}</select>`;
    const extra: string[] = [];
    if (stopperMesh({ id: 0, cat: 'module', type: one.type, x: 0, y: 0, z: 0, rot: 0 })) extra.push(`<label><input type="checkbox" data-flag="noStopper"${one.noStopper ? '' : ' checked'}>挡块</label>`);
    if (baseSpec(one.type)) extra.push(`<label><input type="checkbox" data-flag="noBase"${one.noBase ? '' : ' checked'}>专属路块</label>`);
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
  if ((e.kind === 'obj' || e.kind === 'piece') && k === 'rot') e.rot = +t.value as Dir;
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
document.getElementById('open')!.addEventListener('click', () => fileInput.click());
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
document.getElementById('save')!.addEventListener('click', saveFile);
document.getElementById('export')!.addEventListener('click', async () => {
  try {
    flash('正在生成 NMO…');
    const { data, warnings } = await exportBoxNmo(doc);
    download('map.nmo', data as BlobPart, 'application/octet-stream');
    flash(warnings.length ? `已导出 map.nmo（${warnings.join('；')}）` : '已导出 map.nmo', warnings.length > 0);
  } catch (e) { flash(`导出失败：${(e as Error).message}`, true); console.error(e); }
});
window.addEventListener('keydown', (e) => { if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); saveFile(); } });

// ---------------- 场景与视图 ----------------

const sceneSel = document.getElementById('scene') as HTMLSelectElement;
sceneSel.innerHTML = '<option value="" hidden>测试场景…</option>' + SCENES.map((s, i) => `<option value="${i}">${s.name}</option>`).join('') + '<option value="-1">空白</option>';
sceneSel.addEventListener('change', () => { setScene(+sceneSel.value); sceneSel.value = ''; sceneSel.blur(); });
function setScene(i: number) {
  snapshot();
  doc = i < 0 ? { elems: {}, nextId: 1 } : SCENES[i].build();
  sel.clear();
  frameAll();
  rebuild();
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
  const w = host.clientWidth, h = host.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();
frameAll();
rebuild();
// 路面贴图加载好之前先不显示（最多等 1.5 秒），免得先闪一下纯色的路面
renderer.domElement.style.opacity = '0';
Promise.race([floorTexturesReady(), new Promise((r) => setTimeout(r, 1500))]).then(() => {
  renderer.domElement.style.transition = 'opacity .15s';
  renderer.domElement.style.opacity = '1';
});
renderer.setAnimationLoop(() => {
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
  controls.update();
  renderer.render(scene, camera);
});

// 截图脚本用
(window as unknown as Record<string, unknown>).__proto = {
  setScene,
  view: (pos: number[], target: number[]) => { camera.position.set(pos[0], pos[1], pos[2]); controls.target.set(target[0], target[1], target[2]); controls.update(); },
  project: (p: number[]) => { const s = toScreen([p[0], p[1], p[2]]); return { x: s.x, y: s.y }; },
  wire: (on: boolean) => { wireOn = on; wireBtn.classList.toggle('on', on); rebuild(); },
  select: (ids: number[]) => { sel = new Set(ids); drawOverlay(); syncProps(); },
  toggle: (k: 'grid' | 'align') => (k === 'grid' ? toggleGrid() : toggleAlign()),
  get sel() { return [...sel]; },
  get rebuilds() { return rebuildCount; },
  get rebuildTimes() { return rebuildTimes; },
  get doc() { return doc; },
  set doc(d: Doc) { doc = d; rebuild(); },
};
