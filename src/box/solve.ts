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
import { type Edge as OEdge, type Loop, loopsFromEdges, push as pushEdge } from '../model/outline';
import {
  BAND, Box, DX, DY, Dir, Doc, EPS_TOUCH, Elem, FaceKind, Piece, SINK_DEPTH, Style,
  basePiece, boxTopAt, elemXf, footprint, isSlope, opp, pieceFace, pieceLen, pieceStyles,
} from './types';
import { type M3, apply, rotZ } from './xform';
import { ShapeUtils, Vector2 } from 'three';

export interface ElemMeshOut {
  id: number; parts: Partial<Record<MatName, MeshPart>>;
  /** 网格内容的签名：一样就说明网格没变，编辑器可以直接沿用上一次生成的 three.js 网格 */
  sig?: string;
}
/** 资产库模型（专属路块、盘点路面）或 BBP 占位符（火焰、重生点）：放在哪、转多少度 */
export interface AssetPart { name: string; kind: 'asset' | 'element'; pos: [number, number, number]; rotZ: number; objName?: string; /** 只留模型本地 x ∈ [x0, x1] 的部分（盘点路面裁掉自带的延伸路） */ crop?: [number, number, number, number][] }
export interface Solved {
  meshes: Map<number, ElemMeshOut>;
  /** 元素 id（机关或盘点）→ 它的模型：专属路块、盘点路面 + 火焰 + 重生点 */
  assets: Map<number, AssetPart[]>;
  /** 自动生成的转换件（负数 id）→ 它嵌进去的那块路面 */
  owner: Map<number, number>;
  /** 路面外沿连成的环（顶面高度，朝外在右手边）：护栏沿它走 */
  loops: Loop[];
}

const EPS = 1e-7;

/** 粗略的空间网格：按包围盒放进边长 CELL 的格子，查询时只看附近格子里的东西（避免大地图上两两比较） */
class Grid<T> {
  private cells = new Map<number, T[]>();
  constructor(private size = 10) {}
  /** 格子编号（坐标在 ±百万格以内） */
  private static key = (i: number, j: number) => (i + 1048576) * 2097152 + (j + 1048576);
  add(item: T, x0: number, y0: number, x1: number, y1: number) {
    const s = this.size;
    for (let i = Math.floor(x0 / s); i <= Math.floor(x1 / s); i++) for (let j = Math.floor(y0 / s); j <= Math.floor(y1 / s); j++) {
      const k = Grid.key(i, j);
      const l = this.cells.get(k);
      if (l) l.push(item); else this.cells.set(k, [item]);
    }
  }
  /** 和矩形范围相交的格子里的东西（可能有多余的，调用方再精确判断；不重复） */
  query(x0: number, y0: number, x1: number, y1: number): T[] {
    const s = this.size, i0 = Math.floor(x0 / s), i1 = Math.floor(x1 / s), j0 = Math.floor(y0 / s), j1 = Math.floor(y1 / s);
    if (i0 === i1 && j0 === j1) return this.cells.get(Grid.key(i0, j0)) ?? [];
    const out: T[] = [], seen = new Set<T>();
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      for (const it of this.cells.get(Grid.key(i, j)) ?? []) if (!seen.has(it)) { seen.add(it); out.push(it); }
    }
    return out;
  }
}
/** 当前朝向的路面、素材件的空间网格（frameCells 里建） */
let elemGrid = new Grid<Elem>(10);
const UP: V3 = [0, 0, 1];

// ---------------- 网格 ----------------

class MeshBuilder {
  parts: Partial<Record<MatName, MeshPart>> = {};
  /** own：这个三角形属于哪个元素（不填就不记） */
  tri(mat: MatName, p: V3[], uv: V2[], outward: V3, own?: number) {
    const e1 = sub(p[1], p[0]), e2 = sub(p[2], p[0]);
    const n = cross(e1, e2);
    if (Math.hypot(...n) < 1e-12) return;
    if (dot(n, outward) < 0) { p = [p[0], p[2], p[1]]; uv = [uv[0], uv[2], uv[1]]; }
    const part = (this.parts[mat] ??= { pos: [], uv: [] });
    for (let i = 0; i < 3; i++) { part.pos.push(...p[i]); part.uv.push(...uv[i]); }
    if (own !== undefined) (part.own ??= []).push(own);
  }
  poly(mat: MatName, p: V3[], uv: V2[], outward: V3, own?: number) {
    for (let i = 1; i + 1 < p.length; i++) this.tri(mat, [p[0], p[i], p[i + 1]], [uv[0], uv[i], uv[i + 1]], outward, own);
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
interface Edge { ax: 0 | 1; c: number; a: number; b: number; n: Dir; owner: number; kind: 'exp' | 'open'; /** 手动封口：别的路面贴着也是外沿 */ forced?: boolean }

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
  /** 只表示「这一段不是外沿」，不把另一层的外沿带进本层的距离场（坡接素材件的接口时，素材件所在层用这个） */
  noField?: boolean;
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
  /** 别的朝向里压在本层上的同样式、同高度的成员（见 crossCover） */
  foreign?: Foreign[];
  /** 别的朝向的外沿（见 crossField） */
  gsegs?: GSeg[];
}

let runSeq = 0;
/** 插进平台的路（"路:平台"）：重叠的部分由平台盖住，不按后放的优先 */
let inserted = new Set<string>();
/** 坡插进平台（"坡:平台"）：掏空平台，或者叠在平台上 */
let slopeOver = new Map<string, 'carve' | 'cover'>();
/** 调试开关：merge 关掉时不合并小块（用来对比合并前后的结果） */
export const solveOpts = { merge: true };
/**
 * 网格缓存：每片连通的路面按「它的网格依赖的所有东西」生成签名，签名没变就直接用上一次的网格。
 * 拖动一块路面时只有它附近的几片要重新切分、三角化（这是求解里最花时间的部分）。每次求解后只留下这次用到的。
 */
let meshCache = new Map<string, ElemMeshOut>();
let nextMeshCache = new Map<string, ElemMeshOut>();
/** 清空网格缓存（测试用：对比用缓存和不用缓存的结果） */
export function clearSolveCache() { meshCache = new Map(); }
/** 上一次求解里网格缓存命中 / 没命中的片数（调试用） */
export const solveStats = { hit: 0, miss: 0 };
/** 自动生成的转换件的编号（负数，整张图唯一） */
let autoSeq = 0;

/**
 * 整张图：按朝向分组，同一朝向（绕 Z 的角度相同）的路面、素材件、机关在它们自己的坐标系里求解，再转回世界坐标。
 * 不同朝向、同样式、同高度的平路面之间也一起解算（见 crossFrames）：重叠处互相挖掉、落在对方里面的外沿不算外沿、
 * 对方的外沿进入自己的距离场，所以接缝两边花纹连续。倾斜（绕 X / Y 转过）的路面各自单独生成，不和别的路面一起求解。
 */
export function solve(doc: Doc): Solved {
  runSeq = 0;
  autoSeq = 0;
  nextMeshCache = new Map();
  solveStats.hit = solveStats.miss = 0;
  try { return solveAll(doc); } finally { meshCache = nextMeshCache; }
}

function solveAll(doc: Doc): Solved {
  const out: Solved = { meshes: new Map(), assets: new Map(), owner: new Map(), loops: [] };
  const frames = new Map<number, Elem[]>();
  const tilted: Box[] = [];
  for (const e of Object.values(doc.elems)) {
    if (e.kind !== 'box' && e.kind !== 'piece' && e.kind !== 'obj') continue;
    if (e.q) { if (e.kind === 'box') tilted.push(e); continue; }
    const k = e.ang ?? 0;
    let l = frames.get(k);
    if (!l) frames.set(k, (l = []));
    l.push(e);
  }
  const ctxs = [...frames].map(([ang, es]) => frameCells(es, ang));
  crossCover(ctxs);
  for (const c of ctxs) frameRuns(c);
  crossField(ctxs);
  // 外沿：各个朝向的边都换到世界坐标后一起连成环（不同朝向的路面接在一起时，外沿也连成一个环）
  // 只有护栏工具要用它，所以用到时才算（拖动路面时不用算）
  const edgeFns: (() => OEdge[])[] = [];
  for (const c of ctxs) {
    const r = frameMesh(c);
    const m = c.ang ? rotZ(c.ang) : null;
    mergeSolved(out, r, m, [0, 0, 0], c.ang);
    edgeFns.push(() => r.edges().map((e) => (m ? { a: apply(m, e.a), b: apply(m, e.b), out: apply(m, [...e.out, 0]).slice(0, 2) as [number, number] } : e)));
  }
  let loops: Loop[] | null = null;
  Object.defineProperty(out, 'loops', { get: () => (loops ??= loopsFromEdges(edgeFns.flatMap((f) => f()))), enumerable: true, configurable: true });
  for (const b of tilted) {
    const { m, t } = elemXf(b);
    const c = frameCells([{ ...b, q: undefined }], 0);
    frameRuns(c);
    mergeSolved(out, frameMesh(c), m, t, 0);
  }
  return out;
}

// ---------------- 不同朝向之间 ----------------

/** 一个朝向的求解上下文 */
interface FrameCtx { ang: number; elems: Elem[]; pieces: Piece[]; layers: Layer[]; owner: Map<number, number> }

/** 别的朝向里同样式、同高度的平路面成员（换到本层坐标里的凸四边形） */
interface Foreign { poly: V2[]; id: number; piece: boolean; x0: number; y0: number; x1: number; y1: number }

/** 朝向 from 的坐标 → 朝向 to 的坐标（绕 Z 转 from − to） */
function frameMap(from: number, to: number): (p: V2) => V2 {
  const a = ((from - to) * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  return ([x, y]) => [c * x - s * y, s * x + c * y];
}
/** 两个平层能不能一起解算：都不是坡、样式相同、一样高、朝向不同 */
const partners = (A: FrameCtx, L: Layer, B: FrameCtx, M: Layer) => A !== B && !L.slope && !M.slope && L.style === M.style && Math.abs(L.z - M.z) <= EPS_TOUCH;

/** 成员的矩形（本朝向坐标）的四个角 */
const rectPoly = (f: { x0: number; y0: number; x1: number; y1: number }): V2[] => [[f.x0, f.y0], [f.x1, f.y0], [f.x1, f.y1], [f.x0, f.y1]];

/**
 * 第一步（格子算完、外沿还没并成边之前）：记下别的朝向里压在本层上的成员（画网格时挖掉输的那部分），
 * 并把本层落在它们里面的外沿去掉（那里路面还连着，不是外沿）。
 */
function crossCover(ctxs: FrameCtx[]) {
  for (const A of ctxs) for (const L of A.layers) {
    if (L.slope || !L.edges.length) continue;
    const bx = L.rects.reduce((b, r) => ({ x0: Math.min(b.x0, r.x0), y0: Math.min(b.y0, r.y0), x1: Math.max(b.x1, r.x1), y1: Math.max(b.y1, r.y1) }), { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
    const fs: Foreign[] = [];
    for (const B of ctxs) for (const M of B.layers) {
      if (!partners(A, L, B, M)) continue;
      const map = frameMap(B.ang, A.ang);
      for (const m of [...M.boxes, ...M.pieces]) {
        if (M.embedded.has(m.id)) continue;
        const poly = rectPoly(footprint(m)).map(map);
        const f: Foreign = { poly, id: m.id, piece: m.kind === 'piece', x0: Math.min(...poly.map((p) => p[0])), y0: Math.min(...poly.map((p) => p[1])), x1: Math.max(...poly.map((p) => p[0])), y1: Math.max(...poly.map((p) => p[1])) };
        if (f.x1 < bx.x0 - EPS || f.x0 > bx.x1 + EPS || f.y1 < bx.y0 - EPS || f.y0 > bx.y1 + EPS) continue;
        fs.push(f);
      }
    }
    if (!fs.length) continue;
    L.foreign = fs;
    // 外沿落在别的朝向的成员里面的部分去掉
    const next: Edge[] = [];
    for (const e of L.edges) {
      if (e.forced) { next.push(e); continue; }
      const P = (t: number): V2 => (e.ax === 0 ? [t, e.c] : [e.c, t]);
      let keep: [number, number][] = [[e.a, e.b]];
      for (const f of fs) {
        const cut = clipSeg(P(e.a), P(e.b), f.poly);
        if (!cut) continue;
        const c0 = e.a + (e.b - e.a) * cut[0], c1 = e.a + (e.b - e.a) * cut[1];
        keep = keep.flatMap(([u, v]) => [[u, Math.min(v, c0)], [Math.max(u, c1), v]] as [number, number][]).filter(([u, v]) => v - u > 1e-6);
      }
      for (const [u, v] of keep) next.push({ ...e, a: u, b: v });
    }
    L.edges = next;
  }
}

/** 线段 p→q 落在凸多边形内部的参数区间（Cyrus–Beck）；只擦到边界或在外面时返回 null */
function clipSeg(p: V2, q: V2, poly: V2[]): [number, number] | null {
  let t0 = 0, t1 = 1;
  const d: V2 = [q[0] - p[0], q[1] - p[1]];
  // 多边形的绕向：按面积符号定内侧
  let ar = 0;
  for (let i = 0; i < poly.length; i++) { const a = poly[i], b = poly[(i + 1) % poly.length]; ar += a[0] * b[1] - b[0] * a[1]; }
  const sg = ar > 0 ? 1 : -1;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    // 内侧法线
    const n: V2 = [-(b[1] - a[1]) * sg, (b[0] - a[0]) * sg];
    const den = n[0] * d[0] + n[1] * d[1];
    const num = n[0] * (p[0] - a[0]) + n[1] * (p[1] - a[1]);
    if (Math.abs(den) < 1e-12) { if (num <= 1e-9) return null; continue; }
    const t = -num / den;
    if (den > 0) t0 = Math.max(t0, t); else t1 = Math.min(t1, t);
    if (t1 - t0 <= 1e-9) return null;
  }
  return [t0, t1];
}

/** 点是否严格在凸多边形内部 */
function insidePoly(p: V2, poly: V2[]): boolean {
  let pos = 0, neg = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const c = (b[0] - a[0]) * (p[1] - a[1]) - (b[1] - a[1]) * (p[0] - a[0]);
    if (c > 1e-9) pos++; else if (c < -1e-9) neg++; else return false;
  }
  return pos === 0 || neg === 0;
}

/** 别的朝向里的一条外沿（换到本层坐标）：p0 → p1，v 按它自己那一层的花纹相位算（换成本层坐标里的线性函数） */
interface GSeg { p0: V2; t: V2; len: number; v: Line; vA: Line; vB: Line; /** 朝路面里面的单位法线 */ nIn: V2 }

/** 第二步（外沿并成边、相位定好以后）：把别的朝向里同样式、同高度的平层的外沿加进本层的距离场 */
function crossField(ctxs: FrameCtx[]) {
  for (const A of ctxs) for (const L of A.layers) {
    if (L.slope || !L.rects.length) continue;
    const segs: GSeg[] = [];
    for (const B of ctxs) for (const M of B.layers) {
      if (!partners(A, L, B, M)) continue;
      const map = frameMap(B.ang, A.ang);
      // 本层坐标 → M 的坐标：M 里沿 ax 的坐标 = 本层坐标的线性函数
      const back = frameMap(A.ang, B.ang);
      const o = back([0, 0]), ex = back([1, 0]), ey = back([0, 1]);
      const coord = (ax: 0 | 1): Line => [ex[ax] - o[ax], ey[ax] - o[ax], o[ax]];
      const vOfRun = (r: Run | undefined, ax: 0 | 1): Line => {
        const k = coord(ax);
        return r ? [r.s * k[0], r.s * k[1], r.s * k[2] + r.o] : k;
      };
      for (const r of M.runs) {
        const P = (t: number): V2 => map(r.ax === 0 ? [t, r.c] : [r.c, t]);
        const p0 = P(r.a), p1 = P(r.b);
        const len = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
        if (len < 1e-9) continue;
        const adj = (q: Run | undefined): Line => (q ? vOfRun(q, q.ax) : vOfRun(undefined, (1 - r.ax) as 0 | 1));
        const o0 = map([0, 0]), ni = map([-DX[r.n], -DY[r.n]]);
        segs.push({ p0, t: [(p1[0] - p0[0]) / len, (p1[1] - p0[1]) / len], len, v: vOfRun(r, r.ax), vA: adj(r.adjA), vB: adj(r.adjB), nIn: [ni[0] - o0[0], ni[1] - o0[1]] });
      }
    }
    if (segs.length) L.gsegs = segs;
  }
}

/** 别的朝向的外沿在本块（中心 cen）里的距离函数：和 segLin 一样，只是边的方向任意 */
function gsegLin(g: GSeg, cen: V2): Lin {
  const n: V2 = [-g.t[1], g.t[0]];
  const d0 = n[0] * g.p0[0] + n[1] * g.p0[1], a0 = g.t[0] * g.p0[0] + g.t[1] * g.p0[1];
  const q = n[0] * cen[0] + n[1] * cen[1] - d0, along = g.t[0] * cen[0] + g.t[1] * cen[1] - a0;
  const s = q >= 0 ? 1 : -1;
  const perp = s * q, overA = -along, overB = along - g.len;
  if (perp >= overA && perp >= overB) return { k: [s * n[0], s * n[1], -s * d0], run: null, vAx: 0, t: [0, 0], v: g.v };
  return overA > overB
    ? { k: [-g.t[0], -g.t[1], a0], run: null, vAx: 0, t: [0, 0], v: g.vA }
    : { k: [g.t[0], g.t[1], -a0 - g.len], run: null, vAx: 0, t: [0, 0], v: g.vB };
}
/** 别的朝向的外沿的转折线：边线、两个端点处的垂线和两条 45° 线 */
function gsegLines(g: GSeg): Line[] {
  const n: V2 = [-g.t[1], g.t[0]];
  const out: Line[] = [[n[0], n[1], n[0] * g.p0[0] + n[1] * g.p0[1]]];
  for (const e of [g.p0, [g.p0[0] + g.t[0] * g.len, g.p0[1] + g.t[1] * g.len] as V2]) {
    out.push([g.t[0], g.t[1], g.t[0] * e[0] + g.t[1] * e[1]]);
    const u: V2 = [n[0] - g.t[0], n[1] - g.t[1]], w: V2 = [n[0] + g.t[0], n[1] + g.t[1]];
    out.push([u[0], u[1], u[0] * e[0] + u[1] * e[1]], [w[0], w[1], w[0] * e[0] + w[1] * e[1]]);
  }
  return out;
}
/** 矩形到任意方向线段的距离（欧氏，作为切比雪夫距离的上界筛选用：切比雪夫 ≥ 欧氏 / √2） */
function gsegDist(r: { x0: number; y0: number; x1: number; y1: number }, g: GSeg): number {
  const p1: V2 = [g.p0[0] + g.t[0] * g.len, g.p0[1] + g.t[1] * g.len];
  if (clipSeg(g.p0, p1, rectPoly(r)) || insidePoly(g.p0, rectPoly(r))) return 0;
  const ptRect = (p: V2) => Math.hypot(Math.max(0, r.x0 - p[0], p[0] - r.x1), Math.max(0, r.y0 - p[1], p[1] - r.y1));
  const ptSeg = (p: V2) => { const t = clamp((p[0] - g.p0[0]) * g.t[0] + (p[1] - g.p0[1]) * g.t[1], 0, g.len); return Math.hypot(p[0] - g.p0[0] - g.t[0] * t, p[1] - g.p0[1] - g.t[1] * t); };
  return Math.min(ptRect(g.p0), ptRect(p1), ...rectPoly(r).map(ptSeg));
}

/** 把一个朝向坐标系里的求解结果转到世界坐标，合并进 out */
function mergeSolved(out: Solved, r: Omit<Solved, 'loops'>, m: M3 | null, t: V3, yaw: number) {
  const tp = (p: V3): V3 => { if (!m) return p; const w = apply(m, p); return [w[0] + t[0], w[1] + t[1], w[2] + t[2]]; };
  for (const [id, mesh] of r.meshes) {
    if (!m) { out.meshes.set(id, mesh); continue; }
    // 转到世界坐标：写到新的数组里（网格可能是缓存里的，不能改）
    const parts: ElemMeshOut['parts'] = {};
    for (const [k, part] of Object.entries(mesh.parts) as [MatName, MeshPart][]) {
      const src = part.pos, pos = new Array<number>(src.length);
      for (let i = 0; i < src.length; i += 3) { const w = tp([src[i], src[i + 1], src[i + 2]]); pos[i] = w[0]; pos[i + 1] = w[1]; pos[i + 2] = w[2]; }
      parts[k] = { ...part, pos };
    }
    out.meshes.set(id, { id, parts, sig: mesh.sig && `${mesh.sig}@${JSON.stringify([m, t])}` });
  }
  for (const [id, parts] of r.assets) out.assets.set(id, m ? parts.map((p) => ({ ...p, pos: tp(p.pos), rotZ: p.rotZ + yaw })) : parts);
  for (const [k, v] of r.owner) out.owner.set(k, v);
}

/** 一个朝向：分层、折线、格子与外沿（到合并外沿之前） */
function frameCells(all: Elem[], ang: number): FrameCtx {
  const bases = all.flatMap((e) => (e.kind === 'obj' ? [basePiece(e)].filter((p): p is Piece => !!p) : []));
  const docElems = all.filter((e) => e.kind === 'box' || e.kind === 'piece');
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
  // 同样式、同高度的层再按连通块拆开（路面、素材件贴着 / 压着才算连着）：不连着的两片互不影响
  //（一片里任何一点到自己外沿的距离都不会比到别的片的外沿远），拆开后每层的格子网格只覆盖自己那一片，大地图上快很多
  const split: Layer[] = [];
  for (const L of layers) {
    const ms: (Box | Piece)[] = [...L.boxes, ...L.pieces];
    if (ms.length <= 1) { split.push(L); continue; }
    const fps = ms.map((m) => footprint(m));
    const par = ms.map((_, i) => i);
    const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i])));
    const g = new Grid<number>(10);
    fps.forEach((f, i) => g.add(i, f.x0, f.y0, f.x1, f.y1));
    fps.forEach((a, i) => {
      for (const j of g.query(a.x0 - EPS_TOUCH, a.y0 - EPS_TOUCH, a.x1 + EPS_TOUCH, a.y1 + EPS_TOUCH)) {
        if (j <= i) continue;
        const b = fps[j];
        const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
        if (ox >= -EPS_TOUCH && oy >= -EPS_TOUCH && Math.max(ox, oy) > EPS_TOUCH) par[find(i)] = find(j);
      }
    });
    const groups = new Map<number, number[]>();
    ms.forEach((_, i) => { const k = find(i); (groups.get(k) ?? groups.set(k, []).get(k)!).push(i); });
    if (groups.size === 1) { split.push(L); continue; }
    for (const idx of groups.values()) {
      const bs = idx.map((i) => ms[i]).filter((m): m is Box => m.kind === 'box');
      const ps = idx.map((i) => ms[i]).filter((m): m is Piece => m.kind === 'piece');
      const C = flatLayer(0, L.style, bs, L.z);
      C.pieces = ps;
      for (const p of ps) if (L.embedded.has(p.id)) C.embedded.add(p.id);
      split.push(C);
    }
  }
  layers.length = 0;
  for (const L of split) { L.id = layers.length; layers.push(L); }
  for (const b of boxes.filter(isSlope)) layers.push(slopeLayer(layers.length, b));

  // 所有路面、素材件按位置放进网格：找挡住某一层的东西时只看附近的
  elemGrid = new Grid<Elem>(10);
  for (const e of elems) { const f = footprint(e); elemGrid.add(e, f.x0, f.y0, f.x1, f.y1); }
  findFolds(layers);
  for (const L of layers) (L.slope ? buildSlopeCells : buildFlatCells)(L, elems);
  return { ang, elems, pieces, layers, owner: auto.owner };
}

/** 一个朝向：外沿并成边、定花纹相位 */
function frameRuns(c: FrameCtx) {
  for (const L of c.layers) buildRuns(L);
  linkRuns(c.layers, c.pieces);
}

/** 一个朝向：网格、资产、护栏用的外沿（本朝向坐标） */
function frameMesh({ elems, pieces, layers, owner }: FrameCtx): Omit<Solved, 'loops'> & { edges: () => OEdge[] } {
  const out = new Map<number, ElemMeshOut>();
  for (const L of layers) meshLayer(L, out);
  const assets = new Map<number, AssetPart[]>();
  const checks = pieces.filter((p) => p.type === 'check').sort((a, b) => a.id - b.id);
  for (const p of pieces) {
    if (p.base) assets.set(p.id, [basePart(p, layers)]);
    else if (p.type === 'start' || p.type === 'check') assets.set(p.id, checkpointParts(p, layers, p.sector ?? checks.indexOf(p) + 2));
    else meshPiece(p, layers, out);
  }
  return { meshes: out, assets, owner, edges: () => outlineEdges(elems, pieces, layers) };
}

/** 护栏用的外沿：每层的边（展开坐标）换回世界坐标，跨层（坡和平路）首尾相接的自然连成一个环 */
function outlineEdges(elems: Elem[], pieces: Piece[], layers: Layer[]): OEdge[] {
  const oedges: OEdge[] = [];
  // 盘点路面的侧边不算（实际的模型是圆盘，比 5 宽的带子大）：外沿在盘点处断开，护栏不会穿过盘点
  const cp = new Set(pieces.filter((p) => p.type === 'start' || p.type === 'check').map((p) => p.id));
  // 外面紧挨着差不多一样高的路面（样式不同、坡插进平台留下的槽口、底座…）的边也不算：那里球还能滚过去，不该放护栏
  const floors = elems.filter((e): e is Box | Piece => e.kind === 'box' || e.kind === 'piece');
  const floorGrid = new Grid<{ f: Box | Piece; fp: ReturnType<typeof footprint> }>(10);
  for (const f of floors) { const fp = footprint(f); floorGrid.add({ f, fp }, fp.x0, fp.y0, fp.x1, fp.y1); }
  const continues = (x: number, y: number, z: number) => floorGrid.query(x, y, x, y).some(({ f, fp }) => {
    if (x <= fp.x0 || x >= fp.x1 || y <= fp.y0 || y >= fp.y1) return false;
    const top = f.kind === 'box' ? boxTopAt(f, x, y) : f.z;
    return Math.abs(top - z) < 1;
  });
  for (const L of layers) for (const r of L.edges) {
    if (r.kind !== 'exp' || cp.has(r.owner)) continue;
    const P = (t: number) => L.world(...((r.ax === 0 ? [t, r.c] : [r.c, t]) as [number, number]), 0) as [number, number, number];
    // 按 1 的步长切开，逐小段看外面是不是还有路面
    const n = Math.max(1, Math.ceil(r.b - r.a));
    // 连续的几小段外面都没有路面：并成一条（坡上的边是直线，并起来不变形）
    let runStart: number | null = null;
    const flush = (tEnd: number) => { if (runStart !== null) pushEdge(oedges, P(runStart), P(tEnd), [DX[r.n], DY[r.n]]); runStart = null; };
    for (let k = 0; k < n; k++) {
      const t0 = r.a + ((r.b - r.a) * k) / n, t1 = r.a + ((r.b - r.a) * (k + 1)) / n;
      const A = P(t0), B = P(t1);
      const mx = (A[0] + B[0]) / 2 + DX[r.n] * 0.05, my = (A[1] + B[1]) / 2 + DY[r.n] * 0.05;
      if (continues(mx, my, (A[2] + B[2]) / 2)) { flush(t0); continue; }
      if (runStart === null) runStart = t0;
    }
    flush(r.b);
  }
  return oedges;
}

/**
 * 坡的一头插进平台（这一头和平台一样高、平台盖住坡在这一头外面的那一截）时，坡的坡度和长度都不变：
 *   高的一头插进去（carve）：坡在平台里那一截比平台低，平台在坡底下掏空，坡从槽里升上来，在坡顶接上平台；
 *   低的一头插进去（cover）：坡在平台里那一截比平台高，直接叠在平台上；坡底下的平台不画，但平台的花纹照旧（不因此多出边框）。
 */
function slopeOverlaps(elems: Elem[]): Map<string, 'carve' | 'cover'> {
  const out = new Map<string, 'carve' | 'cover'>();
  const flats = elems.filter((e): e is Box => e.kind === 'box' && !isSlope(e));
  const fg = new Grid<Box>(10);
  for (const B of flats) { const f = footprint(B); fg.add(B, f.x0, f.y0, f.x1, f.y1); }
  for (const S of elems) {
    if (!isSlope(S)) continue;
    const fs = footprint(S), ax = S.slope.axis;
    for (const B of fg.query(fs.x0, fs.y0, fs.x1, fs.y1)) {
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
  const roads = elems.filter((e): e is Box => e.kind === 'box');
  const placed = elems.filter((e): e is Piece => e.kind === 'piece');
  const pieces: Piece[] = [];
  const owner = new Map<number, number>();
  const inserted = new Set<string>();
  const fg = new Grid<Box>(10);
  for (const B of flats) { const f = footprint(B); fg.add(B, f.x0, f.y0, f.x1, f.y1); }
  for (const A of roads) for (const B of (() => { const f = footprint(A); return fg.query(f.x0 - EPS_TOUCH, f.y0 - EPS_TOUCH, f.x1 + EPS_TOUCH, f.y1 + EPS_TOUCH); })()) {
    if (A === B || A.style === B.style || A.style === 'ribbon') continue;
    // 路在接平台那一头的高度（平路就是 z；坡只能用沿坡方向的两头去接）
    const endZ = (d: Dir) => {
      if (!isSlope(A)) return A.z;
      if (d % 2 !== A.slope.axis) return NaN;
      return d < 2 ? A.z + A.slope.dz : A.z;
    };
    if (!isSlope(A) && Math.abs(A.z - B.z) > EPS_TOUCH) continue;
    const type = A.style === 'sink' ? (B.style === 'normal' ? 'transition-half' : 'transition-narrow') : 'ramp';
    const fa = footprint(A), fb = footprint(B);
    for (const d of [0, 1, 2, 3] as Dir[]) {
      if (!(Math.abs(endZ(d) - B.z) <= EPS_TOUCH)) continue;
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
      const p: Piece = { id: -(++autoSeq), kind: 'piece', type, x: ax === 0 ? along : c, y: ax === 0 ? c : along, z: B.z, rot: d, inner: type === 'ramp' ? B.style : undefined };
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
        if (L === S) continue;
        // 素材件（平凹转换、窄转换、专属路块、盘点）的接口贴着坡的端头：接口样式和坡一样就接上（素材件可能在别的样式的层里）
        if (!L.slope && Math.abs(L.z - ze) <= EPS_TOUCH) for (const c of L.pieces) {
          if (L.embedded.has(c.id)) continue;
          const face = pieceFace(c, opp(n));
          if (face.t !== 'port' || face.style !== S.style) continue;
          const q = faceContact(fp, n, footprint(c));
          if (!q || S.folds.some((f) => f.n === n && Math.abs(f.q0 - q[0]) < EPS && Math.abs(f.q1 - q[1]) < EPS)) continue;
          S.folds.push({ other: L, ax, line: lineS, n, q0: q[0], q1: q[1], shift: pe - lineS });
          // 素材件所在的层：接口那一面也不算外沿
          L.folds.push({ other: S, ax, line: pe, n: opp(n), q0: q[0], q1: q[1], shift: lineS - pe, noField: true });
        }
        if (L.style !== S.style) continue;
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
  void elems;
  const occluders = elemGrid.query(bx0, by0, bx1, by1).filter((e) => !memberIds.has(e.id) && overlaps(footprint(e), { x0: bx0, y0: by0, x1: bx1, y1: by1 }));
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
  /** 格子的占用者（路面）在 d 这一侧手动封口，并且 c 就是它这一侧的边 */
  const closedAt = (id: number, d: Dir, c: number) => {
    const bx = L.boxes.find((x) => x.id === id);
    if (!bx || !((bx.closed ?? 0) & (1 << d))) return false;
    const f = sfp.get(id)!;
    return Math.abs(c - [f.x1, f.y1, f.x0, f.y0][d]) < EPS;
  };
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
        // 手动封口：这一格的路面在这一侧封口（格子边正好落在它的这条边上），贴着别的路面也画边框
        if (closedAt(o, d, c) || closedAt(nb, opp(d), c)) { units.push({ ax, c, a, b, n: d, owner: o, kind: 'exp', forced: true }); continue; }
        // 两格都被占：只有素材件和 box 之间、接法不匹配时才算外沿
        if (!isPiece(o) && !isPiece(nb)) continue;
        const pid = isPiece(o) ? o : nb;
        const face = faceIn(L, piece(pid), pid === o ? d : opp(d));
        if (face.t !== 'wall' && face.style === L.style) continue;
        units.push({ ax, c, a, b, n: d, owner: o, kind: 'exp' });
        continue;
      }
      const ni = i + DX[d], nj = j + DY[d];
      const forced = closedAt(o, d, c);
      if (!forced && ni >= 0 && nj >= 0 && ni < nx && nj < ny && virt[ni * ny + nj]) continue; // 叠着坡的那一块：照旧算作路面内部
      const m = (a + b) / 2;
      if (!forced && L.folds.some((f) => f.n === d && Math.abs(f.line - c) < EPS_TOUCH && m > f.q0 && m < f.q1)) continue;
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
    const forced = !!((b.closed ?? 0) & (1 << d));
    if (d % 2 !== ax) { units.push({ ax: eax, c, a, b: e, n: d, owner: b.id, kind, forced }); continue; }
    // 端面：扣掉和别的层相接的区间（手动封口的端面不扣）
    const cuts = (b.closed ?? 0) & (1 << d) ? [] : L.folds.filter((f) => f.n === d).map((f) => [f.q0, f.q1] as [number, number]).sort((p, q) => p[0] - q[0]);
    let s = a;
    for (const [q0, q1] of cuts) {
      if (q0 > s + EPS) units.push({ ax: eax, c, a: s, b: q0, n: d, owner: b.id, kind });
      s = Math.max(s, q1);
    }
    if (e > s + EPS) units.push({ ax: eax, c, a: s, b: e, n: d, owner: b.id, kind, forced });
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
  // 只有同方向、同朝外、在同一条线上（横向坐标差不到 EPS_TOUCH）的边才可能相接：按这条线分桶，只比较相邻桶里的
  const bucket = (i: number) => Math.floor(ends[i][0][1 - runs[i].ax] / 0.01);
  const buckets = new Map<string, number[]>();
  runs.forEach((r, i) => { const k = `${r.ax}|${r.n}|${bucket(i)}`; (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i); });
  const pairs: [number, number][] = [];
  runs.forEach((r, i) => {
    for (const db of [-1, 0, 1]) for (const j of buckets.get(`${r.ax}|${r.n}|${bucket(i) + db}`) ?? []) if (j > i) pairs.push([i, j]);
  });
  for (const [i, j] of pairs) {
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
    if (p.base || p.type === 'start' || p.type === 'check') continue;
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
interface Lin { k: [number, number, number]; run: Run | null; vAx: 0 | 1; t: V2; clamp?: boolean; /** 直接给出 v·5 的线性函数（别的朝向的外沿） */ v?: Line }

const linVal = (l: Lin, p: V2) => l.k[0] * p[0] + l.k[1] * p[1] + l.k[2];

function fieldSegs(L: Layer): FSeg[] {
  const out: FSeg[] = L.runs.map((r) => ({ r, ax: r.ax, c: r.c, a: r.a, b: r.b, t: [0, 0] }));
  for (const f of L.folds) {
    if (f.noField) continue;
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
  const tops = new Map<number, V3[]>(); // 每片路面顶面网格的顶点（展开坐标 + 下沉量），画开口端面用
  const boxIds = new Map(L.boxes.map((b) => [b.id, b]));
  const isBox = (id: number) => boxIds.has(id);
  // 连通的一片路面（贴着 / 压着的格子矩形连在一起）合成一个网格，网格的编号取这一片里最小的元素 id；
  // 这样花纹的分块不会被路面之间的分界线切开。每个三角形另外记下它属于哪个元素（点选用）。
  const boxRects = L.rects.filter((r) => isBox(r.owner));
  const par = boxRects.map((_, i) => i);
  const find = (i: number): number => (par[i] === i ? i : (par[i] = find(par[i])));
  const idxGrid = new Grid<number>(10);
  boxRects.forEach((r, i) => idxGrid.add(i, r.x0, r.y0, r.x1, r.y1));
  for (let i = 0; i < boxRects.length; i++) for (const j of idxGrid.query(boxRects[i].x0 - EPS, boxRects[i].y0 - EPS, boxRects[i].x1 + EPS, boxRects[i].y1 + EPS)) {
    if (j <= i) continue;
    const a = boxRects[i], b = boxRects[j];
    const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
    if (a.owner === b.owner || (ox >= -EPS && oy >= -EPS && Math.max(ox, oy) > EPS)) par[find(i)] = find(j);
  }
  const repOfRoot = new Map<number, number>();
  boxRects.forEach((r, i) => { const k = find(i); repOfRoot.set(k, Math.min(repOfRoot.get(k) ?? Infinity, r.owner)); });
  const repOfRect = new Map(boxRects.map((r, i) => [r, repOfRoot.get(find(i))!]));
  const repOfOwner = new Map(boxRects.map((r) => [r.owner, repOfRect.get(r)!]));
  /** 点 (x, y) 在哪个元素的格子里（三角形的重心，找不到就取最近的） */
  const ownerAt = (x: number, y: number) => {
    let best = boxRects[0]?.owner ?? 0, bd = Infinity;
    const cand = rectGrid.query(x - 1, y - 1, x + 1, y + 1);
    for (const r of cand.length ? cand : boxRects) {
      const d = Math.max(r.x0 - x, x - r.x1, r.y0 - y, y - r.y1);
      if (d < bd) { bd = d; best = r.owner; }
      if (d <= 0) break;
    }
    return best;
  };
  // 外沿按位置放进网格：每一块只看附近的外沿（一层是全图同样式、同高度的路面，外沿可能很多）
  const compSig = new Map<number, string>();
  const segGrid = new Grid<FSeg>(10);
  const segIndex = new Map(segs.map((e, i) => [e, i]));
  for (const e of segs) segGrid.add(e, e.ax === 0 ? e.a : e.c, e.ax === 0 ? e.c : e.a, e.ax === 0 ? e.b : e.c, e.ax === 0 ? e.c : e.b);
  const rectGrid = new Grid<(typeof boxRects)[number]>(10);
  for (const r of boxRects) rectGrid.add(r, r.x0, r.y0, r.x1, r.y1);
  /** 每片路面：线性函数（距离、花纹）→ 用这个函数的小块 */
  const pending = new Map<number, Map<string, { w: Lin; polys: Poly[] }>>();
  const vOf = (l: Lin, p: V2) => {
    if (l.v) return linVal({ k: l.v } as Lin, p) / 5;
    const c = p[l.vAx] + l.t[l.vAx];
    return l.run ? (l.run.s * c + l.run.o) / 5 : c / 5;
  };

  // 不同朝向的路面接在一起的折角（本层的外沿和别的朝向的外沿在同一点断开）：像手工拼路那样，
  // 两边都当作正常的直路一直延伸过去，在角平分线处割开——每一侧按自己那条边的垂直距离和花纹相位，两侧在平分线上正好相等。
  // 这样的折角都是凹角（两块路面的外沿相交处），所以折角附近取两条边（带符号、朝里为正）距离里较大的那个。
  // 很尖的折角（外角远小于 90°）：两侧花纹带的交叠会沿平分线拉出一条细长的尖，所以再加一个沿平分线离折角的距离 / √2 封顶
  //（90° 的折角时它正好和切比雪夫距离的方块一样，不起作用；外角越尖越起作用）。
  type Joint = { c: V2; own: Lin; g: Lin; bis: Line; cap: [number, number, number]; capV: Line; capLines: Line[] };
  const joints: Joint[] = [];
  const ownPerp = (e: FSeg): Lin => {
    const ni: V2 = [-DX[e.r.n], -DY[e.r.n]];
    const p: V2 = e.ax === 0 ? [e.a, e.c] : [e.c, e.a];
    return { k: [ni[0], ni[1], -(ni[0] * p[0] + ni[1] * p[1])], run: e.r, vAx: e.ax, t: e.t };
  };
  const gPerp = (g: GSeg): Lin => ({ k: [g.nIn[0], g.nIn[1], -(g.nIn[0] * g.p0[0] + g.nIn[1] * g.p0[1])], run: null, vAx: 0, t: [0, 0], v: g.v });
  const jointAt = (c: V2) => joints.find((j) => Math.abs(j.c[0] - c[0]) < 1e-5 && Math.abs(j.c[1] - c[1]) < 1e-5);
  /** 折角拼接的函数；这一块在两条边的外侧（带符号的距离是负的）时不适用，返回 null 用普通的距离函数 */
  const pickJoint = (j: Joint, cen: V2): Lin | null => {
    const side = linVal(j.own, cen) >= linVal(j.g, cen) ? j.own : j.g;
    // 两条边的外侧还是路面：那是第三块路面盖住的地方（例如同朝向的另一块路面压在这个角上），不归这个折角管
    if (linVal(side, cen) < -1e-9) return null;
    // 封顶那一块：等距线垂直于平分线，花纹相位沿等距线走（不然贴图会被斜着拉长）
    return linVal({ k: j.cap } as Lin, cen) > linVal(side, cen) ? { k: j.cap, run: null, vAx: 0, t: [0, 0], v: j.capV } : side;
  };
  if (L.gsegs) for (const e of segs) {
    if (e.t[0] || e.t[1] || e.r.layer !== L) continue;
    for (const end of [e.a, e.b]) {
      const c: V2 = e.ax === 0 ? [end, e.c] : [e.c, end];
      for (const g of L.gsegs) {
        const g1: V2 = [g.p0[0] + g.t[0] * g.len, g.p0[1] + g.t[1] * g.len];
        if (![g.p0, g1].some((q) => Math.abs(q[0] - c[0]) < 1e-5 && Math.abs(q[1] - c[1]) < 1e-5)) continue;
        const own = ownPerp(e), gl = gPerp(g);
        // 平分线方向（朝路面里面）：垂直于 nE − nF，并且沿着它两边的距离都增大
        let w: V2 = [-(own.k[1] - gl.k[1]), own.k[0] - gl.k[0]];
        const wl = Math.hypot(...w) || 1;
        w = [w[0] / wl, w[1] / wl];
        if (w[0] * own.k[0] + w[1] * own.k[1] < 0) w = [-w[0], -w[1]];
        const cap: [number, number, number] = [w[0] / Math.SQRT2, w[1] / Math.SQRT2, -(w[0] * c[0] + w[1] * c[1]) / Math.SQRT2];
        const eq = (a: number[], b: number[]): Line => [a[0] - b[0], a[1] - b[1], b[2] - a[2]];
        const capV: Line = [-w[1], w[0], w[1] * c[0] - w[0] * c[1]];
        joints.push({ c, own, g: gl, bis: eq(own.k, gl.k), cap, capV, capLines: [eq(cap, own.k), eq(cap, gl.k)] });
      }
    }
  }
  /** 本层外沿在本块里的距离函数：越过的那一头是折角时按角平分线拼接 */
  const ownLin = (e: FSeg, cen: V2): Lin => {
    if (joints.length && !e.t[0] && !e.t[1]) {
      const p = cen[e.ax];
      const end = p < e.a - 1e-9 ? e.a : p > e.b + 1e-9 ? e.b : null;
      const j = end === null ? null : jointAt(e.ax === 0 ? [end, e.c] : [e.c, end]);
      const jl = j && pickJoint(j, cen);
      if (jl) return jl;
    }
    return segLin(e, cen);
  };
  const gLin = (g: GSeg, cen: V2): Lin => {
    if (joints.length) {
      const along = (cen[0] - g.p0[0]) * g.t[0] + (cen[1] - g.p0[1]) * g.t[1];
      const end: V2 | null = along < -1e-9 ? g.p0 : along > g.len + 1e-9 ? [g.p0[0] + g.t[0] * g.len, g.p0[1] + g.t[1] * g.len] : null;
      const j = end && jointAt(end);
      const jl = j && pickJoint(j, cen);
      if (jl) return jl;
    }
    return gsegLin(g, cen);
  };

  // 每片路面的签名：图层（样式、高度、坡）、它的格子和元素、它的外沿，附近（会进距离场的）外沿和它们的花纹相位、
  // 别的朝向压上来的成员和外沿、是否合并。签名一样，网格就一样
  const cached = new Map<number, ElemMeshOut>();
  {
    const comps = new Map<number, (typeof boxRects)[number][]>();
    for (const r of boxRects) { const k = repOfRect.get(r)!; (comps.get(k) ?? comps.set(k, []).get(k)!).push(r); }
    const runSig = (r: Run | null | undefined): unknown => (r ? [r.ax, r.c, r.a, r.b, r.n, r.s, r.o] : 0);
    for (const [rep, rs] of comps) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const r of rs) { x0 = Math.min(x0, r.x0); y0 = Math.min(y0, r.y0); x1 = Math.max(x1, r.x1); y1 = Math.max(y1, r.y1); }
      const owners = new Set(rs.map((r) => r.owner));
      const near = new Set<FSeg>();
      for (const r of rs) for (const e of segGrid.query(r.x0 - BAND, r.y0 - BAND, r.x1 + BAND, r.y1 + BAND)) near.add(e);
      const pad = BAND * 2;
      const sig = JSON.stringify([
        solveOpts.merge, L.style, L.z, L.slope ?? null,
        rs.map((r) => [r.x0, r.y0, r.x1, r.y1, r.owner]),
        [...owners].map((o) => boxIds.get(o)),
        L.edges.filter((e) => owners.has(e.owner)).map((e) => [e.ax, e.c, e.a, e.b, e.n, e.kind, e.forced ?? 0, e.owner]),
        [...near].map((e) => [e.ax, e.c, e.a, e.b, e.t, runSig(e.r), runSig(e.r.adjA), runSig(e.r.adjB), e.r.layer === L ? 0 : 1]),
        (L.gsegs ?? []).filter((g) => { const ex = g.p0[0] + g.t[0] * g.len, ey = g.p0[1] + g.t[1] * g.len; return Math.max(g.p0[0], ex) > x0 - pad && Math.min(g.p0[0], ex) < x1 + pad && Math.max(g.p0[1], ey) > y0 - pad && Math.min(g.p0[1], ey) < y1 + pad; }),
        (L.foreign ?? []).filter((f) => f.x1 > x0 - EPS && f.x0 < x1 + EPS && f.y1 > y0 - EPS && f.y0 < y1 + EPS).map((f) => [f.poly, f.id, f.piece]),
      ]);
      compSig.set(rep, sig);
      const hit = meshCache.get(sig);
      if (hit) { cached.set(rep, hit); nextMeshCache.set(sig, hit); solveStats.hit++; } else solveStats.miss++;
    }
  }

  for (const r of L.rects) {
    if (!isBox(r.owner) || cached.has(repOfRect.get(r)!)) continue;
    // 按外沿原来的顺序排：距离一样的两个函数取排在前面的那个，顺序变了花纹相位就可能换成另一条边的
    const near = segGrid.query(r.x0 - BAND, r.y0 - BAND, r.x1 + BAND, r.y1 + BAND).filter((e) => rectDist(r, e) <= BAND + 1e-9).sort((a, b) => segIndex.get(a)! - segIndex.get(b)!);
    // 别的朝向的外沿：切比雪夫距离 ≥ 欧氏距离 / √2，欧氏距离在 BAND·√2 以内的才可能起作用
    const gnear = (L.gsegs ?? []).filter((g) => gsegDist(r, g) < BAND * Math.SQRT2);
    let polys: Poly[] = [[[r.x0, r.y0], [r.x1, r.y0], [r.x1, r.y1], [r.x0, r.y1]]];
    // 别的朝向的成员压在这一块上：沿它的四条边切开，挖掉它赢的部分（素材件优先，路面按 id 小的优先）
    for (const f of L.foreign ?? []) {
      if (f.x1 <= r.x0 + EPS || f.x0 >= r.x1 - EPS || f.y1 <= r.y0 + EPS || f.y0 >= r.y1 - EPS) continue;
      if (!f.piece && f.id > r.owner) continue;
      const next: Poly[] = [];
      for (const p of polys) {
        let parts: Poly[] = [p];
        for (let i = 0; i < 4; i++) {
          const a = f.poly[i], b = f.poly[(i + 1) % 4];
          const ln: Line = [b[1] - a[1], a[0] - b[0], (b[1] - a[1]) * a[0] + (a[0] - b[0]) * a[1]];
          parts = parts.flatMap((q) => splitPoly(q, ln) ?? [q]);
        }
        next.push(...parts.filter((q) => !insidePoly(centroid(q), f.poly)));
      }
      polys = next;
    }
    // 每条外沿的转折线只在它附近（BAND 以内）起作用：包围盒离得远的块不用切
    type BP = { p: Poly; x0: number; x1: number; y0: number; y1: number };
    const bp = (p: Poly): BP => {
      let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
      for (const q of p) { if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
      return { p, x0, x1, y0, y1 };
    };
    let bps: BP[] = polys.map(bp);
    // 折角的角平分线
    for (const j of joints) {
      if (j.c[0] < r.x0 - BAND * 2 || j.c[0] > r.x1 + BAND * 2 || j.c[1] < r.y0 - BAND * 2 || j.c[1] > r.y1 + BAND * 2) continue;
      for (const ln of [j.bis, ...j.capLines]) bps = bps.flatMap((b) => { const s = splitPoly(b.p, ln); return s ? [bp(s[0]), bp(s[1])] : [b]; });
    }
    for (const g of gnear) {
      const ex = [g.p0[0], g.p0[0] + g.t[0] * g.len], ey = [g.p0[1], g.p0[1] + g.t[1] * g.len];
      const ix0 = Math.min(...ex) - BAND * 1.5, ix1 = Math.max(...ex) + BAND * 1.5, iy0 = Math.min(...ey) - BAND * 1.5, iy1 = Math.max(...ey) + BAND * 1.5;
      for (const ln of gsegLines(g)) {
        const next: BP[] = [];
        for (const b of bps) {
          const s = b.x1 > ix0 && b.x0 < ix1 && b.y1 > iy0 && b.y0 < iy1 ? splitPoly(b.p, ln) : null;
          if (s) next.push(bp(s[0]), bp(s[1])); else next.push(b);
        }
        bps = next;
      }
    }
    for (const e of near) {
      const ix0 = (e.ax === 0 ? e.a : e.c) - BAND, ix1 = (e.ax === 0 ? e.b : e.c) + BAND;
      const iy0 = (e.ax === 0 ? e.c : e.a) - BAND, iy1 = (e.ax === 0 ? e.c : e.b) + BAND;
      for (const ln of segLines(e)) {
        const next: BP[] = [];
        for (const b of bps) {
          const s = b.x1 > ix0 - 1e-6 && b.x0 < ix1 + 1e-6 && b.y1 > iy0 - 1e-6 && b.y0 < iy1 + 1e-6 ? splitPoly(b.p, ln) : null;
          if (s) next.push(bp(s[0]), bp(s[1])); else next.push(b);
        }
        bps = next;
      }
    }
    polys = bps.map((b) => b.p);
    const boxes = new Map(bps.map((b) => [b.p, b]));
    const clampLin: Lin = { k: [0, 0, BAND], run: null, vAx: 0, t: [0, 0], clamp: true };
    // 先攒起来，整片路面算完后把同一个函数的小块并成多边形再出网格
    const rep = repOfRect.get(r)!;
    const groups = pending.get(rep) ?? (pending.set(rep, new Map()), pending.get(rep)!);
    const emit = (poly: Poly, w: Lin) => {
      const k = solveOpts.merge ? linKey(w) : `${groups.size}`;
      const g = groups.get(k);
      if (g) g.polys.push(poly); else groups.set(k, { w, polys: [poly] });
    };
    for (const poly of polys) {
      const cen = centroid(poly);
      // 只有离这一块不超过 BAND 的外沿可能成为最近的
      const b = boxes.get(poly)!;
      // 只看离这一块严格小于 BAND 的外沿：刚好 BAND 远的整块都已经到了路面内部（花纹到头了），带进来反而可能用错端点那一侧的函数
      const cands = near.filter((e) => rectDist(b, e) < BAND - 1e-9);
      const gc = gnear.filter((g) => gsegDist(b, g) < BAND * Math.SQRT2);
      resolve(poly, [clampLin, ...cands.map((e) => ownLin(e, cen)), ...gc.map((g) => gLin(g, cen))], emit, 0);
    }
  }
  for (const [rep, groups] of pending) {
    const m = mb(rep);
    const tv = tops.get(rep) ?? (tops.set(rep, []), tops.get(rep)!);
    for (const { w, polys } of groups.values()) {
      for (const tri of solveOpts.merge ? unionTriangulate(polys) : polys.flatMap((p) => p.slice(1, -1).map((_, i) => [p[0], p[i + 1], p[i + 2]]))) {
        const pts: V3[] = [], uvs: V2[] = [];
        for (const p of tri) {
          const d = clamp(linVal(w, p), 0, BAND);
          const depth = (st.sink * d) / BAND;
          pts.push(L.world(p[0], p[1], depth));
          tv.push([p[0], p[1], depth]);
          uvs.push(w.clamp ? [p[0] / 5, p[1] / 5] : [(st.uScale * d) / BAND, vOf(w, p)]);
        }
        const c = centroid(tri);
        m.tri(w.clamp ? 'FloorTopBorderless' : st.band, pts, uvs, UP, ownerAt(c[0], c[1]));
      }
    }
  }

  // 侧面：外沿是竖直的平面；开口按顶面实际的下沉画出凹槽截面。
  // 同一片路面、厚度一样的路面在同一条线上首尾相接的外沿并成一段（一个四边形），不按元素断开
  const sideEdges: (Edge & { rep: number })[] = [];
  if (cached.size < compSig.size) {
    const byKey = new Map<string, (Edge & { rep: number })[]>();
    for (const e of L.edges) {
      if (!isBox(e.owner)) continue;
      const rep = repOfOwner.get(e.owner) ?? e.owner;
      const depth = boxIds.get(e.owner)!.depth;
      const k = `${rep}|${depth}|${e.kind}|${e.ax}|${e.c}|${e.n}`;
      const l = byKey.get(k) ?? (byKey.set(k, []), byKey.get(k)!);
      l.push({ ...e, rep });
    }
    for (const l of byKey.values()) {
      l.sort((p, q) => p.a - q.a);
      let cur = { ...l[0] };
      for (let i = 1; i < l.length; i++) {
        if (l[i].a <= cur.b + EPS) cur.b = Math.max(cur.b, l[i].b);
        else { sideEdges.push(cur); cur = { ...l[i] }; }
      }
      sideEdges.push(cur);
    }
  }
  for (const e of sideEdges) {
    if (cached.has(e.rep)) continue;
    const b = boxIds.get(e.owner)!;
    // 侧面的三角形属于哪个元素：从侧面中点往路面里挪一点看是谁的格子
    const sideOwner = (t: number) => { const [x, y] = e.ax === 0 ? [t, e.c] : [e.c, t]; return ownerAt(x - DX[e.n] * 0.01, y - DY[e.n] * 0.01); };
    const out3: V3 = [DX[e.n], DY[e.n], 0];
    const run = L.runs.find((r) => r.ax === e.ax && Math.abs(r.c - e.c) < EPS && r.n === e.n && r.a <= e.a + EPS && r.b >= e.b - EPS);
    const v = (t: number) => (run ? (run.s * t + run.o) / 5 : t / 5);
    const P = (t: number): V2 => (e.ax === 0 ? [t, e.c] : [e.c, t]);
    let ts: [number, number][] = [[e.a, 0], [e.b, 0]];
    if (e.kind === 'open') {
      const on = (tops.get(e.rep) ?? []).filter((p) => Math.abs(p[1 - e.ax] - e.c) < 1e-6 && p[e.ax] >= e.a - 1e-6 && p[e.ax] <= e.b + 1e-6);
      const byT = new Map<string, [number, number]>();
      for (const p of on) byT.set(p[e.ax].toFixed(6), [p[e.ax], p[2]]);
      ts = [...byT.values()].sort((p, q) => p[0] - q[0]);
    }
    for (let i = 0; i + 1 < ts.length; i++) {
      const [t0, d0] = ts[i], [t1, d1] = ts[i + 1];
      const A = L.world(...P(t0), d0), B = L.world(...P(t1), d1);
      const A0 = L.world(...P(t0), 0), B0 = L.world(...P(t1), 0);
      const Ab: V3 = [A[0], A[1], A0[2] - b.depth], Bb: V3 = [B[0], B[1], B0[2] - b.depth];
      const own = sideOwner((t0 + t1) / 2);
      if (b.depth <= 5 + 1e-9) {
        mb(e.rep).poly('FloorSide', [A, B, Bb, Ab], [[d0 / 5, v(t0)], [d1 / 5, v(t1)], [b.depth / 5, v(t1)], [b.depth / 5, v(t0)]], out3, own);
        continue;
      }
      // 厚度超过 5：和 BBP（raw_floor_side）一样，上面 5 用带边框的顶面贴图，再往下用无边框的顶面贴图
      const Am: V3 = [A[0], A[1], A0[2] - 5], Bm: V3 = [B[0], B[1], B0[2] - 5];
      const hb = (b.depth - 5) / 5;
      mb(e.rep).poly('LightingFloorTopBorder', [A, B, Bm, Am], [[d0 / 5, v(t0)], [d1 / 5, v(t1)], [1, v(t1)], [1, v(t0)]], out3, own);
      mb(e.rep).poly('LightingFloorTopBorderless', [Am, Bm, Bb, Ab], [[0, v(t0)], [0, v(t1)], [hb, v(t1)], [hb, v(t0)]], out3, own);
    }
  }
  // 新算的放进缓存；命中缓存的直接用（复制一份数组，后面可能还要往里追加）
  const copyParts = (src: ElemMeshOut['parts']) => {
    const parts: ElemMeshOut['parts'] = {};
    for (const [k, p] of Object.entries(src) as [MatName, MeshPart][]) parts[k] = { pos: p.pos.slice(), uv: p.uv.slice(), ...(p.own ? { own: p.own.slice() } : {}) };
    return parts;
  };
  for (const [id, m] of builders) { const sig = compSig.get(id); if (sig !== undefined) nextMeshCache.set(sig, { id, parts: copyParts(m.parts) }); }
  for (const [id, hit] of cached) {
    const b = new MeshBuilder();
    b.parts = copyParts(hit.parts);
    builders.set(id, b);
  }
  for (const [id, m] of builders) {
    const prev = out.get(id);
    if (!prev) { out.set(id, { id, parts: m.parts, sig: compSig.get(id) }); continue; }
    prev.sig = undefined;
    for (const [k, part] of Object.entries(m.parts) as [MatName, MeshPart][]) {
      const t = (prev.parts[k] ??= { pos: [], uv: [] });
      t.pos.push(...part.pos); t.uv.push(...part.uv);
      if (part.own) (t.own ??= []).push(...part.own);
    }
  }
}

/** 线性函数（距离 + 花纹）的键：一样的函数在同一片路面里的小块可以并成一块 */
function linKey(l: Lin): string {
  const r9 = (v: number) => Math.round(v * 1e9);
  return l.clamp ? 'c' : [...l.k.map(r9), ...(l.v ? ['v', ...l.v.map(r9)] : ['r', l.run?.id ?? -1, l.vAx, r9(l.t[0]), r9(l.t[1])])].join(',');
}

/**
 * 同一个线性函数的小块（凸多边形，互不重叠）并成多边形（可以凹、可以有洞），去掉共线的点，再三角化。
 * 小块之间的公共边成对抵消（一边的顶点落在另一边上时先把边切开），剩下的边连成环：逆时针的是外圈，顺时针的是洞。
 * 函数在整块上是同一个线性函数，所以顶点上算出的 UV、高度和原来逐块算的完全一样，n 个顶点的多边形只要 n − 2 个三角形。
 */
function unionTriangulate(polys: Poly[]): V2[][] {
  // 只有一块（凸多边形）：去掉共线点后扇形三角化就是最少的
  if (polys.length === 1) {
    const ring = dropCollinear(polys[0]);
    return ring.length < 3 ? [] : ring.slice(1, -1).map((_, i) => [ring[0], ring[i + 1], ring[i + 2]]);
  }
  const Q = 1e6;
  const key = (p: V2) => `${Math.round(p[0] * Q)},${Math.round(p[1] * Q)}`;
  const pts = new Map<string, V2>();
  const rings = polys.map((p) => (signedArea(p) < 0 ? [...p].reverse() : p));
  for (const r of rings) for (const p of r) if (!pts.has(key(p))) pts.set(key(p), p);
  const vgrid = new Grid<[string, V2]>(2.5);
  for (const e of pts.entries()) vgrid.add(e, e[1][0], e[1][1], e[1][0], e[1][1]);
  // 有向边（顶点落在边上的先切开），统计次数
  const cnt = new Map<string, number>();
  const ends = new Map<string, [string, string]>();
  for (const r of rings) for (let i = 0; i < r.length; i++) {
    const a = r[i], b = r[(i + 1) % r.length];
    const ka = key(a), kb = key(b);
    if (ka === kb) continue;
    const dx = b[0] - a[0], dy = b[1] - a[1], len2 = dx * dx + dy * dy;
    const mids: [number, string][] = [];
    const x0 = Math.min(a[0], b[0]) - 1e-7, x1 = Math.max(a[0], b[0]) + 1e-7, y0 = Math.min(a[1], b[1]) - 1e-7, y1 = Math.max(a[1], b[1]) + 1e-7;
    for (const [k, p] of vgrid.query(x0, y0, x1, y1)) {
      if (k === ka || k === kb || p[0] < x0 || p[0] > x1 || p[1] < y0 || p[1] > y1) continue;
      const t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
      if (t <= 1e-9 || t >= 1 - 1e-9) continue;
      if (Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.sqrt(len2) > 1e-7) continue;
      mids.push([t, k]);
    }
    mids.sort((p, q) => p[0] - q[0]);
    const chain = [ka, ...mids.map((m) => m[1]), kb];
    for (let j = 0; j + 1 < chain.length; j++) {
      const ek = `${chain[j]}>${chain[j + 1]}`;
      cnt.set(ek, (cnt.get(ek) ?? 0) + 1);
      ends.set(ek, [chain[j], chain[j + 1]]);
    }
  }
  // 公共边抵消：a→b 和 b→a 各去掉一次
  const out = new Map<string, string[]>();
  let left = 0;
  for (const [ek, n] of cnt) {
    const [a, b] = ends.get(ek)!;
    const m = n - (cnt.get(`${b}>${a}`) ?? 0);
    for (let i = 0; i < m; i++) { (out.get(a) ?? (out.set(a, []), out.get(a)!)).push(b); left++; }
  }
  // 连成环：一个点有好几条出边（两块只在一个点相碰）时取向右拐得最多的那条，保证每个环不自交
  const loops: V2[][] = [];
  while (left > 0) {
    const start = [...out.keys()].find((k) => out.get(k)!.length)!;
    const loop: string[] = [start];
    let prev = start, cur = out.get(start)!.pop()!;
    left--;
    let guard = 0;
    while (cur !== start && guard++ < 100000) {
      loop.push(cur);
      const cands = out.get(cur) ?? [];
      if (!cands.length) break;
      let bi = 0;
      if (cands.length > 1) {
        const P = pts.get(prev)!, C = pts.get(cur)!;
        const din: V2 = [C[0] - P[0], C[1] - P[1]];
        let best = Infinity;
        cands.forEach((k, i) => {
          const N = pts.get(k)!, d: V2 = [N[0] - C[0], N[1] - C[1]];
          const ang = Math.atan2(din[0] * d[1] - din[1] * d[0], din[0] * d[0] + din[1] * d[1]);
          if (ang < best) { best = ang; bi = i; }
        });
      }
      prev = cur;
      cur = cands.splice(bi, 1)[0];
      left--;
    }
    const ring = dropCollinear(loop.map((k) => pts.get(k)!));
    if (ring.length >= 3 && Math.abs(signedArea(ring)) > 1e-10) loops.push(ring);
  }
  // 外圈（逆时针）带上落在它里面的洞（顺时针），用 earcut 三角化
  const outers = loops.filter((l) => signedArea(l) > 0), holes = loops.filter((l) => signedArea(l) < 0);
  const tris: V2[][] = [];
  for (const o of outers) {
    const hs = holes.filter((h) => pointInRing(h[0], o) && !outers.some((o2) => o2 !== o && pointInRing(h[0], o2) && pointInRing(o2[0], o)));
    if (o.length === 3 && !hs.length) { tris.push(o); continue; }
    const verts = [o, ...hs].flat();
    for (const f of ShapeUtils.triangulateShape(o.map((p) => new Vector2(p[0], p[1])), hs.map((h) => h.map((p) => new Vector2(p[0], p[1]))))) tris.push(f.map((i) => verts[i]));
  }
  return tris;
}
/** 去掉多边形上共线的点（三角形不动） */
function dropCollinear(poly: Poly): Poly {
  const ring = [...poly];
  for (let changed = true; changed && ring.length > 3;) {
    changed = false;
    for (let i = 0; i < ring.length && ring.length > 3; i++) {
      const a = ring[(i + ring.length - 1) % ring.length], p = ring[i], b = ring[(i + 1) % ring.length];
      const cr = (p[0] - a[0]) * (b[1] - p[1]) - (p[1] - a[1]) * (b[0] - p[0]);
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1;
      if (Math.abs(cr) / l < 1e-7 && (p[0] - a[0]) * (b[0] - p[0]) + (p[1] - a[1]) * (b[1] - p[1]) >= 0) { ring.splice(i, 1); i--; changed = true; }
    }
  }
  return ring;
}
function signedArea(p: Poly) {
  let s = 0;
  for (let i = 0; i < p.length; i++) { const q = p[(i + 1) % p.length]; s += p[i][0] * q[1] - q[0] * p[i][1]; }
  return s / 2;
}
function pointInRing(p: V2, ring: Poly) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i], b = ring[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
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
    // 两个函数在这块里不相交（相等的线只擦到边界）：去掉处处不比另一个小的那个再找。
    // 容差要和上面判断「处处最小」的一致：相等的线正好落在这块的边上时，两边在那几个顶点上只差舍入误差，
    // 用更紧的容差会把真正最小的那个去掉（花纹贴图被拉成一条条的）
    const ge = (a: number, b: number) => vals[a].every((v, kk) => v >= vals[b][kk] - 1e-7);
    const sum = (a: number) => vals[a].reduce((s, v) => s + v, 0);
    const drop = ge(i0, i1) ? i0 : ge(i1, i0) ? i1 : sum(i0) >= sum(i1) ? i0 : i1;
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
  // 平台里自动嵌的转换件（负数 id）只要顶面：侧面、端面都贴着平台或路，看不见
  if (p.id < 0) { out.set(p.id, { id: p.id, parts: mb.parts }); return; }
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
    const cx = [fp.x1, fp.y1, fp.x0, fp.y0][d], cm = d % 2 === 0 ? (fp.y0 + fp.y1) / 2 : (fp.x0 + fp.x1) / 2;
    const [qx, qy] = d % 2 === 0 ? [cx, cm] : [cm, cx];
    const joined = layers.some((Ly) => Ly.style === st && Ly.boxes.some((b) => Math.abs(boxTopAt(b, qx, qy) - p.z) < EPS_TOUCH && (faceContact(fp, d, footprint(b)) || overlaps(fp, footprint(b)))));
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
  if (b.kind === 'trafo') return { name: `TrafoBase_${b.mat ?? 'Wood'}`, kind: 'asset', pos: [p.x, p.y, z], rotZ: 0 };
  // Slider 的原点在第一格中心，本地 +Y 沿栅栏方向
  if (b.kind === 'fence') return { name: 'Slider', kind: 'asset', pos: [p.x, p.y, z], rotZ: p.rot * 90 - 90 };
  if (layers.some((L) => L.embedded.has(p.id))) return { name: 'Ventilator_NoEdge_Borderless', kind: 'asset', pos: [p.x, p.y, z], rotZ: 0 };
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
    for (let k = 0; k < 4; k++) if (borders.every((d) => closed.has(((d + k) % 4) as Dir))) return { name, kind: 'asset', pos: [p.x, p.y, z], rotZ: k * 90 };
  }
  return { name: 'Ventilator_4Face', kind: 'asset', pos: [p.x, p.y, z], rotZ: 0 };
}

// ---------------- 盘点路面 ----------------

/** 火焰占位符里锥桶的底部比原点高这么多：锥桶底部贴住盘点路面顶面 */
const FLAME_CONE = 1.25555;
/** 资产库里盘点路面的延伸段不正好在中线上，按资产本地坐标挪回来，让延伸段末端正好落在路口上 */
const CP_FIX: Record<string, [number, number]> = {
  // 不带延伸的版本圆盘偏了 0.218：挪回来，和接了路的版本对齐（换版本时不会横着跳一下）
  CheckPoint_NoExtended: [0, -0.218],
  CheckPoint_Extended_OpenEdge: [0, -0.042],
  CheckPoint_DoubleExtended_OpenEdge: [-0.02155, 0.036],
};

/**
 * 盘点路面接了路的那一侧：用带延伸的模型，但把延伸出来的那一格普通路裁掉，只留圆盘边上和路相接的花纹（盘点更紧凑，
 * 路口就在圆盘边上）。裁剪线是模型本地的 x（圆盘边沿正好有一排顶点）。
 */
// 挖掉的是路那一条（宽 5）：两边的火焰托盘、圆盘前沿不动
const CP_CROP: Record<string, [number, number, number, number][]> = {
  // 起点：圆盘主体到 7.386 为止，再往外是延伸路（开头那 0.67 只有上面一层），一起挖掉
  StartPoint_Extended_OpenEdge: [[7.386, 1e9, -2.51, 2.51]],
  CheckPoint_Extended_OpenEdge: [[4.924, 1e9, -2.6, 2.6]],
  CheckPoint_DoubleExtended_OpenEdge: [[4.946, 1e9, -2.6, 2.6], [-1e9, -4.902, -2.6, 2.6]],
};

/** 重生点占位符本身朝 -X，转 180° 才和路口 / 设置的重生朝向一致 */
const spawnRot = (p: Piece) => ((p.spawn ?? p.rot * 90) + 180) % 360;

/** 盘点路面由哪些模型组成：路面（按接了哪几侧选延伸段版本）+ 火焰占位符 + 重生点占位符 */
function checkpointParts(p: Piece, layers: Layer[], sector: number): AssetPart[] {
  const fp = footprint(p);
  const joined = (d: Dir) => layers.some((L) => L.pieces.includes(p) && L.boxes.some((b) => faceContact(fp, d, footprint(b))));
  const floorZ = p.z - 2.5; // 资产模型原点在路块中心
  const deg = (d: Dir) => d * 90;
  const two = (v: number) => String(v).padStart(2, '0');
  if (p.type === 'start') {
    return [
      { name: joined(p.rot) ? 'StartPoint_Extended_OpenEdge' : 'StartPoint_NoExtended', kind: 'asset', pos: [p.x, p.y, floorZ], rotZ: deg(p.rot), ...(joined(p.rot) ? { crop: CP_CROP.StartPoint_Extended_OpenEdge } : {}) },
      // 四火比资产模型多转 90°（与 BBP 的小节对一致）；重生点抬高 3.65
      { name: 'PS_FourFlames', kind: 'element', objName: 'PS_FourFlames_01', pos: [p.x, p.y, p.z - FLAME_CONE], rotZ: deg(p.rot) + 90 },
      { name: 'PR_Resetpoint', kind: 'element', objName: 'PR_Resetpoint_01', pos: [p.x, p.y, p.z - FLAME_CONE + 3.65], rotZ: spawnRot(p) },
    ];
  }
  const a = joined(p.rot), b = joined(opp(p.rot));
  const [name, r] = a && b ? ['CheckPoint_DoubleExtended_OpenEdge', p.rot] : a ? ['CheckPoint_Extended_OpenEdge', p.rot]
    : b ? ['CheckPoint_Extended_OpenEdge', opp(p.rot)] : ['CheckPoint_NoExtended', p.rot];
  const f = CP_FIX[name] ?? [0, 0];
  const rr = (deg(r as Dir) * Math.PI) / 180;
  const fx = p.x + f[0] * Math.cos(rr) - f[1] * Math.sin(rr), fy = p.y + f[0] * Math.sin(rr) + f[1] * Math.cos(rr);
  return [
    { name, kind: 'asset', pos: [fx, fy, floorZ], rotZ: deg(r as Dir), ...(CP_CROP[name] ? { crop: CP_CROP[name] } : {}) },
    { name: 'PC_TwoFlames', kind: 'element', objName: `PC_TwoFlames_${two(sector - 1)}`, pos: [p.x, p.y, p.z - FLAME_CONE], rotZ: deg(p.rot) },
    { name: 'PR_Resetpoint', kind: 'element', objName: `PR_Resetpoint_${two(sector)}`, pos: [p.x, p.y, p.z - FLAME_CONE + 3.3258], rotZ: spawnRot(p) },
  ];
}
