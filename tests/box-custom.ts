// 导入的自定义模型：跟着地图码走、导出进 NMO、能从 NMO 读回来。
import lib from '../public/nmo-lib.json';
import { type CustomModel, customModel, finishModel, modelsUsed, registerModel } from '../src/box/custom-model';
import { customAssets, exportBoxScene } from '../src/box/export';
import { decodeShare, encodeShare } from '../src/box/share';
import type { Doc } from '../src/box/types';
import { assetInfo } from '../src/box/asset-info';
import { buildNmoDoc } from '../src/export/nmo-scene';
import { writeNmo } from '../src/export/nmo';
import type { NmoLib } from '../src/export/nmo-lib';
import { readNmoFile } from '../src/export/nmo-read';

type Check = (cond: boolean, msg: string) => void;
type Scenario = (name: string, fn: () => void | Promise<void>) => void;

/** 一个 2×4×1 的盒子（12 个三角形），两种材质 */
function boxModel(label: string): CustomModel {
  const v = (x: number, y: number, z: number) => [x * 2, y * 4, z + 10];
  const quads = [[[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]], [[1, 1, 0], [0, 1, 0], [0, 1, 1], [1, 1, 1]], [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]]];
  const parts = [0, 1].map((k) => ({ pos: [] as number[], uv: [] as number[], nrm: [] as number[], color: [k, 0.5, 0.25] as [number, number, number], ...(k ? { tex: 'Floor_Side.bmp' } : {}) }));
  quads.forEach((q, i) => {
    const p = parts[i % 2];
    for (const t of [0, 1, 2, 0, 2, 3]) { p.pos.push(...v(q[t][0], q[t][1], q[t][2])); p.uv.push(q[t][0], q[t][1]); p.nrm.push(0, 0, 1); }
  });
  return finishModel(label, parts, []);
}

export function boxCustomScenarios(check: Check, scenario: Scenario) {
  scenario('导入模型：原点在底面中心，包围盒对', () => {
    const m = boxModel('盒子');
    check(m.min.join() === '-1,-2,0' && m.max.join() === '1,2,1', `包围盒 ${m.min} ~ ${m.max}`);
    const name = registerModel(m);
    check(registerModel(boxModel('盒子')) === name, '同一个模型导入两次是同一个编号');
    check(assetInfo(name)?.label === '盒子' && assetInfo(name)!.stretch === true, '素材信息来自模型');
  });

  scenario('导入模型：地图码带着模型走，旧地图码照常解开', async () => {
    const name = registerModel(boxModel('码里的盒子'));
    const doc: Doc = { elems: { 1: { id: 1, kind: 'asset', name, x: 3, y: 4, z: 5, rot: 1, phys: 'wood' } }, nextId: 2 };
    const code = await encodeShare(doc);
    check(code.length > 100, '模型数据进了地图码');
    const back = await decodeShare(code);
    const e = back.elems[1];
    check(e.kind === 'asset' && e.name === name && e.phys === 'wood', '元素和导出类型原样回来');
    check(!('models' in back), '解开的文档里不留模型数据（登记到登记表里）');
    check(!!customModel(name), '模型登记了');
    // 没有导入模型的地图码不带尾巴
    const plain = await encodeShare({ elems: { 1: { id: 1, kind: 'asset', name: 'WoodPlate', x: 0, y: 0, z: 0, rot: 0 } }, nextId: 2 });
    check((await decodeShare(plain)).elems[1].kind === 'asset', '普通地图码照常');
    check(!!modelsUsed([e]) && !modelsUsed([{ kind: 'asset', name: 'WoodPlate' }]), '只收集用到的导入模型');
  });

  scenario('导入模型：导出进 NMO，读回来物体、网格、组都对', async () => {
    const name = registerModel(boxModel('Crate'));
    const doc: Doc = { elems: { 1: { id: 1, kind: 'asset', name, x: 10, y: 0, z: 0, rot: 0, phys: 'floor' }, 2: { id: 2, kind: 'asset', name, x: -10, y: 0, z: 0, rot: 2 } }, nextId: 3 };
    const desc = exportBoxScene(doc);
    const nmo = buildNmoDoc(desc, customAssets(desc, lib as unknown as NmoLib));
    // 同样的网格之前以「盒子」导入过：编号相同，沿用先登记的名字（中文名字导出成 Model_编号）
    const key = name.slice(7);
    const objs = nmo.objects.filter((o) => o.name.includes(key));
    check(objs.length === 2, `两个物体：${nmo.objects.map((o) => o.name).join(', ')}`);
    const floors = nmo.groups.find((g) => g.name === 'Phys_Floors')!;
    check(floors.objects.some((i) => nmo.objects[i].name === `A_Floor_Model_${key}`) && !floors.objects.some((i) => nmo.objects[i].name.startsWith('D_')), '路面进 Phys_Floors，装饰不进');
    const r = await readNmoFile(await writeNmo(nmo));
    const o = r.objects.find((x) => x.name === `A_Floor_Model_${key}`)!;
    check(!!o && o.mesh !== null && r.meshes.get(o.mesh)!.faces.length === 36, '读回来 12 个三角形');
    check(Math.abs(o.matrix[12] - 10) < 1e-4, '位置对（Virtools x）');
    const m = r.meshes.get(o.mesh!)!;
    const tex = m.mtls.map((i) => (i === null ? undefined : r.materials.get(i))).find((x) => x?.texture != null);
    check(!!tex && r.textures.get(tex.texture!) === 'Floor_Side.bmp', '游戏贴图按文件名引用');
  });
}
