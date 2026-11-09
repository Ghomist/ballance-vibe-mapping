// 快捷键：每个动作一个主按键（可以在设置里改），别名（Ctrl+D、Delete 这种）固定，被别的动作占用时让位。
// 按键写法：小写、修饰键在前，例如 "ctrl+shift+g"、"shift+d"、"x"；单独的修饰键是 "control"、"alt"、"shift"。

export interface KeyDef {
  id: string;
  label: string;
  group: string;
  def: string;
  /** 固定的其他按键 */
  alias?: string[];
  /** 只能是单个键（按住类、漫游）：允许单独的修饰键 */
  single?: boolean;
  /** 漫游的按键只在漫游时生效，不和编辑的按键冲突 */
  fly?: boolean;
  note?: string;
}

const MODES: [string, string][] = [['move', '移动'], ['stretch', '拉伸'], ['slope', '坡面'], ['rotate', '旋转'], ['split', '切分'], ['pattern', '花纹']];
const HOLD_DEF: Record<string, string> = { move: 'g', stretch: 'control', slope: 'alt', rotate: 'r', split: 'k', pattern: 'p' };
const HOLD_NOTE: Record<string, string> = { move: '轻按是自由移动', rotate: '轻按是自由旋转；拖素材卡片时用来转向', split: '轻按是永久切换', pattern: '轻按是永久切换', stretch: '按着拖就是改尺寸', slope: '按着拖就是拉坡' };

export const KEY_DEFS: KeyDef[] = [
  ...MODES.map(([m, n], i) => ({ id: `mode.${m}`, label: n, group: '切换编辑模式', def: String(i + 1) })),
  ...MODES.map(([m, n]) => ({ id: `hold.${m}`, label: n, group: '按住临时切换', def: HOLD_DEF[m], single: true, note: HOLD_NOTE[m] })),
  { id: 'guard', label: '护栏工具', group: '编辑', def: 'h' },
  { id: 'dup', label: '复制', group: '编辑', def: 'shift+d', alias: ['ctrl+d'] },
  { id: 'delete', label: '删除', group: '编辑', def: 'x', alias: ['delete', 'backspace'] },
  { id: 'undo', label: '撤销', group: '编辑', def: 'ctrl+z' },
  { id: 'redo', label: '重做', group: '编辑', def: 'ctrl+y' },
  { id: 'selectAll', label: '全选', group: '编辑', def: 'ctrl+a' },
  { id: 'merge', label: '合并路面', group: '编辑', def: 'ctrl+j' },
  { id: 'group', label: '绑定', group: '编辑', def: 'ctrl+g' },
  { id: 'ungroup', label: '解除绑定', group: '编辑', def: 'ctrl+shift+g' },
  { id: 'vsnap', label: '顶点吸附', group: '编辑', def: 'v', single: true, note: '按住' },
  { id: 'split.dir', label: '切分换方向', group: '编辑', def: 'tab', note: '切分模式里' },
  { id: 'focus', label: '聚焦 / 看全部', group: '视图和开关', def: 'f' },
  { id: 'align', label: '自动对齐开关', group: '视图和开关', def: 's' },
  { id: 'grid', label: '格栅开关', group: '视图和开关', def: 'shift+tab' },
  { id: 'save', label: '保存到历史', group: '文件', def: 'ctrl+s' },
  { id: 'history', label: '打开历史', group: '文件', def: 'ctrl+o' },
  { id: 'fly.forward', label: '前进', group: '漫游', def: 'w', single: true, fly: true },
  { id: 'fly.back', label: '后退', group: '漫游', def: 's', single: true, fly: true },
  { id: 'fly.left', label: '左移', group: '漫游', def: 'a', single: true, fly: true },
  { id: 'fly.right', label: '右移', group: '漫游', def: 'd', single: true, fly: true },
  { id: 'fly.up', label: '上升', group: '漫游', def: 'space', alias: ['e'], single: true, fly: true },
  { id: 'fly.down', label: '下降', group: '漫游', def: 'shift', alias: ['q'], single: true, fly: true },
];

const BY_ID = new Map(KEY_DEFS.map((d) => [d.id, d]));
let overrides: Record<string, string> = {};
let editMap = new Map<string, string>();
let flyMap = new Map<string, string>();

function rebuild() {
  editMap = new Map();
  flyMap = new Map();
  // 先放别名，主按键后放：别名和别的动作的主按键撞了，别名让位
  for (const d of KEY_DEFS) for (const a of d.alias ?? []) (d.fly ? flyMap : editMap).set(a, d.id);
  for (const d of KEY_DEFS) { const k = keyOf(d.id); if (k) (d.fly ? flyMap : editMap).set(k, d.id); }
}

/** 载入用户改过的按键（只存和默认不同的；'' 表示未设置）。不认识的动作丢掉 */
export function loadKeys(o: Record<string, string> | undefined) {
  overrides = Object.fromEntries(Object.entries(o ?? {}).filter(([id]) => BY_ID.has(id)));
  rebuild();
}
export const savedKeys = () => ({ ...overrides });
export const keyDef = (id: string) => BY_ID.get(id)!;
export const keyOf = (id: string): string => overrides[id] ?? BY_ID.get(id)!.def;

/** 键盘事件的按键名：数字键不受 Shift 影响，空格写成 space */
export function keyName(e: { key: string; code?: string }): string {
  if (/^Digit\d$/.test(e.code ?? '')) return e.code!.slice(5);
  const k = e.key.toLowerCase();
  return k === ' ' ? 'space' : k;
}
const BARE = new Set(['control', 'alt', 'shift', 'meta']);
export const isBareModifier = (name: string) => BARE.has(name);

/** 键盘事件 → 按键写法 */
export function comboOf(e: { key: string; code?: string; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; metaKey: boolean }): string {
  const k = keyName(e);
  if (BARE.has(k)) return k;
  return `${e.ctrlKey ? 'ctrl+' : ''}${e.altKey ? 'alt+' : ''}${e.shiftKey ? 'shift+' : ''}${e.metaKey ? 'meta+' : ''}${k}`;
}

export const actionFor = (combo: string): string | null => editMap.get(combo) ?? null;
export const flyActionFor = (name: string): string | null => flyMap.get(name) ?? null;
/** 这个键是按住临时切换哪个模式 */
export function holdModeOf(name: string): string | null {
  const a = editMap.get(name);
  return a?.startsWith('hold.') ? a.slice(5) : null;
}

const NAMES: Record<string, string> = {
  ctrl: 'Ctrl', control: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta', space: 'Space', tab: 'Tab', enter: 'Enter', escape: 'Esc',
  delete: 'Delete', backspace: 'Backspace', arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→', pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', insert: 'Insert',
};
/** 按键写法 → 显示用的几个键帽 */
export function tokens(combo: string): string[] {
  if (!combo) return [];
  const out: string[] = [];
  let rest = combo;
  for (let m = /^(ctrl|alt|shift|meta)\+(?=.)/.exec(rest); m; m = /^(ctrl|alt|shift|meta)\+(?=.)/.exec(rest)) { out.push(NAMES[m[1]]); rest = rest.slice(m[0].length); }
  out.push(NAMES[rest] ?? (rest.length === 1 ? rest.toUpperCase() : rest[0].toUpperCase() + rest.slice(1)));
  return out;
}
export const keysOf = (id: string) => tokens(keyOf(id));
export const keyText = (id: string) => keysOf(id).join('+') || '未设置';

/** 改绑：占用这个按键的其他动作（同一范围里的）变成未设置，返回它们 */
export function assignKey(id: string, combo: string): KeyDef[] {
  const self = BY_ID.get(id)!;
  const taken = KEY_DEFS.filter((d) => d.id !== id && !!d.fly === !!self.fly && keyOf(d.id) === combo);
  for (const d of taken) overrides[d.id] = '';
  setKey(id, combo);
  return taken;
}
/** 设成指定按键（等于默认时不存），'' 是清除 */
export function setKey(id: string, combo: string) {
  if (combo === BY_ID.get(id)!.def) delete overrides[id]; else overrides[id] = combo;
  rebuild();
}
export function resetKeys() { overrides = {}; rebuild(); }
