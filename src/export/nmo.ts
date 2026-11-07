// Virtools 文件（.nmo）写入器：纯 TypeScript 实现，照搬 libcmo21（BBP 背后的 BMap）的保存流程，
// 只支持导出 Ballance 地图需要的几类对象：组、3D 物体、网格、材质、贴图（外部引用文件名）。
//
// 文件结构：CKRawFileInfo（64 字节）+ 文件头（对象表）+ 数据（每个对象一个 CKStateChunk），
// 文件头、数据分别用 zlib 压缩（CKFILE_WHOLECOMPRESSED），CRC 为 adler32。
// 坐标一律是 Virtools 坐标系（Y 轴朝上），调用方负责转换。
//
// 文件格式的写法移植自 libcmo21（https://github.com/yyc12345/libcmo21）：
//   The MIT License (MIT) Copyright (c) 2022-2026 yyc12345
//   Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
//   documentation files (the "Software"), to deal in the Software without restriction, including without limitation
//   the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
//   permit persons to whom the Software is furnished to do so, subject to the following conditions: The above copyright
//   notice and this permission notice shall be included in all copies or substantial portions of the Software.
//   THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED.
import type { NmoColor, NmoMaterial } from './nmo-lib';

export interface NmoDocTexture { name: string; file: string; size: [number, number] | null; saveOptions: number; videoFormat: number }
export interface NmoDocMaterial extends Omit<NmoMaterial, 'texture'> { name: string; texture: number | null }
export interface NmoDocMesh {
  name: string;
  litMode: number;
  pos: ArrayLike<number>; nml: ArrayLike<number>; uv: ArrayLike<number>;
  faces: ArrayLike<number>; faceMtl: ArrayLike<number>;
  /** 材质槽：材质的下标 */
  mtls: (number | null)[];
}
export interface NmoDocObject {
  name: string;
  mesh: number | null;
  /** Virtools 世界矩阵，按行：前三行是三个轴，第四行是位置 */
  matrix: number[];
  visible?: boolean;
}
export interface NmoDoc {
  groups: { name: string; objects: number[] }[];
  objects: NmoDocObject[];
  meshes: NmoDocMesh[];
  materials: NmoDocMaterial[];
  textures: NmoDocTexture[];
}

// ---- 常量（libcmo21 CKEnums / VxEnums） ----
const CKCID = { GROUP: 23, MATERIAL: 30, TEXTURE: 31, MESH: 32, ENTITY3D: 33, OBJECT3D: 41 } as const;
const CHUNK_VERSION4 = 7, CHUNK_DEV_2_1 = 10, CHNK_OPTION_FILE = 0x08;
const CKVERSION = 0x13022002, DEVBUILD = 0x02010001, DEVVERSION = 0;
const CKFILE_WHOLECOMPRESSED = 8;
const S = {
  GROUPALL: 0x000fffff,
  OBJECT_HIDDEN: 0x00000004, ENTITY_MESHS: 0x00004000, ENTITY_DATA: 0x00100000,
  MESH_FLAGS: 0x00002000, MESH_MATERIALS: 0x00100000, MESH_FACES: 0x00010000, MESH_VERTICES: 0x00020000,
  MAT_DATA: 0x00001000,
  TEX_FILENAMES: 0x00010000, TEX_OLDTEXONLY: 0x002ff000, TEX_SAVEFORMAT: 0x00080000,
};
const VXMESH_VISIBLE = 0x2, VXMESH_RENDERCHANNELS = 0x8, VXMESH_PRELITMODE = 0x80;
const VX_PRELITMESH = 0;
const VX_MOVEABLE_DEFAULT = 0x1 | 0x2 | 0x8 | 0x00400000; // PICKABLE | VISIBLE | RENDERCHANNELS | INVERSEWORLDMATVALID
const VX_MOVEABLE_VISIBLE = 0x2;
const PF_ARGB8888 = 1;
/** 网格顶点数据的保存标记 */
const VSF = { SingleColor: 0x1, SingleSpecularColor: 0x2, NoNormal: 0x4, SingleUV: 0x8 };

const f32 = new Float32Array(1), u32 = new Uint32Array(f32.buffer);
const floatBits = (v: number) => { f32[0] = v; return u32[0]; };
/** VxColor::ToARGB（float32 运算后截断） */
const argb = (c: NmoColor) => {
  const b = (v: number) => Math.trunc(Math.fround(Math.fround(v) * 255)) & 0xff;
  return ((b(c[3]) << 24) | (b(c[0]) << 16) | (b(c[1]) << 8) | b(c[2])) >>> 0;
};
/** 名字按单字节编码写入（cp1252 的 ASCII 部分） */
const encodeName = (s: string) => Uint8Array.from(s, (ch) => { const c = ch.charCodeAt(0); return c < 0x80 ? c : 0x5f; });

/** CKStateChunk 写入（绑定文件：对象引用写成文件里的下标） */
class Chunk {
  data: number[] = [];
  classId = 0;
  private prevIdent = 0;

  ident(id: number) {
    if (this.prevIdent < this.data.length) this.data[this.prevIdent + 1] = this.data.length;
    this.prevIdent = this.data.length;
    this.data.push(id >>> 0, 0);
  }
  dword(v: number) { this.data.push(v >>> 0); }
  float(v: number) { this.data.push(floatBits(v)); }
  /** 对象引用：文件里的下标，空引用为 -1 */
  obj(index: number | null) { this.data.push(index === null ? 0xffffffff : index); }
  objArray(list: number[]) { this.dword(list.length); for (const i of list) this.obj(i); }
  /** 原始字节，补齐到 4 字节 */
  bytes(b: Uint8Array) {
    const n = Math.ceil(b.length / 4);
    const pad = new Uint8Array(n * 4);
    pad.set(b);
    const dv = new DataView(pad.buffer);
    for (let i = 0; i < n; i++) this.data.push(dv.getUint32(i * 4, true));
  }
  string(s: string) {
    if (!s) { this.dword(0); return; }
    const b = encodeName(s);
    const z = new Uint8Array(b.length + 1);
    z.set(b);
    this.dword(z.length);
    this.bytes(z);
  }
  /** 带长度的缓冲区（WriteBuffer） */
  buffer(dwords: number[]) { this.dword(dwords.length * 4); this.data.push(...dwords); }

  /** ConvertToBuffer：4 字节头（数据版本、类 ID、块版本、选项）+ 长度 + 数据 */
  toBytes(): Uint8Array {
    const out = new Uint8Array(8 + this.data.length * 4);
    const dv = new DataView(out.buffer);
    out[0] = CHUNK_DEV_2_1; out[1] = this.classId; out[2] = CHUNK_VERSION4; out[3] = CHNK_OPTION_FILE;
    dv.setUint32(4, this.data.length, true);
    for (let i = 0; i < this.data.length; i++) dv.setUint32(8 + i * 4, this.data[i], true);
    return out;
  }
}

function saveGroup(c: Chunk, g: NmoDoc['groups'][number], objBase: number) {
  c.ident(S.GROUPALL);
  c.objArray(g.objects.map((i) => objBase + i));
  c.classId = CKCID.GROUP;
}

function saveObject(c: Chunk, o: NmoDocObject, meshBase: number) {
  // 隐藏要写两处，和原版关卡一样：这个标识符（读档时靠它决定显示与否）和下面的 Moveable 标记
  if (o.visible === false) c.ident(S.OBJECT_HIDDEN);
  if (o.mesh !== null) {
    c.ident(S.ENTITY_MESHS);
    c.obj(meshBase + o.mesh);
    c.objArray([meshBase + o.mesh]);
  }
  c.ident(S.ENTITY_DATA);
  c.dword(0); // 3dEntity flags
  c.dword(o.visible === false ? VX_MOVEABLE_DEFAULT & ~VX_MOVEABLE_VISIBLE : VX_MOVEABLE_DEFAULT);
  for (let r = 0; r < 4; r++) for (let k = 0; k < 3; k++) c.float(o.matrix[r * 4 + k]);
  c.classId = CKCID.ENTITY3D;
}

/** CKMesh::GenerateSaveFlags：法线和按面自动生成的一致时不保存法线 */
function vertexSaveFlags(m: NmoDocMesh): number {
  let flags = VSF.SingleColor | VSF.SingleSpecularColor | VSF.NoNormal | VSF.SingleUV;
  const n = m.pos.length / 3;
  for (let i = 1; i < n; i++) {
    if (m.uv[i * 2] !== m.uv[0] || m.uv[i * 2 + 1] !== m.uv[1]) { flags &= ~VSF.SingleUV; break; }
  }
  const gen = new Float32Array(n * 3);
  const F = m.faces;
  for (let f = 0; f < F.length; f += 3) {
    const a = F[f] * 3, b = F[f + 1] * 3, cc = F[f + 2] * 3;
    const ux = m.pos[b] - m.pos[a], uy = m.pos[b + 1] - m.pos[a + 1], uz = m.pos[b + 2] - m.pos[a + 2];
    const vx = m.pos[cc] - m.pos[a], vy = m.pos[cc + 1] - m.pos[a + 1], vz = m.pos[cc + 2] - m.pos[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const l = Math.hypot(nx, ny, nz);
    if (l > 0) { nx /= l; ny /= l; nz /= l; }
    for (const v of [F[f], F[f + 1], F[f + 2]]) { gen[v * 3] += nx; gen[v * 3 + 1] += ny; gen[v * 3 + 2] += nz; }
  }
  let ax = 0, ay = 0, az = 0;
  for (let v = 0; v < n; v++) {
    const l = Math.hypot(gen[v * 3], gen[v * 3 + 1], gen[v * 3 + 2]) || 1;
    ax += Math.abs(m.nml[v * 3] - gen[v * 3] / l);
    ay += Math.abs(m.nml[v * 3 + 1] - gen[v * 3 + 1] / l);
    az += Math.abs(m.nml[v * 3 + 2] - gen[v * 3 + 2] / l);
  }
  if (n && Math.hypot(ax / n, ay / n, az / n) > 0.001) flags &= ~VSF.NoNormal;
  return flags;
}

function saveMesh(c: Chunk, m: NmoDocMesh, mtlBase: number) {
  c.ident(S.MESH_FLAGS);
  c.dword(VXMESH_VISIBLE | VXMESH_RENDERCHANNELS | (m.litMode === VX_PRELITMESH ? VXMESH_PRELITMODE : 0));

  c.ident(S.MESH_MATERIALS);
  const slots = m.mtls.length ? m.mtls : [null];
  c.dword(slots.length);
  for (const s of slots) { c.obj(s === null ? null : mtlBase + s); c.dword(0); }

  const faceCount = m.faces.length / 3;
  if (faceCount) {
    c.ident(S.MESH_FACES);
    c.dword(faceCount);
    for (let f = 0; f < faceCount; f++) {
      c.dword((m.faces[f * 3] & 0xffff) | ((m.faces[f * 3 + 1] & 0xffff) << 16));
      c.dword((m.faces[f * 3 + 2] & 0xffff) | ((m.faceMtl[f] & 0xffff) << 16));
    }
  }

  const vtx = m.pos.length / 3;
  if (vtx) {
    c.ident(S.MESH_VERTICES);
    c.dword(vtx);
    const flags = vertexSaveFlags(m);
    c.dword(flags);
    const body: number[] = [];
    for (let i = 0; i < vtx * 3; i++) body.push(floatBits(m.pos[i]));
    body.push(0xffffffff); // 顶点颜色（统一白色）
    body.push(0x00000000); // 高光颜色
    if (!(flags & VSF.NoNormal)) for (let i = 0; i < vtx * 3; i++) body.push(floatBits(m.nml[i]));
    if (flags & VSF.SingleUV) body.push(floatBits(m.uv[0] ?? 0), floatBits(m.uv[1] ?? 0));
    else for (let i = 0; i < vtx * 2; i++) body.push(floatBits(m.uv[i]));
    c.dword(body.length + 1); // 长度（含长度本身）
    c.data.push(...body);
  }
  c.classId = CKCID.MESH;
}

function saveMaterial(c: Chunk, m: NmoDocMaterial, texBase: number) {
  c.ident(S.MAT_DATA);
  c.dword(argb(m.diffuse)); c.dword(argb(m.ambient)); c.dword(argb(m.specular)); c.dword(argb(m.emissive));
  c.float(m.specularPower);
  c.obj(m.texture === null ? null : texBase + m.texture);
  c.dword(argb(m.textureBorderColor));
  let mix = 0;
  for (const v of [m.textureAddressMode, m.fillMode, m.shadeMode, m.destBlend, m.sourceBlend, m.textureMagMode, m.textureMinMode, m.textureBlendMode]) mix = ((mix << 4) | (v & 0xf)) >>> 0;
  c.dword(mix);
  const flags = (m.twoSided ? 1 : 0) | (m.zWrite ? 2 : 0) | (m.perspectiveCorrection ? 4 : 0) | (m.alphaBlend ? 8 : 0) | (m.alphaTest ? 16 : 0);
  c.dword((((m.alphaRef & 0xff) << 24) | ((m.alphaFunc & 0xff) << 16) | ((m.zFunc & 0xff) << 8) | flags) >>> 0);
  c.classId = CKCID.MATERIAL;
}

function saveTexture(c: Chunk, t: NmoDocTexture) {
  // 外部贴图：只存文件名
  c.ident(S.TEX_FILENAMES);
  c.dword(1);
  c.string(t.file);
  c.ident(S.TEX_OLDTEXONLY);
  c.dword((((t.saveOptions & 0xff) << 16) | ((t.videoFormat !== 0 ? 0x2 : 0) << 8)) >>> 0);
  c.dword(0); // 透明色
  if (t.videoFormat !== 0) c.dword(t.videoFormat);
  // 保存格式（FakeBitmapProperties，72 字节）
  c.ident(S.TEX_SAVEFORMAT);
  const [w, h] = t.size ?? [0, 0];
  const ext = new DataView(new ArrayBuffer(4));
  'bmp'.split('').forEach((ch, i) => ext.setUint8(i, ch.charCodeAt(0)));
  c.buffer([
    72, 0, 0, ext.getUint32(0, true),
    52, PF_ARGB8888, w, h, 4 * w, 32,
    0x00ff0000, 0x0000ff00, 0x000000ff, 0xff000000,
    0, 0, 0, 0,
  ]);
  c.classId = CKCID.TEXTURE;
}

/** zlib compress（RFC 1950） */
async function zlib(data: Uint8Array): Promise<Uint8Array> {
  const cs = new CompressionStream('deflate');
  const out = new Response(cs.readable).arrayBuffer();
  const w = cs.writable.getWriter();
  void w.write(data);
  void w.close();
  return new Uint8Array(await out);
}

function adler32(prev: number, data: Uint8Array): number {
  let a = prev & 0xffff, b = (prev >>> 16) & 0xffff;
  for (let i = 0; i < data.length;) {
    const end = Math.min(i + 3800, data.length);
    for (; i < end; i++) { a += data[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** 生成 .nmo 文件内容 */
export async function writeNmo(doc: NmoDoc): Promise<Uint8Array> {
  // 文件里的对象顺序与 BMap 一致：组、3D 物体、网格、材质、贴图
  const objBase = doc.groups.length;
  const meshBase = objBase + doc.objects.length;
  const mtlBase = meshBase + doc.meshes.length;
  const texBase = mtlBase + doc.materials.length;
  const entries: { cid: number; name: string; chunk: Chunk }[] = [];
  const add = (cid: number, name: string, fill: (c: Chunk) => void) => { const c = new Chunk(); fill(c); entries.push({ cid, name, chunk: c }); };
  for (const g of doc.groups) add(CKCID.GROUP, g.name, (c) => saveGroup(c, g, objBase));
  for (const o of doc.objects) add(CKCID.OBJECT3D, o.name, (c) => saveObject(c, o, meshBase));
  for (const m of doc.meshes) add(CKCID.MESH, m.name, (c) => saveMesh(c, m, mtlBase));
  for (const m of doc.materials) add(CKCID.MATERIAL, m.name, (c) => saveMaterial(c, m, texBase));
  for (const t of doc.textures) add(CKCID.TEXTURE, t.name, (c) => saveTexture(c, t));

  const chunks = entries.map((e) => e.chunk.toBytes());
  const names = entries.map((e) => encodeName(e.name));
  const hdrSize = names.reduce((s, n) => s + 16 + n.length, 0) + 4 + 8;
  const dataSize = chunks.reduce((s, c) => s + 4 + c.length, 0);

  // 文件头：对象表（ID、类 ID、数据位置、名字）+ 插件依赖（无）+ 内含文件（无）
  const hdr = new Uint8Array(hdrSize);
  const hv = new DataView(hdr.buffer);
  let p = 0, fileIndex = hdrSize + 64;
  entries.forEach((e, i) => {
    hv.setUint32(p, i + 1, true); hv.setUint32(p + 4, e.cid, true); hv.setUint32(p + 8, fileIndex, true);
    hv.setUint32(p + 12, names[i].length, true);
    hdr.set(names[i], p + 16);
    p += 16 + names[i].length;
    fileIndex += chunks[i].length + 4;
  });
  hv.setUint32(p, 0, true); hv.setUint32(p + 4, 4, true); hv.setUint32(p + 8, 0, true);

  const data = new Uint8Array(dataSize);
  const dv = new DataView(data.buffer);
  p = 0;
  for (const c of chunks) { dv.setUint32(p, c.length, true); data.set(c, p + 4); p += 4 + c.length; }

  const hdrZ = await zlib(hdr), dataZ = await zlib(data);
  const raw = new Uint8Array(64);
  const rv = new DataView(raw.buffer);
  raw.set(encodeName('Nemo Fi'));
  const fields = [
    0, CKVERSION, 8, 0, CKFILE_WHOLECOMPRESSED, hdrZ.length, dataZ.length, dataSize,
    0, entries.length, entries.length, DEVVERSION, DEVBUILD, hdrSize,
  ];
  fields.forEach((v, i) => rv.setUint32(8 + i * 4, v >>> 0, true));
  let crc = adler32(0, raw);
  crc = adler32(crc, hdrZ);
  crc = adler32(crc, dataZ);
  rv.setUint32(8, crc, true);

  const out = new Uint8Array(64 + hdrZ.length + dataZ.length);
  out.set(raw); out.set(hdrZ, 64); out.set(dataZ, 64 + hdrZ.length);
  return out;
}
