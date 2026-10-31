// 路面网格生成：按四分之一格（2.5×2.5）判断边框，自动分配材质与 UV。
// UV 规则沿用 BBP / BME 原型：边框贴图 u=0 在路外沿、u=0.5 在路中线，v 方向每 5 个单位走 1。
// UV 采用 Virtools 约定（v 向下），预览时贴图关闭 flipY 即可对齐。
import {
  DX, DY, EndKey, HALF, MNode, Model, SINK_DEPTH, Seg, THICK,
  endZ, isFree, nodePorts, opp,
} from '../model/types';

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
  const t0 = closedA ? HALF : 0;
  const t1 = closedB ? s.len - HALF : s.len;

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
  if (closedA) outerCorner(0, HALF);
  if (closedB) outerCorner(s.len, s.len - HALF);

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
  const L = (lx: number, ly: number, lz: number): V3 =>
    [n.x + a[0] * (lx - HALF) + p[0] * (ly - HALF), n.y + a[1] * (lx - HALF) + p[1] * (ly - HALF), n.z + lz];
  const v0 = L(0, 0, 0), v1 = L(5, 0, 0), v2 = L(0, 2.5, -SINK_DEPTH), v3 = L(5, 5, 0), v4 = L(0, 5, 0);
  mb.tri('FloorTopProfilFlat', [v0, v1, v2], [[0, 1], [0, 0], [0.5, 1]], UP);
  mb.tri('FloorTopProfilFlat', [v3, v2, v1], [[1, 0], [0.5, 1], [0, 0]], UP);
  mb.tri('FloorTopProfilFlat', [v2, v3, v4], [[0.5, 1], [1, 0], [1, 1]], UP);
  // 两条侧边
  for (const [ly, sg] of [[0, -1], [5, 1]] as const) {
    const A = L(0, ly, 0), B = L(5, ly, 0);
    const out: V3 = [p[0] * sg, p[1] * sg, 0];
    const Ab: V3 = [A[0], A[1], A[2] - THICK], Bb: V3 = [B[0], B[1], B[2] - THICK];
    mb.quad('FloorSide', [A, B, Bb, Ab], [[0, 0], [0, 1], [1, 1], [1, 0]], out);
  }
  // 端口如果没有连接，补端面
  const ports = nodePorts(m, n.id);
  for (const [d, notch] of [[sd, SINK_DEPTH], [opp(sd), 0]] as const) {
    if (ports[d]) continue;
    const ox = DX[d], oy = DY[d];
    const px = -oy, py = ox;
    const ex = n.x + ox * HALF, ey = n.y + oy * HALF;
    endFace(mb, [ex + px * HALF, ey + py * HALF, n.z], [ex, ey, n.z - notch], [ex - px * HALF, ey - py * HALF, n.z], notch, [ox, oy, 0]);
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
  return JSON.stringify([n, nodePorts(m, id).map((p) => !!p)]);
}

export function buildElem(m: Model, id: number, chains: Chains): ElemMesh | null {
  const mb = new MeshBuilder();
  const s = m.segs[id];
  if (s) {
    buildSeg(mb, m, s, chains.get(id) ?? { off: 0, rev: false });
    return { id, kind: 'seg', parts: mb.parts };
  }
  const n = m.nodes[id];
  if (!n || n.kind === 'joint') return null;
  if (n.kind === 'block') buildBlock(mb, m, n);
  else buildTransition(mb, m, n);
  return { id, kind: 'node', parts: mb.parts };
}

export function buildFloorMeshes(m: Model): ElemMesh[] {
  const chains = computeChains(m);
  const ids = [...Object.keys(m.segs), ...Object.keys(m.nodes)].map(Number);
  return ids.map((id) => buildElem(m, id, chains)).filter((e): e is ElemMesh => !!e);
}
