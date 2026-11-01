// 路网数据模型。坐标系与 Blender 一致：Z 轴向上，单位与 Ballance 相同（1 路块 = 5）。
//
// 路网由两种元素组成：
//   - 节点（MNode）：5×5 的路块（拐角 / 路口 / 1×1 / 平凹转换），或零尺寸的“截面接头”（joint）。
//   - 直道（Seg）：沿坐标轴方向、宽 5、长度任意的路段，两端或接在节点端口上，或是自由端点。
// 节点和直道共用一个 id 空间，这样 root 等引用只需要一个数字。

import type { Rail } from './rail';
import type { Obj } from './objects';

export type Dir = 0 | 1 | 2 | 3; // 0:+X 1:+Y 2:-X 3:-Y
export const DX = [1, 0, -1, 0] as const;
export const DY = [0, 1, 0, -1] as const;
export const opp = (d: Dir): Dir => ((d + 2) % 4) as Dir;
export const axisOf = (d: Dir): 0 | 1 => (d % 2) as 0 | 1;

export type Style = 'normal' | 'sink';
export type EndStyle = 'open' | 'closed';
export type NodeKind = 'block' | 'joint' | 'transition' | 'platform' | 'checkpoint' | 'base';
/** 机关专属路面：变球器底座、风扇底座、栅栏路面 */
export type BaseKind = 'trafo' | 'fan' | 'fence';
/** 盘点路面：起点（四火）或小节盘点（两火） */
export type Prefab = 'start' | 'check';

/** 盘点路面中心到路口端面的距离（资产库模型的延伸段末端） */
export const PREFAB_PORT: Record<Prefab, number> = { start: 12.3861, check: 9.924 };

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
  /**
   * transition（嵌入平台）：不是平凹转换，而是半块（2.5）平路，平台内侧一端下沉 0.7；
   * 用于普通路接凹槽平台。sinkDir 指向平台内侧。
   */
  ramp?: boolean;
  /** transition（嵌入平台）：平路一侧的两个顶点也下沉 0.7（凹槽路接细边花纹平台，贴住平台下沉的内部） */
  flatDeep?: boolean;
  /** base：专属路面的种类 */
  baseKind?: BaseKind;
  /** base（变球器）：材质 */
  baseMat?: 'Paper' | 'Stone' | 'Wood';
  /** base：属于哪个机关 */
  obj?: number;
  /** 仅用于显示过渡：平台整体平移时，按目标形状绘制再偏移这么多（不会存进模型） */
  dispOff?: [number, number, number];
  /** checkpoint：起点 / 小节盘点 */
  prefab?: Prefab;
  /** checkpoint：朝向（模型本地 +X 对应的方向）。起点的路口在这一侧；小节盘点的路口在这一侧和对侧 */
  rot?: Dir;
  /** checkpoint：重生时球朝向的方向（与路面朝向分开设置）；不填则与 rot 相同（朝着出口 / 顺着路往前） */
  spawn?: Dir;
  /** checkpoint（小节盘点）：激活的小节号（≥2），对应 PC_TwoFlames_{sector-1} 与 PR_Resetpoint_{sector} */
  sector?: number;
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
  /** 机关与装饰 */
  objs: Record<number, Obj>;
  /** 护栏：沿路面外沿从 a 走到 b（外沿是有方向的环，见 outline.ts） */
  guards: Record<number, Guard>;
  /** 全图设置 */
  settings: MapSettings;
}

export interface Guard { id: number; a: [number, number, number]; b: [number, number, number] }

/** 全图设置（设置页里改，整张图生效） */
export interface MapSettings {
  /** 护栏横杆顶部离路面的高度 */
  guardTop: number;
  /** 护栏立柱伸到路面以下多深 */
  guardPostDepth: number;
  /** 护栏管中心离路边多远（往外） */
  guardOffset: number;
  /** 护栏管半径 */
  guardRadius: number;
  /** 铆钉顶部离路面多深 */
  nailDepth: number;
  /** 道具（球、箱子、加分 / 加命球）离路面多高，防止穿模 */
  propLift: number;
}

/** 默认值：护栏顶部离路面 2.6、立柱伸到路面下 2，铆钉在路面下约 0.7（原版关卡量得顶部约 3.37、立柱 1.5） */
export const DEFAULT_SETTINGS: MapSettings = {
  guardTop: 2.6, guardPostDepth: 2, guardOffset: 0.25, guardRadius: 0.25, nailDepth: 0.7, propLift: 0.1,
};

export interface PortRef { seg: number; key: EndKey }

export const isFree = (e: End): e is FreeEnd => e.node === null;
/**
 * 节点中心到某个方向路口的距离。栅栏路面例外：节点在栅栏所在的那一格（第一格）上，
 * 往栅栏方向（rot）还延伸一格（第二格，栅栏被推过去的地方），所以那一侧是 7.5，其余三侧 2.5。
 */
export const nodeHalf = (n: MNode, d?: Dir) => (n.kind === 'joint' ? 0 : n.kind === 'checkpoint' ? PREFAB_PORT[n.prefab!]
  : n.kind === 'base' && n.baseKind === 'fence' ? (d === n.rot ? 3 * HALF : HALF)
  : n.kind === 'transition' && n.narrow ? HALF / 2 : HALF);

/** 节点占的矩形（栅栏路面是 5×10，其余按 nodeHalf 的正方形） */
export function nodeRect(n: MNode): { x0: number; y0: number; x1: number; y1: number } {
  const h = nodeHalf(n);
  const r = { x0: n.x - h, y0: n.y - h, x1: n.x + h, y1: n.y + h };
  if (n.kind === 'base' && n.baseKind === 'fence') {
    const d = n.rot!, ext = 2 * HALF;
    if (d === 0) r.x1 += ext; else if (d === 2) r.x0 -= ext; else if (d === 1) r.y1 += ext; else r.y0 -= ext;
  }
  return r;
}

/** 节点可以接路的方向（路块四个方向都行；盘点路面只有延伸段那一侧 / 两侧） */
export function nodePortDirs(n: MNode): Dir[] {
  if (n.kind === 'checkpoint') return n.prefab === 'start' ? [n.rot!] : [n.rot!, opp(n.rot!)];
  return [0, 1, 2, 3];
}

export function emptyModel(): Model {
  const m: Model = { nodes: {}, segs: {}, nextId: 1, root: null, rails: {}, objs: {}, guards: {}, settings: { ...DEFAULT_SETTINGS } };
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
  m.guards ??= {};
  m.settings = { ...DEFAULT_SETTINGS, ...(m.settings ?? {}) };
  // 早期版本把护栏记在路边上，已改为独立的护栏对象
  for (const s of Object.values(m.segs ?? {})) delete (s as { guard?: unknown }).guard;
  for (const n of Object.values(m.nodes ?? {})) { delete (n as { guard?: unknown }).guard; delete (n as { guardSides?: unknown }).guardSides; }
  m.objs ??= {};
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
