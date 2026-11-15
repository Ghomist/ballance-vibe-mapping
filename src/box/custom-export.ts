// 导出时的导入模型：把用到的模型塞进素材库（NmoLib）的副本里，buildNmoDoc 就和资产库模型一样处理。
// 网格换成 Virtools 坐标（Y、Z 互换，V 取反，面的顶点顺序反过来）；Virtools 的面索引是 16 位，顶点超过 65535 个的拆成几块。
// 模型自带的贴图导出成单独的文件（不透明的 .bmp，带透明的 .tga），要放进 Ballance/Textures。
import type { NmoLib, NmoMaterial, NmoMesh } from '../export/nmo-lib';
import type { SceneAsset } from '../export/scene';
import { type CustomModel, customKey, customModel } from './custom-model';

const GROUPS: Record<string, string[]> = {
  floor: ['Phys_Floors', 'Sound_HitID_01', 'Sound_RollID_01', 'Shadow'],
  wood: ['Phys_Floors', 'Sound_HitID_02', 'Sound_RollID_02', 'Shadow'],
  rail: ['Phys_FloorRails', 'Sound_HitID_03', 'Sound_RollID_03'],
  deco: [],
};
export const physKind = (phys: string | undefined): SceneAsset['kind'] => (phys === 'rail' ? 'rail' : phys ? 'floor' : 'deco');

/** 导出用的贴图文件名 */
export const customTexFile = (key: string, i: number, url: string) => `BVM_${key}_${i}.${/^data:image\/png/.test(url) ? 'tga' : 'bmp'}`;
/** 导出时物体名用模型名字（只留 ASCII，Virtools 的名字是单字节编码） */
const objLabel = (m: CustomModel, key: string) => (m.label.replace(/[^\w-]+/g, '_').replace(/^_+|_+$/g, '') || `Model_${key}`);

/** 网格拆块：每块最多 65535 个顶点 */
function meshesOf(m: CustomModel, key: string): { mesh: NmoMesh; mats: string[] }[] {
  const out: { mesh: NmoMesh; mats: string[] }[] = [];
  let cur: NmoMesh | null = null, seen = new Map<string, number>();
  const slot = new Map<string, number>();
  const flush = () => { if (cur && cur.faces.length) out.push({ mesh: cur, mats: cur.mtls as string[] }); cur = null; };
  m.parts.forEach((p, pi) => {
    const mat = `custom:${key}:${pi}`;
    for (let t = 0; t * 9 < p.pos.length; t++) {
      if (!cur || cur.pos.length / 3 + 3 > 65535) { flush(); cur = { litMode: 1, pos: [], nml: [], uv: [], faces: [], faceMtl: [], mtls: [] }; seen = new Map(); slot.clear(); }
      let s = slot.get(mat);
      if (s === undefined) { s = cur.mtls.length; cur.mtls.push(mat); slot.set(mat, s); }
      for (const k of [2, 1, 0]) {
        const v = t * 3 + k;
        const P = [p.pos[v * 3], p.pos[v * 3 + 2], p.pos[v * 3 + 1]], N = [p.nrm[v * 3], p.nrm[v * 3 + 2], p.nrm[v * 3 + 1]], U = [p.uv[v * 2], -p.uv[v * 2 + 1] + 0];
        const id = [...P, ...N, ...U].join(',');
        let j = seen.get(id);
        if (j === undefined) { j = cur.pos.length / 3; seen.set(id, j); cur.pos.push(...P); cur.nml.push(...N); cur.uv.push(...U); }
        cur.faces.push(j);
      }
      cur.faceMtl.push(s);
    }
  });
  flush();
  return out;
}

/**
 * 素材库副本，加上这些导入模型（assets 里每个模型拆成的几块是 `custom:编号#块号`）。
 * 返回新的素材库和每个模型拆成了几块
 */
export function withCustom(lib: NmoLib, names: string[]): { lib: NmoLib; split: Map<string, number> } {
  const out: NmoLib = { ...lib, textures: { ...lib.textures }, materials: { ...lib.materials }, meshes: { ...lib.meshes }, assets: { ...lib.assets } };
  const split = new Map<string, number>();
  const base = lib.materials.BMEFloorSide ?? Object.values(lib.materials)[0];
  for (const name of new Set(names)) {
    const m = customModel(name);
    if (!m) continue;
    const key = customKey(name);
    m.parts.forEach((p, pi) => {
      let tex: string | null = null;
      if (typeof p.tex === 'string') { tex = p.tex; out.textures[tex] ??= { file: p.tex, size: null, saveOptions: 1, videoFormat: 0 }; }
      else if (typeof p.tex === 'number' && m.textures[p.tex]) {
        tex = customTexFile(key, p.tex, m.textures[p.tex]);
        out.textures[tex] = { file: tex, size: null, saveOptions: 1, videoFormat: 0 };
      }
      const c = p.color, mat: NmoMaterial = {
        ...base,
        diffuse: [c[0], c[1], c[2], 1], ambient: [0, 0, 0, 1], specular: [0, 0, 0, 1], emissive: [c[0] * 0.5, c[1] * 0.5, c[2] * 0.5, 1],
        texture: tex, alphaTest: !!p.alphaTest, alphaRef: p.alphaTest ? 128 : 0, alphaFunc: p.alphaTest ? 7 : base.alphaFunc,
        alphaBlend: !!p.alphaBlend, zWrite: !p.alphaBlend, twoSided: !!(p.twoSided || p.alphaBlend),
        ...(p.alphaBlend ? { sourceBlend: 5, destBlend: 6 } : {}),
      };
      out.materials[`custom:${key}:${pi}`] = mat;
    });
    const chunks = meshesOf(m, key);
    chunks.forEach(({ mesh }, i) => {
      const mn = `${objLabel(m, key)}_Mesh${chunks.length > 1 ? `_${i + 1}` : ''}`;
      out.meshes[`${name}#${i}`] = { ...mesh };
      out.assets[`${name}#${i}`] = { mesh: `${name}#${i}`, groups: [], name: objLabel(m, key) + (chunks.length > 1 ? `_${i + 1}` : ''), meshName: mn } as NmoLib['assets'][string];
    });
    split.set(name, chunks.length);
  }
  return { lib: out, split };
}

/** 导出时这个导入模型属于哪些组 */
export const customGroups = (phys: string | undefined) => GROUPS[phys ?? 'deco'] ?? [];

/** 把模型自带的贴图转成游戏能读的 .bmp（24 位）/ .tga（32 位，带透明）；只在浏览器里能用 */
export async function customTextureFiles(names: string[]): Promise<Map<string, Uint8Array>> {
  const out = new Map<string, Uint8Array>();
  for (const name of new Set(names)) {
    const m = customModel(name);
    if (!m) continue;
    const key = customKey(name);
    for (const [i, url] of m.textures.entries()) {
      const used = m.parts.some((p) => p.tex === i);
      if (!used) continue;
      try {
        const bmp = await createImageBitmap(await (await fetch(url)).blob());
        const c = document.createElement('canvas');
        c.width = bmp.width; c.height = bmp.height;
        const g = c.getContext('2d')!;
        g.drawImage(bmp, 0, 0);
        const px = g.getImageData(0, 0, c.width, c.height);
        const file = customTexFile(key, i, url);
        out.set(file, file.endsWith('.tga') ? encodeTga(px) : encodeBmp(px));
      } catch { /* 读不了的贴图不导出 */ }
    }
  }
  return out;
}

function encodeBmp(img: ImageData): Uint8Array {
  const { width: w, height: h, data } = img, row = Math.ceil((w * 3) / 4) * 4, size = 54 + row * h;
  const b = new Uint8Array(size), dv = new DataView(b.buffer);
  b[0] = 0x42; b[1] = 0x4d; dv.setUint32(2, size, true); dv.setUint32(10, 54, true);
  dv.setUint32(14, 40, true); dv.setInt32(18, w, true); dv.setInt32(22, h, true); dv.setUint16(26, 1, true); dv.setUint16(28, 24, true); dv.setUint32(34, row * h, true);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((h - 1 - y) * w + x) * 4, d = 54 + y * row + x * 3;
    b[d] = data[s + 2]; b[d + 1] = data[s + 1]; b[d + 2] = data[s];
  }
  return b;
}
function encodeTga(img: ImageData): Uint8Array {
  const { width: w, height: h, data } = img;
  const b = new Uint8Array(18 + w * h * 4);
  b[2] = 2; b[12] = w & 255; b[13] = w >> 8; b[14] = h & 255; b[15] = h >> 8; b[16] = 32; b[17] = 8; // 从下往上
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const s = ((h - 1 - y) * w + x) * 4, d = 18 + (y * w + x) * 4;
    b[d] = data[s + 2]; b[d + 1] = data[s + 1]; b[d + 2] = data[s]; b[d + 3] = data[s + 3];
  }
  return b;
}
