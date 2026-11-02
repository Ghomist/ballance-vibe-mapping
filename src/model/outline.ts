// 路面外轮廓：所有露在外面的路边（直道两侧、端头、路块空边、平台外沿）首尾相接连成的环。
// 每条边都定向为“朝外的一侧在右手边”，因此环的方向是固定的。护栏就是沿这些环走的一段。
import { boundaryEdges, cellSet, linkOpening, platformInsets } from './platform';
import { DX, DY, Dir, HALF, MNode, Model, endPos, endZ, isFree, nodeLinks, nodePorts } from './types';

export type P3 = [number, number, number];

export interface Loop {
  /** 顶点（沿外沿，路面顶面高度） */
  pts: P3[];
  /** 每一段（pts[i] → pts[i+1]）的朝外方向 */
  outs: [number, number][];
  closed: boolean;
  /** 到每个顶点为止的水平弧长 */
  cum: number[];
  len: number;
}

export interface Edge { a: P3; b: P3; out: [number, number] }

const k3 = (p: P3) => `${p[0].toFixed(2)},${p[1].toFixed(2)},${p[2].toFixed(2)}`;

/** 加一条边，并定向为朝外在右手边 */
export function push(out: Edge[], a: P3, b: P3, o: [number, number]) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  if (Math.hypot(dx, dy) < 1e-6) return;
  // 右手方向 (dy, -dx)
  if (dy * o[0] - dx * o[1] < 0) out.push({ a: b, b: a, out: o });
  else out.push({ a, b, out: o });
}

/** 矩形节点（路块、转换块、底座）没接路的边。栅栏路面是两格：第二格的侧边总是外沿 */
function nodeEdges(m: Model, n: MNode, out: Edge[]) {
  let hx = HALF, hy = HALF;
  if (n.kind === 'transition' && n.narrow) { if (n.axis === 0) hx = HALF / 2; else hy = HALF / 2; }
  const ports = nodePorts(m, n.id);
  const side = (cx: number, cy: number, hx: number, hy: number, d: Dir) => {
    const ax = d % 2 === 0;
    const x = cx + DX[d] * hx, y = cy + DY[d] * hy;
    const t = ax ? hy : hx;
    push(out, ax ? [x, y - t, n.z] : [x - t, y, n.z], ax ? [x, y + t, n.z] : [x + t, y, n.z], [DX[d], DY[d]]);
  };
  const fence = n.kind === 'base' && n.baseKind === 'fence';
  for (const d of [0, 1, 2, 3] as Dir[]) {
    if (fence && d === n.rot) continue;
    if (!ports[d]) side(n.x, n.y, hx, hy, d);
  }
  if (fence) {
    const d = n.rot!;
    const cx = n.x + DX[d] * 2 * HALF, cy = n.y + DY[d] * 2 * HALF;
    for (const e of [((d + 1) % 4) as Dir, ((d + 3) % 4) as Dir]) side(cx, cy, HALF, HALF, e);
    if (!ports[d]) side(cx, cy, HALF, HALF, d);
  }
}

export function outlineEdges(m: Model): Edge[] {
  const out: Edge[] = [];
  for (const s of Object.values(m.segs)) {
    if (s.len < 1e-6) continue;
    const [ax, ay] = endPos(s, 'a'), [bx, by] = endPos(s, 'b');
    const za = endZ(m, s, 'a'), zb = endZ(m, s, 'b');
    const L = ((s.dir + 1) % 4) as Dir;
    for (const sg of [1, -1]) {
      const ox = DX[L] * HALF * sg, oy = DY[L] * HALF * sg;
      push(out, [ax + ox, ay + oy, za], [bx + ox, by + oy, zb], [DX[L] * sg, DY[L] * sg]);
    }
    // 自由端的端面
    for (const k of ['a', 'b'] as const) {
      if (!isFree(s[k])) continue;
      const [x, y] = endPos(s, k);
      const z = endZ(m, s, k);
      const o: [number, number] = k === 'a' ? [-DX[s.dir], -DY[s.dir]] : [DX[s.dir], DY[s.dir]];
      push(out, [x - DX[L] * HALF, y - DY[L] * HALF, z], [x + DX[L] * HALF, y + DY[L] * HALF, z], o);
    }
  }
  for (const n of Object.values(m.nodes)) {
    if (n.kind === 'block' || n.kind === 'base' || (n.kind === 'transition' && n.inPlatform === undefined)) nodeEdges(m, n, out);
    if (n.kind === 'platform') {
      const cells = cellSet(n);
      const openings = [
        ...nodeLinks(m, n.id).map((l) => linkOpening(m.segs[l.seg], l.key)),
        ...platformInsets(m, n.id).map((i) => ({ x: i.ox, y: i.oy, out: i.out })),
      ];
      for (const e of boundaryEdges(cells)) {
        const L = 1.25;
        const a: P3 = [e.x, e.y, n.z];
        const b: P3 = e.along === 0 ? [e.x + L, e.y, n.z] : [e.x, e.y + L, n.z];
        const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
        // 开口处（接着路）不算外沿
        if (openings.some((o) => o.out === e.out && Math.abs(e.along === 1 ? o.x - mx : o.y - my) < 1e-6
          && Math.abs(e.along === 1 ? o.y - my : o.x - mx) < HALF)) continue;
        push(out, a, b, [DX[e.out], DY[e.out]]);
      }
    }
  }
  return out;
}

/** 外沿连成环（或断开的链），合并共线的相邻边 */
export function outlineLoops(m: Model): Loop[] {
  return loopsFromEdges(outlineEdges(m));
}

/** 定向好的边（朝外在右手边）首尾相接连成环（或断开的链） */
export function loopsFromEdges(edges: Edge[]): Loop[] {
  const from = new Map<string, number[]>();
  edges.forEach((e, i) => { const k = k3(e.a); from.set(k, [...(from.get(k) ?? []), i]); });
  const ends = new Set(edges.map((e) => k3(e.b)));
  const used = new Set<number>();
  const loops: Loop[] = [];
  const walk = (start: number) => {
    const seq: Edge[] = [];
    let i: number | undefined = start;
    while (i !== undefined && !used.has(i)) {
      used.add(i);
      seq.push(edges[i]);
      const nexts: number[] = (from.get(k3(edges[i].b)) ?? []).filter((j) => !used.has(j));
      i = nexts[0];
    }
    const closed = seq.length > 1 && k3(seq[seq.length - 1].b) === k3(seq[0].a);
    loops.push(makeLoop(seq, closed));
  };
  // 先从链的起点（没有边指向它）开始，再处理闭合环
  edges.forEach((e, i) => { if (!used.has(i) && !ends.has(k3(e.a))) walk(i); });
  edges.forEach((_, i) => { if (!used.has(i)) walk(i); });
  return loops;
}

function makeLoop(seq: Edge[], closed: boolean): Loop {
  // 合并共线、同坡度、同朝外方向的相邻边
  const merged: Edge[] = [];
  for (const e of seq) {
    const p = merged[merged.length - 1];
    if (p && p.out[0] === e.out[0] && p.out[1] === e.out[1] && k3(p.b) === k3(e.a)) {
      const l1 = Math.hypot(p.b[0] - p.a[0], p.b[1] - p.a[1]), l2 = Math.hypot(e.b[0] - e.a[0], e.b[1] - e.a[1]);
      if (Math.abs((p.b[2] - p.a[2]) / l1 - (e.b[2] - e.a[2]) / l2) < 1e-6) { p.b = e.b; continue; }
    }
    merged.push({ ...e });
  }
  if (closed && merged.length > 1) {
    const f = merged[0], l = merged[merged.length - 1];
    if (f.out[0] === l.out[0] && f.out[1] === l.out[1]) {
      const l1 = Math.hypot(l.b[0] - l.a[0], l.b[1] - l.a[1]), l2 = Math.hypot(f.b[0] - f.a[0], f.b[1] - f.a[1]);
      if (Math.abs((l.b[2] - l.a[2]) / l1 - (f.b[2] - f.a[2]) / l2) < 1e-6) { f.a = l.a; merged.pop(); }
    }
  }
  const pts: P3[] = merged.map((e) => e.a);
  if (!closed) pts.push(merged[merged.length - 1].b);
  const outs = merged.map((e) => e.out);
  const cum = [0];
  for (let i = 0; i < merged.length; i++) cum.push(cum[i] + Math.hypot(merged[i].b[0] - merged[i].a[0], merged[i].b[1] - merged[i].a[1]));
  return { pts, outs, closed, cum, len: cum[cum.length - 1] };
}

/** 环上弧长 s 处的点（闭合环会取模） */
export function pointAt(l: Loop, s: number): { p: P3; seg: number } {
  if (l.closed) s = ((s % l.len) + l.len) % l.len;
  else s = Math.min(Math.max(s, 0), l.len);
  let i = 0;
  while (i < l.outs.length - 1 && l.cum[i + 1] < s) i++;
  const a = l.pts[i], b = l.pts[(i + 1) % l.pts.length];
  const t = (s - l.cum[i]) / Math.max(l.cum[i + 1] - l.cum[i], 1e-9);
  return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t], seg: i };
}

export interface Proj { loop: number; s: number; p: P3; dist: number }

/** 离点 p 最近的外沿位置（水平距离为主，高度差太大的不算） */
export function project(loops: Loop[], p: P3, maxDz = 3): Proj | null {
  let best: Proj | null = null;
  loops.forEach((l, li) => {
    for (let i = 0; i < l.outs.length; i++) {
      const a = l.pts[i], b = l.pts[(i + 1) % l.pts.length];
      const dx = b[0] - a[0], dy = b[1] - a[1];
      const L2 = dx * dx + dy * dy;
      const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2));
      const q: P3 = [a[0] + dx * t, a[1] + dy * t, a[2] + (b[2] - a[2]) * t];
      if (Math.abs(q[2] - p[2]) > maxDz) continue;
      const d = Math.hypot(q[0] - p[0], q[1] - p[1]) + Math.abs(q[2] - p[2]) * 0.1;
      if (!best || d < best.dist) best = { loop: li, s: l.cum[i] + Math.sqrt(L2) * t, p: q, dist: d };
    }
  });
  return best;
}

/**
 * 拖动时用的投影：只在当前位置 near 附近连续地移动，不会因为鼠标斜穿路面就跳到对面的路边。
 * 返回已展开（闭合环上可超出 [0, len)）的弧长。
 */
export function projectNear(l: Loop, x: number, y: number, near: number): number {
  let best = near, bs = Infinity;
  for (let i = 0; i < l.outs.length; i++) {
    const a = l.pts[i], b = l.pts[(i + 1) % l.pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const L2 = dx * dx + dy * dy;
    const t = Math.max(0, Math.min(1, ((x - a[0]) * dx + (y - a[1]) * dy) / L2));
    let s = l.cum[i] + Math.sqrt(L2) * t;
    if (l.closed) s += Math.round((near - s) / l.len) * l.len;
    const d = Math.hypot(a[0] + dx * t - x, a[1] + dy * t - y);
    const score = d + 0.6 * Math.max(0, Math.abs(s - near) - d);
    if (score < bs) { bs = score; best = s; }
  }
  return best;
}

/** 环上从 s0 往前走到 s1 的折线（含两头），以及每段的朝外方向 */
export function pathAlong(l: Loop, s0: number, s1: number): { pts: P3[]; outs: [number, number][] } {
  if (!l.closed) { s0 = Math.max(0, Math.min(s0, l.len)); s1 = Math.max(0, Math.min(s1, l.len)); }
  let end = s1;
  if (l.closed) { s0 = ((s0 % l.len) + l.len) % l.len; end = s0 + (((s1 - s0) % l.len) + l.len) % l.len; }
  const pts: P3[] = [pointAt(l, s0).p];
  const outs: [number, number][] = [];
  let s = s0;
  let guard = 0;
  while (s < end - 1e-6 && guard++ < 10000) {
    const { seg } = pointAt(l, s + 1e-6);
    const base = l.closed ? Math.floor(s / l.len) * l.len : 0;
    const segEnd = base + l.cum[seg + 1];
    const next = Math.min(segEnd, end);
    outs.push(l.outs[seg]);
    pts.push(pointAt(l, next).p);
    s = next;
  }
  return { pts, outs };
}
