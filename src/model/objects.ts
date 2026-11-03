// 摆放在场景里的独立物件：机关（BBP 占位符，按小节归组）与装饰（资产库模型）。
//
// 机关的小节默认自动判断：从机关脚下的路面出发沿路网扩散，遇到盘点就停下；
// 碰到的盘点中小节号最小的那个就是它所在的小节（两个盘点之间的路属于前一个盘点激活的小节）。
// 也可以手动指定。
import { CELL, HALF, MNode, Model, PREFAB_PORT, isFree, nodeLinks, nodeRect, zAt } from './types';
import { checkpoints, findStart } from './checkpoint';
import { cellSet } from './platform';

export type ObjCat = 'module' | 'deco';

export interface Obj {
  id: number;
  cat: ObjCat;
  /** 机关：BBP 元素名（P_Modul_01…）；装饰：资产库物体名 */
  type: string;
  x: number;
  y: number;
  z: number;
  /** 绕 Z 轴旋转（度） */
  rot: number;
  /** 机关：手动指定的小节；不填则自动判断 */
  sector?: number;
  /** 机关：专属路面（底座）节点 */
  base?: number;
  /** 机关：不要挡块 */
  noStopper?: boolean;
}

/** 对准方块：本地中心 x、y，顶面 z（= 路面高度），以及大小（默认 5×5）、厚度（默认 5） */
export type Anchor = [number, number, number] | [number, number, number, number, number] | [number, number, number, number, number, number];

/** 机关的所有对准方块（世界坐标的中心、半宽、顶面相对原点的高度） */
export function anchorBlocks(o: { type: string; x: number; y: number; z: number; rot: number }) {
  const t = objType(o.type);
  if (!t?.anchor) return [];
  const r = (o.rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const quarter = Math.abs(Math.round(o.rot / 90)) % 2 === 1;
  return [t.anchor, ...(t.more ?? [])].map((a) => {
    const sx = a[3] ?? 5, sy = a[4] ?? 5;
    return {
      x: o.x + a[0] * c - a[1] * s, y: o.y + a[0] * s + a[1] * c, top: o.z + a[2],
      hx: (quarter ? sy : sx) / 2, hy: (quarter ? sx : sy) / 2,
    };
  });
}

export interface ObjType {
  type: string;
  cat: ObjCat;
  label: string;
  /**
   * 对准点（本地坐标 [x, y, 路面顶面 z]）：占位符里的对准方块（代表它所在的那一格路面）中心与顶面。
   * 放到路面上时，对准点落在那一格路面的中心、顶面与路面齐平。数据来自 BBP 占位符和原版关卡。
   * 装饰没有对准点，底部贴住路面。
   */
  anchor?: Anchor;
  /** 其余对准方块（有几个方块的机关，例如秋千、跷跷板）：放置时哪个方块离路面格子最近就用哪个吸附 */
  more?: Anchor[];
  /** 道具（球、箱子、加分 / 加命球）：放的时候再抬高 settings.propLift，防止穿模 */
  prop?: boolean;
  /** 全图只能有一个 */
  unique?: boolean;
  /**
   * 从中间断开的机关（秋千、跷跷板等）：放在直路中间时，每对对准方块（下标，0 = anchor，1… = more）之间的那段路去掉，
   * 断开处是开放端点。T 型板是两个侧边方块之间（两个挡块中间）；双向挡板是两条平行的路各断一段。
   */
  split?: [number, number][];
}

/** 名称取自 Ballance Wiki「机关」词条 */
export const OBJ_TYPES: ObjType[] = [
  { type: 'P_Extra_Point', cat: 'module', label: '分数球', anchor: [0, 0, -2.5], prop: true },
  { type: 'P_Extra_Life', cat: 'module', label: '生命球', anchor: [0, 0, -2.56], prop: true },
  { type: 'P_Box', cat: 'module', label: '箱子', anchor: [0, 0, -2.5], prop: true },
  { type: 'P_Trafo_Paper', cat: 'module', label: '纸球变球器', anchor: [0, 0, -0.1] },
  { type: 'P_Trafo_Stone', cat: 'module', label: '石球变球器', anchor: [0, 0, -0.1] },
  { type: 'P_Trafo_Wood', cat: 'module', label: '木球变球器', anchor: [0, 0, -0.1] },
  { type: 'P_Ball_Paper', cat: 'module', label: '道具纸球', anchor: [0, 0, -2], prop: true },
  { type: 'P_Ball_Stone', cat: 'module', label: '道具石球', anchor: [0, 0, -2], prop: true },
  { type: 'P_Ball_Wood', cat: 'module', label: '道具木球', anchor: [0, 0, -2], prop: true },
  { type: 'P_Dome', cat: 'module', label: '半球型钢罩', anchor: [0, 0, 0] },
  { type: 'P_Modul_01', cat: 'module', label: '活式木栅栏', anchor: [2.5, 0.65, 0] },
  { type: 'P_Modul_03', cat: 'module', label: '升降机', anchor: [13.37, 0.04, -10.76] },
  { type: 'P_Modul_08', cat: 'module', label: '秋千', anchor: [-10, 0, 1.5], more: [[10, 0, 1.5]], split: [[0, 1]] },
  { type: 'P_Modul_17', cat: 'module', label: '单摆（杠杆靶）', anchor: [0, 0, -5] },
  { type: 'P_Modul_18', cat: 'module', label: '风扇', anchor: [0, 0, 0.34] },
  { type: 'P_Modul_19', cat: 'module', label: '双向挡板（双翼桥）', anchor: [0, 5, 0], more: [[-11.63, 5, 0], [-5.84, -10, 0], [5.81, -10, 0]], split: [[0, 1], [2, 3]] },
  { type: 'P_Modul_25', cat: 'module', label: '推板', anchor: [2.5, 0, 0], more: [[-12.56, 0, 0]], split: [[0, 1]] },
  { type: 'P_Modul_26', cat: 'module', label: '沙袋', anchor: [0.23, -0.22, -2.68] },
  { type: 'P_Modul_29', cat: 'module', label: '软木桥', anchor: [10.97, 0, 0.17], more: [[-9.36, 0, 0.17]], split: [[0, 1]] },
  { type: 'P_Modul_30', cat: 'module', label: '跷跷板', anchor: [9.9, 0.05, 0.5], more: [[-9.9, 0.05, 0.5]], split: [[0, 1]] },
  { type: 'P_Modul_34', cat: 'module', label: '落石', anchor: [-2.5, 0, 0], more: [[-12.9, 0, 0]], split: [[0, 1]] },
  { type: 'P_Modul_37', cat: 'module', label: 'T 型板', anchor: [1.23, 0.1, 0], more: [[-13.77, 7.23, 0], [-13.77, -7.24, 0]], split: [[1, 2]] },
  { type: 'P_Modul_41', cat: 'module', label: '箱式浮板（帆板）', anchor: [3.98, 0.02, 0, 1, 5], more: [[-4.03, 0.02, 0, 1, 5]], split: [[0, 1]] },
  { type: 'PE_Balloon', cat: 'module', label: '终点气球', anchor: [24.57, 0.17, 0.01], unique: true },
  // 灯塔：对准方块是塔底那块 5×5 的地板（厚 2.23，顶面就是塔里的地面），像一格路面一样对齐
  { type: 'Latern', cat: 'deco', label: '灯塔', anchor: [0, 0, 2.23, 5, 5, 2.23] },
  { type: 'LaternColumn_Full', cat: 'deco', label: '灯塔（带长柱）', anchor: [0, 0, 95.74, 5, 5, 2.23] },
  // 柱子：对准方块是柱子顶上的那一格路面（顶面 = 路面），柱头顶在这一格路面的底下作为支撑
  { type: 'LaternColumn', cat: 'deco', label: '柱子（支撑）', anchor: [0, 0, 98.51] },
];

export const objType = (type: string) => OBJ_TYPES.find((t) => t.type === type);

/** 资产库里有假机关（机关模型）的机关：编辑器里可以显示成机关模型，制图逻辑和导出仍按占位符 */
const FAKES = new Set([
  'Fake_Ball_Paper', 'Fake_Ball_Stone', 'Fake_Ball_Wood', 'Fake_Box', 'Fake_Balloon',
  'Fake_Trafo_Paper', 'Fake_Trafo_Stone', 'Fake_Trafo_Wood',
  'Fake_Modul_01', 'Fake_Modul_03', 'Fake_Modul_08', 'Fake_Modul_17', 'Fake_Modul_19', 'Fake_Modul_25',
  'Fake_Modul_26', 'Fake_Modul_29', 'Fake_Modul_30', 'Fake_Modul_34', 'Fake_Modul_37', 'Fake_Modul_41',
  // 资产库里没有，用原版机关文件补的（scripts/ph-models.mjs）
  'Fake_Modul_18', 'Fake_Extra_Life', 'Fake_Extra_Point', 'Fake_Dome',
]);
/**
 * 和占位符对不上的机关模型，显示时再调整：先绕本地 Y 轴（转轴）倾斜 pitch 度，再绕 Z 转 rot 度、上下挪 dz。
 *   单摆：模型横着放，转轴（模型原点）挪到占位符横杆的中间高度（低 3）；升降机：模型在升起的位置（底板比占位符高 9.1）；浮板：顶部和占位符顶部（路面）齐平；
 *   跷跷板：模型是平的，按占位符的初始姿态倾斜约 10°（-X 一端落下、+X 一端抬起），转轴抬到占位符转轴的高度；
 *   双向挡板：模型的转轴在原点、两块板各对着 y=±7.5 的路，占位符的两条路在 y=5、y=-10，转轴在两个缺口相接处（x≈-2.92），
 *   平放的那块板搭在挡块上（dx、dy 是机关本地坐标里的平移，跟着机关一起转）。
 */
export const FAKE_FIX: Record<string, { rot?: number; dx?: number; dy?: number; dz?: number; pitch?: number }> = {
  Fake_Modul_17: { rot: 90, dz: -3 },
  Fake_Modul_03: { dz: -9.1 },
  Fake_Modul_41: { dz: -1.35 },
  Fake_Modul_30: { pitch: -10, dz: 2.55 },
  Fake_Modul_19: { dx: -2.92, dy: -2.5, dz: -0.1 },
};
/**
 * 机关模型之外再一起显示的模型（只影响编辑器里的显示，不导出）：
 *   终点飞船前面的软木桥：飞船平台边沿 x≈8.6，路口那一格从 x=22.07 开始；软木桥模型两头的缺口是 -6.86～8.47，
 *   挪 13.6 让桥的路面一头接上那一格，另一头搭在平台上（高度：飞船对准方块顶面 +0.01，软木桥 +0.17）
 */
export const FAKE_EXTRA: Record<string, { name: string; dx: number; dy: number; dz: number }[]> = {
  Fake_Balloon: [{ name: 'Fake_Modul_29', dx: 13.6, dy: 0.17, dz: -0.16 }],
};

export function fakeModel(type: string): string | null {
  const n = type === 'PE_Balloon' ? 'Fake_Balloon' : type.replace(/^P_/, 'Fake_');
  return FAKES.has(n) ? n : null;
}

export function addObj(m: Model, type: string, x: number, y: number, z: number, rot = 0): number | null {
  const t = objType(type);
  if (!t) return null;
  if (t.unique && Object.values(m.objs).some((o) => o.type === type)) return null;
  const id = m.nextId++;
  m.objs[id] = { id, cat: t.cat, type, x, y, z, rot };
  return id;
}

// ---------------- 脚下的路面 ----------------

export interface Surface { id: number; z: number }

/** 平面坐标 (x,y) 处所有路面元素的顶面高度 */
export function surfacesAt(m: Model, x: number, y: number): Surface[] {
  const out: Surface[] = [];
  for (const s of Object.values(m.segs)) {
    const dx = s.dir === 0 ? 1 : s.dir === 2 ? -1 : 0, dy = s.dir === 1 ? 1 : s.dir === 3 ? -1 : 0;
    const t = (x - s.x) * dx + (y - s.y) * dy;
    const lat = (x - s.x) * -dy + (y - s.y) * dx;
    if (t >= -1e-6 && t <= s.len + 1e-6 && Math.abs(lat) <= HALF + 1e-6) out.push({ id: s.id, z: zAt(m, s, t) });
  }
  for (const n of Object.values(m.nodes)) {
    if (nodeContains(n, x, y)) out.push({ id: n.id, z: n.z });
  }
  return out;
}

function nodeContains(n: MNode, x: number, y: number) {
  if (n.kind === 'joint') return false;
  if (n.kind === 'platform') return cellSet(n).has(`${Math.floor(x / CELL)},${Math.floor(y / CELL)}`);
  if (n.kind === 'checkpoint') {
    // 圆盘 + 延伸段，粗略按圆盘半径与延伸段矩形判断
    const r = n.prefab === 'start' ? 8.1 : 5;
    const dx = x - n.x, dy = y - n.y;
    if (Math.hypot(dx, dy) <= r) return true;
    const ax = n.rot! % 2 === 0;
    const along = ax ? dx : dy, across = ax ? dy : dx;
    return Math.abs(across) <= HALF && Math.abs(along) <= PREFAB_PORT[n.prefab!];
  }
  const r = nodeRect(n);
  return x >= r.x0 - 1e-6 && x <= r.x1 + 1e-6 && y >= r.y0 - 1e-6 && y <= r.y1 + 1e-6;
}

/** 物件脚下的路面：取低于物件、最高的那一层；都在上方时取最近的 */
export function surfaceUnder(m: Model, x: number, y: number, z: number): Surface | null {
  const all = surfacesAt(m, x, y);
  if (!all.length) return null;
  const below = all.filter((s) => s.z <= z + 0.5);
  if (below.length) return below.reduce((a, b) => (b.z > a.z ? b : a));
  return all.reduce((a, b) => (b.z < a.z ? b : a));
}

// ---------------- 小节 ----------------

export const sectorCount = (m: Model) => 1 + checkpoints(m).length;

const sectorOfNode = (n: MNode) => (n.prefab === 'start' ? 1 : n.sector!);

export function autoSector(m: Model, o: Obj): number {
  const surf = surfaceUnder(m, o.x, o.y, o.z);
  if (surf) {
    const found: number[] = [];
    const seen = new Set([surf.id]);
    const q = [surf.id];
    while (q.length) {
      const id = q.shift()!;
      const n = m.nodes[id];
      if (n?.kind === 'checkpoint') { found.push(sectorOfNode(n)); if (id !== surf.id) continue; }
      const nb: number[] = [];
      if (n) nb.push(...nodeLinks(m, id).map((l) => l.seg));
      const s = m.segs[id];
      if (s) for (const e of [s.a, s.b]) if (!isFree(e)) nb.push(e.node);
      for (const x of nb) if (!seen.has(x)) { seen.add(x); q.push(x); }
    }
    if (found.length) return Math.min(...found);
  }
  // 不在路网上（或路网上没有盘点）：取最近的盘点
  const cps = [findStart(m), ...checkpoints(m)].filter((n): n is MNode => !!n);
  if (!cps.length) return 1;
  const near = cps.reduce((a, b) => (Math.hypot(b.x - o.x, b.y - o.y) < Math.hypot(a.x - o.x, a.y - o.y) ? b : a));
  return sectorOfNode(near);
}

export const objSector = (m: Model, o: Obj) => (o.sector !== undefined ? Math.min(o.sector, sectorCount(m)) : autoSector(m, o));

/**
 * 路面改动后，物件跟着脚下的路面走：
 * 脚下是节点且节点移动了 → 跟着平移；否则按同一位置路面高度的变化升降。
 */
export function followSurfaces(before: Model, after: Model) {
  for (const o of Object.values(after.objs)) {
    const b = before.objs[o.id];
    if (!b || b.x !== o.x || b.y !== o.y || b.z !== o.z) continue; // 物件本身被移动过
    const s0 = surfaceUnder(before, o.x, o.y, o.z);
    if (!s0) continue;
    const n0 = before.nodes[s0.id], n1 = after.nodes[s0.id];
    if (n0 && n1 && n0.kind === n1.kind && n0.kind !== 'platform') {
      o.x += n1.x - n0.x; o.y += n1.y - n0.y; o.z += n1.z - n0.z;
      continue;
    }
    const all = surfacesAt(after, o.x, o.y);
    const same = all.find((s) => s.id === s0.id);
    const s1 = same ?? (all.length ? all.reduce((a, c) => (Math.abs(c.z - s0.z) < Math.abs(a.z - s0.z) ? c : a)) : null);
    if (s1) o.z += s1.z - s0.z;
  }
}
