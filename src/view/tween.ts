// 显示模型向真实模型的平滑过渡：只插值数值（位置、长度、高度），结构字段直接取目标值。
// 所有数值用同一个插值系数，因此直道端点与节点端口在过渡中保持对齐。
import { Model, isFree } from '../model/types';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export function lerpModel(disp: Model, target: Model, t: number): { model: Model; done: boolean } {
  let maxDiff = 0;
  const track = (a: number, b: number) => { maxDiff = Math.max(maxDiff, Math.abs(a - b)); return lerp(a, b, t); };
  const out: Model = { nodes: {}, segs: {}, nextId: target.nextId, root: target.root };

  for (const s of Object.values(target.segs)) {
    const d = disp.segs[s.id];
    const ns = structuredClone(s);
    if (d && d.dir === s.dir) {
      ns.x = track(d.x, s.x);
      ns.y = track(d.y, s.y);
      ns.len = track(d.len, s.len);
      if (isFree(ns.a) && isFree(d.a)) ns.a.z = track(d.a.z, ns.a.z);
      if (isFree(ns.b) && isFree(d.b)) ns.b.z = track(d.b.z, ns.b.z);
    } else if (!d && !isFree(s.a)) {
      // 从节点端口新长出来的直道：从 0 开始生长
      ns.len = track(0, s.len);
    }
    out.segs[s.id] = ns;
  }
  for (const n of Object.values(target.nodes)) {
    const d = disp.nodes[n.id];
    const nn = { ...n };
    if (d && d.kind === n.kind) {
      nn.x = track(d.x, n.x);
      nn.y = track(d.y, n.y);
      nn.z = track(d.z, n.z);
    }
    out.nodes[n.id] = nn;
  }
  if (maxDiff < 1e-3) return { model: structuredClone(target), done: true };
  return { model: out, done: false };
}
