// 从中间断开的机关（秋千、推板、双向挡板、软木桥、跷跷板、落石、T 型板、浮板）。
//
// 原版里这些机关横跨在两段路之间，中间没有路面。放在一段直路中间时，自动把对准方块之间的那段路去掉，
// 断开处是开放端点；端点上记着属于哪个机关（GapMark），机关挪走或删掉后两侧的路重新接回一整段。
import { anchorBlocks, objType } from './objects';
import { DX, DY, EndKey, FreeEnd, GapMark, Model, Seg, axisOf, endOutDir, endPos, endZ, isFree, nodePorts, opp, SINK_DEPTH } from './types';

const EPS = 1e-6;
/** 断开的长度太短（小于这个）就不断 */
const MIN_GAP = 0.5;

export const isSplitObj = (type: string) => !!objType(type)?.split;

/**
 * 机关跨着的缺口（每对对准方块一个）：两个方块中心连线方向上相隔更远的那根轴，缺口是两个方块相对的两个面之间。
 * 缺口以对准方块为准，不取整（例如推板 10.06、软木桥 15.33、跷跷板 14.8，与原版实测一致）。
 * 返回轴、缺口两头的坐标、方块顶面高度，以及两个方块的横向中心（路要从这里穿过）。
 */
export function gapsOf(o: { type: string; x: number; y: number; z: number; rot: number }) {
  const pairs = objType(o.type)?.split;
  if (!pairs) return [];
  const blocks = anchorBlocks(o);
  const out: { axis: 0 | 1; lo: number; hi: number; z: number; lats: number[] }[] = [];
  for (const [i, j] of pairs) {
    const a = blocks[i], b = blocks[j];
    if (!a || !b) continue;
    const axis: 0 | 1 = Math.abs(a.x - b.x) >= Math.abs(a.y - b.y) ? 0 : 1;
    const [p, q] = (axis === 0 ? a.x < b.x : a.y < b.y) ? [a, b] : [b, a];
    const lo = axis === 0 ? p.x + p.hx : p.y + p.hy, hi = axis === 0 ? q.x - q.hx : q.y - q.hy;
    if (hi - lo < MIN_GAP) continue;
    out.push({ axis, lo, hi, z: a.top, lats: axis === 0 ? [a.y, b.y] : [a.x, b.x] });
  }
  return out;
}

/** 对准方块落在这条路上：顶面与路面齐平，凹槽路是与下沉 0.7 的槽底齐平 */
const atLevel = (roadZ: number, style: string, top: number) =>
  Math.abs(roadZ - top) < 0.01 || (style === 'sink' && Math.abs(roadZ - SINK_DEPTH - top) < 0.01);

const mark = (obj: number, len = 0, style?: FreeEnd['style']): GapMark => (style ? { obj, len, style } : { obj, len });

/** 放好（或挪动后）的机关：把它跨着的那段直路去掉。返回断开了几段路 */
export function cutForObj(m: Model, id: number): number {
  const o = m.objs[id];
  if (!o) return 0;
  let n = 0;
  for (const g of gapsOf(o)) n += cutRange(m, id, g);
  return n;
}

export type GapRange = ReturnType<typeof gapsOf>[number];

/**
 * 把沿 axis、[lo, hi] 这一段、横向中心在 lats 附近、顶面（或凹槽槽底）在 z 的直路去掉，断开处记在机关 id 名下。
 * 也用于凹槽路上嵌入风扇 / 变球器底座（挖掉底座那一格）。返回断开了几段路
 */
export function cutRange(m: Model, id: number, g: GapRange): number {
  let n = 0;
  {
    // 缺口里（含两头）的截面接头先拆开成两个开放端点（坡道分界、分隔过的路都会有接头），之后照常截断；
    // 接回去时两侧的开放端点重新碰在一起，规范化会自动接上
    for (const j of Object.values(m.nodes)) {
      if (j.kind !== 'joint' || j.axis !== g.axis || !atLevel(j.z, j.style, g.z)) continue;
      const c = g.axis === 0 ? j.x : j.y, lat = g.axis === 0 ? j.y : j.x;
      if (c < g.lo - EPS || c > g.hi + EPS || !g.lats.some((l) => Math.abs(l - lat) < 2.5 - EPS)) continue;
      for (const p of nodePorts(m, j.id)) if (p) m.segs[p.seg][p.key] = { node: null, z: j.z, style: 'open' };
      delete m.nodes[j.id];
      if (m.root === j.id) m.root = Object.keys(m.segs).map(Number)[0] ?? null;
    }
    n += cutLine(m, id, g);
  }
  return n;
}

function cutLine(m: Model, id: number, g: GapRange): number {
  let n = 0;
  for (const s of Object.values(m.segs)) {
    if (axisOf(s.dir) !== g.axis) continue;
    const za = endZ(m, s, 'a');
    if (!atLevel(za, s.style, g.z) || Math.abs(endZ(m, s, 'b') - za) > EPS) continue;
    const lat = g.axis === 0 ? s.y : s.x;
    if (!g.lats.some((l) => Math.abs(l - lat) < 2.5 - EPS)) continue;
    // 缺口换算到这段路的 t 上
    const c0 = g.axis === 0 ? s.x : s.y, sign = DX[s.dir] + DY[s.dir];
    const t0 = (g.lo - c0) * sign, t1 = (g.hi - c0) * sign;
    const ta = Math.min(t0, t1), tb = Math.max(t0, t1);
    if (tb <= EPS || ta >= s.len - EPS) continue;
    const keepA = ta > EPS, keepB = tb < s.len - EPS;
    if (!keepA && !keepB) continue; // 整段都在缺口里：不删路
    if ((!keepA && !isFree(s.a)) || (!keepB && !isFree(s.b))) continue; // 会把接着的路块断开
    if (keepA && keepB) {
      const s2: Seg = { ...s, id: m.nextId++, x: s.x + DX[s.dir] * tb, y: s.y + DY[s.dir] * tb, len: s.len - tb, a: { node: null, z: za, style: 'open', gap: mark(id) } };
      m.segs[s2.id] = s2;
      s.len = ta;
      s.b = { node: null, z: za, style: 'open', gap: mark(id) };
    } else if (keepA) {
      const e = s.b as FreeEnd;
      s.b = { node: null, z: za, style: 'open', gap: mark(id, s.len - ta, e.style) };
      s.len = ta;
    } else {
      const e = s.a as FreeEnd;
      s.a = { node: null, z: za, style: 'open', gap: mark(id, tb, e.style) };
      s.x += DX[s.dir] * tb; s.y += DY[s.dir] * tb;
      s.len -= tb;
    }
    n++;
  }
  return n;
}

function marked(m: Model, pred: (g: GapMark) => boolean): { s: Seg; k: EndKey; g: GapMark }[] {
  const out: { s: Seg; k: EndKey; g: GapMark }[] = [];
  for (const s of Object.values(m.segs)) {
    for (const k of ['a', 'b'] as EndKey[]) {
      const e = s[k];
      if (isFree(e) && e.gap && pred(e.gap)) out.push({ s, k, g: e.gap });
    }
  }
  return out;
}

/** 把机关断开的路接回去 */
export function uncutObj(m: Model, id: number) {
  const ends = marked(m, (g) => g.obj === id);
  const done = new Set<string>();
  for (const a of ends) {
    if (done.has(`${a.s.id}${a.k}`) || !m.segs[a.s.id]) continue;
    done.add(`${a.s.id}${a.k}`);
    const s = a.s, out = endOutDir(s, a.k);
    const [px, py] = endPos(s, a.k), pz = endZ(m, s, a.k);
    // 对面：同一个机关的、正对着的、在同一条中线上的开放端点
    const b = ends.find((e) => !done.has(`${e.s.id}${e.k}`) && m.segs[e.s.id] && e.s.id !== s.id && endOutDir(e.s, e.k) === opp(out) && (() => {
      const [qx, qy] = endPos(e.s, e.k);
      const lat = (qx - px) * -DY[out] + (qy - py) * DX[out], fwd = (qx - px) * DX[out] + (qy - py) * DY[out];
      return Math.abs(lat) < 1e-3 && fwd > -EPS && Math.abs(endZ(m, e.s, e.k) - pz) < 1e-3;
    })());
    if (b) {
      done.add(`${b.s.id}${b.k}`);
      // 两段并成一段：保留 a 端在前的那段，伸到对面那段的远端
      const [first, second] = a.k === 'b' ? [s, b.s] : [b.s, s];
      if (first.dir !== second.dir) {
        // 方向不一致（不该出现）：只去掉标记
        delete (s[a.k] as FreeEnd).gap; delete (b.s[b.k] as FreeEnd).gap;
        continue;
      }
      const [fx, fy] = endPos(first, 'a'), [ex, ey] = endPos(second, 'b');
      first.len = Math.abs(ex - fx) + Math.abs(ey - fy);
      first.b = second.b;
      delete m.segs[second.id];
      if (m.root === second.id) m.root = first.id;
      continue;
    }
    // 只有这一侧（另一侧被删掉了）
    const e = s[a.k] as FreeEnd;
    if (a.g.style) {
      // 机关贴着路的一头放的：把去掉的那截补回来
      if (a.k === 'a') { s.x -= DX[s.dir] * a.g.len; s.y -= DY[s.dir] * a.g.len; }
      s.len += a.g.len;
      e.style = a.g.style;
    }
    delete e.gap;
  }
}

/** 规范化：机关没了的缺口接回去；不存在的直道上的标记不用管 */
export function repairGaps(m: Model): boolean {
  const lost = marked(m, (g) => !m.objs[g.obj]);
  if (!lost.length) return false;
  uncutObj(m, lost[0].g.obj);
  return true;
}
