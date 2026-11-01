// 生成网页端 NMO 导出用的素材库 public/nmo-lib.json：
//   让 Blender + BBP 导出一个“目录”关卡（所有资产库物体、所有机关占位符、每种路面 / 钢轨 / 挡块材质各一个三角形），
//   再用 BMap 把这个 .nmo 读回来，留下网格、材质、贴图和组。网页导出时直接照搬这些数据，结果与 BBP 导出一致。
//
//   npx tsx scripts/build-nmo-lib.ts      （需要 Blender + BBP、BallanceAssets.blend、Ballance 贴图目录）
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SceneDesc, SceneMesh } from '../src/export/scene';
import { assetKind, ELEMENT_TYPES, FLOOR_MATERIALS } from '../src/export/scene';
import type { NmoLib } from '../src/export/nmo-lib';
// @ts-expect-error 纯 JS 模块
import { ASSET_OBJECTS } from './asset-list.mjs';
// @ts-expect-error 纯 JS 模块
import { buildScene, findBlender, ROOT, TEXTURES } from './blender.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'bvm-lib-'));
const tri = (i: number) => [i * 10, 0, 0, i * 10 + 1, 0, 0, i * 10, 1, 0];
const meshes: SceneMesh[] = [
  { name: 'A_Floor_BVM_01', kind: 'floor', parts: FLOOR_MATERIALS.map((mat, i) => ({ mat, pos: tri(i), uv: [0, 0, 1, 0, 0, 1] })) },
  { name: 'A_Rail_BVM_01', kind: 'rail', smooth: true, parts: [{ mat: 'Rail', pos: tri(0) }] },
  { name: 'A_Stopper_BVM_01', kind: 'stopper', parts: [{ mat: 'Stopper', pos: tri(0), uv: [0, 0, 1, 0, 0, 1] }] },
];
const desc: SceneDesc = {
  format: 'bvm-scene', version: 1, sectors: 1, meshes,
  assets: (ASSET_OBJECTS as string[]).map((asset) => ({ asset, kind: assetKind(asset), pos: [0, 0, 0], rotZ: 0 })),
  elements: ELEMENT_TYPES.map((type) => ({ type, sector: 1, pos: [0, 0, 0], rotZ: 0 })),
  warnings: [],
};
const scene = join(tmp, 'catalog.json'), nmo = join(tmp, 'catalog.nmo'), dump = join(tmp, 'catalog.dump.json');
writeFileSync(scene, JSON.stringify(desc));
await buildScene(scene, { nmo });
execFileSync(findBlender(), ['-b', '--python', join(ROOT, 'scripts/blender/dump_nmo.py'), '--', nmo, dump, '--textures', TEXTURES], { maxBuffer: 64 << 20 });

interface Dump {
  textures: (NmoLib['textures'][string] & { name: string })[];
  materials: (NmoLib['materials'][string] & { name: string })[];
  meshes: (NmoLib['meshes'][string] & { name: string })[];
  objects: { name: string; mesh: string | null }[];
  groups: { name: string; objects: string[] }[];
}
const d: Dump = JSON.parse(readFileSync(dump, 'utf8'));
const groupsOf = (obj: string) => d.groups.filter((g) => g.objects.includes(obj)).map((g) => g.name);
const meshOf = (obj: string) => d.objects.find((o) => o.name === obj)?.mesh ?? null;
const r6 = (v: number) => Math.round(v * 1e6) / 1e6;

const lib: NmoLib = { version: 1, textures: {}, materials: {}, meshes: {}, assets: {}, elements: {}, floorMaterials: {} };
for (const { name, ...t } of d.textures) lib.textures[name] = t;
for (const { name, ...m } of d.materials) lib.materials[name] = m;
for (const { name, ...m } of d.meshes) {
  if (/_BVM_/.test(name)) continue; // 目录里的示意三角形，只用来带出材质
  lib.meshes[name] = { ...m, pos: m.pos.map(r6), nml: m.nml.map(r6), uv: m.uv.map(r6) };
}
// 资产库物体：网格 + 组（物体名是 前缀 + 资产名）
for (const a of desc.assets) {
  const obj = d.objects.find((o) => o.name.replace(/^(A_Floor_|A_Rail_|D_)/, '') === a.asset);
  if (!obj?.mesh) throw new Error(`目录关卡里没有资产 ${a.asset}`);
  lib.assets[a.asset] = { mesh: obj.mesh, groups: groupsOf(obj.name).filter((g) => !/^Sector_/.test(g)) };
}
// 机关占位符：网格（组按命名规范生成）
for (const type of ELEMENT_TYPES) {
  const obj = d.objects.find((o) => o.name.startsWith(type + '_') || o.name.startsWith(type.replace(/^P_/, 'P_') + '_'));
  const mesh = obj ? meshOf(obj.name) : null;
  if (!mesh) throw new Error(`目录关卡里没有机关 ${type}`);
  lib.elements[type] = { mesh };
}
// 路面 / 钢轨 / 挡块：编辑器里的材质名 → 导出后的材质名（三角形按 FLOOR_MATERIALS 的顺序排列）
const floorMesh = d.meshes.find((m) => m.name === 'A_Floor_BVM_01')!;
for (const [k, mat] of FLOOR_MATERIALS.entries()) {
  const f = floorMesh.faceMtl.find((_, i) => {
    const x = floorMesh.pos[floorMesh.faces[i * 3] * 3];
    return Math.floor(x / 10 + 1e-6) === k;
  });
  lib.floorMaterials[mat] = floorMesh.mtls[f ?? -1]!;
}
lib.floorMaterials.Rail = d.meshes.find((m) => m.name === 'A_Rail_BVM_01')!.mtls[0]!;
lib.floorMaterials.Stopper = d.meshes.find((m) => m.name === 'A_Stopper_BVM_01')!.mtls[0]!;
// 只保留用到的网格、材质、贴图
const usedMeshes = new Set([...Object.values(lib.assets).map((a) => a.mesh), ...Object.values(lib.elements).map((e) => e.mesh)]);
for (const k of Object.keys(lib.meshes)) if (!usedMeshes.has(k)) delete lib.meshes[k];
const usedMtls = new Set([...Object.values(lib.meshes).flatMap((m) => m.mtls), ...Object.values(lib.floorMaterials)]);
for (const k of Object.keys(lib.materials)) if (!usedMtls.has(k)) delete lib.materials[k];
const usedTex = new Set(Object.values(lib.materials).map((m) => m.texture));
for (const k of Object.keys(lib.textures)) if (!usedTex.has(k)) delete lib.textures[k];

const out = join(ROOT, 'public/nmo-lib.json');
writeFileSync(out, JSON.stringify(lib));
console.log(`已生成 ${out}：${Object.keys(lib.meshes).length} 个网格，${Object.keys(lib.materials).length} 个材质，${Object.keys(lib.textures).length} 张贴图`);
