// 吸附用的几何特征：顶点、边的中点、边
import { assetInfo } from './asset-info';
import { ASSET_SNAP } from './asset-snap';
import { Elem, anchorRects, assetBounds, boxTopAt, footprint, isCheckpoint, toWorld, virtualCells } from './types';
import { objType } from '../model/objects';
import { roadRings } from '../geom/curve-road';
import { DOUBLE_OFFSET, MONO_OFFSET, RAIL_RADIUS, RAIL_SPAN, type RailKind, advance, type RailState, sampleRail, sideLowerSpan } from '../model/rail';

export type P3 = [number, number, number];
export interface Feats { verts: P3[]; mids: P3[]; edges: [P3, P3][] }

/** 钢轨某个位置的预设吸附点：每根轨的截面中心（对齐别的钢轨）；双轨再加路径点（两轨中间、轨顶高度，对齐路面） */
function railPoints(s: RailState, kind: RailKind): P3[] {
  const h = (s.heading * Math.PI) / 180, lx = -Math.sin(h) * (RAIL_SPAN / 2), ly = Math.cos(h) * (RAIL_SPAN / 2);
  const out: P3[] = [];
  if (kind !== 'mono') out.push([s.x, s.y, s.z], [s.x + lx, s.y + ly, s.z + DOUBLE_OFFSET], [s.x - lx, s.y - ly, s.z + DOUBLE_OFFSET]);
  if (kind !== 'double') out.push([s.x, s.y, s.z + MONO_OFFSET]);
  return out;
}

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

/** 吸附点（世界坐标）：在元素自己的坐标里算，再转到世界 */
export function feats(e: Elem): Feats {
  const f = localFeats(e);
  if (e.kind === 'guard' || (e.kind === 'rail' ? !e.q : !e.ang && !e.q)) return f;
  const w = (p: P3) => toWorld(e, p);
  return { verts: f.verts.map(w), mids: f.mids.map(w), edges: f.edges.map(([a, b]) => [w(a), w(b)]) };
}

function localFeats(e: Elem): Feats {
  if (e.kind === 'zone') return boxFeats(() => [e.z, 0], e.x, e.y, e.x + e.sx, e.y + e.sy, e.depth);
  if (e.kind === 'box') {
    const f = footprint(e);
    return boxFeats((x, y) => [boxTopAt(e, x, y), 0], f.x0, f.y0, f.x1, f.y1, e.depth);
  }
  if (e.kind === 'piece') {
    const f = footprint(e);
    if (isCheckpoint(e)) {
      // 盘点只有预设的吸附点：路口那条边的两角和中点（起点一个路口，小节盘点两个），再加圆盘中心
      const out: Feats = { verts: [], mids: [[e.x, e.y, e.z]], edges: [] };
      const alongX = e.rot % 2 === 0, lo = alongX ? f.x0 : f.y0, hi = alongX ? f.x1 : f.y1;
      for (const t of e.type === 'check' ? [lo, hi] : [e.rot < 2 ? hi : lo]) {
        if (alongX) { out.verts.push([t, f.y0, e.z], [t, f.y1, e.z]); out.mids.push([t, e.y, e.z]); }
        else { out.verts.push([f.x0, t, e.z], [f.x1, t, e.z]); out.mids.push([e.x, t, e.z]); }
      }
      return out;
    }
    const out = boxFeats(() => [e.z, 0], f.x0, f.y0, f.x1, f.y1, 5);
    // 盘点：路口那一格的虚拟路面
    for (const r of virtualCells(e)) {
      const v = boxFeats(() => [r.top, 0], r.x0, r.y0, r.x1, r.y1, r.depth ?? 5);
      out.verts.push(...v.verts); out.mids.push(...v.mids); out.edges.push(...v.edges);
    }
    return out;
  }
  if (e.kind === 'asset') {
    const preset = ASSET_SNAP[e.name];
    if (preset) {
      // 木板、木桥：模型上的预设点，跟着拉伸和朝向走
      const [ks, kt] = e.scale ?? [1, 1], c = [1, 0, -1, 0][e.rot], s = [0, 1, 0, -1][e.rot];
      const at = ([x, y, z]: P3): P3 => [e.x + x * ks * c - y * kt * s, e.y + x * ks * s + y * kt * c, e.z + z];
      return { verts: preset.verts.map(at), mids: preset.mids.map(at), edges: [] };
    }
    const b = assetBounds(e), st = assetInfo(e.name)?.snapTop, top = st === undefined ? b.z1 : e.z + st;
    return boxFeats(() => [top, 0], b.x0, b.y0, b.x1, b.y1, top - b.z0);
  }
  if (e.kind === 'guard') return { verts: [e.pts[0], e.pts[e.pts.length - 1]], mids: [], edges: [] };
  if (e.kind === 'rail') {
    // 钢轨只有预设的吸附点：两头和（单段时）中间的 railPoints，没有边
    const out: Feats = { verts: [], mids: [], edges: [] };
    if (e.curve && e.road) {
      // 曲线路面：两头的顶面两角、中点、底面两角，和路面的端面对得上
      const rs = roadRings(e), d = e.road.depth;
      for (const f of [rs[0], rs[rs.length - 1]]) {
        if (!f) continue;
        const P = (l: number, dz: number): P3 => [f.p[0] + f.L[0] * l + f.U[0] * dz, f.p[1] + f.L[1] * l + f.U[1] * dz, f.p[2] + f.L[2] * l + f.U[2] * dz];
        out.verts.push(P(2.5, 0), P(-2.5, 0), P(2.5, -d), P(-2.5, -d));
        out.mids.push(P(0, 0));
      }
      return out;
    }
    if (e.curve) {
      // 样条线：只吸两头。平行传递的两头截面不一定竖直，只留路径点
      const ps = sampleRail(e), kind = e.pieces[0]?.kind ?? 'double';
      for (const s of [ps[0], ps[ps.length - 1]]) if (s) out.verts.push(...(e.curve.frame === 'parallel' ? [[s.x, s.y, s.z] as P3] : railPoints(s, kind)));
      return out;
    }
    const s0: RailState = { x: e.x, y: e.y, z: e.z, heading: e.heading };
    if (e.side && e.pieces.length === 1) {
      // 侧轨只对下轨：截面中心（对齐别的钢轨）和外接正方形靠上轨的顶点（对齐路面的棱角）
      const pc = e.pieces[0], [ta, tb] = sideLowerSpan(e);
      const h = (e.heading * Math.PI) / 180, k = e.side.dir * RAIL_RADIUS;
      const both = (t: number): [P3, P3] => { const s = advance(s0, pc, t); return [[s.x, s.y, s.z], [s.x - Math.sin(h) * k, s.y + Math.cos(h) * k, s.z + RAIL_RADIUS]]; };
      const a = both(ta), b = both(tb);
      out.verts.push(...a, ...b);
      out.mids.push(...both((ta + tb) / 2));
      return out;
    }
    let s1 = s0;
    for (const p of e.pieces) s1 = advance(s1, p);
    out.verts.push(...railPoints(s0, e.pieces[0]?.kind ?? 'double'), ...railPoints(s1, e.pieces[e.pieces.length - 1]?.kind ?? 'double'));
    if (e.pieces.length === 1) out.mids.push(...railPoints(advance(s0, e.pieces[0], 0.5), e.pieces[0].kind));
    return out;
  }
  // 机关只有预设的吸附点：每个对准方块（代表它所在的那一格路面，顶面就是路面）顶面的四角、四边中点和中心，没有边
  const out: Feats = { verts: [], mids: [], edges: [] };
  for (const r of anchorRects(e)) {
    const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
    out.verts.push([r.x0, r.y0, r.top], [r.x1, r.y0, r.top], [r.x1, r.y1, r.top], [r.x0, r.y1, r.top]);
    out.mids.push([cx, r.y0, r.top], [r.x1, cy, r.top], [cx, r.y1, r.top], [r.x0, cy, r.top], [cx, cy, r.top]);
  }
  const c = [1, 0, -1, 0][e.rot], s = [0, 1, 0, -1][e.rot];
  for (const [x, y, z] of objType(e.type)?.snapTops ?? []) out.verts.push([e.x + x * c - y * s, e.y + x * s + y * c, e.z + z]);
  if (!out.verts.length) out.verts.push([e.x, e.y, e.z]);
  return out;
}
