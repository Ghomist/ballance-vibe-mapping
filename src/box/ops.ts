// 文档上的编辑操作：旋转、合并、切分、复制、绑定、包围盒
import { Box, Dir, Doc, Elem, OrientedElem, canTilt, dirToLocal, footprint, isOriented, localBounds, pivotOf, toWorld } from './types';
import { sampleRail } from '../model/rail';
import { type M3, I3, apply, fromQuat, isUpright, mul, rotZ, splitYaw, toQuat, yawOf } from './xform';

export type V3 = [number, number, number];
export interface Bounds { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number }

/** 元素的包围盒（世界坐标；机关按对准方块；转过的元素取 8 个角转过去之后的包围盒） */
export function elemBounds(e: Elem): Bounds {
  if (e.kind === 'rail') { const f = footprint(e); const zs = sampleRail(e).map((p) => p.z); return { ...f, z0: Math.min(...zs) - 1.2, z1: Math.max(...zs) }; }
  if (e.kind === 'guard') { const f = footprint(e); return { ...f, z0: Math.min(...e.pts.map((p) => p[2])) - 2, z1: Math.max(...e.pts.map((p) => p[2])) + 2.6 }; }
  const b = localBounds(e);
  if (!e.ang && !e.q) return b;
  const cs: V3[] = [];
  for (const x of [b.x0, b.x1]) for (const y of [b.y0, b.y1]) for (const z of [b.z0, b.z1]) cs.push(toWorld(e, [x, y, z]));
  return {
    x0: Math.min(...cs.map((c) => c[0])), y0: Math.min(...cs.map((c) => c[1])), z0: Math.min(...cs.map((c) => c[2])),
    x1: Math.max(...cs.map((c) => c[0])), y1: Math.max(...cs.map((c) => c[1])), z1: Math.max(...cs.map((c) => c[2])),
  };
}

export function unionBounds(bs: Bounds[]): Bounds {
  return {
    x0: Math.min(...bs.map((b) => b.x0)), y0: Math.min(...bs.map((b) => b.y0)), z0: Math.min(...bs.map((b) => b.z0)),
    x1: Math.max(...bs.map((b) => b.x1)), y1: Math.max(...bs.map((b) => b.y1)), z1: Math.max(...bs.map((b) => b.z1)),
  };
}

export const boundsOf = (doc: Doc, ids: Iterable<number>) => unionBounds([...ids].map((id) => elemBounds(doc.elems[id])));

/** 选中一个元素时，同一个绑定组的元素一起选上 */
export function expandGroups(doc: Doc, ids: Iterable<number>): Set<number> {
  const out = new Set<number>();
  const groups = new Set<number>();
  for (const id of ids) { const e = doc.elems[id]; if (!e) continue; out.add(id); if (e.group !== undefined) groups.add(e.group); }
  if (groups.size) for (const e of Object.values(doc.elems)) if (e.group !== undefined && groups.has(e.group)) out.add(e.id);
  return out;
}

/** 平移（d 是世界坐标里的位移；转过的元素换到它自己的坐标系里再加） */
export function translateElem(e: Elem, d: V3) {
  // 倾斜的元素 ang 为 0、绕自己的中心转：坐标直接加；只绕 Z 转的换到朝向坐标系里
  if (isOriented(e) && e.ang && !e.q) d = dirToLocal(e, d);
  e.x += d[0]; e.y += d[1]; e.z += d[2];
  if (e.kind === 'guard') for (const p of e.pts) { p[0] += d[0]; p[1] += d[1]; p[2] += d[2]; }
}

/** 绕竖直轴转 90°（逆时针），转轴过 (px, py) */
export function rotateElem(e: Elem, px: number, py: number) {
  const rot = (x: number, y: number): [number, number] => [px - (y - py), py + (x - px)];
  if (e.kind === 'box' || e.kind === 'zone') {
    const f = footprint(e);
    const [ax, ay] = rot(f.x0, f.y0), [bx, by] = rot(f.x1, f.y1);
    e.x = Math.min(ax, bx); e.y = Math.min(ay, by);
    [e.sx, e.sy] = [e.sy, e.sx];
    if (e.kind === 'zone') return;
    if (e.slope) {
      // 沿 +X 升高 → 沿 +Y 升高；沿 +Y 升高 → 沿 -X 升高（低的一端换到另一头）
      if (e.slope.axis === 0) e.slope = { axis: 1, dz: e.slope.dz };
      else { e.z += e.slope.dz; e.slope = { axis: 0, dz: -e.slope.dz }; }
    }
    if (e.open) e.open = ((e.open << 1) | (e.open >> 3)) & 15;
    if (e.closed) e.closed = ((e.closed << 1) | (e.closed >> 3)) & 15;
    return;
  }
  if (e.kind === 'guard') {
    for (const p of e.pts) [p[0], p[1]] = rot(p[0], p[1]);
    e.outs = e.outs.map(([ox, oy]) => [-oy, ox]);
    [e.x, e.y] = [e.pts[0][0], e.pts[0][1]];
    return;
  }
  [e.x, e.y] = rot(e.x, e.y);
  if (e.kind === 'piece' && e.spawn !== undefined) e.spawn = (e.spawn + 90) % 360;
  if (e.kind === 'rail') { e.heading = (e.heading + 90) % 360; return; }
  e.rot = ((e.rot + 1) % 4) as Dir;
}

/** 合并：几个同样式、同高度、同厚度的平 box 拼起来正好是一个矩形时，合成一个 */
export function mergeBoxes(doc: Doc, ids: number[]): { ok: true; id: number } | { ok: false; msg: string } {
  const bs = ids.map((id) => doc.elems[id]).filter((e): e is Box => e?.kind === 'box');
  if (bs.length < 2) return { ok: false, msg: '至少选两个路面才能合并' };
  if (bs.length !== ids.length) return { ok: false, msg: '只有路面能合并' };
  const a = bs[0];
  if (bs.some((b) => b.style !== a.style)) return { ok: false, msg: '样式不同的路面不能合并' };
  if (bs.some((b) => b.slope)) return { ok: false, msg: '倾斜的路面不能合并' };
  if (bs.some((b) => Math.abs(b.z - a.z) > 1e-3 || Math.abs(b.depth - a.depth) > 1e-3)) return { ok: false, msg: '高度或厚度不同的路面不能合并' };
  const fs = bs.map(footprint);
  const bb = { x0: Math.min(...fs.map((f) => f.x0)), y0: Math.min(...fs.map((f) => f.y0)), x1: Math.max(...fs.map((f) => f.x1)), y1: Math.max(...fs.map((f) => f.y1)) };
  // 拼起来要正好盖满包围矩形
  const xs = [...new Set(fs.flatMap((f) => [f.x0, f.x1]))].sort((p, q) => p - q);
  const ys = [...new Set(fs.flatMap((f) => [f.y0, f.y1]))].sort((p, q) => p - q);
  for (let i = 0; i + 1 < xs.length; i++) for (let j = 0; j + 1 < ys.length; j++) {
    const cx = (xs[i] + xs[i + 1]) / 2, cy = (ys[j] + ys[j + 1]) / 2;
    if (xs[i + 1] - xs[i] < 0.01 || ys[j + 1] - ys[j] < 0.01) continue;
    if (!fs.some((f) => cx > f.x0 && cx < f.x1 && cy > f.y0 && cy < f.y1)) return { ok: false, msg: '这几块拼起来不是一个矩形，没法合并' };
  }
  // 开口：原来贴着包围矩形某一边、并且那一边是开口的，合并后那一边也是开口
  let open = 0, closed = 0;
  bs.forEach((b, i) => {
    const f = fs[i];
    for (const d of [0, 1, 2, 3] as Dir[]) {
      const on = [Math.abs(f.x1 - bb.x1), Math.abs(f.y1 - bb.y1), Math.abs(f.x0 - bb.x0), Math.abs(f.y0 - bb.y0)][d] < 1e-6;
      if (on && (b.open ?? 0) & (1 << d)) open |= 1 << d;
      if (on && (b.closed ?? 0) & (1 << d)) closed |= 1 << d;
    }
  });
  const keep = bs.reduce((p, q) => (q.id < p.id ? q : p));
  Object.assign(keep, { x: bb.x0, y: bb.y0, sx: bb.x1 - bb.x0, sy: bb.y1 - bb.y0, open: open || undefined, closed: closed || undefined });
  for (const b of bs) if (b !== keep) delete doc.elems[b.id];
  return { ok: true, id: keep.id };
}

/** 切分：沿 axis 方向在坐标 t 处切开（axis=0：切线是 x=t），返回新的那一块 */
export function splitBox(doc: Doc, id: number, axis: 0 | 1, t: number): number | null {
  const b = doc.elems[id];
  if (b?.kind !== 'box') return null;
  const lo = axis === 0 ? b.x : b.y, len = axis === 0 ? b.sx : b.sy;
  if (t <= lo + 0.01 || t >= lo + len - 0.01) return null;
  const nb: Box = JSON.parse(JSON.stringify(b));
  nb.id = doc.nextId++;
  const l1 = t - lo, l2 = len - l1;
  if (axis === 0) { b.sx = l1; nb.x = t; nb.sx = l2; } else { b.sy = l1; nb.y = t; nb.sy = l2; }
  if (b.slope && b.slope.axis === axis) {
    const dz1 = (b.slope.dz * l1) / len;
    nb.slope = { axis, dz: b.slope.dz - dz1 };
    nb.z = b.z + dz1;
    b.slope = { axis, dz: dz1 };
  }
  // 切口两侧不是开口，也不封口
  const hi = (axis === 0 ? 0 : 1) as Dir, low = (axis === 0 ? 2 : 3) as Dir;
  if (b.open) b.open = (b.open & ~(1 << hi)) || undefined;
  if (nb.open) nb.open = (nb.open & ~(1 << low)) || undefined;
  if (b.closed) b.closed = (b.closed & ~(1 << hi)) || undefined;
  if (nb.closed) nb.closed = (nb.closed & ~(1 << low)) || undefined;
  doc.elems[nb.id] = nb;
  return nb.id;
}

/** 复制：绑定组也换成新的组号 */
export function duplicate(doc: Doc, ids: Iterable<number>): number[] {
  let g = Math.max(0, ...Object.values(doc.elems).map((e) => e.group ?? 0));
  const remap = new Map<number, number>();
  const out: number[] = [];
  for (const id of ids) {
    const e: Elem = JSON.parse(JSON.stringify(doc.elems[id]));
    e.id = doc.nextId++;
    if (e.group !== undefined) { if (!remap.has(e.group)) remap.set(e.group, ++g); e.group = remap.get(e.group); }
    doc.elems[e.id] = e;
    out.push(e.id);
  }
  return out;
}

export function groupElems(doc: Doc, ids: Iterable<number>) {
  const g = Math.max(0, ...Object.values(doc.elems).map((e) => e.group ?? 0)) + 1;
  for (const id of ids) doc.elems[id].group = g;
}

export function ungroupElems(doc: Doc, ids: Iterable<number>) {
  for (const id of ids) delete doc.elems[id].group;
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

/**
 * 把元素绕世界里的点 P 转 R（旋转矩阵）。钢轨、护栏、素材件只能绕 Z 转。
 * 转完以后仍然朝上的：只记绕 Z 的角度（拆成 [0, 90) 的朝向坐标系 + 90° 的整数倍），照样参与路面求解；
 * 倾斜了的：记成四元数，绕中心 / 原点转。
 */
export function rotateWorld(e: Elem, R: M3, P: V3) {
  const rot = (p: V3): V3 => { const v = apply(R, [p[0] - P[0], p[1] - P[1], p[2] - P[2]]); return [v[0] + P[0], v[1] + P[1], v[2] + P[2]]; };
  const yaw = yawOf(R);
  if (e.kind === 'rail') {
    const p = rot([e.x, e.y, e.z]);
    [e.x, e.y, e.z] = p.map(r6) as V3;
    e.heading = r6(((e.heading + yaw) % 360 + 360) % 360);
    return;
  }
  if (e.kind === 'guard') {
    for (const p of e.pts) { const q = rot(p); p[0] = r6(q[0]); p[1] = r6(q[1]); p[2] = r6(q[2]); }
    e.outs = e.outs.map(([ox, oy]) => { const v = apply(R, [ox, oy, 0]); return [r6(v[0]), r6(v[1])] as [number, number]; });
    [e.x, e.y, e.z] = e.pts[0];
    return;
  }
  const o = e as OrientedElem;
  const box = o.kind === 'box' || o.kind === 'zone';
  const Wc = rot(toWorld(o, pivotOf(o)));
  // 元素自己的轴：Rz(ang)·Q，机关、素材件再乘 Rz(rot·90)
  const O = mul(rotZ(o.ang ?? 0), o.q ? fromQuat(o.q) : I3);
  const O2 = mul(R, box ? O : mul(O, rotZ((o as { rot: Dir }).rot * 90)));
  if (isUpright(O2)) {
    const { ang, quarter } = splitYaw(yawOf(O2));
    if (box) {
      const b = localBounds(o);
      for (let k = 0; k < quarter; k++) rotateElem(o, (b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2);
    } else {
      const p = o as Exclude<OrientedElem, Box | { kind: 'zone' }>;
      if (p.kind === 'piece' && p.spawn !== undefined) p.spawn = r6((((p.ang ?? 0) + p.spawn + yaw - ang) % 360 + 360) % 360);
      p.rot = quarter;
    }
    o.ang = ang || undefined;
    delete o.q;
  } else {
    if (!canTilt(o)) return;
    delete o.ang;
    o.q = toQuat(O2);
    if (!box) (o as { rot: Dir }).rot = 0;
  }
  // 转轴（中心 / 原点）落到转过去的位置
  const now = toWorld(o, pivotOf(o));
  let d: V3 = [Wc[0] - now[0], Wc[1] - now[1], Wc[2] - now[2]];
  if (o.ang) d = dirToLocal(o, d);
  o.x = r6(o.x + d[0]); o.y = r6(o.y + d[1]); o.z = r6(o.z + d[2]);
}

/** 摆正：去掉倾斜，只保留绕 Z 的朝向（中心不动） */
export function uprightElem(e: Elem) {
  if (!isOriented(e) || !e.q) return;
  const m = fromQuat(e.q);
  // 局部 X 轴投到水平面上的方向当作朝向
  const yaw = Math.atan2(m[3], m[0]) * 180 / Math.PI;
  const c = toWorld(e, pivotOf(e));
  delete e.q;
  const p = pivotOf(e);
  e.x += c[0] - p[0]; e.y += c[1] - p[1]; e.z += c[2] - p[2];
  rotateWorld(e, rotZ(yaw), c);
}
