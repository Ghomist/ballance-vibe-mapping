// box 版的几何基线：钢轨路径与网格、护栏圆管、吸附特征点、外沿查询。
//
// 钢轨这段的重点是「截面不能随坡度变」「顶端永远和路径高度齐平」「绕序朝外」——
// 这三条错了在编辑器里看不出来，进游戏才会发现轨道是反的或者浮在路面上面。
import {
  DOUBLE_OFFSET, MONO_OFFSET, RAIL_RADIUS, RAIL_SPAN, advance, kindSpans, pieceLength, railEnd, railTopOffset,
  sampleRail, stateAt, type Rail, type RailPiece, type RailState,
} from '../src/model/rail';
import { buildRail } from '../src/geom/rail';
import { sweepTube } from '../src/geom/railing';
import { feats } from '../src/box/snap';
import { edgeAt, routeLen, shortPath } from '../src/box/guard';
import type { Loop, P3 } from '../src/model/outline';
import { Box, RailElem, boxTopAt, footprint, toWorld } from '../src/box/types';
import { rotAxis, toQuat } from '../src/box/xform';

type Check = (cond: boolean, msg: string) => void;
type Scenario = (name: string, fn: () => void) => void;

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
    check(rf.verts.length === 6, `直轨两头各有 1 个中心 + 左右两根轨的顶端 = 6 个顶点，实际 ${rf.verts.length}`);
    check(rf.mids.length === 1 && rf.edges.length === 1, '单段直轨应有 1 个中点、1 条中线');
    check(rf.verts.some((v) => near(v[1], RAIL_SPAN / 2) && near(v[2], 5)), '轨顶在路径两侧 RAIL_SPAN/2、高度等于路径高度');

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
