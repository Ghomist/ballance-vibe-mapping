// 网页端导出 .nmo：把场景描述（exportScene）配合素材库（nmo-lib.json）组装成 Virtools 文档，再交给 writeNmo。
// 处理流程与 Blender + BBP 一致：
//   路面 / 钢轨 / 挡块：合并重合顶点（0.0001）→ 法线（路面平直、钢轨平滑）→ 钢轨反射 UV → 转 Virtools 坐标 → 去重顶点；
//   资产库物体、机关占位符：照搬素材库里的网格，按位置 / 朝向摆放；
//   组：Sector_01..N 先建好，物体按 BBP 的命名规范归组。
import { exportScene, SceneDesc, SceneMesh } from './scene';
import { NmoDoc, NmoDocMesh, NmoDocObject, writeNmo } from './nmo';
import { loadNmoLib, NmoLib } from './nmo-lib';
import { Model } from '../model/types';
import { stretchTriUV } from '../view/uvstretch';
import { cutBoxes } from '../view/clipmesh';

const MESH_GROUPS: Record<SceneMesh['kind'], string[]> = {
  floor: ['Phys_Floors', 'Sound_HitID_01', 'Sound_RollID_01', 'Shadow'],
  rail: ['Phys_FloorRails', 'Sound_HitID_03', 'Sound_RollID_03'],
  stopper: ['Phys_FloorStopper'],
  zone: ['DepthTestCubes'],
};
const MESH_PREFIX: Record<SceneMesh['kind'], string> = { floor: 'A_Floor_', rail: 'A_Rail_', stopper: 'A_Stopper_', zone: 'DepthTestCubes_' };
const ASSET_PREFIX = { floor: 'A_Floor_', rail: 'A_Rail_', deco: 'D_' } as const;

/** 不投影子的资产库物体：特殊路块 15、木制 U 形槽（原版里就不在 Shadow 组） */
const NO_SHADOW = new Set(['Modul_15', 'Modul_11']);
/** 资产库物体导出时的组：不投影子的去掉 Shadow，其余照资产库 */
export function assetGroups(name: string, groups: string[]): string[] {
  return NO_SHADOW.has(name) ? groups.filter((g) => g !== 'Shadow') : groups;
}

export const sectorGroup = (i: number) => (i === 9 ? 'Sector_9' : `Sector_${String(i).padStart(2, '0')}`);
const two = (i: number) => String(i).padStart(2, '0');

/** Blender 坐标（Z 朝上）下的 平移 · 绕 Z 旋转 · 绕 Y 俯仰，转成 Virtools 世界矩阵（按行） */
export function vxMatrix(pos: [number, number, number], rotZ: number, pitch = 0, rot3?: number[]): number[] {
  const z = (rotZ * Math.PI) / 180, y = (pitch * Math.PI) / 180;
  const cz = Math.cos(z), sz = Math.sin(z), cy = Math.cos(y), sy = Math.sin(y);
  // B = Rz · Ry（列向量约定）；给了完整朝向就直接用
  const B = rot3 ? [rot3.slice(0, 3), rot3.slice(3, 6), rot3.slice(6, 9)] : [
    [cz * cy, -sz, cz * sy],
    [sz * cy, cz, sz * sy],
    [-sy, 0, cy],
  ];
  const s = [0, 2, 1];
  const m: number[] = [];
  for (let i = 0; i < 3; i++) { for (let j = 0; j < 3; j++) m.push(B[s[j]][s[i]]); m.push(0); }
  m.push(pos[0], pos[2], pos[1], 1);
  return m;
}

/** 路面 / 钢轨 / 挡块网格：Blender 坐标的三角形 → Virtools 网格（材质槽为编辑器材质名） */
export function bakeMesh(m: SceneMesh): Omit<NmoDocMesh, 'mtls' | 'name' | 'litMode'> & { mtls: string[] } {
  const F = Math.fround;
  // 1. 顶点（合并 0.0001 内的重合顶点）
  const vx: number[] = [];
  const cells = new Map<string, number[]>();
  const EPS = 1e-4, Q = 1e-3;
  const vert = (x: number, y: number, z: number) => {
    x = F(x); y = F(y); z = F(z);
    const kx = Math.floor(x / Q), ky = Math.floor(y / Q), kz = Math.floor(z / Q);
    for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) for (let c = -1; c <= 1; c++) {
      for (const i of cells.get(`${kx + a},${ky + b},${kz + c}`) ?? []) {
        if (Math.abs(vx[i * 3] - x) <= EPS && Math.abs(vx[i * 3 + 1] - y) <= EPS && Math.abs(vx[i * 3 + 2] - z) <= EPS) return i;
      }
    }
    const i = vx.length / 3;
    vx.push(x, y, z);
    const k = `${kx},${ky},${kz}`;
    const l = cells.get(k);
    if (l) l.push(i); else cells.set(k, [i]);
    return i;
  };
  // 2. 面（退化的丢掉）：顶点、UV、材质槽
  const faces: { v: [number, number, number]; uv: number[]; mtl: number }[] = [];
  m.parts.forEach((part, mi) => {
    const { pos, uv } = part;
    for (let t = 0; t + 8 < pos.length; t += 9) {
      const v = [0, 1, 2].map((k) => vert(pos[t + k * 3], pos[t + k * 3 + 1], pos[t + k * 3 + 2])) as [number, number, number];
      if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
      const b = (t / 3) * 2;
      faces.push({ v, uv: uv ? [0, 1, 2].flatMap((k) => [F(uv[b + k * 2]), F(uv[b + k * 2 + 1])]) : [0, 0, 0, 0, 0, 0], mtl: mi });
    }
  });
  // 3. 面法线；平滑网格按角度加权得到顶点法线
  const fn = faces.map(({ v }) => {
    const [a, b, c] = v.map((i) => [vx[i * 3], vx[i * 3 + 1], vx[i * 3 + 2]]);
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]];
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    return [n[0] / l, n[1] / l, n[2] / l];
  });
  let vn: number[] | null = null;
  if (m.smooth) {
    vn = new Array(vx.length).fill(0);
    faces.forEach(({ v }, f) => {
      for (let k = 0; k < 3; k++) {
        const p = v[k], q = v[(k + 1) % 3], r = v[(k + 2) % 3];
        const e1 = [vx[q * 3] - vx[p * 3], vx[q * 3 + 1] - vx[p * 3 + 1], vx[q * 3 + 2] - vx[p * 3 + 2]];
        const e2 = [vx[r * 3] - vx[p * 3], vx[r * 3 + 1] - vx[p * 3 + 1], vx[r * 3 + 2] - vx[p * 3 + 2]];
        const l1 = Math.hypot(e1[0], e1[1], e1[2]), l2 = Math.hypot(e2[0], e2[1], e2[2]);
        const ang = l1 && l2 ? Math.acos(Math.max(-1, Math.min(1, (e1[0] * e2[0] + e1[1] * e2[1] + e1[2] * e2[2]) / (l1 * l2)))) : 0;
        for (let d = 0; d < 3; d++) vn![p * 3 + d] += fn[f][d] * ang;
      }
    });
    for (let i = 0; i < vn.length; i += 3) {
      const l = Math.hypot(vn[i], vn[i + 1], vn[i + 2]) || 1;
      vn[i] /= l; vn[i + 1] /= l; vn[i + 2] /= l;
    }
  }
  const loopNormal = (f: number, k: number) => {
    const n = vn ? [vn[faces[f].v[k] * 3], vn[faces[f].v[k] * 3 + 1], vn[faces[f].v[k] * 3 + 2]] : fn[f];
    return n.map(F);
  };
  // 4. 钢轨：BBP 的反射贴图 UV（照搬它的逐分量乘法）
  if (m.kind === 'rail') {
    faces.forEach((face, f) => {
      for (let k = 0; k < 3; k++) {
        const i = face.v[k];
        const pt = [vx[i * 3], vx[i * 3 + 2], vx[i * 3 + 1]];
        const n0 = loopNormal(f, k);
        let n = [n0[0], n0[2], n0[1]];
        const nl = Math.hypot(n[0], n[1], n[2]) || 1;
        n = n.map((c) => c / nl);
        let p = [-pt[0], -pt[1], -pt[2]];
        const pl = Math.hypot(p[0], p[1], p[2]) || 1;
        p = p.map((c) => c / pl);
        let b = p.map((c, d) => 2 * c * n[d] * n[d] - c);
        const bl = Math.hypot(b[0], b[1], b[2]) || 1;
        b = b.map((c) => c / bl);
        face.uv[k * 2] = F((b[0] + 1) / 2);
        face.uv[k * 2 + 1] = F(-(b[2] + 1) / 2);
      }
    });
  }
  // 5. 转 Virtools 坐标（Y、Z 互换，V 取反，面的顶点顺序反过来），按（位置、法线、UV）去重
  const pos: number[] = [], nml: number[] = [], uv: number[] = [], idx: number[] = [], faceMtl: number[] = [];
  const seen = new Map<string, number>();
  faces.forEach((face, f) => {
    for (const k of [2, 1, 0]) {
      const i = face.v[k];
      const n = loopNormal(f, k);
      const P = [vx[i * 3], vx[i * 3 + 2], vx[i * 3 + 1]], N = [n[0], n[2], n[1]], U = [face.uv[k * 2], F(-face.uv[k * 2 + 1])];
      const key = [...P, ...N, ...U].join(',');
      let j = seen.get(key);
      if (j === undefined) {
        j = pos.length / 3;
        seen.set(key, j);
        pos.push(...P); nml.push(...N); uv.push(...U);
      }
      idx.push(j);
    }
    faceMtl.push(face.mtl);
  });
  return { pos, nml, uv, faces: idx, faceMtl, mtls: m.parts.map((p) => p.mat) };
}

/** 场景描述 + 素材库 → Virtools 文档 */
export function buildNmoDoc(desc: SceneDesc, lib: NmoLib): NmoDoc {
  const doc: NmoDoc = { groups: [], objects: [], meshes: [], materials: [], textures: [] };
  const groupIdx = new Map<string, number>(), meshIdx = new Map<string, number>(), mtlIdx = new Map<string, number>(), texIdx = new Map<string, number>();
  const names = new Set<string>();
  const unique = (name: string) => {
    let n = name, k = 0;
    while (names.has(n)) n = `${name}.${String(++k).padStart(3, '0')}`;
    names.add(n);
    return n;
  };
  const group = (name: string) => {
    let i = groupIdx.get(name);
    if (i === undefined) { i = doc.groups.length; doc.groups.push({ name, objects: [] }); groupIdx.set(name, i); }
    return doc.groups[i];
  };
  const texture = (name: string | null) => {
    if (!name) return null;
    let i = texIdx.get(name);
    if (i === undefined) {
      const t = lib.textures[name];
      if (!t?.file) return null;
      i = doc.textures.length;
      doc.textures.push({ name, file: t.file, size: t.size, saveOptions: t.saveOptions, videoFormat: t.videoFormat });
      texIdx.set(name, i);
    }
    return i;
  };
  const material = (name: string | null) => {
    if (!name) return null;
    let i = mtlIdx.get(name);
    if (i === undefined) {
      const m = lib.materials[name];
      if (!m) return null;
      i = doc.materials.length;
      doc.materials.push({ ...m, name, texture: null });
      mtlIdx.set(name, i);
      doc.materials[i].texture = texture(m.texture);
    }
    return i;
  };
  const libMesh = (name: string) => {
    let i = meshIdx.get(name);
    if (i === undefined) {
      const m = lib.meshes[name];
      i = doc.meshes.length;
      doc.meshes.push({ name, litMode: m.litMode, pos: m.pos, nml: m.nml, uv: m.uv, faces: m.faces, faceMtl: m.faceMtl, mtls: [] });
      meshIdx.set(name, i);
      doc.meshes[i].mtls = m.mtls.map(material);
    }
    return i;
  };
  const addObject = (o: NmoDocObject, groups: string[]) => {
    const i = doc.objects.length;
    doc.objects.push(o);
    for (const g of groups) group(g).objects.push(i);
  };

  // 小节组先按顺序建好（游戏靠 Sector_XX 是否存在判断小节数）
  for (let i = 1; i <= Math.max(1, desc.sectors); i++) group(sectorGroup(i));

  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  for (const m of desc.meshes) {
    const baked = bakeMesh(m);
    if (!baked.faces.length) continue;
    const name = unique(m.name.startsWith(MESH_PREFIX[m.kind]) ? m.name : MESH_PREFIX[m.kind] + m.name);
    const mi = doc.meshes.length;
    doc.meshes.push({ ...baked, name, litMode: 1, mtls: baked.mtls.map((k) => material(lib.floorMaterials[k] ?? null)) });
    // 死亡区：导出时隐藏（游戏只看它的包围盒）
    addObject({ name, mesh: mi, matrix: identity, ...(m.kind === 'zone' ? { visible: false } : {}) }, MESH_GROUPS[m.kind]);
  }
  /** 拉伸过的木制件：复制一份网格，UV 按三角形补偿成平铺（顶点拆开不共用；Virtools 坐标里 Blender 的 Y 是第 3 个分量） */
  const stretchedMesh = (name: string, s: [number, number]) => {
    const key = `${name}@${s[0]},${s[1]}`;
    let i = meshIdx.get(key);
    if (i !== undefined) return i;
    const m = lib.meshes[name];
    const pos: number[] = [], nml: number[] = [], uv: number[] = [], faces: number[] = [];
    for (let f = 0; f * 3 < m.faces.length; f++) {
      const vi = [0, 1, 2].map((k) => m.faces[f * 3 + k]);
      const p = vi.map((v) => [m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]]);
      const u = stretchTriUV(p, vi.map((v) => [m.uv[v * 2], m.uv[v * 2 + 1]]), s[0], s[1], 0, 2);
      vi.forEach((v, k) => { pos.push(...p[k]); nml.push(m.nml[v * 3], m.nml[v * 3 + 1], m.nml[v * 3 + 2]); uv.push(...u[k]); faces.push(f * 3 + k); });
    }
    i = doc.meshes.length;
    doc.meshes.push({ name: unique(`${name}_Stretch`), litMode: m.litMode, pos, nml, uv, faces, faceMtl: [...m.faceMtl], mtls: [] });
    meshIdx.set(key, i);
    doc.meshes[i].mtls = m.mtls.map(material);
    return i;
  };
  /** 裁掉一部分的模型（盘点路面去掉延伸路）：每个面拆开、按本地 x 裁剪，材质槽照旧（Virtools 坐标里 x 不变） */
  const croppedMesh = (name: string, c: [number, number, number, number][]) => {
    const key = `${name}#${JSON.stringify(c)}`;
    let i = meshIdx.get(key);
    if (i !== undefined) return i;
    const m = lib.meshes[name];
    const pos: number[] = [], nml: number[] = [], uv: number[] = [], faces: number[] = [], faceMtl: number[] = [];
    for (let f = 0; f * 3 < m.faces.length; f++) {
      const vi = [0, 1, 2].map((k) => m.faces[f * 3 + k]);
      const r = cutBoxes({ pos: vi.flatMap((v) => [m.pos[v * 3], m.pos[v * 3 + 1], m.pos[v * 3 + 2]]), uv: vi.flatMap((v) => [m.uv[v * 2], m.uv[v * 2 + 1]]), nrm: vi.flatMap((v) => [m.nml[v * 3], m.nml[v * 3 + 1], m.nml[v * 3 + 2]]) }, c, 2);
      for (let k = 0; k * 3 < r.pos.length; k++) { faces.push(pos.length / 3); pos.push(...r.pos.slice(k * 3, k * 3 + 3)); nml.push(...r.nrm!.slice(k * 3, k * 3 + 3)); uv.push(...r.uv.slice(k * 2, k * 2 + 2)); if (k % 3 === 2) faceMtl.push(m.faceMtl[f]); }
    }
    i = doc.meshes.length;
    doc.meshes.push({ name: unique(`${name}_Crop`), litMode: m.litMode, pos, nml, uv, faces, faceMtl, mtls: [] });
    meshIdx.set(key, i);
    doc.meshes[i].mtls = m.mtls.map(material);
    return i;
  };
  for (const a of desc.assets) {
    const src = lib.assets[a.asset];
    if (!src) continue;
    const mesh = a.uvStretch ? stretchedMesh(src.mesh, a.uvStretch) : a.crop ? croppedMesh(src.mesh, a.crop) : libMesh(src.mesh);
    addObject({ name: unique(ASSET_PREFIX[a.kind] + a.asset), mesh, matrix: vxMatrix(a.pos, a.rotZ, a.pitch, a.rot3) }, assetGroups(a.asset, src.groups));
  }
  const counters = new Map<string, number>();
  for (const e of desc.elements) {
    const src = lib.elements[e.type];
    if (!src) continue;
    const sector = e.sector ?? 1;
    let name: string, groups: string[];
    switch (e.type) {
      case 'PS_FourFlames': name = 'PS_FourFlames_01'; groups = ['PS_Levelstart']; break;
      case 'PE_Balloon': name = 'PE_Balloon_01'; groups = ['PE_Levelende']; break;
      case 'PC_TwoFlames': name = `PC_TwoFlames_${two(sector)}`; groups = ['PC_Checkpoints']; break;
      case 'PR_Resetpoint': name = `PR_Resetpoint_${two(sector)}`; groups = ['PR_Resetpoints']; break;
      default: {
        const k = `${e.type}_${two(sector)}`;
        const n = (counters.get(k) ?? 0) + 1;
        counters.set(k, n);
        name = `${k}_${two(n)}`;
        groups = [e.type, sectorGroup(sector)];
      }
    }
    addObject({ name: unique(name), mesh: libMesh(src.mesh), matrix: vxMatrix(e.pos, e.rotZ, 0, e.rot3) }, groups);
  }
  return doc;
}

/** 地图 → .nmo 文件内容（网页端，不需要 Blender） */
export async function exportNmo(m: Model, lib?: NmoLib): Promise<{ data: Uint8Array; warnings: string[] }> {
  const desc = exportScene(m);
  const doc = buildNmoDoc(desc, lib ?? (await loadNmoLib()));
  return { data: await writeNmo(doc), warnings: desc.warnings };
}
