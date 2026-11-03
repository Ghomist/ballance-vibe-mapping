// 元素的朝向：绕 Z 的任意角（ang，存成 [0, 90) 内的「朝向坐标系」，元素的坐标都在这个坐标系里）
// 加上可选的倾斜（q：四元数，绕元素自己的中心 / 原点转）。世界坐标 = Rz(ang)·(c + Q·(p − c))。
// 纯数组实现，求解器和导出（Node 里跑测试）也能用。
export type V3 = [number, number, number];
/** 四元数 [x, y, z, w] */
export type Quat = [number, number, number, number];
/** 3×3 矩阵，按行 */
export type M3 = [number, number, number, number, number, number, number, number, number];

export const I3: M3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];
const D2R = Math.PI / 180;

export function rotZ(deg: number): M3 {
  const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R);
  return [c, -s, 0, s, c, 0, 0, 0, 1];
}
/** 绕坐标轴 axis（0 x / 1 y / 2 z）转 deg 度 */
export function rotAxis(axis: 0 | 1 | 2, deg: number): M3 {
  const c = Math.cos(deg * D2R), s = Math.sin(deg * D2R);
  if (axis === 0) return [1, 0, 0, 0, c, -s, 0, s, c];
  if (axis === 1) return [c, 0, s, 0, 1, 0, -s, 0, c];
  return rotZ(deg);
}
export function mul(a: M3, b: M3): M3 {
  const r = new Array(9).fill(0) as M3;
  for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
  return r;
}
export const apply = (m: M3, p: V3): V3 => [m[0] * p[0] + m[1] * p[1] + m[2] * p[2], m[3] * p[0] + m[4] * p[1] + m[5] * p[2], m[6] * p[0] + m[7] * p[1] + m[8] * p[2]];
export const transpose = (m: M3): M3 => [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];

export function fromQuat([x, y, z, w]: Quat): M3 {
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y),
  ];
}
export function toQuat(m: M3): Quat {
  const [a, b, c, d, e, f, g, h, i] = m;
  const t = a + e + i;
  let q: Quat;
  if (t > 0) { const s = Math.sqrt(t + 1) * 2; q = [(h - f) / s, (c - g) / s, (d - b) / s, s / 4]; }
  else if (a > e && a > i) { const s = Math.sqrt(1 + a - e - i) * 2; q = [s / 4, (b + d) / s, (c + g) / s, (h - f) / s]; }
  else if (e > i) { const s = Math.sqrt(1 + e - a - i) * 2; q = [(b + d) / s, s / 4, (f + h) / s, (c - g) / s]; }
  else { const s = Math.sqrt(1 + i - a - e) * 2; q = [(c + g) / s, (f + h) / s, s / 4, (d - b) / s]; }
  const n = Math.hypot(...q);
  return q.map((v) => Math.round((v / n) * 1e9) / 1e9) as Quat;
}

/** 矩阵是不是只绕 Z 转（局部的 Z 轴仍然朝上） */
export const isUpright = (m: M3) => m[8] > 1 - 1e-7;
/** 只绕 Z 转的矩阵的角度（度） */
export const yawOf = (m: M3) => Math.atan2(m[3], m[0]) / D2R;

/** 角度规范到 [0, 360) */
export const mod360 = (a: number) => { const r = ((a % 360) + 360) % 360; return r > 360 - 1e-6 ? 0 : r; };
/** 把绕 Z 的总角度拆成朝向坐标系的角度 [0, 90) 和 90° 的整数倍 */
export function splitYaw(deg: number): { ang: number; quarter: 0 | 1 | 2 | 3 } {
  const a = mod360(deg);
  let ang = a % 90, quarter = Math.floor(a / 90);
  if (ang > 90 - 1e-6) { ang = 0; quarter++; }
  if (ang < 1e-6) ang = 0;
  return { ang: Math.round(ang * 1e6) / 1e6, quarter: (quarter % 4) as 0 | 1 | 2 | 3 };
}
