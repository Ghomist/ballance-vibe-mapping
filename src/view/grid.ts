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
  g.position.z = -0.75; // 放在 z=0 路面（含 0.7 深的凹槽）之下，避免穿出路面
  return g;
}

function lineSegs(pts: number[], color: number, opacity: number) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return new THREE.LineSegments(geo, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity }));
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
