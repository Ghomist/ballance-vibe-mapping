// box 版的几何基线：钢轨路径与网格、护栏圆管、吸附特征点、外沿查询。
//
// 钢轨这段的重点是「截面不能随坡度变」「顶端永远和路径高度齐平」「绕序朝外」——
// 这三条错了在编辑器里看不出来，进游戏才会发现轨道是反的或者浮在路面上面。
import {
  DOUBLE_OFFSET, MONO_OFFSET, RAIL_RADIUS, RAIL_SPAN, SIDE_BEND_TRIM, SIDE_RAIL_ANGLE, SIDE_RAIL_STONE_ANGLE, advance, kindSpans, pieceLength,
  railCenters, railEnd, railTopOffset, sampleRail, sideLowerSpan, stateAt, type Rail, type RailPiece, type RailState,
} from '../src/model/rail';
import { buildRail } from '../src/geom/rail';
import { sweepTube } from '../src/geom/railing';
import { feats } from '../src/box/snap';
import { edgeAt, routeLen, shortPath } from '../src/box/guard';
import type { Loop, P3 } from '../src/model/outline';
import { Box, Obj, Piece, RailElem, boxTopAt, footprint, toWorld } from '../src/box/types';
import { rotAxis, toQuat } from '../src/box/xform';
import { ASSET_SNAP } from '../src/box/asset-snap';

type Check = (cond: boolean, msg: string) => void;
type Scenario = (name: string, fn: () => void) => void;

const fs = (await import('node:fs' as string)) as { readFileSync(p: string, enc: string): string };

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps;
const D2R = Math.PI / 180;

const line = (len: number, dz = 0): RailPiece => ({ kind: 'double', len, radius: 0, angle: 0, dz });
const arc = (angle: number, radius: number, dz = 0): RailPiece => ({ kind: 'double', len: 0, radius, angle, dz });
const start: RailState = { x: 0, y: 0, z: 5, heading: 0 };

const railElem = (pieces: RailPiece[], o: Partial<RailElem> = {}): RailElem =>
  ({ id: 1, kind: 'rail', x: 0, y: 0, z: 5, heading: 0, pieces, ...o });

/** 三角形列表里的最大/最小 z，以及是否有非法数值 */
function zs(m: { pos: number[] }) {
  let lo = Infinity, hi = -Infinity, bad = 0;
  for (let i = 2; i < m.pos.length; i += 3) {
    const z = m.pos[i];
    if (!Number.isFinite(z)) bad++;
    else { lo = Math.min(lo, z); hi = Math.max(hi, z); }
  }
  return { lo, hi, bad };
}
const triCount = (m: { pos: number[] }) => m.pos.length / 9;

/** 每个三角形的几何法线要和顶点法线同向（绕序朝外） */
function windingOk(m: { pos: number[]; nrm: number[] }, eps = 1e-9): boolean {
  for (let t = 0; t < m.pos.length / 9; t++) {
    const o = t * 9;
    const ax = m.pos[o], ay = m.pos[o + 1], az = m.pos[o + 2];
    const bx = m.pos[o + 3], by = m.pos[o + 4], bz = m.pos[o + 5];
    const cx = m.pos[o + 6], cy = m.pos[o + 7], cz = m.pos[o + 8];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const sx = m.nrm[o] + m.nrm[o + 3] + m.nrm[o + 6];
    const sy = m.nrm[o + 1] + m.nrm[o + 4] + m.nrm[o + 7];
    const sz = m.nrm[o + 2] + m.nrm[o + 5] + m.nrm[o + 8];
    if (nx * sx + ny * sy + nz * sz <= eps * (Math.hypot(nx, ny, nz) + 1)) return false;
  }
  return true;
}
const normalsUnit = (m: { nrm: number[] }, eps = 1e-9) => {
  for (let i = 0; i < m.nrm.length; i += 3) {
    if (!near(Math.hypot(m.nrm[i], m.nrm[i + 1], m.nrm[i + 2]), 1, eps)) return false;
  }
  return true;
};

export function boxGeomScenarios(check: Check, scenario: Scenario) {
  scenario('钢轨路径：直线 / 左弯 / 右弯 / 半段', () => {
    const l = advance(start, line(10, 2));
    check(near(l.x, 10) && near(l.y, 0) && near(l.z, 7) && near(l.heading, 0), `直线：${JSON.stringify(l)}`);
    const half = advance(start, line(10, 2), 0.5);
    check(near(half.x, 5) && near(half.z, 6) && near(half.heading, 0), `直线走一半：${JSON.stringify(half)}`);

    // 左转 90°、半径 5：圆心在左手边 (0, 5)，终点 (5, 5)
    const left = advance(start, arc(90, 5));
    check(near(left.x, 5) && near(left.y, 5) && near(left.heading, 90), `左弯 90°：${JSON.stringify(left)}`);
    // 右转 90°：圆心在右手边 (0, -5)，终点 (5, -5)
    const right = advance(start, arc(-90, 5));
    check(near(right.x, 5) && near(right.y, -5) && near(right.heading, -90), `右弯 90°：${JSON.stringify(right)}`);
    // 任意一段：到圆心的距离恒等于半径
    const p30 = advance(start, arc(30, 4), 0.6);
    const cx = 0, cy = 4;
    check(near(Math.hypot(p30.x - cx, p30.y - cy), 4, 1e-9), `弯道上任意点到圆心的距离应等于半径：${Math.hypot(p30.x - cx, p30.y - cy)}`);
    check(near(p30.heading, 18), `走了 60% 的 30° 弯，朝向应转了 18°，实际 ${p30.heading}`);

    check(near(pieceLength(line(10)), 10) && near(pieceLength(arc(90, 5)), (Math.PI / 2) * 5),
      '段长：直线用 len，圆弧用 |angle|·π/180·radius');
  });

  scenario('钢轨采样：点数 / 弧长单调 / 首尾对上', () => {
    const straight = railElem([line(10)]);
    const s1 = sampleRail(straight);
    check(s1.length === 2, `直线应只有两侧两个采样点，实际 ${s1.length}`);
    check(near(s1[1].s, 10) && near(s1[1].x, 10), `直线终点：s=${s1[1].s} x=${s1[1].x}`);

    // 圆弧按每 360° 32 段细分：90° → 8 段 9 个点
    const quarter = railElem([arc(90, 5)]);
    check(sampleRail(quarter).length === 9, `90° 弯应有 9 个采样点，实际 ${sampleRail(quarter).length}`);
    // 螺旋一整圈 → 32 段 33 个点
    const spiral = railElem([arc(360, 5, 5)]);
    const ss = sampleRail(spiral);
    check(ss.length === 33, `一整圈螺旋应有 33 个采样点，实际 ${ss.length}`);

    const multi = railElem([line(10), arc(90, 5), line(3, -1)]);
    const sm = sampleRail(multi);
    let mono = true;
    for (let i = 1; i < sm.length; i++) if (sm[i].s <= sm[i - 1].s) mono = false;
    check(mono, '采样点的弧长应严格递增');
    const e = railEnd(multi);
    const last = sm[sm.length - 1];
    check(near(last.x, e.x) && near(last.y, e.y) && near(last.z, e.z) && near(last.heading, e.heading),
      '最后一个采样点应等于 railEnd');
    check(near(sm[0].x, 0) && near(sm[0].z, 5) && sm[0].s === 0, '第一个采样点是起点');
    check(near(last.s, pieceLength(line(10)) + pieceLength(arc(90, 5)) + pieceLength(line(3, -1))), '总弧长应等于各段长之和');

    // stateAt 与采样点一致
    for (const s of [0, 1.5, 10, 12.3, 20]) {
      const st = stateAt(multi, s);
      let best = sm[0];
      for (const p of sm) if (Math.abs(p.s - s) < Math.abs(best.s - s)) best = p;
      if (near(best.s, s)) check(near(st.x, best.x) && near(st.y, best.y), `stateAt(${s}) 应与采样点一致`);
    }
    const beyond = stateAt(multi, 999);
    check(near(beyond.x, e.x) && near(beyond.y, e.y), '超出终点的 stateAt 返回终点');
  });

  scenario('钢轨：单双轨的弧长区间与顶端高度', () => {
    const mono: RailPiece = { kind: 'mono', len: 6, radius: 0, angle: 0, dz: 0 };
    const trans: RailPiece = { kind: 'transition', len: 5, radius: 0, angle: 0, dz: 0 };
    const spans = kindSpans(railElem([line(10), mono, trans]));
    const dbl = spans.filter((s) => s.kind === 'double');
    const mo = spans.filter((s) => s.kind === 'mono');
    check(dbl.length === 2 && near(dbl[0].s0, 0) && near(dbl[0].s1, 10) && near(dbl[1].s0, 16) && near(dbl[1].s1, 21),
      `双轨区间：${JSON.stringify(dbl)}`);
    // 单双转换段同时算作双轨和单轨，所以 10..21 连成一段
    check(mo.length === 1 && near(mo[0].s0, 10) && near(mo[0].s1, 21), `单轨区间（转换段算在单轨里）：${JSON.stringify(mo)}`);

    // 双轨尖顶朝上：最顶端就是路径高度；单轨平顶：比路径低一点（BBP 的下沉量）
    check(near(railTopOffset('double'), 0) && near(railTopOffset('transition'), 0), '双轨 / 单双转换的最顶端等于路径高度');
    check(near(railTopOffset('mono'), MONO_OFFSET + RAIL_RADIUS * Math.cos(Math.PI / 8)), '单轨顶端 = 截面中心 + 半径·cos(22.5°)');
    check(railTopOffset('mono') < -0.5, `单轨顶端应明显低于路径高度，实际 ${railTopOffset('mono').toFixed(3)}`);
    check(near(DOUBLE_OFFSET, -RAIL_RADIUS), '双轨截面中心 = 路径高度 − 半径');
  });

  scenario('钢轨网格：直轨的三角形、顶端齐平、法线与绕序', () => {
    const m = buildRail(railElem([line(10)]) as Rail);
    // 一段 10 的直轨：2 圈 × 8 边 → 16 个侧面三角形 + 两头各 6 个封盖，两根轨
    check(triCount(m) === 56, `直轨双轨应有 56 个三角形，实际 ${triCount(m)}`);
    const z = zs(m);
    check(near(z.hi, 5), `双轨最顶端应与路径高度齐平（5），实际 ${z.hi}`);
    check(near(z.lo, 5 - 2 * RAIL_RADIUS), `双轨底面应在路径高度下 2×半径，实际 ${z.lo}`);
    check(normalsUnit(m), '钢轨法线应是单位向量');
    check(windingOk(m), '钢轨三角形的绕序应朝外（几何法线 · 顶点法线 > 0）');

    // 两根轨在路径两侧 1.875
    let minY = Infinity, maxY = -Infinity;
    for (let i = 1; i < m.pos.length; i += 3) { minY = Math.min(minY, m.pos[i]); maxY = Math.max(maxY, m.pos[i]); }
    check(near(maxY - minY, RAIL_SPAN + 2 * RAIL_RADIUS), `两轨外侧宽度应为 3.75 + 2×0.35，实际 ${(maxY - minY).toFixed(3)}`);

    const monoM = buildRail(railElem([line(10)], {}).pieces ? ({ ...railElem([{ kind: 'mono', len: 10, radius: 0, angle: 0, dz: 0 }]) } as Rail) : ({} as Rail));
    check(triCount(monoM) === 28, `单轨只有一根轨：28 个三角形，实际 ${triCount(monoM)}`);
    check(near(zs(monoM).hi, 5 + railTopOffset('mono'), 1e-9), `单轨顶端 = 路径高度 + 单轨偏移，实际 ${zs(monoM).hi}`);
  });

  scenario('钢轨网格：坡度只错切不改截面、螺旋两头不塌', () => {
    const sloped = buildRail(railElem([line(10, 2)]) as Rail);
    const z = zs(sloped);
    check(near(z.hi, 7), `终点处的顶端应到 5+2=7，实际 ${z.hi}`);
    check(near(z.lo, 5 - 2 * RAIL_RADIUS), `起点处底面不受坡度影响，实际 ${z.lo}`);
    check(windingOk(sloped), '坡上的钢轨绕序也应朝外');

    // 螺旋一整圈：没有 NaN、闭合（首尾两圈的中心重合）
    const sp = buildRail(railElem([arc(360, 5, 5)]) as Rail);
    const zsSp = zs(sp);
    check(zsSp.bad === 0 && triCount(sp) > 100, `螺旋应有大量三角形且无非法数值：${triCount(sp)} 个，坏点 ${zsSp.bad}`);
    check(near(zsSp.hi, 10, 1e-6), `螺旋终点顶端应到 5+5=10，实际 ${zsSp.hi}`);
    check(normalsUnit(sp), '螺旋的法线应是单位向量');

    check(buildRail(railElem([]) as Rail).pos.length === 0, '没有段的钢轨不应产生三角形');
  });

  scenario('护栏圆管：顶点数、法线、开口 / 闭合', () => {
    const linePath: P3[] = [[0, 0, 0], [10, 0, 0]];
    const tube = sweepTube(linePath, false, 0.2);
    // 2 圈 × 8 边 → 16 个侧面三角形 + 两头各 8 个封盖三角形
    check(triCount(tube) === 32, `直管应有 32 个三角形，实际 ${triCount(tube)}`);
    check(normalsUnit(tube), '管体法线应是单位向量');
    const zt = zs(tube);
    check(near(zt.hi, 0.2) && near(zt.lo, -0.2), `半径为 0.2 的管子在 z 上应是 ±0.2，实际 ${zt.lo}..${zt.hi}`);

    const square: P3[] = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]];
    const loopTube = sweepTube(square, true, 0.2);
    check(triCount(loopTube) === 64, `闭合管（4 段 × 8 边 × 2）应有 64 个三角形，实际 ${triCount(loopTube)}`);
    check(normalsUnit(loopTube), '闭合管法线应是单位向量');
    check(triCount(sweepTube([[0, 0, 0]], false, 0.1)) === 0, '少于两个点不应产生三角形');
  });

  scenario('侧轨：两根轨的位置、弯下去的那头、绕序', () => {
    const rad = (d: number) => (d * Math.PI) / 180;
    const side = (o: Partial<NonNullable<RailElem['side']>>, len = 20): RailElem => ({ ...railElem([line(len)]), z: 0, side: { dir: -1, ...o } });
    const [lo, up] = railCenters(side({}), 'double');
    check(near(lo[0], 0) && near(lo[1], 0), '下轨的轴线就是路径');
    check(near(up[0], -RAIL_SPAN * Math.cos(rad(SIDE_RAIL_ANGLE))) && near(up[1], RAIL_SPAN * Math.sin(rad(SIDE_RAIL_ANGLE))), '上轨按 79.563° 斜上去，两轨间距不变');
    const st = railCenters(side({ stone: true, dir: 1 }), 'double')[1];
    check(near(st[0], RAIL_SPAN * Math.cos(rad(SIDE_RAIL_STONE_ANGLE))) && near(Math.hypot(st[0], st[1]), RAIL_SPAN), '石球型 57°，dir 决定偏向');

    const span = sideLowerSpan(side({ ends: [true, false] }));
    check(near(span[0] * 20, SIDE_BEND_TRIM) && near(span[1], 1), `弯下去的那头下轨缩短 ${SIDE_BEND_TRIM}，另一头不变`);
    const short = sideLowerSpan(side({ ends: [true, true] }, 8));
    check(short[0] === short[1], '太短时下轨缩没了，不能倒过来');
    const noLower = buildRail(side({ ends: [true, true] }, 8));
    check(noLower.pos.length > 0 && noLower.pos.every(Number.isFinite), '下轨缩没时上轨照常生成');

    const r = side({ ends: [true, true] });
    r.x = 0; r.y = 0; r.heading = 0;
    const m = buildRail(r, 2);
    check(m.pos.every(Number.isFinite) && m.nrm.every(Number.isFinite), '网格没有非数值');
    let minZ = Infinity, wrong = 0;
    for (let i = 0; i < m.pos.length; i += 9) {
      const p = m.pos.slice(i, i + 9), n = m.nrm.slice(i, i + 3);
      const a = [p[3] - p[0], p[4] - p[1], p[5] - p[2]], b = [p[6] - p[0], p[7] - p[1], p[8] - p[2]];
      const g = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
      if (Math.hypot(...g) > 1e-9 && g[0] * n[0] + g[1] * n[1] + g[2] * n[2] < 0) wrong++;
      minZ = Math.min(minZ, p[2], p[5], p[8]);
    }
    check(wrong === 0, `绕序和法线要一致（朝外），有 ${wrong} 个三角形反了`);
    // 路面比路径高一个半径，立柱竖到路面以下 2（圆管本身不再往下）
    check(minZ > RAIL_RADIUS - 2 - RAIL_RADIUS - 0.05 && minZ < RAIL_RADIUS - 2 + 0.05, `立柱底端应在路面以下 2 左右，实际 ${minZ}`);
    const open = buildRail(side({}));
    check(open.pos.length < m.pos.length, '开放侧轨就是两根直管，比带弯的三角形少');
  });

  scenario('吸附特征点：路面 / 钢轨 / 倾斜的元素', () => {
    const b: Box = { id: 1, kind: 'box', x: 0, y: 0, z: 0, sx: 5, sy: 5, depth: 1, style: 'normal' };
    const f = feats(b);
    check(f.verts.length === 8 && f.mids.length === 12 && f.edges.length === 12,
      `路面的吸附点应是 8 顶点 / 12 中点 / 12 边，实际 ${f.verts.length}/${f.mids.length}/${f.edges.length}`);
    const fz = footprint(b);
    check(f.verts.some((v) => near(v[0], fz.x0) && near(v[1], fz.y0) && near(v[2], 0)), '应有顶面角点（z 为路面高度）');
    check(f.verts.some((v) => near(v[0], fz.x0) && near(v[1], fz.y0) && near(v[2], -1)), '应有底面角点（z 往下 depth）');

    const r = railElem([line(10)]);
    const rf = feats(r);
    check(rf.verts.length === 6, `直轨两头各有路径点 + 左右两根轨的截面中心 = 6 个顶点，实际 ${rf.verts.length}`);
    check(rf.mids.length === 3 && rf.edges.length === 0, '单段直轨中间也是这 3 个预设点，没有边');
    check(rf.verts.some((v) => near(v[1], RAIL_SPAN / 2) && near(v[2], 5 - RAIL_RADIUS)), '截面中心在路径两侧 RAIL_SPAN/2、比路径低一个钢轨半径');

    const mf = feats(railElem([{ ...line(10), kind: 'mono' }]));
    check(mf.verts.length === 2 && mf.verts.every((v) => near(v[2], 5 + MONO_OFFSET)), '单轨只有两头的截面中心');
    const tf2 = feats(railElem([{ ...line(10), kind: 'transition' }]));
    check(tf2.verts.length === 8, `单双转换的两头双轨、单轨的点都有，实际 ${tf2.verts.length}`);

    // 侧轨：下轨截面中心 + 外接正方形靠上轨的顶点
    const sr: RailElem = { ...railElem([line(20)]), x: 0, y: 0, z: 0, heading: 0, side: { dir: -1, ends: [true, false] } };
    const sf = feats(sr);
    check(sf.verts.length === 4 && sf.mids.length === 2 && sf.edges.length === 0, `侧轨 4 顶点 / 2 中点 / 没有边，实际 ${sf.verts.length}/${sf.mids.length}/${sf.edges.length}`);
    check(sf.verts.some((v) => near(v[0], SIDE_BEND_TRIM) && near(v[1], 0) && near(v[2], 0)), '吸附点跟着缩短后的下轨走');
    check(sf.verts.some((v) => near(v[0], 20) && near(v[1], -RAIL_RADIUS) && near(v[2], RAIL_RADIUS)), '顶点在靠上轨一侧、比中心高一个半径');

    // 盘点：路口的两角、中点和圆盘中心
    const cp = (type: 'start' | 'check', rot: Piece['rot']): Piece => ({ id: 3, kind: 'piece', type, x: 0, y: 0, z: 0, rot });
    const cs = feats(cp('start', 0)), cc = feats(cp('check', 1));
    check(cs.verts.length === 2 && cs.mids.length === 2 && cs.edges.length === 0, '起点一个路口：2 顶点 / 2 中点');
    check(cc.verts.length === 4 && cc.mids.length === 3 && cc.edges.length === 0, '小节盘点两个路口：4 顶点 / 3 中点');
    check(cs.verts.every((v) => near(v[0], footprint(cp('start', 0)).x1)), '起点的吸附点在路口那条边上');
    check(feats(cp('start', 2)).verts.every((v) => near(v[0], footprint(cp('start', 2)).x0)), '转过去的起点路口在另一边');

    // 旋转门路块：吸附点落在底下方块的顶点上，土堆顶上不能有悬空的点
    const ts = feats({ id: 5, kind: 'asset', name: 'Turnstile', x: 0, y: 0, z: 0, rot: 0 });
    check(ts.verts.length === 8 && ts.verts.every((v) => near(Math.abs(v[0]), 2.5) && near(Math.abs(v[1]), 2.5) && near(Math.abs(v[2]), 2.5)), '旋转门的吸附点是 5×5×5 方块的 8 个顶点');
    check([...ts.verts, ...ts.mids].every((v) => v[2] <= 2.5 + 1e-6), '旋转门没有高过方块顶面的吸附点');

    // 木板、木桥：预设点都是模型上真实的顶点，没有悬空的点；跟着拉伸和朝向走
    for (const [name, snap] of Object.entries(ASSET_SNAP)) {
      const parts = (JSON.parse(fs.readFileSync(`public/assets/${name}.json`, 'utf8')) as { parts: { pos: number[] }[] }).parts;
      const real = (v: number[]) => parts.some((q) => { for (let i = 0; i < q.pos.length; i += 3) if (near(q.pos[i], v[0], 2e-3) && near(q.pos[i + 1], v[1], 2e-3) && near(q.pos[i + 2], v[2], 2e-3)) return true; return false; });
      check(snap.verts.length >= 4 && snap.verts.every(real), `${name} 的吸附点都应是模型顶点`);
    }
    const wp = feats({ id: 6, kind: 'asset', name: 'WoodPlate', x: 10, y: 0, z: 1, rot: 1, scale: [2, 1] });
    check(wp.edges.length === 0 && wp.verts.length === 8, '木板 8 个顶点，没有边');
    check(wp.verts.some((v) => near(v[0], 10 - 4.752) && near(v[1], 4.755 * 2) && near(v[2], 1)), '拉伸后再按朝向转到世界坐标');

    // 顶端的吸附点：箱式浮板箱子的四个角、特殊路块 16 高墙墙顶
    const sail = feats({ id: 7, kind: 'obj', type: 'P_Modul_41', x: 10, y: 20, z: 3, rot: 1 } as Obj);
    check(sail.verts.length === 12 && sail.verts.some((v) => near(v[0], 10 - 2.485, 2e-3) && near(v[1], 20 + 2.525, 2e-3) && near(v[2], 3, 2e-3)), '箱式浮板箱顶四个角跟着位置和朝向走');
    check(ASSET_SNAP.Modul_16.verts.filter((v) => v[2] > 5).length === 8, '特殊路块 16 高墙顶有 8 个吸附点');

    // 机关：只有对准方块顶面的预设点
    const of = feats({ id: 4, kind: 'obj', type: 'P_Modul_01', x: 0, y: 0, z: 0, rot: 0 } as Obj);
    check(of.edges.length === 0, '机关没有边');
    check(new Set(of.verts.map((v) => v[2])).size <= of.verts.length / 4, '机关的顶点都在对准方块的顶面上');

    // 倾斜的路面：吸附点要跟着转到世界坐标
    const flat = { ...b };
    const tilted: Box = { ...b, q: toQuat(rotAxis(0, 30)) };
    const tf = feats(tilted);
    const expect = toWorld(tilted, feats(flat).verts[0]);
    check(near(tf.verts[0][0], expect[0]) && near(tf.verts[0][1], expect[1]) && near(tf.verts[0][2], expect[2]),
      '倾斜元素的吸附点应该是世界坐标');
  });

  scenario('外沿查询：点边 / 短路径 / 路径长度', () => {
    const side = 10;
    const pts: P3[] = [[0, 0, 0], [side, 0, 0], [side, side, 0], [0, side, 0]];
    const outs: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    const loop: Loop = { pts, outs, closed: true, cum: [0, side, 2 * side, 3 * side], len: 4 * side };

    const e = edgeAt([loop], [4, 0.5, 0]);
    check(!!e && e.pts.length === 2 && near(routeLen(e), side), `点在外沿附近应取到那一整条直边：${e ? routeLen(e) : 'null'}`);
    const ins = edgeAt([loop], [4, 0.5, 0], 1.5);
    check(!!ins && near(routeLen(ins), side - 3) && near(ins.pts[0][0], 1.5) && near(ins.pts[1][0], side - 1.5), `两头各内缩 1.5：${ins ? JSON.stringify(ins.pts) : 'null'}`);
    const shortLoop: Loop = { pts: [[0, 0, 0], [3, 0, 0], [3, 3, 0], [0, 3, 0]], outs, closed: true, cum: [0, 3, 6, 9], len: 12 };
    check(near(routeLen(edgeAt([shortLoop], [1.5, 0.3, 0], 1.5)!), 3), '边太短（缩完不到 1）时不缩');
    check(edgeAt([loop], [4, 5, 0]) === null, '离外沿太远不应取到边');
    check(edgeAt([loop], [4, 0.5, 9]) === null, '离外沿太高（>3）不应取到边');

    const a = shortPath(loop, 1, 9);
    const b2 = shortPath(loop, 9, 1);
    check(near(routeLen(a), 8) && near(routeLen(b2), 8), `外沿上两点之间走短边：${routeLen(a)} / ${routeLen(b2)}`);
    check(near(routeLen(a), routeLen(b2)), '起止反过来也应是同一段');
    const long = shortPath(loop, 1, 21);
    check(near(routeLen(long), 20), `相距正好半圈时也应是 20，实际 ${routeLen(long)}`);
    check(near(routeLen({ pts: [[0, 0, 0], [3, 4, 0], [3, 4, 12]] }), 5), 'routeLen 只累加水平距离，竖直分量不计');
  });
}
