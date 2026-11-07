// 钢轨网格：正八边形截面沿路径扫掠。单轨平顶朝上、双轨尖顶朝上（与原版和 BBP 一致），法线取径向，呈平滑效果。
import {
  DOUBLE_OFFSET, MONO_OFFSET, RAIL_RADIUS, RAIL_SPAN, Rail, RailState,
  advance, kindSpans, railCenters, sampleRail, sideLowerSpan, stateAt,
} from '../model/rail';
import { fillet, sweepTube } from './railing';

export interface RailMesh { pos: number[]; nrm: number[] }

const rad = (d: number) => (d * Math.PI) / 180;

/** postDepth：侧轨两头弯下去的上轨插到路面以下多深（和护栏立柱一样，默认 2） */
export function buildRail(r: Rail, postDepth = 2): RailMesh {
  const out: RailMesh = { pos: [], nrm: [] };
  if (!r.pieces.length) return out;
  if (r.side && r.pieces.length === 1 && r.pieces[0].angle === 0) return buildSideRail(r, postDepth);
  const samples = sampleRail(r);
  for (const span of kindSpans(r)) {
    // 取该区间内的采样点，并在区间两端补上精确的切点
    const pts: RailState[] = [stateAt(r, span.s0)];
    for (const sm of samples) if (sm.s > span.s0 + 1e-6 && sm.s < span.s1 - 1e-6) pts.push(sm);
    pts.push(stateAt(r, span.s1));
    // 坡度：用相邻点估计切线的竖直分量
    const offsets = span.kind === 'double' ? [-RAIL_SPAN / 2, RAIL_SPAN / 2] : [0];
    for (const off of offsets) tube(out, pts, span.kind, off);
  }
  return out;
}

/**
 * 侧轨：下轨的轴线就是路径，上轨按倾斜角斜上去；两头可以让上轨像护栏立柱那样拐个圆角竖直插下去
 *（立柱竖到路面以下 postDepth，路面比路径高一个钢轨半径），这一头的下轨缩短。两根都是一整根平滑的圆管。
 */
function buildSideRail(r: Rail, postDepth: number): RailMesh {
  const [[, dzLo], [lat, dzUp]] = railCenters(r, 'double');
  const s0: RailState = { x: r.x, y: r.y, z: r.z, heading: r.heading };
  const pc = r.pieces[0];
  const s1 = advance(s0, pc);
  const h = rad(r.heading), L = [-Math.sin(h), Math.cos(h)];
  const P = (s: RailState, l: number, dz: number): [number, number, number] => [s.x + L[0] * l, s.y + L[1] * l, s.z + dz];
  const [ta, tb] = sideLowerSpan(r);
  const lower = tb > ta ? sweepTube([P(advance(s0, pc, ta), 0, dzLo), P(advance(s0, pc, tb), 0, dzLo)], false, RAIL_RADIUS) : { pos: [], nrm: [] };
  const up: [number, number, number][] = [P(s0, lat, dzUp), P(s1, lat, dzUp)];
  const [e0, e1] = r.side!.ends ?? [false, false];
  if (e0) up.unshift(P(s0, lat, RAIL_RADIUS - postDepth));
  if (e1) up.push(P(s1, lat, RAIL_RADIUS - postDepth));
  const upper = sweepTube(e0 || e1 ? fillet(up, false) : up, false, RAIL_RADIUS);
  return { pos: [...lower.pos, ...upper.pos], nrm: [...lower.nrm, ...upper.nrm] };
}

function tube(out: RailMesh, pts: RailState[], kind: 'double' | 'mono', lateral: number) {
  const zOff = kind === 'double' ? DOUBLE_OFFSET : MONO_OFFSET;
  const phase = kind === 'mono' ? 22.5 : 0;
  const rings: { c: number[]; v: number[][]; n: number[][] }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const h = rad(p.heading);
    const L = [-Math.sin(h), Math.cos(h), 0]; // 水平左侧
    // 切线（含坡度）
    const a = pts[Math.max(i - 1, 0)], b = pts[Math.min(i + 1, pts.length - 1)];
    const horiz = Math.hypot(b.x - a.x, b.y - a.y);
    const slope = horiz > 1e-9 ? (b.z - a.z) / horiz : 0;
    const T = normalize([Math.cos(h), Math.sin(h), slope]);
    const U = normalize(cross(T, L)); // 截面内的“上”
    const c = [p.x + L[0] * lateral, p.y + L[1] * lateral, p.z + zOff];
    // 和坡面路一样：每一圈都是竖直截面，大小不随坡度变（坡道是平轨沿竖直方向错切出来的），
    // 所以任何坡度、螺旋的两头都和相接的轨道 / 路面截面完全一样
    const v: number[][] = [], n: number[][] = [];
    for (let k = 0; k < 8; k++) {
      const th = rad(phase + k * 45);
      const d = [L[0] * Math.cos(th) + U[0] * Math.sin(th), L[1] * Math.cos(th) + U[1] * Math.sin(th), L[2] * Math.cos(th) + U[2] * Math.sin(th)];
      v.push([c[0] + L[0] * Math.cos(th) * RAIL_RADIUS, c[1] + L[1] * Math.cos(th) * RAIL_RADIUS, c[2] + Math.sin(th) * RAIL_RADIUS]);
      n.push(d);
    }
    rings.push({ c, v, n });
  }
  const tri = (p: number[][], n: number[][]) => { for (let i = 0; i < 3; i++) { out.pos.push(...p[i]); out.nrm.push(...n[i]); } };
  for (let i = 0; i + 1 < rings.length; i++) {
    const A = rings[i], B = rings[i + 1];
    for (let k = 0; k < 8; k++) {
      const k2 = (k + 1) % 8;
      // 绕序：从外侧看逆时针（截面角度沿 L→U 递增，路径沿 T 前进；由测试校验）
      tri([A.v[k], B.v[k2], B.v[k]], [A.n[k], B.n[k2], B.n[k]]);
      tri([A.v[k], A.v[k2], B.v[k2]], [A.n[k], A.n[k2], B.n[k2]]);
    }
  }
  // 两端封盖
  const cap = (R: { c: number[]; v: number[][] }, dir: number[], flip: boolean) => {
    for (let k = 1; k < 7; k++) {
      const p = flip ? [R.v[0], R.v[k + 1], R.v[k]] : [R.v[0], R.v[k], R.v[k + 1]];
      tri(p, [dir, dir, dir]);
    }
  };
  const first = rings[0], last = rings[rings.length - 1];
  // 端面是竖直的：封盖朝水平方向
  const flat = (a: number[]) => normalize([a[0], a[1], 0]);
  const t0 = flat(sub(rings[Math.min(1, rings.length - 1)].c, first.c));
  const t1 = flat(sub(last.c, rings[Math.max(rings.length - 2, 0)].c));
  cap(first, t0.map((x) => -x), true);
  cap(last, t1, false);
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(a: number[]) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
