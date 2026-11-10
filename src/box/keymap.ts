// 快捷键：每个动作可以有几个按键（最多 MAX_BINDS 个），都能在设置里改、加、去掉。第一个是主按键（界面上显示的那个）。
// 默认按键是 def 加 alias（Ctrl+D、Delete 这种）；默认的别名和别的动作的主按键撞了时让位。
// 按键写法：小写、修饰键在前，例如 "ctrl+shift+g"、"shift+d"、"x"；单独的修饰键是 "control"、"alt"、"shift"。

export interface KeyDef {
  id: string;
  label: string;
  group: string;
  def: string;
  /** 默认的其他按键 */
  alias?: string[];
  /** 只能是单个键（按住类、漫游）：允许单独的修饰键 */
  single?: boolean;
  /** 漫游的按键只在漫游时生效，不和编辑的按键冲突 */
  fly?: boolean;
  note?: string;
}

// 顺序和顶栏的工具按钮一样（数字键 1～6 从左到右）
const MODES: [string, string][] = [['move', '移动'], ['rotate', '旋转'], ['stretch', '拉伸'], ['slope', '坡面'], ['split', '切分'], ['pattern', '花纹']];
const HOLD_DEF: Record<string, string> = { move: 'g', stretch: 'control', slope: 'alt', rotate: 'r', split: 'k', pattern: 'p' };
const HOLD_NOTE: Record<string, string> = { move: '轻按是自由移动', rotate: '轻按是自由旋转；拖素材卡片时用来转向', split: '轻按是永久切换', pattern: '轻按是永久切换', stretch: '按着拖就是改尺寸', slope: '按着拖就是拉坡' };

export const KEY_DEFS: KeyDef[] = [
  { id: 'mode.select', label: '选择', group: '切换工具', def: 'q', note: 'Esc 固定也可以' },
  ...MODES.map(([m, n], i) => ({ id: `mode.${m}`, label: n, group: '切换工具', def: String(i + 1) })),
  { id: 'guard', label: '护栏', group: '切换工具', def: '7', alias: ['h'] },
  ...MODES.map(([m, n]) => ({ id: `hold.${m}`, label: n, group: '按住临时切换', def: HOLD_DEF[m], single: true, note: HOLD_NOTE[m] })),
  { id: 'dup', label: '复制', group: '编辑', def: 'shift+d', alias: ['ctrl+d'] },
  { id: 'delete', label: '删除', group: '编辑', def: 'x', alias: ['delete', 'backspace'] },
  { id: 'undo', label: '撤销', group: '编辑', def: 'ctrl+z' },
  { id: 'redo', label: '重做', group: '编辑', def: 'ctrl+y' },
  { id: 'selectAll', label: '全选', group: '编辑', def: 'ctrl+a' },
  { id: 'merge', label: '合并路面', group: '编辑', def: 'ctrl+j' },
  { id: 'group', label: '绑定', group: '编辑', def: 'ctrl+g' },
  { id: 'ungroup', label: '解除绑定', group: '编辑', def: 'ctrl+shift+g' },
  { id: 'vsnap', label: '顶点吸附', group: '编辑', def: 'v', single: true, note: '按住' },
  { id: 'split.dir', label: '切分换方向', group: '编辑', def: 'tab', note: '切分工具里' },
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

/** 每个动作最多几个按键 */
export const MAX_BINDS = 3;
const BY_ID = new Map(KEY_DEFS.map((d) => [d.id, d]));
const defaultsOf = (d: KeyDef) => [d.def, ...(d.alias ?? [])];
const same = (a: string[], b: string[]) => a.length === b.length && a.every((k, i) => k === b[i]);
/** 改过的动作 → 它现在的全部按键（没改过的不在里面；空数组是未设置） */
let overrides: Record<string, string[]> = {};
let editMap = new Map<string, string>();
let flyMap = new Map<string, string>();

function rebuild() {
  editMap = new Map();
  flyMap = new Map();
  // 先放第二个及以后的按键，主按键后放：别名和别的动作的主按键撞了，别名让位
  for (const d of KEY_DEFS) for (const k of bindsOf(d.id).slice(1)) (d.fly ? flyMap : editMap).set(k, d.id);
  for (const d of KEY_DEFS) { const k = keyOf(d.id); if (k) (d.fly ? flyMap : editMap).set(k, d.id); }
}
/** 设成这几个按键（去重、去空、最多 MAX_BINDS 个）；和默认一样就不存 */
function setBinds(id: string, list: string[]) {
  const l = [...new Set(list.filter(Boolean))].slice(0, MAX_BINDS);
  if (same(l, defaultsOf(BY_ID.get(id)!))) delete overrides[id]; else overrides[id] = l;
}
/** 同一范围（编辑 / 漫游）里别的动作上的这个按键拿掉，返回被拿掉按键的动作 */
function evict(id: string, combos: string[]): KeyDef[] {
  const self = BY_ID.get(id)!;
  const taken = KEY_DEFS.filter((d) => d.id !== id && !!d.fly === !!self.fly && bindsOf(d.id).some((k) => combos.includes(k)));
  for (const d of taken) setBinds(d.id, bindsOf(d.id).filter((k) => !combos.includes(k)));
  return taken;
}

/**
 * 载入用户改过的按键（只存和默认不同的）。不认识的动作丢掉。
 * 旧版每个动作只存一个主按键的字符串（'' 是未设置），别名那时是固定的：换成「主按键 + 默认别名」
 */
export function loadKeys(o: Record<string, string | string[]> | undefined) {
  overrides = {};
  for (const [id, v] of Object.entries(o ?? {})) {
    const d = BY_ID.get(id);
    if (!d) continue;
    setBinds(id, Array.isArray(v) ? v.filter((k) => typeof k === 'string') : [String(v), ...(d.alias ?? [])]);
  }
  rebuild();
}
export const savedKeys = (): Record<string, string[]> => Object.fromEntries(Object.entries(overrides).map(([id, l]) => [id, [...l]]));
export const keyDef = (id: string) => BY_ID.get(id)!;
/** 这个动作现在的全部按键，第一个是主按键 */
export const bindsOf = (id: string): string[] => overrides[id] ?? defaultsOf(BY_ID.get(id)!);
/** 主按键（未设置是 ''） */
export const keyOf = (id: string): string => bindsOf(id)[0] ?? '';
/** 这个键是不是这个动作的按键之一 */
export const hasKey = (id: string, name: string) => bindsOf(id).includes(name);
export const isDefaultKeys = (id: string) => !(id in overrides);

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
/** 按钮提示里用：前两个按键，「X / Delete」 */
export const keyTextAll = (id: string) => bindsOf(id).slice(0, 2).map((k) => tokens(k).join('+')).join(' / ') || '未设置';

/**
 * 改绑第 index 个按键（index 等于现有个数时是再加一个）。别的动作上的这个按键会被拿掉，返回那些动作
 * （它们可能还剩别的按键，也可能变成未设置）
 */
export function assignKey(id: string, combo: string, index = 0): KeyDef[] {
  if (index >= MAX_BINDS) return [];
  const taken = evict(id, [combo]);
  const list = bindsOf(id).map((k, i) => (k === combo && i !== index ? '' : k)); // 自己别处已经有这个键：挪过来
  list[Math.min(index, list.length)] = combo;
  setBinds(id, list);
  rebuild();
  return taken;
}
/** 去掉第 index 个按键 */
export function removeKey(id: string, index: number) {
  setBinds(id, bindsOf(id).filter((_, i) => i !== index));
  rebuild();
}
/** 这个动作恢复默认按键；默认按键这时在别的动作上的，从那边拿掉，返回那些动作 */
export function resetKey(id: string): KeyDef[] {
  delete overrides[id];
  const taken = evict(id, bindsOf(id));
  rebuild();
  return taken;
}
/** 直接设主按键，不管冲突（'' 是去掉主按键） */
export function setKey(id: string, combo: string) {
  const l = bindsOf(id);
  setBinds(id, [combo, ...l.slice(1)]);
  rebuild();
}
export function resetKeys() { overrides = {}; rebuild(); }
