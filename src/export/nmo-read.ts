// Virtools 文件（.nmo / .cmo）读取：只取导入模型要用的——3D 物体（矩阵、网格、显示与否）、网格、材质、贴图文件名。
// 格式与 nmo.ts 的写入器相同（照 libcmo21 的读档流程），能读本工具导出的、BBP 导出的和原版关卡（文件版本 8）。
// 行为、脚本、参数这些都跳过；贴图只认外部文件名，嵌在文件里的贴图数据不读（导入后显示成材质颜色）。
// 坐标是 Virtools 坐标系（Y 朝上、左手系），调用方负责转换。
//
// 文件格式移植自 libcmo21（https://github.com/yyc12345/libcmo21），MIT License，Copyright (c) 2022-2026 yyc12345。

export interface NmoReadMesh {
  name: string;
  pos: Float32Array; nml: Float32Array | null; uv: Float32Array;
  faces: Uint16Array; faceMtl: Uint16Array;
  /** 材质槽：文件里材质的下标（materials 里的），没有是 null */
  mtls: (number | null)[];
}
export interface NmoReadMaterial { name: string; diffuse: [number, number, number, number]; texture: number | null; alphaTest: boolean; alphaBlend: boolean; twoSided: boolean }
export interface NmoReadObject { name: string; mesh: number | null; matrix: number[]; visible: boolean }
export interface NmoReadDoc {
  objects: NmoReadObject[];
  meshes: Map<number, NmoReadMesh>;
  materials: Map<number, NmoReadMaterial>;
  /** 贴图：文件里的下标 → 文件名（没有外部文件名的不在里面） */
  textures: Map<number, string>;
}

const CID = { MATERIAL: 30, TEXTURE: 31, MESH: 32, ENTITY3D: 33, OBJECT3D: 41 };
const S = {
  ENTITY_MESHS: 0x00004000, ENTITY_DATA: 0x00100000,
  MESH_MATERIALS: 0x00100000, MESH_FACES: 0x00010000, MESH_VERTICES: 0x00020000,
  MAT_DATA: 0x00001000, TEX_FILENAMES: 0x00010000,
};
const VSF = { SingleColor: 0x1, SingleSpecularColor: 0x2, NoNormal: 0x4, SingleUV: 0x8, NoPos: 0x10 };
const VX_MOVEABLE_VISIBLE = 0x2;

class Fail extends Error {}

async function inflate(b: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const w = ds.writable.getWriter();
  w.write(b as BufferSource).catch(() => {});
  w.close().catch(() => {});
  try { return new Uint8Array(await new Response(ds.readable).arrayBuffer()); } catch { throw new Fail('文件的压缩数据解不开，可能不完整'); }
}

const decodeName = (b: Uint8Array) => {
  try { return new TextDecoder('gbk').decode(b); } catch { return String.fromCharCode(...b); }
};

/** 一个状态块：DWORD 数据 + 标识符链 */
class Chunk {
  pos = 0;
  constructor(public dw: Uint32Array, public classId: number) {}
  /** 跳到标识符后面；没有返回 false */
  seek(id: number): boolean {
    let p = 0;
    for (let guard = 0; guard < 4096 && p + 1 < this.dw.length; guard++) {
      if (this.dw[p] === id) { this.pos = p + 2; return true; }
      const next = this.dw[p + 1];
      if (!next || next <= p) return false;
      p = next;
    }
    return false;
  }
  dword() { if (this.pos >= this.dw.length) throw new Fail('文件里的数据不完整'); return this.dw[this.pos++]; }
  float() { const f = new Float32Array(this.dw.buffer, this.dw.byteOffset + this.pos * 4, 1)[0]; this.pos++; return f; }
  obj(): number | null { const v = this.dword(); return v === 0xffffffff ? null : v; }
  string(): string {
    const len = this.dword();
    if (!len) return '';
    const b = new Uint8Array(this.dw.buffer, this.dw.byteOffset + this.pos * 4, Math.min(len, (this.dw.length - this.pos) * 4));
    this.pos += Math.ceil(len / 4);
    const z = b.indexOf(0);
    return decodeName(b.slice(0, z < 0 ? b.length : z));
  }
}

/** 读 .nmo；不是 Virtools 文件或者格式不支持时抛错，message 能直接给用户看 */
export async function readNmoFile(file: Uint8Array): Promise<NmoReadDoc> {
  if (file.length < 64 || String.fromCharCode(...file.slice(0, 7)) !== 'Nemo Fi') throw new Fail('这不是 Virtools 文件（.nmo / .cmo）');
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const u = (o: number) => dv.getUint32(o, true);
  const fileVersion = u(16);
  if (fileVersion < 8) throw new Fail(`这个 Virtools 文件的版本太旧（${fileVersion}），只支持版本 8（Virtools 2.1 以后）`);
  const hdrPack = u(28), dataPack = u(32), dataUnpack = u(36), mgrCount = u(40), objCount = u(44), hdrUnpack = u(60);
  if (64 + hdrPack + dataPack > file.length) throw new Fail('文件不完整');
  const hdrRaw = file.slice(64, 64 + hdrPack), dataRaw = file.slice(64 + hdrPack, 64 + hdrPack + dataPack);
  const hdr = hdrPack !== hdrUnpack ? await inflate(hdrRaw) : hdrRaw;
  const data = dataPack !== dataUnpack ? await inflate(dataRaw) : dataRaw;
  const hv = new DataView(hdr.buffer, hdr.byteOffset, hdr.byteLength), dd = new DataView(data.buffer, data.byteOffset, data.byteLength);

  // 文件头：对象表
  const entries: { cid: number; name: string }[] = [];
  let p = 0;
  for (let i = 0; i < objCount; i++) {
    if (p + 16 > hdr.length) throw new Fail('文件头不完整');
    const cid = hv.getUint32(p + 4, true), len = hv.getUint32(p + 12, true);
    entries.push({ cid, name: decodeName(hdr.slice(p + 16, p + 16 + len)) });
    p += 16 + len;
  }

  // 数据：先是管理器（GUID + 状态块），再是每个对象的状态块
  let q = 0;
  const chunkAt = (at: number, size: number): Chunk | null => {
    if (size < 8 || at + size > data.length) return null;
    const info = dd.getUint32(at, true);
    const classId = (info >>> 8) & 0xff, chunkVersion = (info >>> 16) & 0xff;
    if (chunkVersion < 4) throw new Fail('这个 Virtools 文件的数据格式太旧，读不了');
    const n = dd.getUint32(at + 4, true);
    if (8 + n * 4 > size) return null;
    const buf = new Uint32Array(n);
    for (let i = 0; i < n; i++) buf[i] = dd.getUint32(at + 8 + i * 4, true);
    return new Chunk(buf, classId);
  };
  for (let i = 0; i < mgrCount; i++) {
    if (q + 12 > data.length) throw new Fail('文件数据不完整');
    q += 8 + 4 + dd.getUint32(q + 8, true);
  }
  const chunks: (Chunk | null)[] = [];
  for (let i = 0; i < objCount; i++) {
    if (q + 4 > data.length) throw new Fail('文件数据不完整');
    const size = dd.getUint32(q, true);
    chunks.push(size ? chunkAt(q + 4, size) : null);
    q += 4 + size;
  }

  const doc: NmoReadDoc = { objects: [], meshes: new Map(), materials: new Map(), textures: new Map() };
  entries.forEach((e, i) => {
    const c = chunks[i];
    if (!c) return;
    try {
      if (e.cid === CID.TEXTURE) {
        if (c.seek(S.TEX_FILENAMES) && c.dword() > 0) { const f = c.string().split(/[\\/]/).pop()!; if (f) doc.textures.set(i, f); }
      } else if (e.cid === CID.MATERIAL) {
        if (!c.seek(S.MAT_DATA)) return;
        const argb = c.dword();
        c.dword(); c.dword(); c.dword(); c.float();
        const tex = c.obj();
        c.dword(); c.dword();
        const flags = c.dword() & 0xff;
        doc.materials.set(i, {
          name: e.name, texture: tex,
          diffuse: [((argb >>> 16) & 0xff) / 255, ((argb >>> 8) & 0xff) / 255, (argb & 0xff) / 255, (argb >>> 24) / 255],
          twoSided: !!(flags & 1), alphaBlend: !!(flags & 8), alphaTest: !!(flags & 16),
        });
      } else if (e.cid === CID.MESH) {
        doc.meshes.set(i, readMesh(c, e.name));
      } else if (e.cid === CID.OBJECT3D || e.cid === CID.ENTITY3D) {
        let mesh: number | null = null;
        if (c.seek(S.ENTITY_MESHS)) mesh = c.obj();
        if (!c.seek(S.ENTITY_DATA)) return;
        c.dword();
        const moveable = c.dword();
        const m: number[] = [];
        for (let r = 0; r < 4; r++) { for (let k = 0; k < 3; k++) m.push(c.float()); m.push(r === 3 ? 1 : 0); }
        doc.objects.push({ name: e.name, mesh, matrix: m, visible: !!(moveable & VX_MOVEABLE_VISIBLE) });
      }
    } catch (err) { if (!(err instanceof Fail)) throw err; /* 这一个对象读不了就跳过 */ }
  });
  return doc;
}

function readMesh(c: Chunk, name: string): NmoReadMesh {
  const mtls: (number | null)[] = [];
  if (c.seek(S.MESH_MATERIALS)) {
    const n = c.dword();
    for (let i = 0; i < n; i++) { mtls.push(c.obj()); c.dword(); }
  }
  let faces = new Uint16Array(0), faceMtl = new Uint16Array(0);
  if (c.seek(S.MESH_FACES)) {
    const n = c.dword();
    faces = new Uint16Array(n * 3); faceMtl = new Uint16Array(n);
    for (let f = 0; f < n; f++) {
      const a = c.dword(), b = c.dword();
      faces[f * 3] = a & 0xffff; faces[f * 3 + 1] = a >>> 16; faces[f * 3 + 2] = b & 0xffff; faceMtl[f] = b >>> 16;
    }
  }
  let pos = new Float32Array(0), nml: Float32Array | null = null, uv = new Float32Array(0);
  if (c.seek(S.MESH_VERTICES)) {
    const n = c.dword();
    if (n) {
      const flags = c.dword();
      c.dword(); // 长度
      pos = new Float32Array(n * 3);
      if (!(flags & VSF.NoPos)) for (let i = 0; i < n * 3; i++) pos[i] = c.float();
      c.pos += flags & VSF.SingleColor ? 1 : n;
      c.pos += flags & VSF.SingleSpecularColor ? 1 : n;
      if (!(flags & VSF.NoNormal)) { nml = new Float32Array(n * 3); for (let i = 0; i < n * 3; i++) nml[i] = c.float(); }
      uv = new Float32Array(n * 2);
      if (flags & VSF.SingleUV) { const a = c.float(), b = c.float(); for (let i = 0; i < n; i++) { uv[i * 2] = a; uv[i * 2 + 1] = b; } }
      else for (let i = 0; i < n * 2; i++) uv[i] = c.float();
    }
  }
  return { name, pos, nml, uv, faces, faceMtl, mtls };
}
