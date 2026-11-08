// 轻量场景测试：执行一串编辑操作，检查模型一致性与网格质量。
import { nmoScenarios } from './nmo';
import { boxConnScenarios, boxSolveScenarios } from './box-solve';
import { boxGoldenScenarios } from './box-golden';
import { boxOpsScenarios } from './box-ops';
import { boxGeomScenarios } from './box-geom';
import { boxExportScenarios } from './box-export';
import { boxShareScenarios } from './box-share';
import { railEditScenarios } from './rail';
import { gapScenarios } from './gaps';
import { deepTransitionScenario, flushOpeningScenario, moreScenarios, pieceScenarios, platformScenarios, railScenarios, visualJoinScenarios } from './platform';
import { buildFloorMeshes } from '../src/geom/floor';
import { baseScenarios, guardScenarios, newMapScenarios, platformToRoadScenarios, ribbonInsetScenarios, spawnScenarios, checkpointScenarios, objectScenarios, platformRepairScenarios, rippleScenarios } from './checkpoint';
import {
  addSegAtPort, component, moveIds, blockToSeg, cutSeg, extendTo, insertJoint, makeBranch, makeCorner, normalize,
  setChainStyle, shiftDownstream, shiftFreeEnd, toggleEnd, tryConnect,
} from '../src/model/ops';
import {
  DX, DY, HALF, Model, emptyModel as baseModel, endPos, endZ, isFree, nodeHalf, nodePorts, opp, portCount,
} from '../src/model/types';

let failed = 0;

/** 测试沿用以原点为中心的 1×1，坐标更直观 */
function emptyModel() {
  const m = baseModel();
  m.nodes[1].x = 0;
  m.nodes[1].y = 0;
  return m;
}
function check(cond: boolean, msg: string) {
  if (!cond) { failed++; console.error('  ✗ ' + msg); }
}

/** 直道端点必须与所接节点的端口位置、方向一致 */
function validate(m: Model, label: string) {
  for (const s of Object.values(m.segs)) {
    check(s.len >= -1e-9, `${label}: seg ${s.id} 长度为负`);
    for (const k of ['a', 'b'] as const) {
      const e = s[k];
      if (isFree(e)) continue;
      const n = m.nodes[e.node];
      check(!!n, `${label}: seg ${s.id}.${k} 指向不存在的节点 ${e.node}`);
      if (!n || n.kind === 'platform') continue; // 平台的路口可以在边上任意位置
      const d = k === 'a' ? s.dir : opp(s.dir);
      const h = nodeHalf(n, d);
      const [x, y] = endPos(s, k);
      check(Math.abs(n.x + DX[d] * h - x) < 1e-6 && Math.abs(n.y + DY[d] * h - y) < 1e-6,
        `${label}: seg ${s.id}.${k} 与节点 ${n.id} 端口不对齐 (${x},${y}) vs node (${n.x},${n.y}) dir ${d}`);
    }
  }
  for (const n of Object.values(m.nodes)) {
    const c = portCount(nodePorts(m, n.id));
    if (n.kind === 'joint') check(c === 2, `${label}: 接头 ${n.id} 连接数 ${c}`);
    if (n.kind === 'block') check(c !== 1, `${label}: 路块 ${n.id} 只有 1 个连接（应被规范化）`);
  }
  // 网格：顶面法线朝上、无 NaN
  for (const em of buildFloorMeshes(m)) {
    for (const [mat, part] of Object.entries(em.parts)) {
      if (!part) continue;
      check(part.pos.every(Number.isFinite) && part.uv.every(Number.isFinite), `${label}: ${em.id} ${mat} 有非数值`);
      if (!mat.startsWith('FloorTop')) continue;
      for (let i = 0; i < part.pos.length; i += 9) {
        const p = part.pos;
        const e1 = [p[i + 3] - p[i], p[i + 4] - p[i + 1]], e2 = [p[i + 6] - p[i], p[i + 7] - p[i + 1]];
        check(e1[0] * e2[1] - e1[1] * e2[0] > 0, `${label}: ${em.id} 顶面三角形朝下`);
      }
    }
  }
}

function area(m: Model) {
  let a = 0;
  for (const em of buildFloorMeshes(m)) {
    for (const [mat, part] of Object.entries(em.parts)) {
      if (!part || !mat.startsWith('FloorTop')) continue;
      const p = part.pos;
      for (let i = 0; i < p.length; i += 9) {
        a += Math.abs((p[i + 3] - p[i]) * (p[i + 7] - p[i + 1]) - (p[i + 4] - p[i + 1]) * (p[i + 6] - p[i])) / 2;
      }
    }
  }
  return a;
}

// 异步的 scenario（导出 / 压缩这类）都记在这里，最后统一等待，免得失败没被统计到
const pending: Promise<void>[] = [];

function scenario(name: string, fn: () => void | Promise<void>) {
  console.log('• ' + name);
  const r = fn();
  if (r) pending.push(r);
}

scenario('1×1 拉长成直道', () => {
  const m = emptyModel();
  const s = blockToSeg(m, 1, 0);
  extendTo(m, s, 'b', 22.5);
  normalize(m);
  validate(m, 'extend');
  check(Math.abs(m.segs[s].len - 25) < 1e-9, '长度应为 25');
  check(Math.abs(area(m) - 125) < 1e-6, `顶面面积应为 125，实际 ${area(m)}`);
});

scenario('非 5 倍数长度 + 拐角 + 路口', () => {
  const m = emptyModel();
  const s = blockToSeg(m, 1, 0);
  extendTo(m, s, 'b', 26.25); // 长 28.75
  const c = makeCorner(m, s, 'b', 1)!;
  extendTo(m, c, 'b', 22.5);
  normalize(m);
  validate(m, 'corner');
  const blocks = Object.values(m.nodes).filter((n) => n.kind === 'block');
  check(blocks.length === 1, `应有 1 个拐角块，实际 ${blocks.length}`);
  const segX = Object.values(m.segs).find((x) => x.dir === 0)!;
  const br = makeBranch(m, segX.id, 10, 3)!;
  extendTo(m, br, 'b', -20);
  normalize(m);
  validate(m, 'branch');
  const t = Object.values(m.nodes).find((n) => n.kind === 'block' && portCount(nodePorts(m, n.id)) === 3);
  check(!!t, '应出现 T 字路口');
});

scenario('坡道：下游整体抬高', () => {
  const m = emptyModel();
  const s = blockToSeg(m, 1, 0);
  extendTo(m, s, 'b', 47.5);
  const j = insertJoint(m, s, 20)!;
  shiftDownstream(m, j, 2.5);
  normalize(m);
  validate(m, 'slope');
  const seg1 = m.segs[s];
  check(endZ(m, seg1, 'a') === 0 && endZ(m, seg1, 'b') === 2.5, '第一段应从 0 升到 2.5');
  const seg2 = Object.values(m.segs).find((x) => x.id !== s)!;
  check(endZ(m, seg2, 'b') === 2.5, '下游自由端应跟着升高');
});

scenario('凹槽：自动插入平凹转换', () => {
  const m = emptyModel();
  const s = blockToSeg(m, 1, 0);
  extendTo(m, s, 'b', 47.5);
  const j = insertJoint(m, s, 25)!;
  void j;
  const seg2 = Object.values(m.segs).find((x) => x.id !== s)!;
  setChainStyle(m, seg2.id, 'sink');
  normalize(m);
  validate(m, 'sink-chain-all');
  // 链上所有直道都变成凹槽，不应有转换块
  check(Object.values(m.nodes).every((n) => n.kind !== 'transition'), '整条链同样式时不应有转换块');
  // 先切开再刷一半
  const m2 = emptyModel();
  const a = blockToSeg(m2, 1, 0);
  extendTo(m2, a, 'b', 47.5);
  insertJoint(m2, a, 25);
  const b = Object.values(m2.segs).find((x) => x.id !== a)!;
  b.style = 'sink';
  normalize(m2);
  validate(m2, 'sink-half');
  const tr = Object.values(m2.nodes).filter((n) => n.kind === 'transition');
  check(tr.length === 1, `应插入 1 个转换块，实际 ${tr.length}`);
  check(Math.abs(area(m2) - 250) < 1e-6, `总面积应保持 250（水平投影），实际 ${area(m2)}`);
  // 刷回普通：转换块应消失
  setChainStyle(m2, b.id, 'normal');
  normalize(m2);
  validate(m2, 'sink-revert');
  check(Object.values(m2.nodes).every((n) => n.kind !== 'transition'), '刷回普通后转换块应消失');
});

scenario('分隔与端点切换', () => {
  const m = emptyModel();
  const s = blockToSeg(m, 1, 0);
  extendTo(m, s, 'b', 47.5);
  cutSeg(m, s, 20);
  normalize(m);
  validate(m, 'cut');
  check(Object.keys(m.segs).length === 2, '分隔后应有两段');
  check((m.segs[s].b as { style: string }).style === 'closed', '分隔后端点应为封闭');
  toggleEnd(m, s, 'b');
  validate(m, 'toggle');
  check((m.segs[s].b as { style: string }).style === 'open', '端点应切换为开放');
  const other = Object.values(m.segs).find((x) => x.id !== s)!;
  toggleEnd(m, other.id, 'a');
  normalize(m);
  validate(m, 'auto-join');
  check(Object.values(m.nodes).some((n) => n.kind === 'joint'), '两侧都开放后应自动接上');
});

scenario('环路：端点落在开口上自动连接', () => {
  const m = emptyModel();
  const s = blockToSeg(m, 1, 0);
  extendTo(m, s, 'b', 22.5);
  const c1 = makeCorner(m, s, 'b', 1)!;
  extendTo(m, c1, 'b', 22.5);
  normalize(m);
  const up = Object.values(m.segs).find((x) => x.dir === 1)!;
  const c2 = makeCorner(m, up.id, 'b', 2)!;
  extendTo(m, c2, 'b', -2.5);
  normalize(m);
  const left = Object.values(m.segs).find((x) => x.dir === 2)!;
  const c3 = makeCorner(m, left.id, 'b', 3)!;
  // 往下拉到正好碰到起点那段直道的侧面
  extendTo(m, c3, 'b', 2.5);
  tryConnect(m, c3, 'b');
  normalize(m);
  validate(m, 'loop');
  const blocks = Object.values(m.nodes).filter((n) => n.kind === 'block');
  check(blocks.length === 4, `闭合方环应有 4 个拐角块，实际 ${blocks.length}`);
  check(Object.values(m.segs).every((x) => !isFree(x.a) && !isFree(x.b)), '闭合后不应有自由端');
});

scenario('从路块侧面长出新路', () => {
  const m = emptyModel();
  const s = blockToSeg(m, 1, 0);
  extendTo(m, s, 'b', 22.5);
  const br = makeBranch(m, s, 10, 1)!;
  extendTo(m, br, 'b', 20);
  normalize(m);
  const blk = Object.values(m.nodes).find((n) => n.kind === 'block')!;
  const s2 = addSegAtPort(m, blk.id, 3)!;
  extendTo(m, s2, 'b', -20);
  normalize(m);
  validate(m, 'x-crossing');
  check(portCount(nodePorts(m, blk.id)) === 4, '应变成十字路口');
  void HALF;
});

scenario('斜坡上不能开分叉 / 拐弯', () => {
  const m = emptyModel();
  const s = blockToSeg(m, 1, 0);
  extendTo(m, s, 'b', 22.5);
  shiftFreeEnd(m, s, 'b', 2.5);
  check(makeBranch(m, s, 10, 1) === null, '斜坡上开分叉应被拒绝');
  check(makeCorner(m, s, 'b', 1) === null, '斜坡末端拐弯应被拒绝');
  check(Object.keys(m.nodes).length === 0, '不应生成路块');
});

scenario('零长度连接是刚性的：抬升时不出断崖', () => {
  const m = emptyModel();
  const s = blockToSeg(m, 1, 0);
  extendTo(m, s, 'b', 47.5);
  insertJoint(m, s, 25);
  const b = Object.values(m.segs).find((x) => x.id !== s)!;
  b.style = 'sink';
  normalize(m);
  const tr = Object.values(m.nodes).find((n) => n.kind === 'transition')!;
  shiftDownstream(m, tr.id, 2.5);
  normalize(m);
  validate(m, 'rigid');
  check(tr.z === 2.5, '转换块应升高');
});

scenario('拖动端点到另一端点：高度不同时本段变坡道并连接', () => {
  const m = emptyModel();
  const s = blockToSeg(m, 1, 0);
  extendTo(m, s, 'b', 47.5);
  cutSeg(m, s, 25);
  const other = Object.values(m.segs).find((x) => x.id !== s)!;
  // 把后半段整体平移开、抬高，再拉回来连接
  const ids = component(m, other.id);
  moveIds(m, ids, 10, 0);
  shiftFreeEnd(m, other.id, 'a', 2.5);
  shiftFreeEnd(m, other.id, 'b', 2.5);
  extendTo(m, s, 'b', 32.5);
  check(tryConnect(m, s, 'b', true), '应能连接');
  normalize(m);
  validate(m, 'connect-adjust');
  check(endZ(m, m.segs[s], 'b') === 2.5, '本段末端应被拉到目标高度');
});

platformScenarios(emptyModel, check, scenario);
railScenarios(check, scenario);
moreScenarios(emptyModel, check, scenario);
visualJoinScenarios(emptyModel, check, scenario);
deepTransitionScenario(emptyModel, check, scenario);
pieceScenarios(emptyModel, check, scenario);
flushOpeningScenario(emptyModel, check, scenario);
checkpointScenarios(emptyModel, check, scenario, validate);
objectScenarios(emptyModel, check, scenario);
platformRepairScenarios(emptyModel, check, scenario, validate);
rippleScenarios(emptyModel, check, scenario);
baseScenarios(emptyModel, check, scenario, validate);
guardScenarios(emptyModel, check, scenario);
newMapScenarios(check, scenario);
spawnScenarios(check, scenario);
ribbonInsetScenarios(emptyModel, check, scenario);
platformToRoadScenarios(emptyModel, check, scenario, validate);
railEditScenarios(emptyModel, check, scenario);
gapScenarios(emptyModel, check, scenario);
boxSolveScenarios(check, scenario);
boxConnScenarios(check, scenario);
boxOpsScenarios(check, scenario);
boxGoldenScenarios(check, scenario);
boxGeomScenarios(check, scenario);
boxExportScenarios(check, scenario);
boxShareScenarios(check, scenario);
await nmoScenarios(check, scenario);
for (const p of pending) await p;

if (failed) { console.error(`\n${failed} 项检查失败`); (globalThis as { process?: { exit(c: number): void } }).process?.exit(1); }
console.log('\n全部通过');
