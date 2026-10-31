import { addCheckpoint, checkpoints, moveSector, placeCheckpointOnSeg, placeStartAtEnd, prefabParts, rotateCheckpoint } from '../src/model/checkpoint';
import { addSegAtPort, blockToSeg, deleteElem, extendTo, normalize, setSegStyle, shiftDownstream, tryConnect } from '../src/model/ops';
import { Model, PREFAB_PORT, endPos, endZ, nodeLinks } from '../src/model/types';

type Check = (c: boolean, msg: string) => void;
type Scenario = (n: string, f: () => void) => void;

export function checkpointScenarios(emptyModel: () => Model, check: Check, scenario: Scenario, validate: (m: Model, l: string) => void) {
  scenario('盘点：放到直道中间，两侧接到延伸段末端', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0); // x ∈ [-2.5, 2.5]
    extendTo(m, s, 'b', 57.5);
    const cp = placeCheckpointOnSeg(m, s, 30)!;
    normalize(m);
    validate(m, 'cp-mid');
    check(cp !== null && nodeLinks(m, cp).length === 2, '盘点应接着两段路');
    const n = m.nodes[cp];
    check(Math.abs(n.x - 27.5) < 1e-9, `盘点中心 x 应为 27.5，实际 ${n.x}`);
    const parts = prefabParts(m, n);
    check(parts[0].name === 'CheckPoint_DoubleExtended_OpenEdge', `两侧接路应选双延伸版本，实际 ${parts[0].name}`);
    check(parts[1].objName === 'PC_TwoFlames_01' && parts[2].objName === 'PR_Resetpoint_02', '第一个小节盘点：PC_01 + PR_02');
    check(Math.abs(parts[2].pos[2] - (n.z + 3.3258)) < 1e-9, '重生点高度偏移 3.3258');
  });

  scenario('盘点：只有一侧接路时选单延伸版本并转向那一侧', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0);
    extendTo(m, s, 'b', 15);
    const cp = placeCheckpointOnSeg(m, s, 1000)!; // 夹到末端外侧
    normalize(m);
    validate(m, 'cp-end');
    const n = m.nodes[cp];
    check(nodeLinks(m, cp).length === 1, '应只接一侧');
    const parts = prefabParts(m, n);
    check(parts[0].name === 'CheckPoint_Extended_OpenEdge' && parts[0].rotZ === 180, `应为单延伸并朝 -X，实际 ${parts[0].name} ${parts[0].rotZ}`);
  });

  scenario('起点：接在端点外侧；全图只能有一个', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0);
    extendTo(m, s, 'b', 12.5);
    const st = placeStartAtEnd(m, s, 'a')!;
    normalize(m);
    validate(m, 'start');
    const n = m.nodes[st];
    check(Math.abs(n.x - (-2.5 - PREFAB_PORT.start)) < 1e-9, '起点中心应在端点外 12.3861');
    check(prefabParts(m, n)[0].name === 'StartPoint_Extended_OpenEdge', '接路的起点用延伸版本');
    check(prefabParts(m, n)[1].rotZ === 90, '四火比路面多转 90°');
    check(placeStartAtEnd(m, s, 'b') === null && addCheckpoint(m, 'start', 100, 0, 0) === null, '不能有第二个起点');
  });

  scenario('盘点：从路口长出新路、自由端靠上自动接上、凹槽路插转换', () => {
    const m = emptyModel();
    delete m.nodes[1]; m.root = null;
    const cp = addCheckpoint(m, 'check', 0, 0, 0, 0)!;
    check(addSegAtPort(m, cp, 1) === null, '盘点侧面不能接路');
    const a = addSegAtPort(m, cp, 0)!;
    extendTo(m, a, 'b', 40);
    setSegStyle(m, a, 'sink');
    normalize(m);
    validate(m, 'cp-grow');
    check(Object.values(m.nodes).some((n) => n.kind === 'transition'), '凹槽路接盘点应插平凹转换');
    // 另一侧：一段开放端点正好落在路口
    const id = m.nextId++;
    const px = -PREFAB_PORT.check;
    m.segs[id] = { id, x: px - 10, y: 0, dir: 0, len: 10, style: 'normal', a: { node: null, z: 0, style: 'closed' }, b: { node: null, z: 0, style: 'open' } };
    normalize(m);
    check(m.segs[id].b.node === cp, '开放端点落在路口应自动接上');
    // 抬高盘点：下游跟着动
    shiftDownstream(m, cp, 2.5);
    normalize(m);
    validate(m, 'cp-lift');
  });

  scenario('小节编号：新建递增、删除后重排、可交换顺序、可掉头', () => {
    const m = emptyModel();
    const ids = [0, 1, 2].map((i) => addCheckpoint(m, 'check', i * 40, 50, 0)!);
    check(ids.map((id) => m.nodes[id].sector).join() === '2,3,4', '小节号应为 2,3,4');
    deleteElem(m, ids[0]);
    normalize(m);
    check(checkpoints(m).map((n) => n.sector).join() === '2,3', '删除后重排');
    check(moveSector(m, ids[2], -1) && m.nodes[ids[2]].sector === 2, '交换顺序');
    check(rotateCheckpoint(m, ids[1], 1) && m.nodes[ids[1]].rot === 1, '没接路时可转 90°');
  });

  scenario('端点拉到盘点路口：tryConnect', () => {
    const m = emptyModel();
    const cp = addCheckpoint(m, 'check', 50, 0, 0, 0)!;
    const s = blockToSeg(m, 1, 0);
    extendTo(m, s, 'b', 50 - PREFAB_PORT.check);
    check(tryConnect(m, s, 'b'), '应能接到盘点路口');
    normalize(m);
    validate(m, 'cp-connect');
    check(Math.abs(endPos(m.segs[s], 'b')[0] - (50 - PREFAB_PORT.check)) < 1e-9 && endZ(m, m.segs[s], 'b') === 0, '端点位置不变');
  });
}

import { addObj, autoSector, followSurfaces, objSector } from '../src/model/objects';
import { cloneModel } from '../src/model/types';

export function objectScenarios(emptyModel: () => Model, check: Check, scenario: Scenario) {
  scenario('机关小节：两个盘点之间属于前一个；起点之后是第 1 小节', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0);
    extendTo(m, s, 'b', 200);
    placeStartAtEnd(m, s, 'a');
    const c2 = placeCheckpointOnSeg(m, s, 60)!;
    normalize(m);
    const after2 = Object.values(m.segs).find((x) => x.a.node === c2)!;
    placeCheckpointOnSeg(m, after2.id, 60);
    normalize(m);
    const at = (x: number) => { const id = addObj(m, 'P_Box', x, 0, 2.5)!; return autoSector(m, m.objs[id]); };
    check(at(20) === 1, `起点与第一个盘点之间应为第 1 小节，实际 ${at(20)}`);
    check(at(100) === 2, `两个盘点之间应为第 2 小节，实际 ${at(100)}`);
    check(at(180) === 3, `最后一个盘点之后应为第 3 小节，实际 ${at(180)}`);
    const id = addObj(m, 'P_Box', 20, 0, 2.5)!;
    m.objs[id].sector = 3;
    check(objSector(m, m.objs[id]) === 3, '手动指定的小节优先');
    check(addObj(m, 'PE_Balloon', 0, 0, 0) !== null && addObj(m, 'PE_Balloon', 5, 0, 0) === null, '终点气球只能有一个');
  });

  scenario('机关跟着脚下的路面升降', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0);
    extendTo(m, s, 'b', 40);
    const id = addObj(m, 'P_Box', 30, 0, 2.5)!;
    const before = cloneModel(m);
    shiftDownstream(m, s, 5);
    normalize(m);
    followSurfaces(before, m);
    check(Math.abs(m.objs[id].z - 7.5) < 1e-9, `路面抬高 5 后箱子应在 7.5，实际 ${m.objs[id].z}`);
  });
}

import { addSegAtPlatform, blockToPlatform, extrudePlatform, edgeRunAt } from '../src/model/platform';

export function platformRepairScenarios(emptyModel: () => Model, check: Check, scenario: Scenario, validate: (m: Model, l: string) => void) {
  const platforms = (m: Model) => Object.values(m.nodes).filter((n) => n.kind === 'platform');

  scenario('平台推断：拆成两个独立平台，路口归到各自那块', () => {
    const m = emptyModel();
    const p = blockToPlatform(m, 1, 0, 20)!; // x ∈ [-2.5, 22.5]，y ∈ [-2.5, 2.5]
    const right = addSegAtPlatform(m, p, 17.5, -2.5, 3)!;
    extendTo(m, right, 'b', -15);
    const left = addSegAtPlatform(m, p, 0, -2.5, 3)!;
    extendTo(m, left, 'b', -15);
    normalize(m);
    // 中间挖掉一列（x ∈ [5, 10]）
    extrudePlatform(m, p, { out: 3, line: -2.5, from: 5, to: 10 }, -5);
    normalize(m);
    validate(m, 'split');
    const ps = platforms(m);
    check(ps.length === 2, `应拆成 2 个平台，实际 ${ps.length}`);
    const nl = m.segs[left].a.node, nr = m.segs[right].a.node;
    check(nl !== null && nr !== null && nl !== nr, '两条路应分别接在两个平台上');
    check(ps.every((n) => m.nodes[n.id] && (n.cells?.length ?? 0) > 0), '拆出的平台都不为空');
  });

  scenario('平台推空：删除平台，接着的路变成封闭端点', () => {
    const m = emptyModel();
    const p = blockToPlatform(m, 1, 0, 10)!;
    const s = addSegAtPlatform(m, p, 2.5, 2.5, 1)!;
    extendTo(m, s, 'b', 20);
    normalize(m);
    const run = edgeRunAt(m.nodes[p], 2.5, 2.5)!; // 上边
    extrudePlatform(m, p, run, -5);
    normalize(m);
    validate(m, 'empty');
    check(platforms(m).length === 0, '平台应被删除');
    const e = m.segs[s]?.a;
    check(!!e && e.node === null && (e as { style: string }).style === 'closed', '路的这一端应变成封闭端点');
  });

  scenario('两个平台连成一个后再推回去：重新分开', () => {
    const m = emptyModel();
    const a = blockToPlatform(m, 1, 0, 10)!; // x ∈ [-2.5, 12.5]，y ∈ [-2.5, 2.5]
    const bid = m.nextId++;
    m.nodes[bid] = { id: bid, kind: 'platform', x: 0, y: 0, z: 0, style: 'normal', cells: [] };
    extrudePlatform(m, bid, { out: 1, line: 10, from: -2.5, to: 12.5 }, 0); // 占位
    m.nodes[bid].cells = [];
    for (let i = -2; i < 10; i++) for (let j = 8; j < 12; j++) m.nodes[bid].cells!.push(`${i},${j}`); // y ∈ [10, 15]
    const top = edgeRunAt(m.nodes[a], 5, 2.5)!;
    extrudePlatform(m, a, top, 7.5); // 顶边拉到 y=10，与 B 相接
    normalize(m);
    check(platforms(m).length === 1, '相接后应合并成一个');
    const merged = platforms(m)[0];
    // 把连接部分（y ∈ [2.5, 10]）从下往上推掉一部分：从左侧边挖空
    extrudePlatform(m, merged.id, { out: 2, line: -2.5, from: 2.5, to: 10 }, -15);
    normalize(m);
    validate(m, 'remerge-split');
    check(platforms(m).length === 2, `挖掉连接部分后应重新分成 2 个，实际 ${platforms(m).length}`);
  });
}

import { movePiece, pieceOf } from '../src/model/ops';

export function rippleScenarios(emptyModel: () => Model, check: Check, scenario: Scenario) {
  scenario('Ctrl 移动：接在平台边上的路沿边移动时只滑动路口，平台不动', () => {
    const m = emptyModel();
    const p = blockToPlatform(m, 1, 0, 20)!; // x ∈ [-2.5, 22.5]，y ∈ [-2.5, 2.5]
    const s = addSegAtPlatform(m, p, 7.5, 2.5, 1)!;
    extendTo(m, s, 'b', 20);
    normalize(m);
    const cells = JSON.stringify(m.nodes[p].cells);
    const info = { moved: new Set<number>(), stretched: new Set<number>() };
    check(movePiece(m, pieceOf(m, s), 5, 0, 0, info), '应能移动');
    normalize(m);
    check(JSON.stringify(m.nodes[p].cells) === cells, '平台不应移动');
    check(m.segs[s].x === 12.5 && m.segs[s].a.node === p, `路口应滑到 x=12.5 并仍接在平台上，实际 ${m.segs[s].x}`);
    check(!info.moved.has(p), '移动范围里不应包含平台');
    // 滑出平台边就不行了：只能带着平台走
    const info2 = { moved: new Set<number>(), stretched: new Set<number>() };
    movePiece(cloneModel(m), pieceOf(m, s), 15, 0, 0, info2);
    check(info2.moved.has(p), '路口放不下时平台跟着移动');
  });
}
