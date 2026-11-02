// 护栏工具用的外沿查询：鼠标附近的外沿直边、沿外沿的一段路径
import { type Loop, type P3, pathAlong, pointAt, project } from '../model/outline';

export type Route = { pts: P3[]; outs: [number, number][] };

/** 鼠标附近的外沿直边：点一下就沿这一整条直边放护栏 */
export function edgeAt(loops: Loop[], p: P3): Route | null {
  const pr = project(loops, p, 1.5);
  if (!pr || pr.dist > 1.5) return null;
  const l = loops[pr.loop];
  const { seg } = pointAt(l, pr.s);
  return { pts: [l.pts[seg], l.pts[(seg + 1) % l.pts.length]], outs: [l.outs[seg]] };
}

/** 外沿环上 s0 到 s1 的一段，走短的那一边（起止按外沿的方向排好） */
export function shortPath(l: Loop, s0: number, s1: number): Route {
  const f = l.closed ? (((s1 - s0) % l.len) + l.len) % l.len : s1 - s0;
  const forward = l.closed ? f <= l.len - f : f >= 0;
  return forward ? pathAlong(l, s0, s1) : pathAlong(l, s1, s0);
}

export const routeLen = (r: { pts: P3[] }) => r.pts.slice(1).reduce((s, q, i) => s + Math.hypot(q[0] - r.pts[i][0], q[1] - r.pts[i][1]), 0);
