// box 版的导出基线：场景描述（SceneDesc）的结构、命名、小节号，以及 NMO 的往返读回。
//
// 这里不碰浏览器：素材库直接从 public/nmo-lib.json 读进内存交给 buildNmoDoc，
// 所以 exportBoxScene → buildNmoDoc → writeNmo → readNmo 整条链在 Node 里就能跑完。
import { exportBoxScene, zoneTris } from '../src/box/export';
import { solve } from '../src/box/solve';
import { buildNmoDoc } from '../src/export/nmo-scene';
import { writeNmo } from '../src/export/nmo';
import type { NmoLib } from '../src/export/nmo-lib';
import { FLOOR_MATERIALS, type SceneDesc } from '../src/export/scene';
import { buildRail } from '../src/geom/rail';
import { stopperMesh } from '../src/model/stoppers';
import { readNmo } from './nmo';
import { Box, Doc, Elem, GuardElem, Obj, Piece, RailElem, ZoneElem } from '../src/box/types';

type Check = (cond: boolean, msg: string) => void;
type Scenario = (name: string, fn: () => void) => void;

const fs = (await import('node:fs' as string)) as { readFileSync(p: string, enc: string): string };

const doc = (elems: Elem[], settings?: Doc['settings']): Doc => {
  const d: Doc = { elems: {}, nextId: 1 };
  for (const e of elems) { d.elems[e.id] = e; d.nextId = Math.max(d.nextId, e.id + 1); }
  if (settings) d.settings = settings;
  return d;
};

const box = (id: number, x: number, y: number, sx = 5, sy = 5, o: Partial<Box> = {}): Box =>
  ({ id, kind: 'box', x, y, z: 0, sx, sy, depth: 1, style: 'normal', ...o });
const piece = (id: number, type: Piece['type'], x: number, y: number, o: Partial<Piece> = {}): Piece =>
  ({ id, kind: 'piece', type, x, y, z: 0, rot: 0, ...o });
const obj = (id: number, type: string, x: number, y: number, o: Partial<Obj> = {}): Obj =>
  ({ id, kind: 'obj', type, x, y, z: 0, rot: 0, ...o });
const rail = (id: number, x: number, y: number, pieces: RailElem['pieces'], o: Partial<RailElem> = {}): RailElem =>
  ({ id, kind: 'rail', x, y, z: 0, heading: 0, pieces, ...o });

/** 一个像样的关卡：起点 + 两个盘点 + 一段路 + 钢轨 + 护栏 + 死亡区 + 机关 + 气球 */
const level = () => doc([
  piece(1, 'start', 1.25, 1.25),
  box(2, 0, 0, 10, 2.5),
  piece(3, 'check', 11.25, 1.25, { sector: 2 }),
  box(4, 10, 0, 10, 2.5, { z: 0 }),
  piece(5, 'check', 21.25, 1.25),
  box(6, 20, 0, 10, 2.5, { z: 0 }),
  rail(7, 0, 1.25, [{ kind: 'double', len: 10, radius: 0, angle: 0, dz: 0 }]),
  obj(8, 'P_Modul_25', 5, 1.25, { z: 0.5, sector: 1 }),
  obj(9, 'PE_Balloon', 29, 1.25, { z: 2 }),
  { id: 10, kind: 'zone', x: 12, y: 4, z: 0, sx: 3, sy: 3, depth: 2 } as ZoneElem,
]);

let libCache: NmoLib | null = null;
const lib = (): NmoLib =>
  (libCache ??= JSON.parse(fs.readFileSync(new URL('../public/nmo-lib.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), 'utf8')) as unknown as NmoLib);

const triCount = (pos: number[]) => pos.length / 9;
const meshNamed = (desc: SceneDesc, name: string) => desc.meshes.find((m) => m.name === name);

export function boxExportScenarios(check: Check, scenario: Scenario) {
  scenario('场景描述：警告 / 小节数 / 命名', () => {
    const empty = exportBoxScene(doc([]));
    check(empty.format === 'bvm-scene' && empty.version === 1, '场景描述应带 format/version');
    check(empty.warnings.includes('没有起点：游戏里无法开始这一关'), '没有起点应给出警告');
    check(empty.warnings.includes('没有终点气球（PE_Balloon）'), '没有终点气球应给出警告');
    check(empty.sectors === 1 && empty.meshes.length === 0, '空文档只有 1 个小节、没有网格');

    const d = level();
    const desc = exportBoxScene(d);
    check(desc.sectors === 3, `起点 + 两个盘点 = 3 个小节，实际 ${desc.sectors}`);
    check(desc.warnings.length === 0, `完整的关卡不该有警告：${desc.warnings.join(' / ')}`);

    // 路面 / 钢轨 / 挡块的命名前缀
    const floors = desc.meshes.filter((m) => m.kind === 'floor');
    check(floors.length === solve(d).meshes.size, `每一个解出来的路面块对应一个导出物体：${floors.length} vs ${solve(d).meshes.size}`);
    check(floors[0].name === 'A_Floor_BVM_01', `路面命名：${floors[0].name}`);
    check(desc.meshes.some((m) => m.name === 'A_Rail_BVM_01' && m.kind === 'rail' && m.smooth),
      '钢轨物体应叫 A_Rail_BVM_01、kind 为 rail、平滑着色');
    check(desc.meshes.some((m) => m.name === 'A_Stopper_BVM_01' && m.kind === 'stopper'), '机关带的挡块应合成一个 A_Stopper_BVM_01');

    const unknown = exportBoxScene(doc([box(1, 0, 0), obj(2, 'P_Not_A_Thing', 1, 1)]));
    check(unknown.warnings.includes('未知物件类型 P_Not_A_Thing'), `未知物件应给出警告：${unknown.warnings.join(' / ')}`);
    check(!unknown.elements.some((e) => e.type === 'P_Not_A_Thing'), '未知物件不应进占位符');
  });

  scenario('场景描述：占位符的小节号', () => {
    const desc = exportBoxScene(level());
    const at = (type: string) => desc.elements.filter((e) => e.type === type);
    const four = at('PS_FourFlames');
    check(four.length === 1 && four[0].sector === undefined, `起点四火不分小节：${JSON.stringify(four.map((e) => e.sector))}`);
    const resets = at('PR_Resetpoint').map((e) => e.sector).sort();
    check(JSON.stringify(resets) === JSON.stringify([1, 2, 3]),
      `三个重生点依次属于小节 1/2/3（起点算 1、盘点按顺序 2/3），实际 ${JSON.stringify(resets)}`);
    const twos = at('PC_TwoFlames').map((e) => e.sector).sort();
    check(JSON.stringify(twos) === JSON.stringify([1, 2]),
      `盘点的两火属于上一个小节（1/2），实际 ${JSON.stringify(twos)}`);
    const balloon = at('PE_Balloon');
    check(balloon.length === 1 && balloon[0].sector === undefined, '终点气球不分小节');

    // 机关的小节号：缺省 1、超出范围夹到最后一个小节
    const d = doc([piece(1, 'start', 1.25, 1.25), box(2, 0, 0), piece(3, 'check', 10, 1.25), obj(4, 'P_Box', 1, 1), obj(5, 'P_Box', 2, 2, { sector: 9 })]);
    const sec = exportBoxScene(d).elements.filter((e) => e.type === 'P_Box').map((e) => e.sector);
    check(JSON.stringify(sec) === JSON.stringify([1, 2]), `机关小节号缺省 1、9 夹到最后一个小节（2），实际 ${JSON.stringify(sec)}`);
  });

  scenario('场景描述：路面网格的三角形与 UV 对齐', () => {
    const desc = exportBoxScene(doc([box(1, 0, 0, 10, 5)]));
    const m = desc.meshes.find((x) => x.kind === 'floor')!;
    check(!!m && m.parts.length > 0, '路面应有材质分片');
    for (const p of m.parts) {
      check(p.pos.length % 9 === 0, `${p.mat}：顶点数应是 3 的倍数，实际 ${p.pos.length}`);
      check((p.uv?.length ?? 0) === (p.pos.length / 3) * 2, `${p.mat}：UV 数量应是顶点数的两倍`);
      check(FLOOR_MATERIALS.includes(p.mat), `材质名应在 BME 路面材质里：${p.mat}`);
      check(p.pos.every(Number.isFinite) && p.uv!.every(Number.isFinite), `${p.mat}：不应出现非法数值`);
    }
    // 与求解器自己的统计一致
    const s = solve(doc([box(1, 0, 0, 10, 5)]));
    let tris = 0;
    for (const mm of s.meshes.values()) for (const p of Object.values(mm.parts)) if (p) tris += triCount(p.pos);
    check(tris === m.parts.reduce((a, p) => a + triCount(p.pos), 0), '导出的三角形数应等于求解器的统计');
  });

  scenario('场景描述：钢轨 / 护栏 / 死亡区 / 挡块', () => {
    const d = doc([
      box(1, 0, 0, 10, 5),
      rail(2, 0, 2.5, [{ kind: 'double', len: 10, radius: 0, angle: 0, dz: 0 }]),
      { id: 3, kind: 'guard', pts: [[0, 0, 0], [10, 0, 0]], outs: [[0, -1], [0, -1]], x: 0, y: 0, z: 0 } as GuardElem,
      { id: 4, kind: 'zone', x: 2, y: 2, z: 0, sx: 3, sy: 3, depth: 2 } as ZoneElem,
    ]);
    const desc = exportBoxScene(d);
    const rm = desc.meshes.find((m) => m.name === 'A_Rail_BVM_01')!;
    const built = buildRail(d.elems[2] as RailElem);
    check(!!rm && triCount(rm.parts[0].pos) === triCount(built.pos), '钢轨物体的三角形数应与 buildRail 一致');
    check(rm.parts.every((p) => p.mat === 'Rail'), '钢轨只用 Rail 材质');

    const gm = desc.meshes.find((m) => m.name === 'A_Rail_BVM_Guard_01');
    check(!!gm && gm.kind === 'rail' && triCount(gm.parts[0].pos) > 0, '护栏应导出成 A_Rail_BVM_Guard_01');
    check(desc.assets.some((a) => a.kind === 'deco' && a.asset === 'RailNail'), '护栏的铆钉应作为装饰资产导出');

    const zm = desc.meshes.find((m) => m.kind === 'zone');
    check(!!zm && zm.name === 'DepthTestCubes_01', `死亡区命名：${zm?.name}`);
    check(!!zm && triCount(zm.parts[0].pos) === 12, `死亡区是长方体：12 个三角形，实际 ${zm ? triCount(zm.parts[0].pos) : '-'}`);
    const zt = zoneTris(d.elems[4] as ZoneElem);
    check(zt.length === 108 && zt.every(Number.isFinite), 'zoneTris 应是 12 个三角形（108 个数）且都是有限值');

    // 挡块：只有带挡块模板的机关才合成，带 noStopper 的机关跳过
    const withBox = exportBoxScene(doc([box(1, 0, 0), obj(2, 'P_Modul_25', 1, 1)]));
    const st = stopperMesh({ id: 0, cat: 'module', type: 'P_Modul_25', x: 1, y: 1, z: 0, rot: 0 });
    check(!!st && !!meshNamed(withBox, 'A_Stopper_BVM_01'), 'P_Modul_25 带挡块，应导出 A_Stopper_BVM_01');
    const noStop = exportBoxScene(doc([box(1, 0, 0), obj(2, 'P_Modul_25', 1, 1, { noStopper: true })]));
    check(!meshNamed(noStop, 'A_Stopper_BVM_01'), 'noStopper 的机关不应导出挡块');
  });

  scenario('NMO：导出后能读回、对象齐全', async () => {
    const d = level();
    const desc = exportBoxScene(d);
    const data = await writeNmo(buildNmoDoc(desc, lib()));
    const r = await readNmo(data);
    check(r.magic === 'Nemo Fi', `文件头魔数：${r.magic}`);
    check(r.crcOk, 'CRC 应校验通过');
    check(r.chunksOk, '每个对象的数据块长度与 FileIndex 应自洽');
    check(r.sizesOk, '压缩前后的尺寸应与文件头一致');
    check(r.mgrCount === 0 && r.tail[0] === 0, `没有插件依赖：mgrCount=${r.mgrCount} tail0=${r.tail[0]}`);

    const names = r.objects.map((o) => o.name);
    for (const want of ['PS_FourFlames_01', 'PE_Balloon_01', 'PC_TwoFlames_01', 'PC_TwoFlames_02', 'PR_Resetpoint_01', 'PR_Resetpoint_03']) {
      check(names.includes(want), `应导出 ${want}，实际有：${names.filter((n) => /PS_|PE_|PC_|PR_/.test(n)).join(', ')}`);
    }
    check(names.some((n) => n.startsWith('A_Floor_BVM_')), '应导出路面物体');
    check(names.some((n) => n.includes('DepthTestCubes')), `应导出死亡区物体：${names.join(', ')}`);
    // 每个小节都有组（游戏靠 Sector_XX 判断小节数）
    for (const g of ['Sector_01', 'Sector_02', 'Sector_03']) check(names.includes(g), `应有组 ${g}`);
    check(!names.includes('Sector_04'), '不该多出第 4 个小节组');
  });

  scenario('NMO：侧轨和螺旋侧轨能导出、读回', async () => {
    const line = { kind: 'double' as const, len: 20, radius: 0, angle: 0, dz: 0 };
    const d = level();
    d.elems[50] = rail(50, 0, 30, [line], { side: { dir: -1, ends: [true, false] } });
    d.elems[51] = rail(51, 0, 40, [{ kind: 'mono', len: 0, radius: 5, angle: 720, dz: 7.2 }], { sideSpiral: true });
    const before = exportBoxScene(level()).meshes.filter((m) => m.kind === 'rail').length;
    const desc = exportBoxScene(d);
    const rails = desc.meshes.filter((m) => m.kind === 'rail');
    check(rails.length === before + 2, `应多出两根钢轨网格：${before} → ${rails.length}`);
    check(rails.every((m) => m.smooth && m.parts.every((p) => p.pos.length > 0 && p.pos.every(Number.isFinite))), '钢轨网格平滑、数值有效');
    const r = await readNmo(await writeNmo(buildNmoDoc(desc, lib())));
    check(r.crcOk && r.chunksOk && r.sizesOk, 'NMO 校验通过');
    const names = r.objects.map((o) => o.name);
    check(rails.every((m) => names.includes(m.name)), '钢轨物体都写进了 NMO');
  });

  scenario('NMO：死亡区隐藏、云层显示（和原版关卡的写法一样）', async () => {
    const d = level();
    d.elems[60] = { id: 60, kind: 'asset', name: 'SkyLayer', x: 0, y: 0, z: -80, rot: 0 };
    d.elems[61] = { id: 61, kind: 'asset', name: 'SkyLayerVortex', x: 0, y: 0, z: -80, rot: 0 };
    const r = await readNmo(await writeNmo(buildNmoDoc(exportBoxScene(d), lib())));
    /** 物体的隐藏状态：[有 OBJECT_HIDDEN 标识符, Moveable 里有 VISIBLE] */
    const state = (o: { dw: Uint32Array }): [boolean, boolean] => {
      let hidden = false, moveable = 0, pos = 0;
      for (let g = 0; g < 20 && pos + 1 < o.dw.length; g++) {
        if (o.dw[pos] === 4) hidden = true;
        if (o.dw[pos] === 0x100000) moveable = o.dw[pos + 3];
        if (!o.dw[pos + 1]) break;
        pos = o.dw[pos + 1];
      }
      return [hidden, (moveable & 2) !== 0];
    };
    const zones = r.objects.filter((o) => o.classId === 33 && o.name.startsWith('DepthTestCubes_'));
    check(zones.length > 0 && zones.every((o) => state(o).join() === 'true,false'), '死亡区：标识符和 Moveable 都要标成隐藏');
    for (const n of ['SkyLayer', 'SkyLayerVortex']) {
      const o = r.objects.find((x) => x.classId === 33 && x.name === n);
      check(!!o && state(o).join() === 'false,true', `${n} 导出后要显示，名字不加前缀`);
    }
    const floor = r.objects.find((o) => o.classId === 33 && o.name.startsWith('A_Floor_'));
    check(!!floor && state(floor).join() === 'false,true', '普通物体不受影响');
  });

  scenario('NMO：导出是确定的', async () => {
    const a = await writeNmo(buildNmoDoc(exportBoxScene(level()), lib()));
    const b = await writeNmo(buildNmoDoc(exportBoxScene(level()), lib()));
    check(a.length === b.length && a.every((v, i) => v === b[i]), `同一份文档两次导出的字节应完全相同（${a.length} 字节）`);
    check(JSON.stringify(exportBoxScene(level())) === JSON.stringify(exportBoxScene(level())), '场景描述应是确定的');
  });
}
