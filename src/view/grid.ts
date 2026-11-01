// 场景网格：小格 5，坐标轴颜色与 Blender 一致，轴旁标注坐标。
import * as THREE from 'three';

const EXTENT = 300;
const MINOR = 5;
const MAJOR = 50;
const LABEL_STEP = 25;

export const AXIS_COLORS = { x: 0xff3352, y: 0x8bdc00, z: 0x2890ff };

export interface GridTheme { bg: number; minor: number; major: number }
export const GRID_THEMES: Record<'dark' | 'light', GridTheme> = {
  dark: { bg: 0x1d2330, minor: 0x283040, major: 0x343e54 },
  light: { bg: 0xdfe5ee, minor: 0xc9d1dd, major: 0xb2bccb },
};

/** 换主题：线的颜色按背景重新混合（网格线是预先与背景混合好的不透明色） */
export function themeGrid(g: THREE.Group, t: GridTheme) {
  const bg = new THREE.Color(t.bg);
  for (const o of g.children) {
    const u = o.userData as { base?: number | 'minor' | 'major'; opacity?: number };
    if (u.base === undefined) continue;
    const base = u.base === 'minor' ? t.minor : u.base === 'major' ? t.major : u.base;
    ((o as THREE.LineSegments).material as THREE.LineBasicMaterial).color.set(base).lerp(bg, 1 - (u.opacity ?? 1));
  }
}

export function createGrid(): THREE.Group {
  const g = new THREE.Group();
  const minor: number[] = [];
  const major: number[] = [];
  for (let v = -EXTENT; v <= EXTENT; v += MINOR) {
    if (v === 0) continue;
    const arr = v % MAJOR === 0 ? major : minor;
    arr.push(v, -EXTENT, 0, v, EXTENT, 0, -EXTENT, v, 0, EXTENT, v, 0);
  }
  g.add(lineSegs(minor, 'minor', 1));
  g.add(lineSegs(major, 'major', 1));
  g.add(lineSegs([-EXTENT, 0, 0, EXTENT, 0, 0], AXIS_COLORS.x, 0.85));
  g.add(lineSegs([0, -EXTENT, 0, 0, EXTENT, 0], AXIS_COLORS.y, 0.85));
  g.add(lineSegs([0, 0, -60, 0, 0, 60], AXIS_COLORS.z, 0.5));

  for (let v = -EXTENT + LABEL_STEP; v < EXTENT; v += LABEL_STEP) {
    if (v === 0) continue;
    g.add(label(String(v), v, -1.4, AXIS_COLORS.x));
    g.add(label(String(v), 2.2, v, AXIS_COLORS.y));
  }
  g.add(label('0', 1.2, -1.4, 0x9aa4b8));
  themeGrid(g, GRID_THEMES.dark);
  // 网格就在 z = 0：先于路面绘制、不写深度，路面画上去时直接盖住它（包括 0.7 深的凹槽里），不会穿出来
  return g;
}

function lineSegs(pts: number[], color: number | 'minor' | 'major', opacity: number) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  // 不透明（与背景色预先混合，见 themeGrid），这样和路面一起在不透明阶段、按 renderOrder 先画
  const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ depthWrite: false, depthTest: false }));
  line.userData = { base: color, opacity };
  line.renderOrder = -10;
  return line;
}

/** 坐标数字：平躺在 z = 0 的地面上、字面朝正上方（像网格一样先画，被路面盖住） */
function label(text: string, x: number, y: number, color: number) {
  const fontPx = 64;
  const c = document.createElement('canvas');
  const ctx = c.getContext('2d')!;
  ctx.font = `600 ${fontPx}px ui-monospace, Consolas, monospace`;
  const w = Math.ceil(ctx.measureText(text).width) + 8;
  c.width = w; c.height = fontPx + 8;
  ctx.font = `600 ${fontPx}px ui-monospace, Consolas, monospace`;
  ctx.fillStyle = `#${new THREE.Color(color).getHexString()}`;
  ctx.textBaseline = 'middle';
  ctx.fillText(text, 4, c.height / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  const h = 1.6; // 字高（世界单位）
  const geo = new THREE.PlaneGeometry((h * c.width) / c.height, h);
  const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.8, depthWrite: false, depthTest: false }));
  mesh.position.set(x, y, 0);
  mesh.renderOrder = -9;
  return mesh;
}
