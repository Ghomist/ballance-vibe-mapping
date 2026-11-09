// 曲线路面：把路面的截面沿样条线放样。
// 花纹规则和直道一样：边框带 u 从路边到中线，v 沿路每 5 个单位走 1；封口的一头占 2.5，外角的 UV 和直道一致。
import { HALF, SINK_DEPTH } from '../model/types';
import { type Rail, curveSamples, type RailState, sampleRail } from '../model/rail';
import { type CurveRoadEnd, parallelFrames, type V3 } from '../model/spline';
import { MeshBuilder, type MatName, type MeshPart, type V2 } from './floor';

export interface RoadRing { s: number; p: V3; t: V3; L: V3; U: V3 }

/** 沿路的每一圈截面（x、y、z 原点和朝向算进去，倾斜 q 没算）。竖直模式 U 恒为竖直向上，L 水平朝左 */
export function roadRings(r: Rail): RoadRing[] {
  const sm = curveSamples(r);
  if (r.curve!.frame === 'parallel') {
    const fr = parallelFrames(sm);
    return sm.map((m, i) => ({ s: m.s, p: m.p, t: m.t, L: fr[i].L, U: fr[i].U }));
  }
  const st: RailState[] = sampleRail(r);
  return sm.map((m, i) => {
    const h = (st[i].heading * Math.PI) / 180;
    return { s: m.s, p: m.p, t: m.t, L: [-Math.sin(h), Math.cos(h), 0], U: [0, 0, 1] };
  });
}

/** 弯得最急的地方的半径：比路宽一半小的话内侧会自己叠起来 */
export function minRadius(rings: RoadRing[]): number {
  let r = Infinity;
  for (let i = 0; i + 1 < rings.length; i++) {
    const a = rings[i], b = rings[i + 1];
    const c = Math.min(1, Math.max(-1, a.t[0] * b.t[0] + a.t[1] * b.t[1] + a.t[2] * b.t[2]));
    const ang = Math.acos(c);
    if (ang > 1e-4) r = Math.min(r, (b.s - a.s) / ang);
  }
  return r;
}

/** 这条路弧长 t 处、横向 l、沿截面上方向 dz 的点 */
function sampler(rings: RoadRing[]) {
  let i = 0;
  const at = (t: number): RoadRing => {
    while (i > 0 && rings[i].s > t) i--;
    while (i < rings.length - 2 && rings[i + 1].s < t) i++;
    const a = rings[i], b = rings[i + 1], k = Math.min(1, Math.max(0, (t - a.s) / ((b.s - a.s) || 1)));
    const mix = (x: V3, y: V3): V3 => [x[0] + (y[0] - x[0]) * k, x[1] + (y[1] - x[1]) * k, x[2] + (y[2] - x[2]) * k];
    const n = (v: V3): V3 => { const l = Math.hypot(v[0], v[1], v[2]) || 1; return [v[0] / l, v[1] / l, v[2] / l]; };
    return { s: t, p: mix(a.p, b.p), t: n(mix(a.t, b.t)), L: n(mix(a.L, b.L)), U: n(mix(a.U, b.U)) };
  };
  const pt = (t: number, l: number, dz = 0): V3 => {
    const f = at(t);
    return [f.p[0] + f.L[0] * l + f.U[0] * dz, f.p[1] + f.L[1] * l + f.U[1] * dz, f.p[2] + f.L[2] * l + f.U[2] * dz];
  };
  return { at, pt };
}

const STYLES = {
  normal: { band: 'FloorTopBorder' as MatName, us: 0.5, sink: 0 },
  sink: { band: 'FloorTopProfil' as MatName, us: 0.5, sink: SINK_DEPTH },
  ribbon: { band: 'FloorTopFlat' as MatName, us: 1, sink: SINK_DEPTH },
};

/** 放样出路面网格。ends：两头是封口、和别的路接着（不画端面）、还是开口露出截面。结果是元素坐标，倾斜由调用方处理 */
export function buildCurveRoad(r: Rail, ends: [CurveRoadEnd, CurveRoadEnd]): Partial<Record<MatName, MeshPart>> {
  const mb = new MeshBuilder();
  const road = r.road!;
  const rings = roadRings(r);
  if (rings.length < 2) return mb.parts;
  const len = rings[rings.length - 1].s;
  const { at, pt } = sampler(rings);
  const st = STYLES[road.style], sink = st.sink, d = road.depth;
  const v = (t: number) => t / 5;
  const closedA = ends[0] === 'closed', closedB = ends[1] === 'closed';
  const cap = closedA && closedB ? Math.min(HALF, len / 2) : Math.min(HALF, len);
  const t0 = closedA ? cap : 0, t1 = closedB ? len - cap : len;
  // 每一圈的弧长，加上封口的分界
  const ts = [...new Set([0, t0, t1, len, ...rings.map((x) => x.s)])].sort((a, b) => a - b);

  for (let i = 0; i + 1 < ts.length; i++) {
    const a = ts[i], b = ts[i + 1];
    if (b - a < 1e-6) continue;
    const mid = at((a + b) / 2);
    // 顶面的两条带子（封口的那一截由外角盖住）
    if (a >= t0 - 1e-9 && b <= t1 + 1e-9) {
      for (const side of [1, -1]) {
        mb.quad(st.band, [pt(a, side * HALF), pt(b, side * HALF), pt(b, 0, -sink), pt(a, 0, -sink)],
          [[0, v(a)], [0, v(b)], [st.us, v(b)], [st.us, v(a)]], mid.U);
      }
    }
    // 两侧的面：厚度超过 5 时上 5 带边框，往下无边框（和直的路面一样）
    for (const side of [1, -1]) {
      const out: V3 = [mid.L[0] * side, mid.L[1] * side, mid.L[2] * side];
      if (d <= 5 + 1e-9) {
        mb.quad('FloorSide', [pt(a, side * HALF), pt(b, side * HALF), pt(b, side * HALF, -d), pt(a, side * HALF, -d)],
          [[0, v(a)], [0, v(b)], [d / 5, v(b)], [d / 5, v(a)]], out);
      } else {
        mb.quad('LightingFloorTopBorder', [pt(a, side * HALF), pt(b, side * HALF), pt(b, side * HALF, -5), pt(a, side * HALF, -5)],
          [[0, v(a)], [0, v(b)], [1, v(b)], [1, v(a)]], out);
        const hb = (d - 5) / 5;
        mb.quad('LightingFloorTopBorderless', [pt(a, side * HALF, -5), pt(b, side * HALF, -5), pt(b, side * HALF, -d), pt(a, side * HALF, -d)],
          [[0, v(a)], [0, v(b)], [hb, v(b)], [hb, v(a)]], out);
      }
    }
  }

  // 封口的外角：沿对角线分成两个三角形，UV 和直道的外角一样
  const corner = (tEnd: number, tIn: number) => {
    const up = at((tEnd + tIn) / 2).U, k = st.us / 0.5;
    const uv = (u: number, w: number): V2 => [u * k, w * k];
    for (const side of [1, -1]) {
      const C = pt(tEnd, side * HALF), A1 = pt(tEnd, 0), A2 = pt(tIn, side * HALF), O = pt(tIn, 0, -sink);
      mb.tri(st.band, [C, A1, O], [uv(0, 0.5), uv(0, 0), uv(0.5, 0)], up);
      mb.tri(st.band, [C, O, A2], [uv(0, 0.5), uv(0.5, 0), uv(0, 0)], up);
    }
  };
  if (closedA) corner(0, cap);
  if (closedB) corner(len, len - cap);

  // 端面：和别的路接着的一头不画（贴在一起看不见）
  const endFace = (t: number, sg: number, end: CurveRoadEnd) => {
    if (end === 'joined') return;
    const f = at(t), out: V3 = [f.t[0] * sg, f.t[1] * sg, f.t[2] * sg];
    const notch = end === 'open' ? sink : 0;
    const uL = d / 5, uM = (d - notch) / 5;
    const Lt = pt(t, HALF), M = pt(t, 0, -notch), R = pt(t, -HALF);
    const Lb = pt(t, HALF, -d), Mb = pt(t, 0, -d), Rb = pt(t, -HALF, -d);
    mb.quad('FloorSide', [Lt, M, Mb, Lb], [[0, 0], [0, 0.5], [uM, 0.5], [uL, 0]], out);
    mb.quad('FloorSide', [M, R, Rb, Mb], [[0, 0.5], [0, 1], [uL, 1], [uM, 0.5]], out);
  };
  endFace(0, -1, ends[0]);
  endFace(len, 1, ends[1]);
  return mb.parts;
}
