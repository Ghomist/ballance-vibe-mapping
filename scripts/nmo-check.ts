// 网页端 NMO 导出与 Blender + BBP 导出的对比（需要 Blender + BBP）：
//   npx tsx scripts/nmo-check.ts [map.bvm]
// 两边各导出一个 .nmo，用 BMap 读回来比较：物体（名字、网格、矩阵、组）、网格（按面展开比较几何）、材质、贴图。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportScene } from '../src/export/scene';
import { exportNmo } from '../src/export/nmo-scene';
import { migrateModel } from '../src/model/types';
// @ts-expect-error 纯 JS 模块
import { buildScene, findBlender, ROOT, TEXTURES } from './blender.mjs';

const tmp = mkdtempSync(join(tmpdir(), 'bvm-nmo-'));
let input = process.argv[2];
if (!input) {
  input = join(tmp, 'fixture.bvm');
  execFileSync('npx', ['tsx', join(ROOT, 'scripts/fixture-map.ts'), input], { shell: true });
}
const raw = JSON.parse(readFileSync(input, 'utf8'));
const model = migrateModel(raw.format === 'bvm' ? raw.model : raw);

const lib = JSON.parse(readFileSync(join(ROOT, 'public/nmo-lib.json'), 'utf8'));
const web = join(tmp, 'web.nmo'), ref = join(tmp, 'blender.nmo'), scene = join(tmp, 'scene.json');
writeFileSync(web, (await exportNmo(model, lib)).data);
writeFileSync(scene, JSON.stringify(exportScene(model)));
await buildScene(scene, { nmo: ref });
const dump = (f: string) => {
  execFileSync(findBlender(), ['-b', '--python', join(ROOT, 'scripts/blender/dump_nmo.py'), '--', f, f + '.json', '--textures', TEXTURES], { maxBuffer: 64 << 20 });
  return JSON.parse(readFileSync(f + '.json', 'utf8'));
};
const A = dump(web), B = dump(ref);

interface D {
  objects: { name: string; mesh: string | null; matrix: number[] }[];
  meshes: { name: string; pos: number[]; nml: number[]; uv: number[]; faces: number[]; faceMtl: number[]; mtls: (string | null)[] }[];
  materials: Record<string, unknown>[];
  textures: Record<string, unknown>[];
  groups: { name: string; objects: string[] }[];
}
const r = (v: number, k = 3) => (Math.round(v * 10 ** k) / 10 ** k + 0).toFixed(k);
/** 物体的规范名：Blender 的 .001 后缀与网页端的编号不同，按“类型 + 位置”比较 */
const objKey = (o: D['objects'][number]) => `${o.name.replace(/(\.\d{3}|_\d{2}_\d{2}|_\d{2}_)$/, '')}@${r(o.matrix[12], 2)},${r(o.matrix[13], 2)},${r(o.matrix[14], 2)}`;
/** 网格按面展开：每个面（材质 + 三个顶点的 位置/法线/UV），排序后比较 */
const meshSig = (d: D, name: string | null) => {
  const m = d.meshes.find((x) => x.name === name);
  if (!m) return 'none';
  const v = (i: number) => `${r(m.pos[i * 3])},${r(m.pos[i * 3 + 1])},${r(m.pos[i * 3 + 2])}|${r(m.nml[i * 3], 2)},${r(m.nml[i * 3 + 1], 2)},${r(m.nml[i * 3 + 2], 2)}|${r(m.uv[i * 2], 2)},${r(m.uv[i * 2 + 1], 2)}`;
  const faces: string[] = [];
  for (let f = 0; f < m.faces.length / 3; f++) {
    const vs = [v(m.faces[f * 3]), v(m.faces[f * 3 + 1]), v(m.faces[f * 3 + 2])];
    const k = vs.indexOf([...vs].sort()[0]);
    faces.push(`${m.mtls[m.faceMtl[f]]}:${[...vs.slice(k), ...vs.slice(0, k)].join(' ')}`);
  }
  return faces.sort().join('\n');
};
const objects = (d: D) => {
  const out = new Map<string, string>();
  for (const o of d.objects) {
    const groups = d.groups.filter((g) => g.objects.includes(o.name)).map((g) => g.name).sort();
    out.set(objKey(o), JSON.stringify({ matrix: o.matrix.map((x) => r(x)), groups, mesh: meshSig(d, o.mesh) }));
  }
  return out;
};
let bad = 0;
const fail = (msg: string) => { bad++; if (bad <= 30) console.log('✗ ' + msg); };
const oa = objects(A), ob = objects(B);
for (const [k, v] of ob) {
  if (!oa.has(k)) fail(`网页端缺少物体 ${k}`);
  else if (oa.get(k) !== v) {
    const x = JSON.parse(oa.get(k)!), y = JSON.parse(v);
    for (const f of ['matrix', 'groups', 'mesh'] as const) {
      if (JSON.stringify(x[f]) === JSON.stringify(y[f])) continue;
      if (f !== 'mesh') { fail(`${k} 的 ${f} 不同：${JSON.stringify(x[f])} ≠ ${JSON.stringify(y[f])}`); continue; }
      const xa = (x.mesh as string).split('\n'), ya = new Set((y.mesh as string).split('\n'));
      const miss = xa.filter((l) => !ya.has(l));
      fail(`${k} 的网格不同（网页 ${xa.length} 面 / Blender ${ya.size} 面，${miss.length} 面对不上），例：\n    ${miss[0]}\n    ${[...ya].find((l) => !xa.includes(l))}`);
    }
  }
}
for (const k of oa.keys()) if (!ob.has(k)) fail(`网页端多出物体 ${k}`);
const byName = (l: Record<string, unknown>[]) => new Map(l.map((x) => [x.name as string, JSON.stringify({ ...x, name: undefined })]));
for (const [what, la, lb] of [['材质', A.materials, B.materials], ['贴图', A.textures, B.textures]] as const) {
  const ma = byName(la), mb = byName(lb);
  for (const [k, v] of mb) if (ma.get(k) !== v) fail(`${what} ${k} 不同：\n    ${ma.get(k)}\n    ${v}`);
  for (const k of ma.keys()) if (!mb.has(k)) fail(`网页端多出${what} ${k}`);
}
const ga = A.groups.map((g: { name: string }) => g.name).sort().join(), gb = B.groups.map((g: { name: string }) => g.name).sort().join();
if (ga !== gb) fail(`组不同：\n    ${ga}\n    ${gb}`);
console.log(bad ? `\n${bad} 处不同` : `一致：${ob.size} 个物体，${B.materials.length} 个材质，${B.textures.length} 张贴图，${B.groups.length} 个组`);
process.exit(bad ? 1 : 0);
