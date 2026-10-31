// 钢轨：从一个起点出发、由若干段（直线 / 圆弧 / 螺旋）首尾相接的路径。
// 路径高度 z 采用“等效路面顶面高度”：球在路面上时球心高 z+2，钢轨按这个高度放置截面，
// 这样路面 -> 钢轨、单轨 <-> 双轨之间球心高度连续。

export type RailKind = 'double' | 'mono';

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

export interface Rail {
  id: number;
  x: number;
  y: number;
  z: number;
  /** 起点朝向（度，0 = +X，逆时针） */
  heading: number;
  pieces: RailPiece[];
}

export const RAIL_RADIUS = 0.35;
export const RAIL_SPAN = 3.75;
const BALL_R = 2;
/** 双轨截面中心相对等效路面的高度：球心同样在 +2 */
export const DOUBLE_OFFSET = BALL_R - Math.sqrt((BALL_R + RAIL_RADIUS) ** 2 - (RAIL_SPAN / 2) ** 2);
/** 单轨截面中心相对等效路面的高度：轨顶与路面齐平 */
export const MONO_OFFSET = BALL_R - (BALL_R + RAIL_RADIUS);
/** 单双轨切换处的重叠长度 */
export const RAIL_OVERLAP = 5;
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

export function railEnd(r: Rail): RailState {
  let st: RailState = { x: r.x, y: r.y, z: r.z, heading: r.heading };
  for (const p of r.pieces) st = advance(st, p);
  return st;
}

/** 沿路径采样（圆弧按每 360° 32 段细分，与 BBP 默认步数相近） */
export function sampleRail(r: Rail): RailSample[] {
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

/** 各轨型覆盖的弧长区间；轨型变化处，前一段的轨型向后多延伸 RAIL_OVERLAP 形成重叠 */
export function kindSpans(r: Rail): { kind: RailKind; s0: number; s1: number }[] {
  const spans: { kind: RailKind; s0: number; s1: number }[] = [];
  let s = 0;
  const total = r.pieces.reduce((a, p) => a + pieceLength(p), 0);
  for (const p of r.pieces) {
    const L = pieceLength(p);
    const last = spans[spans.length - 1];
    if (last && last.kind === p.kind) last.s1 = s + L;
    else spans.push({ kind: p.kind, s0: s, s1: s + L });
    s += L;
  }
  for (let i = 0; i < spans.length - 1; i++) spans[i].s1 = Math.min(spans[i].s1 + RAIL_OVERLAP, total);
  return spans;
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
