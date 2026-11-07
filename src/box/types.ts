// 重构版的数据模型：地图由互相独立的 box（路面）、素材件和机关组成，元素之间不存任何连接关系。
// 连接、花纹、遮挡、机关的专属路块都由 solve.ts 按几何关系现算。坐标系与 Blender 一致：Z 轴向上。
import { objType } from '../model/objects';
/** 盘点路面的路口离中心多远：圆盘边沿（自带的延伸路裁掉了，见 solve.ts 的 CP_CROP） */
export const CP_PORT = { start: 7.386, check: 4.924 } as const;
import { type RailPiece, type SideRail, sampleRail } from '../model/rail';
import { assetInfo } from './asset-info';
import { type M3, type Quat, type V3, I3, apply, fromQuat, mul, rotZ } from './xform';

export type Dir = 0 | 1 | 2 | 3; // 0:+X 1:+Y 2:-X 3:-Y
export const DX = [1, 0, -1, 0] as const;
export const DY = [0, 1, 0, -1] as const;
export const opp = (d: Dir): Dir => ((d + 2) % 4) as Dir;

/** 路面样式：平路、凹路、细边框凹路 */
export type Style = 'normal' | 'sink' | 'ribbon';

export const SINK_DEPTH = 0.7;
/** 边框带宽：离外沿多远以内画边框花纹（凹路的下沉也在这个宽度内完成） */
export const BAND = 2.5;
/** 判定「贴在一起」「一样高」的容差 */
export const EPS_TOUCH = 0.005;

interface ElemBase {
  id: number;
  /** 绑定：同一个编号的元素在选择、移动时作为一个整体 */
  group?: number;
}

/**
 * 可以任意转向的元素：ang 是朝向坐标系绕 Z 的角度 [0, 90)，元素的坐标（x、y、rot、矩形）都在这个坐标系里；
 * q 是倾斜（绕 X / Y 转过）后的朝向，绕元素的中心（路面、死亡区）或原点（机关、特殊路面）转；有 q 时 ang 为 0。
 * 世界坐标 = Rz(ang)·(c + Q·(p − c))。
 */
interface Oriented {
  ang?: number;
  q?: Quat;
}

export interface Box extends ElemBase, Oriented {
  kind: 'box';
  /** 最小角（x、y 最小的那个角） */
  x: number;
  y: number;
  /** 顶面高度（倾斜时是坐标较小那一端的高度） */
  z: number;
  sx: number;
  sy: number;
  /** 厚度（竖直方向） */
  depth: number;
  style: Style;
  /** 沿 axis 方向倾斜：坐标较大那一端比较小那一端高 dz（可为负）；只有两个端面能和别的路相连 */
  slope?: { axis: 0 | 1; dz: number };
  /** 开口的侧面（位掩码，1<<Dir）：这一侧不画边框，端面露出凹槽截面（例如路接机关的断口） */
  open?: number;
  /** 封口的侧面（位掩码）：这一侧一定画边框，就算贴着别的路面也不连成一片（优先于自动解算） */
  closed?: number;
}

/**
 * transition：平凹转换（长 5）；transition-narrow：窄转换（长 2.5，平路一侧也下沉，接细边框平台）；
 * transition-half：半宽平凹转换（长 2.5，凹路接平路平台）；ramp：半块下沉坡（长 2.5，平路接凹槽 / 细边框平台）；
 * base：机关的专属路块。transition-half、ramp 由求解器自动生成，嵌在平台的边框带里。
 * start：起点（四火）；check：小节盘点（两火）。盘点路面是资产库模型，路口在 rot 一侧（小节盘点两侧都有）。
 */
export type PieceType = 'transition' | 'transition-narrow' | 'transition-half' | 'ramp' | 'base' | 'start' | 'check';
export type BaseKind = 'trafo' | 'fan' | 'fence';

/** 素材件：形状固定，只能平移和按 90° 旋转 */
export interface Piece extends ElemBase, Oriented {
  kind: 'piece';
  type: PieceType;
  /** 中心（专属路块：机关对准的那一格的中心） */
  x: number;
  y: number;
  /** 顶面高度 */
  z: number;
  /** 平凹转换：从凹槽一端指向平路一端的方向；栅栏路面：栅栏被推过去的方向 */
  rot: Dir;
  /** 专属路块（由机关生成，不存进文档） */
  base?: { kind: BaseKind; mat?: 'Paper' | 'Stone' | 'Wood' };
  /** ramp：嵌进去的平台的样式（凹路或细边框凹路） */
  inner?: Style;
  /** 小节盘点：激活第几小节（≥2）；不填则按放置顺序自动编号 */
  sector?: number;
  /** 起点 / 小节盘点：重生时球朝向的角度（度，45° 的倍数，0 = +X）；不填则和路口方向一致 */
  spawn?: number;
}

/** 机关 / 装饰：BBP 占位符或资产库模型；需要专属路块和挡块的机关自动带上 */
export interface Obj extends ElemBase, Oriented {
  kind: 'obj';
  type: string;
  /** 物体原点 */
  x: number;
  y: number;
  z: number;
  rot: Dir;
  noStopper?: boolean;
  noBase?: boolean;
  /** 机关属于第几小节（放的时候取顶栏选的小节） */
  sector?: number;
}

/** 钢轨：从起点 (x, y, z) 朝 heading（度）出发，由若干段（直线 / 圆弧 / 螺旋）首尾相接；z 是双轨最顶端的高度 */
export interface RailElem extends ElemBase {
  kind: 'rail';
  x: number;
  y: number;
  z: number;
  heading: number;
  pieces: RailPiece[];
  /** 侧轨（一段直的双轨斜过来） */
  side?: SideRail;
  /** 螺旋侧轨：单轨螺旋，层间距固定 3.6 */
  sideSpiral?: boolean;
}

/**
 * 护栏：和上一版一样沿路面外沿走（拐角圆弧过渡、顺着坡走、两头立柱 + 铆钉），
 * 但放下时就把走过的路径存下来（pts：外沿上的点，顶面高度；outs：每一段朝外的方向），
 * 之后是一个独立的物体，可以移动 / 删除，不会因为路面改动而自己改道。
 */
export interface GuardElem extends ElemBase {
  kind: 'guard';
  pts: [number, number, number][];
  outs: [number, number][];
  /** 参考点（= 起点），整体平移用 */
  x: number;
  y: number;
  z: number;
}

/** 特殊路面：资产库里形状固定的模型（木制路面、特殊路块、钢轨交叉），按资产原点摆放，只能按 90° 旋转 */
export interface AssetElem extends ElemBase, Oriented {
  kind: 'asset';
  name: string;
  x: number;
  y: number;
  z: number;
  rot: Dir;
  /** 沿模型本地 X、Y 的缩放（Ctrl 拉伸木制件） */
  scale?: [number, number];
}

/** 死亡区：半透明的长方体，球碰到它的包围盒就死；导出时隐藏，归到 DepthTestCubes 组 */
export interface ZoneElem extends ElemBase, Oriented {
  kind: 'zone';
  /** 最小角与顶面高度，和路面一样 */
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  depth: number;
}

export type Elem = Box | Piece | Obj | RailElem | GuardElem | AssetElem | ZoneElem;
export type OrientedElem = Box | Piece | Obj | AssetElem | ZoneElem;
export const isOriented = (e: Elem): e is OrientedElem => e.kind === 'box' || e.kind === 'piece' || e.kind === 'obj' || e.kind === 'asset' || e.kind === 'zone';
/** 绕 X / Y 转过（倾斜）的元素：不参与路面求解 */
export const isTilted = (e: Elem) => isOriented(e) && !!e.q;
/** 能绕 X / Y 转的元素 */
export const canTilt = (e: Elem) => e.kind === 'box' || e.kind === 'obj' || e.kind === 'asset' || e.kind === 'zone';

/** 特殊路面的包围盒（世界坐标）：本地包围盒按朝向转过去 */
export function assetBounds(e: AssetElem): Rect & { z0: number; z1: number } {
  const inf = assetInfo(e.name);
  const [ks, kt] = e.scale ?? [1, 1];
  const mn0 = inf?.min ?? [-2.5, -2.5, -2.5], mx0 = inf?.max ?? [2.5, 2.5, 2.5];
  const mn = [mn0[0] * ks, mn0[1] * kt, mn0[2]], mx = [mx0[0] * ks, mx0[1] * kt, mx0[2]];
  const c = [1, 0, -1, 0][e.rot], s = [0, 1, 0, -1][e.rot];
  const xs: number[] = [], ys: number[] = [];
  for (const x of [mn[0], mx[0]]) for (const y of [mn[1], mx[1]]) { xs.push(e.x + x * c - y * s); ys.push(e.y + x * s + y * c); }
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys), z0: e.z + mn[2], z1: e.z + mx[2] };
}

export interface Doc {
  elems: Record<number, Elem>;
  nextId: number;
  /** 地图名字：显示在历史里，也是导出 NMO 的文件名 */
  name?: string;
  /** 全图设置（护栏尺寸等）：只存改过的项，其余用默认值 */
  settings?: Partial<import('../model/types').MapSettings>;
}

export const emptyDoc = (): Doc => ({ elems: {}, nextId: 1 });

export const isSlope = (e: Elem): e is Box & { slope: { axis: 0 | 1; dz: number } } => e.kind === 'box' && !!e.slope && Math.abs(e.slope.dz) > 1e-9;

/** 素材件的尺寸：沿 rot 的长度 */
export const pieceLen = (p: Piece) => (p.type === 'transition' ? 5 : 2.5);

export type Rect = { x0: number; y0: number; x1: number; y1: number };

/** 机关的对准方块（朝向坐标系里的矩形、顶面高度和厚度） */
export function anchorRects(o: Obj): (Rect & { top: number; depth: number })[] {
  const t = objType(o.type);
  if (!t?.anchor) return [];
  const c = [1, 0, -1, 0][o.rot], s = [0, 1, 0, -1][o.rot];
  return [t.anchor, ...(t.more ?? [])].map((a) => {
    const sx = a[3] ?? 5, sy = a[4] ?? 5;
    const hx = (o.rot % 2 ? sy : sx) / 2, hy = (o.rot % 2 ? sx : sy) / 2;
    const x = o.x + a[0] * c - a[1] * s, y = o.y + a[0] * s + a[1] * c;
    return { x0: x - hx, y0: y - hy, x1: x + hx, y1: y + hy, top: o.z + a[2], depth: a[5] ?? 5 };
  });
}

/** 元素在平面上的范围（朝向坐标系里；钢轨、护栏是世界坐标） */
export function footprint(e: Elem): Rect {
  if (e.kind === 'asset') { const b = assetBounds(e); return { x0: b.x0, y0: b.y0, x1: b.x1, y1: b.y1 }; }
  if (e.kind === 'guard') return { x0: Math.min(...e.pts.map((p) => p[0])) - 0.5, y0: Math.min(...e.pts.map((p) => p[1])) - 0.5, x1: Math.max(...e.pts.map((p) => p[0])) + 0.5, y1: Math.max(...e.pts.map((p) => p[1])) + 0.5 };
  if (e.kind === 'rail') {
    const ps = sampleRail(e);
    const pad = 2.25; // 双轨半宽 + 轨道半径
    return { x0: Math.min(...ps.map((p) => p.x)) - pad, y0: Math.min(...ps.map((p) => p.y)) - pad, x1: Math.max(...ps.map((p) => p.x)) + pad, y1: Math.max(...ps.map((p) => p.y)) + pad };
  }
  if (e.kind === 'box' || e.kind === 'zone') return { x0: e.x, y0: e.y, x1: e.x + e.sx, y1: e.y + e.sy };
  if (e.kind === 'obj') {
    const rs = anchorRects(e);
    if (!rs.length) return { x0: e.x - 1, y0: e.y - 1, x1: e.x + 1, y1: e.y + 1 };
    return { x0: Math.min(...rs.map((r) => r.x0)), y0: Math.min(...rs.map((r) => r.y0)), x1: Math.max(...rs.map((r) => r.x1)), y1: Math.max(...rs.map((r) => r.y1)) };
  }
  if (e.base) {
    const r = { x0: e.x - 2.5, y0: e.y - 2.5, x1: e.x + 2.5, y1: e.y + 2.5 };
    if (e.base.kind === 'fence') {
      if (e.rot === 0) r.x1 += 5; else if (e.rot === 2) r.x0 -= 5; else if (e.rot === 1) r.y1 += 5; else r.y0 -= 5;
    }
    return r;
  }
  if (e.type === 'start' || e.type === 'check') {
    // 盘点路面：沿路口方向的一条 5 宽的带子，末端就是路口（起点只有 rot 一侧，后面是圆盘）
    const a = e.type === 'start' ? -2.5 : -CP_PORT.check, b = CP_PORT[e.type];
    const [lo, hi] = e.rot === 0 || e.rot === 1 ? [a, b] : [-b, -a];
    return e.rot % 2 === 0 ? { x0: e.x + lo, y0: e.y - 2.5, x1: e.x + hi, y1: e.y + 2.5 } : { x0: e.x - 2.5, y0: e.y + lo, x1: e.x + 2.5, y1: e.y + hi };
  }
  const l = pieceLen(e) / 2, w = 2.5;
  const hx = e.rot % 2 === 0 ? l : w, hy = e.rot % 2 === 0 ? w : l;
  return { x0: e.x - hx, y0: e.y - hy, x1: e.x + hx, y1: e.y + hy };
}

/**
 * 虚拟路面（虚线方块）：机关的对准方块、盘点路口的那一格（5×5，顶面就是路面，往下 5）。
 * 悬停 / 选中时画出来，按住 V 时也能吸到它们的顶点，方便把路接上去。
 */
export function virtualCells(e: Elem): (Rect & { top: number; depth?: number })[] {
  // 盘点的路口就在圆盘边上（延伸路裁掉了）：不再要虚拟路面，吸附点就是路口那条边的顶点和中点
  return e.kind === 'obj' ? anchorRects(e) : [];
}

export const isCheckpoint = (e: Elem): boolean => e.kind === 'piece' && (e.type === 'start' || e.type === 'check');

/** box 在 (x, y) 处的顶面高度（未下沉） */
export function boxTopAt(b: Box, x: number, y: number): number {
  if (!b.slope) return b.z;
  const len = b.slope.axis === 0 ? b.sx : b.sy;
  const t = b.slope.axis === 0 ? x - b.x : y - b.y;
  return b.z + (b.slope.dz * t) / len;
}

/**
 * 素材件每个面的接法：
 *   port：接口，只和指定样式的 box 相连；
 *   embed：嵌入面，和指定样式的 box 贴着时算作一体（窄转换嵌在细边框平台的边框带里）；
 *   wall：不和任何东西相连。
 */
export type FaceKind = { t: 'port'; style: Style } | { t: 'embed'; style: Style } | { t: 'wall' };

export function pieceFace(p: Piece, d: Dir): FaceKind {
  if (p.type === 'start') return d === p.rot ? { t: 'port', style: 'normal' } : { t: 'wall' };
  if (p.type === 'check') return d === p.rot || d === opp(p.rot) ? { t: 'port', style: 'normal' } : { t: 'wall' };
  if (p.base) {
    if (p.base.kind === 'fence') return d === p.rot || d === opp(p.rot) ? { t: 'port', style: 'normal' } : { t: 'wall' };
    return { t: 'port', style: 'normal' };
  }
  // rot 一侧是嵌进平台的那一端，对面接路
  const [outer, inner]: [Style, Style] = pieceStyles(p) as [Style, Style];
  if (d === p.rot) return { t: 'port', style: inner };
  if (d === opp(p.rot)) return { t: 'port', style: outer };
  return p.type === 'transition' ? { t: 'wall' } : { t: 'embed', style: inner };
}

/** 素材件两端的样式：[接路的一端（rot 的对面）, rot 那一端] */
export const pieceStyles = (p: Piece): Style[] => (p.base || p.type === 'start' || p.type === 'check' ? ['normal', 'normal']
  : p.type === 'transition-narrow' ? ['sink', 'ribbon']
  : p.type === 'ramp' ? ['normal', p.inner ?? 'sink']
  : ['sink', 'normal']);

/** 需要专属路块的机关 */
export function baseSpec(type: string): Piece['base'] | null {
  const t = /^P_Trafo_(Paper|Stone|Wood)$/.exec(type);
  if (t) return { kind: 'trafo', mat: t[1] as 'Paper' | 'Stone' | 'Wood' };
  if (type === 'P_Modul_18') return { kind: 'fan' };
  if (type === 'P_Modul_01') return { kind: 'fence' };
  return null;
}

/** 机关的专属路块：放在对准方块那一格，顶面与对准方块顶面齐平 */
export function basePiece(o: Obj): Piece | null {
  const spec = o.noBase || o.q ? null : baseSpec(o.type);
  const a = anchorRects(o)[0];
  if (!spec || !a) return null;
  return { id: o.id, kind: 'piece', type: 'base', x: (a.x0 + a.x1) / 2, y: (a.y0 + a.y1) / 2, z: a.top, rot: o.rot, base: spec, ang: o.ang };
}

/** 元素在自己坐标里的包围盒（朝向坐标系，倾斜前） */
export function localBounds(e: OrientedElem): { x0: number; y0: number; z0: number; x1: number; y1: number; z1: number } {
  const f = footprint(e);
  if (e.kind === 'box') {
    const tops = [boxTopAt(e, f.x0, f.y0), boxTopAt(e, f.x1, f.y1)];
    return { ...f, z0: Math.min(...tops) - e.depth, z1: Math.max(...tops) };
  }
  if (e.kind === 'zone') return { ...f, z0: e.z - e.depth, z1: e.z };
  if (e.kind === 'piece') return { ...f, z0: e.z - 5, z1: e.z };
  if (e.kind === 'asset') return assetBounds(e);
  const t = objType(e.type);
  const rs = anchorRects(e);
  if (!rs.length) return { ...f, z0: e.z - 0.5, z1: e.z };
  // 每个对准方块：写了厚度的（灯塔塔底、升降机的薄平台）按它的厚度，没写的按一层薄片；包围盒从最低的到最高的
  const anchors = [t!.anchor!, ...(t!.more ?? [])];
  const z0 = Math.min(...rs.map((r, i) => r.top - (anchors[i][5] !== undefined ? r.depth : 0.5)));
  return { ...f, z0, z1: Math.max(...rs.map((r) => r.top)) };
}

/** 倾斜的转轴：路面、死亡区绕自己的中心，机关、特殊路面绕原点 */
export function pivotOf(e: OrientedElem): V3 {
  if (e.kind === 'box' || e.kind === 'zone') { const b = localBounds(e); return [(b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2]; }
  return [e.x, e.y, e.z];
}

/** 元素坐标 → 世界坐标的变换：world = m·p + t */
export function elemXf(e: Elem): { m: M3; t: V3 } {
  if (!isOriented(e) || (!e.ang && !e.q)) return { m: I3, t: [0, 0, 0] };
  const R = e.ang ? rotZ(e.ang) : I3;
  if (!e.q) return { m: R, t: [0, 0, 0] };
  const Q = fromQuat(e.q), c = pivotOf(e), qc = apply(Q, c);
  return { m: mul(R, Q), t: apply(R, [c[0] - qc[0], c[1] - qc[1], c[2] - qc[2]]) };
}
export function toWorld(e: Elem, p: V3): V3 {
  if (!isOriented(e) || (!e.ang && !e.q)) return p;
  const { m, t } = elemXf(e), w = apply(m, p);
  return [w[0] + t[0], w[1] + t[1], w[2] + t[2]];
}
/** 世界坐标 → 元素坐标 */
export function toLocal(e: Elem, p: V3): V3 {
  if (!isOriented(e) || (!e.ang && !e.q)) return p;
  const { m, t } = elemXf(e);
  const v: V3 = [p[0] - t[0], p[1] - t[1], p[2] - t[2]];
  return [m[0] * v[0] + m[3] * v[1] + m[6] * v[2], m[1] * v[0] + m[4] * v[1] + m[7] * v[2], m[2] * v[0] + m[5] * v[1] + m[8] * v[2]];
}
/** 世界里的方向 → 元素坐标里的方向 */
export function dirToLocal(e: Elem, d: V3): V3 {
  if (!isOriented(e) || (!e.ang && !e.q)) return d;
  const { m } = elemXf(e);
  return [m[0] * d[0] + m[3] * d[1] + m[6] * d[2], m[1] * d[0] + m[4] * d[1] + m[7] * d[2], m[2] * d[0] + m[5] * d[1] + m[8] * d[2]];
}
/** 绕 Z 的总朝向（度）：机关、素材件是 ang + rot·90 */
export const yawDeg = (e: Piece | Obj | AssetElem) => (e.ang ?? 0) + e.rot * 90;
