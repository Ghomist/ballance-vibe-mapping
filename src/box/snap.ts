// 吸附用的几何特征：顶点、边的中点、边
import { Elem, anchorRects, boxTopAt, footprint } from './types';

export type P3 = [number, number, number];
export interface Feats { verts: P3[]; mids: P3[]; edges: [P3, P3][] }

const boxFeats = (corners: (x: number, y: number) => [number, number], x0: number, y0: number, x1: number, y1: number, depth: number): Feats => {
  const xy = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const;
  const top: P3[] = xy.map(([x, y]) => [x, y, corners(x, y)[0]]);
  const bot: P3[] = xy.map(([x, y]) => [x, y, corners(x, y)[0] - depth]);
  const edges: [P3, P3][] = [];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) % 4;
    edges.push([top[i], top[j]], [bot[i], bot[j]], [top[i], bot[i]]);
  }
  return { verts: [...top, ...bot], edges, mids: edges.map(([a, b]) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]) };
};

export function feats(e: Elem): Feats {
  if (e.kind === 'box') {
    const f = footprint(e);
    return boxFeats((x, y) => [boxTopAt(e, x, y), 0], f.x0, f.y0, f.x1, f.y1, e.depth);
  }
  if (e.kind === 'piece') {
    const f = footprint(e);
    return boxFeats(() => [e.z, 0], f.x0, f.y0, f.x1, f.y1, 5);
  }
  // 机关：对准方块的顶面四角、中心和四条边
  const out: Feats = { verts: [], mids: [], edges: [] };
  for (const r of anchorRects(e)) {
    const c: P3[] = [[r.x0, r.y0, r.top], [r.x1, r.y0, r.top], [r.x1, r.y1, r.top], [r.x0, r.y1, r.top]];
    out.verts.push(...c);
    out.mids.push([(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, r.top]);
    for (let i = 0; i < 4; i++) {
      const a = c[i], b = c[(i + 1) % 4];
      out.edges.push([a, b]);
      out.mids.push([(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, r.top]);
    }
  }
  if (!out.verts.length) out.verts.push([e.x, e.y, e.z]);
  return out;
}
