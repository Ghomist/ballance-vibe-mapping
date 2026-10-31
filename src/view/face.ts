// 操作示意：要拉出 / 推进的那个截面画成半透明的面，并向原路面内部延伸 1 个单位逐渐变淡，营造立体感。
import * as THREE from 'three';
import { DX, DY, Dir, THICK } from '../model/types';

export interface FaceSpec {
  /** 面的中心（水平位置在面上，z 为顶面高度） */
  x: number;
  y: number;
  z: number;
  /** 朝外方向 */
  dir: Dir;
  /** 面宽（沿面横向） */
  w: number;
  /** 面高，默认为路面厚度 */
  h?: number;
  /** 箭头：朝外（默认）或上下双向（调高度） */
  arrow?: 'out' | 'updown';
}

const SLEEVE = 1;
const ALPHA = 0.32;

export class FaceFx {
  readonly group = new THREE.Group();
  private mesh: THREE.Mesh;
  private mat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide, opacity: 0 });
  private key = '';
  private target = 0;

  constructor() {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.renderOrder = 5;
    this.group.add(this.mesh);
    this.group.visible = false;
  }

  set(f: FaceSpec | null, color: number) {
    if (!f) { this.target = 0; return; }
    const key = JSON.stringify([f, color]);
    this.target = 1;
    this.group.visible = true;
    if (key === this.key) return;
    // 换了一个面：从淡出状态重新淡入
    if (this.key && this.key.split('"dir"')[0] !== key.split('"dir"')[0]) this.mat.opacity = Math.min(this.mat.opacity, 0.35);
    this.key = key;
    const g = this.mesh.geometry;
    g.dispose();
    this.mesh.geometry = buildFace(f, new THREE.Color(color));
  }

  tick(dt: number) {
    const k = 1 - Math.exp(-dt / 0.06);
    this.mat.opacity += (this.target - this.mat.opacity) * k;
    if (this.target === 0 && this.mat.opacity < 0.01) { this.group.visible = false; this.key = ''; }
  }
}

function buildFace(f: FaceSpec, c: THREE.Color): THREE.BufferGeometry {
  const h = f.h ?? THICK;
  const ox = DX[f.dir], oy = DY[f.dir];
  const px = -oy, py = ox;
  const hw = f.w / 2;
  // 面的四个角（略微往外偏一点，避免与路面侧面打架）
  const e = 0.03;
  const corner = (s: number, top: boolean, back: number): number[] =>
    [f.x + px * hw * s + ox * (e - back), f.y + py * hw * s + oy * (e - back), top ? f.z + e : f.z - h - e];
  const pos: number[] = [], col: number[] = [];
  const quad = (a: number[], b: number[], cc: number[], d: number[], aa: number[]) => {
    for (const [p, al] of [[a, aa[0]], [b, aa[1]], [cc, aa[2]], [a, aa[0]], [cc, aa[2]], [d, aa[3]]] as [number[], number][]) {
      pos.push(...p);
      col.push(c.r, c.g, c.b, al);
    }
  };
  // 截面本身
  quad(corner(-1, true, 0), corner(1, true, 0), corner(1, false, 0), corner(-1, false, 0), [ALPHA, ALPHA, ALPHA, ALPHA]);
  // 往原路面内延伸的四条渐隐带：顶、底、左、右
  const S = SLEEVE;
  quad(corner(-1, true, 0), corner(1, true, 0), corner(1, true, S), corner(-1, true, S), [ALPHA, ALPHA, 0, 0]);
  quad(corner(-1, false, 0), corner(1, false, 0), corner(1, false, S), corner(-1, false, S), [ALPHA, ALPHA, 0, 0]);
  quad(corner(-1, true, 0), corner(-1, false, 0), corner(-1, false, S), corner(-1, true, S), [ALPHA, ALPHA, 0, 0]);
  quad(corner(1, true, 0), corner(1, false, 0), corner(1, false, S), corner(1, true, S), [ALPHA, ALPHA, 0, 0]);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 4));
  return g;
}

/** 截面的轮廓 + 从面中心伸出的箭头（相对面中心 (x,y,z)） */
export function faceSegs(f: FaceSpec): number[] {
  const h = f.h ?? THICK;
  const ox = DX[f.dir], oy = DY[f.dir];
  const px = -oy, py = ox;
  const hw = f.w / 2;
  const P = (s: number, z: number) => [px * hw * s, py * hw * s, z];
  const out = [...P(-1, 0), ...P(1, 0), ...P(1, 0), ...P(1, -h), ...P(1, -h), ...P(-1, -h), ...P(-1, -h), ...P(-1, 0)];
  if (f.arrow === 'updown') {
    // 上下双向箭头，立在截面中心上方
    const t = 4.5, b = -h - 1.5;
    out.push(0, 0, b, 0, 0, t);
    for (const [z, s] of [[t, -1], [b, 1]] as [number, number][]) {
      out.push(0, 0, z, px * 0.8, py * 0.8, z + s * 1.1, 0, 0, z, -px * 0.8, -py * 0.8, z + s * 1.1);
    }
    return out;
  }
  // 箭头：从面中心朝外
  const zc = -h / 2, L = 3.5;
  const tx = ox * L, ty = oy * L;
  out.push(0, 0, zc, tx, ty, zc);
  out.push(tx, ty, zc, tx - ox * 1.1 + px * 0.9, ty - oy * 1.1 + py * 0.9, zc);
  out.push(tx, ty, zc, tx - ox * 1.1 - px * 0.9, ty - oy * 1.1 - py * 0.9, zc);
  out.push(tx, ty, zc, tx - ox * 1.1, ty - oy * 1.1, zc + 0.9);
  out.push(tx, ty, zc, tx - ox * 1.1, ty - oy * 1.1, zc - 0.9);
  return out;
}
