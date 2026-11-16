// 导入的自定义模型：跟着地图码走、导出进 NMO、能从 NMO 读回来。
import lib from '../public/nmo-lib.json';
import { type CustomModel, customModel, finishModel, modelsUsed, registerModel } from '../src/box/custom-model';
import { customAssets, exportBoxScene } from '../src/box/export';
import { decodeShare, encodeShare } from '../src/box/share';
import { type Doc, type Elem, type Obj, type ZoneElem, virtualCells } from '../src/box/types';
import { buildImport, importModelFile } from '../src/box/model-import';
import { newCheckpoint, nextCheckSector, sectorTotal, startsOf } from '../src/box/sectors';
import { feats } from '../src/box/snap';

const near = (a: number, b: number, e = 1e-3) => Math.abs(a - b) < e;
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

  scenario('导入 NMO：机关按组认出来（类型、小节、朝向），死亡区、路面、钢轨分开', async () => {
    const d: Doc = { elems: {}, nextId: 20 };
    const es: Elem[] = [
      { id: 1, kind: 'box', x: 0, y: 0, z: 0, sx: 10, sy: 5, depth: 1, style: 'normal' },
      { id: 2, kind: 'obj', type: 'P_Box', x: 3, y: 2, z: 1, rot: 1, sector: 2 },
      { id: 3, kind: 'obj', type: 'P_Modul_18', x: 7, y: 2, z: 0, rot: 0, ang: 30, sector: 1 },
      { id: 4, kind: 'zone', x: -50, y: -40, z: -30, sx: 100, sy: 80, depth: 5 },
      { id: 5, kind: 'rail', x: 0, y: 20, z: 0, heading: 0, pieces: [{ kind: 'double', len: 10, radius: 0, angle: 0, dz: 0 }] },
      { id: 6, kind: 'piece', type: 'start', x: 1.25, y: 1.25, z: 0, rot: 0 },
      { id: 7, kind: 'piece', type: 'check', x: 30, y: 1.25, z: 0, rot: 0 },
    ];
    for (const e of es) d.elems[e.id] = e;
    const desc = exportBoxScene(d);
    const data = await writeNmo(buildNmoDoc(desc, lib as unknown as NmoLib));
    const r = await importModelFile(new File([data as BlobPart], 'level.nmo'));
    const boxes = r.elems.filter((e): e is Obj => e.kind === 'obj' && e.type === 'P_Box');
    check(boxes.length === 1 && boxes[0].sector === 2 && boxes[0].rot === 1 && near(boxes[0].x, 3) && near(boxes[0].y, 2) && near(boxes[0].z, 1), `木箱：类型、小节、朝向、位置 ${JSON.stringify(boxes[0])}`);
    const fan = r.elems.find((e): e is Obj => e.kind === 'obj' && e.type === 'P_Modul_18');
    check(!!fan && near(fan.ang ?? 0, 30) && fan.noBase === true && fan.noStopper === true, '风扇：任意角度，关掉专属路块和挡块');
    const z = r.elems.find((e): e is ZoneElem => e.kind === 'zone');
    check(!!z && near(z.x, -50) && near(z.sx, 100) && near(z.z, -30) && near(z.depth, 5), '死亡区按包围盒回来');
    check(r.objects.some((o) => o.phys === 'rail') && r.objects.some((o) => o.phys === 'floor'), '钢轨、路面记下导出类型');
    const pc = r.elems.find((e): e is Obj => e.kind === 'obj' && e.type === 'PC_TwoFlames');
    const prs = r.elems.filter((e): e is Obj => e.kind === 'obj' && e.type === 'PR_Resetpoint').map((e) => e.sector).sort();
    check(!!pc && pc.sector === 2 && prs.join() === '1,2' && r.elems.some((e) => e.kind === 'obj' && e.type === 'PS_FourFlames'), `火焰、重生点按小节号导入：两火 ${pc?.sector}，重生点 ${prs}`);
    const built = buildImport(r);
    check(built.filter((e) => e.kind === 'asset').length === r.objects.length && built.every((e, i) => e.id === i + 1), '一个物体一个元素');
  });

  scenario('隐形挡块：隐藏、只归挡块组、排在普通挡块后面；地图码和 NMO 都能回来', async () => {
    const es: Elem[] = [
      { id: 1, kind: 'box', x: -20, y: -2.5, z: 0, sx: 40, sy: 5, depth: 5, style: 'normal' },
      { id: 2, kind: 'zone', x: 0, y: 3, z: 3, sx: 5, sy: 1, depth: 3, stop: true },
      { id: 3, kind: 'obj', type: 'P_Modul_25', x: 2.5, y: 0, z: 0, rot: 0 },
      { id: 4, kind: 'zone', x: -100, y: -100, z: -30, sx: 200, sy: 200, depth: 5 },
      { id: 5, kind: 'zone', x: 10, y: 3, z: 3, sx: 5, sy: 1, depth: 3, stop: true },
    ];
    const d: Doc = { elems: Object.fromEntries(es.map((e) => [e.id, e])), nextId: 10 };
    const nmo = buildNmoDoc(exportBoxScene(d), lib as unknown as NmoLib);
    const g = (n: string) => nmo.groups.find((x) => x.name === n)?.objects.map((i) => nmo.objects[i]) ?? [];
    const st = g('Phys_FloorStopper');
    check(st.length === 3 && st[0].name === 'A_Stopper_BVM_01' && st[0].visible !== false, `挡块组：普通挡块排第一（${st.map((o) => o.name)}）`);
    check(st.slice(1).every((o) => o.name.startsWith('A_Stopper_Invisible_') && o.visible === false), '隐形挡块都隐藏');
    check(g('DepthTestCubes').length === 1 && !nmo.groups.some((x) => x.name !== 'Phys_FloorStopper' && x.objects.some((i) => nmo.objects[i].name.startsWith('A_Stopper_Invisible_'))), '隐形挡块只在挡块组，不算死亡区');
    const back = await decodeShare(await encodeShare(d));
    check(back.elems[2].kind === 'zone' && back.elems[2].stop === true && back.elems[4].kind === 'zone' && !back.elems[4].stop, '地图码里 stop 原样回来');
    const r = await importModelFile(new File([await writeNmo(nmo) as BlobPart], 'istop.nmo'));
    const zs = r.elems.filter((e): e is ZoneElem => e.kind === 'zone');
    check(zs.filter((z) => z.stop).length === 2 && zs.filter((z) => !z.stop).length === 1, `NMO 导入：隐藏的挡块变回隐形挡块（${zs.map((z) => !!z.stop)}）`);
  });

  scenario('拆开的起点 / 小节盘点：导出和旧式盘点完全一样', () => {
    const at = (es: Elem[], dx: number, dy: number, rot: 0 | 1 | 2 | 3) => es.map((e) => ({ ...e, x: e.x + dx, y: e.y + dy, ...(e.kind === 'piece' ? { rot } : e.kind === 'obj' ? { rot: ((e.rot + rot) % 4) as 0 | 1 | 2 | 3 } : {}) }));
    let n = 1;
    const split = [...at(newCheckpoint('start', () => n++, 1, 1), 1.25, 1.25, 1), ...at(newCheckpoint('check', () => n++, 2, 2), 30, 1.25, 0)];
    const old: Elem[] = [{ id: 1, kind: 'piece', type: 'start', x: 1.25, y: 1.25, z: 0, rot: 1 }, { id: 2, kind: 'piece', type: 'check', x: 30, y: 1.25, z: 0, rot: 0 }];
    const docOf = (es: Elem[]): Doc => ({ elems: Object.fromEntries(es.map((e) => [e.id, e])), nextId: 20 });
    const key = (d: Doc) => { const s = exportBoxScene(d); return JSON.stringify({ a: s.assets.map((a) => [a.asset, a.pos.map((v) => v.toFixed(3)), a.rotZ]).sort(), e: s.elements.map((e) => [e.type, e.sector, e.pos.map((v) => v.toFixed(3)), (((e.rotZ % 360) + 360) % 360).toFixed(1)]).sort(), n: s.sectors }); };
    check(key(docOf(split)) === key(docOf(old)), `导出一致\n${key(docOf(split))}\n${key(docOf(old))}`);
    check(sectorTotal(split) === 2 && startsOf(split).length === 1, '小节数、起点都认得出');
    const d = docOf(split);
    check(nextCheckSector(d) === 3, '再放一个小节盘点激活第 3 小节');
    // 吸附点：盘点路面上有火焰、重生点原点的位置；火焰上有盘点圆盘中心的位置
    for (const t of ['start', 'check'] as const) {
      let k = 1;
      const [p, f, r] = newCheckpoint(t, () => k++, 1, 2);
      const pv = feats(p).verts, fp = feats(f);
      const has = (vs: number[][], q: number[]) => vs.some((v) => v.every((x, i) => near(x, q[i])));
      check(has(pv, [f.x, f.y, f.z]) && has(pv, [r.x, r.y, r.z]), `${t}：路面上能吸到火焰、重生点的原点`);
      check(has(fp.mids, [p.x, p.y, p.z]), `${t}：火焰上能吸到圆盘中心`);
      check(virtualCells(f).length === 0 && virtualCells(r).length === 0, `${t}：火焰、重生点自己不带虚线框`);
    }
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
