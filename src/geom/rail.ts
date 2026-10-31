// 钢轨网格：正八边形截面沿路径扫掠。单轨平顶朝上、双轨尖顶朝上（与原版和 BBP 一致），法线取径向，呈平滑效果。
import {
  DOUBLE_OFFSET, MONO_OFFSET, RAIL_RADIUS, RAIL_SPAN, Rail, RailKind, RailState,
  kindSpans, sampleRail, stateAt,
} from '../model/rail';

export interface RailMesh { pos: number[]; nrm: number[] }

const rad = (d: number) => (d * Math.PI) / 180;

export function buildRail(r: Rail): RailMesh {
  const out: RailMesh = { pos: [], nrm: [] };
  if (!r.pieces.length) return out;
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

function tube(out: RailMesh, pts: RailState[], kind: RailKind, lateral: number) {
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
    const v: number[][] = [], n: number[][] = [];
    for (let k = 0; k < 8; k++) {
      const th = rad(phase + k * 45);
      const d = [L[0] * Math.cos(th) + U[0] * Math.sin(th), L[1] * Math.cos(th) + U[1] * Math.sin(th), L[2] * Math.cos(th) + U[2] * Math.sin(th)];
      v.push([c[0] + d[0] * RAIL_RADIUS, c[1] + d[1] * RAIL_RADIUS, c[2] + d[2] * RAIL_RADIUS]);
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
  const t0 = normalize(sub(rings[Math.min(1, rings.length - 1)].c, first.c));
  const t1 = normalize(sub(last.c, rings[Math.max(rings.length - 2, 0)].c));
  cap(first, t0.map((x) => -x), true);
  cap(last, t1, false);
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(a: number[]) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
