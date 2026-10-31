// 挡块（Phys_FloorStopper）：部分机关在原版里总是配着木头挡块（卡住摆动的部件）。
// 模板取自原版关卡：每种机关在半数以上实例里都出现的挡块面，按机关本地坐标记录（x, y, z, u, v）。
import templates from './stopper-templates.json';
import type { Obj } from './objects';

const T = templates as Record<string, number[]>;

export const hasStopper = (type: string) => !!T[type];

/** 机关的挡块三角形（世界坐标与 UV）；没有或被关掉时返回 null */
export function stopperMesh(o: Obj): { pos: number[]; uv: number[] } | null {
  const t = T[o.type];
  if (!t || o.noStopper) return null;
  const r = (o.rot * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  const pos: number[] = [], uv: number[] = [];
  for (let i = 0; i < t.length; i += 5) {
    const x = t[i], y = t[i + 1];
    pos.push(o.x + x * c - y * s, o.y + x * s + y * c, o.z + t[i + 2]);
    uv.push(t[i + 3], t[i + 4]);
  }
  return { pos, uv };
}
