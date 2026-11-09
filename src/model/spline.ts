// 样条线：多段三次贝塞尔。控制点的坐标是相对元素原点的本地坐标，手柄相对控制点。
// 两种截面朝向：默认竖直（和现有路面、钢轨的做法一样，两头能严丝合缝地接上）；
// 平行传递（截面垂直于曲线，能竖直爬升、翻圈，每个控制点可以设侧倾角）。

export type V3 = [number, number, number];

export interface SplinePoint {
  p: V3;
  /** 进入这个点的手柄（相对 p）；第一个点没有 */
  in?: V3;
  /** 离开这个点的手柄（相对 p）；最后一个点没有 */
  out?: V3;
  /** 侧倾角（度，只有平行传递模式用）：正值左侧抬高 */
  bank?: number;
}

export interface SplineCurve {
  pts: SplinePoint[];
  /** 截面朝向，没有就是竖直 */
  frame?: 'parallel';
}

/** 曲线路面的一头：封口、和别的路接着、露出截面的开口 */
export type CurveRoadEnd = 'closed' | 'joined' | 'open';
/** 曲线路面：钢轨元素上多这一项，就按路面的截面放样 */
export interface CurveRoad {
  style: 'normal' | 'sink' | 'ribbon';
  /** 厚度 */
  depth: number;
  /** 两头：自动（接上路就开口，否则封口）、开口、封口；没有就都是自动 */
  ends?: ('auto' | 'open' | 'closed')[];
}

export interface SplineSample {
  p: V3;
  /** 单位切线 */
  t: V3;
  /** 累计弧长 */
  s: number;
  bank: number;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: V3): V3 => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

/** 一段贝塞尔的四个点 */
function segment(c: SplineCurve, i: number): [V3, V3, V3, V3] {
  const a = c.pts[i], b = c.pts[i + 1];
  return [a.p, add(a.p, a.out ?? [0, 0, 0]), add(b.p, b.in ?? [0, 0, 0]), b.p];
}
function pointAt([a, b, c, d]: [V3, V3, V3, V3], u: number): V3 {
  const v = 1 - u, k0 = v * v * v, k1 = 3 * v * v * u, k2 = 3 * v * u * u, k3 = u * u * u;
  return [0, 1, 2].map((n) => a[n] * k0 + b[n] * k1 + c[n] * k2 + d[n] * k3) as V3;
}
function tangentAt([a, b, c, d]: [V3, V3, V3, V3], u: number): V3 {
  const v = 1 - u;
  const t = [0, 1, 2].map((n) => 3 * v * v * (b[n] - a[n]) + 6 * v * u * (c[n] - b[n]) + 3 * u * u * (d[n] - c[n])) as V3;
  // 手柄长度是 0 时端点的导数也是 0：退回用弦的方向
  return len(t) > 1e-9 ? unit(t) : unit(sub(d, a));
}

const TURN = (7 * Math.PI) / 180; // 切线转过这么多就出一圈截面
const MAX_STEP = 10; // 直的地方最长隔这么远出一圈
const FINE = 48; // 每段先细分这么多份再挑点

/** 沿曲线采样：弯的地方密、直的地方疏，每个控制点上一定有一圈 */
export function sampleSpline(c: SplineCurve): SplineSample[] {
  const out: SplineSample[] = [];
  if (c.pts.length < 2) return out;
  const seg0 = segment(c, 0);
  const bankOf = (i: number, u: number) => {
    const a = c.pts[i].bank ?? 0, b = c.pts[i + 1].bank ?? 0;
    return a + (b - a) * (u * u * (3 - 2 * u));
  };
  out.push({ p: seg0[0], t: tangentAt(seg0, 0), s: 0, bank: bankOf(0, 0) });
  let s = 0, sinceEmit = 0;
  for (let i = 0; i + 1 < c.pts.length; i++) {
    const seg = segment(c, i);
    let prev = seg[0];
    for (let k = 1; k <= FINE; k++) {
      const u = k / FINE, p = pointAt(seg, u), t = tangentAt(seg, u), d = len(sub(p, prev));
      s += d; sinceEmit += d;
      prev = p;
      const last = out[out.length - 1];
      const turned = Math.acos(Math.min(1, Math.max(-1, dot(last.t, t))));
      if (k === FINE || turned >= TURN || sinceEmit >= MAX_STEP) {
        if (sinceEmit < 1e-6) { last.t = t; last.bank = bankOf(i, u); continue; } // 重合的点只留一个
        out.push({ p, t, s, bank: bankOf(i, u) });
        sinceEmit = 0;
      }
    }
  }
  return out;
}

/** 平行传递：截面沿曲线走时不自己打转（双反射法），再按侧倾角转过去。L 是截面的左，U 是截面的上 */
export function parallelFrames(samples: SplineSample[]): { L: V3; U: V3 }[] {
  if (!samples.length) return [];
  const t0 = samples[0].t, up: V3 = [0, 0, 1];
  let u = sub(up, mul(t0, dot(up, t0)));
  if (len(u) < 1e-3) u = sub([0, 1, 0], mul(t0, t0[1])); // 一开始就竖直向上：随便取一个
  let r = unit(u);
  const raw: V3[] = [r];
  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i], b = samples[i + 1];
    const v1 = sub(b.p, a.p), c1 = dot(v1, v1);
    if (c1 < 1e-12) { raw.push(r); continue; }
    const rL = sub(r, mul(v1, (2 / c1) * dot(v1, r)));
    const tL = sub(a.t, mul(v1, (2 / c1) * dot(v1, a.t)));
    const v2 = sub(b.t, tL), c2 = dot(v2, v2);
    r = c2 < 1e-12 ? rL : sub(rL, mul(v2, (2 / c2) * dot(v2, rL)));
    r = unit(sub(r, mul(b.t, dot(r, b.t))));
    raw.push(r);
  }
  return samples.map((sm, i) => {
    const U0 = raw[i], L0 = unit(cross(U0, sm.t));
    const a = (sm.bank * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
    return { L: add(mul(L0, co), mul(U0, si)), U: sub(mul(U0, co), mul(L0, si)) };
  });
}

/** 新放的样条线：水平的一段 S 形 */
export const defaultCurve = (): SplineCurve => ({
  pts: [{ p: [0, 0, 0], out: [12, 0, 0] }, { p: [30, 15, 0], in: [-12, 0, 0] }],
});

/** 在第 i 个点后面加一个点：中间的段从正中间切开（形状不变），最后一个点后面顺着方向接一段。返回新点的下标 */
export function insertAfter(c: SplineCurve, i: number): number {
  if (i >= c.pts.length - 1) {
    const last = c.pts[c.pts.length - 1];
    const dir = last.in && len(last.in) > 1e-6 ? mul(unit(last.in), -1) : unit(sub(last.p, c.pts[c.pts.length - 2].p));
    last.out = mul(dir, 8);
    c.pts.push({ p: add(last.p, mul(dir, 20)), in: mul(dir, -8), ...(last.bank ? { bank: last.bank } : {}) });
    return c.pts.length - 1;
  }
  const [p0, p1, p2, p3] = segment(c, i);
  const mid = (a: V3, b: V3) => mul(add(a, b), 0.5);
  const a = mid(p0, p1), b = mid(p1, p2), d = mid(p2, p3), e = mid(a, b), f = mid(b, d), m = mid(e, f);
  const A = c.pts[i], B = c.pts[i + 1];
  A.out = sub(a, p0);
  B.in = sub(d, p3);
  const bank = ((A.bank ?? 0) + (B.bank ?? 0)) / 2;
  c.pts.splice(i + 1, 0, { p: m, in: sub(e, m), out: sub(f, m), ...(bank ? { bank } : {}) });
  return i + 1;
}

/** 删掉一个控制点（至少留两个）。首尾的点删掉后，新的首尾不再需要朝外的手柄 */
export function removePoint(c: SplineCurve, i: number): boolean {
  if (c.pts.length <= 2) return false;
  c.pts.splice(i, 1);
  delete c.pts[0].in;
  delete c.pts[c.pts.length - 1].out;
  return true;
}
