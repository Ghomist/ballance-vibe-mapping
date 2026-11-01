// 资产库里没有假机关的几个机关（风扇、生命球、分数球、Dome），用原版的机关文件（3D Entities/PH/*.nmo）补上显示用的模型。
//   原版文件里有的网格直接用（Dome 罩子和影子、风扇转子、生命球的油膜球）；
//   其余是示意模型，按占位符的大小表现出大概的范围：生命球、分数球中间的银球，分数球外面的三道环，
//   风扇的鼓风区域（半透明的风柱和几道环）。
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

/** 圆环（圆心 c，法线沿 axis：0=X 1=Y 2=Z，大半径 R、管半径 r） */
function torus(c, axis, R, r, part, seg = 40, tube = 6) {
  const pos = [], uv = [], nrm = [];
  const map = (v) => (axis === 2 ? v : axis === 1 ? [v[0], v[2], v[1]] : [v[2], v[1], v[0]]);
  const pt = (i, j) => {
    const a = (i / seg) * Math.PI * 2, b = (j / tube) * Math.PI * 2;
    const n = map([Math.cos(a) * Math.cos(b), Math.sin(a) * Math.cos(b), Math.sin(b)]);
    const p = map([(R + r * Math.cos(b)) * Math.cos(a), (R + r * Math.cos(b)) * Math.sin(a), r * Math.sin(b)]);
    return { p: [c[0] + p[0], c[1] + p[1], c[2] + p[2]], n, t: [i / seg, j / tube] };
  };
  const push = (...vs) => { for (const v of vs) { pos.push(...v.p.map(r5)); nrm.push(...v.n.map(r5)); uv.push(...v.t.map(r5)); } };
  for (let i = 0; i < seg; i++) for (let j = 0; j < tube; j++) {
    const a = pt(i, j), b = pt(i + 1, j), e = pt(i + 1, j + 1), d = pt(i, j + 1);
    push(a, b, e, a, e, d);
  }
  return { ...part, pos, uv, nrm };
}

/** 竖直的圆筒侧面（不封口） */
function tube(r, z0, z1, part, seg = 32) {
  const pos = [], uv = [], nrm = [];
  for (let i = 0; i < seg; i++) {
    const a0 = (i / seg) * Math.PI * 2, a1 = ((i + 1) / seg) * Math.PI * 2;
    const v = (a, z) => [r5(r * Math.cos(a)), r5(r * Math.sin(a)), z];
    const n = (a) => [r5(Math.cos(a)), r5(Math.sin(a)), 0];
    for (const [a, z, u] of [[a0, z0, 0], [a1, z0, 1], [a1, z1, 1], [a0, z0, 0], [a1, z1, 1], [a0, z1, 0]]) {
      pos.push(...v(a, z)); nrm.push(...n(a)); uv.push(u, z === z0 ? 0 : 1);
    }
  }
  return { ...part, pos, uv, nrm };
}

/** 银球：不上贴图，银灰色 */
const SILVER = { name: 'Silver', texture: null, color: [0.8, 0.82, 0.86] };

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
// 风扇：转子（底座是专属路面 Ventilator_*，另外显示）+ 鼓风区域示意：半透明风柱（到占位符顶部 16.7）和几道环
{
  const d = dump('P_Modul_18');
  const rings = [];
  for (const z of [1.5, 5, 8.5, 12, 15.5]) rings.push(torus([0, 0, z], 2, 1.7, 0.05, {}, 32, 4));
  models.Fake_Modul_18 = merge('Fake_Modul_18', [
    objectPart(d, 'P_Modul_18_Rotor', { name: 'P_Modul_18_Rotor', texture: 'Rail_Environment.bmp' }),
    tube(1.7, 0.6, 16.7, { name: 'P_Modul_18_Wind', texture: null, color: [0.78, 0.9, 1], opacity: 0.13 }),
    { ...join1(rings), name: 'P_Modul_18_WindRing', texture: null, color: [0.85, 0.95, 1], opacity: 0.55 },
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
// 分数球：银球核心，外面三道互相垂直的环和一层很淡的外壳（大致是占位符的范围）
{
  models.Fake_Extra_Point = merge('Fake_Extra_Point', [
    sphere(0, 0, 0, 0.4, { ...SILVER }),
    { ...join1([torus([0, 0, 0], 2, 1.9, 0.07, {}, 32, 5), torus([0, 0, 0], 0, 1.9, 0.07, {}, 32, 5), torus([0, 0, 0], 1, 1.9, 0.07, {}, 32, 5)]), name: 'P_Extra_Point_Ring', texture: null, color: [1, 0.32, 0.3] },
    sphere(0, 0, 0, 2.2, { name: 'P_Extra_Point_Shell', texture: null, color: [1, 0.32, 0.3], opacity: 0.1 }, 24, 14),
  ]);
}
for (const [name, m] of Object.entries(models)) {
  writeFileSync(join(out, `${name}.json`), JSON.stringify(m));
  console.log('ok', name, m.parts.reduce((a, p) => a + p.pos.length / 9, 0), 'tris');
}
