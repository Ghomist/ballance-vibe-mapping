// 大平台：用 1.25 小格的集合描述任意直角多边形区域。
import {
  CELL, DX, DY, Dir, EndKey, HALF, MNode, Model, Seg,
  axisOf, endPos, endZ, isFree, nodeLinks, opp,
} from './types';

const EPS = 1e-6;
export const cellKey = (i: number, j: number) => `${i},${j}`;
export const parseCell = (k: string) => k.split(',').map(Number) as [number, number];
const ci = (v: number) => Math.round(v / CELL);

export function cellSet(n: MNode): Set<string> { return new Set(n.cells ?? []); }

/** 矩形区域（坐标需为 CELL 的整数倍）对应的小格 */
export function rectCells(x0: number, y0: number, x1: number, y1: number): string[] {
  const out: string[] = [];
  const [ia, ib] = [ci(Math.min(x0, x1)), ci(Math.max(x0, x1))];
  const [ja, jb] = [ci(Math.min(y0, y1)), ci(Math.max(y0, y1))];
  for (let i = ia; i < ib; i++) for (let j = ja; j < jb; j++) out.push(cellKey(i, j));
  return out;
}

export function platformBBox(n: MNode) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const k of n.cells ?? []) {
    const [i, j] = parseCell(k);
    x0 = Math.min(x0, i * CELL); y0 = Math.min(y0, j * CELL);
    x1 = Math.max(x1, (i + 1) * CELL); y1 = Math.max(y1, (j + 1) * CELL);
  }
  return { x0, y0, x1, y1 };
}

/** 平台的参考点放在包围盒中心（用于显示、高度基准标记） */
export function updatePlatformCenter(n: MNode) {
  const b = platformBBox(n);
  if (!Number.isFinite(b.x0)) return;
  n.x = (b.x0 + b.x1) / 2;
  n.y = (b.y0 + b.y1) / 2;
}

/** 位于边界线上的一小段边：从 (x,y) 起沿 along 方向长 CELL，outward 为朝外方向 */
export interface UnitEdge { x: number; y: number; along: 0 | 1; out: Dir }

export function boundaryEdges(cells: Set<string>): UnitEdge[] {
  const out: UnitEdge[] = [];
  for (const k of cells) {
    const [i, j] = parseCell(k);
    if (!cells.has(cellKey(i + 1, j))) out.push({ x: (i + 1) * CELL, y: j * CELL, along: 1, out: 0 });
    if (!cells.has(cellKey(i - 1, j))) out.push({ x: i * CELL, y: j * CELL, along: 1, out: 2 });
    if (!cells.has(cellKey(i, j + 1))) out.push({ x: i * CELL, y: (j + 1) * CELL, along: 0, out: 1 });
    if (!cells.has(cellKey(i, j - 1))) out.push({ x: i * CELL, y: j * CELL, along: 0, out: 3 });
  }
  return out;
}

/** 平台边界上一段朝外的开口（宽 5，以 (cx,cy) 为中心、朝 out）是否完整：内侧全有格、外侧全空 */
export function openingFits(cells: Set<string>, cx: number, cy: number, out: Dir): boolean {
  const ax = axisOf(out);
  const lineC = ax === 0 ? cx : cy;
  const along = ax === 0 ? cy : cx;
  const sg = out === 0 || out === 1 ? 1 : -1;
  const lineI = ci(lineC);
  if (Math.abs(lineI * CELL - lineC) > EPS) return false;
  const inI = sg > 0 ? lineI - 1 : lineI;
  const outI = sg > 0 ? lineI : lineI - 1;
  for (let a = ci(along - HALF); a < ci(along + HALF); a++) {
    const inK = ax === 0 ? cellKey(inI, a) : cellKey(a, inI);
    const outK = ax === 0 ? cellKey(outI, a) : cellKey(a, outI);
    if (!cells.has(inK) || cells.has(outK)) return false;
  }
  return true;
}

/** 直道接在平台上的开口位置与朝外方向（从平台指向直道） */
export function linkOpening(s: Seg, k: EndKey): { x: number; y: number; out: Dir } {
  const [x, y] = endPos(s, k);
  return { x, y, out: k === 'a' ? s.dir : opp(s.dir) };
}

// ---------------- 转换与编辑 ----------------

function newPlatform(m: Model, z: number, style: 'normal' | 'sink', cells: string[]): MNode {
  const id = m.nextId++;
  const n: MNode = { id, kind: 'platform', x: 0, y: 0, z, style, cells: [...new Set(cells)] };
  updatePlatformCenter(n);
  m.nodes[id] = n;
  return n;
}

/** 直道某一端原先连着的东西，改接到平台上 */
function reattachEnd(m: Model, s: Seg, k: EndKey, pid: number) {
  const e = s[k];
  if (isFree(e)) return;
  const n = m.nodes[e.node];
  if (!n) return;
  if (n.kind === 'joint') {
    // 接头另一侧的直道直接接到平台
    for (const l of nodeLinks(m, n.id)) if (l.seg !== s.id) m.segs[l.seg][l.key] = { node: pid };
    delete m.nodes[n.id];
    return;
  }
  // 路块 / 转换块 / 平台：用零长度直道相连
  const [x, y] = endPos(s, k);
  const dirFromPlatform = k === 'a' ? opp(s.dir) : s.dir;
  const id = m.nextId++;
  m.segs[id] = { id, x, y, dir: dirFromPlatform, len: 0, style: n.style, a: { node: pid }, b: { node: n.id } };
}

/** 把一段平直道连同侧面拉出的 w 宽度变成平台；w 可为 0（仅转换） */
export function segToPlatform(m: Model, segId: number, side: Dir, w: number): number | null {
  const s = m.segs[segId];
  if (!s || Math.abs(endZ(m, s, 'a') - endZ(m, s, 'b')) > EPS) return null;
  const [ax, ay] = endPos(s, 'a');
  const [bx, by] = endPos(s, 'b');
  const P = [-DY[s.dir], DX[s.dir]];
  let x0 = Math.min(ax, bx) - Math.abs(P[0]) * HALF, x1 = Math.max(ax, bx) + Math.abs(P[0]) * HALF;
  let y0 = Math.min(ay, by) - Math.abs(P[1]) * HALF, y1 = Math.max(ay, by) + Math.abs(P[1]) * HALF;
  ({ x0, y0, x1, y1 } = growRect({ x0, y0, x1, y1 }, side, w));
  const p = newPlatform(m, endZ(m, s, 'a'), s.style, rectCells(x0, y0, x1, y1));
  reattachEnd(m, s, 'a', p.id);
  reattachEnd(m, s, 'b', p.id);
  delete m.segs[s.id];
  if (m.root === s.id) m.root = p.id;
  return p.id;
}

/** 路块连同侧面拉出的 w 宽度变成平台 */
export function blockToPlatform(m: Model, nodeId: number, side: Dir, w: number): number | null {
  const n = m.nodes[nodeId];
  if (!n || n.kind !== 'block') return null;
  const r = growRect({ x0: n.x - HALF, y0: n.y - HALF, x1: n.x + HALF, y1: n.y + HALF }, side, w);
  const p = newPlatform(m, n.z, n.style, rectCells(r.x0, r.y0, r.x1, r.y1));
  for (const l of nodeLinks(m, n.id)) m.segs[l.seg][l.key] = { node: p.id };
  delete m.nodes[n.id];
  if (m.root === n.id) m.root = p.id;
  return p.id;
}

function growRect(r: { x0: number; y0: number; x1: number; y1: number }, side: Dir, w: number) {
  const o = { ...r };
  if (side === 0) o.x1 += w;
  if (side === 2) o.x0 -= w;
  if (side === 1) o.y1 += w;
  if (side === 3) o.y0 -= w;
  return o;
}

/** 平台边界上的一整段直边（同一条线、同一朝向、连续） */
export interface EdgeRun { out: Dir; line: number; from: number; to: number }

export function edgeRunAt(n: MNode, px: number, py: number): EdgeRun | null {
  const cells = cellSet(n);
  const edges = boundaryEdges(cells);
  let best: UnitEdge | null = null, bd = Infinity;
  for (const e of edges) {
    const mx = e.x + (e.along === 0 ? CELL / 2 : 0), my = e.y + (e.along === 1 ? CELL / 2 : 0);
    const d = Math.hypot(px - mx, py - my);
    if (d < bd) { bd = d; best = e; }
  }
  if (!best) return null;
  const b = best;
  const line = b.along === 0 ? b.y : b.x;
  const same = new Set(edges.filter((e) => e.out === b.out && (e.along === 0 ? e.y : e.x) === line).map((e) => (e.along === 0 ? e.x : e.y)));
  let from = b.along === 0 ? b.x : b.y, to = from + CELL;
  while (same.has(from - CELL)) from -= CELL;
  while (same.has(to)) to += CELL;
  return { out: b.out, line, from, to };
}

/** 把平台的一整段边往外（w>0）或往里（w<0）推；接在这段边上的直道跟着缩短 / 伸长 */
export function extrudePlatform(m: Model, pid: number, run: EdgeRun, w: number) {
  const n = m.nodes[pid];
  if (!n || n.kind !== 'platform' || Math.abs(w) < EPS) return;
  const cells = cellSet(n);
  const sg = run.out === 0 || run.out === 1 ? 1 : -1;
  const a0 = run.line, a1 = run.line + sg * w;
  const isX = axisOf(run.out) === 0;
  const strip = isX ? rectCells(a0, run.from, a1, run.to) : rectCells(run.from, a0, run.to, a1);
  if (w > 0) for (const k of strip) cells.add(k);
  else for (const k of strip) cells.delete(k);
  if (cells.size === 0) return;
  n.cells = [...cells];
  updatePlatformCenter(n);
  for (const l of nodeLinks(m, pid)) {
    const s = m.segs[l.seg];
    const o = linkOpening(s, l.key);
    if (o.out !== run.out) continue;
    const lc = isX ? o.x : o.y, ac = isX ? o.y : o.x;
    if (Math.abs(lc - run.line) > EPS || ac < run.from - EPS || ac > run.to + EPS) continue;
    // 开口随边移动：直道在这一端缩短 w
    if (l.key === 'a') { s.x += DX[s.dir] * w; s.y += DY[s.dir] * w; }
    s.len -= w;
    if (s.len < -EPS) { delete m.segs[s.id]; continue; }
    s.len = Math.max(s.len, 0);
  }
}

/** 从平台边上 (cx,cy) 处朝 out 长出一段直道 */
export function addSegAtPlatform(m: Model, pid: number, cx: number, cy: number, out: Dir, len = 1.25): number | null {
  const n = m.nodes[pid];
  if (!n || !openingFits(cellSet(n), cx, cy, out)) return null;
  const id = m.nextId++;
  m.segs[id] = {
    id, x: cx, y: cy, dir: out, len, style: n.style,
    a: { node: pid }, b: { node: null, z: n.z, style: 'closed' },
  };
  return id;
}

/** 高度相同、相互接触的平台合并成一个整体 */
export function mergePlatforms(m: Model): boolean {
  const ps = Object.values(m.nodes).filter((n) => n.kind === 'platform');
  for (let i = 0; i < ps.length; i++) {
    for (let j = i + 1; j < ps.length; j++) {
      const A = ps[i], B = ps[j];
      if (Math.abs(A.z - B.z) > EPS) continue;
      const ca = cellSet(A);
      let touch = false;
      for (const k of B.cells ?? []) {
        const [x, y] = parseCell(k);
        if (ca.has(k) || ca.has(cellKey(x + 1, y)) || ca.has(cellKey(x - 1, y)) || ca.has(cellKey(x, y + 1)) || ca.has(cellKey(x, y - 1))) { touch = true; break; }
      }
      if (!touch) continue;
      for (const k of B.cells ?? []) ca.add(k);
      A.cells = [...ca];
      A.ribbon = A.ribbon || B.ribbon;
      updatePlatformCenter(A);
      for (const l of nodeLinks(m, B.id)) m.segs[l.seg][l.key] = { node: A.id };
      delete m.nodes[B.id];
      if (m.root === B.id) m.root = A.id;
      return true;
    }
  }
  return false;
}

/** 平台在 (x,y) 处是否有格 */
export function platformHas(n: MNode, x: number, y: number) {
  return cellSet(n).has(cellKey(Math.floor(x / CELL + EPS), Math.floor(y / CELL + EPS)));
}

