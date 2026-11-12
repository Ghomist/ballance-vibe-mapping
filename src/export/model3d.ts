// 通用 3D 模型导出（.obj / .glb）：和 .nmo 用同一份 Virtools 文档（buildNmoDoc 的结果），
// 所以导出的同样是占位符（机关是 P_Box、PC_TwoFlames… 这些占位网格，不是编辑器里看到的视觉模型），
// 物体名、组、矩阵和 NMO 一一对应，方便在 Blender 等软件里检查或二次加工。
//
// 坐标：Virtools 是 Y 朝上的左手系；OBJ / glTF 是 Y 朝上的右手系，Z 取反（面的顶点顺序随之反过来）。
// UV：Virtools 与 glTF 都是左上角为原点，照搬；OBJ 是左下角为原点，v 取 1 - v。
import type { NmoDoc, NmoDocMesh } from './nmo';
import type { NmoColor } from './nmo-lib';

/** Virtools 矩阵（按行，行向量约定）→ 右手系下同样布局的矩阵：第 3 行、第 3 列各取反一次 */
export function glMatrix(m: number[]): number[] {
  return m.map((v, i) => ((i >> 2 === 2) !== ((i & 3) === 2) ? -v : v) + 0);
}

/** 网格换到右手系：位置、法线 Z 取反，面反向 */
function glMesh(m: NmoDocMesh) {
  const n = m.pos.length / 3;
  const pos = new Float32Array(n * 3), nml = new Float32Array(n * 3), uv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) {
    pos[i * 3] = m.pos[i * 3]; pos[i * 3 + 1] = m.pos[i * 3 + 1]; pos[i * 3 + 2] = -m.pos[i * 3 + 2];
    let x = m.nml[i * 3] ?? 0, y = m.nml[i * 3 + 1] ?? 0, z = -(m.nml[i * 3 + 2] ?? 0);
    const l = Math.hypot(x, y, z);
    if (l > 1e-8) { x /= l; y /= l; z /= l; } else { x = 0; y = 1; z = 0; }
    nml[i * 3] = x; nml[i * 3 + 1] = y; nml[i * 3 + 2] = z;
    uv[i * 2] = m.uv[i * 2] ?? 0; uv[i * 2 + 1] = m.uv[i * 2 + 1] ?? 0;
  }
  const faces = new Uint32Array(m.faces.length);
  for (let f = 0; f * 3 < m.faces.length; f++) {
    faces[f * 3] = m.faces[f * 3]; faces[f * 3 + 1] = m.faces[f * 3 + 2]; faces[f * 3 + 2] = m.faces[f * 3 + 1];
  }
  return { pos, nml, uv, faces };
}

/** 物体在导出文件里的名字：OBJ / MTL 的名字里不能有空白 */
const safeName = (s: string) => s.replace(/\s+/g, '_') || 'unnamed';

/** 每个物体属于哪些组 */
function objectGroups(doc: NmoDoc): string[][] {
  const out = doc.objects.map((): string[] => []);
  for (const g of doc.groups) for (const i of g.objects) out[i]?.push(g.name);
  return out;
}

/** 贴图在导出包里的路径 */
export const textureFiles = (doc: NmoDoc) => [...new Set(doc.textures.map((t) => t.file))];

// ---------------- OBJ ----------------

/**
 * Virtools 文档 → .obj + .mtl 的文本。OBJ 没有物体变换，顶点直接换到世界坐标；
 * 组写成 o 后面的注释（# groups: …），隐藏的物体（死亡区）照样导出，注释里标出来。
 * texDir：.mtl 里贴图的相对目录（贴图文件名照游戏里的）
 */
export function nmoDocToObj(doc: NmoDoc, base: string, texDir = 'textures'): { obj: string; mtl: string } {
  const groups = objectGroups(doc);
  const mtlName = doc.materials.map((m) => safeName(m.name));
  const L: string[] = ['# Ballance Vibe Mapping：占位符模型（与 .nmo 相同的物体、组和占位网格）', '# 坐标：Y 朝上，单位与游戏相同', `mtllib ${base}.mtl`];
  let vBase = 1;
  const r6 = (v: number) => String(Math.round(v * 1e6) / 1e6 + 0);
  doc.objects.forEach((o, oi) => {
    if (o.mesh === null) return;
    const m = doc.meshes[o.mesh];
    if (!m.faces.length) return;
    const g = glMesh(m);
    const M = glMatrix(o.matrix);
    // 法线矩阵：A 的逆的转置（A[i][j] = M[i*4+j]，行向量约定）
    const a = [M[0], M[1], M[2], M[4], M[5], M[6], M[8], M[9], M[10]];
    const det = a[0] * (a[4] * a[8] - a[5] * a[7]) - a[1] * (a[3] * a[8] - a[5] * a[6]) + a[2] * (a[3] * a[7] - a[4] * a[6]);
    const inv = [
      a[4] * a[8] - a[5] * a[7], a[2] * a[7] - a[1] * a[8], a[1] * a[5] - a[2] * a[4],
      a[5] * a[6] - a[3] * a[8], a[0] * a[8] - a[2] * a[6], a[2] * a[3] - a[0] * a[5],
      a[3] * a[7] - a[4] * a[6], a[1] * a[6] - a[0] * a[7], a[0] * a[4] - a[1] * a[3],
    ].map((v) => v / (det || 1));
    L.push(`o ${safeName(o.name)}`);
    L.push(`# groups: ${groups[oi].join(', ') || '-'}${o.visible === false ? '（导出 NMO 时隐藏）' : ''}`);
    const n = g.pos.length / 3;
    for (let i = 0; i < n; i++) {
      const p = [g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]];
      L.push(`v ${[0, 1, 2].map((j) => r6(p[0] * M[j] + p[1] * M[4 + j] + p[2] * M[8 + j] + M[12 + j])).join(' ')}`);
    }
    for (let i = 0; i < n; i++) L.push(`vt ${r6(g.uv[i * 2])} ${r6(1 - g.uv[i * 2 + 1])}`);
    for (let i = 0; i < n; i++) {
      const v = [g.nml[i * 3], g.nml[i * 3 + 1], g.nml[i * 3 + 2]];
      // n' = n · (A⁻¹)ᵀ：n'_j = Σ_i n_i · inv[j][i]
      const w = [0, 1, 2].map((j) => v[0] * inv[j * 3] + v[1] * inv[j * 3 + 1] + v[2] * inv[j * 3 + 2]);
      const l = Math.hypot(w[0], w[1], w[2]) || 1;
      L.push(`vn ${w.map((c) => r6(c / l)).join(' ')}`);
    }
    let cur: string | undefined;
    for (let f = 0; f * 3 < g.faces.length; f++) {
      const slot = m.mtls[m.faceMtl[f] ?? 0];
      const name = slot === null || slot === undefined ? 'None' : mtlName[slot];
      if (name !== cur) { L.push(name === 'None' ? 'usemtl None' : `usemtl ${name}`); cur = name; }
      let t = [g.faces[f * 3], g.faces[f * 3 + 1], g.faces[f * 3 + 2]];
      if (det < 0) t = [t[0], t[2], t[1]];
      L.push(`f ${t.map((k) => { const j = k + vBase; return `${j}/${j}/${j}`; }).join(' ')}`);
    }
    vBase += n;
  });

  const c3 = (c: NmoColor) => c.slice(0, 3).map((v) => r6(v)).join(' ');
  const M: string[] = ['# Ballance Vibe Mapping'];
  doc.materials.forEach((m, i) => {
    M.push('', `newmtl ${mtlName[i]}`, `Ka ${c3(m.ambient)}`, `Kd ${c3(m.diffuse)}`, `Ks ${c3(m.specular)}`, `Ke ${c3(m.emissive)}`, `Ns ${r6(m.specularPower)}`, `d ${r6(m.diffuse[3])}`, 'illum 2');
    const t = m.texture === null ? null : doc.textures[m.texture];
    if (t) M.push(`map_Kd ${texDir}/${t.file}`);
  });
  return { obj: L.join('\n') + '\n', mtl: M.join('\n') + '\n' };
}

// ---------------- glTF（.glb） ----------------

const srgbToLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * Virtools 文档 → .glb。网格共用（同一个占位网格只存一份），每个物体一个节点，矩阵与 NMO 相同；
 * 节点的 extras 里有 groups（所属的组）、hidden（导出 NMO 时隐藏）。
 * images：贴图文件名 → PNG 字节（没给的贴图不嵌入，只保留材质颜色）
 */
export function nmoDocToGlb(doc: NmoDoc, images: Map<string, Uint8Array> = new Map()): Uint8Array {
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  const bufferViews: Record<string, unknown>[] = [];
  const accessors: Record<string, unknown>[] = [];
  const view = (data: ArrayBufferView, target?: number) => {
    const pad = (4 - (byteLength % 4)) % 4;
    if (pad) { chunks.push(new Uint8Array(pad)); byteLength += pad; }
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    chunks.push(bytes);
    bufferViews.push({ buffer: 0, byteOffset: byteLength, byteLength: bytes.byteLength, ...(target ? { target } : {}) });
    byteLength += bytes.byteLength;
    return bufferViews.length - 1;
  };
  const accessor = (data: Float32Array | Uint32Array, type: 'SCALAR' | 'VEC2' | 'VEC3', target: number, minmax = false) => {
    const k = type === 'SCALAR' ? 1 : type === 'VEC2' ? 2 : 3;
    const acc: Record<string, unknown> = {
      bufferView: view(data, target), componentType: data instanceof Float32Array ? 5126 : 5125, count: data.length / k, type,
    };
    if (minmax) {
      const mn = Array(k).fill(Infinity), mx = Array(k).fill(-Infinity);
      for (let i = 0; i < data.length; i++) { const c = i % k; if (data[i] < mn[c]) mn[c] = data[i]; if (data[i] > mx[c]) mx[c] = data[i]; }
      acc.min = mn; acc.max = mx;
    }
    accessors.push(acc);
    return accessors.length - 1;
  };

  // 贴图
  const imageIdx = new Map<string, number>();
  const gImages: Record<string, unknown>[] = [], gTextures: Record<string, unknown>[] = [];
  const texIdx = doc.textures.map((t) => {
    const png = images.get(t.file);
    if (!png) return null;
    let im = imageIdx.get(t.file);
    if (im === undefined) {
      im = gImages.length;
      gImages.push({ name: t.file, mimeType: 'image/png', bufferView: view(png) });
      imageIdx.set(t.file, im);
    }
    gTextures.push({ name: t.name, sampler: 0, source: im });
    return gTextures.length - 1;
  });

  // 材质：有贴图的底色用白色（Virtools 的漫反射色只影响光照），没贴图的用漫反射色
  const gMaterials = doc.materials.map((m) => {
    const tex = m.texture === null ? null : texIdx[m.texture];
    const a = m.diffuse[3];
    const base = tex === null ? [...m.diffuse.slice(0, 3).map(srgbToLinear), a] : [1, 1, 1, a];
    return {
      name: m.name,
      pbrMetallicRoughness: { baseColorFactor: base, metallicFactor: 0, roughnessFactor: 1, ...(tex !== null ? { baseColorTexture: { index: tex } } : {}) },
      ...(m.alphaBlend || a < 1 ? { alphaMode: 'BLEND' } : m.alphaTest ? { alphaMode: 'MASK', alphaCutoff: Math.max(0.01, m.alphaRef / 255) } : {}),
      ...(m.twoSided ? { doubleSided: true } : {}),
    };
  });

  // 网格：按材质槽拆成几个图元，顶点共用
  const meshIdx = new Map<number, number>();
  const gMeshes: Record<string, unknown>[] = [];
  const mesh = (mi: number) => {
    let i = meshIdx.get(mi);
    if (i !== undefined) return i;
    const m = doc.meshes[mi];
    const g = glMesh(m);
    const attributes = {
      POSITION: accessor(g.pos, 'VEC3', 34962, true),
      NORMAL: accessor(g.nml, 'VEC3', 34962),
      TEXCOORD_0: accessor(g.uv, 'VEC2', 34962),
    };
    const bySlot = new Map<number, number[]>();
    for (let f = 0; f * 3 < g.faces.length; f++) {
      const s = m.faceMtl[f] ?? 0;
      let l = bySlot.get(s);
      if (!l) bySlot.set(s, (l = []));
      l.push(g.faces[f * 3], g.faces[f * 3 + 1], g.faces[f * 3 + 2]);
    }
    const primitives = [...bySlot].map(([s, idx]) => {
      const mtl = m.mtls[s];
      return { attributes, indices: accessor(Uint32Array.from(idx), 'SCALAR', 34963), mode: 4, ...(mtl !== null && mtl !== undefined ? { material: mtl } : {}) };
    });
    i = gMeshes.length;
    gMeshes.push({ name: m.name, primitives });
    meshIdx.set(mi, i);
    return i;
  };

  const groups = objectGroups(doc);
  const nodes = doc.objects.map((o, oi) => {
    const hasMesh = o.mesh !== null && doc.meshes[o.mesh].faces.length > 0;
    const M = glMatrix(o.matrix);
    const ident = M.every((v, i) => v === (i % 5 === 0 ? 1 : 0));
    return {
      name: o.name,
      ...(hasMesh ? { mesh: mesh(o.mesh!) } : {}),
      ...(ident ? {} : { matrix: M }),
      extras: { groups: groups[oi], ...(o.visible === false ? { hidden: true } : {}) },
    };
  });

  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'Ballance Vibe Mapping' },
    scene: 0,
    scenes: [{ name: 'Level', nodes: nodes.map((_, i) => i), extras: { groups: doc.groups.map((g) => g.name) } }],
    nodes,
    ...(gMeshes.length ? { meshes: gMeshes } : {}),
    ...(gMaterials.length ? { materials: gMaterials } : {}),
    ...(gTextures.length ? { textures: gTextures, images: gImages, samplers: [{ magFilter: 9729, minFilter: 9987, wrapS: 10497, wrapT: 10497 }] } : {}),
    ...(accessors.length ? { accessors, bufferViews } : {}),
  };
  if (byteLength) (json as { buffers?: unknown }).buffers = [{ byteLength: byteLength + ((4 - (byteLength % 4)) % 4) }];

  // GLB：12 字节文件头 + JSON 块（空格补齐）+ BIN 块（0 补齐）
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLen = Math.ceil(jsonBytes.length / 4) * 4;
  const binLen = Math.ceil(byteLength / 4) * 4;
  const total = 12 + 8 + jsonLen + (binLen ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, 0x46546c67, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jsonLen, true); dv.setUint32(16, 0x4e4f534a, true);
  out.fill(0x20, 20, 20 + jsonLen);
  out.set(jsonBytes, 20);
  if (binLen) {
    let p = 20 + jsonLen;
    dv.setUint32(p, binLen, true); dv.setUint32(p + 4, 0x004e4942, true);
    p += 8;
    for (const c of chunks) { out.set(c, p); p += c.byteLength; }
  }
  return out;
}

// ---------------- zip（只存储不压缩） ----------------

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(d: Uint8Array) {
  let c = 0xffffffff;
  for (let i = 0; i < d.length; i++) c = CRC_TABLE[(c ^ d[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 把几个文件打成 .zip（不压缩，文件名 UTF-8） */
export function zipStore(files: { name: string; data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [], central: Uint8Array[] = [];
  let off = 0;
  for (const f of files) {
    const name = enc.encode(f.name), crc = crc32(f.data), size = f.data.length;
    const h = new Uint8Array(30 + name.length), v = new DataView(h.buffer);
    v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true); v.setUint16(8, 0, true);
    v.setUint16(10, 0, true); v.setUint16(12, 0x21, true); v.setUint32(14, crc, true); v.setUint32(18, size, true); v.setUint32(22, size, true);
    v.setUint16(26, name.length, true); h.set(name, 30);
    const c = new Uint8Array(46 + name.length), w = new DataView(c.buffer);
    w.setUint32(0, 0x02014b50, true); w.setUint16(4, 20, true); w.setUint16(6, 20, true); w.setUint16(8, 0x0800, true);
    w.setUint16(12, 0, true); w.setUint16(14, 0x21, true); w.setUint32(16, crc, true); w.setUint32(20, size, true); w.setUint32(24, size, true);
    w.setUint16(28, name.length, true); w.setUint32(42, off, true); c.set(name, 46);
    parts.push(h, f.data); central.push(c);
    off += h.length + size;
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0);
  const end = new Uint8Array(22), e = new DataView(end.buffer);
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true);
  e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  const out = new Uint8Array(off + cdSize + 22);
  let p = 0;
  for (const x of [...parts, ...central, end]) { out.set(x, p); p += x.length; }
  return out;
}
