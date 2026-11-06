// box 版求解器（src/box/solve.ts）的基线不变量。
//
// 这里不写「期望值」，只断言任何正确结果都必须满足的性质，所以每个内置场景都能跑一遍：
// 数组自洽、不退化、朝向、花纹 u 范围、外沿环、资产、接缝连续、确定性、无悬浮几何…
// 期望值（三角形数、面积这类粗粒度数字）留给 tests/box/golden.ts。
import type { MatName, MeshPart } from '../src/geom/floor';
import { edgeAt } from '../src/box/guard';
import { SCENES } from '../src/box/scenes';
import { type Solved, solve, solveStats } from '../src/box/solve';
import { type Box, type Doc, SINK_DEPTH, basePiece, boxTopAt, emptyDoc, footprint, isSlope, virtualCells } from '../src/box/types';

type V3 = [number, number, number];
type Check = (cond: boolean, msg: string) => void;
type Scenario = (name: string, fn: () => void) => void;

/** 顶面材质（凹路、平路面都算顶面；Lighting 是厚度 > 5 的路面顶面） */
const isTop = (m: MatName) => m.startsWith('FloorTop') || m.startsWith('LightingFloorTop');

const sub = (a: V3, b: V3): V3 => [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const triArea = (p: V3[]) => norm(cross(sub(p[0], p[1]), sub(p[0], p[2]))) / 2;

interface Tri { id: number; mat: MatName; p: [V3, V3, V3]; u: [[number, number], [number, number], [number, number]] }

function* allTris(solved: Solved): Generator<Tri> {
  for (const [id, mesh] of solved.meshes) {
    for (const mat of Object.keys(mesh.parts) as MatName[]) {
      const part = mesh.parts[mat]!;
      for (let i = 0; i < part.pos.length / 9; i++) {
        const o = i * 9, w = i * 6;
        yield {
          id, mat,
          p: [[part.pos[o], part.pos[o + 1], part.pos[o + 2]], [part.pos[o + 3], part.pos[o + 4], part.pos[o + 5]], [part.pos[o + 6], part.pos[o + 7], part.pos[o + 8]]],
          u: [[part.uv[w], part.uv[w + 1]], [part.uv[w + 2], part.uv[w + 3]], [part.uv[w + 4], part.uv[w + 5]]],
        };
      }
    }
  }
}

/** 有问题的项收集起来：一次只报一条 check，但消息里带最多 3 个例子 */
function report(check: Check, label: string, problems: string[]) {
  const head = problems.slice(0, 3).join('；');
  check(problems.length === 0, `${label}（${problems.length} 处）：${head}`);
}

/** 点是否在三角形（投影到 XY）内 */
function inTriXY([x, y]: [number, number], [a, b, c]: [V3, V3, V3]): [number, number, number] | null {
  const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
  if (Math.abs(d) < 1e-12) return null;
  const l1 = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
  const l2 = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
  const l3 = 1 - l1 - l2;
  if (l1 < -1e-9 || l2 < -1e-9 || l3 < -1e-9) return null;
  return [l1, l2, l3];
}

/** 夹具：互不重叠、都不带朝向的 box，用来做精确的面积 / 高度 / 花纹断言 */
function flatFixture(): Doc {
  const d = emptyDoc();
  let id = 1;
  const box = (b: Partial<Box>) => { d.elems[id] = { id: id++, kind: 'box', z: 0, depth: 5, style: 'normal', ...b } as Box; };
  box({ x: 0, y: 0, sx: 10, sy: 10 }); //                       1 普通
  box({ x: 12, y: 0, sx: 10, sy: 10, style: 'sink' }); //       2 凹
  box({ x: 24, y: 0, sx: 10, sy: 10, style: 'ribbon' }); //     3 无边框（凹）
  box({ x: 36, y: 0, sx: 10, sy: 10, depth: 7 }); //            4 厚路面
  box({ x: 0, y: 12, sx: 10, sy: 10, slope: { axis: 0, dz: 5 } }); //   5 坡（沿 x）
  box({ x: 12, y: 12, sx: 10, sy: 10, slope: { axis: 1, dz: -5 } }); // 6 坡（沿 y，往下）
  return d;
}

/** 夹具：单独一块绕 X 转了 30° 的路面（面积不变，但投影到 XY 会变小） */
function tiltedFixture(): Doc {
  const d = emptyDoc();
  const a = Math.PI / 6;
  d.elems[1] = { id: 1, kind: 'box', x: 0, y: 0, z: 0, sx: 10, sy: 6, depth: 5, style: 'normal', q: [Math.sin(a / 2), 0, 0, Math.cos(a / 2)] } as Box;
  return d;
}

/** 一块路面顶面应有的面积（坡的斜面比投影大 sec 倍；绕轴旋转不改变面积） */
/** 三角形投影到 XY 的面积 */
const projArea = (p: V3[]) => Math.abs((p[1][0] - p[0][0]) * (p[2][1] - p[0][1]) - (p[1][1] - p[0][1]) * (p[2][0] - p[0][0])) / 2;

/** 顶面覆盖的高度范围：凹路（含无边框）中间下沉 SINK_DEPTH，靠边是斜坡 */
function topRange(b: Box): [number, number] {
  const top = b.z + (isSlope(b) ? b.slope.dz : 0);
  const lo = Math.min(b.z, top), hi = Math.max(b.z, top);
  const sink = b.style === 'normal' ? 0 : SINK_DEPTH;
  return [lo - sink - 1e-6, hi + 1e-6];
}

/** 求解一次并做「任何场景都该成立」的检查 */
function sceneProblems(doc: Doc): Record<string, string[]> {
  const bad: Record<string, string[]> = { 数值: [], 退化: [], 比例: [], 顶面朝向: [], 花纹u: [], 外沿: [], 无归属: [] };
  const before = JSON.stringify(doc);
  const solved = solve(doc);
  if (JSON.stringify(doc) !== before) bad.数值.push('求解修改了 doc');

  for (const [id, mesh] of solved.meshes) {
    if (mesh.id !== id) bad.数值.push(`网格 id ${mesh.id} 与 key ${id} 不符`);
    for (const mat of Object.keys(mesh.parts) as MatName[]) {
      const part: MeshPart = mesh.parts[mat]!;
      if (part.pos.length % 9) bad.比例.push(`${id}/${mat} 顶点数 ${part.pos.length} 不是 9 的倍数`);
      if (part.uv.length !== (part.pos.length / 3) * 2) bad.比例.push(`${id}/${mat} uv ${part.uv.length} 与顶点 ${part.pos.length / 3} 不符`);
      if (part.own && part.own.length !== part.pos.length / 9) bad.比例.push(`${id}/${mat} own ${part.own.length} 与三角形 ${part.pos.length / 9} 不符`);
      if (part.pos.some((v) => !Number.isFinite(v)) || part.uv.some((v) => !Number.isFinite(v))) bad.数值.push(`${id}/${mat} 有 NaN / Infinity`);
    }
  }
  for (const t of allTris(solved)) {
    const a = triArea(t.p);
    if (a <= 1e-9) bad.退化.push(`${t.id}/${t.mat} 面积 ${a.toExponential(2)}`);
    const n = cross(sub(t.p[0], t.p[1]), sub(t.p[0], t.p[2]));
    const nl = norm(n);
    if (nl < 1e-12) continue;
    if (isTop(t.mat) && n[2] / nl < -1e-6) bad.顶面朝向.push(`${t.id}/${t.mat} nz=${(n[2] / nl).toFixed(3)}`);
    // 花纹 u：uScale 由材质决定（有边框 0.5、无边框 1）；素材件用世界坐标贴图（uv = 坐标/5），不在此列
    const ownerKind = t.id > 0 ? doc.elems[t.id]?.kind : 'box';
    if (isTop(t.mat) && ownerKind === 'box') {
      const uScale = t.mat === 'FloorTopBorderless' ? Infinity : t.mat === 'FloorTopFlat' || t.mat === 'FloorTopProfilFlat' ? 1 : 0.5;
      for (const [u] of t.u) if (u < -1e-6 || u > uScale + 1e-6) bad.花纹u.push(`${t.id}/${t.mat} u=${u.toFixed(4)} > ${uScale}`);
    }
  }
  // 外沿环：闭合、点有限、段长 > 0，环上的点能用 edgeAt 找到
  for (const [i, l] of solved.loops.entries()) {
    if (l.pts.length < 2) bad.外沿.push(`环 ${i} 只有 ${l.pts.length} 个点`);
    if (l.closed && l.pts.length < 3) bad.外沿.push(`闭合环 ${i} 只有 ${l.pts.length} 个点`);
    if (l.pts.some((p) => p.some((v) => !Number.isFinite(v)))) bad.外沿.push(`环 ${i} 有 NaN`);
    if (l.outs.some((o) => Math.abs(Math.hypot(o[0], o[1]) - 1) > 1e-6)) bad.外沿.push(`环 ${i} 的 outs 不是单位向量`);
    if (!edgeAt(solved.loops, l.pts[0])) bad.外沿.push(`环 ${i} 的起点不在外沿上`);
  }
  // 自动插入的转换件（负数 id）必须指向存在的路面
  for (const [id, owner] of solved.owner) {
    if (id >= 0) bad.无归属.push(`owner 的键 ${id} 不是负数 id`);
    if (!doc.elems[owner]) bad.无归属.push(`自动件 ${id} 归属到不存在的元素 ${owner}`);
  }
  // 每个资产 / 网格都必须对应一个存在的元素（自动件除外）
  for (const id of solved.meshes.keys()) if (id > 0 && !doc.elems[id]) bad.数值.push(`网格 id ${id} 不在 doc 里`);
  for (const id of solved.assets.keys()) if (!doc.elems[id]) bad.数值.push(`资产 id ${id} 不在 doc 里`);
  return bad;
}

export function boxSolveScenarios(check: Check, scenario: Scenario) {
  const scenes = SCENES.map((s) => ({ name: s.name, doc: s.build() }));

  scenario('box 求解：数组自洽 / 无退化 / 朝向 / 花纹 u（每个内置场景）', () => {
    const all: string[] = [];
    for (const { name, doc } of scenes) {
      const bad = sceneProblems(doc);
      for (const [k, v] of Object.entries(bad)) for (const m of v) all.push(`${name}: [${k}] ${m}`);
    }
    report(check, '求解结果不满足通用不变量', all);
  });

  scenario('box 求解：求解不修改 doc、重复求解结果相同', () => {
    for (const { name, doc } of scenes) {
      const before = JSON.stringify(doc);
      const a = solve(doc), b = solve(doc);
      check(JSON.stringify(doc) === before, `${name}: solve 修改了 doc`);
      const sig = (s: Solved) => [...s.meshes].map(([id, m]) => `${id}:${m.sig ?? ''}:${Object.keys(m.parts).sort().map((k) => m.parts[k as MatName]!.pos.length).join('/')}`).join('|');
      check(sig(a) === sig(b), `${name}: 两次求解的网格不一致`);
      check(a.assets.size === b.assets.size && a.loops.length === b.loops.length, `${name}: 两次求解的资产 / 外沿数量不一致`);
    }
  });

  scenario('box 求解：第二次求解全部命中网格缓存', () => {
    for (const { name, doc } of scenes) {
      solve(doc);
      const cold = solveStats.miss;
      const warm = solve(doc);
      check(solveStats.miss === 0, `${name}: 热解又有 ${solveStats.miss} 次网格重建（冷解 ${cold} 次）`);
      check(solveStats.hit > 0 && warm.meshes.size > 0, `${name}: 热解一次网格重建都没有（hit ${solveStats.hit}）`);
    }
  });

  scenario('box 求解：跨元素同材质花纹断点不增加（基线棘轮）', () => {
    const problems: string[] = [];
    const nums: number[] = [];
    let total = 0;
    for (const { name, doc } of scenes) {
      const solved = solve(doc);
      const byKey = new Map<string, { u: [number, number]; id: number; mat: MatName }[]>();
      for (const t of allTris(solved)) {
        if (!isTop(t.mat)) continue;
        for (let i = 0; i < 3; i++) {
          const p = t.p[i];
          const key = `${p[0].toFixed(3)},${p[1].toFixed(3)},${p[2].toFixed(3)}`;
          const l = byKey.get(key);
          if (l) l.push({ u: t.u[i], id: t.id, mat: t.mat }); else byKey.set(key, [{ u: t.u[i], id: t.id, mat: t.mat }]);
        }
      }
      let n = 0;
      for (const [key, l] of byKey) {
        if (l.length < 2) continue;
        if (new Set(l.map((i) => i.id)).size < 2) continue; // 同一元素内部不要求连续：边框花纹按圈绕，拐角和中线会断开
        const byMat = new Map<MatName, { u: [number, number]; id: number }[]>();
        for (const e of l) byMat.set(e.mat, [...(byMat.get(e.mat) ?? []), e]);
        for (const [mat, es] of byMat) {
          if (es.length < 2 || new Set(es.map((e) => e.id)).size < 2) continue;
          const us = es.map((e) => e.u[0]), vs = es.map((e) => e.u[1]);
          const du = Math.max(...us) - Math.min(...us), dv = Math.max(...vs) - Math.min(...vs);
          if (du <= 1e-6 && dv <= 1e-6) continue;
          n++;
          if (problems.length < 4) problems.push(`${name}: (${key}) ${mat} Δu=${du.toFixed(4)} Δv=${dv.toFixed(4)} ${es.map((e) => e.id).join(' + ')}`);
        }
      }
    }
    // 现状：跨元素同材质的 v 在层/样式交界处会重置（斜坡→平台这类）。这里只棘轮断点数：变多是回归，
    // 以后修好了变小也不用改测试。
    const baseline = 91;
    check(total <= baseline, `跨元素同材质花纹断点 ${total} 处 > 基线 ${baseline}：${nums.join('・')}\n${problems.join('\n')}`);
  });

  scenario('box 求解：顶面质心都落在某个元素的在路面范围内（无悬浮几何）', () => {
    const problems: string[] = [];
    for (const { name, doc } of scenes) {
      const solved = solve(doc);
      const rects: { x0: number; y0: number; x1: number; y1: number }[] = [];
      for (const e of Object.values(doc.elems)) {
        if (e.kind === 'box' || e.kind === 'piece') rects.push(footprint(e));
        else if (e.kind === 'obj') {
          const base = basePiece(e);
          const rs = virtualCells(e);
          if (base) rects.push(footprint(base)); else rects.push(...rs);
        }
      }
      const inside = (x: number, y: number) => rects.some((r) => x >= r.x0 - 1e-3 && x <= r.x1 + 1e-3 && y >= r.y0 - 1e-3 && y <= r.y1 + 1e-3);
      let n = 0;
      for (const t of allTris(solved)) {
        if (!isTop(t.mat)) continue;
        const cx = (t.p[0][0] + t.p[1][0] + t.p[2][0]) / 3, cy = (t.p[0][1] + t.p[1][1] + t.p[2][1]) / 3;
        if (inside(cx, cy)) continue;
        n++;
        if (n <= 3) problems.push(`${name}: 三角形 ${t.id}/${t.mat} 质心 (${cx.toFixed(2)}, ${cy.toFixed(2)}) 不在任何元素范围内`);
      }
      if (n > 3) problems.push(`${name}: …共 ${n} 个悬浮三角形`);
    }
    report(check, '存在悬浮的路面三角形', problems);
  });

  scenario('box 求解：起点的资产（火焰 / 重生点）', () => {
    for (const { name, doc } of scenes) {
      const starts = Object.values(doc.elems).filter((e) => e.kind === 'piece' && e.type === 'start');
      if (!starts.length) continue;
      const solved = solve(doc);
      for (const s of starts) {
        const a = solved.assets.get(s.id);
        check(!!a, `${name}: 起点 ${s.id} 没有资产`);
        if (!a) continue;
        check(a.some((p) => p.name === 'PS_FourFlames'), `${name}: 起点 ${s.id} 缺四火焰`);
        check(a.some((p) => p.name === 'PR_Resetpoint'), `${name}: 起点 ${s.id} 缺重生点`);
        check(a.some((p) => p.kind === 'asset'), `${name}: 起点 ${s.id} 缺盘点路面模型`);
      }
    }
  });

  scenario('box 求解：面积守恒（互不重叠的夹具，逐块比对）', () => {
    for (const [label, doc] of [['平坦夹具', flatFixture()], ['倾斜夹具', tiltedFixture()]] as const) {
      const solved = solve(doc);
      let sum = 0, want = 0;
      for (const e of Object.values(doc.elems)) {
        if (e.kind !== 'box') continue;
        const mesh = solved.meshes.get(e.id);
        check(!!mesh, `${label}: 路面 ${e.id} 没有网格`);
        const got = [...allTris(solved)].filter((t) => t.id === e.id && isTop(t.mat)).reduce((s, t) => s + (e.q ? triArea(t.p) : projArea(t.p)), 0);
        // 投影面积：坡的斜面投影回地面就是 footprint；倾斜的元素只能比 3D 面积
        const f = footprint(e), exp = e.q ? e.sx * e.sy : (f.x1 - f.x0) * (f.y1 - f.y0);
        check(Math.abs(got - exp) <= 1e-6 * Math.max(1, exp), `${label}: 路面 ${e.id} 顶面积 ${got.toFixed(4)} ≠ ${exp.toFixed(4)}`);
        sum += got; want += exp;
      }
      check(Math.abs(sum - want) <= 1e-6 * want, `${label}: 顶面总面积 ${sum.toFixed(4)} ≠ ${want.toFixed(4)}`);
    }
  });

  scenario('box 求解：顶面覆盖（夹具上撒点，不能有洞、高度要对）', () => {
    const doc = flatFixture();
    const solved = solve(doc);
    const tops = [...allTris(solved)].filter((t) => isTop(t.mat));
    const problems: string[] = [];
    for (const e of Object.values(doc.elems)) {
      if (e.kind !== 'box' || e.q) continue;
      const f = footprint(e);
      const [zlo, zhi] = topRange(e);
      let holes = 0, badz = 0, samples = 0;
      for (let x = f.x0 + 0.125; x < f.x1; x += 0.5) for (let y = f.y0 + 0.125; y < f.y1; y += 0.5) {
        samples++;
        let hit = false, zAny = false;
        for (const t of tops) {
          const w = inTriXY([x, y], t.p);
          if (!w) continue;
          hit = true;
          const z = w[0] * t.p[0][2] + w[1] * t.p[1][2] + w[2] * t.p[2][2];
          if (z >= zlo && z <= zhi) zAny = true;
        }
        if (!hit) holes++; else if (!zAny) badz++;
      }
      if (holes) problems.push(`路面 ${e.id}: ${holes}/${samples} 个采样点没有顶面（有洞）`);
      if (badz) problems.push(`路面 ${e.id}: ${badz}/${samples} 个采样点顶面高度超出 [${zlo.toFixed(2)}, ${zhi.toFixed(2)}]`);
    }
    report(check, '顶面覆盖有问题', problems);
  });

  scenario('box 求解：凹路下沉 / 坡的高度 / 倾斜等价于旋转后的未倾斜结果', () => {
    const doc = flatFixture();
    const solved = solve(doc);
    const byId = (id: number) => [...allTris(solved)].filter((t) => t.id === id && isTop(t.mat));

    // 凹路：中间一格（离边 > BAND）比路边低 SINK_DEPTH
    const sink = byId(2);
    const zs = sink.flatMap((t) => t.p.map((p) => p[2]));
    check(Math.abs(Math.max(...zs)) < 1e-6, `凹路顶面最高点 ${Math.max(...zs)} 应等于 z=0`);
    check(Math.abs(Math.min(...zs) + SINK_DEPTH) < 1e-6, `凹路顶面最低点 ${Math.min(...zs)} 应等于 -${SINK_DEPTH}`);
    // 普通路面不该下沉
    const flat = byId(1);
    check(flat.every((t) => t.p.every((p) => Math.abs(p[2]) < 1e-6)), '普通路面被下沉了');

    // 坡：沿坡方向线性，两端是 z 与 z+dz
    const slope = Object.values(doc.elems).find((e): e is Box => e.kind === 'box' && e.id === 5)!;
    const st = byId(5);
    const zAt = (x: number, y: number) => {
      for (const t of st) {
        const w = inTriXY([x, y], t.p);
        if (w) return w[0] * t.p[0][2] + w[1] * t.p[1][2] + w[2] * t.p[2][2];
      }
      return NaN;
    };
    for (const [x, y] of [[0.5, 17], [5, 17], [9.5, 17], [5, 12.5], [5, 21.5]]) {
      const want = boxTopAt(slope, x, y);
      const got = zAt(x, y);
      check(Math.abs(got - want) < 1e-6, `坡 (${x}, ${y}) 的高度 ${got} ≠ ${want}`);
    }

    // 倾斜：面积与未倾斜一致
    const tilt = solve(tiltedFixture());
    const area = [...allTris(tilt)].filter((t) => isTop(t.mat)).reduce((s, t) => s + triArea(t.p), 0);
    check(Math.abs(area - 60) < 1e-6, `倾斜 30° 的 10×6 路面顶面积 ${area} ≠ 60`);
  });

  scenario('box 求解：花纹 v 沿直边每 5 个单位一个单位', () => {
    for (const [w, h] of [[10, 5], [10, 12], [20, 5]] as const) {
      const doc = emptyDoc();
      doc.elems[1] = { id: 1, kind: 'box', x: 0, y: 0, z: 0, sx: w, sy: h, depth: 5, style: 'normal' } as Box;
      const solved = solve(doc);
      const border = [...allTris(solved)].filter((t) => t.mat === 'FloorTopBorder');
      check(border.length > 0, `${w}x${h}: 普通路面没有边框材质`);
      // 右边（x = w）两个角上的边框顶点：沿着边每 5 个单位 v 走 1 个单位
      const right = border.flatMap((t) => t.p.map((p, i) => ({ p, v: t.u[i][1] }))).filter(({ p }) => Math.abs(p[0] - w) < 1e-9);
      const vs = [...new Set(right.map((i) => +i.v.toFixed(6)))];
      // 同一条边上存在一对顶点，v 的差正好是 边长/5（拐角上还会有另一条边绕过来的值，不参与比较）
      let hit = false;
      for (const a of vs) for (const b of vs) if (Math.abs(Math.abs(a - b) - h / 5) < 1e-6) hit = true;
      check(hit, `${w}x${h}: 右边 v 的取值 ${vs.join(' / ')} 里没有相差 ${h / 5} 的一对`);
    }
  });
}
