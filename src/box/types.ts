// 重构版的数据模型：地图由互相独立的 box（路面）和素材件组成，元素之间不存任何连接关系。
// 连接、花纹、遮挡都由 solve.ts 按几何关系现算。坐标系与 Blender 一致：Z 轴向上。

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

export interface Box {
  id: number;
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

export type PieceType = 'transition' | 'transition-narrow';

/** 素材件：形状固定，只能平移和按 90° 旋转 */
export interface Piece {
  id: number;
  kind: 'piece';
  type: PieceType;
  /** 中心 */
  x: number;
  y: number;
  /** 顶面高度 */
  z: number;
  /** 平凹转换：从凹槽一端指向平路一端的方向 */
  rot: Dir;
}

export type Elem = Box | Piece;

export interface Doc {
  elems: Record<number, Elem>;
  nextId: number;
}

export const emptyDoc = (): Doc => ({ elems: {}, nextId: 1 });

export const isSlope = (e: Elem): e is Box & { slope: { axis: 0 | 1; dz: number } } => e.kind === 'box' && !!e.slope && Math.abs(e.slope.dz) > 1e-9;

/** 素材件的尺寸：沿 rot 的长度 */
export const pieceLen = (p: Piece) => (p.type === 'transition-narrow' ? 2.5 : 5);

/** 元素在平面上的范围 */
export function footprint(e: Elem): { x0: number; y0: number; x1: number; y1: number } {
  if (e.kind === 'box') return { x0: e.x, y0: e.y, x1: e.x + e.sx, y1: e.y + e.sy };
  const l = pieceLen(e) / 2, w = 2.5;
  const hx = e.rot % 2 === 0 ? l : w, hy = e.rot % 2 === 0 ? w : l;
  return { x0: e.x - hx, y0: e.y - hy, x1: e.x + hx, y1: e.y + hy };
}

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
  const narrow = p.type === 'transition-narrow';
  if (d === p.rot) return { t: 'port', style: narrow ? 'ribbon' : 'normal' };
  if (d === opp(p.rot)) return { t: 'port', style: 'sink' };
  return narrow ? { t: 'embed', style: 'ribbon' } : { t: 'wall' };
}

export const pieceStyles = (p: Piece): Style[] => (p.type === 'transition-narrow' ? ['sink', 'ribbon'] : ['sink', 'normal']);
