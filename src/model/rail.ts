// 钢轨：从一个起点出发、由若干段（直线 / 圆弧 / 螺旋）首尾相接的路径。
// 路径高度 z 为双轨的最顶端：双轨接路面时，钢轨最顶端与路面顶面对齐。
// 单轨相对双轨的位置固定为 BBP 单双轨转换的下沉量；单双转换是一种同时带双轨与单轨的特殊轨道。

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

/** 双轨 / 单轨各自覆盖的弧长区间（单双转换段两者都有） */
export function kindSpans(r: Rail): { kind: 'double' | 'mono'; s0: number; s1: number }[] {
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

/** 在弧长 s 处把钢轨切成两条（只在直线段上切），返回后半条 */
export function splitRail(r: Rail, s: number, newId: number): Rail | null {
  let acc = 0;
  let st: RailState = { x: r.x, y: r.y, z: r.z, heading: r.heading };
  for (let i = 0; i < r.pieces.length; i++) {
    const p = r.pieces[i];
    const L = pieceLength(p);
    if (s > acc + 1e-6 && s < acc + L - 1e-6) {
      if (p.angle !== 0) return null;
      const f = (s - acc) / L;
      const mid = advance(st, p, f);
      const tail: RailPiece = { ...p, len: p.len * (1 - f), dz: p.dz * (1 - f) };
      p.len *= f; p.dz *= f;
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
