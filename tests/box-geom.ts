// box 版的几何基线：钢轨路径与网格、护栏圆管、吸附特征点、外沿查询。
//
// 钢轨这段的重点是「截面不能随坡度变」「顶端永远和路径高度齐平」「绕序朝外」——
// 这三条错了在编辑器里看不出来，进游戏才会发现轨道是反的或者浮在路面上面。
import {
  DOUBLE_OFFSET, MONO_OFFSET, RAIL_RADIUS, RAIL_SPAN, SIDE_BEND_TRIM, SIDE_RAIL_ANGLE, SIDE_RAIL_STONE_ANGLE, advance, kindSpans, pieceLength,
  railCenters, railEnd, railTopOffset, sampleRail, sideLowerSpan, stateAt, type Rail, type RailPiece, type RailState,
} from '../src/model/rail';
import { buildRail } from '../src/geom/rail';
import { breakAt, closeCurve, insertAfter, openAt, parallelFrames, removePoint, sampleSpline, type SplineCurve } from '../src/model/spline';
import { ownOutline, solve, type Solved } from '../src/box/solve';
import { exportBoxScene } from '../src/box/export';
import { sweepTube } from '../src/geom/railing';
import { feats } from '../src/box/snap';
import { type Route, edgeAt, refitGuard, routeLen, shortPath } from '../src/box/guard';
import { type Loop, type P3, pathAlong, project } from '../src/model/outline';
import { Box, Obj, Piece, RailElem, boxTopAt, footprint, toWorld } from '../src/box/types';
import { rotAxis, toQuat } from '../src/box/xform';
import { ASSET_SNAP } from '../src/box/asset-snap';
import { ASSET_INFO, tileOf } from '../src/box/asset-info';
import { tileMesh } from '../src/view/tilemesh';
import type { TriMesh } from '../src/view/clipmesh';
import type { AssetElem } from '../src/box/types';

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
  scenario('曲线路面：放样、自动接路面、外沿', () => {
    const curve: SplineCurve = { pts: [{ p: [0, 0, 0], out: [10, 0, 0] }, { p: [30, 0, 0], in: [-10, 0, 0] }] };
    const road = (o: Partial<RailElem> = {}): RailElem => ({ ...railElem([line(1)]), id: 1, x: 0, y: 2.5, z: 0, heading: 0, pieces: [{ kind: 'double', len: 0, radius: 0, angle: 0, dz: 0 }], curve, road: { style: 'normal', depth: 5 }, ...o });
    const box = (id: number, x: number, sx: number, o: Partial<Box> = {}): Box => ({ id, kind: 'box', x, y: 0, z: 0, sx, sy: 5, depth: 5, style: 'normal', ...o });
    const top = (m: Solved, id: number, mat: string) => (m.meshes.get(id)?.parts as Record<string, { pos: number[] }>)[mat]?.pos.length ?? 0;
    // 一条孤零零的路：两头封口
    const alone = solve({ nextId: 2, elems: { 1: road() } });
    check(top(alone, 1, 'FloorTopBorder') > 0 && top(alone, 1, 'FloorSide') > 0, '生成顶面和侧面');
    // 顶面三角形都朝上，侧面朝外
    const tp = (alone.meshes.get(1)!.parts as Record<string, { pos: number[] }>).FloorTopBorder.pos;
    let down = 0;
    for (let i = 0; i + 8 < tp.length; i += 9) { const a = tp.slice(i, i + 3), b = tp.slice(i + 3, i + 6), c = tp.slice(i + 6, i + 9); if ((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]) <= 0) down++; }
    check(down === 0, `顶面朝上（${down} 个朝下）`);
    check(alone.loops.length === 1 && alone.loops[0].closed, '封口的路外沿自己连成一个环');
    // 前后各接一块路面：两头都不封口，路面的边开口，外沿连成一个大环
    const joined = solve({ nextId: 4, elems: { 1: road(), 2: box(2, -10, 10), 3: box(3, 30, 10) } });
    const closedTris = top(alone, 1, 'FloorTopBorder'), joinedTris = top(joined, 1, 'FloorTopBorder');
    check(joinedTris !== closedTris, '接上路面后两头不再是封口的花纹');
    check(joined.loops.length === 1 && joined.loops[0].closed, `接上后外沿连成一个环（${joined.loops.length} 个）`);
    const looseBox = solve({ nextId: 4, elems: { 2: box(2, -10, 10), 3: box(3, 30, 10) } });
    check(top(joined, 2, 'FloorTopBorder') < top(looseBox, 2, 'FloorTopBorder') || top(joined, 2, 'FloorTopBorderless') !== top(looseBox, 2, 'FloorTopBorderless'), '路面贴着曲线路面的那条边开口');
    // 样式不一样：不算接上
    const diff = solve({ nextId: 3, elems: { 1: road(), 2: box(2, -10, 10, { style: 'sink' }) } });
    check(top(diff, 1, 'FloorTopBorder') === closedTris, '样式不同不自动接');
    // 手动封口：贴着路面也封
    const forced = solve({ nextId: 4, elems: { 1: road({ road: { style: 'normal', depth: 5, ends: ['closed', 'closed'] } }), 2: box(2, -10, 10), 3: box(3, 30, 10) } });
    check(top(forced, 1, 'FloorTopBorder') === closedTris, '手动封口优先');
    // 两条曲线路面头尾相接
    const twin = solve({ nextId: 3, elems: { 1: road(), 2: road({ id: 2, x: 30 }) } });
    check(top(twin, 1, 'FloorTopBorder') !== closedTris && top(twin, 2, 'FloorTopBorder') !== closedTris, '曲线路面互相接上');
    // 拐弯进路面的端头不正对坐标轴：不开口
    const skew: SplineCurve = { pts: [{ p: [0, 0, 0], out: [7, 7, 0] }, { p: [30, 0, 0], in: [-10, 0, 0] }] };
    const sk = solve({ nextId: 3, elems: { 1: road({ curve: skew }), 2: box(2, -10, 10) } });
    check(top(sk, 2, 'FloorTopBorder') === top(solve({ nextId: 3, elems: { 2: box(2, -10, 10) } }), 2, 'FloorTopBorder'), '端头歪着的不让路面开口');
    // 导出：路面物体，不是钢轨
    const desc = exportBoxScene({ nextId: 2, elems: { 1: road() } });
    check(desc.meshes.some((m) => m.kind === 'floor') && !desc.meshes.some((m) => m.kind === 'rail'), '导出成路面');
    // 厚度超过 5：上 5 带边框
    const deep = solve({ nextId: 2, elems: { 1: road({ road: { style: 'normal', depth: 8 } }) } });
    check(top(deep, 1, 'LightingFloorTopBorder') > 0 && top(deep, 1, 'LightingFloorTopBorderless') > 0, '厚度超过 5 分两种贴图');
    check(feats(road()).verts.length === 8 && feats(road()).mids.length === 2, '吸附点：两头各 4 个角和中点');
  });

  scenario('弧形路面：花纹、接路面、圆环', () => {
    const arc = (angle: number, o: Partial<RailElem> = {}): RailElem => ({ ...railElem([line(1)]), id: 1, x: 0, y: 2.5, z: 0, heading: 0, pieces: [{ kind: 'double', len: 0, radius: 20, angle, dz: 0 }], road: { style: 'normal', depth: 5 }, ...o });
    const box = (id: number, x: number, y: number, sx: number, sy: number): Box => ({ id, kind: 'box', x, y, z: 0, sx, sy, depth: 5, style: 'normal' });
    const top = (m: Solved, id: number) => (m.meshes.get(id)?.parts as Record<string, { pos: number[] }>).FloorTopBorder?.pos.length ?? 0;
    const sig = (m: Solved, id: number) => JSON.stringify((m.meshes.get(id)?.parts as Record<string, { pos: number[] }>).FloorTopBorder?.pos);
    const alone = solve({ nextId: 2, elems: { 1: arc(90) } });
    check(top(alone, 1) > 0 && alone.loops.length === 1 && alone.loops[0].closed, '单独一段：两头封口，外沿一个环');
    const f = feats(arc(90));
    check(f.mids.length === 2 && near(f.mids[1][0], 20, 1e-6) && near(f.mids[1][1], 22.5, 1e-6), '吸附点在弧的两头');
    check(feats(arc(-90)).mids[1][1] < 0, '负角度是右转');
    // 两头接路面：起点 -x 方向，终点（转过 90°）+y 方向
    const joined = solve({ nextId: 4, elems: { 1: arc(90), 2: box(2, -10, 0, 10, 5), 3: box(3, 17.5, 22.5, 5, 10) } });
    check(sig(joined, 1) !== sig(alone, 1), '接上路面后不再是封口的花纹'); // 三角形数可能碰巧一样，比内容
    check(joined.loops.length === 1 && joined.loops[0].closed, `接上后外沿连成一个环（${joined.loops.length} 个）`);
    // 转 45°：端头不正对坐标轴，不开口
    const skew = solve({ nextId: 3, elems: { 1: arc(45), 2: box(2, 13, 8, 10, 10) } });
    check(sig(skew, 1) === sig(solve({ nextId: 2, elems: { 1: arc(45) } }), 1), '端头歪着的不接');
    // 360°：圆环
    const ring = solve({ nextId: 2, elems: { 1: arc(360) } });
    check(ring.loops.length === 2 && ring.loops.every((l) => l.closed), `圆环内外两圈外沿（${ring.loops.length} 个）`);
    check(feats(arc(360)).mids.length === 1, '圆环只有接缝一组吸附点');
    const e = exportBoxScene({ nextId: 2, elems: { 1: arc(360) } });
    check(e.meshes.some((m) => m.kind === 'floor') && !e.meshes.some((m) => m.kind === 'rail'), '导出成路面');
  });

  scenario('样条线：首尾相连和断开', () => {
    const ring = (): SplineCurve => ({ pts: [{ p: [0, 0, 0], out: [11, 0, 0], in: [-11, 0, 0] }, { p: [20, 20, 0], in: [0, -11, 0], out: [0, 11, 0] }, { p: [0, 40, 0], in: [11, 0, 0], out: [-11, 0, 0] }, { p: [-20, 20, 0], in: [0, 11, 0], out: [0, -11, 0] }], closed: true });
    const c = ring(), sm = sampleSpline(c);
    check(near(sm[0].p[0], sm.at(-1)!.p[0]) && near(sm[0].p[1], sm.at(-1)!.p[1]), '采样回到起点');
    check(near(sm[0].t[0], sm.at(-1)!.t[0], 1e-9) && near(sm[0].t[1], sm.at(-1)!.t[1], 1e-9), '接缝两边切线一样');
    // 高低起伏的环：平行传递回到起点要对得上
    const wavy = ring();
    wavy.pts[1].p[2] = 12; wavy.pts[1].in = [0, -9, -6]; wavy.pts[1].out = [0, 9, 6]; wavy.pts[3].p[2] = -8;
    const ws = sampleSpline(wavy), wf = parallelFrames(ws, true), f0 = wf[0], fn = wf.at(-1)!;
    check(near(f0.U[0], fn.U[0], 1e-6) && near(f0.U[1], fn.U[1], 1e-6) && near(f0.U[2], fn.U[2], 1e-6), '平行传递的接缝对得上');
    check(wf.every((f, i) => i === 0 || f.U[0] * wf[i - 1].U[0] + f.U[1] * wf[i - 1].U[1] + f.U[2] * wf[i - 1].U[2] > 0.9), '补偿的扭转没有突变');
    // 路面和钢轨都没有端头
    const elem = (o: Partial<RailElem>): RailElem => ({ ...railElem([line(1)]), id: 1, x: 0, y: 0, z: 0, heading: 0, pieces: [{ kind: 'double', len: 0, radius: 0, angle: 0, dz: 0 }], curve: ring(), ...o });
    const road = solve({ nextId: 2, elems: { 1: elem({ road: { style: 'normal', depth: 5 } }) } });
    check(road.loops.length === 2 && road.loops.every((l) => l.closed), `环形路面内外两圈外沿（${road.loops.length} 个）`);
    check(feats(elem({ road: { style: 'normal', depth: 5 } })).mids.length === 1, '环形路面只有接缝一组吸附点');
    for (const o of [elem({}), elem({ curve: { ...ring(), frame: 'parallel' } })]) check(buildRail(o).caps.length === 0, '环形钢轨没有封盖');
    // 导出的路面和分享都带着闭合
    check(exportBoxScene({ nextId: 2, elems: { 1: elem({ road: { style: 'normal', depth: 5 } }) } }).meshes.some((m) => m.kind === 'floor'), '环形路面能导出');
    // 任意一点断开：形状不变，两头重合
    const b = ring(), len0 = sampleSpline(b).at(-1)!.s;
    check(breakAt(b, 1, 0.37) && !b.closed && b.pts.length === 6, '断开后多一个切点和一个端点');
    check(near(sampleSpline(b).at(-1)!.s, len0, 0.05), '断开不改变形状');
    check(!b.pts[0].in && !b.pts.at(-1)!.out && near(b.pts[0].p[0], b.pts.at(-1)!.p[0]), '断开后是两个重合的端点');
    // 从控制点断开，再顺着路往回拖开两头（别弯得太急，叠起来的路外沿本来就连不上）
    const apart = ring();
    openAt(apart, 1);
    apart.pts.at(-1)!.p = [20, 12, 0];
    const cut = solve({ nextId: 2, elems: { 1: elem({ curve: apart, road: { style: 'normal', depth: 5 } }) } });
    check(cut.loops.length === 1 && cut.loops[0].closed, '断开后外沿连成一圈');
    // 断开后再接回去：还是那个环
    check(closeCurve(b) && b.closed === true && b.pts.length === 5, '重合的两头并成一个点');
    check(near(sampleSpline(b).at(-1)!.s, len0, 0.05), '接回去形状不变');
    // 从控制点断开
    const o2 = ring();
    check(openAt(o2, 2) && near(o2.pts[0].p[1], 40) && o2.pts.length === 5, '从控制点断开：这个点成为起点');
    // 环上的加点、删点
    const e = ring();
    check(insertAfter(e, 3) === 4 && e.pts.length === 5 && near(sampleSpline(e).at(-1)!.s, len0, 0.05), '最后一段（回到起点）也能加点');
    check(removePoint(e, 0) && !!e.pts[0].in && !!e.pts.at(-1)!.out, '环上删点不去掉手柄');
    // 补一段回到起点、两个点摆成椭圆
    const three: SplineCurve = { pts: [{ p: [0, 0, 0], out: [10, 0, 0] }, { p: [30, 0, 0], in: [-5, -5, 0], out: [5, 5, 0] }, { p: [30, 30, 0], in: [10, -10, 0] }] };
    check(closeCurve(three) && three.pts.length === 3 && !!three.pts[0].in && !!three.pts[2].out, '三个点补一段回到起点');
    const two: SplineCurve = { pts: [{ p: [0, 0, 0], out: [12, 0, 0] }, { p: [30, 15, 0], in: [-12, 0, 0] }] };
    check(closeCurve(two) && near(sampleSpline(two).at(-1)!.p[0], 0), '两个点摆成椭圆');
    const t2 = two.pts;
    check(near(t2[0].out![0] + t2[0].in![0], 0) && near(t2[1].out![1] + t2[1].in![1], 0), '椭圆的手柄是对称的');
  });

  scenario('样条线：采样、平行传递、放样', () => {
    const c: SplineCurve = { pts: [{ p: [0, 0, 0], out: [10, 0, 0] }, { p: [30, 15, 4], in: [-10, 0, 0], out: [10, 0, 0] }, { p: [60, 0, 0], in: [-10, 0, 0] }] };
    const sm = sampleSpline(c);
    check(near(sm[0].p[0], 0) && near(sm.at(-1)!.p[0], 60) && near(sm.at(-1)!.p[2], 0), '采样从第一个点到最后一个点');
    check(sm.some((x) => near(x.p[0], 30) && near(x.p[1], 15) && near(x.p[2], 4)), '每个控制点上都有一圈');
    check(sm.every((x, i) => i === 0 || x.s > sm[i - 1].s), '弧长单调增加');
    const fr = parallelFrames(sm);
    check(fr.every((f, i) => near(f.L[0] * sm[i].t[0] + f.L[1] * sm[i].t[1] + f.L[2] * sm[i].t[2], 0, 1e-6) && near(f.U[0] * sm[i].t[0] + f.U[1] * sm[i].t[1] + f.U[2] * sm[i].t[2], 0, 1e-6)), '截面垂直于切线');
    check(fr.every((f, i) => i === 0 || f.U[0] * fr[i - 1].U[0] + f.U[1] * fr[i - 1].U[1] + f.U[2] * fr[i - 1].U[2] > 0.9), '相邻截面不突然打转');
    // 翻圈：切线转一整圈，截面也不翻转、不退化
    const loop: SplineCurve = { frame: 'parallel', pts: [{ p: [0, 0, 0], out: [10, 0, 0] }, { p: [20, 0, 20], in: [11, 0, -11], out: [-11, 0, 11] }, { p: [0, 3, 40], in: [11, 0, 0], out: [-11, 0, 0] }, { p: [-20, 3, 20], in: [-11, 0, 11], out: [11, 0, -11] }, { p: [0, 6, 0], in: [-10, 0, 0] }] };
    const ls = sampleSpline(loop), lf = parallelFrames(ls);
    check(ls.some((x) => Math.abs(x.t[2]) > 0.99), '翻圈里有竖直的地方');
    check(lf.every((f) => Number.isFinite(f.U[0]) && near(Math.hypot(...f.U), 1, 1e-6) && near(Math.hypot(...f.L), 1, 1e-6)), '竖直的地方截面也不退化');
    // 侧倾：控制点上 90° 时左方向转到原来的上方向
    const flat: SplineCurve = { pts: [{ p: [0, 0, 0], out: [5, 0, 0], bank: 90 }, { p: [20, 0, 0], in: [-5, 0, 0], bank: 90 }] };
    const bf = parallelFrames(sampleSpline(flat))[0];
    check(near(bf.L[2], 1, 1e-6) && near(bf.U[1], -1, 1e-6), '侧倾 90°：左侧转到上面');
    // 放样：竖直和平行传递都生成三角形，绕序朝外
    const rail = (frame?: 'parallel'): RailElem => ({ ...railElem([line(1)]), x: 5, y: 6, z: 1, heading: 90, pieces: [{ kind: 'double', len: 0, radius: 0, angle: 0, dz: 0 }], curve: { ...c, ...(frame ? { frame } : {}) } });
    for (const r of [rail(), rail('parallel')]) {
      const m = buildRail(r);
      check(m.pos.length > 0 && m.caps.length === 4, '双轨两根管子、四个封盖');
      let bad = 0;
      for (let i = 0; i + 8 < m.pos.length; i += 9) {
        const [a, b, d] = [0, 3, 6].map((k) => [m.pos[i + k], m.pos[i + k + 1], m.pos[i + k + 2]]);
        const e1 = b.map((v, k) => v - a[k]), e2 = d.map((v, k) => v - a[k]);
        const n = [e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]];
        const nv = [m.nrm[i] + m.nrm[i + 3] + m.nrm[i + 6], m.nrm[i + 1] + m.nrm[i + 4] + m.nrm[i + 7], m.nrm[i + 2] + m.nrm[i + 5] + m.nrm[i + 8]];
        if (n[0] * nv[0] + n[1] * nv[1] + n[2] * nv[2] < -1e-9) bad++;
      }
      check(bad === 0, `绕序和法线一致（${r.curve!.frame ?? '竖直'}）`);
    }
    // 朝向 90°：曲线跟着转，起点在原点上
    const st = sampleRail(rail());
    check(near(st[0].x, 5) && near(st[0].y, 6) && near(st[0].heading, 90) && near(st.at(-1)!.y, 6 + 60), '朝向和原点算进去了');
    check(feats(rail()).verts.length === 6, '吸附点：两头各 3 个');
    // 加点：形状不变
    const before = sampleSpline(c), d: SplineCurve = JSON.parse(JSON.stringify(c));
    const at = insertAfter(d, 0);
    const after = sampleSpline(d);
    check(at === 1 && d.pts.length === 4 && near(after.at(-1)!.s, before.at(-1)!.s, 0.05), '在中间加点不改变曲线的长度');
    check(insertAfter(d, 3) === 4 && d.pts.length === 5, '最后一个点后面接一段');
    check(removePoint(d, 1) && d.pts.length === 4 && !d.pts[0].in && !d.pts.at(-1)!.out, '删点');
  });

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
    check(sail.verts.length === 12 && sail.verts.some((v) => near(v[0], 10 - 2.515, 2e-3) && near(v[1], 20 + 2.475, 2e-3) && near(v[2], 3, 2e-3)), '箱式浮板箱顶四个角跟着位置和朝向走');
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

  scenario('护栏跟着路面走：拉伸 / 移动 / 旋转 / 相邻的路 / 跟不了的情况', () => {
    type Elems = Record<number, Box>;
    const B = (id: number, x: number, y: number, sx: number, sy: number, o: Partial<Box> = {}): Box => ({ id, kind: 'box', x, y, z: 0, sx, sy, depth: 5, style: 'normal', ...o });
    const docOf = (elems: Elems) => ({ elems, nextId: 99 }) as unknown as Parameters<typeof solve>[0];
    const loopsOf = (elems: Elems) => solve(docOf(elems)).loops;
    /** 和 app.ts 的 followGuards 一样：改过的路面各取自己的新旧外沿 */
    const refit = (g: Route, a: Elems, b: Elems) => {
      const ids = [...new Set([...Object.keys(a), ...Object.keys(b)].map(Number))].filter((id) => JSON.stringify(a[id]) !== JSON.stringify(b[id]));
      const own = (e: Box | undefined) => (e ? ownOutline(docOf({ [e.id]: e })) : null);
      return refitGuard(g, ids.flatMap((id) => { const old = own(a[id]); return old?.length ? [{ old, now: own(b[id]) }] : []; }), loopsOf(b));
    };
    const xs = (r: Route | null) => (r ? r.pts.map((q) => q.map((v) => +v.toFixed(3)).join(',')).join(' → ') : 'null');
    const ends = (r: Route | null, a: number[], b: number[]) => !!r && near(r.pts[0][0], a[0], 1e-4) && near(r.pts[0][1], a[1], 1e-4) && near(r.pts[r.pts.length - 1][0], b[0], 1e-4) && near(r.pts[r.pts.length - 1][1], b[1], 1e-4);

    const one: Elems = { 1: B(1, 0, 0, 15, 5) };
    const full = edgeAt(loopsOf(one), [7, 0, 0], 1.5)!;
    check(ends(full, [1.5, 0], [13.5, 0]), `整条直边的护栏：${xs(full)}`);
    check(refit(full, one, one) === null, '路没改：不动');

    let r = refit(full, one, { 1: B(1, 0, 0, 30, 5) });
    check(ends(r, [1.5, 0], [28.5, 0]) && r!.outs.length === 1 && r!.outs[0][1] === -1, `拉长大头：两头还是各缩 1.5：${xs(r)}`);
    r = refit(full, one, { 1: B(1, -10, 0, 25, 5) });
    check(ends(r, [-8.5, 0], [13.5, 0]), `拉长小头：${xs(r)}`);
    r = refit(full, one, { 1: B(1, 7, 3, 15, 5) });
    check(ends(r, [8.5, 3], [20.5, 3]), `整体移动：跟着走：${xs(r)}`);
    r = refit(full, one, { 1: B(1, 0, 0, 15, 5, { z: 4 }) });
    check(!!r && near(r.pts[0][2], 4) && ends(r, [1.5, 0], [13.5, 0]), `抬高：高度跟着变：${xs(r)}`);
    r = refit(full, one, { 1: B(1, 0, 0, 15, 9) });
    check(r === null, '只改了另一边的宽度：这条边没动，不用跟');
    r = refit(full, one, { 1: B(1, 0, 0, 15, 5, { ang: 90 }) });
    const rl = loopsOf({ 1: B(1, 0, 0, 15, 5, { ang: 90 }) });
    check(!!r && near(routeLen(r), 12, 1e-3) && r.pts.every((q) => (project(rl, q, 0.5)?.dist ?? 9) < 1e-3), `旋转：还贴着同一条边，长度不变：${xs(r)}`);
    r = refit(full, one, { 1: B(1, 0, 0, 15, 5, { slope: { axis: 0, dz: 3 } }) });
    check(!!r && near(r.pts[0][2], 0.3, 1e-3) && near(r.pts[r.pts.length - 1][2], 2.7, 1e-3), `拉成坡：两头的高度跟着坡：${xs(r)}`);

    // 中间的一段：边的哪一头没动，位置就留在原地
    const l0 = loopsOf(one)[0];
    const s5 = project([l0], [5, 0, 0], 0.5)!.s, s10 = project([l0], [10, 0, 0], 0.5)!.s;
    const mid = s5 < s10 ? pathAlong(l0, s5, s10) : pathAlong(l0, s10, s5);
    r = refit(mid, one, { 1: B(1, 0, 0, 30, 5) });
    check(r === null, '中间的一段，路拉长后还贴着：不动');
    r = refit(mid, one, { 1: B(1, 4, 2, 15, 5) });
    check(!!r && near(routeLen(r), 5) && near(r.pts[0][1], 2) && near(Math.min(r.pts[0][0], r.pts[1][0]), 9), `中间的一段，路移动：跟着走：${xs(r)}`);

    // 两块路拼成一条直边，护栏跨过接缝；只拉长其中一块
    const two: Elems = { 1: B(1, 0, 0, 15, 5), 2: B(2, 15, 0, 15, 5) };
    const span = edgeAt(loopsOf(two), [20, 0, 0], 1.5)!;
    check(ends(span, [1.5, 0], [28.5, 0]), `跨两块路的直边：${xs(span)}`);
    r = refit(span, two, { 1: two[1], 2: B(2, 15, 0, 25, 5) });
    check(ends(r, [1.5, 0], [38.5, 0]), `只拉长第二块：那一头跟过去，另一头不动：${xs(r)}`);

    // 绕过拐角的护栏：两条边各自跟
    const lc = loopsOf(one)[0];
    const sa = project([lc], [10, 0, 0], 0.5)!.s, sb = project([lc], [15, 3, 0], 0.5)!.s;
    const corner = shortPath(lc, sa, sb);
    check(corner.pts.length === 3, `绕拐角的护栏有三个点：${xs(corner)}`);
    r = refit(corner, one, { 1: B(1, 0, 0, 20, 5) });
    check(!!r && r.pts.length === 3 && r.pts.some((q) => near(q[0], 20) && near(q[1], 0)) && r.pts.some((q) => near(q[0], 20) && near(q[1], 3)), `拉长后拐角跟着走：${xs(r)}`);

    // 跟不了的：路删了、护栏本来就不在路沿上、边缩得比内缩还短
    check(refit(full, one, {}) === null, '路删了：护栏留在原地');
    const off: Route = { pts: [[1.5, -4, 0], [13.5, -4, 0]], outs: [[0, -1]] };
    check(refit(off, one, { 1: B(1, 7, 3, 15, 5) }) === null, '没贴着路沿的护栏：不动');
    check(refit(full, one, { 1: B(1, 0, 0, 2, 5) }) === null, '边缩到比两头的内缩还短：不跟');
  });

  scenario('花纹重复的木制件：接长 / 截断（tileMesh）', () => {
    const load = (name: string): TriMesh[] => (JSON.parse(fs.readFileSync(`public/assets/${name}.json`, 'utf8')) as { parts: TriMesh[] }).parts.map((q) => ({ pos: q.pos, uv: q.uv, nrm: q.nrm }));
    /** 每条有向边都有一条反向的边配对：网格是封闭的，没有破洞 */
    const openEdges = (ms: TriMesh[]) => {
      const cnt = new Map<string, number>();
      const k = (a: number[]) => a.map((v) => Math.round(v * 200)).join(',');
      for (const m of ms) for (let i = 0; i < m.pos.length; i += 9) {
        const v = [0, 1, 2].map((j) => k(m.pos.slice(i + j * 3, i + j * 3 + 3)));
        if (v[0] === v[1] || v[1] === v[2] || v[0] === v[2]) continue;
        for (let j = 0; j < 3; j++) { const a = v[j], b = v[(j + 1) % 3]; cnt.set(`${a}>${b}`, (cnt.get(`${a}>${b}`) ?? 0) + 1); }
      }
      let open = 0;
      for (const [e, n] of cnt) { const [a, b] = e.split('>'); if ((cnt.get(`${b}>${a}`) ?? 0) !== n) open++; }
      return open;
    };
    const range = (ms: TriMesh[], i: number) => { let lo = Infinity, hi = -Infinity; for (const m of ms) for (let j = i; j < m.pos.length; j += 3) { lo = Math.min(lo, m.pos[j]); hi = Math.max(hi, m.pos[j]); } return [lo, hi]; };
    const tris = (ms: TriMesh[]) => ms.reduce((n, m) => n + m.pos.length / 9, 0);

    /** 实心的（截面是连着的一整块，哪里切都该有端面） */
    const solid = new Set(['Level2_WaveWood', 'WoodSlope', 'Level2_TiltedWoodPlate']);
    for (const a of ASSET_INFO.filter((x) => x.tile)) {
      const parts = load(a.name), base = a.max[a.tile!.axis] - a.min[a.tile!.axis];
      const open0 = openEdges(parts);
      for (const k of [0.3, 0.77, 1.6, 2.5]) {
        const t = tileOf(a.name, a.tile!.axis === 0 ? [k, 1] : [1, k])!;
        // 从原点那一头截掉 / 接上一段（off），长度一样：结果还是从模型原点开始
        const off = k === 0.77 ? t.period * 0.3 : k === 1.6 ? -t.period * 1.25 : 0;
        const r = tileMesh(parts, { ai: t.axis, zi: 2, dir: t.dir, base: t.base, period: t.period, dz: t.dz, len: t.len, off, cont: t.cont });
        const [lo, hi] = range(r, t.axis);
        check(near(t.dir > 0 ? lo : -hi, 0, 0.01) && near(t.dir > 0 ? hi : -lo, base * k, 0.01), `${a.name} ×${k}：长度应是 ${(base * k).toFixed(2)}，实际 ${lo.toFixed(2)}～${hi.toFixed(2)}`);
        check(r.length === parts.length && tris(r) > 0 && r.every((m) => m.uv.length / 2 === m.pos.length / 3 && m.nrm!.length === m.pos.length), `${a.name} ×${k}：每部分的位置、贴图坐标、法线数量对得上`);
        // 原来就封闭的模型，截断 / 接长以后也要封闭（端面补上了）
        // 切口上要补端面：正好落在切口平面里的三角形面积不能是零（木桥的木板之间有缝，切在缝里可以没有，不查）
        const capArea = (at: number) => r.reduce((sum, m) => {
          for (let i = 0; i < m.pos.length; i += 9) {
            const q = [0, 1, 2].map((j) => m.pos.slice(i + j * 3, i + j * 3 + 3));
            if (!q.every((v) => near(v[t.axis], at, 0.005))) continue;
            const e1 = q[1].map((v, j) => v - q[0][j]), e2 = q[2].map((v, j) => v - q[0][j]);
            sum += Math.hypot(e1[1] * e2[2] - e1[2] * e2[1], e1[2] * e2[0] - e1[0] * e2[2], e1[0] * e2[1] - e1[1] * e2[0]) / 2;
          }
          return sum;
        }, 0);
        if (solid.has(a.name)) {
          check(capArea(t.dir * base * k) > 0.5, `${a.name} ×${k}：末尾的切口补了端面（面积 ${capArea(t.dir * base * k).toFixed(2)}）`);
          check(capArea(0) > 0.5, `${a.name} ×${k}：开头的切口补了端面（面积 ${capArea(0).toFixed(2)}）`);
          // 破洞不能比原来的模型多（原来的模型自己就有没焊上的边）
          check(openEdges(r) <= open0 * Math.max(1, Math.ceil(k)) + 8, `${a.name} ×${k}：没焊上的边 ${openEdges(r)} 条，原来 ${open0} 条`);
        }
        // 另一个方向和别的坐标不变
        const o = 1 - t.axis, [olo, ohi] = range(r, o);
        check(near(olo, a.min[o], 0.01) && near(ohi, a.max[o], 0.01), `${a.name} ×${k}：宽度不变`);
      }
    }
    check(tileOf('Level2_WaveWood', [1, 2], 5) !== null && tileOf('WoodSlope', undefined) !== null, '起点动过、或者贴图要重排的（木制斜坡）：没拉长也要重新生成');
    check(tileOf('Level2_WaveWood', [1, 2]) === null && tileOf('WoodPlate', [2, 1]) === null && tileOf('Level2_WaveWood', undefined) === null, '长度方向没拉、或者不是这类素材：不走接长 / 截断');

    // 波浪板：接到整数个周期时两头一样高（都是波峰），半个周期时是波谷；吸附点跟着端面走
    const wave = (k: number): AssetElem => ({ id: 1, kind: 'asset', name: 'Level2_WaveWood', x: 0, y: 0, z: 0, rot: 0, scale: [k, 1] });
    const P = 32.88709, base = 180.8776;
    const farZ = (L: number) => { const f = feats(wave(L / base))!; return Math.max(...f.verts.filter((v) => near(v[0], -L, 0.01)).map((v) => v[2])); };
    check(near(farZ(4 * P), 0, 0.05), `4 个周期：远端在波峰，和近端一样高，实际 ${farZ(4 * P)}`);
    check(near(farZ(6.5 * P), -8.001, 0.05), `6.5 个周期：远端在波谷，实际 ${farZ(6.5 * P)}`);
    const wp = load('Level2_WaveWood');
    const r4 = tileMesh(wp, { ai: 0, zi: 2, dir: -1, base, period: P, dz: 0, len: 4 * P });
    const endTop = Math.max(...r4.flatMap((m) => { const z: number[] = []; for (let i = 0; i < m.pos.length; i += 3) if (near(m.pos[i], -4 * P, 0.01)) z.push(m.pos[i + 2]); return z; }));
    check(near(endTop, 0, 0.02), `网格在 4 个周期处的端面顶也在波峰：${endTop}`);
  });

  scenario('木制斜坡：贴图一段接一段，接缝处两边的贴图坐标一样', () => {
    const parts = (JSON.parse(fs.readFileSync('public/assets/WoodSlope.json', 'utf8')) as { parts: TriMesh[] }).parts.map((q) => ({ pos: q.pos, uv: q.uv, nrm: q.nrm }));
    const t = tileOf('WoodSlope', [1, 2.3])!;
    const r = tileMesh(parts, { ai: 1, zi: 2, dir: t.dir, base: t.base, period: t.period, dz: t.dz, len: t.len, cont: t.cont });
    /** 顶面上每个位置出现过的贴图坐标：同一个位置只能有一个 */
    const seams = (ms: TriMesh[]) => {
      const at = new Map<string, number[]>();
      let bad = 0, n = 0;
      for (const m of ms) for (let i = 0; i < m.pos.length / 3; i++) {
        if (m.nrm![i * 3 + 2] < 0.5) continue;
        const k = [0, 1, 2].map((j) => Math.round(m.pos[i * 3 + j] * 100)).join(','), uv = [m.uv[i * 2], m.uv[i * 2 + 1]], was = at.get(k);
        n++;
        if (!was) at.set(k, uv); else if (Math.abs(was[0] - uv[0]) > 1e-3 || Math.abs(was[1] - uv[1]) > 1e-3) bad++;
      }
      return { bad, n };
    };
    const orig = seams(parts), now = seams(r);
    check(orig.bad > 0, `原来的模型顶面每段各贴各的（${orig.bad} 处对不上），这条测试才有意义`);
    check(now.n > 20 && now.bad === 0, `重新生成后顶面的贴图坐标处处接得上：${now.bad} / ${now.n}`);
    // 坡度不变：每个周期升高 6.1467
    let top = -Infinity;
    for (const m of r) for (let i = 2; i < m.pos.length; i += 3) top = Math.max(top, m.pos[i]);
    check(near(top, (t.len / t.period) * t.dz, 0.05), `拉到 2.3 倍：顶端高度 ${top.toFixed(3)}`);
  });
}
