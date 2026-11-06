// 性能基线：给求解器的几条典型路径留一组可重复的数字（npm run bench）。
//
// 不进 npm test：CI 的机器快慢差很多，耗时断言放在这里，只在需要时手动跑。
// 数字存在 tests/bench/baseline.json，UPDATE_BENCH=1 时刷新；超过基线 3 倍算失败。
//
// 三种形状分别压不同的东西：
//   corridor  一条连通的赛道（很多段首尾相接，外沿 / 花纹要跨元素合并）
//   field     大量互不相连的小块（每块都是一个独立网格）
//   comb      一整块连通的大面，但外沿很长（梳子形：一条脊 + 很多长条）
import { clearSolveCache, solve, solveStats } from '../src/box/solve';
import type { Doc, Elem } from '../src/box/types';

const fs = (await import('node:fs' as string)) as {
  existsSync(p: string): boolean; readFileSync(p: string, enc: string): string; writeFileSync(p: string, s: string): void;
  mkdirSync(p: string, o: { recursive: boolean }): void;
};
const env = (globalThis as { process?: { env: Record<string, string | undefined>; exit(c: number): void } }).process;
const BASE = new URL('./bench/baseline.json', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');

/** 一条长赛道：每行 10 段 20×5 的直路，隔行方向相反，坡道与平台交替 */
function corridor(n: number): Doc {
  const elems: Record<number, Elem> = {};
  let id = 1;
  for (let i = 0; i < n; i++) {
    const row = Math.floor(i / 10), col = i % 10;
    const x = row % 2 === 0 ? col * 20 : (9 - col) * 20;
    const z = (i % 5) * 2.5;
    elems[id] = { id: id++, kind: 'box', x, y: row * 10, z, sx: 20, sy: 5, depth: 5, style: i % 11 === 5 ? 'sink' : 'normal' } as Elem;
  }
  return { elems, nextId: id };
}

/** 大量互不相连的小块：n×n 个 5×5 */
function field(n: number): Doc {
  const elems: Record<number, Elem> = {};
  let id = 1;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    elems[id] = { id: id++, kind: 'box', x: i * 10, y: j * 10, z: 0, sx: 5, sy: 5, depth: 5, style: 'normal' } as Elem;
  }
  return { elems, nextId: id };
}

/** 梳子形：一条脊 + rows 根长条，连成一块大面，外沿非常长 */
function comb(rows: number, len: number): Doc {
  const elems: Record<number, Elem> = {};
  let id = 1;
  elems[id] = { id: id++, kind: 'box', x: 0, y: 0, z: 0, sx: 5, sy: rows * 10 + 5, depth: 5, style: 'normal' } as Elem;
  for (let i = 0; i < rows; i++) elems[id] = { id: id++, kind: 'box', x: 5, y: i * 10, z: 0, sx: len, sy: 5, depth: 5, style: 'normal' } as Elem;
  return { elems, nextId: id };
}

const median = (a: number[]) => { a.sort((x, y) => x - y); return a[a.length >> 1]; };

interface Row { name: string; ms: number; tris: number; meshes: number; reps: number }
const rows: Row[] = [];

/** 计时并记录一行（先跑一次热身，再取中位数） */
function bench(name: string, doc: Doc, reps = 5, prep?: () => void): number {
  let tris = 0, meshes = 0;
  const run = () => {
    if (prep) prep();
    const r = solve(doc);
    tris = 0;
    for (const m of r.meshes.values()) for (const p of Object.values(m.parts)) if (p) tris += p.pos.length / 9;
    meshes = r.meshes.size;
  };
  run();
  const ts: number[] = [];
  for (let i = 0; i < reps; i++) { const t = performance.now(); run(); ts.push(performance.now() - t); }
  const ms = median(ts);
  rows.push({ name, ms, tris, meshes, reps });
  return ms;
}

const cold = () => clearSolveCache();

// ---- 1. 连通赛道：规模翻倍 ----
const corr: Record<number, number> = {};
for (const n of [50, 100, 200, 400]) corr[n] = bench(`corridor ${n} 段（冷解）`, corridor(n), 5, cold);

// ---- 2. 大量独立块 ----
const fld: Record<number, number> = {};
for (const [n, label] of [[10, 100], [20, 400], [40, 1600]] as [number, number][]) {
  fld[label] = bench(`field ${label} 块（冷解）`, field(n), 3, cold);
}

// ---- 3. 单块大面 + 超长外沿 ----
const cmb: Record<string, number> = {};
for (const [rows, len] of [[40, 50], [40, 100]] as [number, number][]) cmb[`${rows}x${len}`] = bench(`comb ${rows} 根 × ${len} 长（冷解）`, comb(rows, len), 3, cold);
// ---- 4. 缓存：同一份文档连着解两次 ----
const warmDoc = corridor(400);
const coldMs = bench('corridor 400 段（冷解，对照）', warmDoc, 5, cold);
solve(warmDoc); // 预热一次，把网格缓存填满
solveStats.hit = solveStats.miss = 0;
const warmMs = bench('corridor 400 段（缓存命中）', warmDoc, 5);
const hits = solveStats.hit, misses = solveStats.miss;

// ---- 5. 拖动：改一块之后重解 ----
const dragDoc = corridor(400);
solve(dragDoc);
const one = dragDoc.elems[7] as Extract<Elem, { kind: 'box' }>;
const dragMs = bench('corridor 400 段（拖动一块后重解）', dragDoc, 5, () => { one.z += 0.01; });

// ---- 汇总 ----
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - [...s].reduce((w, c) => w + (c.charCodeAt(0) > 255 ? 2 : 1), 0)));
console.log('\n' + pad('用例', 34) + pad('耗时', 12) + pad('三角形', 12) + '网格');
for (const r of rows) {
  console.log(pad(r.name, 34) + pad(`${r.ms.toFixed(1)} ms`, 12) + pad(String(r.tris), 12) + r.meshes);
}

// ---- 断言：机器无关的比例 ----
let failed = 0;
const check = (cond: boolean, msg: string) => { if (!cond) { console.error('  ✗ ' + msg); failed++; } };
const ms1 = (v: number) => Number.isFinite(v) ? `${v.toFixed(1)}ms` : 'NaN';

check(warmMs < coldMs * 0.5, `缓存命中应比冷解快一倍以上：冷 ${ms1(coldMs)} / 热 ${ms1(warmMs)}`);
check(misses === 0 && hits > 0, `第二次求解不应重新算网格：hit=${hits} miss=${misses}`);
check(dragMs < coldMs * 0.5, `拖动一块后重解应显著快于整图冷解：拖动 ${ms1(dragMs)} / 冷 ${ms1(coldMs)}`);
check(corr[400] / corr[200] < 4, `段数翻倍，耗时不该超线性增长：200 段 ${ms1(corr[200])} → 400 段 ${ms1(corr[400])}`);
check(fld[1600] / fld[400] < 8, `独立块数 4 倍，耗时不该超线性爆炸：${ms1(fld[400])} → ${ms1(fld[1600])}`);
// 粗的绝对上限：只是防止退化成分钟级
check(corr[400] < 3000, `400 段冷解应在 3s 内，实际 ${ms1(corr[400])}`);
check(fld[1600] < 6000, `1600 块冷解应在 6s 内，实际 ${ms1(fld[1600])}`);
check(cmb['40x100'] < 3000, `梳子形的冷解应在 3s 内，实际 ${ms1(cmb['40x100'])}`);

// ---- 与基线比较（3 倍以内算正常，1.5 倍以内不提） ----
const base: Record<string, number> = fs.existsSync(BASE) ? JSON.parse(fs.readFileSync(BASE, 'utf8')) : {};
const update = env?.env.UPDATE_BENCH === '1';
if (update) {
  fs.mkdirSync(new URL('./bench/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'), { recursive: true });
  fs.writeFileSync(BASE, JSON.stringify(Object.fromEntries(rows.map((r) => [r.name, Math.round(r.ms * 10) / 10])), null, 2) + '\n');
  console.log(`\n基线已刷新：${rows.length} 项`);
} else if (Object.keys(base).length) {
  const slow: string[] = [];
  for (const r of rows) {
    const b = base[r.name];
    if (b === undefined) continue;
    if (r.ms > b * 3) { failed++; slow.push(`  ✗ ${r.name}：基线 ${b}ms → 现在 ${r.ms.toFixed(1)}ms（${(r.ms / b).toFixed(1)}×）`); }
    else if (r.ms > b * 1.5) console.log(`  ⚠ ${r.name}：基线 ${b}ms → 现在 ${r.ms.toFixed(1)}ms（${(r.ms / b).toFixed(1)}×）`);
  }
  if (slow.length) console.log('\n比基线慢 3 倍以上：\n' + slow.join('\n'));
} else {
  console.log('\n还没有基线文件，用 UPDATE_BENCH=1 npm run bench 生成');
}

if (failed) { console.error(`\n${failed} 项失败`); env?.exit(1); }
console.log('\n基准测试通过');
