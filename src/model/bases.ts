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
import { cutRange, uncutObj } from './gaps';
import type { Obj } from './objects';
import { objType } from './objects';
import {
  BLOCK, BaseKind, CELL, DX, DY, Dir, EndKey, HALF, MNode, Model, SINK_DEPTH, axisOf, endPos, endZ, isFree, nodeHalf, nodeLinks, nodePorts, opp,
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

/**
 * 给机关铺上专属路面，成功返回节点 id。节点放在机关对准的那一格（脚下那一格）上：
 *   脚下是普通路块就直接换掉；是直道就挖出这一格。
 *   栅栏路面还要往栅栏方向多占一格（栅栏被推过去的地方）：
 *   栅栏横在路上时，这一格伸到路外面；顺着路时，把那一侧的路再缩短一格。
 */
export function placeBase(m: Model, objId: number): number | null {
  const o = m.objs[objId];
  const spec = o && baseOf(o.type);
  if (!o || !spec || o.base !== undefined) return null;
  const [cx, cy] = anchorWorld(o);
  const floorZ = o.z + (objType(o.type)?.anchor?.[2] ?? 0);
  const d = objDir(o);
  const fence = spec.kind === 'fence';
  const props = { kind: 'base' as const, baseKind: spec.kind, baseMat: spec.mat, style: 'normal' as const, obj: objId, rot: d };
  // 凹槽路面 / 凹槽平台：底座嵌进凹槽里（顶面与下沉 0.7 的槽底齐平）
  if (!fence && embedSunk(m, objId, cx, cy, floorZ)) return o.base!;
  // 普通路块：直接换掉（栅栏的延伸那一侧不能接着路）
  for (const n of Object.values(m.nodes)) {
    if (n.kind !== 'block' || Math.abs(n.x - cx) > EPS || Math.abs(n.y - cy) > EPS || Math.abs(n.z - floorZ) > 0.01) continue;
    if (fence && nodePorts(m, n.id)[d]) return null;
    Object.assign(n, props);
    o.base = n.id;
    return n.id;
  }
  // 直道：这一格的中心落在路中线上、高度一致、不越过两端
  for (const s of Object.values(m.segs)) {
    const t = (cx - s.x) * DX[s.dir] + (cy - s.y) * DY[s.dir];
    const lat = (cx - s.x) * -DY[s.dir] + (cy - s.y) * DX[s.dir];
    if (Math.abs(lat) > EPS || t < -EPS || t > s.len + EPS) continue;
    const za = endZ(m, s, 'a');
    if (Math.abs(za - floorZ) > 0.01 || Math.abs(endZ(m, s, 'b') - za) > EPS) continue;
    if (t < HALF - EPS && !isFree(s.a)) continue;
    if (t > s.len - HALF + EPS && !isFree(s.b)) continue;
    // 栅栏顺着路：延伸那一侧的路要能再让出一格
    const along = fence && axisOf(s.dir) === axisOf(d);
    if (along) {
      const rest = d === s.dir ? s.len - t - HALF : t - HALF;
      const endFree = isFree(d === s.dir ? s.b : s.a);
      if (rest < 2 * HALF - EPS && !endFree) continue;
    }
    const n = insertNodeOnSeg(m, s.id, t, HALF, props);
    if (!n) continue;
    if (Math.abs(n.x - cx) > EPS || Math.abs(n.y - cy) > EPS) { revertBase(m, n.id); continue; }
    if (along) {
      // 延伸那一侧的直道往后缩一格，接到 7.5 远的路口上；不够长就去掉
      const p = nodePorts(m, n.id)[d];
      if (p) {
        const sg = m.segs[p.seg];
        if (sg.len <= 2 * HALF + EPS) { delete m.segs[sg.id]; }
        else {
          if (p.key === 'a') { sg.x += DX[sg.dir] * 2 * HALF; sg.y += DY[sg.dir] * 2 * HALF; }
          sg.len -= 2 * HALF;
        }
      }
    }
    o.base = n.id;
    return n.id;
  }
  return null;
}

/**
 * 凹槽直路上的风扇 / 变球器：底座顶面对准槽底，挖掉底座那一格（直路截断成开放端点），底座单独放在缺口里；
 * 平台（凹槽平台对准槽底，普通平台对准顶面）上：底座嵌在平台里，平台不画盖住的 4×4 小格。
 * 关掉格栅 / 自动对齐时底座不一定落在平台的小格上：就近挪到小格上（最多 0.625）。
 * 机关挪走或删掉时，路接回去，平台照常画。
 */
function embedSunk(m: Model, objId: number, cx: number, cy: number, floorZ: number): boolean {
  const lvl = (z: number) => Math.abs(z - SINK_DEPTH - floorZ) < 0.01;
  for (const s of Object.values(m.segs)) {
    if (s.style !== 'sink') continue;
    const za = endZ(m, s, 'a');
    if (!lvl(za) || Math.abs(endZ(m, s, 'b') - za) > EPS) continue;
    const ax = axisOf(s.dir);
    const t = (cx - s.x) * DX[s.dir] + (cy - s.y) * DY[s.dir];
    const lat = (cx - s.x) * -DY[s.dir] + (cy - s.y) * DX[s.dir];
    if (Math.abs(lat) > EPS || t < -EPS || t > s.len + EPS) continue;
    const c = ax === 0 ? cx : cy;
    if (!cutRange(m, objId, { axis: ax, lo: c - HALF, hi: c + HALF, z: floorZ, lats: [ax === 0 ? cy : cx] })) continue;
    const id = placeFreeBase(m, objId);
    if (id !== null) m.nodes[id].inRoad = ax;
    return id !== null;
  }
  for (const n of Object.values(m.nodes)) {
    if (n.kind !== 'platform' || !(n.style === 'sink' ? lvl(n.z) : Math.abs(n.z - floorZ) < 0.01)) continue;
    const cells: string[] = [];
    const i0 = Math.round((cx - HALF) / CELL), j0 = Math.round((cy - HALF) / CELL);
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) cells.push(`${i0 + i},${j0 + j}`);
    const own = new Set(n.cells ?? []);
    if (!cells.every((k) => own.has(k))) continue;
    // 对齐到小格
    const o = m.objs[objId];
    o.x += i0 * CELL + HALF - cx; o.y += j0 * CELL + HALF - cy;
    const id = placeFreeBase(m, objId);
    if (id === null) continue;
    m.nodes[id].hole = { cells };
    return true;
  }
  return false;
}

/** 不在路面上：在机关下面单独放一块专属底座（不接任何路） */
export function placeFreeBase(m: Model, objId: number): number | null {
  const o = m.objs[objId];
  const spec = o && baseOf(o.type);
  if (!o || !spec || o.base !== undefined) return null;
  const [cx, cy] = anchorWorld(o);
  const id = m.nextId++;
  m.nodes[id] = {
    id, kind: 'base', x: cx, y: cy, z: o.z + (objType(o.type)?.anchor?.[2] ?? 0), style: 'normal',
    baseKind: spec.kind, baseMat: spec.mat, obj: objId, rot: objDir(o), free: true,
  } as MNode;
  o.base = id;
  return id;
}

/** 专属路面变回普通路面 */
export function revertBase(m: Model, nodeId: number) {
  const n = m.nodes[nodeId];
  if (!n || n.kind !== 'base') return;
  const o = n.obj !== undefined ? m.objs[n.obj] : undefined;
  if (o && o.base === nodeId) delete o.base;
  // 单独的底座：没有替换过路面，直接去掉；嵌在凹槽里的把挖掉的路接回去、平台小格补回去
  if (n.free) {
    if (n.obj !== undefined) uncutObj(m, n.obj);
    delete m.nodes[nodeId];
    return;
  }
  if (n.baseKind === 'fence') {
    const pd = nodePorts(m, nodeId)[n.rot!];
    if (pd) {
      const sg = m.segs[pd.seg];
      if (pd.key === 'a') { sg.x -= DX[sg.dir] * 2 * HALF; sg.y -= DY[sg.dir] * 2 * HALF; }
      sg.len += 2 * HALF;
    }
    n.baseKind = 'trafo'; // 之后按普通 5×5 处理
  }
  // 正好接着对穿的两段路：两段路各伸到中心、合成一整段（不留截面接头）
  const ports = nodePorts(m, nodeId);
  const links = ports.filter((p) => p).length;
  const through = ([0, 1] as Dir[]).find((d) => ports[d] && ports[opp(d)]);
  if (links === 2 && through !== undefined) {
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
  n.kind = 'block';
  delete n.baseKind; delete n.baseMat; delete n.obj; delete n.rot;
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
    // Slider 的原点在第一格中心（就是节点位置），本地 +Y 沿栅栏方向
    return [{ name: 'Slider', type: 'asset', pos: [n.x, n.y, z], rotZ: n.rot! * 90 - 90 }];
  }
  // 嵌在凹槽里的风扇：平台里四边都没有边框；直路里只有两侧有边框（两头接着路）
  if (n.hole) return [{ name: 'Ventilator_NoEdge_Borderless', type: 'asset', pos: [n.x, n.y, z], rotZ: 0 }];
  if (n.inRoad !== undefined) return [{ name: 'Ventilator_2Face_Opposite', type: 'asset', pos: [n.x, n.y, z], rotZ: n.inRoad === 0 ? 90 : 0 }];
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
