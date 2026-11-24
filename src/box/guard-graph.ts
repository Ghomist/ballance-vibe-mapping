// 护栏走的「路沿图」：所有外沿环的边，加上跨过断开处的跳线。
// 跳线：一条外沿边在拐角处断了（环在这里拐弯或者到头），顺着这条边往前同一条直线上、40 以内，另一条朝外方向相同的边接着开始，
// 就用直线把两头连起来（中间是空的，护栏悬空跨过去）。只连顺着同一条直线继续的，斜着错开的不连。
// 护栏的路线就是图上两点之间最短的那条路：拖把手、沿路边拖、路面改了以后跟着走都按这个来。
import { type Loop, type P3 } from '../model/outline';

/** 跳线最长多少 */
export const MAX_JUMP = 40;

export interface GEdge { u: number; v: number; a: P3; b: P3; out: [number, number]; len: number; jump: boolean; soft: boolean }
export interface Graph {
  nodes: P3[];
  edges: GEdge[];
  /** 每个点连着哪些边 */
  adj: number[][];
  /** 环 li 的第 si 段是哪条边 */
  segEdge: Map<string, number>;
}
/** 图上的一个位置：在第 e 条边上，从 a 往 b 走了 t（0～1） */
export interface GPos { e: number; t: number }

const key = (p: P3) => `${p[0].toFixed(3)},${p[1].toFixed(3)},${p[2].toFixed(3)}`;
const hlen = (a: P3, b: P3) => Math.hypot(b[0] - a[0], b[1] - a[1]);

const cache = new WeakMap<Loop[], Graph>();
/** 外沿环 → 路沿图（同一组环只建一次） */
export function graphOf(loops: Loop[]): Graph {
  let g = cache.get(loops);
  if (!g) { g = buildGraph(loops); cache.set(loops, g); }
  return g;
}

function buildGraph(loops: Loop[]): Graph {
  const nodes: P3[] = [], index = new Map<string, number>();
  const node = (p: P3) => { const k = key(p); let i = index.get(k); if (i === undefined) { i = nodes.length; nodes.push(p); index.set(k, i); } return i; };
  const edges: GEdge[] = [];
  const segEdge = new Map<string, number>();
  loops.forEach((l, li) => {
    for (let si = 0; si < l.outs.length; si++) {
      const a = l.pts[si], b = l.pts[(si + 1) % l.pts.length];
      segEdge.set(`${li}:${si}`, edges.length);
      edges.push({ u: node(a), v: node(b), a, b, out: l.outs[si], len: hlen(a, b), jump: false, soft: !!l.soft?.[si] });
    }
  });
  // 跳线：从每条边的终点顺着它的方向往前找
  const real = edges.length;
  // 只有朝外方向相同、在同一条直线上的边才可能接上：按这两样分桶
  const lineKey = (e: GEdge) => `${e.out[0].toFixed(4)},${e.out[1].toFixed(4)},${(e.a[0] * e.out[0] + e.a[1] * e.out[1]).toFixed(2)}`;
  const buckets = new Map<string, number[]>();
  for (let j = 0; j < real; j++) { const k = lineKey(edges[j]); (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(j); }
  const startsAt = new Map<number, number[]>();
  for (let j = 0; j < real; j++) (startsAt.get(edges[j].u) ?? startsAt.set(edges[j].u, []).get(edges[j].u)!).push(j);
  for (let i = 0; i < real; i++) {
    const e = edges[i];
    if (e.len < 1e-6) continue;
    const tx = (e.b[0] - e.a[0]) / e.len, ty = (e.b[1] - e.a[1]) / e.len;
    // 终点处接着同方向的边（没断）：不用跳
    if ((startsAt.get(e.v) ?? []).some((j) => { const f = edges[j]; return j !== i && Math.abs((f.b[0] - f.a[0]) / f.len - tx) < 1e-6 && Math.abs((f.b[1] - f.a[1]) / f.len - ty) < 1e-6; })) continue;
    let best = -1, bd = Infinity;
    for (const j of buckets.get(lineKey(e)) ?? []) {
      const f = edges[j];
      if (j === i || f.len < 1e-6 || f.u === e.v) continue;
      // 朝外方向相同、方向相同
      if (Math.abs(f.out[0] - e.out[0]) > 1e-6 || Math.abs(f.out[1] - e.out[1]) > 1e-6) continue;
      if (Math.abs((f.b[0] - f.a[0]) / f.len - tx) > 1e-6 || Math.abs((f.b[1] - f.a[1]) / f.len - ty) > 1e-6) continue;
      // f 的起点在 e 的延长线上、前方 40 以内
      const dx = f.a[0] - e.b[0], dy = f.a[1] - e.b[1];
      const along = dx * tx + dy * ty, side = Math.abs(dx * ty - dy * tx);
      if (side > 0.05 || along <= 1e-3 || along > MAX_JUMP) continue;
      if (along < bd) { bd = along; best = j; }
    }
    if (best < 0) continue;
    // 上面取的是最近的那条，不会跨过别的边；跳线两侧紧挨着的地方有路面（比如 T 字路口：横条的边在竖条两侧断开）就不连，
    // 那里是路口，护栏要绕过去，不能横穿
    const f = edges[best];
    if (onRoad(loops, e.b, f.a, e.out)) continue;
    edges.push({ u: e.v, v: f.u, a: e.b, b: f.a, out: e.out, len: hlen(e.b, f.a), jump: true, soft: true });
  }
  const adj: number[][] = nodes.map(() => []);
  edges.forEach((e, i) => { adj[e.u].push(i); adj[e.v].push(i); });
  return { nodes, edges, adj, segEdge };
}

const boxes = new WeakMap<Loop, number[]>();
/** 外沿圈的包围盒 [x0, y0, x1, y1, z0, z1] */
function boxOf(l: Loop): number[] {
  let b = boxes.get(l);
  if (!b) {
    b = [Infinity, Infinity, -Infinity, -Infinity, Infinity, -Infinity];
    for (const p of l.pts) { b[0] = Math.min(b[0], p[0]); b[1] = Math.min(b[1], p[1]); b[2] = Math.max(b[2], p[0]); b[3] = Math.max(b[3], p[1]); b[4] = Math.min(b[4], p[2]); b[5] = Math.max(b[5], p[2]); }
    boxes.set(l, b);
  }
  return b;
}
/** 跳线 a→b 两侧（朝外、朝里各 0.1）有没有路面：在高度相近的闭合外沿圈里绕数不为 0 就是在路面上 */
function onRoad(loops: Loop[], a: P3, b: P3, out: [number, number]): boolean {
  for (const f of [0.25, 0.5, 0.75]) for (const sg of [1, -1]) {
    const x = a[0] + (b[0] - a[0]) * f + out[0] * 0.1 * sg, y = a[1] + (b[1] - a[1]) * f + out[1] * 0.1 * sg, z = a[2] + (b[2] - a[2]) * f;
    let w = 0;
    for (const l of loops) {
      if (!l.closed) continue;
      const bb = boxOf(l);
      if (x < bb[0] || x > bb[2] || y < bb[1] || y > bb[3] || z < bb[4] - 1.5 || z > bb[5] + 1.5) continue;
      for (let i = 0; i < l.pts.length; i++) {
        const p = l.pts[i], q = l.pts[(i + 1) % l.pts.length];
        if (Math.abs((p[2] + q[2]) / 2 - z) > 1.5 && Math.abs(p[2] - z) > 1.5 && Math.abs(q[2] - z) > 1.5) continue;
        if (p[1] <= y) { if (q[1] > y && (q[0] - p[0]) * (y - p[1]) - (x - p[0]) * (q[1] - p[1]) > 0) w++; }
        else if (q[1] <= y && (q[0] - p[0]) * (y - p[1]) - (x - p[0]) * (q[1] - p[1]) < 0) w--;
      }
    }
    if (w !== 0) return true;
  }
  return false;
}

export function pointOf(g: Graph, p: GPos): P3 {
  const e = g.edges[p.e];
  return [e.a[0] + (e.b[0] - e.a[0]) * p.t, e.a[1] + (e.b[1] - e.a[1]) * p.t, e.a[2] + (e.b[2] - e.a[2]) * p.t];
}

/** 环 li 上弧长 s 的位置 → 图上的位置 */
export function posOnLoop(g: Graph, l: Loop, li: number, s: number): GPos {
  if (l.closed) s = ((s % l.len) + l.len) % l.len;
  else s = Math.min(Math.max(s, 0), l.len);
  let i = 0;
  while (i < l.outs.length - 1 && l.cum[i + 1] < s) i++;
  const L = l.cum[i + 1] - l.cum[i];
  return { e: g.segEdge.get(`${li}:${i}`)!, t: L > 0 ? (s - l.cum[i]) / L : 0 };
}

/** 离 p 最近的位置（水平距离为主，高度差超过 maxDz 的不算；跳线上也算） */
export function nearest(g: Graph, p: P3, maxDz = 3, jumps = true): (GPos & { dist: number }) | null {
  let best: (GPos & { dist: number }) | null = null;
  g.edges.forEach((e, i) => {
    if (e.jump && !jumps) return;
    const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1], L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / L2)) : 0;
    const z = e.a[2] + (e.b[2] - e.a[2]) * t;
    if (Math.abs(z - p[2]) > maxDz) return;
    const d = Math.hypot(e.a[0] + dx * t - p[0], e.a[1] + dy * t - p[1]) + Math.abs(z - p[2]) * 0.1;
    if (!best || d < best.dist) best = { e: i, t, dist: d };
  });
  return best;
}

/** 从位置 from 出发到各个点的最短路程（水平长度），以及走到每个点用的是哪条边；超过 limit 的不再往外走 */
export function distances(g: Graph, from: GPos, limit = Infinity): { dist: Float64Array; via: Int32Array } {
  const n = g.nodes.length, dist = new Float64Array(n).fill(Infinity), via = new Int32Array(n).fill(-1);
  const e0 = g.edges[from.e];
  // 简单的二叉堆
  const heap: [number, number][] = [];
  const push = (d: number, i: number) => {
    heap.push([d, i]);
    let k = heap.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (heap[p][0] <= heap[k][0]) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
  };
  const pop = (): [number, number] => {
    const top = heap[0], last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) { const l = 2 * k + 1, r = l + 1; let m = k; if (l < heap.length && heap[l][0] < heap[m][0]) m = l; if (r < heap.length && heap[r][0] < heap[m][0]) m = r; if (m === k) break; [heap[m], heap[k]] = [heap[k], heap[m]]; k = m; }
    }
    return top;
  };
  const relax = (i: number, d: number, e: number) => { if (d < dist[i] && d <= limit) { dist[i] = d; via[i] = e; push(d, i); } };
  relax(e0.u, e0.len * from.t, from.e);
  relax(e0.v, e0.len * (1 - from.t), from.e);
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]) continue;
    for (const ei of g.adj[i]) {
      const e = g.edges[ei], j = e.u === i ? e.v : e.u;
      relax(j, d + e.len, ei);
    }
  }
  return { dist, via };
}

/** 位置 to 离出发点多远（distances 的结果） */
export function distTo(g: Graph, r: { dist: Float64Array }, from: GPos, to: GPos): number {
  const e = g.edges[to.e];
  let d = Math.min(r.dist[e.u] + e.len * to.t, r.dist[e.v] + e.len * (1 - to.t));
  if (to.e === from.e) d = Math.min(d, Math.abs(to.t - from.t) * e.len);
  return d;
}

export interface GRoute { pts: P3[]; outs: [number, number][] }

/** 图上 from 到 to 的最短路线（护栏的折线）；走不到返回 null */
export function routeBetween(g: Graph, from: GPos, to: GPos): GRoute | null {
  const pf = pointOf(g, from), pt = pointOf(g, to);
  const et = g.edges[to.e];
  if (from.e === to.e) return { pts: [pf, pt], outs: [et.out] };
  const r = distances(g, from);
  const du = r.dist[et.u] + et.len * to.t, dv = r.dist[et.v] + et.len * (1 - to.t);
  if (!Number.isFinite(Math.min(du, dv))) return null;
  // 从终点倒着沿 via 走回出发点所在的边
  let cur = du <= dv ? et.u : et.v;
  const rev: { p: P3; out: [number, number] }[] = [{ p: pt, out: et.out }];
  for (let guard = 0; guard < 100000; guard++) {
    const ei = r.via[cur];
    rev.push({ p: g.nodes[cur], out: g.edges[ei].out });
    if (ei === from.e) break;
    const e = g.edges[ei];
    cur = e.u === cur ? e.v : e.u;
  }
  rev.push({ p: pf, out: [0, 0] });
  const pts: P3[] = [], outs: [number, number][] = [];
  for (let i = rev.length - 1; i >= 0; i--) {
    const q = rev[i].p;
    const last = pts[pts.length - 1];
    if (last && hlen(last, q) < 1e-6 && Math.abs(last[2] - q[2]) < 1e-6) continue;
    if (pts.length) outs.push(rev[i].out);
    pts.push(q);
  }
  return pts.length >= 2 ? mergeCollinear({ pts, outs }) : null;
}

/** 首尾相接、方向和朝外都一样的相邻段并成一段 */
function mergeCollinear(r: GRoute): GRoute {
  const pts: P3[] = [r.pts[0]], outs: [number, number][] = [];
  for (let i = 1; i < r.pts.length; i++) {
    const o = r.outs[i - 1], q = r.pts[i];
    if (outs.length) {
      const a = pts[pts.length - 2], b = pts[pts.length - 1], po = outs[outs.length - 1];
      const l1 = hlen(a, b), l2 = hlen(b, q);
      const same = po[0] === o[0] && po[1] === o[1] && l1 > 0 && l2 > 0
        && Math.abs((b[0] - a[0]) / l1 - (q[0] - b[0]) / l2) < 1e-6 && Math.abs((b[1] - a[1]) / l1 - (q[1] - b[1]) / l2) < 1e-6
        && Math.abs((b[2] - a[2]) / l1 - (q[2] - b[2]) / l2) < 1e-6;
      if (same) { pts[pts.length - 1] = q; continue; }
    }
    pts.push(q); outs.push(o);
  }
  return { pts, outs };
}

/** 折线的前 len 长（水平长度） */
export function truncate(r: GRoute, len: number): GRoute {
  const pts: P3[] = [r.pts[0]], outs: [number, number][] = [];
  let left = len;
  for (let i = 1; i < r.pts.length; i++) {
    const a = r.pts[i - 1], b = r.pts[i], d = hlen(a, b);
    if (left >= d - 1e-9) { pts.push(b); outs.push(r.outs[i - 1]); left -= d; continue; }
    const t = d > 0 ? left / d : 0;
    pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]); outs.push(r.outs[i - 1]);
    break;
  }
  return { pts, outs };
}

export const routeLength = (r: { pts: P3[] }) => r.pts.slice(1).reduce((s, q, i) => s + hlen(r.pts[i], q), 0);

/**
 * 拖动时用的投影：只在和当前位置连通的地方找（别的楼层、不相连的路不算），
 * 并且沿图走的路程比鼠标的直线移动多出太多的不要（不会因为鼠标斜穿路面就跳到路对面）
 */
export function nearFrom(g: Graph, p: P3, cur: GPos): GPos {
  const r = distances(g, cur);
  const pc = pointOf(g, cur), chord = hlen(pc, p);
  let best = cur, bs = Infinity;
  g.edges.forEach((e, i) => {
    if (e.jump) return; // 护栏的一头不停在悬空的跳线上（路线可以经过）
    const dx = e.b[0] - e.a[0], dy = e.b[1] - e.a[1], L2 = dx * dx + dy * dy;
    const t = L2 > 0 ? Math.max(0, Math.min(1, ((p[0] - e.a[0]) * dx + (p[1] - e.a[1]) * dy) / L2)) : 0;
    const pos = { e: i, t };
    const gd = distTo(g, r, cur, pos);
    if (!Number.isFinite(gd)) return;
    const d = Math.hypot(e.a[0] + dx * t - p[0], e.a[1] + dy * t - p[1]);
    const score = d + 0.6 * Math.max(0, gd - d - 1.5 * chord);
    if (score < bs) { bs = score; best = pos; }
  });
  return best;
}
