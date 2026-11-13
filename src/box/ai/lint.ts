// 设计检查：关卡检查（check.ts）管的是「游戏能不能加载」，这里管的是「搭得对不对」——
// 平路直接接凹路、盘点的路口没接路、机关脚下没有路、飞船压在路上、钢轨悬空、死亡区没盖住……
// 这些是大模型最常犯的错。检查结果随 check_level 一起还给它，每条都说清楚是哪几个元素、该怎么改。
// 只看没转过的元素（转过的、倾斜的不参与这种粗略的判断）。
import { assetInfo } from '../asset-info';
import { elemBounds } from '../ops';
import { CP_PORT, Doc, Elem, Obj, Piece, RailElem, anchorRects, footprint, isCheckpoint, railPath, toWorld } from '../types';
import { objType } from '../../model/objects';

export interface Lint { text: string; ids: number[] }
type Rc = { id: number; x0: number; y0: number; x1: number; y1: number; z0: number; z1: number; style?: string; kind: string };
const DX = [1, 0, -1, 0], DY = [0, 1, 0, -1];
const E = 0.05;

/** 能当路走的东西的范围：路面、盘点、转换（没转过的） */
export function roadRects(doc: Doc): Rc[] {
  const out: Rc[] = [];
  for (const e of Object.values(doc.elems)) {
    if (e.kind !== 'box' && e.kind !== 'piece') continue;
    if (e.ang || e.q) continue;
    const f = footprint(e), dz = e.kind === 'box' && e.slope ? e.slope.dz : 0;
    out.push({ id: e.id, ...f, z0: Math.min(e.z, e.z + dz), z1: Math.max(e.z, e.z + dz), style: e.kind === 'box' ? e.style : undefined, kind: e.kind === 'box' ? 'road' : e.type });
  }
  return out;
}
/** 边贴边（至少重合 1 长）或者有重叠，并且高度范围挨着 */
export const touching = (a: Rc, b: Rc) => {
  const ox = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0), oy = Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0);
  return ((ox > -E && oy > 1) || (oy > -E && ox > 1)) && a.z0 <= b.z1 + E && b.z0 <= a.z1 + E;
};
const overlapArea = (a: Rc, b: Rc) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
/** 这个点（高度 z）底下有没有路；margin 是允许超出边缘多少 */
const roadUnder = (rs: Rc[], x: number, y: number, z: number, margin = 0.3, dz = 0.6) => rs.find((r) => x >= r.x0 - margin && x <= r.x1 + margin && y >= r.y0 - margin && y <= r.y1 + margin && z >= r.z0 - dz && z <= r.z1 + dz);
/** 这个点是不是正好在某块路的边上（路的端面对着它） */
const roadEdgeAt = (rs: Rc[], x: number, y: number, z: number, tol = 1.2) => rs.find((r) => {
  const inX = x >= r.x0 - tol && x <= r.x1 + tol, inY = y >= r.y0 - tol && y <= r.y1 + tol;
  const onEdge = (inY && (Math.abs(x - r.x0) < tol || Math.abs(x - r.x1) < tol)) || (inX && (Math.abs(y - r.y0) < tol || Math.abs(y - r.y1) < tol));
  return onEdge && z >= r.z0 - 0.8 && z <= r.z1 + 0.8;
});

export function lintDesign(doc: Doc): Lint[] {
  const out: Lint[] = [];
  const all = Object.values(doc.elems), rs = roadRects(doc);
  const boxes = rs.filter((r) => r.kind === 'road');

  // 1. 平路和凹路直接相接，中间没有平凹转换
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    if (!touching(a, b) || overlapArea(a, b) > 1) continue;
    if ((a.style === 'normal' && b.style === 'sink') || (a.style === 'sink' && b.style === 'normal')) out.push({ text: `平路 #${a.style === 'normal' ? a.id : b.id} 和凹路 #${a.style === 'sink' ? a.id : b.id} 直接接在一起：中间要放一块平凹转换（add_pieces kind=transition，长 5，dir 从凹路指向平路），把其中一段缩短 5 给它腾位置`, ids: [a.id, b.id] });
  }
  // 2. 路面叠在一起（同一个地方放了两块）
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j], area = overlapArea(a, b);
    if (area > 4 && Math.abs(a.z1 - b.z1) < 0.5 && Math.abs(a.z0 - b.z0) < 0.5) out.push({ text: `路面 #${a.id} 和 #${b.id} 叠在一起了（重叠 ${Math.round(area)}）：挪开或者删掉一块`, ids: [a.id, b.id] });
  }
  // 3. 起点、盘点的路口有没有接路
  for (const e of all) {
    if (e.kind !== 'piece' || !isCheckpoint(e) || e.ang || e.q) continue;
    const p = e as Piece, dirs = p.type === 'start' ? [p.rot] : [p.rot, (p.rot + 2) % 4], dist = p.type === 'start' ? CP_PORT.start : CP_PORT.check;
    const others = rs.filter((r) => r.id !== p.id);
    for (const d of dirs) {
      // 路口外面 1 远的地方要有路
      const x = p.x + DX[d] * (dist + 1), y = p.y + DY[d] * (dist + 1);
      if (!roadUnder(others, x, y, p.z)) out.push({ text: `${p.type === 'start' ? '起点' : '小节盘点'} #${p.id} 朝 ${['+X', '+Y', '-X', '-Y'][d]} 的路口没有接路：路的端面要对在 (${(p.x + DX[d] * dist).toFixed(3)}, ${(p.y + DY[d] * dist).toFixed(3)})，高度 ${p.z}`, ids: [p.id] });
    }
  }
  // 4. 机关：脚下有没有路；架在两段路之间的，中间是不是空着；飞船有没有压在路上
  for (const e of all) {
    if (e.kind !== 'obj' || e.ang || e.q) continue;
    const o = e as Obj, t = objType(o.type);
    if (!t?.anchor || t.cat !== 'module') continue;
    const cells = anchorRects(o).map((q) => { const [x, y, z] = toWorld(o, [(q.x0 + q.x1) / 2, (q.y0 + q.y1) / 2, q.top]); return { x, y, z }; });
    const lift = t.prop ? 0.2 : 0;
    const missing = cells.filter((q) => !roadUnder(rs, q.x, q.y, q.z - lift));
    if (missing.length) out.push({ text: `${t.label} #${o.id} 有 ${missing.length} 个对准方块底下没有路：${missing.map((q) => `(${q.x.toFixed(2)}, ${q.y.toFixed(2)}, z ${q.z.toFixed(2)})`).join('、')} 这里要各有一格路面（5×5，顶面在这个高度）`, ids: [o.id] });
    for (const [i, j] of t.split ?? []) {
      const a = cells[i], b = cells[j];
      if (!a || !b) continue;
      const r = roadUnder(rs, (a.x + b.x) / 2, (a.y + b.y) / 2, (a.z + b.z) / 2, -0.5);
      if (r) out.push({ text: `${t.label} #${o.id} 架在两格路之间，中间要空着，但路面 #${r.id} 从底下穿过去了：把这块路在两格之间断开`, ids: [o.id, r.id] });
    }
    if (o.type === 'PE_Balloon') {
      // 飞船本体（原点）周围不能有路：有的话是方向反了
      const hit = rs.find((r) => o.x > r.x0 - 6 && o.x < r.x1 + 6 && o.y > r.y0 - 6 && o.y < r.y1 + 6 && Math.abs(r.z1 - o.z) < 6);
      if (hit) out.push({ text: `终点飞船 #${o.id} 的本体压在路面 #${hit.id} 上了：方向反了。飞船要在路的尽头再往前的空中——把 dir 改成相反的方向，并保证它对准的那一格是路的最后一格`, ids: [o.id, hit.id] });
    }
  }
  // 4b. 球种：有风扇的小节，这一小节或者前面的小节里要有纸球变球器
  const objs = all.filter((e): e is Obj => e.kind === 'obj');
  const fanSecs = [...new Set(objs.filter((o) => o.type === 'P_Modul_18').map((o) => o.sector ?? 1))];
  for (const sec of fanSecs) {
    if (!objs.some((o) => o.type === 'P_Trafo_Paper' && (o.sector ?? 1) <= sec)) out.push({ text: `第 ${sec} 小节有风扇，但到这里为止没有纸球变球器：只有纸球能被风扇吹起来，木球和石球过不去。在风扇区之前放一个纸球变球器`, ids: objs.filter((o) => o.type === 'P_Modul_18' && (o.sector ?? 1) === sec).map((o) => o.id) });
  }
  // 5. 钢轨两头有没有接上东西（路的端面、另一条钢轨的头、木制件）
  const rails = all.filter((e): e is RailElem => e.kind === 'rail' && !e.road && !e.q);
  const ends = rails.map((e) => { const p = railPath(e); return { id: e.id, a: p[0], b: p[p.length - 1] }; });
  const assets = all.filter((e) => e.kind === 'asset' && !assetInfo(e.name)?.sky).map((e) => ({ id: e.id, b: elemBounds(e) }));
  for (const r of ends) {
    const dangling: string[] = [];
    for (const [name, p] of [['起点', r.a], ['终点', r.b]] as const) {
      const ok = roadEdgeAt(rs, p.x, p.y, p.z) || roadUnder(rs, p.x, p.y, p.z, 0.5, 0.8)
        || ends.some((o) => o.id !== r.id && [o.a, o.b].some((q) => Math.hypot(q.x - p.x, q.y - p.y, q.z - p.z) < 1.5))
        || assets.some((s) => p.x > s.b.x0 - 1.5 && p.x < s.b.x1 + 1.5 && p.y > s.b.y0 - 1.5 && p.y < s.b.y1 + 1.5 && p.z > s.b.z0 - 2 && p.z < s.b.z1 + 2);
      if (!ok) dangling.push(`${name} (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, z ${p.z.toFixed(2)})`);
    }
    if (dangling.length) out.push({ text: `钢轨 #${r.id} 的${dangling.join('、')}没有接到路面或别的钢轨上：路的端面中间要正好对着轨头，高度一样`, ids: [r.id] });
  }
  // 6. 云层、死亡区在不在路的下面、盖没盖住
  if (rs.length) {
    const lo = Math.min(...rs.map((r) => r.z0)), bx0 = Math.min(...rs.map((r) => r.x0)), by0 = Math.min(...rs.map((r) => r.y0)), bx1 = Math.max(...rs.map((r) => r.x1)), by1 = Math.max(...rs.map((r) => r.y1));
    const zones = all.filter((e): e is Extract<Elem, { kind: 'zone' }> => e.kind === 'zone' && !e.ang && !e.q);
    for (const z of zones) if (z.z > lo - 5) out.push({ text: `死亡区 #${z.id} 的顶面（z ${z.z}）没有比最低的路面（z ${lo}）低：球在路上就会死。放到最低的路面下方 20～30`, ids: [z.id] });
    if (zones.length) {
      const zx0 = Math.min(...zones.map((z) => z.x)), zy0 = Math.min(...zones.map((z) => z.y)), zx1 = Math.max(...zones.map((z) => z.x + z.sx)), zy1 = Math.max(...zones.map((z) => z.y + z.sy));
      if (zx0 > bx0 - 20 || zy0 > by0 - 20 || zx1 < bx1 + 20 || zy1 < by1 + 20) out.push({ text: `死亡区没有盖住整张图：路面的范围是 x ${bx0.toFixed(0)}～${bx1.toFixed(0)}、y ${by0.toFixed(0)}～${by1.toFixed(0)}，死亡区每边至少再多出 50`, ids: zones.map((z) => z.id) });
    }
    for (const e of all) if (e.kind === 'asset' && assetInfo(e.name)?.sky && e.z > lo - 20) out.push({ text: `云层 #${e.id}（z ${e.z}）离最低的路面（z ${lo}）太近或者在它上面：放到最低的路面下方 40 以上`, ids: [e.id] });
  }
  return out;
}
