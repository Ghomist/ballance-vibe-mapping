// 场景网格：小格 5，坐标轴颜色与 Blender 一致，轴旁标注坐标。
import * as THREE from 'three';
import { CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

const EXTENT = 300;
const MINOR = 5;
const MAJOR = 50;
const LABEL_STEP = 25;

export const AXIS_COLORS = { x: 0xff3352, y: 0x8bdc00, z: 0x2890ff };

export function createGrid(): THREE.Group {
  const g = new THREE.Group();
  const minor: number[] = [];
  const major: number[] = [];
  for (let v = -EXTENT; v <= EXTENT; v += MINOR) {
    if (v === 0) continue;
    const arr = v % MAJOR === 0 ? major : minor;
    arr.push(v, -EXTENT, 0, v, EXTENT, 0, -EXTENT, v, 0, EXTENT, v, 0);
  }
  g.add(lineSegs(minor, 0x283040, 1));
  g.add(lineSegs(major, 0x343e54, 1));
  g.add(lineSegs([-EXTENT, 0, 0, EXTENT, 0, 0], AXIS_COLORS.x, 0.85));
  g.add(lineSegs([0, -EXTENT, 0, 0, EXTENT, 0], AXIS_COLORS.y, 0.85));
  g.add(lineSegs([0, 0, -60, 0, 0, 60], AXIS_COLORS.z, 0.5));

  for (let v = -EXTENT + LABEL_STEP; v < EXTENT; v += LABEL_STEP) {
    if (v === 0) continue;
    g.add(label(String(v), v, -0.8, AXIS_COLORS.x));
    g.add(label(String(v), 0.8, v, AXIS_COLORS.y));
  }
  g.add(label('0', 0.8, -0.8, 0x9aa4b8));
  // 网格就在 z = 0：先于路面绘制、不写深度，路面画上去时直接盖住它（包括 0.7 深的凹槽里），不会穿出来
  return g;
}

const BG = new THREE.Color(0x1d2330); // 与场景背景色一致

function lineSegs(pts: number[], color: number, opacity: number) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  // 不透明（与背景色预先混合），这样和路面一起在不透明阶段、按 renderOrder 先画
  const c = new THREE.Color(color).lerp(BG, 1 - opacity);
  const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color: c, depthWrite: false, depthTest: false }));
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
