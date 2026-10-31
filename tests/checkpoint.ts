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
