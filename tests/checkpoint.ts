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

import { makeCorner, movePiece, pieceOf, shiftFreeEnd } from '../src/model/ops';

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

import { baseParts, placeBase } from '../src/model/bases';

export function baseScenarios(emptyModel: () => Model, check: Check, scenario: Scenario, validate: (m: Model, l: string) => void) {
  const segCount = (m: Model) => Object.keys(m.segs).length;
  scenario('变球器：脚下那一格换成底座，删掉变球器后变回普通路', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0); // x ∈ [-2.5, 2.5]
    extendTo(m, s, 'b', 47.5);
    const o = addObj(m, 'P_Trafo_Stone', 20, 0, 0.1)!;
    const b = placeBase(m, o);
    normalize(m);
    validate(m, 'trafo');
    check(b !== null && m.nodes[b].kind === 'base' && nodeLinks(m, b).length === 2, '应插入接着两段路的底座');
    check(baseParts(m, m.nodes[b!])[0].name === 'TrafoBase_Stone', '石球变球器用石头底座');
    delete m.objs[o];
    normalize(m);
    validate(m, 'trafo-revert');
    check(!Object.values(m.nodes).some((n) => n.kind === 'base') && segCount(m) === 1, `底座应变回普通路并合成一段，实际 ${segCount(m)} 段`);
  });

  scenario('风扇：按接路情况选边框花纹', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0);
    extendTo(m, s, 'b', 47.5);
    const mid = addObj(m, 'P_Modul_18', 20, 0, -0.34)!;
    const end = addObj(m, 'P_Modul_18', 45, 0, -0.34)!;
    placeBase(m, mid); placeBase(m, end);
    normalize(m);
    validate(m, 'fan');
    const pm = baseParts(m, m.nodes[m.objs[mid].base!])[0], pe = baseParts(m, m.nodes[m.objs[end].base!])[0];
    check(pm.name === 'Ventilator_2Face_Opposite' && (pm.rotZ === 90 || pm.rotZ === 270), `路中间的风扇：两侧有边框，实际 ${pm.name} ${pm.rotZ}`);
    check(pe.name === 'Ventilator_3Edge', `路尽头的风扇：三边有边框，实际 ${pe.name}`);
  });

  scenario('栅栏：顺路两格换成栅栏路面，删掉后接回一整段', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0);
    extendTo(m, s, 'b', 47.5);
    // 对准点 (2.5, 0.65)：对准的那一格中心在 x=20
    const o = addObj(m, 'P_Modul_01', 17.5, -0.65, 0)!;
    const b = placeBase(m, o);
    normalize(m);
    validate(m, 'fence');
    check(b !== null && Math.abs(m.nodes[b].x - 22.5) < 1e-9 && nodeLinks(m, b).length === 2, `栅栏路面中心应在 x=22.5，实际 ${b !== null ? m.nodes[b].x : '无'}`);
    delete m.objs[o];
    normalize(m);
    validate(m, 'fence-revert');
    check(segCount(m) === 1 && Math.abs(Object.values(m.segs)[0].len - 50) < 1e-9, '应接回一整段 50 长的路');
  });
}

import { buildGuards } from '../src/geom/railing';
import { outlineLoops } from '../src/model/outline';

export function guardScenarios(emptyModel: () => Model, check: Check, scenario: Scenario) {
  scenario('护栏：沿路面外沿走、跨过拐角，贴着路边外侧，两头立柱 + 铆钉，坡道上也是一整段', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0); // x ∈ [-2.5, 2.5]，y=0
    extendTo(m, s, 'b', 30);
    const br = makeCorner(m, s, 'b', 1)!; // 末端往 +Y 拐
    extendTo(m, br, 'b', 20);
    normalize(m);
    const loops = outlineLoops(m);
    check(loops.length === 1 && loops[0].closed, `一条带拐角的路外沿应是一个闭合环，实际 ${loops.length} 个`);
    // 从直路右侧（y=-2.5）x=10 处，绕过拐角外侧，到拐出去那段路右侧 y=10 处
    const id = m.nextId++;
    m.guards[id] = { id, a: [10, -2.5, 0], b: [32.5, 10, 0] };
    const g = buildGuards(m).get(id);
    check(!!g, '护栏应能生成');
    if (!g) return;
    check(g.route.pts.length === 3, `应绕过一个拐角（3 个点），实际 ${g.route.pts.length}`);
    // 贴着路边外侧：横杆在 y = -2.5 - 0.25
    const ys = [];
    for (let i = 0; i < g.pos.length; i += 3) if (g.pos[i] < 12 && g.pos[i + 2] > 1) ys.push(g.pos[i + 1]);
    const yc = (Math.max(...ys) + Math.min(...ys)) / 2;
    check(Math.abs(yc - -2.75) < 0.01, `管中心应在路边外 0.25（y=-2.75），实际 ${yc.toFixed(3)}`);
    const zs = g.pos.filter((_, i) => i % 3 === 2);
    check(Math.abs(Math.max(...zs) - m.settings.guardTop) < 0.01 && Math.abs(Math.min(...zs) + m.settings.guardPostDepth) < 0.3,
      `管顶应在路面上 ${m.settings.guardTop}、立柱伸到路面下 ${m.settings.guardPostDepth}`);
    check(g.nails.length === 2 && g.nails.every((n) => n.name === 'RailNail'), '两头各一个铆钉');
    // 管子朝外：每个三角形的法线与顶点法线同向
    let bad = 0;
    for (let i = 0; i < g.pos.length; i += 9) {
      const p = g.pos, a = [p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]], b = [p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]];
      const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      const vn = [g.nrm[i] + g.nrm[i + 3] + g.nrm[i + 6], g.nrm[i + 1] + g.nrm[i + 4] + g.nrm[i + 7], g.nrm[i + 2] + g.nrm[i + 5] + g.nrm[i + 8]];
      if (n[0] * vn[0] + n[1] * vn[1] + n[2] * vn[2] < 0) bad++;
    }
    check(bad === 0, `管子三角形朝向应向外，有 ${bad} 个朝里`);
    // 坡道：抬高拐出去那段的末端，护栏仍能生成
    const s2 = Object.values(m.segs).find((x) => x.id !== s)!;
    shiftFreeEnd(m, s2.id, 'b', 5);
    check(!!buildGuards(m).get(id), '坡道上护栏仍是一整段');
  });
}

import { newMapModel } from '../src/model/checkpoint';

export function newMapScenarios(check: Check, scenario: Scenario) {
  scenario('新建地图：只有起点，路口落在格栅上，从路口长出的路对齐格栅', () => {
    const m = newMapModel();
    const ns = Object.values(m.nodes);
    check(ns.length === 1 && ns[0].kind === 'checkpoint' && ns[0].prefab === 'start' && m.root === ns[0].id, '应只有一个起点，并作为高度基准');
    const s = addSegAtPort(m, ns[0].id, 0)!;
    extendTo(m, s, 'b', 20);
    normalize(m);
    check(Math.abs(m.segs[s].x) < 1e-9 && Math.abs(m.segs[s].y - 2.5) < 1e-9, `路从 (0, 2.5) 开始，实际 (${m.segs[s].x}, ${m.segs[s].y})`);
  });
}

import { rotateSpawn } from '../src/model/checkpoint';

export function spawnScenarios(check: Check, scenario: Scenario) {
  scenario('重生点：默认朝着起点出口（占位符转 180°），可单独转向，路面旋转时一起转', () => {
    const m = newMapModel();
    const st = Object.values(m.nodes)[0];
    const pr = () => prefabParts(m, st).find((p) => p.name === 'PR_Resetpoint')!;
    check(pr().rotZ === 180, `路口朝 +X 时重生点占位符应转 180°，实际 ${pr().rotZ}`);
    rotateSpawn(m, st.id, 1);
    check(pr().rotZ === 270 && st.rot === 0, '只转重生朝向，路面不动');
    rotateSpawn(m, st.id, 3);
    check(st.spawn === undefined && pr().rotZ === 180, '转回来后与路面朝向一致');
  });
}
