// 关卡检查：导出前（或者从文件菜单）把地图过一遍，列出进游戏会出问题的地方。
// 规则来自制图手册「关卡」一章：https://ghomist.github.io/ballance-mapping-manual/mapping/basic/level.html
//   error：游戏会拒绝加载（没有起点、没有终点飞船）；warn：能玩，但有已知的问题或者多半是忘了放
import { assetInfo } from './asset-info';
import { objType } from '../model/objects';
import type { Doc } from './types';

export interface Issue {
  level: 'error' | 'warn';
  text: string;
  /** 一句解释 / 怎么改 */
  hint?: string;
  /** 相关的元素：点这一条时选中它们 */
  ids?: number[];
}

/** 原版游戏一关最多几个小节 */
export const MAX_SECTORS = 8;

export function checkLevel(doc: Doc): Issue[] {
  const out: Issue[] = [];
  const elems = Object.values(doc.elems);
  const starts = elems.filter((e) => e.kind === 'piece' && e.type === 'start');
  const checks = elems.filter((e) => e.kind === 'piece' && e.type === 'check').sort((a, b) => a.id - b.id);
  const balloons = elems.filter((e) => e.kind === 'obj' && e.type === 'PE_Balloon');
  const sectors = 1 + checks.length;

  // ---- 游戏拒绝加载 ----
  if (!starts.length) out.push({ level: 'error', text: '没有起点', hint: '关卡至少要有一个起点（四火焰盘点和第一小节的重生点），否则游戏拒绝加载。素材库 → 路面 / 机关里放一个' });
  if (!balloons.length) out.push({ level: 'error', text: '没有终点飞船', hint: '没有飞船（PE_Balloon）游戏拒绝加载。素材库 → 机关里放一个' });

  // ---- 能玩，但有问题 ----
  if (starts.length > 1) out.push({ level: 'warn', text: `有 ${starts.length} 个起点`, hint: '一关只有一个起点，只有最早放的那个算数', ids: starts.map((e) => e.id) });
  if (balloons.length > 1) out.push({ level: 'warn', text: `有 ${balloons.length} 个终点飞船`, hint: '一关一般只有一个飞船', ids: balloons.map((e) => e.id) });
  if (starts.length && !checks.length) out.push({ level: 'warn', text: '只有一个小节', hint: '只有一小节的关卡，开头的火焰会显示成三角形，而且进关后按 Esc 打不开菜单、退不出去。至少放一个小节盘点（两火焰），让关卡有两个小节' });
  if (sectors > MAX_SECTORS) out.push({ level: 'warn', text: `有 ${sectors} 个小节，超过了 ${MAX_SECTORS} 个`, hint: `原版游戏一关最多 ${MAX_SECTORS} 个小节，多出来的小节不能正常加载`, ids: checks.slice(MAX_SECTORS - 1).map((e) => e.id) });
  const over = elems.filter((e) => e.kind === 'obj' && objType(e.type)?.cat === 'module' && e.type !== 'PE_Balloon' && (e.sector ?? 1) > sectors);
  if (over.length) out.push({ level: 'warn', text: `${over.length} 个机关的小节号超出了范围`, hint: `现在一共 ${sectors} 个小节，这些机关会算进最后一个小节`, ids: over.map((e) => e.id) });
  const skies = elems.filter((e) => e.kind === 'asset' && !!assetInfo(e.name)?.sky);
  if (!skies.length) out.push({ level: 'warn', text: '没有云层', hint: '没有云层的关卡下面是空的。素材库 → 装饰里有云层和漩涡云层' });
  if (skies.length > 1) out.push({ level: 'warn', text: `有 ${skies.length} 个云层`, hint: '一张图只能有一个云层，只导出最早放的那个', ids: skies.map((e) => e.id) });
  if (!elems.some((e) => e.kind === 'zone')) out.push({ level: 'warn', text: '没有死亡区', hint: '没有死亡区，球掉下去以后不会死，会一直往下掉。素材库 → 机关里有死亡区，一般在整张图下面放一大片' });
  return out;
}
