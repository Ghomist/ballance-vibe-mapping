// 挡块（Phys_FloorStopper）：部分机关在原版里总是配着木头挡块（卡住摆动的部件）。
// 模板取自原版关卡：每种机关在半数以上实例里都出现的挡块面，按机关本地坐标记录（x, y, z, u, v）。
import templates from './stopper-templates.json';
import type { Obj } from './objects';

const T = templates as Record<string, number[]>;

export const hasStopper = (type: string) => !!T[type];

/**
 * 一种机关的挡块分成几块：模板里互相不连着的三角形各成一块（Modul 25 一块，19、30、37 各两块），
 * 按在模板里第一次出现的顺序编号。每块是三角形编号的列表。
 */
const PARTS = new Map<string, number[][]>();
function parts(type: string): number[][] {
  const hit = PARTS.get(type);
  if (hit) return hit;
  const t = T[type] ?? [];
  const n = t.length / 15;
  const key = (v: number) => `${t[v * 5].toFixed(3)},${t[v * 5 + 1].toFixed(3)},${t[v * 5 + 2].toFixed(3)}`;
  const par = Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => (par[a] === a ? a : (par[a] = find(par[a])));
  const owner = new Map<string, number>();
  for (let tri = 0; tri < n; tri++) for (let k = 0; k < 3; k++) {
    const p = key(tri * 3 + k), o = owner.get(p);
    if (o === undefined) owner.set(p, tri); else par[find(tri)] = find(o);
  }
  const groups = new Map<number, number[]>();
  for (let tri = 0; tri < n; tri++) { const r = find(tri); if (!groups.has(r)) groups.set(r, []); groups.get(r)!.push(tri); }
  const out = [...groups.values()];
  PARTS.set(type, out);
  return out;
}

/** 这种机关有几块挡块 */
export const stopperCount = (type: string) => parts(type).length;

/** 第 i 块挡块关掉了没有：noStopper（以前的整体开关）是全关，stopOff 按位记哪几块关掉 */
export const stopperOff = (o: Pick<Obj, 'noStopper' | 'stopOff'>, i: number) => !!o.noStopper || ((o.stopOff ?? 0) >> i) % 2 === 1;

/** 每块挡块顶面的中心（机关本地坐标，转向之前）：开关圆圈画在这里 */
export function stopperTops(type: string): [number, number, number][] {
  const t = T[type] ?? [];
  return parts(type).map((tris) => {
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z1 = -Infinity;
    for (const tri of tris) for (let k = 0; k < 3; k++) {
      const v = (tri * 3 + k) * 5;
      x0 = Math.min(x0, t[v]); x1 = Math.max(x1, t[v]); y0 = Math.min(y0, t[v + 1]); y1 = Math.max(y1, t[v + 1]); z1 = Math.max(z1, t[v + 2]);
    }
    return [(x0 + x1) / 2, (y0 + y1) / 2, z1];
  });
}

/**
 * 机关的挡块三角形（世界坐标与 UV）：默认只要开着的那几块，which 可以另外指定要哪几块（比如只要关掉的，画成虚影）。
 * 一块都没有时返回 null
 */
export function stopperMesh(o: Obj, which: (part: number) => boolean = (i) => !stopperOff(o, i)): { pos: number[]; uv: number[] } | null {
  const t = T[o.type];
  if (!t) return null;
  const r = (o.rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const pos: number[] = [], uv: number[] = [];
  parts(o.type).forEach((tris, part) => {
    if (!which(part)) return;
    for (const tri of tris) for (let k = 0; k < 3; k++) {
      const i = (tri * 3 + k) * 5;
      const x = t[i], y = t[i + 1];
      pos.push(o.x + x * c - y * s, o.y + x * s + y * c, o.z + t[i + 2]);
      uv.push(t[i + 3], t[i + 4]);
    }
  });
  return pos.length ? { pos, uv } : null;
}
