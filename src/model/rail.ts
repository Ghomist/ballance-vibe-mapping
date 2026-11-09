// 钢轨：从一个起点出发、由若干段（直线 / 圆弧 / 螺旋）首尾相接的路径。
// 路径高度 z 为双轨的最顶端：双轨接路面时，钢轨最顶端与路面顶面对齐。
// 单轨相对双轨的位置固定为 BBP 单双轨转换的下沉量；单双转换是一种同时带双轨与单轨的特殊轨道。

import { type CurveRoad, sampleSpline, type SplineCurve, type SplineSample } from './spline';

export type RailKind = 'double' | 'mono' | 'transition';

export interface RailPiece {
  kind: RailKind;
  /** 直线长度；圆弧段为 0 */
  len: number;
  /** 圆弧半径（双轨为两轨中线） */
  radius: number;
  /** 转过的角度（度），正为左转；0 表示直线。超过 360 即为螺旋 */
  angle: number;
  /** 本段的高度变化 */
  dz: number;
}

/**
 * 侧轨：一段直的双轨绕自身的轴转过一个角度（下轨嵌在路的棱角里：截面外接正方形靠上轨的顶点正好在棱角上，上轨斜着在上面），球靠着两根轨在路边外侧滚。
 * 标准侧轨的上轨两头像护栏一样弯下去固定在路边，弯下去的那头下轨缩短 SIDE_BEND_TRIM；开放侧轨两头不弯，就是两根成角度的钢轨。
 * 参数来自 BBP / BallanceBug：普通侧轨 79.563°，石球也能过的 57°，两轨间距和普通双轨一样。
 */
export interface SideRail {
  /** 上轨偏向路径的左侧（1）还是右侧（-1） */
  dir: 1 | -1;
  /** 石球也能过的侧轨（57°） */
  stone?: boolean;
  /** 两头的上轨是否像护栏立柱一样弯下去插进路面：[起点, 终点] */
  ends?: [boolean, boolean];
}

export interface Rail {
  id: number;
  x: number;
  y: number;
  z: number;
  /** 起点朝向（度，0 = +X，逆时针） */
  heading: number;
  pieces: RailPiece[];
  /** 侧轨（只用于一段直的双轨） */
  side?: SideRail;
  /** 螺旋侧轨：单轨螺旋，每圈升高固定 SIDE_SPIRAL_SCREW */
  sideSpiral?: boolean;
  /** 两头是球形闭合（[起点, 终点]，和原版 RailTip 的头一样），没有就是平直闭合 */
  tips?: [boolean, boolean];
  /** 倾斜（绕 X / Y 转过）：四元数，绕起点转 */
  q?: [number, number, number, number];
  /** 样条线钢轨：路径由曲线决定，pieces 只留一段用来记轨型（双轨或单轨） */
  curve?: SplineCurve;
  /** 曲线路面：有这一项时按路面放样，不再是钢轨 */
  road?: CurveRoad;
}

export const SIDE_RAIL_ANGLE = 79.563;
export const SIDE_RAIL_STONE_ANGLE = 57;
/** 上轨弯下去的那一头，下轨缩短多少 */
export const SIDE_BEND_TRIM = 5;
/** 侧边螺旋轨的层间距（第九关开头、第十三关结尾测量） */
export const SIDE_SPIRAL_SCREW = 3.6;

/** 侧轨下轨的起止位置（占路径长度的比例）：弯下去的那头缩短；太短时缩成中间一点 */
export function sideLowerSpan(r: Pick<Rail, 'side' | 'pieces'>): [number, number] {
  const len = r.pieces[0].len;
  const [e0, e1] = r.side?.ends ?? [false, false];
  const a = e0 ? SIDE_BEND_TRIM : 0, b = len - (e1 ? SIDE_BEND_TRIM : 0);
  if (a >= b) return [0.5, 0.5];
  return [a / len, b / len];
}

/**
 * 每根轨的截面中心相对路径点的位置：[向左的水平偏移, 竖直偏移]。
 * 普通双轨是左右各半个间距；侧轨是下轨的轴线就在路径上，上轨按倾斜角斜上去。
 */
export function railCenters(r: Pick<Rail, 'side'>, kind: 'double' | 'mono'): [number, number][] {
  if (kind === 'mono') return [[0, MONO_OFFSET]];
  if (!r.side) return [[-RAIL_SPAN / 2, DOUBLE_OFFSET], [RAIL_SPAN / 2, DOUBLE_OFFSET]];
  const a = ((r.side.stone ? SIDE_RAIL_STONE_ANGLE : SIDE_RAIL_ANGLE) * Math.PI) / 180;
  return [[0, 0], [r.side.dir * RAIL_SPAN * Math.cos(a), RAIL_SPAN * Math.sin(a)]];
}

export const RAIL_RADIUS = 0.35;
export const RAIL_SPAN = 3.75;
const BALL_R = 2;
/** BBP 单双轨转换的单轨下沉量：球同时压在双轨与单轨上时，两种截面中心的高差 */
export const MONO_DROP = BALL_R + RAIL_RADIUS - Math.sqrt((BALL_R + RAIL_RADIUS) ** 2 - (RAIL_SPAN / 2) ** 2);
/** 双轨截面中心相对路径高度（尖顶朝上，最顶端 = 路径高度） */
export const DOUBLE_OFFSET = -RAIL_RADIUS;
/** 单轨截面中心相对路径高度 */
export const MONO_OFFSET = DOUBLE_OFFSET - MONO_DROP;
/** 某种轨道最顶端相对路径高度（单轨为平顶） */
export function railTopOffset(kind: RailKind) {
  return kind === 'mono' ? MONO_OFFSET + RAIL_RADIUS * Math.cos(Math.PI / 8) : 0;
}
/** 单双转换轨道的默认长度（BBP 默认） */
export const TRANSITION_LEN = 5;
/** 螺旋默认参数（来自 BBP：第九关、第十三关测量） */
export const SPIRAL_RADIUS = 5;
export const SPIRAL_SCREW = 5;

export interface RailState { x: number; y: number; z: number; heading: number }

export interface RailSample extends RailState {
  /** 累计路径长度（水平） */
  s: number;
  piece: number;
}

const rad = (d: number) => (d * Math.PI) / 180;

export function pieceLength(p: RailPiece) {
  return p.angle === 0 ? p.len : (Math.abs(rad(p.angle)) * p.radius);
}

/** 走完一段后的状态 */
export function advance(st: RailState, p: RailPiece, frac = 1): RailState {
  const h = rad(st.heading);
  if (p.angle === 0) {
    const l = p.len * frac;
    return { x: st.x + Math.cos(h) * l, y: st.y + Math.sin(h) * l, z: st.z + p.dz * frac, heading: st.heading };
  }
  const sg = Math.sign(p.angle);
  const cx = st.x - Math.sin(h) * p.radius * sg, cy = st.y + Math.cos(h) * p.radius * sg;
  const a0 = Math.atan2(st.y - cy, st.x - cx);
  const a1 = a0 + rad(p.angle) * frac;
  return { x: cx + Math.cos(a1) * p.radius, y: cy + Math.sin(a1) * p.radius, z: st.z + p.dz * frac, heading: st.heading + p.angle * frac };
}

/** 样条线在元素坐标里的采样（x、y、z 原点和朝向已经算进去，倾斜 q 没算） */
export function curveSamples(r: Rail): SplineSample[] {
  const h = rad(r.heading), c = Math.cos(h), s = Math.sin(h);
  return sampleSpline(r.curve!).map((m) => ({
    ...m,
    p: [r.x + m.p[0] * c - m.p[1] * s, r.y + m.p[0] * s + m.p[1] * c, r.z + m.p[2]],
    t: [m.t[0] * c - m.t[1] * s, m.t[0] * s + m.t[1] * c, m.t[2]],
  }));
}
/** 样条线的采样点换成钢轨的状态：朝向取切线的水平方向，切线竖直时沿用上一个点的朝向 */
function curveStates(r: Rail): RailSample[] {
  let heading = r.heading;
  return curveSamples(r).map((m) => {
    if (Math.hypot(m.t[0], m.t[1]) > 1e-4) heading = (Math.atan2(m.t[1], m.t[0]) * 180) / Math.PI;
    return { x: m.p[0], y: m.p[1], z: m.p[2], heading, s: m.s, piece: 0 };
  });
}

export function railEnd(r: Rail): RailState {
  if (r.curve) return curveStates(r).at(-1)!;
  let st: RailState = { x: r.x, y: r.y, z: r.z, heading: r.heading };
  for (const p of r.pieces) st = advance(st, p);
  return st;
}

/** 沿路径采样（圆弧按每 360° 32 段细分，与 BBP 默认步数相近） */
export function sampleRail(r: Rail): RailSample[] {
  if (r.curve) return curveStates(r);
  const out: RailSample[] = [];
  let st: RailState = { x: r.x, y: r.y, z: r.z, heading: r.heading };
  let s = 0;
  out.push({ ...st, s, piece: 0 });
  r.pieces.forEach((p, i) => {
    const L = pieceLength(p);
    const steps = p.angle === 0 ? 1 : Math.max(2, Math.ceil((Math.abs(p.angle) / 360) * 32));
    for (let k = 1; k <= steps; k++) out.push({ ...advance(st, p, k / steps), s: s + (L * k) / steps, piece: i });
    st = advance(st, p);
    s += L;
  });
  return out;
}

/** 在路径上任意弧长处取状态 */
export function stateAt(r: Rail, s: number): RailState {
  if (r.curve) {
    const ps = curveStates(r);
    let i = 0;
    while (i < ps.length - 2 && ps[i + 1].s < s) i++;
    const a = ps[i], b = ps[i + 1], k = Math.min(1, Math.max(0, (s - a.s) / ((b.s - a.s) || 1)));
    const dh = ((b.heading - a.heading + 540) % 360) - 180;
    return { x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k, heading: a.heading + dh * k };
  }
  let st: RailState = { x: r.x, y: r.y, z: r.z, heading: r.heading };
  let acc = 0;
  for (const p of r.pieces) {
    const L = pieceLength(p);
    if (s <= acc + L + 1e-9) return advance(st, p, L > 0 ? (s - acc) / L : 0);
    st = advance(st, p);
    acc += L;
  }
  return st;
}

/** 双轨 / 单轨各自覆盖的弧长区间（单双转换段两者都有） */
export function kindSpans(r: Rail): { kind: 'double' | 'mono'; s0: number; s1: number }[] {
  if (r.curve) return [{ kind: r.pieces[0]?.kind === 'mono' ? 'mono' : 'double', s0: 0, s1: curveSamples(r).at(-1)?.s ?? 0 }];
  const spans: { kind: 'double' | 'mono'; s0: number; s1: number }[] = [];
  for (const kind of ['double', 'mono'] as const) {
    let s = 0;
    let cur: { kind: 'double' | 'mono'; s0: number; s1: number } | null = null;
    for (const p of r.pieces) {
      const L = pieceLength(p);
      const has = p.kind === kind || p.kind === 'transition';
      if (has) {
        if (cur) cur.s1 = s + L;
        else spans.push((cur = { kind, s0: s, s1: s + L }));
      } else cur = null;
      s += L;
    }
  }
  return spans;
}

/** 在起点往回延伸 len（直线）：首段是同轨型的平直线就直接加长，否则在前面插一段 */
export function extendStart(r: Rail, len: number) {
  const h = (r.heading * Math.PI) / 180;
  const first = r.pieces[0];
  if (len < 0) {
    // 往里缩：只缩首段直线
    if (!first || first.angle !== 0) return;
    const cut = Math.min(-len, first.len);
    const dz = first.len > 0 ? first.dz * (cut / first.len) : 0;
    r.x += Math.cos(h) * cut; r.y += Math.sin(h) * cut; r.z += dz;
    first.len -= cut; first.dz -= dz;
    if (first.len <= 1e-6) r.pieces.shift();
    return;
  }
  r.x -= Math.cos(h) * len; r.y -= Math.sin(h) * len;
  if (first && first.angle === 0 && first.dz === 0) first.len += len;
  else r.pieces.unshift({ kind: first?.kind ?? 'double', len, radius: 0, angle: 0, dz: 0 });
}

/** 在弧长 s 处把钢轨切成两条（直线、圆弧都可以），返回后半条 */
export function splitRail(r: Rail, s: number, newId: number): Rail | null {
  let acc = 0;
  let st: RailState = { x: r.x, y: r.y, z: r.z, heading: r.heading };
  for (let i = 0; i < r.pieces.length; i++) {
    const p = r.pieces[i];
    const L = pieceLength(p);
    if (s > acc + 1e-6 && s < acc + L - 1e-6) {
      const f = (s - acc) / L;
      const mid = advance(st, p, f);
      const [head, tail] = splitPiece(p, f);
      r.pieces[i] = head;
      const rest = r.pieces.splice(i + 1);
      return { id: newId, ...mid, pieces: [tail, ...rest] };
    }
    if (Math.abs(s - (acc + L)) <= 1e-6 && i < r.pieces.length - 1) {
      const end = advance(st, p);
      const rest = r.pieces.splice(i + 1);
      return { id: newId, ...end, pieces: rest };
    }
    st = advance(st, p);
    acc += L;
  }
  return null;
}

/** 离 (x,y) 最近的路径弧长 */
export function nearestS(r: Rail, x: number, y: number): number {
  let st: RailState = { x: r.x, y: r.y, z: r.z, heading: r.heading };
  let best = 0, bd = Infinity, acc = 0;
  for (const p of r.pieces) {
    const L = pieceLength(p);
    const n = Math.max(8, Math.ceil(L * 4));
    for (let k = 0; k <= n; k++) {
      const q = advance(st, p, k / n);
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < bd) { bd = d; best = acc + (L * k) / n; }
    }
    st = advance(st, p);
    acc += L;
  }
  return best;
}

/** 在末端追加一段；与前一段同为平直线且轨型相同时直接合并 */
export function pushPiece(r: Rail, p: RailPiece) {
  const last = r.pieces[r.pieces.length - 1];
  if (last && p.angle === 0 && last.angle === 0 && last.kind === p.kind && last.dz === 0 && p.dz === 0) {
    last.len += p.len;
    return;
  }
  r.pieces.push(p);
}

/** 离 (x,y) 最近的是第几段（按约 1 单位间距密集采样） */
export function nearestPiece(r: Rail, x: number, y: number): number {
  let st: RailState = { x: r.x, y: r.y, z: r.z, heading: r.heading };
  let best = 0, bd = Infinity;
  r.pieces.forEach((p, i) => {
    const n = Math.max(4, Math.ceil(pieceLength(p)));
    for (let k = 0; k <= n; k++) {
      const q = advance(st, p, k / n);
      const d = Math.hypot(q.x - x, q.y - y);
      if (d < bd) { bd = d; best = i; }
    }
    st = advance(st, p);
  });
  return best;
}

/** 把钢轨倒过来走（起点换成原来的终点，朝向反过来；圆弧左右互换、高差取反） */
export function reverseRail(r: Rail) {
  const E = railEnd(r);
  r.x = E.x; r.y = E.y; r.z = E.z; r.heading = E.heading + 180;
  r.pieces = r.pieces.reverse().map((p) => ({ ...p, angle: -p.angle, dz: -p.dz }));
}

/** 在弧长 s 处切开一段（直线或圆弧都可以），返回切开后的两段 */
export function splitPiece(p: RailPiece, f: number): [RailPiece, RailPiece] {
  if (p.angle === 0) return [{ ...p, len: p.len * f, dz: p.dz * f }, { ...p, len: p.len * (1 - f), dz: p.dz * (1 - f) }];
  return [{ ...p, angle: p.angle * f, dz: p.dz * f }, { ...p, angle: p.angle * (1 - f), dz: p.dz * (1 - f) }];
}

/** 钢轨 b 的起点正好接在 a 的终点上（位置、高度、朝向一致）时，把 b 接到 a 后面 */
export function canAppend(a: Rail, b: Rail, eps = 0.02) {
  const E = railEnd(a);
  const dh = ((((b.heading - E.heading) % 360) + 540) % 360) - 180;
  return Math.hypot(E.x - b.x, E.y - b.y) < eps && Math.abs(E.z - b.z) < eps && Math.abs(dh) < 0.5;
}
export function appendRail(a: Rail, b: Rail) {
  const [first, ...rest] = b.pieces;
  if (first) pushPiece(a, { ...first });
  a.pieces.push(...rest.map((p) => ({ ...p })));
}
