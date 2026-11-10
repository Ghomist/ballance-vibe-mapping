// 钢轨网格：正八边形截面沿路径扫掠。单轨平顶朝上、双轨尖顶朝上（与原版和 BBP 一致），法线取径向，呈平滑效果。
import {
  DOUBLE_OFFSET, MONO_OFFSET, RAIL_RADIUS, RAIL_SPAN, Rail, RailState,
  advance, curveSamples, kindSpans, railCenters, sampleRail, sideLowerSpan, stateAt,
} from '../model/rail';
import { parallelFrames } from '../model/spline';
import { dome, fillet, sweepTube, type TubeCap } from './railing';
import { apply, fromQuat, type V3 } from '../box/xform';

export interface RailMesh { pos: number[]; nrm: number[]; caps: TubeCap[] }

const rad = (d: number) => (d * Math.PI) / 180;

/** postDepth：侧轨两头弯下去的上轨插到路面以下多深（和护栏立柱一样，默认 2）。结果是世界坐标，倾斜的钢轨绕起点转过去 */
export function buildRail(r: Rail, postDepth = 2): RailMesh {
  const m = railLocal(r, postDepth);
  if (!r.q) return m;
  const Q = fromQuat(r.q), o: V3 = [r.x, r.y, r.z];
  const pt = (p: number[]): V3 => { const v = apply(Q, [p[0] - o[0], p[1] - o[1], p[2] - o[2]]); return [v[0] + o[0], v[1] + o[1], v[2] + o[2]]; };
  const each = (a: number[], f: (p: V3) => V3) => { const out: number[] = []; for (let i = 0; i < a.length; i += 3) out.push(...f([a[i], a[i + 1], a[i + 2]])); return out; };
  return {
    pos: each(m.pos, pt), nrm: each(m.nrm, (n) => apply(Q, n)),
    caps: m.caps.map((c) => ({ ...c, ring: c.ring.map(pt), dir: apply(Q, c.dir as V3) })),
  };
}

function railLocal(r: Rail, postDepth: number): RailMesh {
  const out: RailMesh = { pos: [], nrm: [], caps: [] };
  if (!r.pieces.length) return out;
  if (r.curve?.frame === 'parallel') return parallelRail(r);
  if (r.side && r.pieces.length === 1 && r.pieces[0].angle === 0) return buildSideRail(r, postDepth);
  const samples = sampleRail(r);
  const spans = kindSpans(r);
  spans.forEach((span, si) => {
    // 取该区间内的采样点，并在区间两端补上精确的切点
    const pts: RailState[] = [stateAt(r, span.s0)];
    for (const sm of samples) if (sm.s > span.s0 + 1e-6 && sm.s < span.s1 - 1e-6) pts.push(sm);
    pts.push(stateAt(r, span.s1));
    // 坡度：用相邻点估计切线的竖直分量
    const offsets = span.kind === 'double' ? [-RAIL_SPAN / 2, RAIL_SPAN / 2] : [0];
    // 球形闭合只在整根钢轨的两头，单双转换的接口还是平的
    for (const off of offsets) tube(out, pts, span.kind, off, [!!r.tips?.[0] && si === 0, !!r.tips?.[1] && si === spans.length - 1], !!r.curve?.closed);
  });
  return out;
}

/**
 * 侧轨：下轨的轴线就是路径，上轨按倾斜角斜上去；两头可以让上轨像护栏立柱那样拐个圆角竖直插下去
 *（立柱竖到路面以下 postDepth，路面比路径高一个钢轨半径），这一头的下轨缩短。两根都是一整根平滑的圆管。
 */
function buildSideRail(r: Rail, postDepth: number): RailMesh {
  const [[, dzLo], [lat, dzUp]] = railCenters(r, 'double');
  const s0: RailState = { x: r.x, y: r.y, z: r.z, heading: r.heading };
  const pc = r.pieces[0];
  const s1 = advance(s0, pc);
  const h = rad(r.heading), L = [-Math.sin(h), Math.cos(h)];
  const P = (s: RailState, l: number, dz: number): [number, number, number] => [s.x + L[0] * l, s.y + L[1] * l, s.z + dz];
  const [ta, tb] = sideLowerSpan(r);
  const tips = r.tips ?? [false, false];
  const lower = tb > ta ? sweepTube([P(advance(s0, pc, ta), 0, dzLo), P(advance(s0, pc, tb), 0, dzLo)], false, RAIL_RADIUS, tips) : { pos: [], nrm: [], caps: [] };
  const up: [number, number, number][] = [P(s0, lat, dzUp), P(s1, lat, dzUp)];
  const [e0, e1] = r.side!.ends ?? [false, false];
  if (e0) up.unshift(P(s0, lat, RAIL_RADIUS - postDepth));
  if (e1) up.push(P(s1, lat, RAIL_RADIUS - postDepth));
  const upper = sweepTube(e0 || e1 ? fillet(up, false) : up, false, RAIL_RADIUS, tips);
  return {
    pos: [...lower.pos, ...upper.pos], nrm: [...lower.nrm, ...upper.nrm],
    caps: [...lower.caps, ...upper.caps.map((c) => ({ ...c, at: c.at + lower.pos.length }))],
  };
}

/**
 * 导出用：头尾相接的钢轨合成一个网格，接头里互相贴着的两个封盖去掉（一个物体里顶点才焊得上，法线和反射 UV 才连续）。
 * 两个封盖截面完全重合、朝向相反才算相接；从同一点朝同一边岔开的钢轨不算，两头都留着封盖。返回每个合并后网格的三角形。
 */
export function mergeRails(rails: RailMesh[]): number[][] {
  const TOL = 1e-3;
  const near = (a: number[], b: number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < TOL;
  const caps = rails.flatMap((m, mesh) => m.caps.map((c) => ({ ...c, mesh, hidden: false })));
  // 接头两边的顶点可能差一点点：后一根的这一圈挪到前一根的位置上，导出时才焊得上
  const moved = rails.map(() => new Map<string, number[]>());
  const vkey = (x: number, y: number, z: number) => `${x},${y},${z}`;
  const root = rails.map((_, i) => i);
  const find = (i: number) => { while (root[i] !== i) i = root[i] = root[root[i]]; return i; };
  caps.forEach((a, i) => {
    if (a.hidden) return;
    for (const b of caps.slice(i + 1)) {
      if (b.hidden || a.dir[0] * b.dir[0] + a.dir[1] * b.dir[1] + a.dir[2] * b.dir[2] >= 0) continue;
      if (!a.ring.every((p) => b.ring.some((q) => near(p, q)))) continue;
      a.hidden = b.hidden = true;
      root[find(a.mesh)] = find(b.mesh);
      for (const q of b.ring) moved[b.mesh].set(vkey(q[0], q[1], q[2]), a.ring.find((p) => near(p, q))!);
      return;
    }
  });
  const out = new Map<number, number[]>();
  rails.forEach((m, i) => {
    const dst = out.get(find(i)) ?? [];
    out.set(find(i), dst);
    const copy = (a: number, b: number) => {
      for (let k = a; k < b; k += 3) {
        const to = moved[i].get(vkey(m.pos[k], m.pos[k + 1], m.pos[k + 2]));
        if (to) dst.push(to[0], to[1], to[2]); else dst.push(m.pos[k], m.pos[k + 1], m.pos[k + 2]);
      }
    };
    let at = 0;
    for (const c of caps.filter((x) => x.mesh === i && x.hidden).sort((x, y) => x.at - y.at)) { copy(at, c.at); at = c.at + c.len; }
    copy(at, m.pos.length);
  });
  return [...out.values()];
}

/** 平行传递的样条线钢轨：截面垂直于曲线，朝向由平行传递和侧倾角决定，能竖直爬升、翻圈 */
function parallelRail(r: Rail): RailMesh {
  const out: RailMesh = { pos: [], nrm: [], caps: [] };
  const sm = curveSamples(r);
  if (sm.length < 2) return out;
  const kind = r.pieces[0]?.kind === 'mono' ? 'mono' : 'double';
  const closed = !!r.curve!.closed;
  const fr = parallelFrames(sm, closed);
  const zOff = kind === 'double' ? DOUBLE_OFFSET : MONO_OFFSET;
  const phase = kind === 'mono' ? 22.5 : 0;
  for (const off of kind === 'double' ? [-RAIL_SPAN / 2, RAIL_SPAN / 2] : [0]) {
    const rings: Ring[] = sm.map((m, i) => {
      const { L, U } = fr[i];
      const c = m.p.map((v, n) => v + L[n] * off + U[n] * zOff);
      const n: number[][] = [], v: number[][] = [];
      for (let k = 0; k < 8; k++) {
        const th = rad(phase + k * 45), co = Math.cos(th), si = Math.sin(th);
        const d = [L[0] * co + U[0] * si, L[1] * co + U[1] * si, L[2] * co + U[2] * si];
        n.push(d);
        v.push(c.map((x, a) => x + d[a] * RAIL_RADIUS));
      }
      return { c, v, n };
    });
    skin(out, rings, [!!r.tips?.[0], !!r.tips?.[1]], [[...sm[0].t], [...sm[sm.length - 1].t]], closed);
  }
  return out;
}

type Ring = { c: number[]; v: number[][]; n: number[][] };

function tube(out: RailMesh, pts: RailState[], kind: 'double' | 'mono', lateral: number, round: [boolean, boolean], closed = false) {
  const zOff = kind === 'double' ? DOUBLE_OFFSET : MONO_OFFSET;
  const phase = kind === 'mono' ? 22.5 : 0;
  const rings: Ring[] = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    const h = rad(p.heading);
    const L = [-Math.sin(h), Math.cos(h), 0]; // 水平左侧
    // 切线（含坡度）
    const cnt = pts.length; // 首尾相连时接缝两边互为邻居
    const a = closed && i === 0 ? pts[cnt - 2] : pts[Math.max(i - 1, 0)], b = closed && i === cnt - 1 ? pts[1] : pts[Math.min(i + 1, cnt - 1)];
    const horiz = Math.hypot(b.x - a.x, b.y - a.y);
    const slope = horiz > 1e-9 ? (b.z - a.z) / horiz : 0;
    const T = normalize([Math.cos(h), Math.sin(h), slope]);
    const U = normalize(cross(T, L)); // 截面内的“上”
    const c = [p.x + L[0] * lateral, p.y + L[1] * lateral, p.z + zOff];
    // 和坡面路一样：每一圈都是竖直截面，大小不随坡度变（坡道是平轨沿竖直方向错切出来的），
    // 所以任何坡度、螺旋的两头都和相接的轨道 / 路面截面完全一样
    const v: number[][] = [], n: number[][] = [];
    for (let k = 0; k < 8; k++) {
      const th = rad(phase + k * 45);
      const d = [L[0] * Math.cos(th) + U[0] * Math.sin(th), L[1] * Math.cos(th) + U[1] * Math.sin(th), L[2] * Math.cos(th) + U[2] * Math.sin(th)];
      v.push([c[0] + L[0] * Math.cos(th) * RAIL_RADIUS, c[1] + L[1] * Math.cos(th) * RAIL_RADIUS, c[2] + Math.sin(th) * RAIL_RADIUS]);
      n.push(d);
    }
    rings.push({ c, v, n });
  }
  skin(out, rings, round, undefined, closed);
}

/** 一圈圈截面连成管子，两头封盖。ends：两头的切线（平行传递时端面垂直于切线）；没给就是竖直端面，封盖朝水平方向 */
function skin(out: RailMesh, rings: Ring[], round: [boolean, boolean], ends?: [number[], number[]], closed = false) {
  const tri = (p: number[][], n: number[][]) => { for (let i = 0; i < 3; i++) { out.pos.push(...p[i]); out.nrm.push(...n[i]); } };
  for (let i = 0; i + 1 < rings.length; i++) {
    const A = rings[i], B = rings[i + 1];
    for (let k = 0; k < 8; k++) {
      const k2 = (k + 1) % 8;
      // 绕序：从外侧看逆时针（截面角度沿 L→U 递增，路径沿 T 前进；由测试校验）
      tri([A.v[k], B.v[k2], B.v[k]], [A.n[k], B.n[k2], B.n[k]]);
      tri([A.v[k], A.v[k2], B.v[k2]], [A.n[k], A.n[k2], B.n[k2]]);
    }
  }
  if (closed) return; // 首尾相连：没有端头
  // 两端封盖
  const cap = (R: { c: number[]; v: number[][] }, dir: number[], flip: boolean, ball: boolean, inner: { c: number[] }) => {
    if (ball) {
      // 截面是竖直的，半球和管子一样按坡度错切：顶点沿水平方向走出去，同时升高坡度那么多
      const d = sub(R.c, inner.c), l = Math.hypot(d[0], d[1]) || 1;
      dome(R.v, R.c, ends ? dir : [dir[0], dir[1], d[2] / l], RAIL_RADIUS, out);
      return;
    }
    const at = out.pos.length;
    for (let k = 1; k < 7; k++) {
      const p = flip ? [R.v[0], R.v[k + 1], R.v[k]] : [R.v[0], R.v[k], R.v[k + 1]];
      tri(p, [dir, dir, dir]);
    }
    out.caps.push({ at, len: out.pos.length - at, ring: R.v, dir });
  };
  const first = rings[0], last = rings[rings.length - 1];
  // 端面是竖直的：封盖朝水平方向
  const flat = (a: number[]) => normalize([a[0], a[1], 0]);
  const t0 = ends?.[0] ?? flat(sub(rings[Math.min(1, rings.length - 1)].c, first.c));
  const t1 = ends?.[1] ?? flat(sub(last.c, rings[Math.max(rings.length - 2, 0)].c));
  cap(first, t0.map((x) => -x), true, round[0], rings[Math.min(1, rings.length - 1)]);
  cap(last, t1, false, round[1], rings[Math.max(rings.length - 2, 0)]);
}

const sub = (a: number[], b: number[]) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: number[], b: number[]) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
function normalize(a: number[]) { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l]; }
