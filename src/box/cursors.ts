/**
 * 全站鼠标指针：SVG 现画成 data URI，和界面同一套配色（浅色填充、深色描边，深浅主题上都看得清）。
 * 界面元素的指针走 CSS 变量（--cur-*，样式表里写 var(--cur-pointer, pointer)，没装时退回系统指针）；
 * 3D 视图的工具指针是「底图 + 右下角的工具徽章」，徽章图标直接用顶栏按钮上的那个，颜色跟按钮一样：永久蓝、临时橙。
 * 尺寸固定 32×32：Chrome 对更大的指针在靠近窗口边缘时会退回系统指针。
 */

export type CursorBase = 'arrow' | 'hand' | 'open' | 'fist' | 'cross';

export const CURSOR_TINT = { accent: '#5b8def', temp: '#f08c2e', muted: '#6f7a90', danger: '#e5534b' };

const INK = '#1d2330';
const FILL = '#f4f7fc';

const solid = (d: string) => `<path d='${d}' fill='${FILL}' stroke='${INK}' stroke-width='1.5' stroke-linejoin='round' stroke-linecap='round'/>`;
/** 线状的形状：先画一遍粗的深色，再画细的浅色 */
const line = (d: string) => `<g fill='none' stroke-linecap='round' stroke-linejoin='round'><path d='${d}' stroke='${INK}' stroke-width='4'/><path d='${d}' stroke='${FILL}' stroke-width='1.7'/></g>`;

const SHAPE: Record<CursorBase, { body: string; hot: [number, number]; fallback: string }> = {
  arrow: { body: solid('M3 2.5V20l4.6-4.2 3 6.8 3-1.3-2.9-6.6h6.1Z'), hot: [3, 3], fallback: 'default' },
  hand: {
    body: solid('M10 2.5a1.8 1.8 0 0 1 1.8 1.8V11h.2a1.7 1.7 0 0 1 3.2.6 1.7 1.7 0 0 1 3 .9 1.6 1.6 0 0 1 2.8 1V18c0 3-2.2 5.5-5.5 5.5H13c-2 0-3.4-.8-4.6-2.3l-3.8-4.8a1.7 1.7 0 0 1 2.5-2.3l1.1 1.1V4.3A1.8 1.8 0 0 1 10 2.5Z'),
    hot: [10, 3], fallback: 'pointer',
  },
  open: {
    body: solid('M8 15V7.2a1.6 1.6 0 0 1 3.2 0V5.6a1.6 1.6 0 0 1 3.2 0V7a1.6 1.6 0 0 1 3.2 0v2a1.6 1.6 0 0 1 3.2 0v8c0 4-2.6 6.5-6.5 6.5h-1.2c-2.4 0-4-.9-5.4-2.7l-3.6-4.7a1.7 1.7 0 0 1 2.6-2.2Z'),
    hot: [13, 12], fallback: 'grab',
  },
  fist: {
    body: solid('M7.5 16v-3.3a1.5 1.5 0 0 1 3-.2v-.8a1.5 1.5 0 0 1 3 0v.3a1.5 1.5 0 0 1 3 0v.5a1.5 1.5 0 0 1 3 0V18c0 3.4-2.4 5.5-6 5.5h-1c-2.4 0-3.8-.9-5-2.4l-2.2-3a1.5 1.5 0 0 1 2.2-2Z'),
    hot: [13, 14], fallback: 'grabbing',
  },
  cross: { body: line('M11 2.5V8M11 14v5.5M2.5 11H8M14 11h5.5'), hot: [11, 11], fallback: 'crosshair' },
};

const toUrl = (body: string, hot: [number, number], fallback: string) =>
  `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' width='32' height='32' viewBox='0 0 32 32'>${body}</svg>`)}") ${hot[0]} ${hot[1]}, ${fallback}`;

const plain = (b: CursorBase) => toUrl(SHAPE[b].body, SHAPE[b].hot, SHAPE[b].fallback);
const EW = solid('M4 16l6-5.5V14h12v-3.5l6 5.5-6 5.5V18H10v3.5Z');

/** 右下角的圆徽章：glyph 是 16×16 的线条图标（顶栏按钮里的那些） */
const badge = (glyph: string, color: string) =>
  `<circle cx='22.6' cy='22.6' r='8.4' fill='${color}' stroke='${INK}' stroke-width='1.3'/>`
  + `<g transform='translate(16.2 16.2) scale(0.8)' fill='none' stroke='#fff' stroke-width='1.7' stroke-linecap='round' stroke-linejoin='round'>${glyph}</g>`;

const toolCache = new Map<string, string>();
/** 工具指针：底图 + 工具徽章。状态每帧都会算一遍，所以记下来不重复拼字符串 */
export function toolCursor(base: CursorBase, glyph: string, color: string): string {
  const key = `${base}|${color}|${glyph}`;
  let v = toolCache.get(key);
  if (!v) { v = toUrl(SHAPE[base].body + badge(glyph, color), SHAPE[base].hot, SHAPE[base].fallback); toolCache.set(key, v); }
  return v;
}

/** 系统指针名 → 自己画的指针；样式表里用 var(--cur-名字, 名字) 引用 */
export const UI_CURSOR = {
  default: plain('arrow'),
  pointer: plain('hand'),
  grab: plain('open'),
  grabbing: plain('fist'),
  crosshair: plain('cross'),
  text: toUrl(line('M12 6c2 0 3 1 4 2 1-1 2-2 4-2M16 8v16M12 26c2 0 3-1 4-2 1 1 2 2 4 2'), [16, 16], 'text'),
  'ew-resize': toUrl(EW, [16, 16], 'ew-resize'),
  'ns-resize': toUrl(`<g transform='rotate(90 16 16)'>${EW}</g>`, [16, 16], 'ns-resize'),
  'not-allowed': toUrl(SHAPE.arrow.body + badge("<path d='M3.5 12.5l9-9'/>", CURSOR_TINT.danger), SHAPE.arrow.hot, 'not-allowed'),
};

export function installCursors() {
  for (const [name, value] of Object.entries(UI_CURSOR)) document.documentElement.style.setProperty(`--cur-${name}`, value);
}
