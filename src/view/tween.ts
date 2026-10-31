// 显示模型向真实模型的平滑过渡：只插值数值（位置、长度、高度），结构字段直接取目标值。
// 所有数值用同一个插值系数，因此直道端点与节点端口在过渡中保持对齐。
import { MNode, Model, isFree } from '../model/types';

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

/** 两个平台的小格是否只差一个整体平移 */
function sameShape(a: MNode, b: MNode) {
  const ca = a.cells ?? [], cb = b.cells ?? [];
  if (ca.length !== cb.length || !ca.length) return false;
  const norm = (cs: string[]) => {
    const ps = cs.map((c) => c.split(',').map(Number));
    const i0 = Math.min(...ps.map((p) => p[0])), j0 = Math.min(...ps.map((p) => p[1]));
    return ps.map((p) => `${p[0] - i0},${p[1] - j0}`).sort().join(';');
  };
  return norm(ca) === norm(cb);
}

export function lerpModel(disp: Model, target: Model, t: number): { model: Model; done: boolean } {
  let maxDiff = 0;
  const track = (a: number, b: number) => { maxDiff = Math.max(maxDiff, Math.abs(a - b)); return lerp(a, b, t); };
  const out: Model = { nodes: {}, segs: {}, nextId: target.nextId, root: target.root, rails: {}, objs: {}, guards: target.guards, settings: target.settings };

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
      if (n.kind === 'platform') {
        // 平台的形状是离散的小格，没法插值：整体平移时按目标形状绘制，再偏移过渡量；形状变了就直接用目标
        const off = d.dispOff ?? [0, 0, 0];
        const from = sameShape(d, n) ? [d.x + off[0], d.y + off[1], d.z + off[2]] : [n.x, n.y, d.z + off[2]];
        nn.dispOff = [track(from[0], n.x) - n.x, track(from[1], n.y) - n.y, track(from[2], n.z) - n.z];
      } else {
        nn.x = track(d.x, n.x);
        nn.y = track(d.y, n.y);
        nn.z = track(d.z, n.z);
      }
    }
    out.nodes[n.id] = nn;
  }
  // 钢轨：结构相同时逐段插值
  out.rails = {};
  for (const r of Object.values(target.rails)) {
    const d = disp.rails?.[r.id];
    if (!d || d.pieces.length !== r.pieces.length || d.pieces.some((p, i) => p.kind !== r.pieces[i].kind)) { out.rails[r.id] = r; continue; }
    out.rails[r.id] = {
      ...r, x: track(d.x, r.x), y: track(d.y, r.y), z: track(d.z, r.z), heading: track(d.heading, r.heading),
      pieces: r.pieces.map((p, i) => ({ ...p, len: track(d.pieces[i].len, p.len), radius: track(d.pieces[i].radius, p.radius), angle: track(d.pieces[i].angle, p.angle), dz: track(d.pieces[i].dz, p.dz) })),
    };
  }
  // 机关 / 装饰
  out.objs = {};
  for (const o of Object.values(target.objs ?? {})) {
    const d = disp.objs?.[o.id];
    if (!d) { out.objs[o.id] = o; continue; }
    const dr = ((o.rot - d.rot + 540) % 360) - 180;
    out.objs[o.id] = { ...o, x: track(d.x, o.x), y: track(d.y, o.y), z: track(d.z, o.z), rot: o.rot - dr + track(0, dr) };
  }
  if (maxDiff < 1e-3) return { model: structuredClone(target), done: true };
  return { model: out, done: false };
}
