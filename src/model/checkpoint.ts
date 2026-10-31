// 盘点路面（起点 / 小节盘点）：直接使用资产库里的模型，路口在延伸段末端。
//
// 小节编号：起点固定是第 1 小节（PS_FourFlames_01 + PR_Resetpoint_01）；
// 每个小节盘点激活下一个小节，sector = n 时对应 PC_TwoFlames_{n-1} 与 PR_Resetpoint_{n}。
import {
  DX, DY, Dir, EndKey, MNode, Model, PREFAB_PORT, Prefab, axisOf, endOutDir, endPos, endZ, isFree, nodePorts, opp,
} from './types';
import { isSloped } from './ops';

const EPS = 1e-6;

export const findStart = (m: Model) => Object.values(m.nodes).find((n) => n.kind === 'checkpoint' && n.prefab === 'start');
export const checkpoints = (m: Model) =>
  Object.values(m.nodes).filter((n) => n.kind === 'checkpoint' && n.prefab === 'check').sort((a, b) => a.sector! - b.sector!);

function newNode(m: Model, n: Omit<MNode, 'id'>): MNode {
  const node = { ...n, id: m.nextId++ } as MNode;
  m.nodes[node.id] = node;
  if (m.root === null) m.root = node.id;
  return node;
}

function nextSector(m: Model) {
  return Math.max(1, ...checkpoints(m).map((n) => n.sector!)) + 1;
}

/** 在空地上新建盘点路面 */
export function addCheckpoint(m: Model, prefab: Prefab, x: number, y: number, z: number, rot: Dir = 0): number | null {
  if (prefab === 'start' && findStart(m)) return null;
  return newNode(m, { kind: 'checkpoint', prefab, x, y, z, style: 'normal', rot, sector: prefab === 'check' ? nextSector(m) : undefined }).id;
}

/** 把直道上以 c 为中心的一段替换成小节盘点（直道两侧接到盘点的两个路口）。 */
export function placeCheckpointOnSeg(m: Model, segId: number, c: number): number | null {
  const s = m.segs[segId];
  if (!s || isSloped(m, s)) return null;
  const P = PREFAB_PORT.check;
  const z = endZ(m, s, 'a');
  // 端点接着别的东西时，盘点不能越过它
  const lo = isFree(s.a) ? -Infinity : P, hi = isFree(s.b) ? Infinity : s.len - P;
  if (lo > hi + EPS) return null;
  c = Math.min(Math.max(c, lo), hi);
  const cp = newNode(m, {
    kind: 'checkpoint', prefab: 'check', x: s.x + DX[s.dir] * c, y: s.y + DY[s.dir] * c, z, style: 'normal',
    rot: s.dir, sector: nextSector(m),
  });
  const right = s.len - (c + P), left = c - P;
  // 被盘点盖住的部分去掉；剩下太短（放不下封闭端头）的自由段也去掉
  if (right > 2.5 - EPS || (!isFree(s.b) && right > -EPS)) {
    const id = m.nextId++;
    m.segs[id] = {
      id, x: s.x + DX[s.dir] * (c + P), y: s.y + DY[s.dir] * (c + P), dir: s.dir, len: Math.max(right, 0), style: s.style,
      a: { node: cp.id }, b: s.b,
    };
  }
  if (left > 2.5 - EPS || (!isFree(s.a) && left > -EPS)) {
    s.len = Math.max(left, 0);
    s.b = { node: cp.id };
  } else {
    delete m.segs[s.id];
    if (m.root === s.id) m.root = cp.id;
  }
  return cp.id;
}

/** 在直道的自由端外侧接上起点 */
export function placeStartAtEnd(m: Model, segId: number, k: EndKey): number | null {
  const s = m.segs[segId];
  if (!s || !isFree(s[k]) || findStart(m)) return null;
  const out = endOutDir(s, k);
  const [ex, ey] = endPos(s, k);
  const P = PREFAB_PORT.start;
  const n = newNode(m, { kind: 'checkpoint', prefab: 'start', x: ex + DX[out] * P, y: ey + DY[out] * P, z: endZ(m, s, k), style: 'normal', rot: opp(out) });
  s[k] = { node: n.id };
  return n.id;
}

/** 没接路时可以转 90°；小节盘点接着路时只能掉头（重生点朝向反过来） */
export function rotateCheckpoint(m: Model, id: number, quarter: 1 | 2): boolean {
  const n = m.nodes[id];
  if (!n || n.kind !== 'checkpoint') return false;
  const linked = nodePorts(m, id).some((p) => p);
  if (linked && (quarter !== 2 || n.prefab === 'start')) return false;
  n.rot = ((n.rot! + quarter) % 4) as Dir;
  return true;
}

/** 调整小节盘点的顺序（与相邻的交换） */
export function moveSector(m: Model, id: number, delta: -1 | 1): boolean {
  const list = checkpoints(m);
  const i = list.findIndex((n) => n.id === id);
  const j = i + delta;
  if (i < 0 || j < 0 || j >= list.length) return false;
  [list[i].sector, list[j].sector] = [list[j].sector, list[i].sector];
  return true;
}

/** 删除后把小节号重新排成 2,3,4…（规范化时调用） */
export function renumberSectors(m: Model): boolean {
  let changed = false;
  checkpoints(m).forEach((n, i) => { if (n.sector !== i + 2) { n.sector = i + 2; changed = true; } });
  return changed;
}

// ---------------- 显示 / 导出用的组成部分 ----------------

export interface PrefabPart {
  /** 资产库物体名，或机关占位符名（PS_FourFlames 等） */
  name: string;
  /** 'asset'：资产库模型；'element'：BBP 机关占位符 */
  type: 'asset' | 'element';
  /** 导出时的物体名（机关需要按规范命名） */
  objName?: string;
  pos: [number, number, number];
  /** 绕 Z 轴旋转（度） */
  rotZ: number;
}

/** 盘点路面由哪些模型组成：路面（按接了哪几侧选延伸段版本）+ 火焰占位符 + 重生点占位符 */
export function prefabParts(m: Model, n: MNode): PrefabPart[] {
  const ports = nodePorts(m, n.id);
  const rot = n.rot!;
  const deg = (d: Dir) => d * 90;
  const parts: PrefabPart[] = [];
  const floorZ = n.z - 2.5; // 资产模型原点在路块中心
  if (n.prefab === 'start') {
    parts.push({ name: ports[rot] ? 'StartPoint_Extended_OpenEdge' : 'StartPoint_NoExtended', type: 'asset', pos: [n.x, n.y, floorZ], rotZ: deg(rot) });
    // 四火比资产模型多转 90°（与 BBP 的小节对一致）；重生点抬高 3.65
    parts.push({ name: 'PS_FourFlames', type: 'element', objName: 'PS_FourFlames_01', pos: [n.x, n.y, n.z], rotZ: deg(rot) + 90 });
    parts.push({ name: 'PR_Resetpoint', type: 'element', objName: 'PR_Resetpoint_01', pos: [n.x, n.y, n.z + 3.65], rotZ: deg(rot) });
  } else {
    const a = !!ports[rot], b = !!ports[opp(rot)];
    const [name, r] = a && b ? ['CheckPoint_DoubleExtended_OpenEdge', rot]
      : a ? ['CheckPoint_Extended_OpenEdge', rot]
        : b ? ['CheckPoint_Extended_OpenEdge', opp(rot)]
          : ['CheckPoint_NoExtended', rot];
    parts.push({ name, type: 'asset', pos: [n.x, n.y, floorZ], rotZ: deg(r as Dir) });
    const sec = n.sector ?? 2;
    const two = (v: number) => String(v).padStart(2, '0');
    parts.push({ name: 'PC_TwoFlames', type: 'element', objName: `PC_TwoFlames_${two(sec - 1)}`, pos: [n.x, n.y, n.z], rotZ: deg(rot) });
    parts.push({ name: 'PR_Resetpoint', type: 'element', objName: `PR_Resetpoint_${two(sec)}`, pos: [n.x, n.y, n.z + 3.3258], rotZ: deg(rot) });
  }
  return parts;
}

/** 盘点路面的平面占地（用于拾取外的粗略判断、吸附等）：沿路口轴向 ±port，垂直方向 ±9 */
export function prefabExtent(n: MNode): { along: number; across: number; axis: 0 | 1 } {
  return { along: PREFAB_PORT[n.prefab!], across: n.prefab === 'start' ? 9.27 : 9.1, axis: axisOf(n.rot!) };
}
