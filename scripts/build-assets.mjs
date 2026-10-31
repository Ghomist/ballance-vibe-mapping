// 生成编辑器预览所需的素材（均不入库）：
//   public/elements/*.json  机关占位符网格（来自 BBP 的 meshes/*.ph）
//   public/assets/*.json    资产库里的盘点路面、装饰等（用 Blender 从 BallanceAssets.blend 导出）
//   public/textures/*       上述素材用到的贴图（来自 Ballance 安装目录）
// 用法：npm run assets
// 可用环境变量覆盖路径：BLENDER、BBP_DIR、BALLANCE_ASSETS（.blend）、BALLANCE_TEXTURES
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_OBJECTS } from './asset-list.mjs';
import { ASSETS_BLEND, TEXTURES, findBlender } from './blender.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const pub = join(root, 'public');
const appdata = process.env.APPDATA ?? '';

function findBBP() {
  if (process.env.BBP_DIR) return process.env.BBP_DIR;
  const base = join(appdata, 'Blender Foundation', 'Blender');
  if (!existsSync(base)) return null;
  for (const v of readdirSync(base).sort().reverse()) {
    for (const sub of ['extensions/user_default/bbp_ng', 'scripts/addons/bbp_ng']) {
      const p = join(base, v, sub);
      if (existsSync(join(p, 'meshes'))) return p;
    }
  }
  return null;
}

// ---------- 机关占位符 ----------
// .ph：uint32 顶点数 + float3[]，uint32 法线数 + float3[]，uint32 面数 + (pos,nml)×3 的 uint32[]
// 坐标为 Virtools 系（Y 向上），转成 Blender 系（交换 Y/Z，三角形绕序反转）
function convertPh(file) {
  const b = readFileSync(file);
  let o = 0;
  const u32 = () => { const v = b.readUInt32LE(o); o += 4; return v; };
  const f32 = () => { const v = b.readFloatLE(o); o += 4; return v; };
  const vec = () => { const x = f32(), y = f32(), z = f32(); return [x, z, y]; };
  const P = Array.from({ length: u32() }, vec);
  const N = Array.from({ length: u32() }, vec);
  const fc = u32();
  const pos = [], nrm = [];
  const r = (v) => Math.round(v * 1e5) / 1e5;
  for (let i = 0; i < fc; i++) {
    const idx = Array.from({ length: 6 }, u32);
    for (const k of [2, 1, 0]) {
      pos.push(...P[idx[k * 2]].map(r));
      nrm.push(...N[idx[k * 2 + 1]].map(r));
    }
  }
  return { pos, nrm };
}

const bbp = findBBP();
if (bbp) {
  const out = join(pub, 'elements');
  mkdirSync(out, { recursive: true });
  for (const f of readdirSync(join(bbp, 'meshes'))) {
    if (!f.endsWith('.ph')) continue;
    writeFileSync(join(out, f.replace(/\.ph$/, '.json')), JSON.stringify(convertPh(join(bbp, 'meshes', f))));
  }
  console.log(`机关占位符：已从 ${bbp} 转换`);
} else console.warn('跳过机关占位符：找不到 BBP（可设置 BBP_DIR）');

// ---------- 资产库物体 ----------
const blend = ASSETS_BLEND;
const assetsOut = join(pub, 'assets');
if (existsSync(blend)) {
  execFileSync(findBlender(), ['-b', blend, '--python', join(root, 'scripts/dump-blend-assets.py'), '--', assetsOut, ...ASSET_OBJECTS], { stdio: ['ignore', 'inherit', 'inherit'] });
} else console.warn(`跳过资产库：找不到 ${blend}`);

// ---------- 贴图 ----------
const texSrc = TEXTURES;
const texOut = join(pub, 'textures');
mkdirSync(texOut, { recursive: true });
const tex = new Set([
  'Floor_Top_Border.bmp', 'Floor_Top_Borderless.bmp', 'Floor_Top_Flat.bmp',
  'Floor_Top_Profil.bmp', 'Floor_Top_ProfilFlat.bmp', 'Floor_Side.bmp',
  'Floor_Top_Checkpoint.bmp', 'Rail_Environment.bmp', 'E_Holzbeschlag.bmp',
]);
if (existsSync(assetsOut)) {
  for (const f of readdirSync(assetsOut)) {
    for (const p of JSON.parse(readFileSync(join(assetsOut, f), 'utf8')).parts) if (p.texture) tex.add(p.texture);
  }
}
for (const f of tex) {
  const p = join(texSrc, f);
  if (!existsSync(p)) { console.warn(`贴图缺失：${p}`); continue; }
  copyFileSync(p, join(texOut, f));
}
console.log(`贴图：${tex.size} 张`);
