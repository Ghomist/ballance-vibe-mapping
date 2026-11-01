// 从中间断开的机关：放在直路中间时把跨着的那段路去掉，挪走 / 删掉后接回去
import { addObj } from '../src/model/objects';
import { cutForObj, uncutObj } from '../src/model/gaps';
import { placeBase } from '../src/model/bases';
import { blockToSeg, extendTo, normalize } from '../src/model/ops';
import { Model, Seg, cloneModel, endPos, isFree } from '../src/model/types';

type Check = (c: boolean, msg: string) => void;
const near = (a: number, b: number, e = 1e-6) => Math.abs(a - b) < e;

/** 沿 X 的直道：从 x=-2.5 到 x=len，y=0 */
function road(emptyModel: () => Model, len: number) {
  const m = emptyModel();
  const s = blockToSeg(m, 1, 0);
  extendTo(m, s, 'b', len);
  normalize(m);
  return m;
}
const segs = (m: Model) => Object.values(m.segs).sort((p, q) => p.x - q.x);
const span = (s: Seg) => [+endPos(s, 'a')[0].toFixed(3), +endPos(s, 'b')[0].toFixed(3)];

export function gapScenarios(emptyModel: () => Model, check: Check, scenario: (n: string, f: () => void) => void) {
  scenario('秋千放在直路中间：两个对准方块之间的路去掉，断开处是开放端点', () => {
    const m = road(emptyModel, 50);
    const len0 = segs(m)[0].len, x0 = segs(m)[0].x;
    // 秋千对准方块在本地 x=±10，方块之间空 15
    const id = addObj(m, 'P_Modul_08', 25, 0, -1.5, 0)!;
    const before = cloneModel(m);
    check(cutForObj(m, id) === 1, '断开了一段路');
    normalize(m);
    const ss = segs(m);
    check(ss.length === 2, `变成两段（${ss.length}）`);
    check(near(span(ss[0])[1], 17.5) && near(span(ss[1])[0], 32.5), `缺口 17.5..32.5（${JSON.stringify(ss.map(span))}）`);
    check(ss.every((s) => [s.a, s.b].every((e) => !isFree(e) || e.style === 'open' || !e.gap)), '断开处是开放端点');
    check(isFree(ss[0].b) && ss[0].b.style === 'open' && isFree(ss[1].a) && ss[1].a.style === 'open', '缺口两边都是 open');
    // 删掉秋千：路接回一整段
    delete m.objs[id];
    normalize(m);
    const back = segs(m);
    check(back.length === 1 && near(back[0].x, x0) && near(back[0].len, len0), `删掉后接回原样（${JSON.stringify(back.map(span))}）`);
    // 接回去后和断开前一样
    check(JSON.stringify(back.map(span)) === JSON.stringify(segs(before).map(span)), '与断开前相同');
  });

  scenario('机关挪走后路接回去，在新位置重新断开；转 90° 横在路上不断', () => {
    const m = road(emptyModel, 60);
    const id = addObj(m, 'P_Modul_30', 20.1, 0, -0.5, 0)!; // 跷跷板 ±9.9 → 缺口 14.8（以对准方块为准）
    cutForObj(m, id);
    normalize(m);
    check(segs(m).length === 2, '先断开');
    uncutObj(m, id);
    m.objs[id].x = 40.1; // 主对准方块（本地 x=9.9）落在格子 [47.5,52.5] 上
    cutForObj(m, id);
    normalize(m);
    const ss = segs(m);
    check(ss.length === 2 && near(span(ss[0])[1], 32.7) && near(span(ss[1])[0], 47.5), `挪到新位置重新断开（${JSON.stringify(ss.map(span))}）`);
    uncutObj(m, id);
    normalize(m);
    m.objs[id].rot = 90;
    check(cutForObj(m, id) === 0 && segs(m).length === 1, '横着放不断路');
  });

  scenario('放在路的一头（缺口伸出路外）：只截短，删掉后补回原来的端点', () => {
    const m = road(emptyModel, 20);
    const s0 = segs(m)[0];
    const style0 = isFree(s0.b) ? s0.b.style : null;
    // 推板：主方块中心 x=2.5（[0,5]），另一个在 -12.56；缺口 10.06
    const id = addObj(m, 'P_Modul_25', 15, 0, 0, 180)!; // 转 180°：主方块在 [10,15]，缺口 15..25
    cutForObj(m, id);
    normalize(m);
    let ss = segs(m);
    check(ss.length === 1 && near(span(ss[0])[1], 15), `截到 15（${JSON.stringify(ss.map(span))}）`);
    delete m.objs[id];
    normalize(m);
    ss = segs(m);
    check(ss.length === 1 && near(span(ss[0])[1], 20) && isFree(ss[0].b) && ss[0].b.style === style0 && !ss[0].b.gap, `补回到 20、端点样式还原（${JSON.stringify(ss.map(span))}）`);
  });

  scenario('T 型板在两个侧边方块（两个挡块）中间断开；双向挡板两条平行的路各断一段', () => {
    // T 型板侧边方块在本地 (-13.77, ±7.23)：路沿 Y 穿过，缺口 y ∈ [-4.74, 4.73]
    const m = emptyModel();
    delete m.nodes[1]; m.root = null;
    m.segs[10] = { id: 10, x: 0, y: -30, dir: 1, len: 60, style: 'normal', a: { node: null, z: 0, style: 'closed' }, b: { node: null, z: 0, style: 'closed' } };
    m.nextId = 20;
    const id = addObj(m, 'P_Modul_37', 13.77, 0, 0, 0)!;
    check(cutForObj(m, id) === 1, 'T 型板断开一段');
    normalize(m);
    const ys = Object.values(m.segs).map((q) => [endPos(q, 'a')[1], endPos(q, 'b')[1]].map((v) => +v.toFixed(2))).sort((p, q) => p[0] - q[0]);
    check(ys.length === 2 && near(ys[0][1], -4.74, 1e-6) && near(ys[1][0], 4.73, 1e-6), `缺口在两个侧边方块之间（${JSON.stringify(ys)}）`);

    // 双向挡板：y=5 的路缺口 x ∈ [-9.13, -2.5]，y=-10 的路缺口 x ∈ [-3.34, 3.31]
    const m2 = emptyModel();
    delete m2.nodes[1]; m2.root = null;
    for (const [id2, y] of [[10, 5], [11, -10]] as const) {
      m2.segs[id2] = { id: id2, x: -30, y, dir: 0, len: 60, style: 'normal', a: { node: null, z: 0, style: 'closed' }, b: { node: null, z: 0, style: 'closed' } };
    }
    m2.nextId = 20;
    const fid = addObj(m2, 'P_Modul_19', 0, 0, 0, 0)!;
    check(cutForObj(m2, fid) === 2, '双向挡板断开两段');
    normalize(m2);
    const at = (y: number) => Object.values(m2.segs).filter((q) => near(q.y, y)).map(span).sort((p, q) => p[0] - q[0]);
    const r5 = at(5), r10 = at(-10);
    check(r5.length === 2 && near(r5[0][1], -9.13, 1e-6) && near(r5[1][0], -2.5, 1e-6), `y=5 缺口 -9.13..-2.5（${JSON.stringify(r5)}）`);
    check(r10.length === 2 && near(r10[0][1], -3.34, 1e-6) && near(r10[1][0], 3.31, 1e-6), `y=-10 缺口 -3.34..3.31（${JSON.stringify(r10)}）`);
    delete m2.objs[fid];
    normalize(m2);
    check(Object.keys(m2.segs).length === 2, '删掉后两条路都接回去');
  });

  scenario('缺口里有截面接头（坡道分界、分隔过的路）也能断开，删掉后接回原样', () => {
    const m = emptyModel();
    delete m.nodes[1]; m.root = 10;
    m.nodes[30] = { id: 30, kind: 'joint', x: 3, y: 0, z: 0, style: 'normal', axis: 0 };
    m.segs[10] = { id: 10, x: -30, y: 0, dir: 0, len: 33, style: 'normal', a: { node: null, z: 0, style: 'closed' }, b: { node: 30 } };
    m.segs[11] = { id: 11, x: 3, y: 0, dir: 0, len: 27, style: 'normal', a: { node: 30 }, b: { node: null, z: 0, style: 'closed' } };
    m.nextId = 40;
    // 软木桥：缺口 -6.86..8.47（原点在 0）
    const id = addObj(m, 'P_Modul_29', 0, 0, -0.17, 0)!;
    check(cutForObj(m, id) === 2, '接头两侧各截一段');
    normalize(m);
    const ss = segs(m);
    check(ss.length === 2 && near(span(ss[0])[1], -6.86, 1e-6) && near(span(ss[1])[0], 8.47, 1e-6) && !m.nodes[30], `缺口 -6.86..8.47，接头去掉（${JSON.stringify(ss.map(span))}）`);
    delete m.objs[id];
    normalize(m);
    const back = segs(m);
    // 接回成连续的路（-30..30，中间没有断开的自由端）
    const free = back.flatMap((q) => [q.a, q.b]).filter((e) => isFree(e)).length;
    check(near(span(back[0])[0], -30) && near(span(back[back.length - 1])[1], 30) && free === 2, `接回连续的路（${JSON.stringify(back.map(span))}）`);
  });

  scenario('凹槽路面 / 凹槽平台上的风扇：底座嵌进槽底（低 0.7），删掉后路接回、底座去掉', () => {
    // 凹槽直路：风扇对准方块顶面 = 槽底（-0.7），风扇原点再低 0.34
    const m = emptyModel();
    delete m.nodes[1]; m.root = 10;
    m.segs[10] = { id: 10, x: -30, y: 0, dir: 0, len: 60, style: 'sink', a: { node: null, z: 0, style: 'closed' }, b: { node: null, z: 0, style: 'closed' } };
    m.nextId = 20;
    const id = addObj(m, 'P_Modul_18', 2.5, 0, -0.7 - 0.34, 0)!;
    const b = placeBase(m, id);
    normalize(m);
    const base = b !== null ? m.nodes[b] : undefined;
    const ss = segs(m);
    check(!!base && !!base.free && near(base.z, -0.7, 1e-6), `底座单独嵌在槽底（${JSON.stringify(base)}）`);
    check(ss.length === 2 && near(span(ss[0])[1], 0) && near(span(ss[1])[0], 5) && ss.every((q) => q.style === 'sink'), `挖掉底座那一格、没有加平凹转换（${JSON.stringify(ss.map(span))}）`);
    delete m.objs[id];
    normalize(m);
    check(segs(m).length === 1 && near(segs(m)[0].len, 60) && !Object.values(m.nodes).some((n) => n.kind === 'base'), '删掉后路接回、底座去掉');

    // 凹槽平台：挖掉底座下面 4×4 小格
    const p = emptyModel();
    delete p.nodes[1];
    const cells: string[] = [];
    for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) cells.push(`${i},${j}`);
    p.nodes[5] = { id: 5, kind: 'platform', x: 0, y: 0, z: 0, style: 'sink', cells };
    p.root = 5; p.nextId = 20;
    const fid = addObj(p, 'P_Modul_18', 7.5, 7.5, -0.7 - 0.34, 0)!;
    const pb = placeBase(p, fid);
    normalize(p);
    const plat = Object.values(p.nodes).filter((n) => n.kind === 'platform');
    const left = plat.reduce((a, n) => a + (n.cells?.length ?? 0), 0);
    check(pb !== null && !!p.nodes[pb]?.hole && p.nodes[pb].hole!.cells.length === 16 && near(p.nodes[pb].z, -0.7, 1e-6) && left === 144, `底座嵌在槽底、盖住 16 个小格，平台本身不变（剩 ${left}）`);
    delete p.objs[fid];
    normalize(p);
    const back = Object.values(p.nodes).filter((n) => n.kind === 'platform');
    check(back.reduce((a, n) => a + (n.cells?.length ?? 0), 0) === 144 && !Object.values(p.nodes).some((n) => n.kind === 'base'), '删掉后底座去掉、平台完整');
  });

  scenario('路已经断开时（机关跨在两段路之间）不再动路', () => {
    const m = road(emptyModel, 50);
    const id = addObj(m, 'P_Modul_08', 25, 0, -1.5, 0)!;
    cutForObj(m, id);
    normalize(m);
    const snap = JSON.stringify(m.segs);
    check(cutForObj(m, id) === 0 && JSON.stringify(m.segs) === snap, '重复断开不改路');
  });
}
