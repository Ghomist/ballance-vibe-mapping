// 关卡检查：导出前（或者从文件菜单）把地图过一遍，列出进游戏会出问题的地方。
// 规则来自制图手册「关卡」一章：https://ghomist.github.io/ballance-mapping-manual/mapping/basic/level.html
//   error：游戏会拒绝加载（没有起点、没有终点飞船）；warn：能玩，但有已知的问题或者多半是忘了放
import { assetInfo } from './asset-info';
import { objType } from '../model/objects';
import { stopperMesh } from '../model/stoppers';
import { guardFromRoute } from '../geom/railing';
import { DEFAULT_SETTINGS } from '../model/types';
import { toWorld, yawDeg, type Doc, type GuardElem } from './types';

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
  const near = stoppersNearGuards(doc);
  if (near.objs.length) out.push({
    level: 'warn', text: `${near.objs.length} 个机关的挡块附近有护栏`,
    hint: `挡块 ${STOPPER_GUARD_DIST} 个单位以内有护栏：护栏的顶点很多，会拖累物理引擎，让挡块间歇失效、球直接滚过去。建议改一下设计，删掉这附近的护栏`,
    ids: [...near.objs, ...near.guards],
  });
  return out;
}

/** 挡块离护栏多近就提醒 */
export const STOPPER_GUARD_DIST = 5;

/** 挡块（和导出一样：没关掉、没倾斜的机关）附近 STOPPER_GUARD_DIST 以内有护栏的机关和护栏 */
function stoppersNearGuards(doc: Doc): { objs: number[]; guards: number[] } {
  const elems = Object.values(doc.elems);
  const st = { ...DEFAULT_SETTINGS, ...(doc.settings ?? {}) };
  // 护栏网格的三角形边（护栏是细管子，到边的距离就够准）
  const guards = elems.filter((e): e is GuardElem => e.kind === 'guard').flatMap((g) => {
    const m = guardFromRoute({ pts: g.pts, outs: g.outs }, st);
    if (!m?.pos.length) return [];
    const p = m.pos;
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < p.length; i += 3) for (let k = 0; k < 3; k++) { box[k] = Math.min(box[k], p[i + k]); box[k + 3] = Math.max(box[k + 3], p[i + k]); }
    return [{ id: g.id, pos: p, box }];
  });
  if (!guards.length) return { objs: [], guards: [] };
  const D = STOPPER_GUARD_DIST, D2 = D * D;
  const segDist2 = (q: number[], p: number[], a: number, b: number) => {
    const ax = p[a], ay = p[a + 1], az = p[a + 2];
    const dx = p[b] - ax, dy = p[b + 1] - ay, dz = p[b + 2] - az;
    const l = dx * dx + dy * dy + dz * dz;
    const t = l ? Math.max(0, Math.min(1, ((q[0] - ax) * dx + (q[1] - ay) * dy + (q[2] - az) * dz) / l)) : 0;
    const x = ax + dx * t - q[0], y = ay + dy * t - q[1], z = az + dz * t - q[2];
    return x * x + y * y + z * z;
  };
  const objs: number[] = [], hit = new Set<number>();
  for (const o of elems) {
    if (o.kind !== 'obj' || o.noStopper || o.q) continue;
    const w = toWorld(o, [o.x, o.y, o.z]);
    const sm = stopperMesh({ id: 0, cat: 'module', type: o.type, x: w[0], y: w[1], z: w[2], rot: yawDeg(o), stopOff: o.stopOff });
    if (!sm?.pos.length) continue;
    const sp = sm.pos;
    const sb = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
    for (let i = 0; i < sp.length; i += 3) for (let k = 0; k < 3; k++) { sb[k] = Math.min(sb[k], sp[i + k]); sb[k + 3] = Math.max(sb[k + 3], sp[i + k]); }
    let near = false;
    for (const g of guards) {
      if ([0, 1, 2].some((k) => g.box[k] > sb[k + 3] + D || g.box[k + 3] < sb[k] - D)) continue;
      let found = false;
      for (let i = 0; i < sp.length && !found; i += 3) {
        const q = [sp[i], sp[i + 1], sp[i + 2]];
        if ([0, 1, 2].some((k) => q[k] < g.box[k] - D || q[k] > g.box[k + 3] + D)) continue;
        for (let t = 0; t + 8 < g.pos.length && !found; t += 9) {
          if (segDist2(q, g.pos, t, t + 3) <= D2 || segDist2(q, g.pos, t + 3, t + 6) <= D2 || segDist2(q, g.pos, t + 6, t) <= D2) found = true;
        }
      }
      if (found) { near = true; hit.add(g.id); }
    }
    if (near) objs.push(o.id);
  }
  return { objs, guards: [...hit] };
}
