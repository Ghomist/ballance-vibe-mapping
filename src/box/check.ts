// 关卡检查：导出前（或者从文件菜单）把地图过一遍，列出进游戏会出问题的地方。
// 规则来自制图手册「关卡」一章：https://ghomist.github.io/ballance-mapping-manual/mapping/basic/level.html
//   error：游戏会拒绝加载（没有起点、没有终点飞船）；warn：能玩，但有已知的问题或者多半是忘了放
import { assetInfo } from './asset-info';
import { objType } from '../model/objects';
import { stopperMesh } from '../model/stoppers';
import { guardFromRoute } from '../geom/railing';
import { DEFAULT_SETTINGS } from '../model/types';
import { toWorld, yawDeg, type Doc, type GuardElem, type Obj } from './types';
import { apply, fromQuat, rotZ, type V3 } from './xform';

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
  const ft = fansNearTrafos(doc);
  if (ft.length) out.push({
    level: 'warn', text: `${ft.length} 处变球器离风扇的风柱太近`,
    hint: `变球器离风扇的风柱不到 ${FAN_TRAFO_DIST} 个单位：在风扇的受力区域里变球，可能触发物理引擎的 bug。建议把变球器挪远一点`,
    ids: [...new Set(ft.flat())],
  });
  return out;
}

/** 变球器离风柱多近就提醒 */
export const FAN_TRAFO_DIST = 4;
/** 风扇的风柱（受力区域）：和导出的占位符 P_Modul_18 一样，机关本地坐标 [x0, x1, y0, y1, z0, z1] */
const FAN_COLUMN = [-2.49, 2.51, -2.5, 2.5, -4.66, 16.7];
/** 变球器的触发区域：占位符 P_Trafo_* */
const TRAFO_BOX = [-2.5, 2.5, -2.5, 2.5, -0.1, 2.4];

/** 机关的世界摆放（和导出一样：位置经过绑定 / 倾斜，朝向是自己的四元数或者绕 Z 的转角） */
const placeOf = (o: Obj) => ({ pos: toWorld(o, [o.x, o.y, o.z]), R: o.q ? fromQuat(o.q) : rotZ(yawDeg(o)) });

/** 离风柱太近的 [风扇, 变球器] 对：变球器的触发区域按 1 个单位左右的间隔取点，换到风扇本地坐标里量到风柱的距离 */
function fansNearTrafos(doc: Doc): [number, number][] {
  const objs = Object.values(doc.elems).filter((e): e is Obj => e.kind === 'obj');
  const fans = objs.filter((o) => o.type === 'P_Modul_18').map((o) => ({ id: o.id, ...placeOf(o) }));
  const trafos = objs.filter((o) => /^P_Trafo_/.test(o.type)).map((o) => ({ id: o.id, ...placeOf(o) }));
  if (!fans.length || !trafos.length) return [];
  const steps = (a: number, b: number) => { const n = Math.max(1, Math.ceil(b - a)); return Array.from({ length: n + 1 }, (_, i) => a + ((b - a) * i) / n); };
  const local: V3[] = [];
  for (const x of steps(TRAFO_BOX[0], TRAFO_BOX[1])) for (const y of steps(TRAFO_BOX[2], TRAFO_BOX[3])) for (const z of steps(TRAFO_BOX[4], TRAFO_BOX[5])) local.push([x, y, z]);
  const D2 = FAN_TRAFO_DIST * FAN_TRAFO_DIST, c = FAN_COLUMN;
  const out: [number, number][] = [];
  for (const t of trafos) {
    const pts = local.map((p) => { const w = apply(t.R, p); return [w[0] + t.pos[0], w[1] + t.pos[1], w[2] + t.pos[2]] as V3; });
    for (const f of fans) {
      // 粗筛：风柱离原点最远约 17.1，变球器约 4.2，加上阈值 4 还不到 30
      if (Math.hypot(t.pos[0] - f.pos[0], t.pos[1] - f.pos[1], t.pos[2] - f.pos[2]) > 30) continue;
      const Rt = f.R;
      const hit = pts.some((w) => {
        const v: V3 = [w[0] - f.pos[0], w[1] - f.pos[1], w[2] - f.pos[2]];
        // 世界 → 风扇本地：乘 Rᵀ
        const l = [0, 1, 2].map((k) => Rt[k] * v[0] + Rt[k + 3] * v[1] + Rt[k + 6] * v[2]);
        let d2 = 0;
        for (let k = 0; k < 3; k++) { const e = Math.max(c[k * 2] - l[k], 0, l[k] - c[k * 2 + 1]); d2 += e * e; }
        return d2 <= D2;
      });
      if (hit) out.push([f.id, t.id]);
    }
  }
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
