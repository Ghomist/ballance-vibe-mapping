// 命令行导出：npm run export -- map.bvm [--nmo out.nmo] [--blend out.blend] [--json out.json] [--blender]
// 不给输出参数时默认导出同名 .nmo。.nmo 默认用内置的写入器生成（与网页端相同，不需要 Blender），
// 加 --blender 则改用 Blender + BBP 生成；.blend 总是需要 Blender。
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportScene } from '../src/export/scene';
import { exportNmo } from '../src/export/nmo-scene';
import type { NmoLib } from '../src/export/nmo-lib';
import { migrateModel } from '../src/model/types';
// @ts-expect-error 纯 JS 模块
import { buildScene, ROOT } from './blender.mjs';

const args = process.argv.slice(2);
const opt = (k: string) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const input = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
if (!input) { console.error('用法：npm run export -- map.bvm [--nmo out.nmo] [--blend out.blend] [--json out.json]'); process.exit(1); }

const raw = JSON.parse(readFileSync(input, 'utf8'));
const model = migrateModel(raw.format === 'bvm' ? raw.model : raw);
const desc = exportScene(model);
for (const w of desc.warnings) console.warn('警告：' + w);
const json = opt('json') ?? join(mkdtempSync(join(tmpdir(), 'bvm-')), 'scene.json');
writeFileSync(json, JSON.stringify(desc));
let nmo = opt('nmo');
const blend = opt('blend');
if (!nmo && !blend && !opt('json')) nmo = input.replace(/\.(bvm|json)$/i, '') + '.nmo';
if (nmo && !args.includes('--blender')) {
  const lib: NmoLib = JSON.parse(readFileSync(join(ROOT, 'public/nmo-lib.json'), 'utf8'));
  writeFileSync(nmo, (await exportNmo(model, lib)).data);
  console.log(`完成：${nmo}`);
  nmo = undefined;
}
if (nmo || blend) {
  try {
    await buildScene(json, { nmo, blend });
    console.log(`完成：${[nmo, blend].filter(Boolean).join('、')}`);
  } catch (e) {
    console.error((e as { log?: string }).log ?? e);
    process.exit(1);
  }
} else if (opt('json')) console.log(`场景描述：${json}`);
