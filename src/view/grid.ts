// 场景网格：小格 5，坐标轴颜色与 Blender 一致，轴旁标注坐标。
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

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
    g.add(label(String(v), v, -0.8, AXIS_COLORS.x));
    g.add(label(String(v), 0.8, v, AXIS_COLORS.y));
  }
  g.add(label('0', 0.8, -0.8, 0x9aa4b8));
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

function label(text: string, x: number, y: number, color: number) {
  const el = document.createElement('div');
  el.className = 'axis-label';
  el.textContent = text;
  el.style.color = `#${new THREE.Color(color).getHexString()}`;
  const o = new CSS2DObject(el);
  o.position.set(x, y, 0);
  return o;
}
