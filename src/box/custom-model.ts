// 导入的自定义模型（glTF / OBJ / FBX / NMO 转出来的三角形网格）：地图里是一个特殊路面元素（AssetElem），
// 名字是 `custom:<编号>`，网格数据放在这里的登记表里，不进素材库。编号由模型内容算出，同一个模型导入几次都是同一个。
//
// 坐标与资产库模型一致：Blender 坐标（Z 朝上），原点在模型底面的中心；UV 也按 Blender 的约定（左下角为原点）。
// 地图码、.bvm、蓝图、剪贴板都把用到的模型连同元素一起存（见 share.ts 的 models），打开时再登记回来。
// 这个文件不依赖 three，导出、测试在 Node 里也能用。

export interface CustomPart {
  pos: number[]; uv: number[]; nrm: number[];
  /** 漫反射颜色 0..1 */
  color: [number, number, number];
  /** 贴图：模型自带的是 textures 的下标；游戏自带的贴图（从 NMO 导入）是文件名 */
  tex?: number | string;
  alphaTest?: boolean; alphaBlend?: boolean; twoSided?: boolean;
}
export interface CustomModel {
  /** 名字（导入时的文件名，可以改） */
  label: string;
  parts: CustomPart[];
  /** 模型自带的贴图：dataURL（PNG / JPEG） */
  textures: string[];
  min: [number, number, number];
  max: [number, number, number];
}

export const CUSTOM_PREFIX = 'custom:';
export const isCustom = (name: string) => name.startsWith(CUSTOM_PREFIX);

const registry = new Map<string, CustomModel>();
const listeners: ((key: string) => void)[] = [];
/** 有模型新登记进来时回调（渲染缓存、素材库要刷新） */
export function onCustomModel(cb: (key: string) => void) { listeners.push(cb); }

/** 模型内容的编号（FNV-1a，两轮拼成 64 位，冲突概率可以忽略） */
function hashOf(m: CustomModel): string {
  const s = JSON.stringify({ p: m.parts, t: m.textures });
  let a = 0x811c9dc5, b = 0x01000193 ^ s.length;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x5bd1e995) ^ (b >>> 15);
  }
  return (a >>> 0).toString(36) + (b >>> 0).toString(36);
}

/** 检查一份模型数据像不像样（地图码里读出来的也要过一遍）；不像样抛错 */
export function validModel(m: unknown): CustomModel {
  const o = m as CustomModel;
  if (!o || typeof o !== 'object' || !Array.isArray(o.parts) || !Array.isArray(o.textures)) throw new Error('模型数据不完整');
  for (const p of o.parts) {
    if (!Array.isArray(p.pos) || !Array.isArray(p.uv) || !Array.isArray(p.nrm) || p.pos.length % 9 || p.uv.length * 3 !== p.pos.length * 2 || p.nrm.length !== p.pos.length) throw new Error('模型数据不完整');
  }
  return { label: String(o.label ?? '模型'), parts: o.parts, textures: o.textures, min: o.min, max: o.max };
}

/** 登记一个模型，返回它在地图里的名字（custom:编号） */
export function registerModel(m: CustomModel, key = hashOf(m)): string {
  if (!registry.has(key)) {
    registry.set(key, m);
    for (const f of listeners) f(key);
  }
  return CUSTOM_PREFIX + key;
}
export function registerModels(rec: Record<string, unknown> | undefined) {
  if (!rec) return;
  for (const [k, m] of Object.entries(rec)) { try { registerModel(validModel(m), k); } catch { /* 坏掉的模型跳过，元素会显示成占位盒子 */ } }
}
export const customModel = (name: string): CustomModel | undefined => (isCustom(name) ? registry.get(name.slice(CUSTOM_PREFIX.length)) : undefined);
export const customKey = (name: string) => name.slice(CUSTOM_PREFIX.length);

/** 这些元素用到的模型（存地图码、蓝图时带上） */
export function modelsUsed(elems: Iterable<{ kind: string; name?: string }>): Record<string, CustomModel> | undefined {
  const out: Record<string, CustomModel> = {};
  for (const e of elems) {
    if (e.kind !== 'asset' || !e.name || !isCustom(e.name)) continue;
    const m = customModel(e.name);
    if (m) out[customKey(e.name)] = m;
  }
  return Object.keys(out).length ? out : undefined;
}

const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;
/**
 * 三角形网格整理成模型：原点挪到底面中心、乘上缩放，数字取 4 位小数（存地图码小一些），算包围盒。
 * 没有三角形时抛错
 */
export function finishModel(label: string, parts: CustomPart[], textures: string[], scale = 1): CustomModel {
  parts = parts.filter((p) => p.pos.length >= 9);
  if (!parts.length) throw new Error('文件里没有找到三角形网格');
  const mn = [Infinity, Infinity, Infinity], mx = [-Infinity, -Infinity, -Infinity];
  for (const p of parts) for (let i = 0; i < p.pos.length; i++) { const k = i % 3; mn[k] = Math.min(mn[k], p.pos[i]); mx[k] = Math.max(mx[k], p.pos[i]); }
  if (!mn.every(Number.isFinite) || !mx.every(Number.isFinite)) throw new Error('模型的顶点坐标不对（有无穷大或非数字）');
  const c = [(mn[0] + mx[0]) / 2, (mn[1] + mx[1]) / 2, mn[2]];
  const out = parts.map((p) => ({
    ...p,
    pos: p.pos.map((v, i) => r4((v - c[i % 3]) * scale)),
    uv: p.uv.map((v) => (Number.isFinite(v) ? r4(v) : 0)),
    nrm: p.nrm.map((v) => (Number.isFinite(v) ? Math.round(v * 1e3) / 1e3 + 0 : 0)),
    color: p.color.map((v) => Math.round(v * 1e3) / 1e3) as [number, number, number],
  }));
  const min = [0, 1, 2].map((k) => r4((mn[k] - c[k]) * scale)) as [number, number, number];
  const max = [0, 1, 2].map((k) => r4((mx[k] - c[k]) * scale)) as [number, number, number];
  return { label, parts: out, textures, min, max };
}

/** 三角形数 */
export const triCount = (m: CustomModel) => m.parts.reduce((s, p) => s + p.pos.length / 9, 0);
