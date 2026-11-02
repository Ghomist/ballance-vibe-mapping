// 护栏：沿路面外沿（solve 算出的外沿环）从 a 走到 b
import { type Loop, type P3, pathAlong, pointAt, project } from '../model/outline';
import type { GuardElem } from './types';

/** 护栏走过的外沿路径：起止点投影到同一个外沿环上（离外沿太远就放不下） */
export function guardRouteBox(loops: Loop[], g: GuardElem): { pts: P3[]; outs: [number, number][] } | null {
  const pa = project(loops, g.a);
  if (!pa || pa.dist > 3) return null;
  const pb = project([loops[pa.loop]], g.b);
  if (!pb || pb.dist > 3) return null;
  const r = pathAlong(loops[pa.loop], pa.s, pb.s);
  return r.pts.length >= 2 && r.outs.length ? r : null;
}

/** 鼠标附近的外沿直边：用来预览 / 点一下放整条边的护栏 */
export function edgeAt(loops: Loop[], p: P3): { a: P3; b: P3; out: [number, number] } | null {
  const pr = project(loops, p, 1.5);
  if (!pr || pr.dist > 1.5) return null;
  const l = loops[pr.loop];
  const { seg } = pointAt(l, pr.s);
  return { a: l.pts[seg], b: l.pts[(seg + 1) % l.pts.length], out: l.outs[seg] };
}
