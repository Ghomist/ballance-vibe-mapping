// 路面求解：从一堆互相独立的 box / 素材件算出每个元素的网格。
//
// 1. 分层：同样式、同高度的平 box 归为一层（一层里的 box 合起来看作一整片路面）；每个斜 box 自成一层。
//    素材件（平凹转换）按接口样式加入它贴着的层。
// 2. 每层在「展开坐标」里算出被占的格子（坐标压缩 + 遮挡 + 重叠时 id 小的优先、素材件优先），
//    再求出整片路面的外沿（exp）、开口（open），斜坡两端和平路相接处不算外沿（折线）。
// 3. 外沿合并成「边」（run）。花纹的 v 坐标按边计：v = (s·沿边坐标 + o) / 5；
//    跨层首尾相接的边（斜坡和平路、穿过平凹转换的边）要求 v 连续，从平凹转换出发传播 s、o。
// 4. 每个点的花纹由它到外沿的切比雪夫距离 d 决定：u 随 d 线性变化，到 BAND 为止；凹路按 d 下沉。
//    这个距离场是分片线性的：先按每条边自己的转折线（端点、45° 线）切开，再在每块里按「谁最小」继续二分，
//    得到的每一小块上距离都是一个线性函数，顶点上算出的 UV、高度插值后是精确的。
//    每个 box 只在自己的格子里生成网格，但距离场看的是整片路面，所以接缝两边算出来的结果完全一致。
import type { MatName, MeshPart, V2, V3 } from '../geom/floor';
import {
  BAND, Box, DX, DY, Dir, Doc, EPS_TOUCH, Elem, FaceKind, Piece, SINK_DEPTH, Style,
  basePiece, boxTopAt, footprint, isSlope, opp, pieceFace, pieceLen, pieceStyles,
} from './types';

export interface ElemMeshOut { id: number; parts: Partial<Record<MatName, MeshPart>> }
/** 资产库模型（专属路块）：放在哪、转多少度 */
export interface AssetPart { name: string; pos: [number, number, number]; rotZ: number }
export interface Solved {
  meshes: Map<number, ElemMeshOut>;
  /** 机关 id → 它的专属路块模型 */
  bases: Map<number, AssetPart>;
  /** 自动生成的转换件（负数 id）→ 它嵌进去的那块路面 */
  owner: Map<number, number>;
}

const EPS = 1e-7;
const UP: V3 = [0, 0, 1];

// ---------------- 网格 ----------------

class MeshBuilder {
  parts: Partial<Record<MatName, MeshPart>> = {};
  tri(mat: MatName, p: V3[], uv: V2[], outward: V3) {
    const e1 = sub(p[1], p[0]), e2 = sub(p[2], p[0]);
    const n = cross(e1, e2);
    if (Math.hypot(...n) < 1e-12) return;
    if (dot(n, outward) < 0) { p = [p[0], p[2], p[1]]; uv = [uv[0], uv[2], uv[1]]; }
    const part = (this.parts[mat] ??= { pos: [], uv: [] });
    for (let i = 0; i < 3; i++) { part.pos.push(...p[i]); part.uv.push(...uv[i]); }
  }
  poly(mat: MatName, p: V3[], uv: V2[], outward: V3) {
    for (let i = 1; i + 1 < p.length; i++) this.tri(mat, [p[0], p[i], p[i + 1]], [uv[0], uv[i], uv[i + 1]], outward);
  }
}
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

// ---------------- 凸多边形 ----------------

type Poly = V2[];
/** 直线 nx·x + ny·y = d */
type Line = [number, number, number];

function splitPoly(poly: Poly, [nx, ny, d]: Line): [Poly, Poly] | null {
  const s = poly.map(([x, y]) => nx * x + ny * y - d);
  if (s.every((v) => v >= -1e-9) || s.every((v) => v <= 1e-9)) return null;
  const a: Poly = [], b: Poly = [];
  for (let i = 0; i < poly.length; i++) {
    const j = (i + 1) % poly.length;
    const p = poly[i], q = poly[j], sp = s[i], sq = s[j];
    if (sp >= -1e-9) a.push(p);
    if (sp <= 1e-9) b.push(p);
    if ((sp > 1e-9 && sq < -1e-9) || (sp < -1e-9 && sq > 1e-9)) {
      const t = sp / (sp - sq);
      const m: V2 = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      a.push(m); b.push(m);
    }
  }
  return area(a) > 1e-10 && area(b) > 1e-10 ? [a, b] : null;
}
function area(p: Poly) {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; s += p[i][0] * q[1] - q[0] * p[i][1]; }
  return Math.abs(s) / 2;
}
const centroid = (p: Poly): V2 => [p.reduce((s, q) => s + q[0], 0) / p.length, p.reduce((s, q) => s + q[1], 0) / p.length];

// ---------------- 层 ----------------

/** 外沿上的一段（展开坐标）：沿 ax 方向（0：沿 x，1：沿 y），位于 c 这条线上，从 a 到 b，朝外方向 n */
interface Edge { ax: 0 | 1; c: number; a: number; b: number; n: Dir; owner: number; kind: 'exp' | 'open' }

interface Run {
  id: number;
  layer: Layer;
  ax: 0 | 1; c: number; a: number; b: number; n: Dir;
  /** v = (s·沿边坐标 + o) / 5 */
  s: number; o: number; set: boolean;
  /** 两个端点处与它垂直相接的边（内角处的花纹沿用它） */
  adjA?: Run; adjB?: Run;
}

/** 折线：斜坡端面与另一层相接 */
interface Fold {
  other: Layer;
  /** 折线所在的轴（斜坡方向）和本层展开坐标里的位置 */
  ax: 0 | 1; line: number;
  /** 从本层指向另一层的方向 */
  n: Dir;
  /** 相接的横向区间 */
  q0: number; q1: number;
  /** 另一层的展开坐标 = 本层 + shift（沿 ax） */
  shift: number;
}

interface Layer {
  id: number;
  style: Style;
  slope?: Box;
  z: number;
  boxes: Box[];
  pieces: Piece[];
  /** 嵌在本层凹槽里的专属路块（顶面在槽底） */
  embedded: Set<number>;
  /** 展开坐标 ↔ 世界坐标 */
  dev: (x: number, y: number) => V2;
  world: (X: number, Y: number, depth: number) => V3;
  /** 被占的矩形（展开坐标）和占用者 */
  rects: { x0: number; y0: number; x1: number; y1: number; owner: number }[];
  edges: Edge[];
  runs: Run[];
  folds: Fold[];
}

let runSeq = 0;
/** 插进平台的路（"路:平台"）：重叠的部分由平台盖住，不按后放的优先 */
let inserted = new Set<string>();
/** 坡插进平台（"坡:平台"）：掏空平台，或者叠在平台上 */
let slopeOver = new Map<string, 'carve' | 'cover'>();

export function solve(doc: Doc): Solved {
  runSeq = 0;
  const bases = Object.values(doc.elems).flatMap((e) => (e.kind === 'obj' ? [basePiece(e)].filter((p): p is Piece => !!p) : []));
  const docElems = Object.values(doc.elems).filter((e) => e.kind !== 'obj');
  slopeOver = slopeOverlaps(docElems);
  const auto = autoTransitions(docElems);
  inserted = auto.inserted;
  const elems: Elem[] = [...docElems, ...bases, ...auto.pieces];
  const boxes = elems.filter((e): e is Box => e.kind === 'box');
  const pieces = elems.filter((e): e is Piece => e.kind === 'piece');
  const layers: Layer[] = [];

  // 平 box：按样式、高度分组
  const flats = boxes.filter((b) => !isSlope(b)).sort((a, b) => a.z - b.z);
  for (const st of ['normal', 'sink', 'ribbon'] as Style[]) {
    let cur: Box[] = [];
    const flush = () => { if (cur.length) layers.push(flatLayer(layers.length, st, cur)); cur = []; };
    for (const b of flats.filter((b) => b.style === st)) {
      if (cur.length && b.z - cur[0].z > EPS_TOUCH) flush();
      cur.push(b);
    }
    flush();
  }
  // 素材件加入它贴着 / 压着的、样式与接口相符的层；一个都没有时自成一层
  for (const p of pieces) {
    let joined = false;
    for (const L of layers) {
      if (L.slope) continue;
      // 变球器、风扇的底座顶面落在凹槽槽底：嵌进凹槽里，四边都和凹槽连成一体
      if (p.base && p.base.kind !== 'fence' && L.style !== 'normal' && Math.abs(L.z - SINK_DEPTH - p.z) <= EPS_TOUCH
        && L.boxes.some((b) => overlaps(footprint(b), footprint(p)))) { L.pieces.push(p); L.embedded.add(p.id); joined = true; continue; }
      if (!pieceStyles(p).includes(L.style) || Math.abs(L.z - p.z) > EPS_TOUCH) continue;
      if (L.boxes.some((b) => overlaps(footprint(b), footprint(p)) || pieceTouches(p, b, L.style))) { L.pieces.push(p); joined = true; }
    }
    if (!joined) { const L = flatLayer(layers.length, pieceStyles(p)[1], [], p.z); L.pieces.push(p); layers.push(L); }
  }
  for (const b of boxes.filter(isSlope)) layers.push(slopeLayer(layers.length, b));

  findFolds(layers);
  for (const L of layers) (L.slope ? buildSlopeCells : buildFlatCells)(L, elems);
  for (const L of layers) buildRuns(L);
  linkRuns(layers, pieces);

  const out = new Map<number, ElemMeshOut>();
  for (const L of layers) meshLayer(L, out);
  const baseParts = new Map<number, AssetPart>();
  for (const p of pieces) {
    if (p.base) baseParts.set(p.id, basePart(p, layers));
    else meshPiece(p, layers, out);
  }
  return { meshes: out, bases: baseParts, owner: auto.owner };
}

/**
 * 坡的一头插进平台（这一头和平台一样高、平台盖住坡在这一头外面的那一截）时，坡的坡度和长度都不变：
 *   高的一头插进去（carve）：坡在平台里那一截比平台低，平台在坡底下掏空，坡从槽里升上来，在坡顶接上平台；
 *   低的一头插进去（cover）：坡在平台里那一截比平台高，直接叠在平台上；坡底下的平台不画，但平台的花纹照旧（不因此多出边框）。
 */
function slopeOverlaps(elems: Elem[]): Map<string, 'carve' | 'cover'> {
  const out = new Map<string, 'carve' | 'cover'>();
  const flats = elems.filter((e): e is Box => e.kind === 'box' && !isSlope(e));
  for (const S of elems) {
    if (!isSlope(S)) continue;
    const fs = footprint(S), ax = S.slope.axis;
    for (const B of flats) {
      const fb = footprint(B);
      if (!overlaps(fs, fb)) continue;
      for (const hi of [false, true]) {
        const n = (hi ? ax : ax + 2) as Dir;
        const ze = hi ? S.z + S.slope.dz : S.z;
        if (Math.abs(ze - B.z) > EPS_TOUCH || !endContact(fs, n, fb)) continue;
        // 这一头是坡的最高处 → 坡在平台里的那一截比平台低 → 掏空
        const top = (hi && S.slope.dz > 0) || (!hi && S.slope.dz < 0);
        out.set(`${S.id}:${B.id}`, top ? 'carve' : 'cover');
      }
    }
  }
  return out;
}

/**
 * 坡的端面（矩形 f 在 d 方向的那条边）外面紧挨着矩形 g：g 贴着这条边，或者 g 从这条边往外还继续（坡头插在 g 里面）。
 * 返回横向的重叠区间。
 */
function endContact(f: ReturnType<typeof footprint>, d: Dir, g: ReturnType<typeof footprint>): [number, number] | null {
  const line = [f.x1, f.y1, f.x0, f.y0][d];
  const [g0, g1] = d % 2 === 0 ? [g.x0, g.x1] : [g.y0, g.y1];
  const covers = d < 2 ? g0 <= line + EPS_TOUCH && g1 > line + 0.01 : g1 >= line - EPS_TOUCH && g0 < line - 0.01;
  if (!covers) return null;
  const [a0, a1, b0, b1] = d % 2 === 0 ? [f.y0, f.y1, g.y0, g.y1] : [f.x0, f.x1, g.x0, g.x1];
  const q0 = Math.max(a0, b0), q1 = Math.min(a1, b1);
  return q1 - q0 > EPS_TOUCH ? [q0, q1] : null;
}

/**
 * 不同样式的路接到平台（或别的路的侧面）上时，在平台的边框带里自动嵌一个长 2.5 的转换件：
 *   凹路接平路平台：半宽平凹转换；凹路接细边框平台：窄转换；平路接凹槽 / 细边框平台：半块下沉坡。
 * 路可以刚好贴着平台，也可以一端插进平台里（插进去的那一截被平台盖住）。
 * 条件：路宽正好是 5、整个宽度都在平台侧面的范围里、平台那一侧比路宽、往里至少有 2.5。
 */
function autoTransitions(elems: Elem[]): { pieces: Piece[]; owner: Map<number, number>; inserted: Set<string> } {
  const flats = elems.filter((e): e is Box => e.kind === 'box' && !isSlope(e));
  const placed = elems.filter((e): e is Piece => e.kind === 'piece');
  const pieces: Piece[] = [];
  const owner = new Map<number, number>();
  const inserted = new Set<string>();
  for (const A of flats) for (const B of flats) {
    if (A === B || A.style === B.style || A.style === 'ribbon' || Math.abs(A.z - B.z) > EPS_TOUCH) continue;
    const type = A.style === 'sink' ? (B.style === 'normal' ? 'transition-half' : 'transition-narrow') : 'ramp';
    const fa = footprint(A), fb = footprint(B);
    for (const d of [0, 1, 2, 3] as Dir[]) {
      // 路沿 d 方向进入平台：平台在 d 的对面那条边（line）上接路
      const ax = d % 2;
      const [a0, a1, b0, b1] = ax === 0 ? [fa.x0, fa.x1, fb.x0, fb.x1] : [fa.y0, fa.y1, fb.y0, fb.y1];
      const [c0, c1, e0, e1] = ax === 0 ? [fa.y0, fa.y1, fb.y0, fb.y1] : [fa.x0, fa.x1, fb.x0, fb.x1];
      const pos = d < 2;
      const line = pos ? b0 : b1;
      // 路从外面伸到这条线（或越过它，但没穿过平台），路的另一端在平台外面
      const reaches = pos ? a0 < line - EPS_TOUCH && a1 >= line - EPS_TOUCH && a1 <= b1 + EPS_TOUCH
        : a1 > line + EPS_TOUCH && a0 <= line + EPS_TOUCH && a0 >= b0 - EPS_TOUCH;
      if (!reaches) continue;
      if (Math.abs(c1 - c0 - 5) > EPS_TOUCH || c0 < e0 - EPS_TOUCH || c1 > e1 + EPS_TOUCH || e1 - e0 < 5 + EPS_TOUCH || b1 - b0 < 2.5 - EPS_TOUCH) continue;
      const c = (c0 + c1) / 2;
      const along = line + (pos ? 1.25 : -1.25);
      const p: Piece = { id: -(pieces.length + 1), kind: 'piece', type, x: ax === 0 ? along : c, y: ax === 0 ? c : along, z: B.z, rot: d, inner: type === 'ramp' ? B.style : undefined };
      if (placed.some((x) => overlaps(footprint(x), footprint(p)))) continue; // 已经手动放了转换件
      pieces.push(p);
      owner.set(p.id, B.id);
      if (pos ? a1 > line + EPS_TOUCH : a0 < line - EPS_TOUCH) inserted.add(`${A.id}:${B.id}`);
    }
  }
  return { pieces, owner, inserted };
}

/** 素材件在某一层里每个面的接法（嵌进凹槽的底座四边都算嵌入面） */
const faceIn = (L: Layer, p: Piece, d: Dir): FaceKind => (L.embedded.has(p.id) ? { t: 'embed', style: L.style } : pieceFace(p, d));

const overlaps = (a: ReturnType<typeof footprint>, b: ReturnType<typeof footprint>) =>
  Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) > EPS_TOUCH && Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0) > EPS_TOUCH;

/** 素材件的某个面（接口 / 嵌入面，样式为 st）是否贴着 box 的侧面 */
function pieceTouches(p: Piece, b: Box, st: Style): boolean {
  const f = footprint(p), g = footprint(b);
  for (const d of [0, 1, 2, 3] as Dir[]) {
    const k = pieceFace(p, d);
    if (k.t === 'wall' || k.style !== st) continue;
    if (faceContact(f, d, g)) return true;
  }
  return false;
}

/** 矩形 f 在 d 方向的面贴着矩形 g（g 在外侧），返回横向重叠区间 */
function faceContact(f: ReturnType<typeof footprint>, d: Dir, g: ReturnType<typeof footprint>): [number, number] | null {
  const line = [f.x1, f.y1, f.x0, f.y0][d];
  const other = [g.x0, g.y0, g.x1, g.y1][d];
  if (Math.abs(line - other) > EPS_TOUCH) return null;
  const [a0, a1, b0, b1] = d % 2 === 0 ? [f.y0, f.y1, g.y0, g.y1] : [f.x0, f.x1, g.x0, g.x1];
  const q0 = Math.max(a0, b0), q1 = Math.min(a1, b1);
  return q1 - q0 > EPS_TOUCH ? [q0, q1] : null;
}

function flatLayer(id: number, style: Style, boxes: Box[], z0 = 0): Layer {
  const z = boxes.length ? boxes[0].z : z0;
  return {
    id, style, z, boxes, pieces: [], embedded: new Set(), rects: [], edges: [], runs: [], folds: [],
    dev: (x, y) => [x, y],
    world: (X, Y, depth) => [X, Y, z - depth],
  };
}

function slopeLayer(id: number, b: Box): Layer {
  const ax = b.slope!.axis;
  const len = ax === 0 ? b.sx : b.sy;
  const k = Math.hypot(len, b.slope!.dz) / len;
  const p0 = ax === 0 ? b.x : b.y;
  return {
    id, style: b.style, slope: b, z: b.z, boxes: [b], pieces: [], embedded: new Set(), rects: [], edges: [], runs: [], folds: [],
    dev: (x, y) => (ax === 0 ? [p0 + (x - p0) * k, y] : [x, p0 + (y - p0) * k]),
    world: (X, Y, depth) => {
      const [x, y] = ax === 0 ? [p0 + (X - p0) / k, Y] : [X, p0 + (Y - p0) / k];
      return [x, y, boxTopAt(b, x, y) - depth];
    },
  };
}

// ---------------- 折线（斜坡两端） ----------------

function findFolds(layers: Layer[]) {
  for (const S of layers) {
    if (!S.slope) continue;
    const b = S.slope, ax = b.slope!.axis;
    const fp = footprint(b);
    for (const hi of [false, true]) {
      const n = (hi ? ax : ax + 2) as Dir;
      const pe = hi ? (ax === 0 ? fp.x1 : fp.y1) : (ax === 0 ? fp.x0 : fp.y0);
      const ze = hi ? b.z + b.slope!.dz : b.z;
      const lineS = S.dev(ax === 0 ? pe : fp.x0, ax === 0 ? fp.y0 : pe)[ax];
      for (const L of layers) {
        if (L === S || L.style !== S.style) continue;
        if (L.slope) {
          // 斜坡接斜坡：同轴、对面的端面在同一条线上、高度一致
          const c = L.slope;
          if (c.slope!.axis !== ax) continue;
          const g = footprint(c);
          const pe2 = hi ? (ax === 0 ? g.x0 : g.y0) : (ax === 0 ? g.x1 : g.y1);
          const ze2 = hi ? c.z : c.z + c.slope!.dz;
          if (Math.abs(pe2 - pe) > EPS_TOUCH || Math.abs(ze2 - ze) > EPS_TOUCH) continue;
          const q = faceContact(fp, n, g);
          if (!q) continue;
          const lineL = L.dev(ax === 0 ? pe2 : g.x0, ax === 0 ? g.y0 : pe2)[ax];
          S.folds.push({ other: L, ax, line: lineS, n, q0: q[0], q1: q[1], shift: lineL - lineS });
          continue;
        }
        if (Math.abs(L.z - ze) > EPS_TOUCH) continue;
        for (const c of L.boxes) {
          const q = endContact(fp, n, footprint(c));
          if (!q) continue;
          S.folds.push({ other: L, ax, line: lineS, n, q0: q[0], q1: q[1], shift: pe - lineS });
          if (slopeOver.get(`${b.id}:${c.id}`) !== 'cover') L.folds.push({ other: S, ax, line: pe, n: opp(n), q0: q[0], q1: q[1], shift: lineS - pe });
        }
      }
    }
  }
}

// ---------------- 格子与外沿 ----------------

/** 把相差不到 EPS_TOUCH 的坐标并成一个 */
function clusterer(vals: number[]) {
  const s = [...vals].sort((a, b) => a - b);
  const reps: number[] = [];
  for (const v of s) if (!reps.length || v - reps[reps.length - 1] > EPS_TOUCH) reps.push(v);
  const snap = (v: number) => {
    let lo = 0, hi = reps.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (reps[m] <= v + EPS_TOUCH) lo = m; else hi = m - 1; }
    return Math.abs(reps[lo] - v) <= EPS_TOUCH ? reps[lo] : v;
  };
  return { reps, snap };
}

function buildFlatCells(L: Layer, elems: Elem[]) {
  const members = [...L.boxes, ...L.pieces];
  if (!members.length) return;
  const fps = new Map<number, ReturnType<typeof footprint>>();
  for (const e of members) fps.set(e.id, footprint(e));
  let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
  for (const f of fps.values()) { bx0 = Math.min(bx0, f.x0); by0 = Math.min(by0, f.y0); bx1 = Math.max(bx1, f.x1); by1 = Math.max(by1, f.y1); }
  const memberIds = new Set(members.map((e) => e.id));
  const occluders = elems.filter((e) => !memberIds.has(e.id) && overlaps(footprint(e), { x0: bx0, y0: by0, x1: bx1, y1: by1 }));
  const xs: number[] = [], ys: number[] = [];
  for (const e of [...members, ...occluders]) {
    const f = footprint(e);
    xs.push(clamp(f.x0, bx0, bx1), clamp(f.x1, bx0, bx1)); ys.push(clamp(f.y0, by0, by1), clamp(f.y1, by0, by1));
  }
  for (const f of L.folds) for (const v of [f.q0, f.q1]) (f.ax === 0 ? ys : xs).push(v);
  const cx = clusterer(xs), cy = clusterer(ys);
  const X = cx.reps, Y = cy.reps;
  const nx = X.length - 1, ny = Y.length - 1;
  const own = new Int32Array(Math.max(0, nx * ny));
  const virt = new Uint8Array(Math.max(0, nx * ny));
  const snapFp = (f: ReturnType<typeof footprint>) => ({ x0: cx.snap(f.x0), y0: cy.snap(f.y0), x1: cx.snap(f.x1), y1: cy.snap(f.y1) });
  const sfp = new Map<number, ReturnType<typeof footprint>>();
  for (const e of [...members, ...occluders]) sfp.set(e.id, snapFp(footprint(e)));
  const inside = (id: number, x: number, y: number) => { const f = sfp.get(id)!; return x > f.x0 && x < f.x1 && y > f.y0 && y < f.y1; };
  // 其它元素是否遮住这一格：穿过本层顶面的实体、同高度的素材件、同高度且后放的其它样式 box
  const occludedBy = (x: number, y: number, cand: number) => (o: Elem): boolean => {
    if (!inside(o.id, x, y)) return false;
    if (slopeOver.has(`${o.id}:${cand}`)) return true;
    const zt = o.kind === 'box' ? boxTopAt(o, x, y) : o.z;
    const zb = zt - (o.kind === 'box' ? o.depth : 5);
    if (zt > L.z + EPS_TOUCH && zb < L.z - EPS_TOUCH) return true;
    // 专属路块盖在路上：顶面和路面齐平或落在槽底的都算（专属路块优先）
    if (o.kind === 'piece' && o.base && zt <= L.z + EPS_TOUCH && zt >= L.z - SINK_DEPTH - EPS_TOUCH) return true;
    if (Math.abs(zt - L.z) <= EPS_TOUCH) {
      if (o.kind === 'piece') return true;
      if (inserted.has(`${o.id}:${cand}`)) return false;
      if (inserted.has(`${cand}:${o.id}`)) return true;
      return o.id > cand;
    }
    return false;
  };
  /** 0：没被遮；1：被遮住，边上露出外沿；2：被叠在上面的坡盖住，边上不算外沿 */
  const occluded = (x: number, y: number, cand: number): 0 | 1 | 2 => {
    const hit = occluders.filter(occludedBy(x, y, cand));
    if (!hit.length) return 0;
    return hit.every((o) => slopeOver.get(`${o.id}:${cand}`) === 'cover') ? 2 : 1;
  };
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const x = (X[i] + X[i + 1]) / 2, y = (Y[j] + Y[j + 1]) / 2;
    let o = 0;
    for (const p of L.pieces) if (inside(p.id, x, y)) { o = p.id; break; }
    if (!o) for (const b of L.boxes) if (inside(b.id, x, y) && (!o || b.id < o)) o = b.id;
    if (o && L.boxes.some((b) => b.id === o)) {
      const oc = occluded(x, y, o);
      if (oc) { if (oc === 2) virt[i * ny + j] = 1; o = 0; }
    }
    own[i * ny + j] = o;
  }
  const at = (i: number, j: number) => (i < 0 || j < 0 || i >= nx || j >= ny ? 0 : own[i * ny + j]);
  const isPiece = (id: number) => L.pieces.some((p) => p.id === id);
  const piece = (id: number) => L.pieces.find((p) => p.id === id)!;
  const box = (id: number) => L.boxes.find((b) => b.id === id);
  const units: Edge[] = [];
  for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
    const o = at(i, j);
    if (!o) continue;
    for (const d of [0, 1, 2, 3] as Dir[]) {
      const nb = at(i + DX[d], j + DY[d]);
      const ax: 0 | 1 = d % 2 === 0 ? 1 : 0;
      const c = d === 0 ? X[i + 1] : d === 2 ? X[i] : d === 1 ? Y[j + 1] : Y[j];
      const a = ax === 0 ? X[i] : Y[j], b = ax === 0 ? X[i + 1] : Y[j + 1];
      if (nb === o) continue;
      if (nb) {
        // 两格都被占：只有素材件和 box 之间、接法不匹配时才算外沿
        if (!isPiece(o) && !isPiece(nb)) continue;
        const pid = isPiece(o) ? o : nb;
        const face = faceIn(L, piece(pid), pid === o ? d : opp(d));
        if (face.t !== 'wall' && face.style === L.style) continue;
        units.push({ ax, c, a, b, n: d, owner: o, kind: 'exp' });
        continue;
      }
      const ni = i + DX[d], nj = j + DY[d];
      if (ni >= 0 && nj >= 0 && ni < nx && nj < ny && virt[ni * ny + nj]) continue; // 叠着坡的那一块：照旧算作路面内部
      const m = (a + b) / 2;
      if (L.folds.some((f) => f.n === d && Math.abs(f.line - c) < EPS_TOUCH && m > f.q0 && m < f.q1)) continue;
      const bx = box(o);
      const openSide = !!bx && !!((bx.open ?? 0) & (1 << d)) && Math.abs(c - [sfp.get(o)!.x1, sfp.get(o)!.y1, sfp.get(o)!.x0, sfp.get(o)!.y0][d]) < EPS;
      units.push({ ax, c, a, b, n: d, owner: o, kind: openSide ? 'open' : 'exp' });
    }
  }
  L.edges = mergeEdges(units, true);
  L.rects = mergeCells(X, Y, own, nx, ny);
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

/** 同一条线上首尾相接的小段并起来（byOwner：占用者不同的分开） */
function mergeEdges(units: Edge[], byOwner: boolean): Edge[] {
  const key = (e: Edge) => `${e.ax}|${e.c}|${e.n}|${e.kind}|${byOwner ? e.owner : ''}`;
  const groups = new Map<string, Edge[]>();
  for (const e of units) { const k = key(e); let g = groups.get(k); if (!g) groups.set(k, (g = [])); g.push(e); }
  const out: Edge[] = [];
  for (const g of groups.values()) {
    g.sort((p, q) => p.a - q.a);
    let cur = { ...g[0] };
    for (let i = 1; i < g.length; i++) {
      if (g[i].a <= cur.b + EPS) cur.b = Math.max(cur.b, g[i].b);
      else { out.push(cur); cur = { ...g[i] }; }
    }
    out.push(cur);
  }
  return out;
}

/** 占用格子合并成尽量大的矩形（先按行合并，再把上下相同的并起来） */
function mergeCells(X: number[], Y: number[], own: Int32Array, nx: number, ny: number) {
  const out: Layer['rects'] = [];
  const open = new Map<string, Layer['rects'][number]>();
  for (let j = 0; j < ny; j++) {
    const next = new Map<string, Layer['rects'][number]>();
    let i = 0;
    while (i < nx) {
      const o = own[i * ny + j];
      if (!o) { i++; continue; }
      let k = i;
      while (k + 1 < nx && own[(k + 1) * ny + j] === o) k++;
      const key = `${i},${k},${o}`;
      const prev = open.get(key);
      if (prev) { prev.y1 = Y[j + 1]; next.set(key, prev); open.delete(key); }
      else { const r = { x0: X[i], x1: X[k + 1], y0: Y[j], y1: Y[j + 1], owner: o }; out.push(r); next.set(key, r); }
      i = k + 1;
    }
    open.clear();
    for (const [k, v] of next) open.set(k, v);
  }
  return out;
}

function buildSlopeCells(L: Layer) {
  const b = L.slope!, ax = b.slope!.axis;
  const fp = footprint(b);
  const [X0, Y0] = L.dev(fp.x0, fp.y0), [X1, Y1] = L.dev(fp.x1, fp.y1);
  L.rects = [{ x0: X0, y0: Y0, x1: X1, y1: Y1, owner: b.id }];
  const units: Edge[] = [];
  const open = b.open ?? 0;
  for (const d of [0, 1, 2, 3] as Dir[]) {
    const eax: 0 | 1 = d % 2 === 0 ? 1 : 0;
    const c = [X1, Y1, X0, Y0][d];
    const a = eax === 0 ? X0 : Y0, e = eax === 0 ? X1 : Y1;
    const kind = open & (1 << d) ? 'open' : 'exp';
    if (d % 2 !== ax) { units.push({ ax: eax, c, a, b: e, n: d, owner: b.id, kind }); continue; }
    // 端面：扣掉和别的层相接的区间
    const cuts = L.folds.filter((f) => f.n === d).map((f) => [f.q0, f.q1] as [number, number]).sort((p, q) => p[0] - q[0]);
    let s = a;
    for (const [q0, q1] of cuts) {
      if (q0 > s + EPS) units.push({ ax: eax, c, a: s, b: q0, n: d, owner: b.id, kind });
      s = Math.max(s, q1);
    }
    if (e > s + EPS) units.push({ ax: eax, c, a: s, b: e, n: d, owner: b.id, kind });
  }
  L.edges = mergeEdges(units, true);
}

function buildRuns(L: Layer) {
  const merged = mergeEdges(L.edges.filter((e) => e.kind === 'exp').map((e) => ({ ...e, owner: 0 })), false);
  L.runs = merged.map((e) => ({ id: runSeq++, layer: L, ax: e.ax, c: e.c, a: e.a, b: e.b, n: e.n, s: 1, o: 0, set: false }));
  const ends = new Map<string, Run[]>();
  const k = (x: number, y: number) => `${Math.round(x * 1e4)},${Math.round(y * 1e4)}`;
  const pt = (r: Run, t: number): V2 => (r.ax === 0 ? [t, r.c] : [r.c, t]);
  for (const r of L.runs) for (const t of [r.a, r.b]) { const p = pt(r, t); const kk = k(p[0], p[1]); let g = ends.get(kk); if (!g) ends.set(kk, (g = [])); g.push(r); }
  for (const r of L.runs) {
    const find = (t: number) => { const p = pt(r, t); return ends.get(k(p[0], p[1]))?.find((q) => q.ax !== r.ax); };
    r.adjA = find(r.a); r.adjB = find(r.b);
  }
}

// ---------------- 花纹相位：让跨层首尾相接的边连续 ----------------

function linkRuns(layers: Layer[], pieces: Piece[]) {
  const runs = layers.flatMap((L) => L.runs);
  const world = (r: Run, t: number) => { const [X, Y] = r.ax === 0 ? [t, r.c] : [r.c, t]; return r.layer.world(X, Y, 0); };
  const ends = runs.map((r) => [world(r, r.a), world(r, r.b)] as const);
  const along = (r: Run, p: V3) => r.layer.dev(p[0], p[1])[r.ax];
  const links: { i: number; j: number; p: V3 }[] = [];
  for (let i = 0; i < runs.length; i++) for (let j = i + 1; j < runs.length; j++) {
    const r = runs[i], q = runs[j];
    if (r.layer === q.layer || r.ax !== q.ax || r.n !== q.n) continue;
    const [a0, a1] = ends[i], [b0, b1] = ends[j];
    const cr = 1 - r.ax; // 横向坐标的分量
    if (Math.abs(a0[cr] - b0[cr]) > EPS_TOUCH) continue;
    const lo = Math.max(Math.min(a0[r.ax], a1[r.ax]), Math.min(b0[r.ax], b1[r.ax]));
    const hi = Math.min(Math.max(a0[r.ax], a1[r.ax]), Math.max(b0[r.ax], b1[r.ax]));
    if (hi < lo - EPS_TOUCH) continue;
    const m = (lo + hi) / 2;
    const p: V3 = r.ax === 0 ? [m, a0[1], 0] : [a0[0], m, 0];
    const za = r.layer.world(...r.layer.dev(p[0], p[1]), 0)[2], zb = q.layer.world(...q.layer.dev(p[0], p[1]), 0)[2];
    if (Math.abs(za - zb) > EPS_TOUCH) continue;
    links.push({ i, j, p });
  }
  const adj = new Map<number, { j: number; p: V3 }[]>();
  for (const l of links) {
    (adj.get(l.i) ?? adj.set(l.i, []).get(l.i)!).push({ j: l.j, p: l.p });
    (adj.get(l.j) ?? adj.set(l.j, []).get(l.j)!).push({ j: l.i, p: l.p });
  }
  const idx = new Map(runs.map((r, i) => [r, i]));
  const flood = (start: number) => {
    const queue = [start];
    while (queue.length) {
      const i = queue.shift()!;
      const r = runs[i];
      for (const { j, p } of adj.get(i) ?? []) {
        const q = runs[j];
        if (q.set) continue;
        q.s = r.s;
        q.o = r.s * along(r, p) + r.o - q.s * along(q, p);
        q.set = true;
        queue.push(j);
      }
    }
  };
  // 先从平凹转换的侧边出发：转换件的贴图是固定的（凹槽一端 v=1，平路一端 v=0）
  for (const p of pieces) {
    if (p.base) continue;
    const f = footprint(p), ax: 0 | 1 = p.rot % 2 === 0 ? 0 : 1;
    const pf = p.rot === 0 ? f.x1 : p.rot === 2 ? f.x0 : p.rot === 1 ? f.y1 : f.y0; // 平路一端
    const ps = p.rot === 0 ? f.x0 : p.rot === 2 ? f.x1 : p.rot === 1 ? f.y0 : f.y1; // 凹槽一端
    const s = Math.sign(ps - pf);
    for (const r of runs) {
      if (r.set || r.ax !== ax || !r.layer.pieces.includes(p)) continue;
      const wallC = r.n === (ax === 0 ? 1 : 0) ? (ax === 0 ? f.y1 : f.x1) : r.n === (ax === 0 ? 3 : 2) ? (ax === 0 ? f.y0 : f.x0) : NaN;
      if (Math.abs(r.c - wallC) > EPS_TOUCH || r.a > Math.min(pf, ps) + EPS_TOUCH || r.b < Math.max(pf, ps) - EPS_TOUCH) continue;
      // 转换件：凹槽一端 v=1；半块下沉坡：接路的一端 v=0.5（都是 rot 对面那一端，v 朝这一端增大）
      const vE = p.type === 'ramp' ? 0.5 : 1;
      r.s = s; r.o = 5 * vE - s * ps; r.set = true;
      flood(idx.get(r)!);
    }
  }
  for (let i = 0; i < runs.length; i++) if (!runs[i].set) { runs[i].set = true; flood(i); }
}

// ---------------- 距离场与网格 ----------------

/** 参与距离场的一条外沿：t 是从本层展开坐标换到这条边所在层的平移 */
interface FSeg { r: Run; ax: 0 | 1; c: number; a: number; b: number; t: V2 }
/** 线性函数 ka·X + kb·Y + kc；meta 说明 v 怎么算 */
interface Lin { k: [number, number, number]; run: Run | null; vAx: 0 | 1; t: V2; clamp?: boolean }

const linVal = (l: Lin, p: V2) => l.k[0] * p[0] + l.k[1] * p[1] + l.k[2];

function fieldSegs(L: Layer): FSeg[] {
  const out: FSeg[] = L.runs.map((r) => ({ r, ax: r.ax, c: r.c, a: r.a, b: r.b, t: [0, 0] }));
  for (const f of L.folds) {
    // 另一层在折线另一侧 BAND 以内的外沿，平移到本层的展开坐标里
    const Y = f.other, pos = f.n === 0 || f.n === 1;
    const lineY = f.line + f.shift;
    const w0 = pos ? lineY : lineY - BAND, w1 = pos ? lineY + BAND : lineY;
    const t: V2 = f.ax === 0 ? [f.shift, 0] : [0, f.shift];
    for (const r of Y.runs) {
      if (r.ax === f.ax) {
        const a = Math.max(r.a, w0), b = Math.min(r.b, w1);
        if (b <= a + EPS || r.c < f.q0 - BAND || r.c > f.q1 + BAND) continue;
        out.push({ r, ax: r.ax, c: r.c, a: a - f.shift, b: b - f.shift, t });
      } else {
        if (r.c < w0 - EPS || r.c > w1 + EPS || r.b < f.q0 - BAND || r.a > f.q1 + BAND) continue;
        out.push({ r, ax: r.ax, c: r.c - f.shift, a: r.a, b: r.b, t });
      }
    }
  }
  return out;
}

/** 外沿 e 在本块（展开坐标）里的距离函数：先看块中心离边线近还是离端点更远 */
function segLin(e: FSeg, cen: V2): Lin {
  const p = cen[e.ax], q = cen[1 - e.ax];
  const s = q - e.c >= 0 ? 1 : -1;
  const perp = s * (q - e.c);
  const overA = e.a - p, overB = p - e.b;
  const k = (kp: number, kq: number, kc: number): [number, number, number] => (e.ax === 0 ? [kp, kq, kc] : [kq, kp, kc]);
  if (perp >= overA && perp >= overB) return { k: k(0, s, -s * e.c), run: e.r, vAx: e.ax, t: e.t };
  // 越过端点：这里属于内角，花纹沿着端点处垂直的那条边继续
  const atA = overA > overB;
  const adj = atA ? e.r.adjA : e.r.adjB;
  return { k: atA ? k(-1, 0, e.a) : k(1, 0, -e.b), run: adj ?? null, vAx: (1 - e.ax) as 0 | 1, t: e.t };
}

/** 外沿 e 的转折线：边线本身、两个端点处的垂线和 45° 线 */
function segLines(e: FSeg): Line[] {
  const L: Line[] = [];
  const P = (kp: number, kq: number, d: number): Line => (e.ax === 0 ? [kp, kq, d] : [kq, kp, d]);
  L.push(P(0, 1, e.c));
  for (const t of [e.a, e.b]) {
    L.push(P(1, 0, t));
    L.push(P(-1, 1, e.c - t)); // q - c = p - t
    L.push(P(1, 1, e.c + t));  // q - c = -(p - t)
  }
  return L;
}

function rectDist(r: { x0: number; y0: number; x1: number; y1: number }, e: FSeg) {
  const [sx0, sx1, sy0, sy1] = e.ax === 0 ? [e.a, e.b, e.c, e.c] : [e.c, e.c, e.a, e.b];
  const gx = Math.max(0, sx0 - r.x1, r.x0 - sx1), gy = Math.max(0, sy0 - r.y1, r.y0 - sy1);
  return Math.max(gx, gy);
}

const MAT: Record<Style, { band: MatName; uScale: number; sink: number }> = {
  normal: { band: 'FloorTopBorder', uScale: 0.5, sink: 0 },
  sink: { band: 'FloorTopProfil', uScale: 0.5, sink: SINK_DEPTH },
  ribbon: { band: 'FloorTopFlat', uScale: 1, sink: SINK_DEPTH },
};

function meshLayer(L: Layer, out: Map<number, ElemMeshOut>) {
  const segs = fieldSegs(L);
  const st = MAT[L.style];
  const builders = new Map<number, MeshBuilder>();
  const mb = (id: number) => { let m = builders.get(id); if (!m) builders.set(id, (m = new MeshBuilder())); return m; };
  const tops = new Map<number, V3[]>(); // 每个 box 顶面网格的顶点（展开坐标 + 下沉量），画开口端面用
  const isBox = (id: number) => L.boxes.some((b) => b.id === id);
  const vOf = (l: Lin, p: V2) => {
    const c = p[l.vAx] + l.t[l.vAx];
    return l.run ? (l.run.s * c + l.run.o) / 5 : c / 5;
  };

  for (const r of L.rects) {
    if (!isBox(r.owner)) continue;
    const near = segs.filter((e) => rectDist(r, e) <= BAND + 1e-9);
    let polys: Poly[] = [[[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]]];
    // 每条外沿的转折线只在它附近（BAND 以内）起作用：包围盒离得远的块不用切
    type BP = { p: Poly; x0: number; x1: number; y0: number; y1: number };
    const bp = (p: Poly): BP => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const q of p) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
      return { p, x0, x1, y0, y1 };
    };
    let bps: BP[] = polys.map(bp);
    for (const e of near) {
      const ix0 = (e.ax === 0 ? e.a : e.c) - BAND, ix1 = (e.ax === 0 ? e.b : e.c) + BAND;
      const iy0 = (e.ax === 0 ? e.c : e.a) - BAND, iy1 = (e.ax === 0 ? e.c : e.b) + BAND;
      for (const ln of segLines(e)) {
        const next: BP[] = [];
        for (const b of bps) {
          const s = b.x1 > ix0 && b.x0 < ix1 && b.y1 > iy0 && b.y0 < iy1 ? splitPoly(b.p, ln) : null;
          if (s) next.push(bp(s[0]), bp(s[1])); else next.push(b);
        }
        bps = next;
      }
    }
    polys = bps.map((b) => b.p);
    const boxes = new Map(bps.map((b) => [b.p, b]));
    const clampLin: Lin = { k: [0, 0, BAND], run: null, vAx: 0, t: [0, 0], clamp: true };
    const m = mb(r.owner);
    const tv = tops.get(r.owner) ?? (tops.set(r.owner, []), tops.get(r.owner)!);
    const emit = (poly: Poly, w: Lin) => {
      const pts: V3[] = [], uvs: V2[] = [];
      for (const p of poly) {
        const d = clamp(linVal(w, p), 0, BAND);
        const depth = (st.sink * d) / BAND;
        pts.push(L.world(p[0], p[1], depth));
        tv.push([p[0], p[1], depth]);
        uvs.push(w.clamp ? [p[0] / 5, p[1] / 5] : [(st.uScale * d) / BAND, vOf(w, p)]);
      }
      m.poly(w.clamp ? 'FloorTopBorderless' : st.band, pts, uvs, UP);
    };
    for (const poly of polys) {
      const cen = centroid(poly);
      // 只有离这一块不超过 BAND 的外沿可能成为最近的
      const b = boxes.get(poly)!;
      const cands = near.filter((e) => rectDist(b, e) <= BAND + 1e-9);
      resolve(poly, [clampLin, ...cands.map((e) => segLin(e, cen))], emit, 0);
    }
  }

  // 侧面：外沿是竖直的平面；开口按顶面实际的下沉画出凹槽截面
  for (const e of L.edges) {
    if (!isBox(e.owner)) continue;
    const b = L.boxes.find((x) => x.id === e.owner)!;
    const out3: V3 = [DX[e.n], DY[e.n], 0];
    const run = L.runs.find((r) => r.ax === e.ax && Math.abs(r.c - e.c) < EPS && r.n === e.n && r.a <= e.a + EPS && r.b >= e.b - EPS);
    const v = (t: number) => (run ? (run.s * t + run.o) / 5 : t / 5);
    const P = (t: number): V2 => (e.ax === 0 ? [t, e.c] : [e.c, t]);
    let ts: [number, number][] = [[e.a, 0], [e.b, 0]];
    if (e.kind === 'open') {
      const on = (tops.get(e.owner) ?? []).filter((p) => Math.abs(p[1 - e.ax] - e.c) < 1e-6 && p[e.ax] >= e.a - 1e-6 && p[e.ax] <= e.b + 1e-6);
      const byT = new Map<string, [number, number]>();
      for (const p of on) byT.set(p[e.ax].toFixed(6), [p[e.ax], p[2]]);
      ts = [...byT.values()].sort((p, q) => p[0] - q[0]);
    }
    for (let i = 0; i + 1 < ts.length; i++) {
      const [t0, d0] = ts[i], [t1, d1] = ts[i + 1];
      const A = L.world(...P(t0), d0), B = L.world(...P(t1), d1);
      const A0 = L.world(...P(t0), 0), B0 = L.world(...P(t1), 0);
      const Ab: V3 = [A[0], A[1], A0[2] - b.depth], Bb: V3 = [B[0], B[1], B0[2] - b.depth];
      mb(e.owner).poly('FloorSide', [A, B, Bb, Ab], [[d0 / 5, v(t0)], [d1 / 5, v(t1)], [b.depth / 5, v(t1)], [b.depth / 5, v(t0)]], out3);
    }
  }
  for (const [id, m] of builders) {
    const prev = out.get(id);
    if (!prev) { out.set(id, { id, parts: m.parts }); continue; }
    for (const [k, part] of Object.entries(m.parts) as [MatName, MeshPart][]) {
      const t = (prev.parts[k] ??= { pos: [], uv: [] });
      t.pos.push(...part.pos); t.uv.push(...part.uv);
    }
  }
}

/** 在凸多边形里找出处处最小的那个线性函数；没有就沿两个函数相等的线切开再找 */
function resolve(poly: Poly, lins: Lin[], emit: (p: Poly, w: Lin) => void, depth: number) {
  const vals = lins.map((l) => poly.map((p) => linVal(l, p)));
  const mins = poly.map((_, k) => Math.min(...vals.map((v) => v[k])));
  const w = lins.findIndex((_, i) => vals[i].every((v, k) => v <= mins[k] + 1e-7));
  if (w >= 0 || depth > 24) { emit(poly, lins[w >= 0 ? w : 0]); return; }
  const i0 = vals.findIndex((v) => v[0] <= mins[0] + 1e-7);
  const k = vals[i0].findIndex((v, kk) => v > mins[kk] + 1e-7);
  const i1 = vals.findIndex((v) => v[k] <= mins[k] + 1e-7);
  const a = lins[i0].k, b = lins[i1].k;
  const s = splitPoly(poly, [a[0] - b[0], a[1] - b[1], b[2] - a[2]]);
  if (!s) {
    // 两个函数在这块里不相交：较大的那个在这里永远不会是最小值，去掉它再找
    const drop = vals[i0].every((v, kk) => v >= vals[i1][kk] - 1e-9) ? i0 : i1;
    resolve(poly, lins.filter((_, i) => i !== drop), emit, depth + 1);
    return;
  }
  resolve(s[0], lins, emit, depth + 1);
  resolve(s[1], lins, emit, depth + 1);
}

// ---------------- 素材件 ----------------

function meshPiece(p: Piece, layers: Layer[], out: Map<number, ElemMeshOut>) {
  const mb = new MeshBuilder();
  const ramp = p.type === 'ramp';
  const sx = pieceLen(p) / 5;
  // 局部坐标沿用 BME：lx=0 是凹槽一侧，lx=5 是平路一侧（长 2.5 的件沿长度缩放 0.5，UV 不变）；ly 横跨路宽
  //   平凹转换：凹槽一侧是 rot 的对面；半块下沉坡：凹槽一侧是 rot 那一端（嵌进平台）
  const sd = ramp ? p.rot : opp(p.rot);
  const a: V2 = [-DX[sd], -DY[sd]];
  const q: V2 = [-a[1], a[0]];
  const L = (lx: number, ly: number, lz: number): V3 =>
    [p.x + a[0] * (lx - 2.5) * sx + q[0] * (ly - 2.5), p.y + a[1] * (lx - 2.5) * sx + q[1] * (ly - 2.5), p.z + lz];
  // 窄转换：平路一侧也下沉（贴着细边框平台下沉的内部）；下沉坡：凹槽一侧整条边下沉
  const fz = p.type === 'transition-narrow' ? -SINK_DEPTH : 0;
  const cz = ramp ? -SINK_DEPTH : 0;
  if (ramp) {
    for (const e0 of [0, 5]) {
      const E0 = L(0, e0, cz), E1 = L(5, e0, 0), M1 = L(5, 2.5, 0), M0 = L(0, 2.5, cz);
      mb.poly('FloorTopBorder', [E0, E1, M1, M0], [[0, 0], [0, 0.5], [0.5, 0.5], [0.5, 0]], UP);
    }
  } else {
    const v0 = L(0, 0, 0), v1 = L(5, 0, fz), v2 = L(0, 2.5, -SINK_DEPTH), v3 = L(5, 5, fz), v4 = L(0, 5, 0);
    mb.tri('FloorTopProfilFlat', [v0, v1, v2], [[0, 1], [0, 0], [0.5, 1]], UP);
    mb.tri('FloorTopProfilFlat', [v3, v2, v1], [[1, 0], [0.5, 1], [0, 0]], UP);
    mb.tri('FloorTopProfilFlat', [v2, v3, v4], [[0.5, 1], [1, 0], [1, 1]], UP);
  }
  for (const [ly, sg] of [[0, -1], [5, 1]] as const) {
    const A = L(0, ly, cz), B = L(5, ly, fz);
    const Ab: V3 = [A[0], A[1], A[2] - 5], Bb: V3 = [B[0], B[1], B[2] - 5];
    mb.poly('FloorSide', [A, B, Bb, Ab], [[0, 1], [0, 1 - sx], [1, 1 - sx], [1, 1]], [q[0] * sg, q[1] * sg, 0]);
  }
  // 接口没接上（没有同样式的路贴着或压着）时补端面
  const fp = footprint(p);
  for (const [d, lx] of [[sd, 0], [opp(sd), 5]] as const) {
    const face = pieceFace(p, d);
    if (face.t === 'wall') continue;
    const st = face.style;
    const joined = layers.some((Ly) => Ly.style === st && Math.abs(Ly.z - p.z) < EPS_TOUCH && Ly.boxes.some((b) => faceContact(fp, d, footprint(b)) || overlaps(fp, footprint(b))));
    if (joined) continue;
    const top = lx === 0 ? cz : fz;
    const notch = lx === 0 && !ramp ? SINK_DEPTH : 0;
    const Lc = L(lx, 0, top), M = L(lx, 2.5, top - notch), R = L(lx, 5, top);
    const outv: V3 = [DX[d], DY[d], 0];
    const bz = Lc[2] - 5;
    mb.poly('FloorSide', [Lc, M, [M[0], M[1], bz], [Lc[0], Lc[1], bz]], [[0, 0], [0, 0.5], [(5 - notch) / 5, 0.5], [1, 0]], outv);
    mb.poly('FloorSide', [M, R, [R[0], R[1], bz], [M[0], M[1], bz]], [[0, 0.5], [0, 1], [1, 1], [(5 - notch) / 5, 0.5]], outv);
  }
  out.set(p.id, { id: p.id, parts: mb.parts });
}

// ---------------- 专属路块 ----------------

/** 风扇底座的边框花纹：变体在资产本地坐标下有边框的方向 */
const FAN_VARIANTS: [string, Dir[]][] = [
  ['Ventilator_4Face', [0, 1, 2, 3]],
  ['Ventilator_3Edge', [0, 1, 2]],
  ['Ventilator_2Face_Opposite', [0, 2]],
  ['Ventilator_2Face_Adjacent', [0, 1]],
  ['Ventilator_1Edge', [0]],
  ['Ventilator_NoEdge_Border', []],
];

function basePart(p: Piece, layers: Layer[]): AssetPart {
  const z = p.z - 2.5; // 资产原点在方块中心
  const b = p.base!;
  if (b.kind === 'trafo') return { name: `TrafoBase_${b.mat ?? 'Wood'}`, pos: [p.x, p.y, z], rotZ: 0 };
  // Slider 的原点在第一格中心，本地 +Y 沿栅栏方向
  if (b.kind === 'fence') return { name: 'Slider', pos: [p.x, p.y, z], rotZ: p.rot * 90 - 90 };
  if (layers.some((L) => L.embedded.has(p.id))) return { name: 'Ventilator_NoEdge_Borderless', pos: [p.x, p.y, z], rotZ: 0 };
  // 风扇：没接路的边要有边框
  const fp = footprint(p);
  // 这一边接上了：有同层的路贴着这一边，或者路从底座下面穿过去、在这一边外面还继续
  const cx = (fp.x0 + fp.x1) / 2, cy = (fp.y0 + fp.y1) / 2;
  const outside = (d: Dir): [number, number] => [d === 0 ? fp.x1 + 0.01 : d === 2 ? fp.x0 - 0.01 : cx, d === 1 ? fp.y1 + 0.01 : d === 3 ? fp.y0 - 0.01 : cy];
  const joined = (d: Dir) => layers.some((L) => L.pieces.includes(p) && L.boxes.some((x) => {
    if (faceContact(fp, d, footprint(x))) return true;
    const f = footprint(x), [ox, oy] = outside(d);
    return overlaps(f, fp) && ox > f.x0 && ox < f.x1 && oy > f.y0 && oy < f.y1;
  }));
  const closed = new Set(([0, 1, 2, 3] as Dir[]).filter((d) => !joined(d)));
  for (const [name, borders] of FAN_VARIANTS) {
    if (borders.length !== closed.size) continue;
    for (let k = 0; k < 4; k++) if (borders.every((d) => closed.has(((d + k) % 4) as Dir))) return { name, pos: [p.x, p.y, z], rotZ: k * 90 };
  }
  return { name: 'Ventilator_4Face', pos: [p.x, p.y, z], rotZ: 0 };
}
