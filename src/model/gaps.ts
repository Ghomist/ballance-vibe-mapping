// 从中间断开的机关（秋千、推板、双向挡板、软木桥、跷跷板、落石、T 型板、浮板）。
//
// 原版里这些机关横跨在两段路之间，中间没有路面。放在一段直路中间时，自动把对准方块之间的那段路去掉，
// 断开处是开放端点；端点上记着属于哪个机关（GapMark），机关挪走或删掉后两侧的路重新接回一整段。
import { anchorBlocks, objType } from './objects';
import { DX, DY, EndKey, FreeEnd, GapMark, Model, Seg, axisOf, endOutDir, endPos, endZ, isFree, opp } from './types';

const EPS = 1e-6;
/** 断开的长度太短（小于这个）就不断 */
const MIN_GAP = 0.5;

export const isSplitObj = (type: string) => !!objType(type)?.split;

/** 缺口长度取整：接近 2.5 的倍数就取倍数（原版数据有零点几的误差），否则取 0.5 的倍数 */
function roundGap(len: number) {
  const k = Math.round(len / 2.5) * 2.5;
  return Math.abs(k - len) < 0.45 ? k : Math.round(len * 2) / 2;
}

/**
 * 机关跨着的缺口：对准方块投影到某根坐标轴上，相邻方块之间最大的空当。
 * 返回轴、缺口两头的坐标、对准方块的顶面高度，以及方块的横向中心（路要从这些位置穿过）。
 */
export function gapOf(o: { type: string; x: number; y: number; z: number; rot: number }) {
  if (!isSplitObj(o.type)) return null;
  const blocks = anchorBlocks(o);
  if (blocks.length < 2) return null;
  let best: { axis: 0 | 1; lo: number; hi: number } | null = null;
  for (const axis of [0, 1] as const) {
    const iv = blocks.map((b) => (axis === 0 ? [b.x - b.hx, b.x + b.hx] : [b.y - b.hy, b.y + b.hy])).sort((p, q) => p[0] - q[0]);
    let end = iv[0][1];
    for (const [lo, hi] of iv.slice(1)) {
      if (lo - end > (best ? best.hi - best.lo : MIN_GAP)) best = { axis, lo: end, hi: lo };
      end = Math.max(end, hi);
    }
  }
  if (!best) return null;
  // 放置时对齐到格子上的那个方块一侧（边沿离 2.5 的格线更近的一侧）保持不动，另一侧按取整后的长度
  const off = (v: number) => Math.abs(v / 2.5 - Math.round(v / 2.5));
  const len = roundGap(best.hi - best.lo);
  if (off(best.lo) <= off(best.hi)) best.hi = best.lo + len;
  else best.lo = best.hi - len;
  const p = blocks[0];
  const lats = blocks.map((b) => (best!.axis === 0 ? b.y : b.x));
  return { ...best, z: p.top, lats };
}

const mark = (obj: number, len = 0, style?: FreeEnd['style']): GapMark => (style ? { obj, len, style } : { obj, len });

/** 放好（或挪动后）的机关：把它跨着的那段直路去掉。返回断开了几段路 */
export function cutForObj(m: Model, id: number): number {
  const o = m.objs[id];
  const g = o && gapOf(o);
  if (!g) return 0;
  let n = 0;
  for (const s of Object.values(m.segs)) {
    if (axisOf(s.dir) !== g.axis) continue;
    const za = endZ(m, s, 'a');
    if (Math.abs(za - g.z) > 0.01 || Math.abs(endZ(m, s, 'b') - za) > EPS) continue;
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
  const lost = marked(m, (g) => !m.objs[g.obj] || !isSplitObj(m.objs[g.obj].type));
  if (!lost.length) return false;
  uncutObj(m, lost[0].g.obj);
  return true;
}
