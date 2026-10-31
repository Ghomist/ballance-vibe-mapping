// 吸附：格栅模式下一切对齐到世界坐标 2.5 的倍数；自由模式下吸附到其它元素的边界 / 端点 / 高度。
import { DX, DY, HALF, Model, endPos, endZ, nodeHalf } from '../model/types';
import { platformBBox } from '../model/platform';
import { railEnd } from '../model/rail';

export const GRID = 2.5;

type P3 = [number, number, number];

export interface SnapResult {
  v: number;
  /** 吸附到的参考点（用于画对齐参考线） */
  from?: P3;
}

const round = (v: number, s: number) => Math.round(v / s) * s;
const tidy = (v: number) => Math.round(v * 100) / 100;

export class Snapper {
  grid = true;
  /** 自由模式吸附距离（世界单位） */
  tol = 1;
  private cacheFor: Model | null = null;
  private cacheEx = '';
  private feats: { p: P3; id: number }[] = [];

  /** 收集模型中可供对齐的特征点 */
  private features(m: Model, exclude: Set<number>) {
    const ex = [...exclude].sort().join(',');
    if (this.cacheFor === m && this.cacheEx === ex) return this.feats;
    const f: { p: P3; id: number }[] = [];
    for (const s of Object.values(m.segs)) {
      if (exclude.has(s.id)) continue;
      const P = [-DY[s.dir], DX[s.dir]];
      for (const k of ['a', 'b'] as const) {
        const [x, y] = endPos(s, k);
        const z = endZ(m, s, k);
        f.push({ p: [x, y, z], id: s.id });
        f.push({ p: [x + P[0] * HALF, y + P[1] * HALF, z], id: s.id }, { p: [x - P[0] * HALF, y - P[1] * HALF, z], id: s.id });
      }
    }
    for (const n of Object.values(m.nodes)) {
      if (exclude.has(n.id)) continue;
      if (n.kind === 'platform') {
        const b = platformBBox(n);
        f.push({ p: [b.x0, b.y0, n.z], id: n.id }, { p: [b.x1, b.y1, n.z], id: n.id });
        continue;
      }
      const h = nodeHalf(n);
      f.push({ p: [n.x, n.y, n.z], id: n.id });
      if (h > 0) f.push({ p: [n.x - h, n.y - h, n.z], id: n.id }, { p: [n.x + h, n.y + h, n.z], id: n.id });
    }
    for (const r of Object.values(m.rails)) {
      if (exclude.has(r.id)) continue;
      const e = railEnd(r);
      f.push({ p: [r.x, r.y, r.z], id: r.id }, { p: [e.x, e.y, e.z], id: r.id });
    }
    this.cacheFor = m; this.cacheEx = ex; this.feats = f;
    return f;
  }

  /** 水平坐标（axis 0 = x，1 = y） */
  axis(m: Model, axis: 0 | 1, raw: number, exclude: Set<number> = new Set()): SnapResult {
    if (this.grid) return { v: round(raw, GRID) };
    let best: SnapResult = { v: tidy(raw) }, bd = this.tol;
    for (const { p } of this.features(m, exclude)) {
      const d = Math.abs(p[axis] - raw);
      if (d < bd) { bd = d; best = { v: p[axis], from: p }; }
    }
    return best;
  }

  /**
   * 宽 2·half 的带子（路口）沿轴放置：格栅模式下中心对齐 2.5；
   * 自由模式下中心随鼠标连续移动，带子的边沿或中心靠近别的特征（端点、边沿、平台角）时吸附过去。
   */
  band(m: Model, axis: 0 | 1, raw: number, half: number, exclude: Set<number> = new Set()): SnapResult {
    if (this.grid) return { v: round(raw, GRID) };
    let best: SnapResult = { v: tidy(raw) }, bd = this.tol;
    for (const { p } of this.features(m, exclude)) {
      for (const off of [0, -half, half]) {
        const d = Math.abs(p[axis] - (raw + off));
        if (d < bd) { bd = d; best = { v: p[axis] - off, from: p }; }
      }
    }
    return best;
  }

  z(m: Model, raw: number, exclude: Set<number> = new Set()): SnapResult {
    if (this.grid) return { v: round(raw, GRID) };
    let best: SnapResult = { v: tidy(raw) }, bd = this.tol;
    for (const { p } of this.features(m, exclude)) {
      const d = Math.abs(p[2] - raw);
      if (d < bd) { bd = d; best = { v: p[2], from: p }; }
    }
    return best;
  }

  /** 无方向的长度 / 半径 */
  length(raw: number): number {
    return this.grid ? round(raw, GRID) : tidy(raw);
  }

  /** 圆弧角度步进（度） */
  angleStep() { return this.grid ? 90 : 15; }
}

