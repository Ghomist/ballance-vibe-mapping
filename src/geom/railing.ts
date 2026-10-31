// 护栏：与原版一致，一整段连续的钢管——沿路边走，拐角处圆弧过渡，只在两头有立柱插进路面，坡道上顺着坡走。
//
// 护栏记在路边上：直道左右侧（Seg.guard）、路块没接路的边（MNode.guardSides）。
// 生成时把所有加了护栏的边收集成线段（往路内缩 0.25，与 BarrierRail 一致），首尾相接的连成一条折线，再扫出圆管。
import { DX, DY, Dir, HALF, Model, endPos, endZ, nodePorts } from '../model/types';

export const GUARD_INSET = 0.25;
export const GUARD_HEIGHT = 5;     // 横杆中心离路面的高度（BarrierRail 顶部 5.25，管半径 0.25）
export const GUARD_RADIUS = 0.25;
const BEND = 0.8;                  // 拐弯半径
const SIDES = 8;

type P3 = [number, number, number];
interface Piece { a: P3; b: P3 }

/** 所有护栏边（每条边一段，端点在路面顶面高度） */
export function guardPieces(m: Model): Piece[] {
  const out: Piece[] = [];
  const e = HALF - GUARD_INSET;
  for (const s of Object.values(m.segs)) {
    const g = s.guard;
    if (!g || s.len < 1e-6) continue;
    const [ax, ay] = endPos(s, 'a'), [bx, by] = endPos(s, 'b');
    const za = endZ(m, s, 'a'), zb = endZ(m, s, 'b');
    const L = ((s.dir + 1) % 4) as Dir;
    for (const [on, sg] of [[g.L, 1], [g.R, -1]] as const) {
      if (!on) continue;
      const ox = DX[L] * e * sg, oy = DY[L] * e * sg;
      out.push({ a: [ax + ox, ay + oy, za], b: [bx + ox, by + oy, zb] });
    }
  }
  for (const n of Object.values(m.nodes)) {
    if (n.kind !== 'block' || !n.guardSides) continue;
    const ports = nodePorts(m, n.id);
    const on = (d: Dir) => !ports[d] && !!(n.guardSides! & (1 << d));
    for (const N of [0, 1, 2, 3] as Dir[]) {
      if (!on(N)) continue;
      const T = ((N + 1) % 4) as Dir;
      // 两头：相邻那条边也有护栏时在拐角处相交（缩进），否则伸到路块边沿（接上直道的护栏）
      const end = (t: Dir) => (on(t) ? e : HALF);
      const cx = n.x + DX[N] * e, cy = n.y + DY[N] * e;
      const ta = end(((T + 2) % 4) as Dir), tb = end(T);
      out.push({ a: [cx - DX[T] * ta, cy - DY[T] * ta, n.z], b: [cx + DX[T] * tb, cy + DY[T] * tb, n.z] });
    }
  }
  return out;
}

const key = (p: P3) => `${p[0].toFixed(2)},${p[1].toFixed(2)},${p[2].toFixed(2)}`;

/** 首尾相接的护栏边连成折线；closed 表示围成一圈 */
export function guardChains(m: Model): { pts: P3[]; closed: boolean }[] {
  const pieces = guardPieces(m);
  const at = new Map<string, number[]>();
  pieces.forEach((p, i) => { for (const q of [p.a, p.b]) { const k = key(q); at.set(k, [...(at.get(k) ?? []), i]); } });
  const used = new Set<number>();
  const chains: { pts: P3[]; closed: boolean }[] = [];
  const walk = (start: number, from: P3): P3[] => {
    const pts: P3[] = [from];
    let i = start, cur = from;
    while (true) {
      used.add(i);
      const p = pieces[i];
      const next = key(p.a) === key(cur) ? p.b : p.a;
      pts.push(next);
      cur = next;
      const nb = (at.get(key(cur)) ?? []).find((j) => !used.has(j));
      if (nb === undefined) return pts;
      i = nb;
    }
  };
  // 先从端点（只连一段）开始走，剩下的是闭合圈
  pieces.forEach((p, i) => {
    if (used.has(i)) return;
    for (const q of [p.a, p.b]) {
      if ((at.get(key(q)) ?? []).length === 1) { chains.push({ pts: walk(i, q), closed: false }); return; }
    }
  });
  pieces.forEach((p, i) => {
    if (used.has(i)) return;
    const pts = walk(i, p.a);
    pts.pop();
    chains.push({ pts, closed: true });
  });
  return chains.map((c) => ({ pts: simplify(c.pts, c.closed), closed: c.closed }));
}

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: P3, k: number): P3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: P3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: P3): P3 => mul(a, 1 / (len(a) || 1));
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** 去掉共线的中间点 */
function simplify(pts: P3[], closed: boolean): P3[] {
  const out: P3[] = [];
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) { out.push(pts[i]); continue; }
    const p = pts[(i - 1 + n) % n], c = pts[i], q = pts[(i + 1) % n];
    if (len(sub(c, p)) < 1e-6) continue;
    if (dot(norm(sub(c, p)), norm(sub(q, c))) > 1 - 1e-6) continue;
    out.push(c);
  }
  return out;
}

/** 护栏中心线：两头立柱 + 横杆，拐角处圆弧 */
export function guardPath(pts: P3[], closed: boolean): { path: P3[]; closed: boolean } {
  const top = pts.map((p) => [p[0], p[1], p[2] + GUARD_HEIGHT] as P3);
  let poly: P3[];
  if (closed) poly = top;
  else {
    // 立柱往路内收 GUARD_INSET，管子不伸出路沿
    const d0 = norm(sub(top[1], top[0])), d1 = norm(sub(top[top.length - 2], top[top.length - 1]));
    const s0 = add(pts[0], mul([d0[0], d0[1], 0], GUARD_INSET)), s1 = add(pts[pts.length - 1], mul([d1[0], d1[1], 0], GUARD_INSET));
    top[0] = [s0[0], s0[1], top[0][2] + d0[2] * GUARD_INSET];
    top[top.length - 1] = [s1[0], s1[1], top[top.length - 1][2] + d1[2] * GUARD_INSET];
    poly = [[s0[0], s0[1], pts[0][2] - 0.05], ...top, [s1[0], s1[1], pts[pts.length - 1][2] - 0.05]];
  }
  return { path: fillet(poly, closed), closed };
}

/** 折线的拐角换成圆弧 */
function fillet(poly: P3[], closed: boolean): P3[] {
  const n = poly.length;
  const out: P3[] = [];
  for (let i = 0; i < n; i++) {
    const c = poly[i];
    if (!closed && (i === 0 || i === n - 1)) { out.push(c); continue; }
    const p = poly[(i - 1 + n) % n], q = poly[(i + 1) % n];
    const u = norm(sub(p, c)), v = norm(sub(q, c));
    const ang = Math.acos(Math.max(-1, Math.min(1, dot(u, v))));
    if (Math.PI - ang < 1e-3) { out.push(c); continue; }
    // 切点离拐点的距离，不超过两边各一半
    let t = BEND / Math.tan(ang / 2);
    t = Math.min(t, len(sub(p, c)) / 2, len(sub(q, c)) / 2);
    const r = t * Math.tan(ang / 2);
    const a = add(c, mul(u, t)), b = add(c, mul(v, t));
    const bis = norm(add(u, v));
    const center = add(c, mul(bis, r / Math.sin(ang / 2)));
    const steps = 6;
    const va = sub(a, center), vb = sub(b, center);
    const theta = Math.acos(Math.max(-1, Math.min(1, dot(norm(va), norm(vb)))));
    for (let k = 0; k <= steps; k++) {
      const f = k / steps;
      // 球面插值（两向量等长）
      const s = Math.sin(theta) || 1;
      const w0 = Math.sin((1 - f) * theta) / s, w1 = Math.sin(f * theta) / s;
      out.push(add(center, add(mul(va, w0), mul(vb, w1))));
    }
  }
  return out;
}

/** 沿中心线扫出八边形截面的圆管（平滑法线），两头封口 */
export function sweepTube(path: P3[], closed: boolean, radius = GUARD_RADIUS): { pos: number[]; nrm: number[] } {
  const pos: number[] = [], nrm: number[] = [];
  const n = path.length;
  if (n < 2) return { pos, nrm };
  const tan = path.map((_, i) => {
    const a = path[closed ? (i - 1 + n) % n : Math.max(i - 1, 0)], b = path[closed ? (i + 1) % n : Math.min(i + 1, n - 1)];
    return norm(sub(b, a));
  });
  // 平行移动的标架，避免截面扭转
  let nv = Math.abs(tan[0][2]) < 0.9 ? norm(cross(tan[0], [0, 0, 1])) : norm(cross(tan[0], [1, 0, 0]));
  const rings: { p: P3; n: P3 }[][] = [];
  for (let i = 0; i < n; i++) {
    if (i > 0) { nv = norm(cross(cross(tan[i], nv), tan[i])); if (len(nv) < 1e-6) nv = norm(cross(tan[i], [0, 0, 1])); }
    const bv = cross(tan[i], nv);
    const ring: { p: P3; n: P3 }[] = [];
    for (let k = 0; k < SIDES; k++) {
      const a = (k / SIDES) * Math.PI * 2;
      const d = add(mul(nv, Math.cos(a)), mul(bv, Math.sin(a)));
      ring.push({ p: add(path[i], mul(d, radius)), n: d });
    }
    rings.push(ring);
  }
  const tri = (a: { p: P3; n: P3 }, b: { p: P3; n: P3 }, c: { p: P3; n: P3 }) => {
    for (const v of [a, b, c]) { pos.push(...v.p); nrm.push(...v.n); }
  };
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const r0 = rings[i], r1 = rings[(i + 1) % n];
    for (let k = 0; k < SIDES; k++) {
      const k1 = (k + 1) % SIDES;
      tri(r0[k], r1[k1], r1[k]);
      tri(r0[k], r0[k1], r1[k1]);
    }
  }
  if (!closed) {
    for (const [i, sg] of [[0, -1], [n - 1, 1]] as const) {
      const c = { p: path[i], n: mul(tan[i], sg) };
      const r = rings[i];
      for (let k = 0; k < SIDES; k++) {
        const a = { p: r[k].p, n: c.n }, b = { p: r[(k + 1) % SIDES].p, n: c.n };
        if (sg < 0) tri(c, b, a); else tri(c, a, b);
      }
    }
  }
  return { pos, nrm };
}

export function buildGuards(m: Model): { pos: number[]; nrm: number[] }[] {
  return guardChains(m).map((c) => { const p = guardPath(c.pts, c.closed); return sweepTube(p.path, p.closed); });
}
