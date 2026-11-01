// NMO 写入器的自检（不需要 Blender）：把导出的文件按 Virtools 的格式读回来，检查文件头、CRC、对象表与每个状态块。
// 与 BBP 导出逐项对比见 scripts/nmo-check.ts。
import lib from '../public/nmo-lib.json';
import { buildNmoDoc, exportNmo, vxMatrix } from '../src/export/nmo-scene';
import { exportScene } from '../src/export/scene';
import type { NmoLib } from '../src/export/nmo-lib';
import { placeCheckpointOnSeg, placeStartAtEnd } from '../src/model/checkpoint';
import { addObj } from '../src/model/objects';
import { blockToSeg, extendTo, normalize } from '../src/model/ops';
import { Model, emptyModel } from '../src/model/types';

type Check = (cond: boolean, msg: string) => void;

async function inflate(b: Uint8Array) {
  const ds = new DecompressionStream('deflate');
  const out = new Response(ds.readable).arrayBuffer();
  const w = ds.writable.getWriter();
  void w.write(b);
  void w.close();
  return new Uint8Array(await out);
}
function adler32(prev: number, d: Uint8Array) {
  let a = prev & 0xffff, b = prev >>> 16;
  for (const x of d) { a = (a + x) % 65521; b = (b + a) % 65521; }
  return ((b << 16) | a) >>> 0;
}

/** 读回 .nmo：对象表 + 每个对象的状态块（类 ID、DWORD 数据） */
export async function readNmo(file: Uint8Array) {
  const dv = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const u = (o: number) => dv.getUint32(o, true);
  const magic = String.fromCharCode(...file.slice(0, 7));
  const [crc, , fileVersion, , mode, hdrPack, dataPack, dataUnpack, mgrCount, objCount, , , , hdrUnpack] = Array.from({ length: 14 }, (_, i) => u(8 + i * 4));
  const head = file.slice(0, 64);
  new DataView(head.buffer).setUint32(8, 0, true);
  const hdrZ = file.slice(64, 64 + hdrPack), dataZ = file.slice(64 + hdrPack, 64 + hdrPack + dataPack);
  const crcOk = adler32(adler32(adler32(0, head), hdrZ), dataZ) === crc;
  const hdr = await inflate(hdrZ), data = await inflate(dataZ);
  const hv = new DataView(hdr.buffer), dd = new DataView(data.buffer);
  const objects: { id: number; cid: number; name: string; fileIndex: number; classId: number; dw: Uint32Array }[] = [];
  let p = 0;
  for (let i = 0; i < objCount; i++) {
    const len = hv.getUint32(p + 12, true);
    objects.push({ id: hv.getUint32(p, true), cid: hv.getUint32(p + 4, true), fileIndex: hv.getUint32(p + 8, true), name: String.fromCharCode(...hdr.slice(p + 16, p + 16 + len)), classId: 0, dw: new Uint32Array() });
    p += 16 + len;
  }
  const tail = [hv.getUint32(p, true), hv.getUint32(p + 4, true), hv.getUint32(p + 8, true)];
  let q = 0, chunksOk = true;
  for (const o of objects) {
    const size = dd.getUint32(q, true);
    // FileIndex 指向未压缩布局里这个对象的长度字段
    if (o.fileIndex !== 64 + hdrUnpack + q) chunksOk = false;
    o.classId = data[q + 5];
    const n = dd.getUint32(q + 8, true);
    if (size !== 8 + n * 4) chunksOk = false;
    o.dw = new Uint32Array(data.slice(q + 12, q + 12 + n * 4).buffer);
    q += 4 + size;
  }
  return {
    magic, fileVersion, mode, crcOk, mgrCount, tail, chunksOk: chunksOk && q === dataUnpack,
    sizesOk: hdr.length === hdrUnpack && data.length === dataUnpack && 64 + hdrPack + dataPack === file.length,
    objects,
  };
}

/** 状态块里的标识符链：每个标识符的位置 */
function identifiers(dw: Uint32Array) {
  const out = new Map<number, number>();
  let pos = 0;
  for (let guard = 0; guard < 100 && pos + 1 < dw.length; guard++) {
    out.set(dw[pos], pos);
    const next = dw[pos + 1];
    if (!next) break;
    pos = next;
  }
  return out;
}

function sampleMap(): Model {
  const m = emptyModel();
  const s = blockToSeg(m, 1, 0);
  extendTo(m, s, 'b', 60);
  placeStartAtEnd(m, s, 'a');
  placeCheckpointOnSeg(m, s, 30);
  normalize(m);
  addObj(m, 'P_Box', 20, 2.5, 2.6);
  addObj(m, 'P_Extra_Point', 45, 2.5, 2.5);
  addObj(m, 'PE_Balloon', 55, 2.5, 0);
  normalize(m);
  return m;
}

export async function nmoScenarios(check: Check, scenario: (name: string, fn: () => void) => void) {
  const m = sampleMap();
  const { data } = await exportNmo(m, lib as unknown as NmoLib);
  const f = await readNmo(data);
  scenario('nmo: 文件头与 CRC', () => {
    check(f.magic === 'Nemo Fi', '文件头应为 Nemo Fi');
    check(f.fileVersion === 8 && f.mode === 8, '文件版本 8、整体压缩');
    check(f.crcOk, 'CRC（adler32）应正确');
    check(f.sizesOk, '压缩前后大小应与文件头一致');
    check(f.chunksOk, '每个对象的数据位置、状态块长度应一致');
    check(f.mgrCount === 0 && f.tail.join() === '0,4,0', '没有管理器数据、插件依赖与内含文件');
  });
  scenario('nmo: 对象与组', () => {
    const names = f.objects.map((o) => o.name);
    const doc = buildNmoDoc(exportScene(m), lib as unknown as NmoLib);
    check(f.objects.length === doc.groups.length + doc.objects.length + doc.meshes.length + doc.materials.length + doc.textures.length, '对象数');
    for (const g of ['Sector_01', 'Sector_02', 'PS_Levelstart', 'PE_Levelende', 'PC_Checkpoints', 'PR_Resetpoints', 'Phys_Floors', 'P_Box', 'P_Extra_Point']) check(names.includes(g), `应有组 ${g}`);
    check(names.includes('PS_FourFlames_01') && names.includes('PC_TwoFlames_01') && names.includes('PR_Resetpoint_02'), '起点、盘点、重生点按规范命名');
    check(names.includes('P_Box_01_01') && names.includes('P_Extra_Point_02_01'), '机关按小节命名');
    const sector2 = f.objects.find((o) => o.name === 'Sector_02')!;
    const members = Array.from(sector2.dw.slice(3)).map((i) => f.objects[i].name);
    check(members.length === 1 && members[0] === 'P_Extra_Point_02_01', '第二小节的组只含第二小节的机关');
    const floors = f.objects.find((o) => o.name === 'Phys_Floors')!;
    check(Array.from(floors.dw.slice(3)).every((i) => f.objects[i].cid === 41), '组里都是 3D 物体');
  });
  scenario('nmo: 所有挡块合成一个物体（分开会导致声音出问题）', () => {
    const mm = emptyModel();
    addObj(mm, 'P_Modul_25', 0, 0, 0, 0); addObj(mm, 'P_Modul_30', 30, 0, 0, 0); addObj(mm, 'P_Modul_19', 60, 0, 0, 90); addObj(mm, 'P_Modul_37', 90, 0, 0, 0);
    const doc = buildNmoDoc(exportScene(mm), lib as unknown as NmoLib);
    const g = doc.groups.find((x) => x.name === 'Phys_FloorStopper');
    check(!!g && g.objects.length === 1, `Phys_FloorStopper 组里只有一个物体（${g?.objects.length}）`);
  });
  scenario('nmo: 网格与材质', () => {
    const floor = f.objects.find((o) => o.name === 'A_Floor_BVM_01');
    check(!!floor && floor.cid === 41 && floor.classId === 33, '路面物体');
    const mesh = floor && f.objects[floor.dw[identifiers(floor.dw).get(0x4000)! + 2]];
    check(!!mesh && mesh.cid === 32 && mesh.name === 'A_Floor_BVM_01', '路面物体引用自己的网格');
    if (mesh) {
      const ids = identifiers(mesh.dw);
      const mp = ids.get(0x100000)!, vp = ids.get(0x20000)!, fp = ids.get(0x10000)!;
      const slots = mesh.dw[mp + 2];
      check(slots >= 2, '路面网格至少有顶面、侧面两个材质');
      for (let i = 0; i < slots; i++) check(f.objects[mesh.dw[mp + 3 + i * 2]]?.cid === 30, '材质槽引用材质');
      const vtx = mesh.dw[vp + 2], faces = mesh.dw[fp + 2];
      check(vtx > 0 && faces > 0, '有顶点和面');
      let okIdx = true;
      for (let i = 0; i < faces; i++) {
        const a = mesh.dw[fp + 3 + i * 2], b = mesh.dw[fp + 4 + i * 2];
        if ((a & 0xffff) >= vtx || a >>> 16 >= vtx || (b & 0xffff) >= vtx || b >>> 16 >= slots) okIdx = false;
      }
      check(okIdx, '面的顶点、材质下标都在范围内');
    }
    const tex = f.objects.filter((o) => o.cid === 31);
    check(tex.length > 0 && tex.every((t) => identifiers(t.dw).has(0x10000)), '贴图只存文件名');
  });
  scenario('nmo: 矩阵换算', () => {
    // Blender 里绕 Z 转 90°：+X → +Y（Blender）= +Z（Virtools）
    const mx = vxMatrix([1, 2, 3], 90);
    const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;
    check(near(mx[0], 0) && near(mx[2], 1), 'X 轴转到 Virtools 的 Z');
    check(near(mx[5], 1), 'Y 轴（Virtools 朝上）不变');
    check(mx[12] === 1 && mx[13] === 3 && mx[14] === 2, '位置的 Y、Z 互换');
  });
}
