// 机关专属路面（底座）：变球器底座、风扇底座、栅栏路面。
//
// 与原版一致：放变球器 / 风扇 / 栅栏时，把机关脚下那一格（栅栏是顺着它的两格）路面换成专属路面，
// 专属路面是路网里的一个节点，两侧照常接路；机关删掉或挪走后，专属路面变回普通路面。
//   变球器：TrafoBase_<材质>，5×5×5 整块，顶面与路面齐平，变球器原点高出顶面 0.1
//   风扇：Ventilator_*，按哪几边接着路选择边框花纹（与普通路块的边框规则相同）
//   栅栏：原版 Slider，5×10，沿栅栏方向两格，路口在两头
import type { PrefabPart } from './checkpoint';
import { insertNodeOnSeg } from './checkpoint';
import { deleteElem } from './ops';
import type { Obj } from './objects';
import { objType } from './objects';
import {
  BLOCK, BaseKind, DX, DY, Dir, EndKey, HALF, MNode, Model, axisOf, endPos, endZ, isFree, nodeHalf, nodeLinks, nodePorts, opp,
} from './types';

const EPS = 1e-6;

export interface BaseSpec { kind: BaseKind; mat?: 'Paper' | 'Stone' | 'Wood' }

/** 哪些机关需要专属路面 */
export function baseOf(type: string): BaseSpec | null {
  const t = /^P_Trafo_(Paper|Stone|Wood)$/.exec(type);
  if (t) return { kind: 'trafo', mat: t[1] as BaseSpec['mat'] };
  if (type === 'P_Modul_18') return { kind: 'fan' };
  if (type === 'P_Modul_01') return { kind: 'fence' };
  return null;
}

/** 机关的朝向（取最接近的 90°） */
const objDir = (o: Obj): Dir => ((Math.round(o.rot / 90) % 4 + 4) % 4) as Dir;

/** 对准方块（脚下那一格）中心的世界坐标 */
export function anchorWorld(o: Obj): [number, number] {
  const a = objType(o.type)?.anchor ?? [0, 0, 0];
  const r = (o.rot * Math.PI) / 180;
  return [o.x + a[0] * Math.cos(r) - a[1] * Math.sin(r), o.y + a[0] * Math.sin(r) + a[1] * Math.cos(r)];
}

/** 给机关铺上专属路面：脚下是直道就挖出一段，是普通路块就直接换掉。成功返回节点 id */
export function placeBase(m: Model, objId: number): number | null {
  const o = m.objs[objId];
  const spec = o && baseOf(o.type);
  if (!o || !spec || o.base !== undefined) return null;
  const [ax, ay] = anchorWorld(o);
  const floorZ = o.z + (objType(o.type)?.anchor?.[2] ?? 0);
  const d = objDir(o);
  // 栅栏：节点中心在两格的中间（从对准的那一格往栅栏方向再走 2.5）
  const half = spec.kind === 'fence' ? BLOCK : HALF;
  const cx = spec.kind === 'fence' ? ax + DX[d] * HALF : ax, cy = spec.kind === 'fence' ? ay + DY[d] * HALF : ay;
  const props = { kind: 'base' as const, baseKind: spec.kind, baseMat: spec.mat, style: 'normal' as const, obj: objId, rot: d };
  // 普通路块（变球器、风扇）
  if (spec.kind !== 'fence') {
    for (const n of Object.values(m.nodes)) {
      if (n.kind !== 'block' || Math.abs(n.x - cx) > EPS || Math.abs(n.y - cy) > EPS || Math.abs(n.z - floorZ) > 0.01) continue;
      Object.assign(n, props);
      o.base = n.id;
      return n.id;
    }
  }
  // 直道：中心落在路中线上、高度一致；栅栏要顺着路
  for (const s of Object.values(m.segs)) {
    if (spec.kind === 'fence' && axisOf(s.dir) !== axisOf(d)) continue;
    const t = (cx - s.x) * DX[s.dir] + (cy - s.y) * DY[s.dir];
    const lat = (cx - s.x) * -DY[s.dir] + (cy - s.y) * DX[s.dir];
    if (Math.abs(lat) > EPS || t < -EPS || t > s.len + EPS) continue;
    const za = endZ(m, s, 'a');
    if (Math.abs(za - floorZ) > 0.01 || Math.abs(endZ(m, s, 'b') - za) > EPS) continue;
    // 不能越过两端：节点必须整个落在这段路上
    if (t < half - EPS && !isFree(s.a)) continue;
    if (t > s.len - half + EPS && !isFree(s.b)) continue;
    const n = insertNodeOnSeg(m, s.id, t, half, props);
    if (!n) continue;
    // 插入时可能被夹到直道范围内：位置有偏差就撤销
    if (Math.abs(n.x - cx) > EPS || Math.abs(n.y - cy) > EPS) { revertBase(m, n.id); continue; }
    o.base = n.id;
    return n.id;
  }
  return null;
}

/** 专属路面变回普通路面 */
export function revertBase(m: Model, nodeId: number) {
  const n = m.nodes[nodeId];
  if (!n || n.kind !== 'base') return;
  const o = n.obj !== undefined ? m.objs[n.obj] : undefined;
  if (o && o.base === nodeId) delete o.base;
  // 正好接着对穿的两段路：两段路各伸到中心、合成一整段（不留截面接头）
  const ports = nodePorts(m, nodeId);
  const links = ports.filter((p) => p).length;
  const through = ([0, 1] as Dir[]).find((d) => ports[d] && ports[opp(d)]);
  if (links === 2 && through !== undefined && (n.baseKind !== 'fence' || axisOf(n.rot!) === axisOf(through))) {
    const half = nodeHalf(n);
    for (const p of [ports[through]!, ports[opp(through)]!]) {
      const sg = m.segs[p.seg];
      if (p.key === 'a') { sg.x -= DX[sg.dir] * half; sg.y -= DY[sg.dir] * half; }
      sg.len += half;
    }
    const keep = { id: n.id, x: n.x, y: n.y, z: n.z };
    for (const k of Object.keys(n)) delete (n as unknown as Record<string, unknown>)[k];
    Object.assign(n, keep, { kind: 'joint', style: 'normal', axis: axisOf(through) });
    deleteElem(m, nodeId);
    return;
  }
  if (n.baseKind !== 'fence') {
    n.kind = 'block';
    delete n.baseKind; delete n.baseMat; delete n.obj; delete n.rot;
    return;
  }
  // 栅栏路面：换成一段 10 长的直道，两头原来接着的路照常接上
  const d = n.rot!;
  const id = m.nextId++;
  // （ports 已在上面取过）
  const pa = ports[opp(d)], pb = ports[d];
  m.segs[id] = {
    id, x: n.x - DX[d] * BLOCK, y: n.y - DY[d] * BLOCK, dir: d, len: 2 * BLOCK, style: 'normal',
    a: { node: null, z: n.z, style: 'closed' }, b: { node: null, z: n.z, style: 'closed' },
  };
  // 原来接在栅栏路面上的直道：通过接头接到新直道两端
  for (const [p, k] of [[pa, 'a'], [pb, 'b']] as const) {
    if (!p) continue;
    const j = m.nextId++;
    const [x, y] = endPos(m.segs[id], k as EndKey);
    m.nodes[j] = { id: j, kind: 'joint', x, y, z: n.z, style: 'normal', axis: axisOf(d) };
    m.segs[id][k as EndKey] = { node: j };
    m.segs[p.seg][p.key] = { node: j };
  }
  for (const l of nodeLinks(m, nodeId)) m.segs[l.seg][l.key] = { node: null, z: n.z, style: 'closed' };
  delete m.nodes[nodeId];
  if (m.root === nodeId) m.root = id;
}

/** 规范化：机关没了的专属路面变回普通路面；指向不存在节点的机关清掉引用 */
export function repairBases(m: Model): boolean {
  for (const n of Object.values(m.nodes)) {
    if (n.kind !== 'base') continue;
    const o = n.obj !== undefined ? m.objs[n.obj] : undefined;
    if (!o || o.base !== n.id) { revertBase(m, n.id); return true; }
  }
  for (const o of Object.values(m.objs)) {
    if (o.base !== undefined && m.nodes[o.base]?.kind !== 'base') { delete o.base; return true; }
  }
  return false;
}

// ---------------- 显示 / 导出 ----------------

/** 风扇底座的边框花纹：变体在资产本地坐标下有边框的方向 */
const FAN_VARIANTS: [string, Dir[]][] = [
  ['Ventilator_4Face', [0, 1, 2, 3]],
  ['Ventilator_3Edge', [0, 1, 2]],
  ['Ventilator_2Face_Opposite', [0, 2]],
  ['Ventilator_2Face_Adjacent', [0, 1]],
  ['Ventilator_1Edge', [0]],
  ['Ventilator_NoEdge_Border', []],
];

export function baseParts(m: Model, n: MNode): PrefabPart[] {
  const z = n.z - 2.5; // 资产原点在方块中心
  if (n.baseKind === 'trafo') return [{ name: `TrafoBase_${n.baseMat ?? 'Wood'}`, type: 'asset', pos: [n.x, n.y, z], rotZ: 0 }];
  if (n.baseKind === 'fence') {
    // Slider 的原点在第一格中心，本地 +Y 沿栅栏方向
    const d = n.rot!;
    return [{ name: 'Slider', type: 'asset', pos: [n.x - DX[d] * HALF, n.y - DY[d] * HALF, z], rotZ: d * 90 - 90 }];
  }
  // 风扇：没接路的边要有边框
  const ports = nodePorts(m, n.id);
  const closed = new Set(([0, 1, 2, 3] as Dir[]).filter((d) => !ports[d]));
  for (const [name, borders] of FAN_VARIANTS) {
    if (borders.length !== closed.size) continue;
    for (let k = 0; k < 4; k++) {
      if (borders.every((b) => closed.has(((b + k) % 4) as Dir))) return [{ name, type: 'asset', pos: [n.x, n.y, z], rotZ: k * 90 }];
    }
  }
  return [{ name: 'Ventilator_4Face', type: 'asset', pos: [n.x, n.y, z], rotZ: 0 }];
}
