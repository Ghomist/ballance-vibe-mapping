// 护栏：与原版一致，一整段连续的钢管——沿路面外沿走（贴着路边的外侧），拐角处圆弧过渡，
// 只在两头有立柱沿路面侧面往下插，立柱上各有一个铆钉（RailNail）；坡道上顺着坡走。
//
// 护栏是独立的对象（Model.guards）：记着起点和终点，沿路面外沿（见 outline.ts）从起点走到终点，
// 可以跨过拐角；路面改动后起止点重新投影到最近的外沿上。尺寸见全图设置（MapSettings）。
import type { PrefabPart } from '../model/checkpoint';
import { Loop, outlineLoops, pathAlong, project } from '../model/outline';
import { Guard, MapSettings, Model } from '../model/types';

const BEND = 0.8;                  // 拐弯半径
const SIDES = 8;

type P3 = [number, number, number];

const sub = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const add = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: P3, k: number): P3 => [a[0] * k, a[1] * k, a[2] * k];
const len = (a: P3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: P3): P3 => mul(a, 1 / (len(a) || 1));
const dot = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: P3, b: P3): P3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** 折线的拐角换成圆弧 */
export function fillet(poly: P3[], closed: boolean): P3[] {
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

/** 圆管一头的封盖：在 pos 里的区间（at 起 len 个数）、截面的一圈顶点、朝外的方向。导出时两根管子对接就把封盖去掉 */
export interface TubeCap { at: number; len: number; ring: number[][]; dir: number[] }

/**
 * 球形闭合：把一圈截面收成半球，和原版 RailTip 的头一样三层（截面、45°、顶点）。
 * axis 是半球顶点的方向：圆管用单位切线；竖直截面的钢轨用「水平走 1 升多少」，半球跟着管子按坡度错切
 */
export function dome(ring: number[][], c: number[], axis: number[], radius: number, out: { pos: number[]; nrm: number[] }) {
  const ctr = c as P3, up = axis as P3, q = Math.SQRT1_2, n = ring.length;
  const pts: P3[] = [...(ring as P3[]), ...(ring as P3[]).map((p) => add(add(ctr, mul(sub(p, ctr), q)), mul(up, radius * q))), add(ctr, mul(up, radius))];
  const tris: [number, number, number][] = [];
  for (let k = 0; k < n; k++) {
    const k1 = (k + 1) % n;
    tris.push([k, k1, n + k1], [k, n + k1, n + k], [n + k, n + k1, 2 * n]);
  }
  const nrm = pts.map((): P3 => [0, 0, 0]);
  for (const t of tris) {
    const [a, b, d] = t.map((i) => pts[i]);
    const f = cross(sub(b, a), sub(d, a)), mid = sub(mul(add(add(a, b), d), 1 / 3), ctr);
    if (dot(f, mid) < 0) { const x = t[1]; t[1] = t[2]; t[2] = x; }
    const g = norm(dot(f, mid) < 0 ? mul(f, -1) : f);
    for (const i of t) nrm[i] = add(nrm[i], g);
  }
  for (const t of tris) for (const i of t) { out.pos.push(...pts[i]); out.nrm.push(...norm(nrm[i])); }
}

/** 沿中心线扫出八边形截面的圆管（平滑法线），两头封口；round 是两头改成球形闭合 */
export function sweepTube(path: P3[], closed: boolean, radius: number, round: readonly boolean[] = [false, false]): { pos: number[]; nrm: number[]; caps: TubeCap[] } {
  const pos: number[] = [], nrm: number[] = [], caps: TubeCap[] = [];
  const n = path.length;
  if (n < 2) return { pos, nrm, caps };
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
      const r = rings[i], at = pos.length;
      if (round[sg < 0 ? 0 : 1]) { dome(r.map((v) => v.p), path[i], c.n, radius, { pos, nrm }); continue; }
      for (let k = 0; k < SIDES; k++) {
        const a = { p: r[k].p, n: c.n }, b = { p: r[(k + 1) % SIDES].p, n: c.n };
        if (sg < 0) tri(c, b, a); else tri(c, a, b);
      }
      caps.push({ at, len: pos.length - at, ring: r.map((v) => v.p), dir: c.n });
    }
  }
  return { pos, nrm, caps };
}

/** 护栏走过的外沿路径（起止点投影到同一个外沿环上）；放不下时返回 null */
export function guardRoute(loops: Loop[], g: Guard): { pts: P3[]; outs: [number, number][] } | null {
  const pa = project(loops, g.a);
  if (!pa || pa.dist > 3) return null;
  const pb = project([loops[pa.loop]], g.b);
  if (!pb || pb.dist > 3) return null;
  const r = pathAlong(loops[pa.loop], pa.s, pb.s);
  if (r.pts.length < 2 || !r.outs.length) return null;
  return r;
}

export interface GuardMesh { pos: number[]; nrm: number[]; nails: PrefabPart[]; route: { pts: P3[]; outs: [number, number][] } }

export function buildGuard(loops: Loop[], g: Guard, st: MapSettings): GuardMesh | null {
  const route = guardRoute(loops, g);
  return route ? guardFromRoute(route, st) : null;
}

/** 沿一段外沿路径生成护栏：钢管、两头的立柱和铆钉 */
export function guardFromRoute(route: { pts: P3[]; outs: [number, number][] }, st: MapSettings): GuardMesh | null {
  const { pts, outs } = route;
  if (pts.length < 2 || !outs.length) return null;
  // 往外偏移：拐角处取两条偏移线的交点
  const off = pts.map((p, i) => {
    const n1 = outs[Math.max(i - 1, 0)], n2 = outs[Math.min(i, outs.length - 1)];
    const d = st.guardOffset;
    const dot = n1[0] * n2[0] + n1[1] * n2[1];
    const k = d / (1 + dot || 1);
    const ox = i === 0 ? n2[0] * d : i === pts.length - 1 ? n1[0] * d : (n1[0] + n2[0]) * k;
    const oy = i === 0 ? n2[1] * d : i === pts.length - 1 ? n1[1] * d : (n1[1] + n2[1]) * k;
    return [p[0] + ox, p[1] + oy, p[2]] as P3;
  });
  const h = st.guardTop - st.guardRadius;
  const top = off.map((p) => [p[0], p[1], p[2] + h] as P3);
  const first = off[0], last = off[off.length - 1];
  const poly: P3[] = [[first[0], first[1], first[2] - st.guardPostDepth], ...top, [last[0], last[1], last[2] - st.guardPostDepth]];
  const tube = sweepTube(fillet(poly, false), false, st.guardRadius);
  const deg = (o: [number, number]) => (Math.atan2(o[1], o[0]) * 180) / Math.PI;
  const nails: PrefabPart[] = [
    { name: 'RailNail', type: 'asset', pos: [pts[0][0], pts[0][1], pts[0][2] - st.nailDepth], rotZ: deg(outs[0]) },
    { name: 'RailNail', type: 'asset', pos: [pts[pts.length - 1][0], pts[pts.length - 1][1], pts[pts.length - 1][2] - st.nailDepth], rotZ: deg(outs[outs.length - 1]) },
  ];
  return { ...tube, nails, route };
}

export function buildGuards(m: Model): Map<number, GuardMesh> {
  const loops = outlineLoops(m);
  const out = new Map<number, GuardMesh>();
  for (const g of Object.values(m.guards ?? {})) {
    const b = buildGuard(loops, g, m.settings);
    if (b) out.set(g.id, b);
  }
  return out;
}
