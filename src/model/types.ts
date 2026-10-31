// 路网数据模型。坐标系与 Blender 一致：Z 轴向上，单位与 Ballance 相同（1 路块 = 5）。
//
// 路网由两种元素组成：
//   - 节点（MNode）：5×5 的路块（拐角 / 路口 / 1×1 / 平凹转换），或零尺寸的“截面接头”（joint）。
//   - 直道（Seg）：沿坐标轴方向、宽 5、长度任意的路段，两端或接在节点端口上，或是自由端点。
// 节点和直道共用一个 id 空间，这样 root 等引用只需要一个数字。

import type { Rail } from './rail';

export type Dir = 0 | 1 | 2 | 3; // 0:+X 1:+Y 2:-X 3:-Y
export const DX = [1, 0, -1, 0] as const;
export const DY = [0, 1, 0, -1] as const;
export const opp = (d: Dir): Dir => ((d + 2) % 4) as Dir;
export const axisOf = (d: Dir): 0 | 1 => (d % 2) as 0 | 1;

export type Style = 'normal' | 'sink';
export type EndStyle = 'open' | 'closed';
export type NodeKind = 'block' | 'joint' | 'transition' | 'platform';

export const HALF = 2.5;       // 半个路块
export const BLOCK = 5;        // 路块边长
export const THICK = 5;        // 路面厚度
export const SINK_DEPTH = 0.7; // 凹槽深度
export const HEIGHT_STEP = 1.25;
/** 平台按 1.25 的小格记录占用区域 */
export const CELL = 1.25;

export interface MNode {
  id: number;
  kind: NodeKind;
  x: number;
  y: number;
  z: number; // 顶面高度
  style: Style;
  /** joint / transition：沿哪根轴（0=X，1=Y） */
  axis?: 0 | 1;
  /** transition：从中心指向凹槽一侧的方向 */
  sinkDir?: Dir;
  /** platform：占用的小格（"i,j"，覆盖 [i·CELL,(i+1)·CELL]×[j·CELL,(j+1)·CELL]） */
  cells?: string[];
  /** platform：细边花纹（仅凹槽平台有效） */
  ribbon?: boolean;
  /** transition：窄转换（长 2.5，用于平台与路面衔接） */
  narrow?: boolean;
  /** transition：嵌在哪个平台的边框带里（平台与样式不同的路面衔接处） */
  inPlatform?: number;
  /** transition：凹槽一侧的两个角也下沉 0.7（整条边贴住凹槽平台下沉的内部） */
  deep?: boolean;
}

export interface AttachedEnd { node: number }
export interface FreeEnd { node: null; z: number; style: EndStyle }
export type End = AttachedEnd | FreeEnd;
export type EndKey = 'a' | 'b';

export interface Seg {
  id: number;
  /** 起点（a 端）在路中线上的坐标 */
  x: number;
  y: number;
  /** 从 a 端指向 b 端的方向 */
  dir: Dir;
  len: number;
  style: Style;
  a: End;
  b: End;
}

export interface Model {
  nodes: Record<number, MNode>;
  segs: Record<number, Seg>;
  nextId: number;
  /** 高度传播的根元素（节点或直道 id）；改高度时，只有远离根的一侧跟着动 */
  root: number | null;
  rails: Record<number, Rail>;
}

export interface PortRef { seg: number; key: EndKey }

export const isFree = (e: End): e is FreeEnd => e.node === null;
export const nodeHalf = (n: MNode) => (n.kind === 'joint' ? 0 : n.kind === 'transition' && n.narrow ? HALF / 2 : HALF);

export function emptyModel(): Model {
  const m: Model = { nodes: {}, segs: {}, nextId: 1, root: null, rails: {} };
  const id = m.nextId++;
  // 路块边沿对齐到 5 的整数倍，与 Blender / BBP 的习惯一致
  m.nodes[id] = { id, kind: 'block', x: HALF, y: HALF, z: 0, style: 'normal' };
  m.root = id;
  return m;
}

export const cloneModel = (m: Model): Model => JSON.parse(JSON.stringify(m));

/** 兼容旧版本存档 */
export function migrateModel(m: Model): Model {
  m.rails ??= {};
  return m;
}

/** 直道某一端在路中线上的平面坐标 */
export function endPos(s: Seg, k: EndKey): [number, number] {
  if (k === 'a') return [s.x, s.y];
  return [s.x + DX[s.dir] * s.len, s.y + DY[s.dir] * s.len];
}

/** 直道某一端的朝外方向 */
export const endOutDir = (s: Seg, k: EndKey): Dir => (k === 'a' ? opp(s.dir) : s.dir);

export function endZ(m: Model, s: Seg, k: EndKey): number {
  const e = s[k];
  return isFree(e) ? e.z : m.nodes[e.node].z;
}

export function zAt(m: Model, s: Seg, t: number): number {
  const za = endZ(m, s, 'a');
  const zb = endZ(m, s, 'b');
  return s.len > 1e-9 ? za + ((zb - za) * t) / s.len : za;
}

/** 节点四个方向上连接的直道 */
export function nodePorts(m: Model, id: number): (PortRef | null)[] {
  const r: (PortRef | null)[] = [null, null, null, null];
  for (const s of Object.values(m.segs)) {
    if (s.a.node === id) r[s.dir] = { seg: s.id, key: 'a' };
    if (s.b.node === id) r[opp(s.dir)] = { seg: s.id, key: 'b' };
  }
  return r;
}

export interface LinkRef { seg: number; key: EndKey; dir: Dir }

/** 节点上连接的所有直道（平台一侧可能有多条，因此不按方向归并） */
export function nodeLinks(m: Model, id: number): LinkRef[] {
  const r: LinkRef[] = [];
  for (const s of Object.values(m.segs)) {
    if (s.a.node === id) r.push({ seg: s.id, key: 'a', dir: s.dir });
    if (s.b.node === id) r.push({ seg: s.id, key: 'b', dir: opp(s.dir) });
  }
  return r;
}

export const portCount = (p: (PortRef | null)[]) => p.filter((x) => x).length;
