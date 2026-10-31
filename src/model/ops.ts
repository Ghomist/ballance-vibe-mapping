// 路网编辑操作。所有操作都直接修改传入的 Model；调用方负责先 clone 再改（用于拖拽预览和撤销）。
import {
  BLOCK, CELL, DX, DY, Dir, End, EndKey, EndStyle, HALF, MNode, Model, Seg, Style,
  axisOf, endOutDir, endPos, endZ, isFree, nodeHalf, nodeLinks, nodePorts, opp, portCount, zAt,
} from './types';
import { cellSet, makeInset, mergePlatforms, openingFits, revertInset } from './platform';

const EPS = 1e-6;

function newId(m: Model) { return m.nextId++; }

function addNode(m: Model, n: Omit<MNode, 'id'>): MNode {
  const node = { ...n, id: newId(m) };
  m.nodes[node.id] = node;
  return node;
}

function addSeg(m: Model, s: Omit<Seg, 'id'>): Seg {
  const seg = { ...s, id: newId(m) };
  m.segs[seg.id] = seg;
  return seg;
}

const freeEnd = (z: number, style: EndStyle = 'open'): End => ({ node: null, z, style });

function replaceRoot(m: Model, oldId: number, newIdv: number) {
  if (m.root === oldId) m.root = newIdv;
}

/** 直道最短长度：每个封闭端要占 2.5 */
export function minLen(s: Seg) {
  let n = 0;
  if (isFree(s.a) && s.a.style === 'closed') n += HALF;
  if (isFree(s.b) && s.b.style === 'closed') n += HALF;
  return Math.max(n, 1.25);
}

/** 把直道在 t 处切成两段，返回后半段。切点两侧都暂时是开放自由端。 */
export function splitSeg(m: Model, s: Seg, t: number): Seg {
  const zt = zAt(m, s, t);
  const s2 = addSeg(m, {
    x: s.x + DX[s.dir] * t, y: s.y + DY[s.dir] * t, dir: s.dir,
    len: s.len - t, style: s.style, a: freeEnd(zt), b: s.b,
  });
  s.len = t;
  s.b = freeEnd(zt);
  return s2;
}

/** 在直道 t 处插入截面接头；若 t 落在端点上，返回端点处已有的节点（自由端则返回 null）。 */
export function insertJoint(m: Model, segId: number, t: number): number | null {
  const s = m.segs[segId];
  if (t <= EPS) return s.a.node;
  if (t >= s.len - EPS) return s.b.node;
  const s2 = splitSeg(m, s, t);
  const [x, y] = endPos(s, 'b');
  const j = addNode(m, { kind: 'joint', x, y, z: zAt(m, s2, 0), style: s.style, axis: axisOf(s.dir) });
  s.b = { node: j.id };
  s2.a = { node: j.id };
  return j.id;
}

/** 在直道中心位置 c 处挖出一个 5×5 路块，返回路块 id。 */
export function insertBlockAt(m: Model, segId: number, c: number): number | null {
  const s = m.segs[segId];
  if (s.len < BLOCK - EPS) return null;
  c = Math.min(Math.max(c, HALF), s.len - HALF);
  const zc = zAt(m, s, c);
  const blk = addNode(m, {
    kind: 'block', x: s.x + DX[s.dir] * c, y: s.y + DY[s.dir] * c, z: zc, style: s.style,
  });
  const rightLen = s.len - (c + HALF);
  if (rightLen > EPS || !isFree(s.b)) {
    addSeg(m, {
      x: s.x + DX[s.dir] * (c + HALF), y: s.y + DY[s.dir] * (c + HALF), dir: s.dir,
      len: Math.max(rightLen, 0), style: s.style, a: { node: blk.id }, b: s.b,
    });
  }
  const leftLen = c - HALF;
  if (leftLen > EPS || !isFree(s.a)) {
    s.len = Math.max(leftLen, 0);
    s.b = { node: blk.id };
  } else {
    delete m.segs[s.id];
    replaceRoot(m, s.id, blk.id);
  }
  return blk.id;
}

/** 从路块端口长出一段新直道，返回新直道 id（生长端为 b）。 */
export function addSegAtPort(m: Model, nodeId: number, d: Dir, len = 1.25): number | null {
  const n = m.nodes[nodeId];
  if (nodePorts(m, nodeId)[d]) return null;
  if (n.kind !== 'block') return null;
  const h = nodeHalf(n);
  const s = addSeg(m, {
    x: n.x + DX[d] * h, y: n.y + DY[d] * h, dir: d, len, style: n.style,
    a: { node: n.id }, b: freeEnd(n.z, 'closed'),
  });
  return s.id;
}

/** 把孤立的 1×1 路块变成一段朝 d 方向的直道（两端封闭），返回直道 id（生长端为 b）。 */
export function blockToSeg(m: Model, nodeId: number, d: Dir): number {
  const n = m.nodes[nodeId];
  const s = addSeg(m, {
    x: n.x - DX[d] * HALF, y: n.y - DY[d] * HALF, dir: d, len: BLOCK, style: n.style,
    a: freeEnd(n.z, 'closed'), b: freeEnd(n.z, 'closed'),
  });
  delete m.nodes[nodeId];
  replaceRoot(m, nodeId, s.id);
  return s.id;
}

/** 把自由端拉到轴向坐标 coord（X 轴向直道为 x，Y 轴向为 y）。 */
export function extendTo(m: Model, segId: number, k: EndKey, coord: number) {
  const s = m.segs[segId];
  const ax = axisOf(s.dir);
  const sign = ax === 0 ? DX[s.dir] : DY[s.dir];
  const start = ax === 0 ? s.x : s.y;
  const other = k === 'a' ? s.b : s.a;
  const lo = isFree(other) ? minLen(s) : 0;
  if (k === 'b') {
    s.len = Math.max((coord - start) * sign, lo);
  } else {
    const endc = start + sign * s.len;
    const len = Math.max((endc - coord) * sign, lo);
    const ns = endc - sign * len;
    if (ax === 0) s.x = ns; else s.y = ns;
    s.len = len;
  }
}

/** 斜坡的自由端往外拉：在端点处加接头，续接一段平路。返回新直道 id（生长端为 b）。 */
export function extendFlat(m: Model, segId: number, k: EndKey): number | null {
  const s = m.segs[segId];
  const e = s[k];
  if (!isFree(e)) return null;
  const [x, y] = endPos(s, k);
  const out = endOutDir(s, k);
  const j = addNode(m, { kind: 'joint', x, y, z: e.z, style: s.style, axis: axisOf(s.dir) });
  const ns = addSeg(m, { x, y, dir: out, len: 0, style: s.style, a: { node: j.id }, b: freeEnd(e.z, e.style) });
  s[k] = { node: j.id };
  return ns.id;
}

/** 拐角：把自由端最后 5 个单位变成路块，并从侧面 d 长出新直道。 */
export function makeCorner(m: Model, segId: number, k: EndKey, d: Dir): number | null {
  const s = m.segs[segId];
  if (!isFree(s[k]) || s.len < BLOCK - EPS || isSloped(m, s)) return null;
  const blk = insertBlockAt(m, segId, k === 'b' ? s.len - HALF : HALF);
  if (blk === null) return null;
  return addSegAtPort(m, blk, d);
}

/** 路口：在直道 c 处挖出路块，并从侧面 d 长出新直道。 */
export function makeBranch(m: Model, segId: number, c: number, d: Dir): number | null {
  if (isSloped(m, m.segs[segId])) return null;
  const blk = insertBlockAt(m, segId, c);
  if (blk === null) return null;
  return addSegAtPort(m, blk, d);
}

// ---------------- 图遍历 / 高度 ----------------

function neighbors(m: Model, id: number): number[] {
  if (m.segs[id]) {
    const s = m.segs[id];
    return [s.a.node, s.b.node].filter((x): x is number => x !== null && !!m.nodes[x]);
  }
  return nodeLinks(m, id).map((l) => l.seg);
}

export function component(m: Model, start: number): Set<number> {
  const seen = new Set([start]);
  const q = [start];
  while (q.length) {
    for (const nb of neighbors(m, q.shift()!)) if (!seen.has(nb)) { seen.add(nb); q.push(nb); }
  }
  return seen;
}

/** 目标节点及其“下游”（远离根的一侧）整体升降 dz。 */
export function shiftDownstream(m: Model, target: number, dz: number) {
  const comp = component(m, target);
  const root = m.root !== null && comp.has(m.root) ? m.root : Math.min(...comp);
  let sub: Set<number>;
  if (root === target) {
    sub = comp;
  } else {
    const parent = new Map<number, number>();
    const seen = new Set([root]);
    const q = [root];
    while (q.length) {
      const cur = q.shift()!;
      for (const nb of neighbors(m, cur)) if (!seen.has(nb)) { seen.add(nb); parent.set(nb, cur); q.push(nb); }
    }
    // 零长度直道是刚性连接（例如路块紧挨着转换块），不能在那里形成断崖：沿刚性连接往上找真正的分界
    let tgt = target;
    for (;;) {
      const p = parent.get(tgt);
      if (p === undefined || !m.segs[p] || m.segs[p].len > EPS) break;
      const pp = parent.get(p);
      if (pp === undefined) break;
      tgt = pp;
    }
    if (tgt === root) {
      sub = comp;
    } else {
    const blocked = parent.get(tgt);
    sub = new Set([tgt]);
    const q2 = [tgt];
    while (q2.length) {
      for (const nb of neighbors(m, q2.shift()!)) {
        if (nb === blocked || sub.has(nb)) continue;
        sub.add(nb); q2.push(nb);
      }
    }
    }
  }
  for (const id of sub) {
    if (m.nodes[id]) m.nodes[id].z += dz;
    const s = m.segs[id];
    if (s) {
      if (isFree(s.a)) s.a.z += dz;
      if (isFree(s.b)) s.b.z += dz;
    }
  }
}

/**
 * 目标连同下游整体沿 (dx,dy,dz) 移动；与上游相连的直道自动伸缩（水平移动）或变成坡道（竖直移动）。
 * 水平移动时，需要伸缩的直道必须与移动方向同轴且长度不小于 0，否则返回 false 且不修改模型。
 */
export function moveDownstream(m: Model, target: number, dx: number, dy: number, dz: number): boolean {
  const horiz = Math.abs(dx) > EPS || Math.abs(dy) > EPS;
  if (!horiz) { shiftDownstream(m, target, dz); return true; }
  const comp = component(m, target);
  const root = m.root !== null && comp.has(m.root) ? m.root : Math.min(...comp);
  let sub: Set<number>;
  if (root === target) sub = comp;
  else {
    const parent = new Map<number, number>();
    const seen = new Set([root]);
    const q = [root];
    while (q.length) {
      const cur = q.shift()!;
      for (const nb of neighbors(m, cur)) if (!seen.has(nb)) { seen.add(nb); parent.set(nb, cur); q.push(nb); }
    }
    const blocked = parent.get(target);
    sub = new Set([target]);
    const q2 = [target];
    while (q2.length) for (const nb of neighbors(m, q2.shift()!)) if (nb !== blocked && !sub.has(nb)) { sub.add(nb); q2.push(nb); }
  }
  const axis = Math.abs(dx) > EPS ? 0 : 1;
  const d = axis === 0 ? dx : dy;
  const moved = (e: End, segIn: boolean) => (isFree(e) ? segIn : sub.has(e.node));
  // 先检查
  const plan: { s: Seg; k: EndKey | null }[] = [];
  for (const s of Object.values(m.segs)) {
    const segIn = sub.has(s.id);
    const ma = moved(s.a, segIn), mb = moved(s.b, segIn);
    if (!ma && !mb) continue;
    if (ma && mb) { plan.push({ s, k: null }); continue; }
    if (axisOf(s.dir) !== axis) return false;
    const k: EndKey = ma ? 'a' : 'b';
    const sg = axis === 0 ? DX[s.dir] : DY[s.dir];
    const nl = k === 'b' ? s.len + d * sg : s.len - d * sg;
    if (nl < -EPS) return false;
    plan.push({ s, k });
  }
  // 再执行
  for (const { s, k } of plan) {
    if (k === null) {
      s.x += dx; s.y += dy;
      for (const kk of ['a', 'b'] as EndKey[]) { const e = s[kk]; if (isFree(e)) e.z += dz; }
      continue;
    }
    const sg = axis === 0 ? DX[s.dir] : DY[s.dir];
    if (k === 'a') { s.x += dx; s.y += dy; s.len -= d * sg; } else s.len += d * sg;
    s.len = Math.max(s.len, 0);
  }
  for (const id of sub) {
    const n = m.nodes[id];
    if (!n) continue;
    n.x += dx; n.y += dy; n.z += dz;
    if (n.kind === 'platform' && n.cells) {
      const di = Math.round(dx / CELL), dj = Math.round(dy / CELL);
      n.cells = n.cells.map((c) => { const [i, j] = c.split(',').map(Number); return `${i + di},${j + dj}`; });
    }
  }
  return true;
}

/** 新建一个独立的 1×1 路块（中心坐标） */
export function addBlock(m: Model, x: number, y: number, z: number): number {
  const n = addNode(m, { kind: 'block', x, y, z, style: 'normal' });
  if (m.root === null) m.root = n.id;
  return n.id;
}

export function shiftFreeEnd(m: Model, segId: number, k: EndKey, dz: number) {
  const e = m.segs[segId][k];
  if (isFree(e)) e.z += dz;
}

// ---------------- 端点 / 分隔 ----------------

export function toggleEnd(m: Model, segId: number, k: EndKey) {
  const s = m.segs[segId];
  const e = s[k];
  if (!isFree(e)) return;
  e.style = e.style === 'open' ? 'closed' : 'open';
  if (s.len < minLen(s)) extendTo(m, segId, k, axisCoord(s, k) + endSign(s, k) * (minLen(s) - s.len));
}

const axisCoord = (s: Seg, k: EndKey) => endPos(s, k)[axisOf(s.dir)];
const endSign = (s: Seg, k: EndKey) => { const d = endOutDir(s, k); return DX[d] + DY[d]; };

/** 在直道 t 处把花纹分开，生成两个开放端点。 */
export function cutSeg(m: Model, segId: number, t: number) {
  const s = m.segs[segId];
  if (t <= EPS || t >= s.len - EPS) return;
  const s2 = splitSeg(m, s, t);
  (s.b as { style: EndStyle }).style = 'closed';
  (s2.a as { style: EndStyle }).style = 'closed';
}

/** 从截面接头处分开。 */
export function cutJoint(m: Model, nodeId: number) {
  const n = m.nodes[nodeId];
  if (!n || n.kind !== 'joint') return;
  for (const p of nodePorts(m, nodeId)) if (p) m.segs[p.seg][p.key] = freeEnd(n.z, 'closed');
  delete m.nodes[nodeId];
}

// ---------------- 删除 ----------------

export function deleteElem(m: Model, id: number) {
  if (m.segs[id]) {
    delete m.segs[id];
    if (m.root === id) m.root = null;
    return;
  }
  const n = m.nodes[id];
  if (!n) return;
  if (n.kind === 'joint') {
    mergeAtJoint(m, id);
    return;
  }
  for (const l of nodeLinks(m, id)) m.segs[l.seg][l.key] = freeEnd(n.z, 'closed');
  delete m.nodes[id];
  if (m.root === id) m.root = null;
}

/** 删掉接头，把两侧直道合并成一段。 */
function mergeAtJoint(m: Model, jid: number) {
  const ports = nodePorts(m, jid).filter((p) => p) as { seg: number; key: EndKey }[];
  if (ports.length !== 2) { cutJoint(m, jid); return; }
  const [p1, p2] = ports;
  let s1 = m.segs[p1.seg];
  let s2 = m.segs[p2.seg];
  // 统一成 s1.b -> joint -> s2.a
  if (p1.key === 'a') { [s1, s2] = [s2, s1]; }
  if (s1.b.node !== jid || s2.a.node !== jid || s1.dir !== s2.dir) { cutJoint(m, jid); return; }
  s1.len += s2.len;
  s1.b = s2.b;
  delete m.segs[s2.id];
  replaceRoot(m, s2.id, s1.id);
  delete m.nodes[jid];
  replaceRoot(m, jid, s1.id);
}

// ---------------- 合并 ----------------

const near = (a: number, b: number) => Math.abs(a - b) < 1e-3;

export type Connection =
  | { type: 'end'; seg: number; key: EndKey; z: number }
  | { type: 'port'; node: number; z: number }
  | { type: 'side'; seg: number; t: number; z: number };

/**
 * 查找自由端可以连接的目标：对面的自由端、路块空端口，或另一条直道的侧面（开 T 字口）。
 * adjust=true 时忽略高度差（连接时会把本端拉到目标高度，本段变成坡道）。
 */
export function findConnection(m: Model, segId: number, k: EndKey, adjust: boolean): Connection | null {
  const s = m.segs[segId];
  if (!s || !isFree(s[k])) return null;
  const [px, py] = endPos(s, k);
  const pz = endZ(m, s, k);
  const out = endOutDir(s, k);
  const zok = (z: number) => adjust || near(z, pz);

  for (const o of Object.values(m.segs)) {
    if (o.id === s.id) continue;
    for (const ok of ['a', 'b'] as EndKey[]) {
      if (!isFree(o[ok]) || endOutDir(o, ok) !== opp(out)) continue;
      const [ox, oy] = endPos(o, ok);
      const oz = endZ(m, o, ok);
      if (near(ox, px) && near(oy, py) && zok(oz)) return { type: 'end', seg: o.id, key: ok, z: oz };
    }
  }
  for (const n of Object.values(m.nodes)) {
    if (n.kind !== 'block' || !zok(n.z)) continue;
    const d = opp(out);
    if (!near(n.x + DX[d] * HALF, px) || !near(n.y + DY[d] * HALF, py)) continue;
    if (nodePorts(m, n.id)[d]) continue;
    return { type: 'port', node: n.id, z: n.z };
  }
  for (const n of Object.values(m.nodes)) {
    if (n.kind !== 'platform' || !zok(n.z)) continue;
    if (openingFits(cellSet(n), px, py, opp(out))) return { type: 'port', node: n.id, z: n.z };
  }
  const cx = px + DX[out] * HALF;
  const cy = py + DY[out] * HALF;
  for (const o of Object.values(m.segs)) {
    if (o.id === s.id || axisOf(o.dir) === axisOf(out) || isSloped(m, o)) continue;
    const t = (cx - o.x) * DX[o.dir] + (cy - o.y) * DY[o.dir];
    const lat = (cx - o.x) * -DY[o.dir] + (cy - o.y) * DX[o.dir];
    if (!near(lat, 0) || t < HALF - 1e-3 || t > o.len - HALF + 1e-3) continue;
    const oz = zAt(m, o, t);
    if (!zok(oz)) continue;
    return { type: 'side', seg: o.id, t, z: oz };
  }
  return null;
}

export function applyConnection(m: Model, segId: number, k: EndKey, c: Connection) {
  const s = m.segs[segId];
  const e = s[k];
  if (!isFree(e)) return;
  e.z = c.z;
  const [px, py] = endPos(s, k);
  if (c.type === 'end') {
    const j = addNode(m, { kind: 'joint', x: px, y: py, z: c.z, style: s.style, axis: axisOf(s.dir) });
    s[k] = { node: j.id };
    m.segs[c.seg][c.key] = { node: j.id };
  } else if (c.type === 'port') {
    s[k] = { node: c.node };
  } else {
    const blk = insertBlockAt(m, c.seg, c.t);
    if (blk !== null) m.segs[segId][k] = { node: blk };
  }
}

/** 拖拽结束后：自由端如果正好落在别的开口上，就连起来 */
export function tryConnect(m: Model, segId: number, k: EndKey, adjust = false): boolean {
  const c = findConnection(m, segId, k, adjust);
  if (!c) return false;
  applyConnection(m, segId, k, c);
  return true;
}

export function isSloped(m: Model, s: Seg) {
  return Math.abs(endZ(m, s, 'a') - endZ(m, s, 'b')) > 1e-6;
}

/** 平移整个连通块 */
export function moveIds(m: Model, ids: Iterable<number>, dx: number, dy: number) {
  for (const id of ids) {
    const n = m.nodes[id];
    if (n) { n.x += dx; n.y += dy; }
    const s = m.segs[id];
    if (s) { s.x += dx; s.y += dy; }
  }
}

// ---------------- 样式（普通 / 凹槽）----------------

/** 沿接头相连的整条直道链 */
export function chainOf(m: Model, segId: number): number[] {
  const out = new Set([segId]);
  const q = [segId];
  while (q.length) {
    const s = m.segs[q.shift()!];
    for (const k of ['a', 'b'] as EndKey[]) {
      const e = s[k];
      if (isFree(e) || m.nodes[e.node]?.kind !== 'joint') continue;
      for (const p of nodePorts(m, e.node)) if (p && !out.has(p.seg)) { out.add(p.seg); q.push(p.seg); }
    }
  }
  return [...out];
}

/** 只改这一段（接头之间）的样式；两端样式不一致处由 fixStyles 自动插入平凹转换 */
export function setSegStyle(m: Model, segId: number, style: Style) {
  const s = m.segs[segId];
  if (s) s.style = style;
}

export function setChainStyle(m: Model, segId: number, style: Style) {
  for (const id of chainOf(m, segId)) m.segs[id].style = style;
  for (const id of chainOf(m, segId)) {
    for (const k of ['a', 'b'] as EndKey[]) {
      const e = m.segs[id][k];
      if (!isFree(e) && m.nodes[e.node].kind === 'joint') m.nodes[e.node].style = style;
    }
  }
}

export function setBlockStyle(m: Model, nodeId: number, style: Style) {
  const n = m.nodes[nodeId];
  if (n && n.kind === 'block') n.style = style;
}

export function setPlatformStyle(m: Model, id: number, style: Style, ribbon: boolean) {
  const n = m.nodes[id];
  if (!n || n.kind !== 'platform') return;
  n.style = style;
  n.ribbon = style === 'sink' && ribbon;
}

/** 从直道 k 端切掉 5 个单位，在那里放一个平凹转换块。 */
function insertTransition(m: Model, s: Seg, k: EndKey, other: { seg: Seg; key: EndKey } | { node: number; dir: Dir }, narrow = false) {
  const e = s[k] as { node: number };
  const z = endZ(m, s, k);
  const [ex, ey] = endPos(s, k);
  const inward = opp(endOutDir(s, k));
  const L = narrow ? HALF : BLOCK;
  if (k === 'a') { s.x += DX[s.dir] * L; s.y += DY[s.dir] * L; }
  s.len -= L;
  const sinkIsCarved = s.style === 'sink';
  const tr = addNode(m, {
    kind: 'transition', x: ex + DX[inward] * L / 2, y: ey + DY[inward] * L / 2, z,
    style: 'sink', axis: axisOf(s.dir), sinkDir: sinkIsCarved ? inward : opp(inward), narrow,
  });
  s[k] = { node: tr.id };
  if ('seg' in other) {
    other.seg[other.key] = { node: tr.id };
    if (m.nodes[e.node]?.kind === 'joint') delete m.nodes[e.node];
  } else {
    // 路块与转换块之间用零长度直道相连
    const blk = m.nodes[other.node];
    addSeg(m, {
      x: ex, y: ey, dir: opp(inward), len: 0, style: blk.style,
      a: { node: tr.id }, b: { node: blk.id },
    });
  }
}

/** 修正样式不一致的连接处：插入或移除平凹转换块。 */
export function fixStyles(m: Model): boolean {
  for (const n of Object.values(m.nodes)) {
    const ports = nodePorts(m, n.id);
    if (n.kind === 'joint') {
      const ps = ports.filter((p) => p)!;
      if (ps.length !== 2) continue;
      const [p1, p2] = ps as { seg: number; key: EndKey }[];
      const s1 = m.segs[p1.seg], s2 = m.segs[p2.seg];
      if (s1.style === s2.style) continue;
      const sinkP = s1.style === 'sink' ? p1 : p2;
      const normP = sinkP === p1 ? p2 : p1;
      const carve = m.segs[sinkP.seg].len >= BLOCK - EPS ? sinkP : m.segs[normP.seg].len >= BLOCK - EPS ? normP : null;
      if (!carve) continue;
      const keep = carve === sinkP ? normP : sinkP;
      insertTransition(m, m.segs[carve.seg], carve.key, { seg: m.segs[keep.seg], key: keep.key });
      return true;
    }
    if (n.kind === 'block') {
      for (let d = 0 as Dir; d < 4; d = (d + 1) as Dir) {
        const p = ports[d];
        if (!p) continue;
        const s = m.segs[p.seg];
        if (s.style === n.style || s.len < BLOCK - EPS) continue;
        insertTransition(m, s, p.key, { node: n.id, dir: d });
        return true;
      }
    }
    if (n.kind === 'platform') {
      for (const l of nodeLinks(m, n.id)) {
        const s = m.segs[l.seg];
        if (s.style === n.style || s.len <= EPS) continue;
        // 窄转换放在平台边框带内部；放不下时才从路面上切
        if (makeInset(m, n.id, s.id, l.key)) return true;
        if (s.len < HALF - EPS) continue;
        insertTransition(m, s, l.key, { node: n.id, dir: l.dir }, true);
        return true;
      }
    }
    if (n.kind === 'transition' && n.inPlatform !== undefined) {
      // 嵌入平台的窄转换：平台没了、外侧没路了、或两边样式一致了，就撤掉
      const p = m.nodes[n.inPlatform];
      const road = nodeLinks(m, n.id).find((l) => m.segs[l.seg].len > EPS || isFree(m.segs[l.seg][l.key === 'a' ? 'b' : 'a']) || (m.segs[l.seg][l.key === 'a' ? 'b' : 'a'] as { node: number }).node !== n.inPlatform);
      if (!p || !road || m.segs[road.seg].style === p.style) { revertInset(m, n.id); return true; }
      continue;
    }
    if (n.kind === 'transition') {
      const sp = ports[n.sinkDir!];
      const fp = ports[opp(n.sinkDir!)];
      const sStyle = sp ? m.segs[sp.seg].style : 'sink';
      const fStyle = fp ? m.segs[fp.seg].style : 'normal';
      if (sStyle === 'sink' && fStyle === 'normal') continue;
      if (sStyle === 'normal' && fStyle === 'sink') { n.sinkDir = opp(n.sinkDir!); return true; }
      // 两边样式相同：转换块不再需要，变回接头并把两侧直道各延长半个转换块
      const h = n.narrow ? HALF / 2 : HALF;
      n.kind = 'joint';
      n.style = sStyle;
      delete n.sinkDir;
      delete n.narrow;
      for (const p of [sp, fp]) {
        if (!p) continue;
        const s = m.segs[p.seg];
        if (p.key === 'a') { s.x -= DX[s.dir] * h; s.y -= DY[s.dir] * h; }
        s.len += h;
      }
      return true;
    }
  }
  return false;
}

// ---------------- 规范化 ----------------

/** 消除冗余结构：只剩一个连接的路块变成封闭端点、对穿路块变成接头、悬空接头去掉等。 */
export function normalize(m: Model) {
  for (let guard = 0; guard < 1000; guard++) {
    if (!normalizeOnce(m) && !fixStyles(m)) return;
  }
}

/** 两个开放的自由端正对且重合（高度一致）时自动接上 */
function joinOpenEnds(m: Model): boolean {
  for (const s of Object.values(m.segs)) {
    for (const k of ['a', 'b'] as EndKey[]) {
      const e = s[k];
      if (!isFree(e) || e.style !== 'open') continue;
      const c = findConnection(m, s.id, k, false);
      if (!c || c.type !== 'end') continue;
      const oe = m.segs[c.seg][c.key];
      if (!isFree(oe) || oe.style !== 'open') continue;
      applyConnection(m, s.id, k, c);
      return true;
    }
  }
  return false;
}

function normalizeOnce(m: Model): boolean {
  for (const s of Object.values(m.segs)) {
    if (s.len > EPS) continue;
    if (isFree(s.a) || isFree(s.b) || s.a.node === s.b.node) { delete m.segs[s.id]; return true; }
    // 接头紧挨着别的节点（中间是零长度直道）：接头多余，让接头另一侧的直道直接接到那个节点
    for (const [jk, nk] of [['a', 'b'], ['b', 'a']] as const) {
      const j = m.nodes[(s[jk] as { node: number }).node];
      const other = (s[nk] as { node: number }).node;
      if (!j || j.kind !== 'joint') continue;
      const rest = nodeLinks(m, j.id).find((l) => l.seg !== s.id);
      if (rest) m.segs[rest.seg][rest.key] = { node: other };
      delete m.segs[s.id];
      delete m.nodes[j.id];
      replaceRoot(m, j.id, other);
      return true;
    }
  }
  if (mergePlatforms(m)) return true;
  if (joinOpenEnds(m)) return true;
  for (const n of Object.values(m.nodes)) {
    const ports = nodePorts(m, n.id);
    const cnt = portCount(ports);
    if (n.kind === 'joint') {
      if (cnt === 2) continue;
      if (cnt === 1) {
        const p = ports.find((x) => x)!;
        m.segs[p.seg][p.key] = freeEnd(n.z);
        replaceRoot(m, n.id, p.seg);
      }
      delete m.nodes[n.id];
      return true;
    }
    if (n.kind !== 'block') continue;
    if (cnt === 1) {
      // 只剩一个连接：并入那段直道，成为封闭端点
      const d = ports.findIndex((x) => x) as Dir;
      const p = ports[d]!;
      const s = m.segs[p.seg];
      if (p.key === 'a') { s.x -= DX[s.dir] * BLOCK; s.y -= DY[s.dir] * BLOCK; }
      s.len += BLOCK;
      s[p.key] = freeEnd(n.z, 'closed');
      if (s.style !== n.style) s.style = n.style;
      delete m.nodes[n.id];
      replaceRoot(m, n.id, s.id);
      return true;
    }
    if (cnt === 2) {
      const d = ports.findIndex((x) => x) as Dir;
      const p1 = ports[d], p2 = ports[opp(d)];
      if (!p1 || !p2) continue;
      if (m.segs[p1.seg].style !== n.style || m.segs[p2.seg].style !== n.style) continue;
      // 对穿：变成接头，两侧直道各延长 2.5
      for (const p of [p1, p2]) {
        const s = m.segs[p.seg];
        if (p.key === 'a') { s.x -= DX[s.dir] * HALF; s.y -= DY[s.dir] * HALF; }
        s.len += HALF;
      }
      n.kind = 'joint';
      n.axis = axisOf(d);
      return true;
    }
  }
  return false;
}
