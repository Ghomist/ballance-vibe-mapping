// 从 Ballance 安装目录复制预览所需的贴图到 public/textures（不入库）。
// 用法：npm run textures [-- <Textures 目录>]，或设置环境变量 BALLANCE_TEXTURES。
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const src = process.argv[2] ?? process.env.BALLANCE_TEXTURES ?? 'D:/Ballance/Textures';
const dst = new URL('../public/textures/', import.meta.url);
const files = [
  'Floor_Top_Border.bmp', 'Floor_Top_Borderless.bmp', 'Floor_Top_Flat.bmp',
  'Floor_Top_Profil.bmp', 'Floor_Top_ProfilFlat.bmp', 'Floor_Side.bmp',
  'Floor_Top_Checkpoint.bmp', 'Rail_Environment.bmp',
];
mkdirSync(dst, { recursive: true });
for (const f of files) {
  const p = join(src, f);
  if (!existsSync(p)) { console.warn(`跳过：找不到 ${p}`); continue; }
  copyFileSync(p, new URL(f, dst));
  console.log(`已复制 ${f}`);
}
