// 路面网格生成：按四分之一格（2.5×2.5）判断边框，自动分配材质与 UV。
// UV 规则沿用 BBP / BME 原型：边框贴图 u=0 在路外沿、u=0.5 在路中线，v 方向每 5 个单位走 1。
// UV 与 BME 一致，采用 Blender 约定（v 向上）。
import {
  CELL, DX, DY, EndKey, HALF, MNode, Model, SINK_DEPTH, Seg, THICK,
  endZ, isFree, nodeLinks, nodePorts, opp,
} from '../model/types';
import { boundaryEdges, cellSet, insetCells, linkOpening, parseCell, platformInsets } from '../model/platform';
import type { Dir } from '../model/types';

export type MatName =
  | 'FloorTopBorder' | 'FloorTopBorderless' | 'FloorTopFlat'
  | 'FloorTopProfil' | 'FloorTopProfilFlat' | 'FloorSide';

export type V3 = [number, number, number];
export type V2 = [number, number];

export interface MeshPart { pos: number[]; uv: number[] }
export interface ElemMesh {
  /** 元素 id（节点或直道） */
  id: number;
  kind: 'seg' | 'node';
  parts: Partial<Record<MatName, MeshPart>>;
}

class MeshBuilder {
  parts: Partial<Record<MatName, MeshPart>> = {};

  /** 按期望朝外的法线自动修正绕序 */
  tri(mat: MatName, p: [V3, V3, V3], uv: [V2, V2, V2], outward: V3) {
    const e1 = sub(p[1], p[0]), e2 = sub(p[2], p[0]);
    const n = cross(e1, e2);
    if (Math.hypot(...n) < 1e-9) return;
    if (dot(n, outward) < 0) { p = [p[0], p[2], p[1]]; uv = [uv[0], uv[2], uv[1]]; }
    const part = (this.parts[mat] ??= { pos: [], uv: [] });
    for (let i = 0; i < 3; i++) { part.pos.push(...p[i]); part.uv.push(...uv[i]); }
  }

  quad(mat: MatName, p: [V3, V3, V3, V3], uv: [V2, V2, V2, V2], outward: V3) {
    this.tri(mat, [p[0], p[1], p[2]], [uv[0], uv[1], uv[2]], outward);
    this.tri(mat, [p[0], p[2], p[3]], [uv[0], uv[2], uv[3]], outward);
  }
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const UP: V3 = [0, 0, 1];

// ---------------- 直道链：保证接头两侧纹理连续 ----------------

interface ChainInfo { off: number; rev: boolean }

function len3(m: Model, s: Seg) {
  return Math.hypot(s.len, endZ(m, s, 'b') - endZ(m, s, 'a'));
}

/** 沿接头相连的直道共享一条连续的 v 坐标 */
export function computeChains(m: Model): Map<number, ChainInfo> {
  const res = new Map<number, ChainInfo>();
  const jointNext = (segId: number, k: EndKey): { seg: Seg; key: EndKey } | null => {
    const e = m.segs[segId][k];
    if (isFree(e)) return null;
    const n = m.nodes[e.node];
    if (!n || n.kind !== 'joint') return null;
    for (const p of nodePorts(m, n.id)) if (p && p.seg !== segId) return { seg: m.segs[p.seg], key: p.key };
    return null;
  };
  for (const s0 of Object.values(m.segs)) {
    if (res.has(s0.id)) continue;
    // 先往 a 端回溯到链头
    let cur = s0, entry: EndKey = 'a';
    const guard = new Set<number>([s0.id]);
    for (;;) {
      const prev = jointNext(cur.id, entry);
      if (!prev || guard.has(prev.seg.id)) break;
      guard.add(prev.seg.id);
      cur = prev.seg;
      entry = prev.key === 'a' ? 'b' : 'a';
    }
    // 再顺着链走，累计长度
    let off = 0;
    for (;;) {
      if (res.has(cur.id)) break;
      res.set(cur.id, { off, rev: entry === 'b' });
      off += len3(m, cur);
      const exit: EndKey = entry === 'a' ? 'b' : 'a';
      const next = jointNext(cur.id, exit);
      if (!next) break;
      cur = next.seg;
      entry = next.key;
    }
  }
  return res;
}

// ---------------- 直道 ----------------

function buildSeg(mb: MeshBuilder, m: Model, s: Seg, chain: ChainInfo) {
  if (s.len < 1e-6) return;
  const D: V2 = [DX[s.dir], DY[s.dir]];
  const P: V2 = [-D[1], D[0]]; // 左侧
  const za = endZ(m, s, 'a'), zb = endZ(m, s, 'b');
  const zf = (t: number) => za + ((zb - za) * t) / s.len;
  const k3 = Math.hypot(s.len, zb - za) / s.len;
  const vAt = (t: number) => (chain.rev ? chain.off + (s.len - t) * k3 : chain.off + t * k3) / 5;
  const pt = (t: number, l: number, dz = 0): V3 => [s.x + D[0] * t + P[0] * l, s.y + D[1] * t + P[1] * l, zf(t) + dz];
  const sink = s.style === 'sink' ? SINK_DEPTH : 0;
  const topMat: MatName = sink ? 'FloorTopProfil' : 'FloorTopBorder';
  const closedA = isFree(s.a) && s.a.style === 'closed';
  const closedB = isFree(s.b) && s.b.style === 'closed';
  // 封闭端各占 2.5；路段太短时按比例压缩
  const cap = closedA && closedB ? Math.min(HALF, s.len / 2) : Math.min(HALF, s.len);
  const t0 = closedA ? cap : 0;
  const t1 = closedB ? s.len - cap : s.len;

  // 顶面：左右两条边框带
  if (t1 > t0 + 1e-9) {
    for (const side of [1, -1]) {
      mb.quad(topMat,
        [pt(t0, side * HALF), pt(t1, side * HALF), pt(t1, 0, -sink), pt(t0, 0, -sink)],
        [[0, vAt(t0)], [0, vAt(t1)], [0.5, vAt(t1)], [0.5, vAt(t0)]], UP);
    }
  }
  // 封闭端：两个外角
  const outerCorner = (tEnd: number, tIn: number) => {
    for (const side of [1, -1]) {
      const C = pt(tEnd, side * HALF), A1 = pt(tEnd, 0), A2 = pt(tIn, side * HALF), O = pt(tIn, 0, -sink);
      mb.tri(topMat, [C, A1, O], [[0, 0.5], [0, 0], [0.5, 0]], UP);
      mb.tri(topMat, [C, O, A2], [[0, 0.5], [0.5, 0], [0, 0]], UP);
    }
  };
  if (closedA) outerCorner(0, cap);
  if (closedB) outerCorner(s.len, s.len - cap);

  // 侧面
  for (const side of [1, -1]) {
    const out: V3 = [P[0] * side, P[1] * side, 0];
    mb.quad('FloorSide',
      [pt(0, side * HALF), pt(s.len, side * HALF), pt(s.len, side * HALF, -THICK), pt(0, side * HALF, -THICK)],
      [[0, vAt(0)], [0, vAt(s.len)], [THICK / 5, vAt(s.len)], [THICK / 5, vAt(0)]], out);
  }
  // 自由端的端面
  for (const k of ['a', 'b'] as EndKey[]) {
    const e = s[k];
    if (!isFree(e)) continue;
    const t = k === 'a' ? 0 : s.len;
    const sg = k === 'a' ? -1 : 1;
    const out: V3 = [D[0] * sg, D[1] * sg, 0];
    const notch = e.style === 'open' ? sink : 0;
    endFace(mb, pt(t, HALF), pt(t, 0, -notch), pt(t, -HALF), notch, out);
  }
}

/** 端面 / 侧面：左角 L、中点 M（可能下沉）、右角 R */
function endFace(mb: MeshBuilder, L: V3, M: V3, R: V3, notch: number, out: V3) {
  const bottomZ = L[2] - THICK;
  const Lb: V3 = [L[0], L[1], bottomZ], Mb: V3 = [M[0], M[1], bottomZ], Rb: V3 = [R[0], R[1], bottomZ];
  const uL = THICK / 5, uM = (THICK - notch) / 5;
  mb.quad('FloorSide', [L, M, Mb, Lb], [[0, 0], [0, 0.5], [uM, 0.5], [uL, 0]], out);
  mb.quad('FloorSide', [M, R, Rb, Mb], [[0, 0.5], [0, 1], [uL, 1], [uM, 0.5]], out);
}

// ---------------- 路块 ----------------

function buildBlock(mb: MeshBuilder, m: Model, n: MNode) {
  const ports = nodePorts(m, n.id).map((p) => !!p);
  const sink = n.style === 'sink' ? SINK_DEPTH : 0;
  const mat: MatName = sink ? 'FloorTopProfil' : 'FloorTopBorder';
  const cx = n.x, cy = n.y, z = n.z;
  for (const [sx, sy] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    const borderX = !ports[sx > 0 ? 0 : 2];
    const borderY = !ports[sy > 0 ? 1 : 3];
    // C：路块角点，O：路块中心，Ax：x 侧边中点，Ay：y 侧边中点
    let uv: { C: V2; Ax: V2; Ay: V2; O: V2 };
    if (borderX && borderY) uv = { C: [0, 0.5], Ax: [0, 0], Ay: [0, 0], O: [0.5, 0] };       // 外角
    else if (!borderX && !borderY) uv = { C: [0, 0], Ax: [0.5, 0], Ay: [0.5, 0], O: [0.5, 0.5] }; // 内角
    else if (borderX) uv = { C: [0, 0.5], Ax: [0, 0], Ay: [0.5, 0.5], O: [0.5, 0] };          // 沿 y 的边框带
    else uv = { C: [0, 0.5], Ay: [0, 0], Ax: [0.5, 0.5], O: [0.5, 0] };                       // 沿 x 的边框带
    const h = (u: V2) => z - sink * (u[0] / 0.5);
    const C: V3 = [cx + HALF * sx, cy + HALF * sy, h(uv.C)];
    const Ax: V3 = [cx + HALF * sx, cy, h(uv.Ax)];
    const Ay: V3 = [cx, cy + HALF * sy, h(uv.Ay)];
    const O: V3 = [cx, cy, h(uv.O)];
    mb.tri(mat, [C, Ax, O], [uv.C, uv.Ax, uv.O], UP);
    mb.tri(mat, [C, O, Ay], [uv.C, uv.O, uv.Ay], UP);
  }
  // 没有连接的一侧是外沿，需要侧面
  for (let d = 0; d < 4; d++) {
    if (ports[d]) continue;
    const ox = DX[d], oy = DY[d];
    const px = -oy, py = ox;
    const ex = cx + ox * HALF, ey = cy + oy * HALF;
    const L: V3 = [ex + px * HALF, ey + py * HALF, z];
    const R: V3 = [ex - px * HALF, ey - py * HALF, z];
    const M: V3 = [ex, ey, z];
    endFace(mb, L, M, R, 0, [ox, oy, 0]);
  }
}

// ---------------- 平凹转换块 ----------------

function buildTransition(mb: MeshBuilder, m: Model, n: MNode) {
  // 局部坐标：凹槽一侧在 lx=0，平路一侧在 lx=5；ly 横跨路宽
  const sd = n.sinkDir!;
  const a: V2 = [DX[opp(sd)], DY[opp(sd)]]; // 凹槽 -> 平路
  const p: V2 = [-a[1], a[0]];
  // 窄转换（BME floor_narrow_transition）：沿长度方向缩放 0.5，UV 不变
  const sx = n.narrow ? 0.5 : 1;
  const L = (lx: number, ly: number, lz: number): V3 =>
    [n.x + a[0] * (lx - HALF) * sx + p[0] * (ly - HALF), n.y + a[1] * (lx - HALF) * sx + p[1] * (ly - HALF), n.z + lz];
  // ramp：半块平路（普通路接凹槽平台），平台内侧（lx=0）整条边下沉 0.7
  const cz = n.ramp ? -SINK_DEPTH : 0;
  if (n.ramp) {
    for (const e0 of [0, 5]) {
      // 两条边框带：从路边沿（u=0）到中线（u=0.5），v 沿路方向
      const E0 = L(0, e0, cz), E1 = L(5, e0, 0), M1 = L(5, 2.5, 0), M0 = L(0, 2.5, cz);
      mb.quad('FloorTopBorder', [E0, E1, M1, M0], [[0, 0], [0, 0.5], [0.5, 0.5], [0.5, 0]], UP);
    }
  } else {
    const v0 = L(0, 0, 0), v1 = L(5, 0, 0), v2 = L(0, 2.5, -SINK_DEPTH), v3 = L(5, 5, 0), v4 = L(0, 5, 0);
    mb.tri('FloorTopProfilFlat', [v0, v1, v2], [[0, 1], [0, 0], [0.5, 1]], UP);
    mb.tri('FloorTopProfilFlat', [v3, v2, v1], [[1, 0], [0.5, 1], [0, 0]], UP);
    mb.tri('FloorTopProfilFlat', [v2, v3, v4], [[0.5, 1], [1, 0], [1, 1]], UP);
  }
  // 两条侧边
  for (const [ly, sg] of [[0, -1], [5, 1]] as const) {
    const A = L(0, ly, cz), B = L(5, ly, 0);
    const out: V3 = [p[0] * sg, p[1] * sg, 0];
    const Ab: V3 = [A[0], A[1], A[2] - THICK], Bb: V3 = [B[0], B[1], B[2] - THICK];
    mb.quad('FloorSide', [A, B, Bb, Ab], [[0, 0], [0, sx], [1, sx], [1, 0]], out);
  }
  // 端口如果没有连接，补端面
  const ports = nodePorts(m, n.id);
  for (const [d, notch] of [[sd, SINK_DEPTH], [opp(sd), 0]] as const) {
    if (ports[d]) continue;
    const ox = DX[d], oy = DY[d];
    const px = -oy, py = ox;
    const h = n.narrow ? HALF / 2 : HALF;
    const ex = n.x + ox * h, ey = n.y + oy * h;
    endFace(mb, [ex + px * HALF, ey + py * HALF, n.z], [ex, ey, n.z - notch], [ex - px * HALF, ey - py * HALF, n.z], notch, [ox, oy, 0]);
  }
}

// ---------------- 平台 ----------------

interface BSeg { x0: number; y0: number; x1: number; y1: number; hor: boolean }
interface Run { along: 0 | 1; out: number; line: number; from: number; to: number }

function distToSeg(px: number, py: number, b: BSeg) {
  const dx = b.x1 - b.x0, dy = b.y1 - b.y0;
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - b.x0) * dx + (py - b.y0) * dy) / l2)) : 0;
  return Math.hypot(px - (b.x0 + dx * t), py - (b.y0 + dy * t));
}

/** 把同一直线上相邻的单位边合并成长边 */
function mergeRuns(edges: { x: number; y: number; along: 0 | 1; out: number }[]): Run[] {
  const groups = new Map<string, number[]>();
  for (const e of edges) {
    const key = [e.along, e.out, e.along === 0 ? e.y : e.x].join('|');
    let g = groups.get(key);
    if (!g) groups.set(key, (g = []));
    g.push(e.along === 0 ? e.x : e.y);
  }
  const runs: Run[] = [];
  for (const [key, list] of groups) {
    const [along, out, line] = key.split('|').map(Number);
    list.sort((a, b) => a - b);
    let from = list[0], to = list[0] + CELL;
    for (let i = 1; i <= list.length; i++) {
      if (i < list.length && Math.abs(list[i] - to) < 1e-6) { to += CELL; continue; }
      runs.push({ along: along as 0 | 1, out, line, from, to });
      if (i < list.length) { from = list[i]; to = list[i] + CELL; }
    }
  }
  return runs;
}

/**
 * 平台顶面：每个顶点的 u = min(到边界的距离, 2.5) / 5，与 BME 的边框 / 内外角规则一致；
 * 距边界 2.5 以外的部分用无边框贴图，并按行合并成大面。
 */
function buildPlatform(mb: MeshBuilder, m: Model, n: MNode) {
  const cells = cellSet(n);
  const sink = n.style === 'sink' ? SINK_DEPTH : 0;
  const ribbon = !!n.ribbon && !!sink;
  const bandMat: MatName = ribbon ? 'FloorTopFlat' : sink ? 'FloorTopProfil' : 'FloorTopBorder';
  const z0 = n.z;

  // 嵌入的窄转换：所占小格不画，外沿处作为开口；平台边框照常延续，不补道路边沿延长线
  const insets = platformInsets(m, n.id);
  const insetLinks = new Set(insets.map((i) => i.link));
  const skip = new Set(insets.flatMap((i) => insetCells(i)));
  // 开口：从边界中扣掉，并补上道路两侧边沿的延长线
  // 同样式的路面接平台：开口处往里 2.5 的带子由两块 1/4 内角拼成（与 T 字路口一致），平台边框直线延续
  const cornerOpenings: { x: number; y: number; out: Dir }[] = [];
  const roadOpenings: { x: number; y: number; out: Dir }[] = [];
  for (const l of nodeLinks(m, n.id)) {
    if (insetLinks.has(l.seg)) continue;
    const o = linkOpening(m.segs[l.seg], l.key);
    const notch = insetCells({ tr: n, link: -1, out: o.out, ox: o.x, oy: o.y });
    if (m.segs[l.seg].style === n.style && notch.every((c) => cells.has(c))) {
      cornerOpenings.push(o);
      for (const c of notch) skip.add(c);
    } else roadOpenings.push(o);
  }
  const openings = [...roadOpenings, ...cornerOpenings, ...insets.map((i) => ({ x: i.ox, y: i.oy, out: i.out }))];
  const inOpening = (e: { x: number; y: number; along: 0 | 1; out: number }) => openings.some((o) => {
    if (o.out !== e.out) return false;
    if (e.along === 1) return Math.abs(e.x - o.x) < 1e-6 && e.y >= o.y - HALF - 1e-6 && e.y + CELL <= o.y + HALF + 1e-6;
    return Math.abs(e.y - o.y) < 1e-6 && e.x >= o.x - HALF - 1e-6 && e.x + CELL <= o.x + HALF + 1e-6;
  });
  const runs = mergeRuns(boundaryEdges(cells).filter((e) => !inOpening(e)));
  const bsegs: BSeg[] = runs.map((r) => r.along === 0
    ? { x0: r.from, y0: r.line, x1: r.to, y1: r.line, hor: true }
    : { x0: r.line, y0: r.from, x1: r.line, y1: r.to, hor: false });
  for (const o of roadOpenings) {
    const ox = DX[o.out], oy = DY[o.out], px = -oy, py = ox;
    for (const sg of [1, -1]) {
      const cx = o.x + px * HALF * sg, cy = o.y + py * HALF * sg;
      bsegs.push({ x0: cx, y0: cy, x1: cx + ox * 3, y1: cy + oy * 3, hor: oy === 0 });
    }
  }
  const near = (x: number, y: number) => {
    let d = Infinity, hor = true;
    for (const b of bsegs) {
      if (Math.min(b.x0, b.x1) - x > HALF || x - Math.max(b.x0, b.x1) > HALF) continue;
      if (Math.min(b.y0, b.y1) - y > HALF || y - Math.max(b.y0, b.y1) > HALF) continue;
      const dd = distToSeg(x, y, b);
      if (dd < d) { d = dd; hor = b.hor; }
    }
    return { d: Math.min(d, HALF), hor };
  };
  const uCache = new Map<string, number>();
  const uAt = (i: number, j: number) => {
    const k = `${i},${j}`;
    let u = uCache.get(k);
    if (u === undefined) { u = near(i * CELL, j * CELL).d / 5; uCache.set(k, u); }
    return u;
  };
  const uScale = ribbon ? 2 : 1;
  // 开口带的两块 1/4：
  //   平台外沿在角点 C 之外还继续 → 内角块（边框在 C 处拐进路面）；
  //   C 之外已没有平台（路的边沿与平台侧边共线）→ 直的边框条，纹路顺着侧边延续。
  for (const o of cornerOpenings) {
    const inward = opp(o.out);
    const px = -DY[o.out], py = DX[o.out];
    const zi = z0 - sink;
    const uv = (u: number, v: number): V2 => [u * uScale, v];
    for (const sg of [1, -1]) {
      const C: V3 = [o.x + px * HALF * sg, o.y + py * HALF * sg, z0];
      const A1: V3 = [o.x, o.y, zi];
      const O: V3 = [o.x + DX[inward] * HALF, o.y + DY[inward] * HALF, zi];
      const qx = C[0] + px * sg * CELL / 2 + DX[inward] * CELL / 2, qy = C[1] + py * sg * CELL / 2 + DY[inward] * CELL / 2;
      const continues = cells.has(`${Math.floor(qx / CELL)},${Math.floor(qy / CELL)}`);
      if (continues) {
        const A2: V3 = [C[0] + DX[inward] * HALF, C[1] + DY[inward] * HALF, zi];
        mb.tri(bandMat, [C, A1, O], [uv(0, 0), uv(0.5, 0), uv(0.5, 0.5)], UP);
        mb.tri(bandMat, [C, O, A2], [uv(0, 0), uv(0.5, 0.5), uv(0.5, 0)], UP);
      } else {
        // 边框沿 C—C' 这条侧边（u=0），中线 A1—O（u=0.5），v 沿进深方向
        const C2: V3 = [C[0] + DX[inward] * HALF, C[1] + DY[inward] * HALF, z0];
        mb.quad(bandMat, [C, C2, O, A1], [uv(0, 0), uv(0, 0.5), uv(0.5, 0.5), uv(0.5, 0)], UP);
      }
    }
  }
  const interior: [number, number][] = [];
  for (const key of cells) {
    if (skip.has(key)) continue;
    const [i, j] = parseCell(key);
    const c = [[i, j], [i + 1, j], [i + 1, j + 1], [i, j + 1]];
    const us = c.map(([a, b]) => uAt(a, b));
    if (us.every((u) => u >= 0.5 - 1e-9)) { interior.push([i, j]); continue; }
    // 选择与真实距离场更吻合的对角线（让外角 / 内角的折痕落在对角线上）
    const uc = near((i + 0.5) * CELL, (j + 0.5) * CELL).d / 5;
    const diag02 = Math.abs((us[0] + us[2]) / 2 - uc) <= Math.abs((us[1] + us[3]) / 2 - uc);
    const tris = diag02 ? [[0, 1, 2], [0, 2, 3]] : [[0, 1, 3], [1, 2, 3]];
    for (const t of tris) {
      const pts = t.map((q) => [c[q][0] * CELL, c[q][1] * CELL, us[q]]);
      const hor = near((pts[0][0] + pts[1][0] + pts[2][0]) / 3, (pts[0][1] + pts[1][1] + pts[2][1]) / 3).hor;
      const P = pts.map(([x, y, u]) => [x, y, z0 - sink * (u / 0.5)] as V3);
      const UV = pts.map(([x, y, u]) => [u * uScale, (hor ? x : y) / 5] as V2);
      mb.tri(bandMat, [P[0], P[1], P[2]], [UV[0], UV[1], UV[2]], UP);
    }
  }
  // 内部：按行合并成长条
  const rows = new Map<number, number[]>();
  for (const [i, j] of interior) { let r = rows.get(j); if (!r) rows.set(j, (r = [])); r.push(i); }
  const zi = z0 - sink;
  for (const [j, list] of rows) {
    list.sort((a, b) => a - b);
    let s0 = list[0], prev = list[0];
    for (let q = 1; q <= list.length; q++) {
      if (q < list.length && list[q] === prev + 1) { prev = list[q]; continue; }
      const x0 = s0 * CELL, x1 = (prev + 1) * CELL, y0 = j * CELL, y1 = (j + 1) * CELL;
      mb.quad('FloorTopBorderless', [[x0, y0, zi], [x1, y0, zi], [x1, y1, zi], [x0, y1, zi]],
        [[x0 / 5, y0 / 5], [x1 / 5, y0 / 5], [x1 / 5, y1 / 5], [x0 / 5, y1 / 5]], UP);
      if (q < list.length) { s0 = list[q]; prev = list[q]; }
    }
  }
  // 侧面
  for (const r of runs) {
    const out: V3 = [DX[r.out], DY[r.out], 0];
    const A: V3 = r.along === 0 ? [r.from, r.line, z0] : [r.line, r.from, z0];
    const B: V3 = r.along === 0 ? [r.to, r.line, z0] : [r.line, r.to, z0];
    const Ab: V3 = [A[0], A[1], z0 - THICK], Bb: V3 = [B[0], B[1], z0 - THICK];
    mb.quad('FloorSide', [A, B, Bb, Ab], [[0, r.from / 5], [0, r.to / 5], [THICK / 5, r.to / 5], [THICK / 5, r.from / 5]], out);
  }
}

// ---------------- 汇总 ----------------

export type Chains = Map<number, ChainInfo>;

/** 元素几何的缓存键：只要键不变，网格就不需要重建 */
export function elemKey(m: Model, id: number, chains: Chains): string {
  const s = m.segs[id];
  if (s) return JSON.stringify([s, endZ(m, s, 'a'), endZ(m, s, 'b'), chains.get(id)]);
  const n = m.nodes[id];
  if (!n) return '';
  if (n.kind === 'platform') return JSON.stringify([n, nodeLinks(m, id).map((l) => linkOpening(m.segs[l.seg], l.key)), platformInsets(m, id).map((i) => i.tr.id)]);
  // 相连直道的样式也会影响形状（例如平台里的衔接块要和路的截面对齐）
  return JSON.stringify([n, nodePorts(m, id).map((p) => (p ? m.segs[p.seg].style : null))]);
}

export function buildElem(m: Model, id: number, chains: Chains): ElemMesh | null {
  const mb = new MeshBuilder();
  const s = m.segs[id];
  if (s) {
    buildSeg(mb, m, s, chains.get(id) ?? { off: 0, rev: false });
    return { id, kind: 'seg', parts: mb.parts };
  }
  const n = m.nodes[id];
  if (!n || n.kind === 'joint' || n.kind === 'checkpoint') return null;
  if (n.kind === 'block') buildBlock(mb, m, n);
  else if (n.kind === 'platform') buildPlatform(mb, m, n);
  else buildTransition(mb, m, n);
  return { id, kind: 'node', parts: mb.parts };
}

export function buildFloorMeshes(m: Model): ElemMesh[] {
  const chains = computeChains(m);
  const ids = [...Object.keys(m.segs), ...Object.keys(m.nodes)].map(Number);
  return ids.map((id) => buildElem(m, id, chains)).filter((e): e is ElemMesh => !!e);
}
