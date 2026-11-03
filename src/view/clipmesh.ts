// 从不带索引的三角形网格里挖掉几个矩形区域（模型本地的 x、y，竖直方向整个挖穿），跨过边界的三角形切开，UV、法线按线性插值。
// 盘点路面用它去掉自带的那一格延伸路，只留圆盘上和路相接的花纹；旁边的火焰托盘不在挖掉的范围里。
export interface TriMesh { pos: number[]; uv: number[]; nrm?: number[] }
/** 挖掉的矩形：x0 ≤ x ≤ x1 且 y0 ≤ y ≤ y1 */
export type CutBox = [x0: number, x1: number, y0: number, y1: number];

type V = { p: number[]; t: number[]; n: number[] };
const lerp = (a: V, b: V, k: number): V => ({ p: a.p.map((v, i) => v + (b.p[i] - v) * k), t: a.t.map((v, i) => v + (b.t[i] - v) * k), n: a.n.map((v, i) => v + (b.n[i] - v) * k) });
/** 凸多边形沿 f(v) = 0 切成两半：[f ≥ 0 的一半, f ≤ 0 的一半] */
function split(poly: V[], f: (v: V) => number): [V[], V[]] {
  const a: V[] = [], b: V[] = [];
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i], q = poly[(i + 1) % poly.length], sp = f(p), sq = f(q);
    if (sp >= 0) a.push(p);
    if (sp <= 0) b.push(p);
    if ((sp > 0 && sq < 0) || (sp < 0 && sq > 0)) { const m = lerp(p, q, sp / (sp - sq)); a.push(m); b.push(m); }
  }
  return [a, b];
}

/** yi：位置里哪个分量是矩形的 y（Blender 坐标是 1；Virtools 坐标里 Blender 的 y 是 2） */
export function cutBoxes(m: TriMesh, boxes: CutBox[], yi = 1): TriMesh {
  const out: TriMesh = { pos: [], uv: [], ...(m.nrm ? { nrm: [] } : {}) };
  for (let t = 0; t * 9 < m.pos.length; t++) {
    let polys: V[][] = [[0, 1, 2].map((k) => ({ p: m.pos.slice(t * 9 + k * 3, t * 9 + k * 3 + 3), t: m.uv.slice(t * 6 + k * 2, t * 6 + k * 2 + 2), n: m.nrm ? m.nrm.slice(t * 9 + k * 3, t * 9 + k * 3 + 3) : [0, 0, 0] }))];
    for (const [x0, x1, y0, y1] of boxes) {
      const next: V[][] = [];
      for (const poly of polys) {
        // 依次沿矩形的四条边切：落在矩形外的部分留下，最后剩在里面的扔掉
        let inside = poly;
        for (const f of [(v: V) => x0 - v.p[0], (v: V) => v.p[0] - x1, (v: V) => y0 - v.p[yi], (v: V) => v.p[yi] - y1]) {
          if (inside.length < 3) break;
          const [outPart, inPart] = split(inside, f);
          if (outPart.length >= 3) next.push(outPart);
          inside = inPart;
        }
      }
      polys = next;
    }
    for (const poly of polys) for (let i = 1; i + 1 < poly.length; i++) for (const v of [poly[0], poly[i], poly[i + 1]]) { out.pos.push(...v.p); out.uv.push(...v.t); out.nrm?.push(...v.n); }
  }
  return out;
}
