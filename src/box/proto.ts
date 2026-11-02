// box 制图原型：验证花纹算法和基本交互（拖动、V 键顶点吸附、格栅、拖拽放置）
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MatName } from '../geom/floor';
import { getMaterial } from '../view/materials';
import { SCENES } from './scenes';
import { solve } from './solve';
import { Box, Dir, Doc, Elem, PieceType, Style, boxTopAt, footprint, pieceLen } from './types';

const host = document.getElementById('view')!;
const status = document.getElementById('status')!;
const props = document.getElementById('props')!;

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
scene.add(world, overlay);

let doc: Doc = SCENES[0].build();
let selected: number | null = null;
let gridOn = false;
let wireOn = false;
let vHeld = false;
const undo: string[] = [];
const redo: string[] = [];
const snapshot = () => { undo.push(JSON.stringify(doc)); redo.length = 0; if (undo.length > 200) undo.shift(); };

// ---------------- 渲染 ----------------

let pickables: THREE.Mesh[] = [];
function rebuild() {
  world.clear();
  pickables = [];
  const t0 = performance.now();
  const meshes = solve(doc);
  const ms = performance.now() - t0;
  let tris = 0;
  for (const m of meshes.values()) {
    const g = new THREE.Group();
    for (const [mat, part] of Object.entries(m.parts) as [MatName, { pos: number[]; uv: number[] }][]) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(part.pos, 3));
      geo.setAttribute('uv', new THREE.Float32BufferAttribute(part.uv, 2));
      geo.computeVertexNormals();
      const mesh = new THREE.Mesh(geo, getMaterial(mat));
      mesh.userData.id = m.id;
      g.add(mesh);
      pickables.push(mesh);
      tris += part.pos.length / 9;
      if (wireOn) g.add(new THREE.LineSegments(new THREE.WireframeGeometry(geo), new THREE.LineBasicMaterial({ color: 0x00e0ff, transparent: true, opacity: 0.45 })));
    }
    world.add(g);
  }
  drawOverlay();
  setStatus(`${Object.keys(doc.elems).length} 个元素 · ${tris} 个三角形 · 求解 ${ms.toFixed(1)} ms`);
  syncProps();
}

let statusBase = '';
function setStatus(s?: string) {
  if (s !== undefined) statusBase = s;
  const keys = '中键旋转 · 右键平移 · 滚轮缩放 · 左键拖动移动 · Alt 拖动改高度 · Ctrl 拖动改尺寸 · 按住 V 拖顶点吸附 · G 格栅 · R 旋转';
  status.textContent = `${statusBase}　|　${keys}${gridOn ? '　|　格栅 1' : ''}`;
}

/** 元素的 8 个顶点 */
function vertsOf(e: Elem): THREE.Vector3[] {
  const f = footprint(e);
  const out: THREE.Vector3[] = [];
  for (const [x, y] of [[f.x0, f.y0], [f.x1, f.y0], [f.x1, f.y1], [f.x0, f.y1]]) {
    const top = e.kind === 'box' ? boxTopAt(e, x, y) : e.z;
    const depth = e.kind === 'box' ? e.depth : 5;
    out.push(new THREE.Vector3(x, y, top), new THREE.Vector3(x, y, top - depth));
  }
  return out;
}

function outline(e: Elem, color: number, opacity = 1) {
  const v = vertsOf(e);
  const idx = [0, 2, 2, 4, 4, 6, 6, 0, 1, 3, 3, 5, 5, 7, 7, 1, 0, 1, 2, 3, 4, 5, 6, 7];
  const geo = new THREE.BufferGeometry().setFromPoints(idx.map((i) => v[i]));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthTest: false }));
}

let hoverId: number | null = null;
let snapMarks: { from?: THREE.Vector3; to?: THREE.Vector3 } = {};
function drawOverlay() {
  overlay.clear();
  if (hoverId !== null && hoverId !== selected && doc.elems[hoverId]) overlay.add(outline(doc.elems[hoverId], 0x9fc2ff, 0.5));
  if (selected !== null && doc.elems[selected]) overlay.add(outline(doc.elems[selected], 0x4c8dff));
  if (vHeld && hoverId !== null && doc.elems[hoverId]) overlay.add(dots(vertsOf(doc.elems[hoverId]), 0xffd34c, 9));
  if (snapMarks.to) overlay.add(dots([snapMarks.to], 0x4cff8a, 16));
  if (snapMarks.from) overlay.add(dots([snapMarks.from], 0xff7a4c, 12));
}
function dots(ps: THREE.Vector3[], color: number, size: number) {
  const g = new THREE.BufferGeometry().setFromPoints(ps);
  return new THREE.Points(g, new THREE.PointsMaterial({ color, size, sizeAttenuation: false, depthTest: false }));
}

// ---------------- 拾取 ----------------

const ray = new THREE.Raycaster();
const ndc = new THREE.Vector2();
function setNdc(e: { clientX: number; clientY: number }) {
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
}
function pick(e: { clientX: number; clientY: number }, skip?: number): { id: number; p: THREE.Vector3 } | null {
  setNdc(e);
  for (const h of ray.intersectObjects(pickables, false)) {
    const id = h.object.userData.id as number;
    if (id !== skip) return { id, p: h.point.clone() };
  }
  return null;
}
function planeHit(e: { clientX: number; clientY: number }, plane: THREE.Plane) {
  setNdc(e);
  return ray.ray.intersectPlane(plane, new THREE.Vector3());
}
function toScreen(p: THREE.Vector3): THREE.Vector2 {
  const v = p.clone().project(camera);
  const r = renderer.domElement.getBoundingClientRect();
  return new THREE.Vector2((v.x + 1) / 2 * r.width + r.left, (1 - v.y) / 2 * r.height + r.top);
}
/** 离屏幕上 (x, y) 最近的、其它元素的顶点 */
function nearestVertex(x: number, y: number, exclude: number, maxPx = 14): THREE.Vector3 | null {
  let best: THREE.Vector3 | null = null, bd = maxPx;
  for (const e of Object.values(doc.elems)) {
    if (e.id === exclude) continue;
    for (const v of vertsOf(e)) { const s = toScreen(v); const d = Math.hypot(s.x - x, s.y - y); if (d < bd) { bd = d; best = v; } }
  }
  return best;
}

// ---------------- 编辑操作 ----------------

const snapGrid = (v: number) => (gridOn ? Math.round(v) : v);

function translate(e: Elem, dx: number, dy: number, dz: number) { e.x += dx; e.y += dy; e.z += dz; }

function rotateElem(e: Elem) {
  if (e.kind === 'piece') { e.rot = ((e.rot + 1) % 4) as Dir; return; }
  const cx = e.x + e.sx / 2, cy = e.y + e.sy / 2;
  [e.sx, e.sy] = [e.sy, e.sx];
  e.x = cx - e.sx / 2; e.y = cy - e.sy / 2;
  if (e.slope) {
    if (e.slope.axis === 0) e.slope.axis = 1;
    else { e.slope = { axis: 0, dz: -e.slope.dz }; e.z -= e.slope.dz; }
  }
  if (e.open) { const o = e.open; e.open = ((o << 1) | (o >> 3)) & 15; }
}

function newElem(type: string): Elem {
  const id = doc.nextId++;
  if (type === 'transition' || type === 'transition-narrow') return { id, kind: 'piece', type: type as PieceType, x: 0, y: 0, z: 0, rot: 0 };
  return { id, kind: 'box', x: 0, y: 0, z: 0, sx: 10, sy: 5, depth: 5, style: type as Style };
}

type Drag =
  | { t: 'move'; id: number; orig: string; plane: THREE.Plane; start: THREE.Vector3 }
  | { t: 'lift'; id: number; orig: string; plane: THREE.Plane; start: THREE.Vector3 }
  | { t: 'size'; id: number; orig: string; plane: THREE.Plane; start: THREE.Vector3; side: Dir }
  | { t: 'vsnap'; id: number; orig: string; grab: THREE.Vector3; plane: THREE.Plane }
  | { t: 'place'; id: number | null; type: string; moved: boolean };
let drag: Drag | null = null;

const el = renderer.domElement;
el.addEventListener('contextmenu', (e) => e.preventDefault());
el.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const h = pick(e);
  if (!h) { selected = null; drawOverlay(); syncProps(); return; }
  selected = h.id;
  const elem = doc.elems[h.id];
  const orig = JSON.stringify(elem);
  if (vHeld) {
    // 按住 V：抓住离鼠标最近的顶点
    let grab = vertsOf(elem)[0], bd = Infinity;
    for (const v of vertsOf(elem)) { const s = toScreen(v); const d = Math.hypot(s.x - e.clientX, s.y - e.clientY); if (d < bd) { bd = d; grab = v; } }
    drag = { t: 'vsnap', id: h.id, orig, grab, plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -grab.z) };
  } else if (e.altKey) {
    const n = camera.getWorldDirection(new THREE.Vector3()).setZ(0).normalize();
    drag = { t: 'lift', id: h.id, orig, plane: new THREE.Plane().setFromNormalAndCoplanarPoint(n, h.p), start: h.p };
  } else if (e.ctrlKey && elem.kind === 'box') {
    const f = footprint(elem);
    const ds = [f.x1 - h.p.x, f.y1 - h.p.y, h.p.x - f.x0, h.p.y - f.y0].map(Math.abs);
    const side = ds.indexOf(Math.min(...ds)) as Dir;
    drag = { t: 'size', id: h.id, orig, plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -h.p.z), start: h.p, side };
  } else {
    drag = { t: 'move', id: h.id, orig, plane: new THREE.Plane(new THREE.Vector3(0, 0, 1), -h.p.z), start: h.p };
  }
  snapshot();
  el.setPointerCapture(e.pointerId);
  drawOverlay(); syncProps();
});

window.addEventListener('pointermove', (e) => {
  if (!drag) {
    const h = e.target === el ? pick(e) : null;
    const id = h?.id ?? null;
    if (id !== hoverId) { hoverId = id; drawOverlay(); }
    return;
  }
  if (drag.t === 'place') { placeMove(e); return; }
  const elem = doc.elems[drag.id];
  const o = JSON.parse(drag.orig) as Elem;
  if (drag.t === 'vsnap') {
    const p = planeHit(e, drag.plane);
    if (!p) return;
    Object.assign(elem, o);
    const target = nearestVertex(e.clientX, e.clientY, drag.id);
    const to = target ?? p;
    translate(elem, to.x - drag.grab.x, to.y - drag.grab.y, target ? to.z - drag.grab.z : 0);
    snapMarks = { to: target ?? undefined, from: undefined };
    rebuild();
    return;
  }
  const p = planeHit(e, drag.plane);
  if (!p) return;
  const d = p.clone().sub(drag.start);
  Object.assign(elem, o);
  if (drag.t === 'move') {
    const f = footprint(o);
    elem.x = o.x + snapGrid(f.x0 + d.x) - f.x0;
    elem.y = o.y + snapGrid(f.y0 + d.y) - f.y0;
  } else if (drag.t === 'lift') {
    elem.z = snapGrid(o.z + d.z);
  } else if (drag.t === 'size' && elem.kind === 'box' && o.kind === 'box') {
    const s = drag.side;
    if (s === 0) elem.sx = Math.max(0.1, snapGrid(o.x + o.sx + d.x) - o.x);
    if (s === 1) elem.sy = Math.max(0.1, snapGrid(o.y + o.sy + d.y) - o.y);
    if (s === 2) { const x0 = Math.min(o.x + o.sx - 0.1, snapGrid(o.x + d.x)); elem.x = x0; elem.sx = o.x + o.sx - x0; }
    if (s === 3) { const y0 = Math.min(o.y + o.sy - 0.1, snapGrid(o.y + d.y)); elem.y = y0; elem.sy = o.y + o.sy - y0; }
  }
  rebuild();
});

window.addEventListener('pointerup', (e) => {
  if (!drag) return;
  if (drag.t === 'place') { placeEnd(e); return; }
  if (JSON.stringify(doc.elems[drag.id]) === drag.orig) undo.pop();
  drag = null;
  snapMarks = {};
  drawOverlay();
});

// ---------------- 从顶栏拖进来放置 ----------------

for (const b of document.querySelectorAll<HTMLButtonElement>('.add')) {
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drag = { t: 'place', id: null, type: b.dataset.add!, moved: false };
  });
}
function placeMove(e: PointerEvent) {
  if (drag?.t !== 'place') return;
  const r = el.getBoundingClientRect();
  const over = e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom;
  if (!over) return;
  drag.moved = true;
  if (drag.id === null) { snapshot(); const n = newElem(drag.type); doc.elems[n.id] = n; drag.id = n.id; }
  const elem = doc.elems[drag.id];
  // 鼠标下的路面顶面（或地面）
  const h = pick(e, drag.id);
  const p = h?.p ?? planeHit(e, new THREE.Plane(new THREE.Vector3(0, 0, 1), 0)) ?? new THREE.Vector3();
  const f = footprint(elem);
  translate(elem, p.x - f.x0, p.y - f.y0, p.z - elem.z);
  // 拖拽放置时自动吸附：新元素的任一顶点靠近别的顶点就贴上去
  let best: { from: THREE.Vector3; to: THREE.Vector3; d: number } | null = null;
  for (const v of vertsOf(elem)) {
    const s = toScreen(v);
    const t = nearestVertex(s.x, s.y, elem.id, 18);
    if (!t) continue;
    const d = toScreen(t).distanceTo(s);
    if (!best || d < best.d) best = { from: v, to: t, d };
  }
  if (best) translate(elem, best.to.x - best.from.x, best.to.y - best.from.y, best.to.z - best.from.z);
  else if (gridOn) { const g = footprint(elem); translate(elem, Math.round(g.x0) - g.x0, Math.round(g.y0) - g.y0, 0); }
  snapMarks = best ? { to: best.to } : {};
  selected = elem.id;
  rebuild();
}
function placeEnd(e: PointerEvent) {
  if (drag?.t !== 'place') return;
  const r = el.getBoundingClientRect();
  const over = e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom;
  if (!drag.moved && !over) {
    // 点击按钮：放到视图中心
    snapshot();
    const n = newElem(drag.type);
    const f = footprint(n);
    translate(n, snapGrid(controls.target.x - (f.x1 - f.x0) / 2) - f.x0, snapGrid(controls.target.y - (f.y1 - f.y0) / 2) - f.y0, 0);
    doc.elems[n.id] = n; selected = n.id;
  } else if (drag.id !== null && !over) { delete doc.elems[drag.id]; undo.pop(); selected = null; }
  drag = null; snapMarks = {};
  rebuild();
}

// ---------------- 属性面板 ----------------

function syncProps() {
  const e = selected !== null ? doc.elems[selected] : null;
  if (!e) { props.hidden = true; return; }
  if (props.dataset.id === String(e.id) && props.contains(document.activeElement)) return;
  props.hidden = false;
  props.dataset.id = String(e.id);
  const num = (k: string, v: number) => `<label>${k}</label><input data-k="${k}" type="number" step="0.1" value="${+v.toFixed(4)}">`;
  let h = num('x', e.x) + num('y', e.y) + num('z', e.z);
  if (e.kind === 'box') {
    h += num('sx', e.sx) + num('sy', e.sy) + num('depth', e.depth);
    h += `<label>样式</label><select data-k="style">${(['normal', 'sink', 'ribbon'] as Style[]).map((s) => `<option value="${s}"${s === e.style ? ' selected' : ''}>${{ normal: '平路', sink: '凹路', ribbon: '细边框凹路' }[s]}</option>`).join('')}</select>`;
    h += `<label>倾斜轴</label><select data-k="axis"><option value="-1">不倾斜</option><option value="0"${e.slope?.axis === 0 ? ' selected' : ''}>沿 X</option><option value="1"${e.slope?.axis === 1 ? ' selected' : ''}>沿 Y</option></select>`;
    h += num('dz', e.slope?.dz ?? 0);
    h += `<div class="row">开口：${['+X', '+Y', '-X', '-Y'].map((n, i) => `<label><input type="checkbox" data-open="${i}"${(e.open ?? 0) & (1 << i) ? ' checked' : ''}>${n}</label>`).join('')}</div>`;
  } else {
    h += `<label>类型</label><span>${e.type === 'transition' ? '平凹转换' : '窄转换'}（长 ${pieceLen(e)}）</span>`;
  }
  props.innerHTML = h;
}
props.addEventListener('change', (ev) => {
  const t = ev.target as HTMLInputElement;
  const e = selected !== null ? doc.elems[selected] : null;
  if (!e) return;
  snapshot();
  if (t.dataset.open !== undefined && e.kind === 'box') e.open = ((e.open ?? 0) ^ (1 << +t.dataset.open)) || undefined;
  const k = t.dataset.k;
  if (k && e.kind === 'box') {
    if (k === 'style') e.style = t.value as Style;
    else if (k === 'axis') e.slope = +t.value < 0 ? undefined : { axis: +t.value as 0 | 1, dz: e.slope?.dz || 2.5 };
    else if (k === 'dz') { if (e.slope) e.slope.dz = +t.value; }
    else if (k === 'sx' || k === 'sy' || k === 'depth') (e as Box)[k] = Math.max(0.1, +t.value);
    else if (k === 'x' || k === 'y' || k === 'z') e[k] = +t.value;
  } else if (k === 'x' || k === 'y' || k === 'z') e[k] = +t.value;
  props.dataset.id = '';
  rebuild();
});

// ---------------- 顶栏与快捷键 ----------------

const sceneSel = document.getElementById('scene') as HTMLSelectElement;
sceneSel.innerHTML = SCENES.map((s, i) => `<option value="${i}">${s.name}</option>`).join('') + '<option value="-1">空白</option>';
sceneSel.addEventListener('change', () => setScene(+sceneSel.value));
function setScene(i: number) {
  snapshot();
  doc = i < 0 ? { elems: {}, nextId: 1 } : SCENES[i].build();
  selected = null;
  frameAll();
  rebuild();
}
const gridBtn = document.getElementById('grid')!;
const toggleGrid = () => { gridOn = !gridOn; gridBtn.classList.toggle('on', gridOn); setStatus(); };
gridBtn.addEventListener('click', toggleGrid);
const wireBtn = document.getElementById('wire')!;
wireBtn.addEventListener('click', () => { wireOn = !wireOn; wireBtn.classList.toggle('on', wireOn); rebuild(); });
const rotSel = () => { const e = selected !== null ? doc.elems[selected] : null; if (e) { snapshot(); rotateElem(e); rebuild(); } };
const delSel = () => { if (selected !== null) { snapshot(); delete doc.elems[selected]; selected = null; rebuild(); } };
document.getElementById('rot')!.addEventListener('click', rotSel);
document.getElementById('del')!.addEventListener('click', delSel);

window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).tagName === 'INPUT') return;
  const k = e.key.toLowerCase();
  if (k === 'v' && !vHeld) { vHeld = true; drawOverlay(); }
  if (k === 'g') toggleGrid();
  if (k === 'r') rotSel();
  if (k === 'delete' || k === 'backspace') delSel();
  if (k === 'f') frameAll();
  if (e.ctrlKey && k === 'z' && undo.length) { redo.push(JSON.stringify(doc)); doc = JSON.parse(undo.pop()!); rebuild(); }
  if (e.ctrlKey && k === 'y' && redo.length) { undo.push(JSON.stringify(doc)); doc = JSON.parse(redo.pop()!); rebuild(); }
});
window.addEventListener('keyup', (e) => { if (e.key.toLowerCase() === 'v') { vHeld = false; drawOverlay(); } });

function frameAll() {
  const es = Object.values(doc.elems);
  if (!es.length) return;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of es) { const f = footprint(e); x0 = Math.min(x0, f.x0); y0 = Math.min(y0, f.y0); x1 = Math.max(x1, f.x1); y1 = Math.max(y1, f.y1); }
  const c = new THREE.Vector3((x0 + x1) / 2, (y0 + y1) / 2, 0);
  const r = Math.max(x1 - x0, y1 - y0);
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
renderer.setAnimationLoop(() => { controls.update(); renderer.render(scene, camera); });

// 截图脚本用
(window as unknown as Record<string, unknown>).__proto = {
  setScene: (i: number) => { setScene(i); sceneSel.value = String(i); },
  view: (pos: number[], target: number[]) => { camera.position.set(pos[0], pos[1], pos[2]); controls.target.set(target[0], target[1], target[2]); controls.update(); },
  project: (p: number[]) => { const s = toScreen(new THREE.Vector3(p[0], p[1], p[2])); return { x: s.x, y: s.y }; },
  wire: (on: boolean) => { wireOn = on; wireBtn.classList.toggle('on', on); rebuild(); },
  get doc() { return doc; },
  set doc(d: Doc) { doc = d; rebuild(); },
};
