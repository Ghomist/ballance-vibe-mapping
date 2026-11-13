// AI 制图的工具集：模型能调用的全部操作。每个工具都是「地图设计」层面的动作（放一段路、放一个机关、整体平移……），
// 不涉及建模和文件格式——那些由编辑器的求解器和导出器负责。
//
// 这里全是纯函数：runTool(doc, 名字, 参数) 直接改 doc，返回给模型看的结果（JSON）、界面上显示的一句话、改动了哪些元素。
// 坐标一律是编辑器内部的：x、y 是水平面，z 朝上；路面的 z 是顶面高度。方向 dir：0 = +X，1 = +Y，2 = -X，3 = -Y。
import { ASSET_INFO, assetInfo } from '../asset-info';
import { checkLevel } from '../check';
import { edgeAt, routeLen } from '../guard';
import { lintDesign, roadRects, touching } from './lint';
import { PathError, buildPath, lastCursor, markNames, sectorTagOf } from './path';
import { duplicate, elemBounds, mirrorElems, rotateWorld, translateElem } from '../ops';
import { solve } from '../solve';
import { AssetElem, Box, CP_PORT, Dir, Doc, Elem, Obj, Piece, RailElem, ZoneElem, anchorRects, footprint, isCheckpoint, railPath, toWorld } from '../types';
import { rotZ } from '../xform';
import { OBJ_TYPES, objType } from '../../model/objects';
import { DEFAULT_SETTINGS } from '../../model/types';
import type { RailPiece } from '../../model/rail';

export interface ToolOut {
  /** 给模型看的结果 */
  result: unknown;
  /** 界面上这一步显示的一句话 */
  summary: string;
  /** 这一步新增、改动的元素（界面上高亮它们） */
  changed: number[];
  /** 这一步改了地图（要重建画面、算进撤销） */
  mutated: boolean;
  /** 只是想让用户看这些元素 */
  focus?: number[];
}

type Args = Record<string, unknown>;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
const STYLES = ['normal', 'sink', 'ribbon'] as const;
/** 一次调用最多处理多少个，防止模型一口气塞进几千个元素 */
const BATCH = 200;

class Bad extends Error {}
const num = (o: Args, k: string, def?: number): number => {
  const v = o[k];
  if (v === undefined || v === null) { if (def === undefined) throw new Bad(`缺少 ${k}`); return def; }
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) throw new Bad(`${k} 要是数字`);
  if (Math.abs(n) > 1e5) throw new Bad(`${k} 太大了`);
  return n;
};
const pos = (o: Args, k: string, def?: number) => { const n = num(o, k, def); if (n <= 0) throw new Bad(`${k} 要大于 0`); return n; };
const dirOf = (o: Args, def = 0): Dir => { const n = num(o, 'dir', def); if (![0, 1, 2, 3].includes(n)) throw new Bad('dir 只能是 0（+X）、1（+Y）、2（-X）、3（-Y）'); return n as Dir; };
const list = (a: Args, k: string): Args[] => {
  const v = a[k];
  if (!Array.isArray(v) || !v.length) throw new Bad(`${k} 要是非空数组`);
  if (v.length > BATCH) throw new Bad(`${k} 一次最多 ${BATCH} 个，分几次调用`);
  return v as Args[];
};
const idsOf = (doc: Doc, a: Args): number[] => {
  const v = a.ids;
  if (!Array.isArray(v) || !v.length) throw new Bad('ids 要是非空数组');
  const ids = [...new Set(v.map(Number))];
  const miss = ids.filter((id) => !doc.elems[id]);
  if (miss.length) throw new Bad(`没有这些 id：${miss.slice(0, 10).join(', ')}（用 get_map 看现在有哪些元素）`);
  return ids;
};

// ---------------- 元素 → 给模型看的样子 ----------------

const railEnd = (e: RailElem) => {
  const p = railPath(e), b = p[p.length - 1];
  // 终点的朝向：出发方向加上每段转过的角度（倾斜的钢轨不算，朝向都在四元数里）
  const h = e.q ? null : r3((((e.heading + e.pieces.reduce((s, x) => s + x.angle, 0)) % 360) + 360) % 360);
  return { x: r3(b.x), y: r3(b.y), z: r3(b.z), ...(h === null ? {} : { heading: h }) };
};
const segsOf = (e: RailElem) => e.pieces.map((p) => (p.angle ? { radius: r3(p.radius), angle: r3(p.angle), ...(p.dz ? { dz: r3(p.dz) } : {}) } : { length: r3(p.len), ...(p.dz ? { dz: r3(p.dz) } : {}) }));
/** 盘点的路口：路面的端面要对在这里（中心点和朝外的方向） */
const portsOf = (e: Piece) => {
  const out = (d: Dir, dist: number) => { const [x, y] = toWorld(e, [e.x + DX[d] * dist, e.y + DY[d] * dist, e.z]); return { x: r3(x), y: r3(y), dir: d }; };
  return e.type === 'start' ? [out(e.rot, CP_PORT.start)] : [out(e.rot, CP_PORT.check), out(((e.rot + 2) % 4) as Dir, CP_PORT.check)];
};
/** 机关的对准方块：每个方块代表一格路面，放机关时路面要正好垫在这些格子底下 */
const cellsOf = (o: Obj) => anchorRects(o).map((a) => {
  const [x, y, z] = toWorld(o, [(a.x0 + a.x1) / 2, (a.y0 + a.y1) / 2, a.top]);
  return { x: r3(x), y: r3(y), z: r3(z), sx: r3(a.x1 - a.x0), sy: r3(a.y1 - a.y0) };
});

export function describe(e: Elem): Record<string, unknown> {
  const at = { x: r3(e.x), y: r3(e.y), z: r3(e.z) };
  const tilt = 'q' in e && e.q ? { tilted: true } : {};
  const ang = 'ang' in e && e.ang ? { angle: r3(e.ang) } : {};
  if (e.kind === 'box') return { id: e.id, t: 'road', ...at, sx: r3(e.sx), sy: r3(e.sy), style: e.style, ...(e.depth !== 5 ? { depth: r3(e.depth) } : {}), ...(e.slope ? { slope_axis: 'xy'[e.slope.axis], slope_dz: r3(e.slope.dz) } : {}), ...ang, ...tilt };
  if (e.kind === 'zone') return { id: e.id, t: 'death_zone', ...at, sx: r3(e.sx), sy: r3(e.sy), depth: r3(e.depth), ...ang };
  if (e.kind === 'piece') {
    if (isCheckpoint(e)) return { id: e.id, t: e.type === 'start' ? 'start' : 'checkpoint', ...at, dir: e.rot, ports: portsOf(e), ...ang };
    return { id: e.id, t: e.type === 'transition-narrow' ? 'transition_narrow' : 'transition', ...at, dir: e.rot, ...ang };
  }
  if (e.kind === 'obj') { const t = objType(e.type); return { id: e.id, t: 'object', type: e.type, name: t?.label, ...at, dir: e.rot, ...(e.sector ? { sector: e.sector } : {}), cells: cellsOf(e), ...ang, ...tilt }; }
  if (e.kind === 'asset') { const b = elemBounds(e); return { id: e.id, t: 'asset', name: e.name, label: assetInfo(e.name)?.label, ...at, dir: e.rot, bounds: [r3(b.x0), r3(b.y0), r3(b.z0), r3(b.x1), r3(b.y1), r3(b.z1)], ...tilt }; }
  if (e.kind === 'guard') return { id: e.id, t: 'guard', from: e.pts[0].map(r3), to: e.pts[e.pts.length - 1].map(r3), length: r3(routeLen(e)) };
  // 钢轨类
  if (e.curve) return { id: e.id, t: e.road ? 'curve_road' : 'curve_rail', ...at, heading: r3(e.heading), points: e.curve.pts.length, note: '曲线只能整体移动 / 旋转 / 删除，形状请用户自己拖控制点', ...tilt };
  if (e.road) return { id: e.id, t: 'arc_road', ...at, heading: r3(e.heading), radius: r3(e.pieces[0].radius), angle: r3(e.pieces[0].angle), style: e.road.style, end: railEnd(e), ...tilt };
  return { id: e.id, t: 'rail', ...at, heading: r3(e.heading), kind: e.pieces[0].kind, ...(e.side ? { side_rail: true } : {}), segments: segsOf(e), end: railEnd(e), ...tilt };
}

// ---------------- 路面连没连上（给模型自查用，只看水平贴在一起、高度对得上的） ----------------

/** 路面（和盘点、转换）按「贴在一起」分成几片 */
function roadGroups(doc: Doc): number[][] {
  const rs = roadRects(doc), parent = new Map(rs.map((r) => [r.id, r.id]));
  const find = (i: number): number => { while (parent.get(i) !== i) { parent.set(i, parent.get(parent.get(i)!)!); i = parent.get(i)!; } return i; };
  for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) if (touching(rs[i], rs[j])) parent.set(find(rs[i].id), find(rs[j].id));
  const g = new Map<number, number[]>();
  for (const r of rs) { const k = find(r.id); g.set(k, [...(g.get(k) ?? []), r.id]); }
  return [...g.values()].sort((a, b) => b.length - a.length);
}
const neighbours = (doc: Doc, id: number): number[] => {
  const rs = roadRects(doc), me = rs.find((r) => r.id === id);
  return me ? rs.filter((r) => r.id !== id && touching(me, r)).map((r) => r.id) : [];
};

// ---------------- 工具的实现 ----------------

type Impl = (doc: Doc, a: Args) => Omit<ToolOut, 'mutated'> & { mutated?: boolean };
const add = <T extends Elem>(doc: Doc, e: Omit<T, 'id'>): T => { const n = { ...e, id: doc.nextId++ } as T; doc.elems[n.id] = n; return n; };
/** 批量添加：每一项各自成败，失败的把原因告诉模型 */
function batch(doc: Doc, items: Args[], what: string, make: (o: Args) => { e: Elem; info?: Record<string, unknown> }): Omit<ToolOut, 'mutated'> {
  const ok: unknown[] = [], errors: unknown[] = [], changed: number[] = [];
  items.forEach((o, i) => {
    try { const { e, info } = make(o); changed.push(e.id); ok.push({ ...describe(e), ...info }); }
    catch (err) { if (!(err instanceof Bad)) throw err; errors.push({ index: i, error: err.message }); }
  });
  return { result: { added: ok, ...(errors.length ? { errors } : {}) }, summary: `添加 ${changed.length} ${what}${errors.length ? `，${errors.length} 个没放成` : ''}`, changed };
}

const IMPL: Record<string, Impl> = {
  get_map(doc) {
    const all = Object.values(doc.elems);
    const b = all.length ? all.map(elemBounds).reduce((p, q) => ({ x0: Math.min(p.x0, q.x0), y0: Math.min(p.y0, q.y0), z0: Math.min(p.z0, q.z0), x1: Math.max(p.x1, q.x1), y1: Math.max(p.y1, q.y1), z1: Math.max(p.z1, q.z1) })) : null;
    const shown = all.slice(0, 400);
    return {
      result: {
        count: all.length, sectors: 1 + all.filter((e) => e.kind === 'piece' && e.type === 'check').length,
        bounds: b && [r3(b.x0), r3(b.y0), r3(b.z0), r3(b.x1), r3(b.y1), r3(b.z1)],
        road_groups: roadGroups(doc).length,
        elements: shown.map(describe),
        ...(all.length > shown.length ? { note: `只列出了前 ${shown.length} 个` } : {}),
      },
      summary: `查看地图（${all.length} 个元素）`, changed: [],
    };
  },

  add_roads(doc, a) {
    return batch(doc, list(a, 'roads'), '块路面', (o) => {
      const style = (o.style ?? 'normal') as Box['style'];
      if (!STYLES.includes(style)) throw new Bad('style 只能是 normal / sink / ribbon');
      const sx = pos(o, 'sx'), sy = pos(o, 'sy');
      if (sx > 1000 || sy > 1000) throw new Bad('路面太大了');
      const e = add<Box>(doc, { kind: 'box', x: num(o, 'x'), y: num(o, 'y'), z: num(o, 'z', 0), sx, sy, depth: pos(o, 'depth', 5), style });
      const dz = num(o, 'slope_dz', 0);
      if (dz) { const ax = o.slope_axis; if (ax !== 'x' && ax !== 'y') throw (delete doc.elems[e.id], new Bad('有 slope_dz 时 slope_axis 要是 x 或 y')); e.slope = { axis: ax === 'x' ? 0 : 1, dz }; }
      const ang = num(o, 'angle', 0);
      if (ang) rotateWorld(e, rotZ(ang), [e.x + e.sx / 2, e.y + e.sy / 2, e.z]);
      // 贴着的路里有样式不一样的（平路贴凹路）：提醒要放平凹转换
      const near = neighbours(doc, e.id);
      const clash = near.filter((id) => { const o = doc.elems[id]; return o.kind === 'box' && ((o.style === 'normal' && e.style === 'sink') || (o.style === 'sink' && e.style === 'normal')); });
      return { e, info: { touches: near, ...(clash.length ? { warning: `和 #${clash.join('、#')} 一平一凹直接接上了：中间要放一块平凹转换（长 5），或者改用 build_path，它会自动垫` } : {}) } };
    });
  },

  add_rails(doc, a) {
    return batch(doc, list(a, 'rails'), '条钢轨', (o) => {
      const kind = (o.kind ?? 'double') as RailPiece['kind'];
      if (kind !== 'double' && kind !== 'mono') throw new Bad('kind 只能是 double / mono');
      const segs = o.segments;
      if (!Array.isArray(segs) || !segs.length || segs.length > 40) throw new Bad('segments 要是 1～40 段');
      const pieces: RailPiece[] = (segs as Args[]).map((s) => {
        const dz = num(s, 'dz', 0);
        if (s.angle !== undefined && num(s, 'angle')) return { kind, len: 0, radius: pos(s, 'radius'), angle: num(s, 'angle'), dz };
        return { kind, len: pos(s, 'length'), radius: 0, angle: 0, dz };
      });
      return { e: add<RailElem>(doc, { kind: 'rail', x: num(o, 'x'), y: num(o, 'y'), z: num(o, 'z', 0), heading: num(o, 'heading', 0), pieces }) };
    });
  },

  add_pieces(doc, a) {
    return batch(doc, list(a, 'pieces'), '个盘点 / 转换', (o) => {
      const k = String(o.kind);
      const type = ({ start: 'start', checkpoint: 'check', transition: 'transition', transition_narrow: 'transition-narrow' } as Record<string, Piece['type']>)[k];
      if (!type) throw new Bad('kind 只能是 start / checkpoint / transition / transition_narrow');
      if (type === 'start' && Object.values(doc.elems).some((e) => e.kind === 'piece' && e.type === 'start')) throw new Bad('地图里已经有起点了，一关只能有一个');
      return { e: add<Piece>(doc, { kind: 'piece', type, x: num(o, 'x'), y: num(o, 'y'), z: num(o, 'z', 0), rot: dirOf(o) }) };
    });
  },

  add_objects(doc, a) {
    const sectors = () => 1 + Object.values(doc.elems).filter((e) => e.kind === 'piece' && e.type === 'check').length;
    return batch(doc, list(a, 'objects'), '个机关 / 道具', (o) => {
      const t = objType(String(o.type));
      if (!t) throw new Bad(`不认识的 type「${String(o.type)}」，可用的：${OBJ_TYPES.map((x) => x.type).join(', ')}`);
      if (t.unique && Object.values(doc.elems).some((e) => e.kind === 'obj' && e.type === t.type)) throw new Bad(`${t.label} 全图只能有一个`);
      const x = num(o, 'x'), y = num(o, 'y'), z = num(o, 'z', 0);
      const mod = t.cat === 'module' && t.type !== 'PE_Balloon';
      const e = add<Obj>(doc, { kind: 'obj', type: t.type, x: 0, y: 0, z: 0, rot: dirOf(o), ...(mod ? { sector: Math.max(1, Math.min(sectors(), Math.round(num(o, 'sector', 1)))) } : {}) });
      // x、y、z 给的是第一个对准方块（机关脚下那一格路面）的中心和路面顶面：把机关挪到让方块正好落在那里
      const c = anchorRects(e)[0];
      if (c) translateElem(e, [x - (c.x0 + c.x1) / 2, y - (c.y0 + c.y1) / 2, z - c.top + (t.prop ? DEFAULT_SETTINGS.propLift : 0)]);
      else translateElem(e, [x, y, z]);
      return { e };
    });
  },

  add_assets(doc, a) {
    return batch(doc, list(a, 'assets'), '个木制件 / 特殊路块', (o) => {
      const inf = assetInfo(String(o.name));
      if (!inf || inf.sky) throw new Bad(`不认识的 name「${String(o.name)}」，可用的：${ASSET_INFO.filter((x) => !x.sky).map((x) => x.name).join(', ')}`);
      const e = add<AssetElem>(doc, { kind: 'asset', name: inf.name, x: num(o, 'x'), y: num(o, 'y'), z: num(o, 'z', 0), rot: dirOf(o) });
      if (o.length !== undefined) {
        if (!inf.stretch) throw (delete doc.elems[e.id], new Bad(`${inf.label} 不能改长度`));
        // 长度方向：有花纹周期的按周期方向，其余取模型较长的那根轴
        const ax = inf.tile?.axis ?? (inf.max[0] - inf.min[0] >= inf.max[1] - inf.min[1] ? 0 : 1);
        const sc: [number, number] = [1, 1];
        sc[ax] = r3(pos(o, 'length') / (inf.max[ax] - inf.min[ax]) * 1000) / 1000;
        if (sc[ax] !== 1) e.scale = sc;
      }
      return { e };
    });
  },

  add_death_zone(doc, a) {
    const e = add<ZoneElem>(doc, { kind: 'zone', x: num(a, 'x'), y: num(a, 'y'), z: num(a, 'z'), sx: pos(a, 'sx'), sy: pos(a, 'sy'), depth: pos(a, 'depth', 5) });
    return { result: describe(e), summary: '添加死亡区', changed: [e.id] };
  },

  add_sky(doc, a) {
    if (Object.values(doc.elems).some((e) => e.kind === 'asset' && assetInfo(e.name)?.sky)) throw new Bad('地图里已经有云层了，一张图只能有一个');
    const e = add<AssetElem>(doc, { kind: 'asset', name: a.vortex ? 'SkyLayerVortex' : 'SkyLayer', x: num(a, 'x', 0), y: num(a, 'y', 0), z: num(a, 'z'), rot: 0 });
    return { result: describe(e), summary: a.vortex ? '添加漩涡云层' : '添加云层', changed: [e.id] };
  },

  add_guards(doc, a) {
    const pts = list(a, 'at');
    const inset = num(a, 'inset', 1.5);
    const ok: unknown[] = [], errors: unknown[] = [], changed: number[] = [];
    pts.forEach((o, i) => {
      try {
        // 每放一条都重新解一次外沿：前一条不影响外沿，但这样写最不容易错
        const r = edgeAt(solve(doc).loops, [num(o, 'x'), num(o, 'y'), num(o, 'z', 0)], inset);
        if (!r) throw new Bad('这个点附近（1.5 以内）没有路面的外沿');
        const e = add<Extract<Elem, { kind: 'guard' }>>(doc, { kind: 'guard', pts: r.pts.map((q) => [...q] as [number, number, number]), outs: r.outs.map((q) => [...q] as [number, number]), x: r.pts[0][0], y: r.pts[0][1], z: r.pts[0][2] });
        changed.push(e.id); ok.push(describe(e));
      } catch (err) { if (!(err instanceof Bad)) throw err; errors.push({ index: i, error: err.message }); }
    });
    return { result: { added: ok, ...(errors.length ? { errors } : {}) }, summary: `添加 ${changed.length} 条护栏${errors.length ? `，${errors.length} 条没放成` : ''}`, changed };
  },

  update_elements(doc, a) {
    const ok: unknown[] = [], errors: unknown[] = [], changed: number[] = [];
    list(a, 'updates').forEach((o, i) => {
      const e = doc.elems[Number(o.id)];
      try {
        if (!e) throw new Bad(`没有 id ${String(o.id)}`);
        const keys = Object.keys(o).filter((k) => k !== 'id');
        if (!keys.length) throw new Bad('没有要改的字段');
        const back = JSON.stringify(e);
        try {
          // 位置：按位移平移（转过的元素也对）
          const d: [number, number, number] = [o.x !== undefined ? num(o, 'x') - e.x : 0, o.y !== undefined ? num(o, 'y') - e.y : 0, o.z !== undefined ? num(o, 'z') - e.z : 0];
          const plain = !('ang' in e && e.ang) && !('q' in e && e.q);
          if (d.some(Boolean)) { if (plain) translateElem(e, d); else throw new Bad('这个元素转过，不能直接设坐标：用 move_elements 平移'); }
          const rest = keys.filter((k) => !['x', 'y', 'z'].includes(k));
          const want = (ks: string[]) => { const bad = rest.filter((k) => !ks.includes(k)); if (bad.length) throw new Bad(`这种元素不能改 ${bad.join('、')}；能改的：x, y, z${ks.length ? ', ' + ks.join(', ') : ''}`); };
          if (e.kind === 'box') {
            want(['sx', 'sy', 'depth', 'style', 'slope_axis', 'slope_dz']);
            if (o.sx !== undefined) e.sx = pos(o, 'sx');
            if (o.sy !== undefined) e.sy = pos(o, 'sy');
            if (o.depth !== undefined) e.depth = pos(o, 'depth');
            if (o.style !== undefined) { if (!STYLES.includes(o.style as Box['style'])) throw new Bad('style 只能是 normal / sink / ribbon'); e.style = o.style as Box['style']; }
            if (o.slope_dz !== undefined || o.slope_axis !== undefined) {
              const dz = num(o, 'slope_dz', e.slope?.dz ?? 0), ax = o.slope_axis ?? (e.slope ? 'xy'[e.slope.axis] : undefined);
              if (!dz) delete e.slope;
              else { if (ax !== 'x' && ax !== 'y') throw new Bad('slope_axis 要是 x 或 y'); e.slope = { axis: ax === 'x' ? 0 : 1, dz }; }
            }
          } else if (e.kind === 'zone') {
            want(['sx', 'sy', 'depth']);
            if (o.sx !== undefined) e.sx = pos(o, 'sx');
            if (o.sy !== undefined) e.sy = pos(o, 'sy');
            if (o.depth !== undefined) e.depth = pos(o, 'depth');
          } else if (e.kind === 'piece') {
            want(['dir']);
            if (o.dir !== undefined) e.rot = dirOf(o);
          } else if (e.kind === 'obj') {
            want(['dir', 'sector']);
            if (o.dir !== undefined) e.rot = dirOf(o);
            if (o.sector !== undefined) { if (e.sector === undefined) throw new Bad('这个物体不分小节'); e.sector = Math.max(1, Math.round(num(o, 'sector'))); }
          } else if (e.kind === 'asset') {
            want(['dir']);
            if (o.dir !== undefined) e.rot = dirOf(o);
          } else if (e.kind === 'rail' && !e.curve && !e.road && !e.side && !e.sideSpiral) {
            want(['heading', 'kind', 'segments']);
            if (e.q && o.heading !== undefined) throw new Bad('倾斜的钢轨不能直接改朝向');
            if (o.heading !== undefined) e.heading = num(o, 'heading');
            const kind = (o.kind ?? e.pieces[0].kind) as RailPiece['kind'];
            if (kind !== 'double' && kind !== 'mono') throw new Bad('kind 只能是 double / mono');
            if (o.segments !== undefined) {
              const segs = o.segments;
              if (!Array.isArray(segs) || !segs.length || segs.length > 40) throw new Bad('segments 要是 1～40 段');
              e.pieces = (segs as Args[]).map((s) => (s.angle !== undefined && num(s, 'angle') ? { kind, len: 0, radius: pos(s, 'radius'), angle: num(s, 'angle'), dz: num(s, 'dz', 0) } : { kind, len: pos(s, 'length'), radius: 0, angle: 0, dz: num(s, 'dz', 0) }));
            } else if (o.kind !== undefined) for (const p of e.pieces) p.kind = kind;
          } else want([]);
        } catch (err) { doc.elems[e.id] = JSON.parse(back); throw err; }
        changed.push(e.id); ok.push(describe(doc.elems[e.id]));
      } catch (err) { if (!(err instanceof Bad)) throw err; errors.push({ index: i, error: err.message }); }
    });
    return { result: { updated: ok, ...(errors.length ? { errors } : {}) }, summary: `修改 ${changed.length} 个元素${errors.length ? `，${errors.length} 个没改成` : ''}`, changed };
  },

  move_elements(doc, a) {
    const ids = idsOf(doc, a), d: [number, number, number] = [num(a, 'dx', 0), num(a, 'dy', 0), num(a, 'dz', 0)];
    if (!d.some(Boolean)) throw new Bad('dx、dy、dz 至少给一个不是 0 的');
    for (const id of ids) translateElem(doc.elems[id], d);
    return { result: { moved: ids.length, by: d }, summary: `移动 ${ids.length} 个元素`, changed: ids };
  },

  rotate_elements(doc, a) {
    const ids = idsOf(doc, a), deg = num(a, 'degrees');
    if (!deg) throw new Bad('degrees 不能是 0');
    const bs = ids.map((id) => elemBounds(doc.elems[id]));
    const cx = num(a, 'cx', (Math.min(...bs.map((b) => b.x0)) + Math.max(...bs.map((b) => b.x1))) / 2), cy = num(a, 'cy', (Math.min(...bs.map((b) => b.y0)) + Math.max(...bs.map((b) => b.y1))) / 2);
    for (const id of ids) rotateWorld(doc.elems[id], rotZ(deg), [cx, cy, 0]);
    return { result: { rotated: ids.length, degrees: deg, about: [r3(cx), r3(cy)], elements: ids.slice(0, 50).map((id) => describe(doc.elems[id])) }, summary: `旋转 ${ids.length} 个元素 ${deg}°`, changed: ids };
  },

  mirror_elements(doc, a) {
    const ids = idsOf(doc, a), ax = a.axis;
    if (ax !== 'x' && ax !== 'y') throw new Bad('axis 要是 x（x 取反）或 y（y 取反）');
    const bs = ids.map((id) => elemBounds(doc.elems[id])), axis = ax === 'x' ? 0 : 1;
    const c = a.at !== undefined ? num(a, 'at') : axis === 0 ? (Math.min(...bs.map((b) => b.x0)) + Math.max(...bs.map((b) => b.x1))) / 2 : (Math.min(...bs.map((b) => b.y0)) + Math.max(...bs.map((b) => b.y1))) / 2;
    const r = mirrorElems(doc, ids, axis, c);
    return { result: { mirrored: r.done, skipped: r.skipped, ...(r.skipped ? { note: '机关、木制件、盘点和倾斜的东西不支持镜像，留在了原地' } : {}), mirror_plane: r3(c) }, summary: `镜像 ${r.done} 个元素${r.skipped ? `（跳过 ${r.skipped} 个）` : ''}`, changed: ids, mutated: r.done > 0 };
  },

  duplicate_elements(doc, a) {
    const ids = idsOf(doc, a), d: [number, number, number] = [num(a, 'dx', 0), num(a, 'dy', 0), num(a, 'dz', 0)];
    const count = Math.round(num(a, 'count', 1));
    if (count < 1 || count > 50) throw new Bad('count 要在 1～50 之间');
    if (ids.length * count > 500) throw new Bad('一次复制出来的太多了');
    if (!d.some(Boolean)) throw new Bad('dx、dy、dz 至少给一个不是 0 的，不然副本会叠在原件上');
    const made: number[] = [];
    for (let k = 1; k <= count; k++) for (const id of duplicate(doc, ids)) { translateElem(doc.elems[id], [d[0] * k, d[1] * k, d[2] * k]); made.push(id); }
    return { result: { new_ids: made }, summary: `复制出 ${made.length} 个元素`, changed: made };
  },

  delete_elements(doc, a) {
    const ids = idsOf(doc, a);
    for (const id of ids) delete doc.elems[id];
    return { result: { deleted: ids.length }, summary: `删除 ${ids.length} 个元素`, changed: [] };
  },

  build_path(doc, a) {
    let r;
    try { r = buildPath(doc, a); } catch (e) { if (e instanceof PathError) throw new Bad(e.message); throw e; }
    const kinds = r.steps.length;
    return {
      result: {
        ...(r.error ? { error: r.error } : {}), steps: r.steps, cursor: r.cursor, path_length: r.length,
        ...(r.collisions ? { collisions: r.collisions, collisions_note: '新铺的路压在别的路上了。如果是有意接回原来的路，让它正好贴上而不是叠上去；如果不是有意的，换个方向或者高度（上下错开至少 10），用 delete_elements 删掉叠住的那几块重铺' } : {}),
        ...(r.logic ? { logic_problems: r.logic, logic_note: '球种上说不通：玩家按这条路走到那里时过不去。必须改（挪变球器的位置、换机关、或者改路线），不能留着' } : {}),
        note: '下一次调用不给 from，就从 cursor 接着铺',
      },
      summary: r.error ? `铺赛道：做了 ${kinds} 步后停下（${r.error.split('：')[0]}）` : `铺赛道 ${kinds} 步，长 ${Math.round(r.length)}`,
      changed: r.changed,
    };
  },

  check_level(doc) {
    const issues = checkLevel(doc), groups = roadGroups(doc), design = lintDesign(doc);
    return {
      result: {
        issues: issues.map((i) => ({ level: i.level, text: i.text, hint: i.hint, ids: i.ids })),
        design_problems: design.slice(0, 30),
        ...(lastCursor(doc) ? { path_cursor: lastCursor(doc) } : {}),
        ...(markNames(doc).length ? { path_marks: markNames(doc) } : {}),
        road_groups: groups.length,
        ...(groups.length > 1 ? { groups: groups.slice(0, 12), note: '路面（含盘点、平凹转换）按「贴在一起」分成了这几片。片与片之间要靠钢轨、木制件、机关连起来，或者是有意留的落差；如果不是有意的，说明有路没对上' } : {}),
      },
      summary: issues.length || design.length ? `检查关卡：${issues.filter((i) => i.level === 'error').length} 个错误，${issues.filter((i) => i.level === 'warn').length} 条提醒，${design.length} 处搭得不对` : '检查关卡：没有问题', changed: [],
    };
  },

  get_section(doc, a) {
    const n = Math.round(num(a, 'sector'));
    const checks = Object.values(doc.elems).filter((e): e is Piece => e.kind === 'piece' && e.type === 'check').sort((x, y) => x.id - y.id);
    const total = 1 + checks.length;
    if (n < 1 || n > total) throw new Bad(`现在一共 ${total} 个小节`);
    const start = Object.values(doc.elems).find((e): e is Piece => e.kind === 'piece' && e.type === 'start');
    const head = n === 1 ? start : checks[n - 2], tail = checks[n - 1] ?? null;
    // 属于这一小节的：铺的时候记下的（build_path 铺的），加上小节号是它的机关
    const ids = Object.values(doc.elems).filter((e) => e !== head && e !== tail && !isCheckpoint(e) && (sectorTagOf(doc, e.id) === n || (e.kind === 'obj' && e.sector === n && sectorTagOf(doc, e.id) === undefined))).map((e) => e.id);
    const untagged = Object.values(doc.elems).filter((e) => !isCheckpoint(e) && sectorTagOf(doc, e.id) === undefined && !(e.kind === 'obj' && e.sector !== undefined) && e.kind !== 'zone' && !(e.kind === 'asset' && assetInfo(e.name)?.sky)).length;
    // 入口：上一个盘点（或起点）朝这一小节的路口；出口：下一个盘点朝这一小节的路口。哪一侧朝这一小节：离这一小节的东西近的那一侧
    const cen = ids.length ? ids.map((id) => elemBounds(doc.elems[id])).reduce((p, b) => [p[0] + (b.x0 + b.x1) / 2 / ids.length, p[1] + (b.y0 + b.y1) / 2 / ids.length], [0, 0]) : null;
    const port = (p: Piece | undefined | null, enter: boolean) => {
      if (!p) return null;
      const ps = portsOf(p);
      const near = cen && ps.length > 1 ? ps.reduce((u, v) => (Math.hypot(u.x - cen[0], u.y - cen[1]) <= Math.hypot(v.x - cen[0], v.y - cen[1]) ? u : v)) : ps[0];
      // 入口：从盘点出来，前进方向就是路口朝外的方向；出口：走进盘点，前进方向和路口朝外的方向相反
      return { x: near.x, y: near.y, z: r3(p.z), dir: enter ? near.dir : (near.dir + 2) % 4 };
    };
    return {
      result: {
        sector: n, of: total, ids,
        // entry 里带着小节号：从这里重铺的东西（和机关）都算这一小节
        entry: port(head, true) && { ...port(head, true)!, sector: n }, exit: port(tail, false),
        ...(tail ? {} : { exit_note: '这是最后一个小节：出口是终点飞船，不是盘点' }),
        ...(untagged ? { note: `另有 ${untagged} 个元素不知道属于哪个小节（不是这次对话里用 build_path 铺的）：用 get_map 按位置判断` } : {}),
        howto: '重做这一小节：delete_elements(ids) → build_path，from 用 entry，最后一步用 {do: "connect", to: exit} 接回出口。这样前后的小节都不用动',
      },
      summary: `查看第 ${n} 小节（${ids.length} 个元素）`, changed: [],
    };
  },

  // 询问用户：真正的实现在对话面板里（要等用户回答）；这里是没有面板时的兜底
  ask_user() {
    return { result: { error: '现在没法询问用户，请按最合理的理解继续' }, summary: '询问用户（这里问不了）', changed: [], mutated: false };
  },

  focus(doc, a) {
    const ids = idsOf(doc, a);
    return { result: { ok: true }, summary: `请你看这 ${ids.length} 个元素`, changed: [], focus: ids };
  },
};

/** 执行一个工具。出错（参数不对、找不到元素）不抛出，写进 result.error 让模型自己改 */
export function runTool(doc: Doc, name: string, args: unknown): ToolOut {
  const impl = IMPL[name];
  if (!impl) return { result: { error: `没有这个工具：${name}` }, summary: `未知的工具 ${name}`, changed: [], mutated: false };
  const before = Object.keys(doc.elems).length, nextId = doc.nextId;
  try {
    const out = impl(doc, (args && typeof args === 'object' ? args : {}) as Args);
    const mutated = out.mutated ?? (out.changed.length > 0 || Object.keys(doc.elems).length !== before || doc.nextId !== nextId);
    return { ...out, mutated };
  } catch (err) {
    if (!(err instanceof Bad)) throw err;
    return { result: { error: err.message }, summary: `没做成：${err.message}`, changed: [], mutated: false };
  }
}
export const MUTATING = new Set(Object.keys(IMPL).filter((k) => !['get_map', 'check_level', 'focus', 'ask_user', 'get_section'].includes(k)));

// ---------------- 给模型的工具说明（OpenAI 的 function calling 格式） ----------------

type Schema = Record<string, unknown>;
const N = (description: string): Schema => ({ type: 'number', description });
const obj = (properties: Record<string, Schema>, required: string[] = []): Schema => ({ type: 'object', properties, required });
const arr = (items: Schema, description?: string): Schema => ({ type: 'array', items, ...(description ? { description } : {}) });
const IDS = arr({ type: 'integer' }, '元素的 id');
const DIR = { type: 'integer', enum: [0, 1, 2, 3], description: '朝向：0 = +X，1 = +Y，2 = -X，3 = -Y' };
const fn = (name: string, description: string, parameters: Schema) => ({ type: 'function' as const, function: { name, description, parameters } });

export const TOOLS = [
  fn('get_map', '查看整张地图：所有元素的 id、种类、位置、尺寸，以及路面连成了几片。开始动手前、或者不确定现状时先调用。', obj({})),
  fn('build_path', `【铺赛道的首选】沿着一条路线一步一步往前铺，接头、平凹转换、盘点和飞船的朝向、钢轨从哪接出去，都由编辑器算好，你不用算坐标。
from：从哪开始（位置是路的端面中心，z 是路面顶面，dir 是前进方向）；不给就从上一次 build_path 停下的地方接着铺。
steps 里每一步的 do：
- start：放起点（只能是整条赛道的第一步；from 给的位置是起点的中心）。
- road：一段直路。length 必填；style（normal 平路 / sink 凹路 / ribbon 细边框凹路，不给就沿用上一段）；width 默认 5；rise 这一段升高多少（负数是下坡）。平路和凹路之间会自动垫一块平凹转换。
- platform：一块平台，length 和 width（默认 15），沿前进方向居中。
- turn：直角转弯，to = left / right。会放一块拐角方块，然后朝新方向继续。
- checkpoint：小节盘点（前后的路要是 5 宽）。之后的机关自动算进下一小节。
- balloon：终点飞船，接在路的尽头，赛道结束。
- rail：直钢轨，length，rise（升高）；rail_turn：弯轨，to、radius（默认 10）、angle（默认 90）、rise；spiral：螺旋，to、radius、turns（圈数）、rise（总共升高，负数下降）。连着的几步钢轨是一整条。kind = double（默认）/ mono。钢轨之后要接路，方向必须已经转回正方向。
- gap：空一段不铺（length），drop 是落差（往下掉多少）。用来做落差、或者留给别的东西。
- object：在刚铺的那段路上放机关 / 道具。type 必填。单格的（分数球、生命球、道具球、变球器、箱子、风扇、木栅栏、钢罩等）放在路上：back 是离路的末端往回多远（默认 2.5，即最后一格的中间），side 是往左偏多少（负数往右）。架在两段路之间的（推板 P_Modul_25、软木桥 29、跷跷板 30、落石 34、秋千 08、浮板 41）会自动从路的尽头架出去，并在另一头补一格路；flip: true 掉个头。
- asset：顺着赛道放一段木制件（长木桥 Modul_42、波浪木桥 Modul_42_Wide、波浪板 Level2_WaveWood、凹 / 凸木轨道、木制斜坡 WoodSlope 等从一头伸出去的），name 必填，可给 length。
- guard：给刚铺的那段路装护栏，side = left / right / both（默认 both）。
- connect：自动铺路接到一个指定的路口上，to: {x, y, z, dir}（路口的位置，和到达时的前进方向）。会自己安排直路、转弯和坡。用来接回盘点、接回已有的路、把环路闭合。位置实在接不过去会说明还差多少。
- mark：给现在的位置起个名字记下来（name）；goto：回到某个记号接着铺（name，可以给 dir 换个方向）。用它们做岔路、支线、环路：在岔路口 mark，主线铺完再 goto 回来往另一边铺。from 也可以写成 {mark: "名字"}。在已有路面的地方 turn 不会重复放拐角。
某一步做不成时前面的保留，error 里说明原因和停在哪。`, obj({
    from: obj({ x: N('x'), y: N('y'), z: N('路面顶面高度，默认 0'), dir: DIR, sector: { type: 'integer', description: '从这里起是第几小节（不给就按现有盘点的个数算）' }, style: { type: 'string', enum: [...STYLES] }, width: N('默认 5'), mark: { type: 'string', description: '从这个记号出发（这时不用给 x、y）' } }),
    steps: arr(obj({
      do: { type: 'string', enum: ['start', 'road', 'platform', 'turn', 'checkpoint', 'balloon', 'rail', 'rail_turn', 'spiral', 'gap', 'object', 'asset', 'guard', 'mark', 'goto', 'connect'] },
      length: N('长度'), width: N('宽度'), style: { type: 'string', enum: [...STYLES] }, rise: N('这一步升高多少（负数下降）'), depth: N('路面厚度，默认 5'),
      radius: N('弯轨 / 螺旋的半径'), angle: N('弯轨转过的角度'), turns: N('螺旋的圈数'), kind: { type: 'string', enum: ['double', 'mono'] },
      drop: N('gap 的落差'), type: { type: 'string', description: 'object 的机关类型' }, back: N('object：离路的末端往回多远'), side: { description: 'object：往左偏多少（数字）；guard：left / right / both' }, flip: { type: 'boolean' },
      name: { type: 'string', description: 'asset 的素材名；mark / goto 的记号名' }, to: { description: 'turn / rail_turn / spiral：left 或 right；connect：{x, y, z, dir} 要接上去的路口' }, dir: { type: 'integer', enum: [0, 1, 2, 3], description: 'goto：回到记号后换成这个方向' },
    }, ['do'])),
  }, ['steps'])),
  fn('add_roads', '【零散地补一块路时用；铺一整条路线用 build_path】添加方块路面（可以一次多块）。x、y 是最小角，sx、sy 是沿 X、Y 的长度，z 是顶面高度。结果里的 touches 是和它贴在一起的路面 id，空数组说明没接上任何路。', obj({
    roads: arr(obj({
      x: N('最小角 x'), y: N('最小角 y'), z: N('顶面高度，默认 0'), sx: N('沿 X 的长度'), sy: N('沿 Y 的长度'),
      style: { type: 'string', enum: [...STYLES], description: 'normal 平路（默认）；sink 凹路（两边有沿，球不容易掉）；ribbon 细边框凹路（平台用）' },
      depth: N('厚度，默认 5'), slope_axis: { type: 'string', enum: ['x', 'y'], description: '坡沿哪个方向升高' }, slope_dz: N('坡：坐标大的一端比小的一端高多少（负数是低）；这时 z 是坐标小的那一端的高度'),
      angle: N('绕竖直轴转多少度（绕自己的中心），一般不用'),
    }, ['x', 'y', 'sx', 'sy'])),
  }, ['roads'])),
  fn('add_rails', '添加钢轨。从 (x, y, z) 朝 heading 方向出发，由几段首尾相接：直线段给 length，圆弧段给 radius 和 angle（正数左转、负数右转，超过 360 就是螺旋），每段可以有 dz（这一段升高多少）。z 是轨顶高度，接路面时和路面顶面一样高。结果里的 end 是终点的位置和方向。', obj({
    rails: arr(obj({
      x: N('起点 x'), y: N('起点 y'), z: N('轨顶高度'), heading: N('出发方向（度）：0 = +X，90 = +Y'),
      kind: { type: 'string', enum: ['double', 'mono'], description: 'double 双轨（默认，所有球都能走）；mono 单轨（难）' },
      segments: arr(obj({ length: N('直线段的长度'), radius: N('圆弧段的半径'), angle: N('圆弧段转过的角度'), dz: N('这一段升高多少') })),
    }, ['x', 'y', 'segments'])),
  }, ['rails'])),
  fn('add_pieces', `添加起点、小节盘点、平凹转换。x、y 是中心。start：起点（全图只能一个），路口在 dir 那一侧、离中心 ${CP_PORT.start}；checkpoint：小节盘点，沿 dir 的前后两侧各有一个路口、离中心 ${CP_PORT.check}。路面（宽 5）的端面要正好对在路口上，结果里的 ports 就是路口的位置。transition：平凹转换（长 5、宽 5），dir 是从凹路一端指向平路一端的方向；transition_narrow：窄转换（长 2.5）。`, obj({
    pieces: arr(obj({ kind: { type: 'string', enum: ['start', 'checkpoint', 'transition', 'transition_narrow'] }, x: N('中心 x'), y: N('中心 y'), z: N('顶面高度'), dir: DIR }, ['kind', 'x', 'y'])),
  }, ['pieces'])),
  fn('add_objects', '【顺着赛道放机关优先用 build_path 的 object 步骤】添加机关、道具、终点飞船、灯塔等。dir 是机关自己的朝向：飞船的本体在它对准的那一格沿 -dir 方向 24.57 远的空中，所以 dir 要指向「来路」那一边（球往 -dir 方向走上飞船）。x、y、z 给的是它脚下那一格路面的中心和路面顶面高度（不是模型原点），编辑器会自动把它对准。结果里的 cells 是这个机关所有「对准方块」的位置：每个方块底下都要有一格路面；有两个以上方块的机关（推板、秋千、跷跷板、软木桥等）横跨在两段路之间，两个方块之间的路要空出来。', obj({
    objects: arr(obj({ type: { type: 'string', description: '见系统提示里的机关表' }, x: N('脚下那格路面的中心 x'), y: N('中心 y'), z: N('路面顶面高度'), dir: DIR, sector: { type: 'integer', description: '属于第几小节（1 开始），默认 1' } }, ['type', 'x', 'y'])),
  }, ['objects'])),
  fn('add_assets', '添加木制件、特殊路块（形状固定的模型）。x、y、z 是模型原点。可以拉伸的可以给 length（沿它的长度方向）。结果里的 bounds 是放下后占的范围 [x0, y0, z0, x1, y1, z1]。', obj({
    assets: arr(obj({ name: { type: 'string', description: '见系统提示里的素材表' }, x: N('原点 x'), y: N('原点 y'), z: N('原点 z'), dir: DIR, length: N('长度（只有能拉伸的才行）') }, ['name', 'x', 'y'])),
  }, ['assets'])),
  fn('add_death_zone', '添加死亡区（球碰到就死的长方体）。一般在整张图下面放一大片，接住掉下去的球。', obj({ x: N('最小角 x'), y: N('最小角 y'), z: N('顶面高度'), sx: N('沿 X 的长度'), sy: N('沿 Y 的长度'), depth: N('厚度，默认 5') }, ['x', 'y', 'z', 'sx', 'sy'])),
  fn('add_sky', '添加云层（一张图只能一个），放在所有路面下方。', obj({ z: N('高度，一般比最低的路面低 40 以上'), vortex: { type: 'boolean', description: 'true 是漩涡云层' }, x: N('中心 x，默认 0'), y: N('中心 y，默认 0') }, ['z'])),
  fn('add_guards', '在路面外沿放护栏：给一个靠近路边的点，沿它所在的那一整条直边放一条（两头各内缩 inset）。', obj({ at: arr(obj({ x: N('x'), y: N('y'), z: N('路面顶面高度') }, ['x', 'y'])), inset: N('两头内缩，默认 1.5') }, ['at'])),
  fn('update_elements', '修改已有元素的属性。所有元素都能改 x、y、z；路面还能改 sx、sy、depth、style、slope_axis、slope_dz；钢轨能改 heading、kind、segments；盘点、机关、素材能改 dir；机关能改 sector。', obj({
    updates: arr(obj({ id: { type: 'integer' }, x: N(''), y: N(''), z: N(''), sx: N(''), sy: N(''), depth: N(''), style: { type: 'string', enum: [...STYLES] }, slope_axis: { type: 'string', enum: ['x', 'y'] }, slope_dz: N('0 是去掉坡'), heading: N(''), kind: { type: 'string', enum: ['double', 'mono'] }, segments: arr(obj({ length: N(''), radius: N(''), angle: N(''), dz: N('') })), dir: DIR, sector: { type: 'integer' } }, ['id'])),
  }, ['updates'])),
  fn('move_elements', '把一批元素整体平移。', obj({ ids: IDS, dx: N('沿 X'), dy: N('沿 Y'), dz: N('沿 Z（高度）') }, ['ids'])),
  fn('rotate_elements', '把一批元素绕竖直轴整体旋转（逆时针为正）。不给 cx、cy 就绕它们整体的中心。', obj({ ids: IDS, degrees: N('角度'), cx: N('转轴 x'), cy: N('转轴 y') }, ['ids', 'degrees'])),
  fn('mirror_elements', '把一批元素镜像。axis = x 是 x 取反（左右翻），y 是 y 取反。不给 at 就以它们整体的中线为镜面。只有路面、平凹转换、钢轨、护栏、死亡区能镜像，机关和木制件会留在原地。', obj({ ids: IDS, axis: { type: 'string', enum: ['x', 'y'] }, at: N('镜面的位置') }, ['ids', 'axis'])),
  fn('duplicate_elements', '复制一批元素，每份副本依次偏移 (dx, dy, dz)。count 大于 1 就是等距排一排。', obj({ ids: IDS, dx: N(''), dy: N(''), dz: N(''), count: { type: 'integer', description: '复制几份，默认 1' } }, ['ids'])),
  fn('delete_elements', '删除一批元素。', obj({ ids: IDS }, ['ids'])),
  fn('check_level', '检查关卡。issues：游戏规则上的问题（起点、飞船、小节、云层、死亡区）；design_problems：搭得不对的地方（平路直接接凹路、盘点路口没接路、机关脚下没路、飞船压在路上、钢轨悬空、死亡区没盖住……），每条都说了是哪几个元素、怎么改；road_groups：路面连成了几片。每做完一个阶段就调用，把 design_problems 全部修掉再往下做。', obj({})),
  fn('get_section', '查看某一个小节：它包含哪些元素（ids），入口（entry：上一个盘点或起点的路口，位置和出发方向）和出口（exit：下一个盘点的路口，位置和到达方向）。要改、要重做某一个小节时先调用它。', obj({ sector: { type: 'integer', description: '第几小节，从 1 开始' } }, ['sector'])),
  fn('ask_user', '向用户提一个问题并等他回答。用在：需求有几种差别很大的理解、做错了要大返工的时候；或者用户只给了一个很笼统的想法，需要先定下一两件关键的事（难度、长短、想突出什么）。一次只问一件事，给 2～4 个具体的选项（可以有一个「你来定」），用户也可以不选、自己打字回答。小事不要问，自己定。', obj({
    question: { type: 'string', description: '问题，一句话' },
    options: arr({ type: 'string' }, '2～4 个选项，每个是一句完整的话'),
  }, ['question'])),
  fn('focus', '把视角对准一批元素并选中它们，让用户看。', obj({ ids: IDS }, ['ids'])),
];

/** 系统提示里的素材表、机关表 */
export function catalogText(): string {
  const objs = OBJ_TYPES.map((t) => `${t.type}（${t.label}${t.more ? `，${t.more.length + 1} 个对准方块` : ''}${t.unique ? '，全图一个' : ''}）`).join('、');
  const assets = ASSET_INFO.filter((a) => !a.sky).map((a) => {
    const s = [0, 1, 2].map((k) => r3(a.max[k] - a.min[k]));
    return `${a.name}（${a.label}，${s[0]}×${s[1]}×${s[2]}，原点到包围盒 [${a.min.map(r3).join(',')}]～[${a.max.map(r3).join(',')}]${a.stretch ? '，可给 length' : ''}）`;
  }).join('；');
  return `机关 / 道具 / 装饰（add_objects 的 type）：${objs}。\n木制件 / 特殊路块（add_assets 的 name，尺寸是 dir = 0 时的 X×Y×Z）：${assets}。`;
}
