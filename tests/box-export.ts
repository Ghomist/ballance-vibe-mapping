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
import { DOUBLE_OFFSET, RAIL_RADIUS, advance } from '../src/model/rail';
import { elemBounds, rotateWorld, uprightElem } from '../src/box/ops';
import { feats } from '../src/box/snap';
import { rotAxis } from '../src/box/xform';
import { stopperMesh } from '../src/model/stoppers';
import { readNmo } from './nmo';
import { Box, Doc, Elem, GuardElem, Obj, Piece, RailElem, ZoneElem, canTilt } from '../src/box/types';

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
    const sky = r.objects.find((x) => x.classId === 33 && x.name === 'SkyLayer');
    check(!!sky && state(sky).join() === 'false,true', '云层导出后要显示，名字不加前缀');
    const floor = r.objects.find((o) => o.classId === 33 && o.name.startsWith('A_Floor_'));
    check(!!floor && state(floor).join() === 'false,true', '普通物体不受影响');
  });

  scenario('NMO：漩涡和云层一样叫 SkyLayer（游戏脚本按名字加混合）', () => {
    const d = level();
    d.elems[60] = { id: 60, kind: 'asset', name: 'SkyLayerVortex', x: 0, y: 0, z: -80, rot: 0 };
    const n = buildNmoDoc(exportBoxScene(d), lib());
    const o = n.objects.find((x) => x.name === 'SkyLayer');
    check(o?.mesh != null && n.meshes[o.mesh].name === 'SkyLayer_Mesh', '物体和网格名要和原版第 12 关一样');
    check(n.materials.some((m) => m.name === 'Sky_Vortex'), '材质还是漩涡的');
  });

  scenario('NMO：一张图只导出第一个云层，其余给警告', () => {
    const d = level();
    d.elems[60] = { id: 60, kind: 'asset', name: 'SkyLayer', x: 0, y: 0, z: -80, rot: 0 };
    d.elems[61] = { id: 61, kind: 'asset', name: 'SkyLayerVortex', x: 0, y: 0, z: -80, rot: 0 };
    const s = exportBoxScene(d);
    check(s.assets.filter((a) => a.asset.startsWith('SkyLayer')).map((a) => a.asset).join() === 'SkyLayer', '只留第一个云层');
    check(s.warnings.some((w) => w.includes('云层')), '多余的云层要警告');
  });

  const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;
  const LINE = { kind: 'double', len: 30, radius: 0, angle: 0, dz: 0 } as const;
  const ARC = { kind: 'double', len: 0, radius: 30, angle: 90, dz: 0 } as const;
  const railAt = (id: number, x: number, y: number, piece: typeof LINE | typeof ARC) => ({ id, kind: 'rail', x, y, z: 0, heading: 0, pieces: [piece] }) as unknown as RailElem;

  scenario('NMO：相接的钢轨合成一个物体，接头的法线和 UV 连续', () => {
    const d = { nextId: 10, elems: { 1: railAt(1, 0, 0, LINE), 2: railAt(2, 30, 0, ARC), 3: railAt(3, 0, 100, LINE) } } as unknown as Doc;
    const s = exportBoxScene(d);
    const rails = s.meshes.filter((m) => m.kind === 'rail');
    check(rails.length === 2, `相接的两段算一个物体，单独的一段另算，实际 ${rails.length} 个`);
    const tris = (pos: number[]) => pos.length / 9;
    const joined = tris(buildRail(d.elems[1] as RailElem).pos) + tris(buildRail(d.elems[2] as RailElem).pos);
    check(tris(rails[0].parts[0].pos) === joined - 2 * 2 * 6, `接头里两根轨各 2 个封盖（每个 6 个三角形）要去掉，实际少了 ${joined - tris(rails[0].parts[0].pos)} 个三角形`);
    check(tris(rails[1].parts[0].pos) === tris(buildRail(d.elems[3] as RailElem).pos), '没接上的钢轨保留封盖');

    const mesh = buildNmoDoc(s, lib()).meshes.find((m) => m.name === 'A_Rail_BVM_01')!;
    const seen = new Map<string, Set<string>>();
    for (let i = 0; i * 3 < mesh.pos.length; i++) {
      if (Math.abs(mesh.pos[i * 3] - 30) > 0.01) continue; // 接头那一圈（Virtools 的 X 还是 X）
      const k = `${mesh.pos[i * 3 + 1].toFixed(3)},${mesh.pos[i * 3 + 2].toFixed(3)}`;
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k)!.add(`${Array.from(mesh.nml).slice(i * 3, i * 3 + 3).map((c) => c.toFixed(3))}|${Array.from(mesh.uv).slice(i * 2, i * 2 + 2).map((c) => c.toFixed(3))}`);
    }
    check(seen.size === 16 && [...seen.values()].every((v) => v.size === 1), `接头 16 个点各只能有一组法线和 UV，实际 ${[...seen.values()].map((v) => v.size)}`);
  });

  scenario('NMO：斜轨接平轨、接头差一点点也要焊上，每个点只有一组法线', () => {
    const up = { kind: 'double', len: 27, radius: 0, angle: 0, dz: 10 } as unknown as typeof LINE;
    const d = { nextId: 10, elems: { 1: railAt(1, 0, 0, ARC), 2: { ...railAt(2, 0, 0, up) } } } as unknown as Doc;
    const a = d.elems[1] as RailElem, s0 = buildRail(a), b = d.elems[2] as RailElem;
    // 斜轨的起点放到弯轨的末端，再错开 0.0003（超过导出的焊接距离，地图里手动对齐常见）
    const e = advance({ x: a.x, y: a.y, z: a.z, heading: a.heading }, a.pieces[0]);
    Object.assign(b, { x: e.x + 0.0003, y: e.y, z: e.z, heading: e.heading });
    check(s0.pos.length > 0, '弯轨有网格');
    const s = exportBoxScene(d);
    const rails = s.meshes.filter((m) => m.kind === 'rail');
    check(rails.length === 1, `应合成一个物体，实际 ${rails.length} 个`);
    const mesh = buildNmoDoc(s, lib()).meshes.find((m) => m.name === 'A_Rail_BVM_01')!;
    const pos = Array.from(mesh.pos), nml = Array.from(mesh.nml), seen = new Map<string, Set<string>>();
    // 去掉两头的封盖：只看圆管上的点（法线和管子轴线差得远的）
    for (let i = 0; i * 3 < pos.length; i++) {
      const k = pos.slice(i * 3, i * 3 + 3).map((c) => c.toFixed(2)).join();
      if (!seen.has(k)) seen.set(k, new Set());
      seen.get(k)!.add(nml.slice(i * 3, i * 3 + 3).map((c) => c.toFixed(2)).join());
    }
    const many = [...seen.values()].filter((v) => v.size > 1).length;
    check(many === 2 * 2 * 8, `只有两头封盖的边（2 根轨 × 2 头 × 8 点）才有两组法线，实际 ${many} 个点`);
  });

  scenario('钢轨球形闭合：和 RailTip 的头一样，不算接头', () => {
    const r = (tips?: [boolean, boolean]) => ({ ...railAt(1, 0, 0, LINE), ...(tips ? { tips } : {}) }) as RailElem;
    const flat = buildRail(r()), ball = buildRail(r([false, true]));
    check(flat.caps.length === 4 && ball.caps.length === 2, `终点的两个封盖换成球形，实际还剩 ${ball.caps.length} 个`);
    check(ball.pos.length / 9 === flat.pos.length / 9 - 2 * 6 + 2 * 24, '每根轨的头：去掉 6 个三角形的封盖，换成 24 个三角形的半球');
    const xs = ball.pos.filter((_, i) => i % 3 === 0);
    check(near(Math.max(...xs), 30 + RAIL_RADIUS), `半球顶点比路径终点多出一个钢轨半径，实际 ${Math.max(...xs)}`);
    const tip = lib().meshes[lib().assets.RailTip.mesh];
    const h = Array.from({ length: tip.pos.length / 3 }, (_, i) => tip.pos[i * 3 + 1]);
    check(near(Math.max(...h) - 5.771, RAIL_RADIUS, 0.001), '原版 RailTip 的半球也是一个钢轨半径高');
    const sideBall = buildRail({ ...r([true, true]), side: { dir: -1 } } as RailElem);
    check(sideBall.caps.length === 0, '侧轨两根轨的两头也能是球形');
    const d = { nextId: 10, elems: { 1: r([false, true]), 2: { ...railAt(2, 30, 0, LINE), tips: [true, false] } } } as unknown as Doc;
    check(exportBoxScene(d).meshes.filter((m) => m.kind === 'rail').length === 2, '球形的头没有封盖，不和别的钢轨合并');
  });

  scenario('球形闭合跟着坡度错切', () => {
    const up = { kind: 'double', len: 20, radius: 0, angle: 0, dz: 10 } as unknown as typeof LINE;
    const m = buildRail({ ...railAt(1, 0, 0, up), tips: [false, true] } as RailElem);
    let top = [0, 0, -1e9];
    for (let i = 0; i < m.pos.length; i += 3) if (m.pos[i] > top[0]) top = m.pos.slice(i, i + 3);
    check(near(top[0], 20 + RAIL_RADIUS), `顶点水平走出一个半径，实际 ${top[0]}`);
    check(near(top[2], 10 + DOUBLE_OFFSET + RAIL_RADIUS * 0.5), `坡度 0.5，顶点跟着升高半个半径，实际 ${top[2]}`);
  });

  scenario('钢轨绕 Y 转 90°竖起来当 RailTip 用，能摆正回去', () => {
    const r = { ...railAt(1, 10, 20, { ...LINE, kind: 'mono', len: 5.771 } as unknown as typeof LINE), tips: [false, true] } as RailElem;
    const flat = buildRail(r);
    check(canTilt(r), '钢轨能绕 X / Y 转');
    rotateWorld(r, rotAxis(1, -90), [r.x, r.y, r.z]);
    check(!!r.q && r.heading === 0, '倾斜了记成四元数');
    const m = buildRail(r);
    const zs = m.pos.filter((_, i) => i % 3 === 2), xs = m.pos.filter((_, i) => i % 3 === 0);
    check(near(Math.max(...zs) - Math.min(...zs), 6.121, 0.001) && near(Math.max(...xs) - Math.min(...xs), 0.647, 0.001), `竖起来和原版 RailTip 一样大（6.121 高、0.647 宽）：${Math.max(...zs) - Math.min(...zs)} × ${Math.max(...xs) - Math.min(...xs)}`);
    check(m.pos.length === flat.pos.length, '网格只是转了一下');
    const b = elemBounds(r);
    check(near(b.z1, r.z + 5.771, 0.01), `包围盒跟着转，实际 z1=${b.z1}`);
    check(feats(r).verts.some((v) => v[2] > r.z + 5), '吸附点跟着转');
    uprightElem(r);
    check(r.q === undefined, '摆正以后没有倾斜');
    check(near(buildRail(r).pos[2], flat.pos[2], 1e-6), '摆正后回到平放');
    rotateWorld(r, rotAxis(2, 90), [r.x, r.y, r.z]);
    check(r.q === undefined && near(r.heading, 90), '只绕 Z 转还是改朝向');
  });

  scenario('倾斜的钢轨对接也能合并，导出在转过去的位置', () => {
    const a = railAt(1, 0, 0, LINE), b = railAt(2, 30, 0, LINE);
    const d = { nextId: 5, elems: { 1: a, 2: b } } as unknown as Doc;
    for (const e of [a, b]) rotateWorld(e, rotAxis(0, 30), [0, 0, 0]);
    const rails = exportBoxScene(d).meshes.filter((m) => m.kind === 'rail');
    check(rails.length === 1, `绕 X 转过的两段还是相接，实际 ${rails.length} 个物体`);
    const zs = rails[0].parts[0].pos.filter((_, i) => i % 3 === 2);
    check(Math.max(...zs) > 0.5, '导出的是转过去的网格');
  });

  scenario('转换件能绕 X / Y 转，独立成一块路面', () => {
    const p = { id: 1, kind: 'piece', type: 'transition', x: 0, y: 0, z: 0, rot: 1 } as unknown as Elem;
    check(canTilt(p), '转换件能倾斜');
    check(!canTilt({ id: 2, kind: 'piece', type: 'check', x: 0, y: 0, z: 0, rot: 0 } as unknown as Elem), '盘点不能');
    const d = { nextId: 3, elems: { 1: p } } as unknown as Doc;
    const flat = solve(d).meshes.get(1);
    check(!!flat, '平放的转换件有网格');
    rotateWorld(p, rotAxis(1, 40), [0, 0, 0]);
    check(!!(p as { q?: unknown }).q, '记成四元数');
    const m = solve(d).meshes.get(1);
    check(!!m && Object.values(m.parts).some((x) => x && x.pos.length), '倾斜以后还要有网格');
    const f = Object.values(flat!.parts).reduce((n, x) => n + (x?.pos.length ?? 0), 0), t = Object.values(m!.parts).reduce((n, x) => n + (x?.pos.length ?? 0), 0);
    check(f === t, `倾斜前后是同一个形状：${f} / ${t}`);
    const s = exportBoxScene(d).meshes.filter((x) => x.kind === 'floor');
    check(s.length === 1, '导出成路面');
  });

  scenario('NMO：从同一点岔开的钢轨不算相接', () => {
    const d = { nextId: 10, elems: { 1: railAt(1, 0, 0, LINE), 2: railAt(2, 0, 0, ARC) } } as unknown as Doc;
    check(exportBoxScene(d).meshes.filter((m) => m.kind === 'rail').length === 2, '两根都留着封盖，各是各的物体');
  });

  scenario('NMO：钢轨、木制件的归组', () => {
    const d = level();
    d.elems[60] = railAt(60, 0, 200, LINE);
    const woods = Object.keys(lib().assets).filter((n) => /^(Wood|Modul_(02|13|42)|ConcaveWood|ConvexWood|Level9_|Level13_UWood)/.test(n));
    woods.forEach((name, i) => { d.elems[100 + i] = { id: 100 + i, kind: 'asset', name, x: i * 50, y: 400, z: 0, rot: 0 }; });
    d.elems[99] = { id: 99, kind: 'asset', name: 'RailCrossing', x: 0, y: 300, z: 0, rot: 0 };
    const n = buildNmoDoc(exportBoxScene(d), lib());
    const groupsOf = (name: string) => n.groups.filter((g) => g.objects.some((i) => n.objects[i].name === name)).map((g) => g.name).sort().join();
    const RAIL = 'Phys_FloorRails,Sound_HitID_03,Sound_RollID_03', WOOD = 'Phys_Floors,Shadow,Sound_HitID_02,Sound_RollID_02';
    const rails = n.objects.filter((o) => o.name.startsWith('A_Rail_'));
    check(rails.length > 1 && rails.every((o) => groupsOf(o.name) === RAIL), `钢轨只进钢轨物理组和 03 声音组，不进影子组：${rails.map((o) => `${o.name}=${groupsOf(o.name)}`).join(' ')}`);
    check(woods.length >= 11, `木制件都要测到，实际 ${woods.length}`);
    for (const w of woods) check(groupsOf(`A_Floor_${w}`) === WOOD, `${w} 要进路面物理组、02 声音组和影子组，实际 ${groupsOf(`A_Floor_${w}`)}`);
  });

  scenario('NMO：贴图全部外部引用', () => {
    const d = level();
    d.elems[60] = { id: 60, kind: 'asset', name: 'SkyLayerVortex', x: 0, y: 0, z: -80, rot: 0 };
    const tex = buildNmoDoc(exportBoxScene(d), lib()).textures;
    check(tex.some((t) => t.name === 'Sky_Vortex'), '云层贴图要写进 NMO');
    check(tex.every((t) => t.saveOptions === 1), `贴图都要是 CKTEXTURE_EXTERNAL，实际有 ${tex.filter((t) => t.saveOptions !== 1).map((t) => t.name).join('、')}`);
  });

  scenario('NMO：导出是确定的', async () => {
    const a = await writeNmo(buildNmoDoc(exportBoxScene(level()), lib()));
    const b = await writeNmo(buildNmoDoc(exportBoxScene(level()), lib()));
    check(a.length === b.length && a.every((v, i) => v === b[i]), `同一份文档两次导出的字节应完全相同（${a.length} 字节）`);
    check(JSON.stringify(exportBoxScene(level())) === JSON.stringify(exportBoxScene(level())), '场景描述应是确定的');
  });
}
