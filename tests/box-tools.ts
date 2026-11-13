// 关卡检查、地图文件、粘贴、镜像：都是不碰界面的纯函数。
import { checkLevel } from '../src/box/check';
import { decodeBvm, encodeBvm } from '../src/box/file';
import { decodeShare, encodeShare } from '../src/box/share';
import { canMirror, elemBounds, mirrorElems, pasteElems } from '../src/box/ops';
import { solve } from '../src/box/solve';
import { Box, Doc, Elem, Obj, Piece, RailElem, ZoneElem, emptyDoc, railPath } from '../src/box/types';

type Check = (cond: boolean, msg: string) => void;
type Scenario = (name: string, fn: () => void | Promise<void>) => void;

const near = (a: number, b: number, eps = 1e-4) => Math.abs(a - b) <= eps;
const box = (id: number, x: number, y: number, sx: number, sy: number, o: Partial<Box> = {}): Box => ({ id, kind: 'box', x, y, z: 0, sx, sy, depth: 5, style: 'normal', ...o });
const piece = (id: number, type: Piece['type'], x: number, y: number, o: Partial<Piece> = {}): Piece => ({ id, kind: 'piece', type, x, y, z: 0, rot: 0, ...o });
const obj = (id: number, type: string, x: number, y: number, o: Partial<Obj> = {}): Obj => ({ id, kind: 'obj', type, x, y, z: 0, rot: 0, ...o });
const rail = (id: number, x: number, y: number, heading: number, pieces: RailElem['pieces'], o: Partial<RailElem> = {}): RailElem => ({ id, kind: 'rail', x, y, z: 0, heading, pieces, ...o });
const docOf = (...elems: Elem[]): Doc => { const d = emptyDoc(); for (const e of elems) d.elems[e.id] = e; d.nextId = Math.max(0, ...elems.map((e) => e.id)) + 1; return d; };

export function boxToolsScenarios(check: Check, scenario: Scenario) {
  scenario('关卡检查：手册里的规则', () => {
    const texts = (d: Doc, lv: 'error' | 'warn') => checkLevel(d).filter((i) => i.level === lv).map((i) => i.text);
    check(texts(docOf(), 'error').join() === '没有起点,没有终点飞船', `空地图：两条错误（${texts(docOf(), 'error')}）`);
    const zone: ZoneElem = { id: 20, kind: 'zone', x: 0, y: 0, z: -20, sx: 50, sy: 50, depth: 2 };
    const sky: Elem = { id: 21, kind: 'asset', name: 'SkyLayer', x: 0, y: 0, z: -60, rot: 0 };
    const full = () => docOf(piece(1, 'start', 0, 0), piece(2, 'check', 20, 0), obj(3, 'PE_Balloon', 40, 0), zone, sky);
    check(checkLevel(full()).length === 0, `齐全的关卡没有任何提示：${checkLevel(full()).map((i) => i.text)}`);

    const one = full(); delete one.elems[2];
    check(texts(one, 'warn').join() === '只有一个小节' && texts(one, 'error').length === 0, '没有小节盘点：只有一小节的警告');
    const noSky = full(); delete noSky.elems[21]; delete noSky.elems[20];
    check(texts(noSky, 'warn').join() === '没有云层,没有死亡区' && texts(noSky, 'error').length === 0, '云层和死亡区没放只是警告');
    const many = full();
    for (let i = 0; i < 8; i++) many.elems[30 + i] = piece(30 + i, 'check', 60 + i * 20, 0);
    const mi = checkLevel(many).find((i) => i.text.includes('超过'));
    check(!!mi && mi.level === 'warn' && mi.ids!.length === 2, `10 个小节：超过 8 个，指出多出来的两个盘点（${mi?.ids}）`);
    const over = full(); over.elems[40] = obj(40, 'P_Box', 5, 5, { sector: 5 }); over.elems[41] = obj(41, 'P_Box', 6, 5, { sector: 2 });
    const oi = checkLevel(over).find((i) => i.text.includes('小节号'));
    check(!!oi && oi.ids!.join() === '40', '机关的小节号超出范围：只指出超出的那个');
    const two = full(); two.elems[50] = piece(50, 'start', 9, 9); two.elems[51] = { ...sky, id: 51 } as Elem;
    check(texts(two, 'warn').join() === '有 2 个起点,有 2 个云层', `多个起点、多个云层：${texts(two, 'warn')}`);

    // 挡块附近的护栏：5 个单位以内提醒，远了不提醒；关掉挡块的机关不算
    const guard = (id: number, y: number): Elem => ({ id, kind: 'guard', pts: [[0, y, 0], [20, y, 0]], outs: [[0, -1]], x: 0, y, z: 0 });
    const sg = full(); sg.elems[60] = obj(60, 'P_Modul_25', 10, 0); sg.elems[61] = guard(61, 3); sg.elems[62] = guard(62, 40);
    const si = checkLevel(sg).find((i) => i.text.includes('挡块'));
    check(!!si && si.level === 'warn' && si.ids!.join() === '60,61', `挡块旁边的护栏：指出机关和近的那段护栏（${si?.ids}）`);
    const far = full(); far.elems[60] = obj(60, 'P_Modul_25', 10, 0); far.elems[62] = guard(62, 40);
    check(!checkLevel(far).some((i) => i.text.includes('挡块')), '护栏离得远：不提醒');
    const off = full(); off.elems[60] = obj(60, 'P_Modul_25', 10, 0, { noStopper: true }); off.elems[61] = guard(61, 3);
    check(!checkLevel(off).some((i) => i.text.includes('挡块')), '关掉挡块的机关：不提醒');
    const box5 = full(); box5.elems[60] = obj(60, 'P_Box', 10, 0); box5.elems[61] = guard(61, 1);
    check(!checkLevel(box5).some((i) => i.text.includes('挡块')), '没有挡块的机关：不提醒');
  });

  scenario('地图文件 .bvm：存了再读回来；坏文件给出原因', async () => {
    const d = docOf(piece(1, 'start', 0, 0), box(2, 0, 0, 15, 5, { slope: { axis: 0, dz: 3 } }), rail(3, 0, 0, 30, [{ kind: 'double', len: 10, radius: 0, angle: 0, dz: 0 }]));
    d.name = '测试图';
    const text = await encodeBvm(d);
    const j = JSON.parse(text);
    check(j.format === 'bvm-map' && j.name === '测试图' && j.elements === 3 && typeof j.code === 'string', '文件是带格式标记的 JSON');
    const back = await decodeBvm(text);
    const want = JSON.stringify(await decodeShare(await encodeShare(d))); // 地图码读回来字段顺序可能不一样：和直接走地图码的结果比
    check(JSON.stringify(back) === want && back.name === '测试图' && Object.keys(back.elems).length === 3 && (back.elems[2] as Box).slope?.dz === 3, '读回来和原来一样');
    check(JSON.stringify(await decodeBvm('﻿' + (await encodeShare(d)) + '\n')) === want, '只有一串地图码的文本文件也能打开');
    const fails = async (t: string, part: string) => { try { await decodeBvm(t); return false; } catch (e) { return (e as Error).message.includes(part); } };
    check(await fails('', '空的'), '空文件');
    check(await fails('{"format":"bvm-map","code":', '不完整'), '截断的 JSON');
    check(await fails('{"format":"something-else","code":"x"}', '不是 BVM'), '别的 JSON 文件');
    check(await fails(JSON.stringify({ ...j, version: 99 }), '更新版本'), '更新版本存的文件');
    check(await fails(JSON.stringify({ ...j, code: j.code.slice(0, 20) }), '解不开'), '地图数据被截断');
    check(await fails('这不是地图', '解不开'), '随便一段文字');
  });

  scenario('粘贴：换新编号，绑定组不和原来的撞', () => {
    const d = docOf(box(1, 0, 0, 5, 5, { group: 1 }), box(2, 5, 0, 5, 5, { group: 1 }));
    const src = [box(7, 20, 0, 5, 5, { group: 1 }), box(3, 25, 0, 5, 5, { group: 1 }), box(9, 30, 0, 5, 5)];
    const ids = pasteElems(d, src);
    check(ids.join() === '3,4,5' && d.nextId === 6, `新编号接着往后排：${ids}`);
    check(d.elems[3].group === 2 && d.elems[4].group === 2 && d.elems[5].group === undefined, '粘贴进来的组换成新的组号，没绑定的还是没绑定');
    check((d.elems[3] as Box).x === 25 && (d.elems[4] as Box).x === 20 && src[0].id === 7, '按原来的编号顺序放进来，原数据不动');
  });

  scenario('镜像：路面、转换、钢轨、护栏、死亡区', () => {
    /** 包围盒沿这根轴翻过去 */
    const flipB = (b: ReturnType<typeof elemBounds>, axis: 0 | 1, c: number) => (axis === 0 ? { ...b, x0: 2 * c - b.x1, x1: 2 * c - b.x0 } : { ...b, y0: 2 * c - b.y1, y1: 2 * c - b.y0 });
    const sameB = (a: ReturnType<typeof elemBounds>, b: ReturnType<typeof elemBounds>) => (['x0', 'y0', 'z0', 'x1', 'y1', 'z1'] as const).every((k) => near(a[k], b[k], 1e-3));
    const elems: Elem[] = [
      box(1, 0, 0, 15, 5),
      box(2, 15, 0, 10, 5, { slope: { axis: 0, dz: 4 }, open: 1, closed: 8 }),
      box(3, 3, 9, 12, 5, { ang: 30, slope: { axis: 1, dz: -2 }, open: 4 }),
      piece(4, 'transition', 30, 2.5, { rot: 0 }),
      piece(5, 'transition-narrow', 40, 2.5, { rot: 1, ang: 20 }),
      rail(6, 0, 20, 25, [{ kind: 'double', len: 10, radius: 0, angle: 0, dz: 2 }, { kind: 'double', len: 0, radius: 8, angle: 70, dz: 1 }]),
      rail(7, 10, 30, 110, [{ kind: 'mono', len: 0, radius: 6, angle: -400, dz: 9 }]),
      rail(8, 5, 40, 200, [{ kind: 'double', len: 12, radius: 0, angle: 0, dz: 0 }], { side: { dir: 1, bend: [true, false] } as RailElem['side'] }),
      rail(9, -5, 50, 15, [{ kind: 'double', len: 1, radius: 0, angle: 0, dz: 0 }], { curve: { pts: [{ p: [0, 0, 0], out: [5, 2, 0] }, { p: [15, 6, 3], in: [-4, -3, 0], out: [4, 3, 0], bank: 10 }, { p: [30, -4, 5], in: [-5, 1, 0] }], frame: 'parallel' } }),
      { id: 10, kind: 'guard', pts: [[1.5, 0, 0], [13.5, 0, 0]], outs: [[0, -1]], x: 1.5, y: 0, z: 0 },
      { id: 11, kind: 'zone', x: -10, y: -10, z: -5, sx: 30, sy: 8, depth: 2, ang: 15 } as ZoneElem,
    ];
    for (const axis of [0, 1] as const) {
      const c = 7.25, d = docOf(...elems.map((e) => JSON.parse(JSON.stringify(e)) as Elem));
      const before = new Map(elems.map((e) => [e.id, elemBounds(e)]));
      const paths = new Map(elems.filter((e): e is RailElem => e.kind === 'rail').map((e) => [e.id, railPath(e)]));
      const r = mirrorElems(d, Object.keys(d.elems).map(Number), axis, c);
      check(r.done === elems.length && r.skipped === 0, `${'xy'[axis]} 镜像：${elems.length} 个都处理了`);
      for (const e of Object.values(d.elems)) check(sameB(elemBounds(e), flipB(before.get(e.id)!, axis, c)), `${'xy'[axis]} 镜像：${e.kind} #${e.id} 的包围盒正好翻过去`);
      // 钢轨的路径逐点对上（转弯方向、曲线形状都要对，不只是包围盒）
      for (const [id, p0] of paths) {
        const p1 = railPath(d.elems[id] as RailElem);
        const ok = p1.length === p0.length && p0.every((a, i) => near(axis === 0 ? 2 * c - a.x : a.x, p1[i].x, 1e-3) && near(axis === 1 ? 2 * c - a.y : a.y, p1[i].y, 1e-3) && near(a.z, p1[i].z, 1e-3));
        check(ok, `${'xy'[axis]} 镜像：钢轨 #${id} 的路径逐点翻过去`);
      }
      // 坡：低的那头还在镜像的位置；开口 / 封口的边跟着换
      const b2 = d.elems[2] as Box;
      if (axis === 0) check(near(b2.z, 4) && b2.slope!.dz === -4 && b2.open === 4 && b2.closed === 8, `左右翻：坡的高低两头对调，+长 的开口换到 -长（z ${b2.z} dz ${b2.slope!.dz} open ${b2.open}）`);
      else check(near(b2.z, 0) && b2.slope!.dz === 4 && b2.open === 1 && b2.closed === 2, `前后翻：沿长的坡不变，-宽 的封口换到 +宽（closed ${b2.closed}）`);
      const g = d.elems[10] as Extract<Elem, { kind: 'guard' }>;
      // 护栏：朝外的方向还在前进方向的右手边
      const dir = [g.pts[1][0] - g.pts[0][0], g.pts[1][1] - g.pts[0][1]];
      check(dir[1] * g.outs[0][0] - dir[0] * g.outs[0][1] > 0, `${'xy'[axis]} 镜像：护栏朝外的方向还在右手边`);
      // 翻两次回到原样
      mirrorElems(d, Object.keys(d.elems).map(Number), axis, c);
      for (const e of Object.values(d.elems)) check(sameB(elemBounds(e), before.get(e.id)!), `${'xy'[axis]} 镜像两次：${e.kind} #${e.id} 回到原位`);
    }
    // 一片路镜像以后花纹还是连着的：外沿的圈数和总长不变
    const road = () => docOf(box(1, 0, 0, 15, 5), box(2, 15, 0, 5, 20), box(3, 20, 15, 10, 5, { style: 'sink' }), piece(4, 'transition', 22.5, 12.5, { rot: 1 }));
    const a = road(), b = road();
    mirrorElems(b, [1, 2, 3, 4], 0, 10);
    const la = solve(a).loops, lb = solve(b).loops;
    const total = (ls: typeof la) => ls.reduce((s, l) => s + l.len, 0);
    check(la.length === lb.length && near(total(la), total(lb), 1e-3), `镜像后外沿一样：${la.length} 圈 / ${total(la).toFixed(2)} → ${lb.length} 圈 / ${total(lb).toFixed(2)}`);

    // 不能镜像的：机关、木制件、盘点、倾斜的东西——跳过，原样不动
    const fixed: Elem[] = [obj(1, 'P_Box', 3, 3), { id: 2, kind: 'asset', name: 'WoodPlate', x: 9, y: 9, z: 0, rot: 0 }, piece(3, 'start', 0, 0), box(4, 0, 0, 5, 5, { q: [0, 0.2588, 0, 0.9659] })];
    const fd = docOf(...fixed.map((e) => JSON.parse(JSON.stringify(e)) as Elem)), snap = JSON.stringify(fd);
    const fr = mirrorElems(fd, [1, 2, 3, 4], 0, 5);
    check(fixed.every((e) => !canMirror(e)) && fr.done === 0 && fr.skipped === 4 && JSON.stringify(fd) === snap, '机关、木制件、盘点、倾斜的路面：跳过且不改动');
  });
}
