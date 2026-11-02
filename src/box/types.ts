// 重构版的数据模型：地图由互相独立的 box（路面）、素材件和机关组成，元素之间不存任何连接关系。
// 连接、花纹、遮挡、机关的专属路块都由 solve.ts 按几何关系现算。坐标系与 Blender 一致：Z 轴向上。
import { objType } from '../model/objects';
import { PREFAB_PORT } from '../model/types';
import { type RailPiece, sampleRail } from '../model/rail';

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

export interface Box extends ElemBase {
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
export interface Piece extends ElemBase {
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
export interface Obj extends ElemBase {
  kind: 'obj';
  type: string;
  /** 物体原点 */
  x: number;
  y: number;
  z: number;
  rot: Dir;
  noStopper?: boolean;
  noBase?: boolean;
}

/** 钢轨：从起点 (x, y, z) 朝 heading（度）出发，由若干段（直线 / 圆弧 / 螺旋）首尾相接；z 是双轨最顶端的高度 */
export interface RailElem extends ElemBase {
  kind: 'rail';
  x: number;
  y: number;
  z: number;
  heading: number;
  pieces: RailPiece[];
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

export type Elem = Box | Piece | Obj | RailElem | GuardElem;

export interface Doc {
  elems: Record<number, Elem>;
  nextId: number;
}

export const emptyDoc = (): Doc => ({ elems: {}, nextId: 1 });

export const isSlope = (e: Elem): e is Box & { slope: { axis: 0 | 1; dz: number } } => e.kind === 'box' && !!e.slope && Math.abs(e.slope.dz) > 1e-9;

/** 素材件的尺寸：沿 rot 的长度 */
export const pieceLen = (p: Piece) => (p.type === 'transition' ? 5 : 2.5);

export type Rect = { x0: number; y0: number; x1: number; y1: number };

/** 机关的对准方块（世界坐标的矩形和顶面高度） */
export function anchorRects(o: Obj): (Rect & { top: number })[] {
  const t = objType(o.type);
  if (!t?.anchor) return [];
  const c = [1, 0, -1, 0][o.rot], s = [0, 1, 0, -1][o.rot];
  return [t.anchor, ...(t.more ?? [])].map((a) => {
    const sx = a[3] ?? 5, sy = a[4] ?? 5;
    const hx = (o.rot % 2 ? sy : sx) / 2, hy = (o.rot % 2 ? sx : sy) / 2;
    const x = o.x + a[0] * c - a[1] * s, y = o.y + a[0] * s + a[1] * c;
    return { x0: x - hx, y0: y - hy, x1: x + hx, y1: y + hy, top: o.z + a[2] };
  });
}

/** 元素在平面上的范围 */
export function footprint(e: Elem): Rect {
  if (e.kind === 'guard') return { x0: Math.min(...e.pts.map((p) => p[0])) - 0.5, y0: Math.min(...e.pts.map((p) => p[1])) - 0.5, x1: Math.max(...e.pts.map((p) => p[0])) + 0.5, y1: Math.max(...e.pts.map((p) => p[1])) + 0.5 };
  if (e.kind === 'rail') {
    const ps = sampleRail(e);
    const pad = 2.25; // 双轨半宽 + 轨道半径
    return { x0: Math.min(...ps.map((p) => p.x)) - pad, y0: Math.min(...ps.map((p) => p.y)) - pad, x1: Math.max(...ps.map((p) => p.x)) + pad, y1: Math.max(...ps.map((p) => p.y)) + pad };
  }
  if (e.kind === 'box') return { x0: e.x, y0: e.y, x1: e.x + e.sx, y1: e.y + e.sy };
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
    const a = e.type === 'start' ? -2.5 : -PREFAB_PORT.check, b = PREFAB_PORT[e.type];
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
export function virtualCells(e: Elem): (Rect & { top: number })[] {
  if (e.kind === 'obj') return anchorRects(e);
  if (e.kind !== 'piece' || (e.type !== 'start' && e.type !== 'check')) return [];
  const port = PREFAB_PORT[e.type];
  const cell = (d: Dir) => {
    const cx = e.x + DX[d] * (port - 2.5), cy = e.y + DY[d] * (port - 2.5);
    return { x0: cx - 2.5, y0: cy - 2.5, x1: cx + 2.5, y1: cy + 2.5, top: e.z };
  };
  return e.type === 'start' ? [cell(e.rot)] : [cell(e.rot), cell(opp(e.rot))];
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
  const spec = o.noBase ? null : baseSpec(o.type);
  const a = anchorRects(o)[0];
  if (!spec || !a) return null;
  return { id: o.id, kind: 'piece', type: 'base', x: (a.x0 + a.x1) / 2, y: (a.y0 + a.y1) / 2, z: a.top, rot: o.rot, base: spec };
}
