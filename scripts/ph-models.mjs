// 资产库里没有假机关的几个机关（风扇、生命球、分数球、Dome），用原版的机关文件（3D Entities/PH/*.nmo）补上显示用的模型。
//   原版文件里有的网格直接用（Dome 罩子和影子、风扇转子、生命球的油膜球）；
//   游戏运行时由脚本生成的部分照原版的样子补上：生命球里的银球、分数球的银球核心和绕着转的小球（带红色拖尾）、
//   风扇的鼓风区域（原版碰撞盒 2×2×16 里的白色絮状粒子）。
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
/** 几个同材质的部分合成一个 */
const join1 = (parts) => ({ ...parts[0], pos: parts.flatMap((p) => p.pos), uv: parts.flatMap((p) => p.uv), nrm: parts.flatMap((p) => p.nrm) });
/** 固定种子的随机数（每次生成结果一样） */
let seed = 1;
const rnd = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };

/** 一团烟：三片互相垂直的方片（从哪个方向看都有） */
function puff(cx, cy, cz, s, part) {
  const pos = [], uv = [], nrm = [];
  const quads = [
    [[-s, 0, -s], [s, 0, -s], [s, 0, s], [-s, 0, s], [0, 1, 0]],
    [[0, -s, -s], [0, s, -s], [0, s, s], [0, -s, s], [1, 0, 0]],
    [[-s, -s, 0], [s, -s, 0], [s, s, 0], [-s, s, 0], [0, 0, 1]],
  ];
  const t = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (const q of quads) {
    for (const k of [0, 1, 2, 0, 2, 3]) { pos.push(r5(cx + q[k][0]), r5(cy + q[k][1]), r5(cz + q[k][2])); uv.push(...t[k]); nrm.push(...q[4]); }
  }
  return { ...part, pos, uv, nrm };
}
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
// 风扇：转子（底座是专属路面 Ventilator_*，另外显示）+ 鼓风区域（原版碰撞盒：中心 ±1、原点上方 1.14～17.14）里的白色絮状烟
{
  const d = dump('P_Modul_18');
  seed = 18;
  const smoke = [];
  for (let i = 0; i < 34; i++) {
    const h = rnd();
    // 越往上越散、越淡（小）
    const r = 0.25 + 0.75 * rnd() * (0.5 + h / 2), a = rnd() * Math.PI * 2;
    smoke.push(puff(r * Math.cos(a), r * Math.sin(a), 1.4 + h * 15.5, 0.55 + 0.5 * rnd() * (1 - h * 0.5), {}));
  }
  models.Fake_Modul_18 = merge('Fake_Modul_18', [
    objectPart(d, 'P_Modul_18_Rotor', { name: 'P_Modul_18_Rotor', texture: 'Rail_Environment.bmp' }),
    { ...join1(smoke), name: 'P_Modul_18_Wind', texture: 'Particle_Smoke.bmp', blend: 'add', tint: [0.13, 0.13, 0.14] },
  ]);
}
// 生命球：半透明的油膜球（叠加混合），里面一个银球
{
  const d = dump('P_Extra_Life');
  models.Fake_Extra_Life = merge('Fake_Extra_Life', [
    sphere(0, 0, 0, 0.45, { ...SILVER }),
    objectPart(d, 'P_Extra_Life_Sphere', { name: 'P_Extra_Life_Sphere', texture: 'P_Extra_Life_Oil.bmp', blend: 'add' }),
  ]);
}
// 分数球：小银球核心，周围六个更小的银球（游戏里绕着核心转），每个后面拖着一串渐小的红色粒子
{
  const orbit = (a) => [1.6 * Math.cos(a), 1.6 * Math.sin(a), 0.5 * Math.sin(a * 2)];
  const balls = [sphere(0, 0, 0, 0.35, { ...SILVER })];
  const trail = [];
  for (let k = 0; k < 6; k++) {
    const a = (k / 6) * Math.PI * 2;
    balls.push(sphere(...orbit(a), 0.2, { ...SILVER }, 10, 6));
    for (let i = 1; i <= 9; i++) trail.push(sphere(...orbit(a - i * 0.07), 0.19 * (1 - i / 11), {}, 5, 3));
  }
  models.Fake_Extra_Point = merge('Fake_Extra_Point', [
    join1(balls),
    { ...join1(trail), name: 'P_Extra_Point_Trail', texture: null, color: [1, 0.12, 0.06], blend: 'add' },
  ]);
}
for (const [name, m] of Object.entries(models)) {
  writeFileSync(join(out, `${name}.json`), JSON.stringify(m));
  console.log('ok', name, m.parts.reduce((a, p) => a + p.pos.length / 9, 0), 'tris');
}
