// 起点、小节盘点拆成三部分：盘点路面（piece，bare 表示只有路面）+ 火焰（PS_FourFlames / PC_TwoFlames）+ 重生点（PR_Resetpoint），
// 火焰、重生点是普通的机关元素，三者放的时候绑成一组。旧地图里没有 bare 的盘点照旧自带火焰和重生点（求解时生成）。
// 小节编号：起点是第 1 小节；PC_TwoFlames 的 sector = n 表示「激活第 n 小节」（导出成 PC_TwoFlames_{n-1}），重生点的 sector 就是它所在的小节。
import type { Doc, Elem, Obj, Piece } from './types';

export const START_FLAMES = 'PS_FourFlames', CHECK_FLAMES = 'PC_TwoFlames', RESET_POINT = 'PR_Resetpoint';
export const CP_OBJ_TYPES = new Set([START_FLAMES, CHECK_FLAMES, RESET_POINT]);
/** 火焰离盘点路面顶面多低（占位符原点在火焰锥底） */
export const FLAME_CONE = 1.25555;
/** 重生点比火焰原点高多少（起点、小节盘点不一样，和原版一样） */
export const START_RESET_DZ = 3.65, CHECK_RESET_DZ = 3.3258;

const isObj = (e: Elem, type: string): e is Obj => e.kind === 'obj' && e.type === type;
/** 自带火焰和重生点的旧式盘点 */
export const isFullCheckpoint = (e: Elem): e is Piece => e.kind === 'piece' && (e.type === 'start' || e.type === 'check') && !e.bare;

/** 起点：旧式的起点盘点，或者起点四火 */
export const startsOf = (elems: Elem[]): Elem[] => elems.filter((e) => isFullCheckpoint(e) && e.type === 'start' || isObj(e, START_FLAMES));
/** 旧式小节盘点（按编号排，编号决定默认小节号） */
export const fullChecksOf = (elems: Elem[]): Piece[] => elems.filter((e): e is Piece => isFullCheckpoint(e) && e.type === 'check').sort((a, b) => a.id - b.id);

/** 每个「激活一个小节」的东西（旧式小节盘点、两火）和它激活的小节号 */
export function checkpointSectors(elems: Elem[]): { e: Elem; sector: number }[] {
  const full = fullChecksOf(elems);
  return [
    ...full.map((p, i) => ({ e: p as Elem, sector: p.sector ?? i + 2 })),
    ...elems.filter((e): e is Obj => isObj(e, CHECK_FLAMES)).map((o) => ({ e: o as Elem, sector: o.sector ?? 2 })),
  ];
}
/** 一共几个小节 */
export function sectorTotal(elems: Elem[]): number {
  let n = 1 + fullChecksOf(elems).length;
  for (const { sector } of checkpointSectors(elems)) n = Math.max(n, sector);
  for (const e of elems) if (isObj(e, RESET_POINT)) n = Math.max(n, e.sector ?? 1);
  return n;
}
/** 新放一个小节盘点时它激活第几小节 */
export const nextCheckSector = (doc: Doc) => Math.max(1, ...checkpointSectors(Object.values(doc.elems)).map((c) => c.sector)) + 1;

/**
 * 新的起点 / 小节盘点：路面（bare）+ 火焰 + 重生点，绑成一组。位置和朝向与旧式盘点生成的完全一样。
 * nextId：从哪个编号开始；group：组号；sector：小节盘点激活第几小节
 */
export function newCheckpoint(type: 'start' | 'check', nextId: () => number, group: number, sector: number): Elem[] {
  const p: Piece = { id: nextId(), kind: 'piece', type, x: 0, y: 0, z: 0, rot: 0, bare: true, group };
  const flames: Obj = { id: nextId(), kind: 'obj', type: type === 'start' ? START_FLAMES : CHECK_FLAMES, x: 0, y: 0, z: -FLAME_CONE, rot: type === 'start' ? 1 : 0, group };
  if (type === 'check') flames.sector = sector;
  // 重生点占位符本身朝 -X：转 180° 才朝着路口；起点的重生点比小节的高一点（和原版一样）
  const reset: Obj = { id: nextId(), kind: 'obj', type: RESET_POINT, x: 0, y: 0, z: -FLAME_CONE + (type === 'start' ? START_RESET_DZ : CHECK_RESET_DZ), rot: 2, sector: type === 'start' ? 1 : sector, group };
  return [p, flames, reset];
}
