// 资产库里没有假机关的几个机关（风扇、生命球、分数球、Dome），用原版的机关文件（3D Entities/PH/*.nmo）补上显示用的模型。
//   原版文件里有的网格直接用（Dome 罩子和影子、风扇转子、生命球的油膜球）；
//   游戏运行时由脚本生成的部分照原版的样子补上：生命球里的银球、分数球的银球核心和绕着转的小球。
// 输出与 dump-blend-assets.py 相同格式的 public/fakes/Fake_*.json（Blender 坐标系）。
// 用法：node scripts/ph-models.mjs（npm run assets 会调用）；需要 Blender + BBP 和 Ballance 安装目录。
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findBlender } from './blender.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const PH = process.env.BALLANCE_PH ?? 'D:/Ballance/3D Entities/PH';
const out = join(root, 'public', 'fakes');
const r5 = (v) => Math.round(v * 1e5) / 1e5;

/** 用 BMap 读原版机关文件 */
function dump(name) {
  const dir = mkdtempSync(join(tmpdir(), 'bvm-ph-'));
  try {
    const json = join(dir, `${name}.json`);
    execFileSync(findBlender(), ['-b', '--python', join(root, 'scripts/blender/dump_nmo.py'), '--', join(PH, `${name}.nmo`), json], { stdio: 'ignore' });
    return JSON.parse(readFileSync(json, 'utf8'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

/**
 * 原版物体（Virtools 坐标系：Y 向上，行向量 × 世界矩阵）→ Blender 坐标系的三角形：
 * 交换 Y/Z（左右手互换，三角形绕序反转），V 取反
 */
function objectPart(d, objName, part) {
  const o = d.objects.find((x) => x.name === objName);
  const m = d.meshes.find((x) => x.name === o.mesh);
  const M = o.matrix;
  const xf = (x, y, z, w) => [0, 1, 2].map((c) => x * M[c] + y * M[4 + c] + z * M[8 + c] + w * M[12 + c]);
  const pos = [], uv = [], nrm = [];
  for (let f = 0; f < m.faces.length; f += 3) {
    for (const k of [2, 1, 0]) {
      const i = m.faces[f + k];
      const p = xf(m.pos[i * 3], m.pos[i * 3 + 1], m.pos[i * 3 + 2], 1);
      const n = xf(m.nml[i * 3], m.nml[i * 3 + 1], m.nml[i * 3 + 2], 0);
      const l = Math.hypot(...n) || 1;
      pos.push(r5(p[0]), r5(p[2]), r5(p[1]));
      nrm.push(r5(n[0] / l), r5(n[2] / l), r5(n[1] / l));
      uv.push(r5(m.uv[i * 2]), r5(-m.uv[i * 2 + 1]));
    }
  }
  return { ...part, pos, uv, nrm };
}

/** 球（经纬线三角形，球面 UV） */
function sphere(cx, cy, cz, r, part, seg = 16, ring = 10) {
  const pos = [], uv = [], nrm = [];
  const pt = (i, j) => {
    const th = (i / seg) * Math.PI * 2, ph = (j / ring) * Math.PI;
    const n = [Math.sin(ph) * Math.cos(th), Math.sin(ph) * Math.sin(th), Math.cos(ph)];
    return { p: [cx + r * n[0], cy + r * n[1], cz + r * n[2]], n, t: [i / seg, 1 - j / ring] };
  };
  const push = (...vs) => { for (const v of vs) { pos.push(...v.p.map(r5)); nrm.push(...v.n.map(r5)); uv.push(...v.t.map(r5)); } };
  for (let j = 0; j < ring; j++) {
    for (let i = 0; i < seg; i++) {
      const a = pt(i, j), b = pt(i + 1, j), c = pt(i + 1, j + 1), e = pt(i, j + 1);
      if (j > 0) push(a, e, b);
      if (j < ring - 1) push(b, e, c);
    }
  }
  return { ...part, pos, uv, nrm };
}

const merge = (name, parts) => ({ name, parts, groups: [] });
const SILVER = { name: 'ExtraBall', texture: 'ExtraBall.bmp' };

if (!existsSync(PH)) { console.warn(`跳过原版机关模型：找不到 ${PH}`); process.exit(0); }
mkdirSync(out, { recursive: true });
const models = {};

// Dome：罩子 + 地上的影子
{
  const d = dump('P_Dome');
  models.Fake_Dome = merge('Fake_Dome', [
    objectPart(d, 'P_Dome_MF', { name: 'P_Dome', texture: 'Dome.bmp' }),
    objectPart(d, 'P_Dome_Shadow', { name: 'P_DomeShadow', texture: 'DomeShadow.tga', alphaBlend: true }),
  ]);
}
// 风扇：转子（底座是专属路面 Ventilator_*，另外显示）
{
  const d = dump('P_Modul_18');
  models.Fake_Modul_18 = merge('Fake_Modul_18', [objectPart(d, 'P_Modul_18_Rotor', { name: 'P_Modul_18_Rotor', texture: 'Rail_Environment.bmp' })]);
}
// 生命球：半透明的油膜球（叠加混合），里面一个银球
{
  const d = dump('P_Extra_Life');
  models.Fake_Extra_Life = merge('Fake_Extra_Life', [
    sphere(0, 0, 0, 0.9, { ...SILVER }),
    objectPart(d, 'P_Extra_Life_Sphere', { name: 'P_Extra_Life_Sphere', texture: 'P_Extra_Life_Oil.bmp', blend: 'add' }),
  ]);
}
// 分数球：银球核心，周围六个小银球（游戏里绕着核心转）
{
  const parts = [sphere(0, 0, 0, 0.7, { ...SILVER })];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    parts.push(sphere(1.6 * Math.cos(a), 1.6 * Math.sin(a), 0.5 * Math.sin(a * 2), 0.32, { ...SILVER }, 10, 6));
  }
  models.Fake_Extra_Point = merge('Fake_Extra_Point', [{ ...SILVER, pos: parts.flatMap((p) => p.pos), uv: parts.flatMap((p) => p.uv), nrm: parts.flatMap((p) => p.nrm) }]);
}
for (const [name, m] of Object.entries(models)) {
  writeFileSync(join(out, `${name}.json`), JSON.stringify(m));
  console.log('ok', name, m.parts.reduce((a, p) => a + p.pos.length / 9, 0), 'tris');
}
