// 平台与新交互相关的场景测试（由 run.ts 引入）
import { addSegAtPlatform, blockToPlatform, edgeRunAt, extrudePlatform, segToPlatform } from '../src/model/platform';
import { blockToSeg, extendFlat, extendTo, makeBranch, makeCorner, normalize, shiftFreeEnd, tryConnect } from '../src/model/ops';
import { Model, cloneModel, endZ, nodeLinks } from '../src/model/types';
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
  scenario('平台接凹槽路：窄平凹转换嵌在平台内部', () => {
    const m = emptyModel();
    const p = blockToPlatform(m, 1, 0, 15)!; // x ∈ [-2.5,17.5], y ∈ [-2.5,2.5]
    const s = addSegAtPlatform(m, p, 7.5, -2.5, 3)!;
    extendTo(m, s, 'b', -20);
    m.segs[s].style = 'sink';
    normalize(m);
    const tr = Object.values(m.nodes).find((n) => n.kind === 'transition');
    check(!!tr && !!tr.narrow && tr.inPlatform === p, '应在平台内插入窄转换');
    check(!!tr && Math.abs(tr.y - -1.25) < 1e-9, `窄转换中心应在平台内 y=-1.25，实际 ${tr?.y}`);
    check(Math.abs(m.segs[s].len - 17.5) < 1e-9, `凹槽路长度应保持不变，实际 ${m.segs[s].len}`);
    // 平台顶面面积 = 平台 - 转换块所占
    let a = 0;
    for (const em of buildFloorMeshes(m)) if (em.id === p) for (const [mat, part] of Object.entries(em.parts)) {
      if (!part || !mat.startsWith('FloorTop')) continue;
      const q = part.pos;
      for (let i = 0; i < q.length; i += 9) a += Math.abs((q[i + 3] - q[i]) * (q[i + 7] - q[i + 1]) - (q[i + 4] - q[i + 1]) * (q[i + 6] - q[i])) / 2;
    }
    check(Math.abs(a - (100 - 12.5)) < 1e-6, `平台顶面应扣掉 12.5，实际 ${a}`);
    // 改回普通路：转换块撤掉，路直接接回平台
    m.segs[s].style = 'normal';
    normalize(m);
    check(!Object.values(m.nodes).some((n) => n.kind === 'transition'), '样式一致后转换块应撤掉');
    check(nodeLinks(m, p).length === 1 && m.segs[s].a.node === p, '路应直接接回平台');
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

import { cutSeg } from '../src/model/ops';

export function visualJoinScenarios(emptyModel: () => Model, check: (c: boolean, msg: string) => void, scenario: (n: string, f: () => void) => void) {
  const sideArea = (m: Model) => {
    let a = 0;
    for (const em of buildFloorMeshes(m)) {
      const p = em.parts.FloorSide?.pos ?? [];
      for (let i = 0; i < p.length; i += 9) {
        const u = [p[i + 3] - p[i], p[i + 4] - p[i + 1], p[i + 5] - p[i + 2]], v = [p[i + 6] - p[i], p[i + 7] - p[i + 1], p[i + 8] - p[i + 2]];
        a += Math.hypot(u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]) / 2;
      }
    }
    return a;
  };
  scenario('断开都是显式的：分隔后两端封闭可见；开放端点对上就接成一整块', () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 0);
    extendTo(m, s, 'b', 22.5);
    const whole = sideArea(m);
    cutSeg(m, s, 10);
    normalize(m);
    check(Object.keys(m.segs).length === 2, '分隔后应是两段');
    check(sideArea(m) > whole + 1, '分隔处应显示封闭端面');
    // 两端都改成开放：花纹对上，逻辑上接回一整块
    const other = Object.values(m.segs).find((x) => x.id !== s)!;
    (m.segs[s].b as { style: string }).style = 'open';
    (other.a as { style: string }).style = 'open';
    normalize(m);
    check(Object.values(m.nodes).some((n) => n.kind === 'joint'), '开放端点对上后应接上');
    check(Math.abs(sideArea(m) - whole) < 1e-6, '接上后不应有端面');
    // 开放端点正对路块空端口：也接上
    const m2 = emptyModel();
    const id = m2.nextId++;
    m2.segs[id] = { id, x: 2.5, y: 0, dir: 0, len: 10, style: 'normal', a: { node: null, z: 0, style: 'open' }, b: { node: null, z: 0, style: 'closed' } };
    normalize(m2);
    check(!m2.nodes[1] && Math.abs(m2.segs[id].len - 15) < 1e-9, '开放端点正对路块空端口应接上（1×1 并入成为封闭端头）');
  });
}

export function deepTransitionScenario(emptyModel: () => Model, check: (c: boolean, msg: string) => void, scenario: (n: string, f: () => void) => void) {
  const setup = (platformStyle: 'normal' | 'sink', roadStyle: 'normal' | 'sink') => {
    const m = emptyModel();
    const p = blockToPlatform(m, 1, 0, 15)!; // x ∈ [-2.5,17.5], y ∈ [-2.5,2.5]
    m.nodes[p].style = platformStyle;
    const s = addSegAtPlatform(m, p, 7.5, -2.5, 3)!;
    extendTo(m, s, 'b', -20);
    m.segs[s].style = roadStyle;
    normalize(m);
    const tr = Object.values(m.nodes).find((n) => n.kind === 'transition');
    return { m, p, s, tr };
  };
  const zsAt = (m: Model, id: number, mat: string, y: number) => {
    const part = buildFloorMeshes(m).find((e) => e.id === id)!.parts[mat as 'FloorTopBorder']!;
    const out: { x: number; z: number }[] = [];
    for (let i = 0; i < part.pos.length; i += 3) if (Math.abs(part.pos[i + 1] - y) < 1e-6) out.push({ x: part.pos[i], z: part.pos[i + 2] });
    return out;
  };
  scenario('普通路接凹槽平台：半块平路，平台内侧一端下沉 0.7', () => {
    const { m, p, s, tr } = setup('sink', 'normal');
    check(!!tr && !!tr.ramp && tr.inPlatform === p && Math.abs(tr.y - -1.25) < 1e-9, '应在平台内放半块平路');
    check(Math.abs(m.segs[s].len - 17.5) < 1e-9, '路长度不变');
    const inner = zsAt(m, tr!.id, 'FloorTopBorder', 0), outer = zsAt(m, tr!.id, 'FloorTopBorder', -2.5);
    check(inner.length > 0 && inner.every((v) => Math.abs(v.z + 0.7) < 1e-6), '平台内侧整条边应在 -0.7');
    check(outer.length > 0 && outer.every((v) => Math.abs(v.z) < 1e-6), '靠路一端应全在 0');
  });
  scenario('样式相同的路接平台：开口带由两块 1/4 内角拼成', () => {
    for (const st of ['normal', 'sink'] as const) {
      const { m, p, tr } = setup(st, st);
      check(!tr, `${st}：不应有衔接块`);
      // 平台顶面（含内角块）面积 = 整个平台
      let area = 0;
      const em = buildFloorMeshes(m).find((e) => e.id === p)!;
      for (const [mat, part] of Object.entries(em.parts)) {
        if (!part || !mat.startsWith('FloorTop')) continue;
        const q = part.pos;
        for (let i = 0; i < q.length; i += 9) area += Math.abs((q[i + 3] - q[i]) * (q[i + 7] - q[i + 1]) - (q[i + 4] - q[i + 1]) * (q[i + 6] - q[i])) / 2;
      }
      check(Math.abs(area - 100) < 1e-6, `${st}：平台顶面面积应为 100，实际 ${area}`);
      // 开口外沿：两角在 0，中点在 -sink
      const outer = zsAt(m, p, st === 'sink' ? 'FloorTopProfil' : 'FloorTopBorder', -2.5).filter((v) => v.x > 4 && v.x < 11);
      const mid = outer.filter((v) => Math.abs(v.x - 7.5) < 1e-6), corner = outer.filter((v) => Math.abs(Math.abs(v.x - 7.5) - 2.5) < 1e-6);
      const sink = st === 'sink' ? -0.7 : 0;
      check(mid.length > 0 && mid.every((v) => Math.abs(v.z - sink) < 1e-6) && corner.every((v) => Math.abs(v.z) < 1e-6), `${st}：开口处截面应与路面一致`);
    }
  });
  scenario('凹槽路接普通平台：窄平凹转换；样式变化后衔接块随之替换', () => {
    const a = setup('normal', 'sink');
    check(!!a.tr && !!a.tr.narrow && !a.tr.ramp && a.tr.inPlatform === a.p, '应为窄平凹转换');
    // 切换样式后衔接块随之替换：路改为普通 -> 普通接普通，撤掉；平台再改凹槽 -> 半块平路
    a.m.segs[a.s].style = 'normal';
    normalize(a.m);
    check(!Object.values(a.m.nodes).some((n) => n.kind === 'transition'), '样式一致后应撤掉衔接块');
    a.m.nodes[a.p].style = 'sink';
    normalize(a.m);
    const tr2 = Object.values(a.m.nodes).find((n) => n.kind === 'transition');
    check(!!tr2 && !!tr2.ramp, '平台改为凹槽后应换成半块平路');
  });
}

import { movePiece, pieceOf } from '../src/model/ops';

export function pieceScenarios(emptyModel: () => Model, check: (c: boolean, msg: string) => void, scenario: (n: string, f: () => void) => void) {
  // U 形：左竖 - 下横 - 右竖，两个拐角
  const build = () => {
    const m = emptyModel();
    const s = blockToSeg(m, 1, 1);         // 从原点往 +Y
    extendTo(m, s, 'b', 22.5);
    const c1 = makeCorner(m, s, 'a', 0)!;  // 下端拐向 +X
    extendTo(m, c1, 'b', 22.5);
    normalize(m);
    const bottom = Object.values(m.segs).find((x) => x.dir === 0)!;
    const c2 = makeCorner(m, bottom.id, 'b', 1)!; // 右端拐向 +Y
    extendTo(m, c2, 'b', 22.5);
    normalize(m);
    return m;
  };
  scenario('gizmo 只移动一块：上下移动，相邻路段变坡道', () => {
    const m = build();
    const bottom = Object.values(m.segs).find((x) => x.dir === 0)!;
    const len0 = bottom.len;
    const piece = pieceOf(m, bottom.id);
    check(piece.size === 1, '下横这一块只有一段');
    check(movePiece(m, piece, 0, 0, 2.5), '应能上移');
    const corners = Object.values(m.nodes).filter((n) => n.kind === 'block');
    check(corners.length === 2 && corners.every((n) => n.z === 2.5), '两端拐角随之上移');
    check(m.segs[bottom.id].len === len0, '下横长度不变');
    const ups = Object.values(m.segs).filter((x) => x.dir !== 0);
    check(ups.every((x) => Math.abs(endZ(m, x, 'a') - endZ(m, x, 'b')) === 2.5), '两侧竖路变成坡道（没有被拖着一起移动）');
  });
  scenario('gizmo 只移动一块：水平移动，同轴伸缩、垂直平移', () => {
    const m = build();
    const bottom = Object.values(m.segs).find((x) => x.dir === 0)!;
    const ups0 = Object.values(m.segs).filter((x) => x.dir !== 0).map((x) => x.len);
    check(movePiece(m, pieceOf(m, bottom.id), 0, -5, 0), '下横往 -Y 移动');
    const ups = Object.values(m.segs).filter((x) => x.dir !== 0);
    check(ups.every((x, i) => Math.abs(x.len - ups0[i] - 5) < 1e-9), '两侧竖路各伸长 5');
    // 沿 X 移动：右侧拐角 + 右竖要跟着平移，下横不是这块所以…… 这里移动的是左竖
    const left = Object.values(m.segs).find((x) => x.dir === 1 && x.x < 5)!;
    const bLen = m.segs[bottom.id].len;
    check(movePiece(m, pieceOf(m, left.id), -5, 0, 0), '左竖往 -X 移动');
    check(Math.abs(m.segs[bottom.id].len - bLen - 5) < 1e-9, '下横伸长 5');
    check(!movePiece(cloneModel(m), pieceOf(m, left.id), 100, 0, 0), '会把下横压成负长度时拒绝');
  });
}
