// 护栏工具用的外沿查询：鼠标附近的外沿直边、沿外沿的一段路径
import { type Loop, type P3, pathAlong, pointAt, project } from '../model/outline';

export type Route = { pts: P3[]; outs: [number, number][] };

/**
 * 鼠标附近的外沿直边：点一下就沿这一整条直边放护栏。
 * inset：两头各往里缩多少（立柱不顶在路的拐角上）；边太短、缩完不到 1 时不缩
 */
export function edgeAt(loops: Loop[], p: P3, inset = 0): Route | null {
  const pr = project(loops, p, 1.5);
  if (!pr || pr.dist > 1.5) return null;
  const l = loops[pr.loop];
  const { seg } = pointAt(l, pr.s);
  const a = l.pts[seg], b = l.pts[(seg + 1) % l.pts.length];
  const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
  const k = inset > 0 && len - 2 * inset >= 1 ? inset / len : 0;
  const at = (t: number): P3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  return { pts: [at(k), at(1 - k)], outs: [l.outs[seg]] };
}

/** 外沿环上 s0 到 s1 的一段，走短的那一边（起止按外沿的方向排好） */
export function shortPath(l: Loop, s0: number, s1: number): Route {
  const f = l.closed ? (((s1 - s0) % l.len) + l.len) % l.len : s1 - s0;
  const forward = l.closed ? f <= l.len - f : f >= 0;
  return forward ? pathAlong(l, s0, s1) : pathAlong(l, s1, s0);
}

export const routeLen = (r: { pts: P3[] }) => r.pts.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - r.pts[i][0], q[1] - r.pts[i][1]), 0);

// ---------------- 护栏跟着路面走 ----------------
// 护栏存的是放下时走过的路径。路面改了（移动、拉伸、旋转、拉坡……）以后，原来贴着路沿的护栏按下面的办法重新走一遍：
//   两个端点各自找到它贴着的那块改过的路面，换算到这块路面改完以后同一条边上的位置，再沿新的外沿把两点之间连起来。
// 护栏本来就没贴着路沿、改完以后还贴着、或者换算不出来（路没了、两头不在同一圈外沿上）的，都不动。

/** 点算不算贴在外沿上 */
const ON_EDGE = 0.05;
/** 端点离这条边的一头不超过这么远，就认为它是跟着这个拐角的（整条直边的护栏两头内缩 1.5 就是这样） */
const NEAR_CORNER = 3;
const onLoops = (loops: Loop[], p: P3) => { const pr = project(loops, p, 0.5); return pr && pr.dist < ON_EDGE ? pr : null; };

/** 一块改过的路面：改之前、改之后它自己的外沿（没了是 null） */
export interface ChangedFloor { old: Loop[]; now: Loop[] | null }

/** 旧外沿 lo 上弧长 s 处的点 p，换到新外沿 ln 的同一条边上 */
function mapPoint(lo: Loop, s: number, ln: Loop | undefined, p: P3): P3 | null {
  if (!ln) return null;
  // 边数变了（曲线路面改了形状）：按整圈的比例
  if (lo.outs.length !== ln.outs.length || lo.closed !== ln.closed) return pointAt(ln, (s / lo.len) * ln.len).p;
  const { seg } = pointAt(lo, s);
  const Lo = lo.cum[seg + 1] - lo.cum[seg], Ln = ln.cum[seg + 1] - ln.cum[seg];
  const da = s - lo.cum[seg], db = Lo - da;
  const at = (d: number) => pointAt(ln, ln.cum[seg] + Math.max(0, Math.min(Ln, d))).p;
  if (Math.abs(Ln - Lo) < 1e-6) return at(da); // 这条边没变长短：位置不变（整体移动、旋转）
  if (da <= NEAR_CORNER && da <= db) return at(da);
  if (db <= NEAR_CORNER) return at(Ln - db);
  // 在边的中间：边的哪一头没动，就按离那一头的距离算（位置留在原地）
  const a = at(da), b = at(Ln - db);
  return Math.hypot(a[0] - p[0], a[1] - p[1]) <= Math.hypot(b[0] - p[0], b[1] - p[1]) ? a : b;
}

/**
 * 路面改了以后，护栏 g 该怎么走。changed：改过的路面各自的新旧外沿；loops：改完以后整张图的外沿。
 * 返回新的路径；不用动、没法跟的返回 null
 */
export function refitGuard(g: Route, changed: ChangedFloor[], loops: Loop[]): Route | null {
  if (g.pts.length < 2 || !changed.length) return null;
  const from = [g.pts[0], g.pts[g.pts.length - 1]];
  const ends: P3[] = [];
  /** 每个端点贴着哪块改过的路面、在它自己外沿的哪一圈、改之前和改之后的弧长 */
  const own: ({ c: ChangedFloor; loop: number; s0: number; s1: number } | null)[] = [];
  for (const p of from) {
    const c = changed.find((x) => onLoops(x.old, p));
    if (!c) { ends.push(p); own.push(null); continue; }
    const pr = onLoops(c.old, p)!;
    const q = c.now ? mapPoint(c.old[pr.loop], pr.s, c.now[pr.loop], p) : null;
    const qr = q ? onLoops([c.now![pr.loop]], q) : null;
    if (!q || !qr) return null;
    ends.push(q);
    own.push({ c, loop: pr.loop, s0: pr.s, s1: qr.s });
  }
  const same = (a: P3, b: P3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-6;
  if (same(ends[0], from[0]) && same(ends[1], from[1])) return null;
  // 两头贴着同一块路面：边缩得比护栏还短时两头会换位置（原来走近路的变成绕远路），不跟
  const [oa, ob] = own;
  if (oa && ob && oa.c === ob.c && oa.loop === ob.loop) {
    const lo = oa.c.old[oa.loop], ln = oa.c.now![oa.loop];
    const arc = (l: Loop, a: number, b: number) => (l.closed ? (((b - a) % l.len) + l.len) % l.len : b - a);
    const fo = arc(lo, oa.s0, ob.s0), fn = arc(ln, oa.s1, ob.s1);
    if (fn < 0.5 || (lo.closed && fo <= lo.len / 2 !== fn <= ln.len / 2)) return null;
  }
  const a = onLoops(loops, ends[0]), b = onLoops(loops, ends[1]);
  if (!a || !b || a.loop !== b.loop) return null;
  const l = loops[a.loop];
  if (!l.closed && b.s - a.s < 0.5) return null;
  return pathAlong(l, a.s, b.s);
}
