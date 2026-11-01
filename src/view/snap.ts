// 对齐：格栅（世界坐标 2.5 的倍数）与自动对齐（其它元素的边界 / 端点 / 高度）是两个独立开关，可以同时生效。
import { DX, DY, HALF, Model, endPos, endZ, nodeHalf } from '../model/types';
import { platformBBox } from '../model/platform';
import { railEnd } from '../model/rail';
import { anchorBlocks } from '../model/objects';

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
  /** 格栅：对齐到 2.5 的倍数 */
  grid = true;
  /** 自动对齐：靠近其它元素的边界、端点、高度时对齐过去（与格栅相互独立，可同时开） */
  snap = true;
  /** 自由模式吸附距离（世界单位） */
  tol = 1;
  private cacheFor: Model | null = null;
  private cacheEx = '';
  private feats: { p: P3; id: number; prio?: boolean }[] = [];

  /** 收集模型中可供对齐的特征点 */
  private features(m: Model, exclude: Set<number>) {
    const ex = [...exclude].sort().join(',');
    if (this.cacheFor === m && this.cacheEx === ex) return this.feats;
    const f: { p: P3; id: number; prio?: boolean }[] = [];
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
    // 机关的对准方块：四个角（优先吸附）
    for (const o of Object.values(m.objs ?? {})) {
      if (exclude.has(o.id)) continue;
      for (const b of anchorBlocks(o)) {
        f.push({ p: [b.x - b.hx, b.y - b.hy, b.top], id: o.id, prio: true }, { p: [b.x + b.hx, b.y + b.hy, b.top], id: o.id, prio: true });
      }
    }
    for (const r of Object.values(m.rails)) {
      if (exclude.has(r.id)) continue;
      const e = railEnd(r);
      f.push({ p: [r.x, r.y, r.z], id: r.id }, { p: [e.x, e.y, e.z], id: r.id });
    }
    this.cacheFor = m; this.cacheEx = ex; this.feats = f;
    return f;
  }

  /** 吸附到特征的距离：同时开着格栅时不超过半格，免得挡住相邻的格点 */
  private reach() { return this.grid ? Math.min(this.tol, GRID * 0.4) : this.tol; }

  /** 没吸附到特征时：格栅模式取格点，否则保持原值 */
  private fallback(raw: number, step = GRID): SnapResult { return { v: this.grid ? round(raw, step) : tidy(raw) }; }

  /** 水平坐标（axis 0 = x，1 = y）；step 为格栅步长 */
  axis(m: Model, axis: 0 | 1, raw: number, exclude: Set<number> = new Set(), step = GRID): SnapResult {
    // 机关的对准方块优先于格栅和自动对齐（即使自动对齐关着）
    let pb: SnapResult | null = null, pd = this.tol;
    for (const { p, prio } of this.features(m, exclude)) {
      if (!prio) continue;
      const d = Math.abs(p[axis] - raw);
      if (d < pd) { pd = d; pb = { v: p[axis], from: p }; }
    }
    if (pb) return pb;
    if (this.snap) {
      let best: SnapResult | null = null, bd = this.reach();
      for (const { p } of this.features(m, exclude)) {
        const d = Math.abs(p[axis] - raw);
        if (d < bd) { bd = d; best = { v: p[axis], from: p }; }
      }
      if (best) return best;
    }
    return this.fallback(raw, step);
  }

  /**
   * 宽 2·half 的带子（路口）沿轴放置：带子的边沿或中心靠近别的特征（端点、边沿、平台角）时吸附过去；
   * 否则格栅模式下中心对齐 2.5，关掉格栅时随鼠标连续移动。
   */
  band(m: Model, axis: 0 | 1, raw: number, half: number, exclude: Set<number> = new Set()): SnapResult {
    if (this.snap) {
      let best: SnapResult | null = null, bd = this.reach();
      for (const { p } of this.features(m, exclude)) {
        for (const off of [0, -half, half]) {
          const d = Math.abs(p[axis] - (raw + off));
          if (d < bd) { bd = d; best = { v: p[axis] - off, from: p }; }
        }
      }
      if (best) return best;
    }
    return this.fallback(raw);
  }

  z(m: Model, raw: number, exclude: Set<number> = new Set()): SnapResult {
    if (this.snap) {
      let best: SnapResult | null = null, bd = this.reach();
      for (const { p } of this.features(m, exclude)) {
        const d = Math.abs(p[2] - raw);
        if (d < bd) { bd = d; best = { v: p[2], from: p }; }
      }
      if (best) return best;
    }
    return this.fallback(raw);
  }

  /** 无方向的长度 / 半径 */
  length(raw: number): number {
    return this.grid ? round(raw, GRID) : tidy(raw);
  }

  /** 圆弧角度步进（度） */
  angleStep() { return this.grid ? 90 : 15; }
}

