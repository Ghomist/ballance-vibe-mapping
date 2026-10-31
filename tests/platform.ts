// 平台与新交互相关的场景测试（由 run.ts 引入）
import { addSegAtPlatform, blockToPlatform, edgeRunAt, extrudePlatform, segToPlatform } from '../src/model/platform';
import { blockToSeg, extendFlat, extendTo, makeBranch, normalize, shiftFreeEnd, tryConnect } from '../src/model/ops';
import { Model, endZ, nodeLinks } from '../src/model/types';
import { buildFloorMeshes } from '../src/geom/floor';

export function platformScenarios(emptyModel: () => Model, check: (c: boolean, msg: string) => void, scenario: (n: string, f: () => void) => void) {
  const topArea = (m: Model) => {
    let a = 0;
    for (const em of buildFloorMeshes(m)) for (const [mat, part] of Object.entries(em.parts)) {
      if (!part || !mat.startsWith('FloorTop')) continue;
      const p = part.pos;
      for (let i = 0; i < p.length; i += 9) a += Math.abs((p[i + 3] - p[i]) * (p[i + 7] - p[i + 1]) - (p[i + 4] - p[i + 1]) * (p[i + 6] - p[i])) / 2;
    }
    return a;
  };

  scenario('直道侧面拉成平台', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0);
    extendTo(m, s, 'b', 17.5); // 长 20
    const p = segToPlatform(m, s, 1, 10)!;
    normalize(m);
    check(!!m.nodes[p] && m.nodes[p].kind === 'platform', '应生成平台');
    check(Math.abs(topArea(m) - 20 * 15) < 1e-6, `平台面积应为 300，实际 ${topArea(m)}`);
  });

  scenario('平台拉边 / 合并 / 接路', () => {
    const m = emptyModel();
    const p = blockToPlatform(m, 1, 0, 15)!; // 20 × 5，x ∈ [-2.5, 17.5]
    const run = edgeRunAt(m.nodes[p], 5, 2.5)!;
    check(run.out === 1, '应选中 +Y 的边');
    extrudePlatform(m, p, run, 10);
    check(Math.abs(topArea(m) - 20 * 15) < 1e-6, `拉边后面积应为 300，实际 ${topArea(m)}`);
    // 再造一个挨着的平台：应自动合并
    const id = m.nextId++;
    m.nodes[id] = { id, kind: 'block', x: 20, y: 0, z: 0, style: 'normal' };
    blockToPlatform(m, id, 0, 0);
    normalize(m);
    check(Object.values(m.nodes).filter((n) => n.kind === 'platform').length === 1, '相邻平台应合并');
    // 从平台边上长出一条路
    const s = addSegAtPlatform(m, p, 7.5, -2.5, 3)!;
    check(s !== null, '应能从平台边上长路');
    extendTo(m, s, 'b', -20);
    normalize(m);
    check(nodeLinks(m, p).length === 1, '平台应有一条连接');
    // 平台在接路的这条边往外推：路跟着缩短
    const run2 = edgeRunAt(m.nodes[p], 7.5, -2.5)!;
    extrudePlatform(m, p, run2, 5);
    check(Math.abs(m.segs[s].len - 12.5) < 1e-6, `路应缩短到 12.5，实际 ${m.segs[s].len}`);
  });

  scenario('路端点拉到平台边上自动接上', () => {
    const m = emptyModel();
    const p = blockToPlatform(m, 1, 0, 15)!;
    const id = m.nextId++;
    m.segs[id] = { id, x: 7.5, y: -20, dir: 1, len: 10, style: 'normal', a: { node: null, z: 0, style: 'closed' }, b: { node: null, z: 0, style: 'closed' } };
    extendTo(m, id, 'b', -2.5);
    check(tryConnect(m, id, 'b', true), '应连接到平台');
    normalize(m);
    check(nodeLinks(m, p).length === 1, '平台应有一条连接');
  });

  scenario('斜坡端点往外拉：续接平路', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0);
    extendTo(m, s, 'b', 22.5);
    shiftFreeEnd(m, s, 'b', 2.5);
    const ns = extendFlat(m, s, 'b')!;
    extendTo(m, ns, 'b', 32.5);
    normalize(m);
    check(endZ(m, m.segs[s], 'b') === 2.5 && endZ(m, m.segs[ns], 'b') === 2.5, '新路段应是平的');
    check(Math.abs(m.segs[s].len - 25) < 1e-6, '原斜坡长度不变');
  });

  scenario('分支拉到 0 即删除', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0);
    extendTo(m, s, 'b', 22.5);
    const br = makeBranch(m, s, 10, 1)!;
    extendTo(m, br, 'b', 20);
    normalize(m);
    const brSeg = m.segs[br];
    extendTo(m, br, 'b', brSeg.y);
    normalize(m);
    check(!m.segs[br], '分支应被删除');
    check(Object.values(m.nodes).every((n) => n.kind !== 'block'), '路口应恢复成直道');
  });
}

import { buildRail } from '../src/geom/rail';
import { DOUBLE_OFFSET, MONO_OFFSET, railEnd } from '../src/model/rail';

export function railScenarios(check: (c: boolean, msg: string) => void, scenario: (n: string, f: () => void) => void) {
  scenario('钢轨路径与网格', () => {
    const r = { id: 1, x: 0, y: 0, z: 0, heading: 0, pieces: [
      { kind: 'double' as const, len: 10, radius: 0, angle: 0, dz: 0 },
      { kind: 'double' as const, len: 0, radius: 5, angle: 90, dz: 0 },
      { kind: 'mono' as const, len: 10, radius: 0, angle: 0, dz: -2.5 },
    ] };
    const e = railEnd(r);
    check(Math.abs(e.x - 15) < 1e-9 && Math.abs(e.y - 15) < 1e-9 && e.z === -2.5 && e.heading === 90, `终点应为 (15,15,-2.5) 朝 90°，实际 ${JSON.stringify(e)}`);
    check(Math.abs(DOUBLE_OFFSET - MONO_OFFSET - 0.9334) < 1e-3 && DOUBLE_OFFSET === -0.35, '双轨顶端对齐路径高度，单轨下沉约 0.933（BBP 单双轨转换）');
    const mesh = buildRail(r);
    // 每个三角形的几何法线应与顶点径向法线同向（朝外）
    let bad = 0;
    for (let i = 0; i < mesh.pos.length; i += 9) {
      const p = mesh.pos;
      const e1 = [p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]];
      const e2 = [p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]];
      const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
      const vn = mesh.nrm.slice(i, i + 3);
      if (n[0] * vn[0] + n[1] * vn[1] + n[2] * vn[2] < 0) bad++;
    }
    check(bad === 0, `钢轨有 ${bad} 个三角形朝内`);
  });
}

import { addBlock, moveDownstream } from '../src/model/ops';
import { extendStart, splitRail } from '../src/model/rail';

export function moreScenarios(emptyModel: () => Model, check: (c: boolean, msg: string) => void, scenario: (n: string, f: () => void) => void) {
  scenario('平台接凹槽路：插入窄平凹转换（长 2.5）', () => {
    const m = emptyModel();
    const p = blockToPlatform(m, 1, 0, 15)!; // x ∈ [-2.5,17.5], y ∈ [-2.5,2.5]
    const s = addSegAtPlatform(m, p, 7.5, -2.5, 3)!;
    extendTo(m, s, 'b', -20);
    m.segs[s].style = 'sink';
    normalize(m);
    const tr = Object.values(m.nodes).find((n) => n.kind === 'transition');
    check(!!tr && !!tr.narrow, '应插入窄转换');
    check(!!tr && Math.abs(tr.y - -3.75) < 1e-9, `窄转换中心应在 y=-3.75，实际 ${tr?.y}`);
    check(Math.abs(m.segs[s].len - 15) < 1e-9, `凹槽路应缩短 2.5，实际 ${m.segs[s].len}`);
  });

  scenario('六向移动：同轴伸缩、垂直方向受限', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0);
    extendTo(m, s, 'b', 22.5);
    const br = makeBranch(m, s, 10, 1)!;
    extendTo(m, br, 'b', 20);
    normalize(m);
    // 分支末端整体沿 +Y 移动：分支直道伸长
    const blk = Object.values(m.nodes).find((n) => n.kind === 'block')!;
    check(moveDownstream(m, blk.id, 0, 5, 0) === false, '路口沿 Y 移动会让 X 向直道错位，应被拒绝');
    const len0 = m.segs[br].len;
    check(moveDownstream(m, blk.id, 5, 0, 0) === true, '路口沿 X 移动应可行（上游 X 向直道伸长）');
    check(Math.abs(m.segs[br].len - len0) < 1e-9, '分支随路口平移，长度不变');
    const id = addBlock(m, 50, 50, 0);
    check(moveDownstream(m, id, 0, 7.5, 2.5), '独立块可任意移动');
    check(m.nodes[id].y === 57.5 && m.nodes[id].z === 2.5, '独立块位置应更新');
  });

  scenario('钢轨：起点延伸、分隔', () => {
    const r = { id: 1, x: 0, y: 0, z: 0, heading: 0, pieces: [{ kind: 'double' as const, len: 20, radius: 0, angle: 0, dz: 0 }] };
    extendStart(r, 5);
    check(r.x === -5 && r.pieces[0].len === 25, '起点应往回延伸 5');
    const tail = splitRail(r, 10, 2)!;
    check(!!tail && r.pieces[0].len === 10 && tail.pieces[0].len === 15 && tail.x === 5, '应在弧长 10 处切开');
  });
}
