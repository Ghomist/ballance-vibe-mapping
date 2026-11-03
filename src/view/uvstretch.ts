// 拉伸木制件时让贴图重复而不是被拉长：模型沿本地 X、Y 缩放 (sx, sy) 后，每个三角形的 UV 加上
//   ∂uv/∂x·(sx − 1)·x + ∂uv/∂y·(sy − 1)·y
// 这样缩放后的贴图密度和原来一样（贴图本来就是平铺的）。梯度按三角形所在平面算，各三角形各算各的（顶点不共用）。

/** 三角形里 uv 的某个分量对位置的梯度（在三角形平面内） */
function grad(p: number[][], d1: number, d2: number): number[] {
  const e1 = [p[1][0] - p[0][0], p[1][1] - p[0][1], p[1][2] - p[0][2]], e2 = [p[2][0] - p[0][0], p[2][1] - p[0][1], p[2][2] - p[0][2]];
  const a = e1[0] * e1[0] + e1[1] * e1[1] + e1[2] * e1[2], b = e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2], c = e2[0] * e2[0] + e2[1] * e2[1] + e2[2] * e2[2];
  const det = a * c - b * b;
  if (Math.abs(det) < 1e-12) return [0, 0, 0];
  const al = (c * d1 - b * d2) / det, be = (a * d2 - b * d1) / det;
  return [al * e1[0] + be * e2[0], al * e1[1] + be * e2[1], al * e1[2] + be * e2[2]];
}

/**
 * 三角形 (p0, p1, p2)（本地坐标，未缩放）的 UV 补偿后的值。ax、ay 是本地 X、Y 在位置数组里的下标
 *（Blender 坐标是 0、1；Virtools 坐标里 Blender 的 Y 是 2）。
 */
export function stretchTriUV(p: number[][], uv: number[][], sx: number, sy: number, ax = 0, ay = 1): number[][] {
  const out = uv.map((q) => [...q]);
  for (const k of [0, 1]) {
    const g = grad(p, uv[1][k] - uv[0][k], uv[2][k] - uv[0][k]);
    for (let i = 0; i < 3; i++) out[i][k] += g[ax] * (sx - 1) * p[i][ax] + g[ay] * (sy - 1) * p[i][ay];
  }
  return out;
}

/** 不带索引的三角形网格（pos 每 9 个一个三角形，uv 每 6 个）：返回补偿后的 uv */
export function stretchUV(pos: ArrayLike<number>, uv: ArrayLike<number>, sx: number, sy: number): Float32Array {
  const out = new Float32Array(uv.length);
  for (let t = 0; t * 9 < pos.length; t++) {
    const p = [0, 1, 2].map((k) => [pos[t * 9 + k * 3], pos[t * 9 + k * 3 + 1], pos[t * 9 + k * 3 + 2]]);
    const u = [0, 1, 2].map((k) => [uv[t * 6 + k * 2], uv[t * 6 + k * 2 + 1]]);
    const r = stretchTriUV(p, u, sx, sy);
    for (let k = 0; k < 3; k++) { out[t * 6 + k * 2] = r[k][0]; out[t * 6 + k * 2 + 1] = r[k][1]; }
  }
  return out;
}
