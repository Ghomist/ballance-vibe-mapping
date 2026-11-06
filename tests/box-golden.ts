// box 版求解器的「金标准」：每个内置场景的粗粒度数字（网格数、三角形数、顶面积、外沿数、资产数、各材质三角形数）。
//
// 这里只存数字快照，不存顶点缓冲区——diff 出来能读，退化也明显（三角形少一半、法线换了、外沿丢了）。
// 更新方式：`UPDATE_GOLDEN=1 npm test`，会把新数字写回 tests/box/golden.json（同时打印完整 diff）。
// 不引 @types/node（项目的 tsconfig 没有 node 类型）：用动态 import 换一个最小接口
const fs = (await import('node:fs' as string)) as {
  existsSync(p: string | URL): boolean;
  readFileSync(p: string | URL, enc: 'utf8'): string;
  writeFileSync(p: string | URL, data: string): void;
};
const env = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
import type { MatName } from '../src/geom/floor';
import { SCENES } from '../src/box/scenes';
import { solve } from '../src/box/solve';

type Check = (cond: boolean, msg: string) => void;
type Scenario = (name: string, fn: () => void) => void;

const GOLDEN = new URL('./box/golden.json', import.meta.url);

interface Numbers {
  meshes: number;
  tris: number;
  topArea: number | string;
  loops: number;
  assets: number;
  mats: Record<string, number>;
}
type Golden = Record<string, Numbers>;

const r3 = (v: number) => +v.toFixed(3);

function measure(doc: ReturnType<(typeof SCENES)[number]['build']>): Numbers {
  const solved = solve(doc);
  let tris = 0;
  let topArea = 0;
  const mats: Record<string, number> = {};
  for (const mesh of solved.meshes.values()) {
    for (const mat of Object.keys(mesh.parts) as MatName[]) {
      const p = mesh.parts[mat]!;
      const n = p.pos.length / 9;
      tris += n;
      mats[mat] = (mats[mat] ?? 0) + n;
      if (!mat.startsWith('FloorTop') && !mat.startsWith('LightingFloorTop')) continue;
      for (let i = 0; i < n; i++) {
        const o = i * 9;
        const ax = p.pos[o], ay = p.pos[o + 1];
        const bx = p.pos[o + 3], by = p.pos[o + 4];
        const cx = p.pos[o + 6], cy = p.pos[o + 7];
        topArea += Math.abs((bx - ax) * (cy - ay) - (by - ay) * (cx - ax)) / 2;
      }
    }
  }
  let assets = 0;
  for (const list of solved.assets.values()) assets += list.length;
  return { meshes: solved.meshes.size, tris, topArea: r3(topArea), loops: solved.loops.length, assets, mats };
}

/** 逐项比较两次快照，返回人类可读的差异行 */
function diff(was: Numbers, now: Numbers): string[] {
  const out: string[] = [];
  for (const key of ['meshes', 'tris', 'topArea', 'loops', 'assets'] as const) {
    if (was[key] !== now[key]) out.push(`${key} ${was[key]} → ${now[key]}`);
  }
  for (const mat of [...new Set([...Object.keys(was.mats), ...Object.keys(now.mats)])].sort()) {
    const a = was.mats[mat] ?? 0, b = now.mats[mat] ?? 0;
    if (a !== b) out.push(`${mat} ${a} → ${b}`);
  }
  return out;
}

export function boxGoldenScenarios(check: Check, scenario: Scenario) {
  scenario('box 求解：金标准数字（tests/box/golden.json）', () => {
    const now: Golden = {};
    for (const { name, build } of SCENES) now[name] = measure(build());

    const update = !!env.UPDATE_GOLDEN;
    const was: Golden | null = fs.existsSync(GOLDEN) ? (JSON.parse(fs.readFileSync(GOLDEN, 'utf8')) as Golden) : null;
    if (!was) {
      fs.writeFileSync(GOLDEN, JSON.stringify(now, null, 2) + '\n');
      check(true, 'golden.json 不存在，已按当前结果生成');
      return;
    }

    const lines: string[] = [];
    for (const name of [...new Set([...Object.keys(was), ...Object.keys(now)])]) {
      if (!was[name]) { lines.push(`${name}: 新增场景`); continue; }
      if (!now[name]) { lines.push(`${name}: 场景不见了`); continue; }
      for (const d of diff(was[name], now[name])) lines.push(`${name}: ${d}`);
    }

    if (update && lines.length) {
      fs.writeFileSync(GOLDEN, JSON.stringify(now, null, 2) + '\n');
      console.log(`  ↻ 已更新 golden.json：\n    ${lines.join('\n    ')}`);
      check(true, '');
      return;
    }
    check(lines.length === 0, `求解结果与金标准不同（${lines.length} 项）：${lines.slice(0, 8).join('；')}${lines.length > 8 ? ' …' : ''}`);
  });
}
