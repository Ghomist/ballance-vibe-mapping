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
