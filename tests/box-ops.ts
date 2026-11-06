// box 版文档操作与坐标变换的纯函数测试：这里没有求解器，全是可手算的输入输出。
//
// 重点锁住几处容易写错、错了又不容易看出来的地方：切分斜坡时 dz 的分配、合并时开口位掩码的落位、
// 绕 90° 转之后坡的方向、旋转矩阵与四元数（倾斜）之间的换算、以及 toWorld/toLocal 的互逆。
import type { V3 } from '../src/box/ops';
import {
  Box, CP_PORT, Doc, Piece, boxTopAt, emptyDoc, elemXf, footprint, localBounds, pivotOf, toLocal, toWorld,
  virtualCells, type Elem,
} from '../src/box/types';
import {
  boundsOf, duplicate, elemBounds, expandGroups, groupElems, mergeBoxes, rotateElem, rotateWorld, splitBox,
  ungroupElems, uprightElem,
} from '../src/box/ops';
import { I3, M3, fromQuat, mod360, mul, rotAxis, rotZ, splitYaw, toQuat } from '../src/box/xform';

type Check = (cond: boolean, msg: string) => void;
type Scenario = (name: string, fn: () => void) => void;

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const vnear = (a: V3, b: V3, eps = 1e-6) => a.every((v, i) => near(v, b[i], eps));
const mnear = (a: M3, b: M3, eps = 1e-9) => a.every((v, i) => near(v, b[i], eps));

const box = (o: Partial<Box>): Box => ({ id: 1, kind: 'box', x: 0, y: 0, z: 0, sx: 5, sy: 5, depth: 1, style: 'normal', ...o });
const piece = (o: Partial<Piece>): Piece => ({ id: 1, kind: 'piece', type: 'transition-half', x: 0, y: 0, z: 0, rot: 0, ...o });
const docOf = (...elems: Elem[]): Doc => {
  const doc = emptyDoc();
  for (const e of elems) doc.elems[e.id] = e;
  doc.nextId = Math.max(0, ...elems.map((e) => e.id)) + 1;
  return doc;
};

export function boxOpsScenarios(check: Check, scenario: Scenario) {
  scenario('box 变换：矩阵与四元数互转', () => {
    const ms: M3[] = [I3, rotZ(0), rotZ(37), rotAxis(0, 30), rotAxis(1, -55), rotAxis(2, 12.5), mul(rotZ(20), rotAxis(1, 40))];
    for (const m of ms) {
      const back = fromQuat(toQuat(m));
      // toQuat 会把四个分量舍入到 1e-9，矩阵元素误差量级也是 1e-9
      check(mnear(back, m, 1e-8), `toQuat→fromQuat 应还原矩阵 ${m.map((v) => v.toFixed(3)).join(',')}`);
    }
    // 正交且行列式 +1
    for (const m of ms) {
      const mm = mul(m, [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
      check(mnear(mm, I3, 1e-12), '旋转矩阵应正交');
      const det = m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
      check(near(det, 1, 1e-12), `旋转矩阵行列式应为 +1，实际 ${det.toFixed(6)}`);
    }
    check(near(mod360(-90), 270) && near(mod360(360), 0) && near(mod360(450), 90), 'mod360 应把角度折进 [0, 360)');
  });

  scenario('box 变换：splitYaw 拆成 [0,90) 朝向 + 90° 整数倍', () => {
    for (let deg = 0; deg < 360; deg += 7) {
      const { ang, quarter } = splitYaw(deg);
      check(ang >= 0 && ang < 90, `splitYaw(${deg}) 的 ang 应在 [0,90)，实际 ${ang}`);
      check(near(mod360(ang + quarter * 90), mod360(deg), 1e-9), `splitYaw(${deg}) 还原失败：${ang}+${quarter}×90`);
    }
    // 90° 的整数倍应该落到 quarter 上
    for (const deg of [0, 90, 180, 270]) {
      const { ang, quarter } = splitYaw(deg);
      check(near(ang, 0) && quarter === deg / 90, `splitYaw(${deg}) 应为 ang=0 quarter=${deg / 90}`);
    }
  });

  scenario('box 包围盒：直放 / 绕 Z 转 / 斜坡 / 倾斜', () => {
    const flat = box({ x: 10, y: 20, sx: 5, sy: 2.5, z: 3, depth: 1 });
    const fb = elemBounds(flat);
    check(fb.x0 === 10 && fb.x1 === 15 && fb.y0 === 20 && fb.y1 === 22.5 && fb.z0 === 2 && fb.z1 === 3,
      `直放路面包围盒：${JSON.stringify(fb)}`);

    // ang 是绕原点的朝向坐标系：90° 之后 x/y 互换、符号跟着走
    const turned = box({ ...flat, id: 2, ang: 90 });
    const tb = elemBounds(turned);
    check(near(tb.x0, -22.5) && near(tb.x1, -20) && near(tb.y0, 10) && near(tb.y1, 15) && near(tb.z0, 2) && near(tb.z1, 3),
      `绕 Z 90° 的包围盒：${JSON.stringify(tb)}`);

    // 斜坡：包围盒的 z 从低端到高端
    const slope = box({ x: 0, y: 0, sx: 8, sy: 5, z: 2, depth: 1, slope: { axis: 0, dz: 4 } });
    const sb = elemBounds(slope);
    check(near(sb.z0, 1) && near(sb.z1, 6), `斜坡包围盒 z：${sb.z0}..${sb.z1}（应为 1..6）`);

    // 倾斜：包围盒只在元素附近，不会跑掉
    const tilted = box({ x: 0, y: 0, sx: 5, sy: 5, z: 0, depth: 1, q: toQuat(rotAxis(0, 30)) });
    const xb = elemBounds(tilted);
    check(Number.isFinite(xb.x0 + xb.y0 + xb.z0) && xb.x1 > xb.x0 && xb.y1 > xb.y0 && xb.z1 > xb.z0,
      `倾斜路面包围盒应有效：${JSON.stringify(xb)}`);

    // 合并几个包围盒
    const ub = boundsOf(docOf(flat, turned), [1, 2]);
    check(ub.x0 === Math.min(fb.x0, tb.x0) && ub.y1 === Math.max(fb.y1, tb.y1), 'boundsOf 应取并集');

  });

  scenario('box 坐标：toWorld / toLocal 互逆，pivot 不动', () => {
    const cases: Box[] = [
      box({ x: 3, y: -2, z: 1, sx: 4, sy: 2, depth: 0.5, ang: 25 }),
      box({ x: 3, y: -2, z: 1, sx: 4, sy: 2, depth: 0.5, q: toQuat(rotAxis(1, 35)) }),
      box({ x: 3, y: -2, z: 1, sx: 4, sy: 2, depth: 0.5, ang: 15, q: toQuat(rotAxis(0, 20)) }),
    ];
    for (const e of cases) {
      for (const p of [[0, 0, 0], [1.5, -2.25, 0.75], [-3, 4, -1]] as V3[]) {
        const back = toLocal(e, toWorld(e, p));
        // toQuat 把四元数舍入到 1e-9，倾斜元素的往返精度也就到 1e-8
        check(vnear(back, p, 1e-8), `toLocal(toWorld()) 应还原 ${JSON.stringify(p)}，实际 ${JSON.stringify(back)}`);
      }
      const w = toWorld(e, pivotOf(e));
      check(Number.isFinite(w[0] + w[1] + w[2]), 'pivot 的世界坐标应有限');
    }
    // 没有朝向 / 倾斜时是恒等变换
    const plain = box({});
    check(mnear(elemXf(plain).m, I3) && elemXf(plain).t.every((v) => v === 0), '没有朝向时 elemXf 应为恒等');
    // 只绕 Z 转时不产生平移
    const z90 = box({ ang: 90 });
    check(mnear(elemXf(z90).m, rotZ(90)) && elemXf(z90).t.every((v) => v === 0), '只绕 Z 转时 elemXf 不带平移');
    // 倾斜时绕自己的中心转：中心不动
    const tilted = box({ x: 2, y: 2, sx: 4, sy: 4, z: 0, depth: 1, q: toQuat(rotAxis(0, 40)) });
    const pv = pivotOf(tilted);
    check(vnear(toWorld(tilted, pv), pv, 1e-12), `倾斜路面应绕自己的中心转：${JSON.stringify(toWorld(tilted, pv))} vs ${JSON.stringify(pv)}`);
  });

  scenario('box 平面范围与顶面高度', () => {
    const flat = box({ x: 0, y: 0, sx: 8, sy: 5, z: 2, depth: 1 });
    check(boxTopAt(flat, 3, 3) === 2, '平路顶面高度处处等于 z');

    const slope = box({ x: 0, y: 0, sx: 8, sy: 5, z: 2, depth: 1, slope: { axis: 0, dz: 4 } });
    check(near(boxTopAt(slope, 0, 2.5), 2) && near(boxTopAt(slope, 8, 2.5), 6) && near(boxTopAt(slope, 4, 2.5), 4),
      '沿 X 的斜坡：两端 z / z+dz，中点一半');
    check(near(boxTopAt(slope, 4, 0), boxTopAt(slope, 4, 5)), '沿 X 的斜坡在 Y 方向上高度不变');
    const slopeY = box({ x: 0, y: 0, sx: 5, sy: 8, z: 2, depth: 1, slope: { axis: 1, dz: -4 } });
    check(near(boxTopAt(slopeY, 2.5, 0), 2) && near(boxTopAt(slopeY, 2.5, 8), -2), '沿 Y 的斜坡（负 dz）');

    const lb = localBounds(slope);
    check(near(lb.z0, 1) && near(lb.z1, 6) && near(lb.x1, 8) && near(lb.y1, 5), `斜坡 localBounds：${JSON.stringify(lb)}`);

    // 素材件在平面上是居中的一块 / 盘点是带子
    const half = piece({ type: 'transition-half', x: 10, y: 10, rot: 0 });
    const hf = footprint(half);
    check(near(hf.x0, 10 - 1.25) && near(hf.x1, 10 + 1.25) && near(hf.y0, 7.5) && near(hf.y1, 12.5),
      `半转换的平面范围：${JSON.stringify(hf)}`);
    const start = piece({ type: 'start', x: 0, y: 0, rot: 0 });
    const sf = footprint(start);
    check(near(sf.x0, -2.5) && near(sf.x1, CP_PORT.start) && near(sf.y0, -2.5) && near(sf.y1, 2.5),
      `起点的平面范围（路口朝 +X）：${JSON.stringify(sf)}`);
    const check2 = piece({ type: 'check', x: 0, y: 0, rot: 2 });
    const cf = footprint(check2);
    check(near(cf.x0, -CP_PORT.check) && near(cf.x1, CP_PORT.check) && near(cf.y0, -2.5), `盘点（rot=2）的平面范围：${JSON.stringify(cf)}`);

    // 机关才有虚拟路面，素材件没有
    check(virtualCells(half).length === 0, '素材件不应有虚拟路面');
  });

  scenario('box 切分：面积守恒、斜坡 dz 分配、开口位去掉', () => {
    const b = box({ id: 1, x: 0, y: 0, sx: 10, sy: 5, z: 2, depth: 1, slope: { axis: 0, dz: 4 }, open: (1 << 0) | (1 << 2) });
    const doc = docOf(b);
    const id = splitBox(doc, 1, 0, 4);
    check(id !== null && !!doc.elems[id!], '切分应返回新的一块');
    const nb = doc.elems[id!] as Box;
    check(near(b.sx, 4) && near(nb.x, 4) && near(nb.sx, 6), `切分后的宽度：${b.sx} + ${nb.sx}`);
    check(near(b.slope!.dz, 1.6) && near(nb.slope!.dz, 2.4), `斜坡 dz 应按长度分配：${b.slope!.dz} + ${nb.slope!.dz}（应为 1.6 + 2.4）`);
    check(near(b.z, 2) && near(nb.z, 3.6), `切口右侧的 z 应抬高：${b.z} / ${nb.z}`);
    check(near(nb.z + nb.slope!.dz, 6), `切开后右端应仍是原来的高处 6，实际 ${nb.z + nb.slope!.dz}`);
    check(near(b.sx * b.sy + nb.sx * nb.sy, 50), '切分后面积应守恒');
    check(b.open === 1 << 2, `切口一侧应保留外侧的开口位，实际 ${b.open}`);
    check(nb.open === 1 << 0, `切口另一侧应保留外侧的开口位，实际 ${nb.open}`);

    // 沿 Y 切、非斜坡
    const d2 = docOf(box({ id: 1, x: 0, y: 0, sx: 5, sy: 10, z: 0, depth: 1 }));
    const id2 = splitBox(d2, 1, 1, 3) as number;
    check(near((d2.elems[1] as Box).sy, 3) && near((d2.elems[id2] as Box).sy, 7) && (d2.elems[id2] as Box).slope === undefined,
      '沿 Y 切分不应引入斜坡');

    // 越界 / 非路面
    const d3 = docOf(box({ id: 1, x: 0, y: 0, sx: 5, sy: 5 }));
    check(splitBox(d3, 1, 0, 0.005) === null && splitBox(d3, 1, 0, 5.5) === null, '切在边界上应该拒绝');
    const d4 = docOf(piece({ id: 1 }));
    check(splitBox(d4, 1, 0, 2.5) === null, '素材件不能被切分');
  });

  scenario('box 合并：矩形才合并、保留最小 id、开口位落在外边', () => {
    const a = box({ id: 1, x: 0, y: 0, sx: 5, sy: 5, z: 0, depth: 1, open: 1 << 2 });
    const b = box({ id: 2, x: 5, y: 0, sx: 5, sy: 5, z: 0, depth: 1, open: 1 << 0 });
    const doc = docOf(a, b);
    const r = mergeBoxes(doc, [1, 2]);
    check(r.ok, `两块并排应该能合并：${r.ok ? '' : r.msg}`);
    const kept = doc.elems[1] as Box;
    check(r.ok && r.id === 1 && doc.elems[2] === undefined, '应保留最小 id 并删掉另一块');
    check(near(kept.sx, 10) && near(kept.sy, 5) && near(kept.x, 0), `合并后的范围：${kept.sx}×${kept.sy}`);
    check(kept.open === ((1 << 2) | (1 << 0)), `合并后外侧的开口位应保留（内部那两条应丢掉），实际 ${kept.open}`);

    // 拒绝：非矩形（L 形）
    const l1 = box({ id: 1, x: 0, y: 0, sx: 5, sy: 5 });
    const l2 = box({ id: 2, x: 5, y: 0, sx: 5, sy: 5 });
    const l3 = box({ id: 3, x: 0, y: 5, sx: 5, sy: 5 });
    const dl = docOf(l1, l2, l3);
    const rl = mergeBoxes(dl, [1, 2, 3]);
    check(!rl.ok && Object.keys(dl.elems).length === 3, 'L 形不应合并，且不应删元素');

    // 拒绝：样式 / 高度 / 厚度 / 斜坡不同
    const cases: [string, Box, Box][] = [
      ['样式', box({ id: 1 }), box({ id: 2, x: 5, style: 'sink' })],
      ['高度', box({ id: 1 }), box({ id: 2, x: 5, z: 1 })],
      ['厚度', box({ id: 1 }), box({ id: 2, x: 5, depth: 2 })],
      ['斜坡', box({ id: 1 }), box({ id: 2, x: 5, slope: { axis: 0, dz: 1 } })],
    ];
    for (const [why, p, q] of cases) {
      const r2 = mergeBoxes(docOf(p, q), [1, 2]);
      check(!r2.ok, `${why}不同的两块不应合并`);
    }
    // 单个 / 混入非路面
    check(!mergeBoxes(docOf(box({ id: 1 })), [1]).ok, '单块不应合并');
    check(!mergeBoxes(docOf(box({ id: 1 }), piece({ id: 2, x: 5 })), [1, 2]).ok, '混入素材件不应合并');
  });

  scenario('box 复制与绑定组', () => {
    const a = box({ id: 1, x: 0, y: 0, sx: 5, sy: 5, group: 3 });
    const b = piece({ id: 2, x: 10, y: 0, group: 3 });
    const doc = docOf(a, b);
    const ids = duplicate(doc, [1, 2]);
    check(ids.length === 2 && ids.every((id) => id !== 1 && id !== 2), `复制应产生新 id：${ids}`);
    const [ca, cb] = ids.map((id) => doc.elems[id]);
    check(ca.kind === 'box' && ca.x === 0 && ca.sx === 5, '复制出来的路面几何应一致');
    check(cb.kind === 'piece' && cb.x === 10 && cb.type === 'transition-half', '复制出来的素材件几何应一致');
    check(ca.group !== undefined && ca.group === cb.group && ca.group !== 3, `复制出来的应该是一个新的绑定组：${ca.group}`);
    check(expandGroups(doc, [ca.id]).size === 2, '选中复制件应带出同组的那一个');

    // 分组 / 解绑
    groupElems(doc, [1, 2]);
    const g = (doc.elems[1] as Box).group;
    check(g !== undefined && g === (doc.elems[2] as Piece).group, '同一组应拿到同一个组号');
    check(expandGroups(doc, [1]).has(2), '选中组内任意一个应带出全组');
    ungroupElems(doc, [1]);
    check(doc.elems[1].group === undefined && doc.elems[2].group === g, '解绑只影响选中的元素');
  });

  scenario('box 绕竖直轴转 90°（绕点旋转）', () => {
    const b = box({ id: 1, x: 1, y: 2, sx: 3, sy: 2, z: 3, depth: 1, open: 1, closed: 1 << 1 });
    rotateElem(b, 0, 0);
    check(near(b.x, -4) && near(b.y, 1) && near(b.sx, 2) && near(b.sy, 3), `转 90° 后的范围：x=${b.x} y=${b.y} ${b.sx}×${b.sy}`);
    check(near(b.z, 3) && near(b.depth, 1), '转 90° 不应动高度和厚度');
    check(b.open === 1 << 1 && b.closed === 1 << 2, `开口/封口位应顺时针转一格：open=${b.open} closed=${b.closed}`);

    // 斜坡：沿 +X 升高 → 沿 +Y 升高；沿 +Y 升高 → 沿 -X 升高，低端换到另一头
    const sx = box({ id: 1, x: 0, y: 0, sx: 5, sy: 5, z: 1, slope: { axis: 0, dz: 2 } });
    rotateElem(sx, 0, 0);
    check(sx.slope!.axis === 1 && near(sx.slope!.dz, 2) && near(sx.z, 1), '沿 X 的坡转 90° 后沿 Y，dz 与 z 不变');
    const sy = box({ id: 1, x: 0, y: 0, sx: 5, sy: 5, z: 1, slope: { axis: 1, dz: 2 } });
    rotateElem(sy, 0, 0);
    check(sy.slope!.axis === 0 && near(sy.slope!.dz, -2) && near(sy.z, 3), `沿 Y 的坡转 90° 后沿 X 反向、z 抬高：${JSON.stringify(sy.slope)} z=${sy.z}`);

    // 素材件：rot +1；盘点的重生方向 +90
    const p = piece({ id: 1, x: 2, y: 3, rot: 0 });
    rotateElem(p, 0, 0);
    check(p.rot === 1 && near(p.x, -3) && near(p.y, 2), `素材件转 90°：rot=${p.rot} (${p.x},${p.y})`);
    const cp = piece({ id: 1, type: 'check', rot: 1, spawn: 0 });
    rotateElem(cp, 0, 0);
    check(cp.spawn === 90, `盘点的重生方向应跟着转：${cp.spawn}`);
  });

  scenario('box 绕任意轴转（旋转矩阵）：保持转轴不动', () => {
    // 竖直轴 90°：范围和旋转前一样大，只是 x/y 互换，中心不动
    const b = box({ id: 1, x: 0, y: 0, sx: 4, sy: 2, z: 1, depth: 1 });
    const c0 = [(0 + 4) / 2, (0 + 2) / 2, (0 + 1) / 2];
    rotateWorld(b, rotZ(90), [c0[0], c0[1], c0[2]]);
    const nb = elemBounds(b);
    check(near(nb.x1 - nb.x0, 2) && near(nb.y1 - nb.y0, 4), `绕中心转 90° 后范围应变成 2×4：${nb.x1 - nb.x0}×${nb.y1 - nb.y0}`);
    check(near((nb.x0 + nb.x1) / 2, c0[0], 1e-5) && near((nb.y0 + nb.y1) / 2, c0[1], 1e-5) && near(nb.z0, 0) && near(nb.z1, 1),
      `绕中心转不应移动中心/高度：${JSON.stringify(nb)}`);

    // 非 90° 的朝向：记成 ang，中心不动
    const b2 = box({ id: 1, x: 2, y: 2, sx: 4, sy: 4, z: 0, depth: 1 });
    const before = toWorld(b2, pivotOf(b2));
    rotateWorld(b2, rotZ(30), before);
    check(near(b2.ang!, 30) && b2.q === undefined, `转 30° 应记成 ang=30，实际 ${b2.ang}`);
    check(vnear(toWorld(b2, pivotOf(b2)), before, 1e-5), `转 30° 后 pivot 应不动：${JSON.stringify(toWorld(b2, pivotOf(b2)))} vs ${JSON.stringify(before)}`);

    // 倾斜：记成四元数，中心不动
    const b3 = box({ id: 1, x: 2, y: 2, sx: 4, sy: 4, z: 0, depth: 1 });
    const c3 = toWorld(b3, pivotOf(b3));
    rotateWorld(b3, rotAxis(0, 45), c3);
    check(!!b3.q && b3.ang === undefined, '倾斜之后应记成四元数、没有 ang');
    check(vnear(toWorld(b3, pivotOf(b3)), c3, 1e-5), `倾斜后 pivot 应不动：${JSON.stringify(toWorld(b3, pivotOf(b3)))} vs ${JSON.stringify(c3)}`);

    // 一圈 360° 回到原点
    const b4 = box({ id: 1, x: 1, y: 2, sx: 3, sy: 2, z: 0, depth: 1 });
    const c4 = toWorld(b4, pivotOf(b4));
    for (let i = 0; i < 4; i++) rotateWorld(b4, rotZ(90), c4);
    check(near(b4.sx, 3) && near(b4.sy, 2) && near(b4.x, 1) && near(b4.y, 2), `转四圈应回到原位：(${b4.x},${b4.y}) ${b4.sx}×${b4.sy}`);
  });

  scenario('box 摆正倾斜的元素', () => {
    const b = box({ id: 1, x: 2, y: 2, sx: 4, sy: 3, z: 1, depth: 1, q: toQuat(mul(rotZ(20), rotAxis(0, 35))) });
    const center = toWorld(b, pivotOf(b));
    uprightElem(b);
    check(b.q === undefined, '摆正之后不应再有四元数');
    check(near(b.ang ?? 0, 20, 1e-5), `摆正后应保留绕 Z 的朝向 20°，实际 ${b.ang}`);
    const lb = localBounds(b);
    check(near(lb.x1 - lb.x0, 4) && near(lb.y1 - lb.y0, 3), `摆正后平面尺寸应还原：${lb.x1 - lb.x0}×${lb.y1 - lb.y0}`);
    check(vnear(toWorld(b, pivotOf(b)), center, 1e-5), `摆正后中心应不动：${JSON.stringify(toWorld(b, pivotOf(b)))} vs ${JSON.stringify(center)}`);

    // 平的路面调用它应该什么都不做
    const flat = box({ id: 1, ang: 15 });
    const snapshot = JSON.stringify(flat);
    uprightElem(flat);
    check(JSON.stringify(flat) === snapshot, '没有倾斜的元素不应被改动');
  });
}
