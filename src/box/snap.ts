// 吸附用的几何特征：顶点、边的中点、边
import { Elem, anchorRects, assetBounds, boxTopAt, footprint, virtualCells } from './types';
import { advance, type RailState } from '../model/rail';

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
    const out = boxFeats(() => [e.z, 0], f.x0, f.y0, f.x1, f.y1, 5);
    // 盘点：路口那一格的虚拟路面
    for (const r of virtualCells(e)) {
      const v = boxFeats(() => [r.top, 0], r.x0, r.y0, r.x1, r.y1, 5);
      out.verts.push(...v.verts); out.mids.push(...v.mids); out.edges.push(...v.edges);
    }
    return out;
  }
  if (e.kind === 'asset') { const b = assetBounds(e); return boxFeats(() => [b.z1, 0], b.x0, b.y0, b.x1, b.y1, b.z1 - b.z0); }
  if (e.kind === 'guard') return { verts: [e.pts[0], e.pts[e.pts.length - 1]], mids: [], edges: [] };
  if (e.kind === 'rail') {
    // 钢轨（一段）：两头的中心点、两头左右两根轨的顶端；中间点；直轨的中线
    const out: Feats = { verts: [], mids: [], edges: [] };
    const s0: RailState = { x: e.x, y: e.y, z: e.z, heading: e.heading };
    let s1 = s0;
    for (const p of e.pieces) s1 = advance(s1, p);
    for (const s of [s0, s1]) {
      out.verts.push([s.x, s.y, s.z]);
      const h = (s.heading * Math.PI) / 180, lx = -Math.sin(h) * 1.875, ly = Math.cos(h) * 1.875;
      out.verts.push([s.x + lx, s.y + ly, s.z], [s.x - lx, s.y - ly, s.z]);
    }
    if (e.pieces.length === 1) {
      const m = advance(s0, e.pieces[0], 0.5);
      out.mids.push([m.x, m.y, m.z]);
      if (e.pieces[0].angle === 0) out.edges.push([[s0.x, s0.y, s0.z], [s1.x, s1.y, s1.z]]);
    }
    return out;
  }
  // 机关：对准方块（代表它所在的那一格路面，5×5×5，顶面就是路面）的顶点、边中点、边，再加顶面中心
  const out: Feats = { verts: [], mids: [], edges: [] };
  for (const r of anchorRects(e)) {
    const f = boxFeats(() => [r.top, 0], r.x0, r.y0, r.x1, r.y1, 5);
    out.verts.push(...f.verts);
    out.mids.push(...f.mids, [(r.x0 + r.x1) / 2, (r.y0 + r.y1) / 2, r.top]);
    out.edges.push(...f.edges);
  }
  if (!out.verts.length) out.verts.push([e.x, e.y, e.z]);
  return out;
}
