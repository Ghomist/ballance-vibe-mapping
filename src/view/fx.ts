// 叠加层线框：按 key 管理，透明度与位置都做轻微的缓动；支持按高度渐变的顶点色。
import * as THREE from 'three';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

export interface FxOptions {
  width?: number;
  opacity?: number;
  /** 底部线条变暗，形成自上而下的渐变 */
  gradient?: boolean;
  /** 线框锚点；位置变化时平滑移动过去 */
  pos?: [number, number, number];
  /** 轻微呼吸（用于“可连接”等提示） */
  pulse?: boolean;
  /** 虚线（仅在首次创建该 key 时生效） */
  dashed?: boolean;
}

interface Item {
  obj: LineSegments2;
  mat: LineMaterial;
  opacity: number;
  target: number;
  pos: THREE.Vector3;
  pulse: boolean;
  /** 一次性提示：自动淡出 */
  transient: boolean;
}

const FADE_TAU = 0.06;
const MOVE_TAU = 0.05;

export class Fx {
  group = new THREE.Group();
  private items = new Map<string, Item>();
  private resolution = new THREE.Vector2(1, 1);
  private time = 0;
  private popSeq = 0;

  setResolution(w: number, h: number) {
    this.resolution.set(w, h);
    for (const it of this.items.values()) it.mat.resolution.copy(this.resolution);
  }

  /** 创建或更新一个线框。segs 为线段端点 [x,y,z,x,y,z,...]，相对 opts.pos */
  set(key: string, segs: number[], color: number, opts: FxOptions = {}) {
    if (segs.length === 0) { this.hide(key); return; }
    const colors = vertexColors(segs, color, opts.gradient ?? false);
    let it = this.items.get(key);
    const pos = new THREE.Vector3(...(opts.pos ?? [0, 0, 0]));
    if (!it) {
      const geo = new LineSegmentsGeometry();
      const mat = new LineMaterial({
        vertexColors: true, linewidth: opts.width ?? 1.5, transparent: true, opacity: 0,
        depthTest: false, depthWrite: false,
        dashed: !!opts.dashed, dashSize: 0.45, gapSize: 0.3,
      });
      mat.resolution.copy(this.resolution);
      const obj = new LineSegments2(geo, mat);
      obj.renderOrder = 20;
      obj.position.copy(pos);
      this.group.add(obj);
      it = { obj, mat, opacity: 0, target: 1, pos, pulse: false, transient: false };
      this.items.set(key, it);
    }
    it.obj.geometry.setPositions(segs);
    it.obj.geometry.setColors(colors);
    if (it.mat.dashed) it.obj.computeLineDistances();
    it.mat.linewidth = opts.width ?? 1.5;
    it.target = opts.opacity ?? 1;
    it.pulse = opts.pulse ?? false;
    it.pos.copy(pos);
    it.transient = false;
  }

  hide(key: string) {
    const it = this.items.get(key);
    if (it) it.target = 0;
  }

  has(key: string) { return this.items.has(key) && this.items.get(key)!.target > 0; }

  /** 一闪而过的高亮（例如新生成的路面） */
  pop(segs: number[], color: number) {
    if (!segs.length) return;
    const key = `pop:${this.popSeq++}`;
    this.set(key, segs, color, { width: 2, gradient: true, opacity: 0.9 });
    const it = this.items.get(key)!;
    it.opacity = 0.9;
    it.transient = true;
  }

  tick(dt: number) {
    this.time += dt;
    const kf = 1 - Math.exp(-dt / FADE_TAU);
    const km = 1 - Math.exp(-dt / MOVE_TAU);
    for (const [key, it] of this.items) {
      if (it.transient) it.target = 0;
      const speed = it.transient ? (1 - Math.exp(-dt / 0.25)) : kf;
      it.opacity += (it.target - it.opacity) * speed;
      it.obj.position.lerp(it.pos, km);
      const pulse = it.pulse ? 0.75 + 0.25 * Math.sin(this.time * 6) : 1;
      it.mat.opacity = it.opacity * pulse;
      it.obj.visible = it.opacity > 0.01;
      if (it.target === 0 && it.opacity < 0.01) {
        it.obj.geometry.dispose();
        it.mat.dispose();
        this.group.remove(it.obj);
        this.items.delete(key);
      }
    }
  }
}

function vertexColors(segs: number[], color: number, gradient: boolean): number[] {
  const c = new THREE.Color(color);
  let zmin = Infinity, zmax = -Infinity;
  for (let i = 2; i < segs.length; i += 3) { zmin = Math.min(zmin, segs[i]); zmax = Math.max(zmax, segs[i]); }
  const out: number[] = [];
  for (let i = 0; i < segs.length; i += 3) {
    const f = gradient && zmax - zmin > 1e-6 ? 0.3 + 0.7 * ((segs[i + 2] - zmin) / (zmax - zmin)) : 1;
    out.push(c.r * f, c.g * f, c.b * f);
  }
  return out;
}

/** 矩形线框（水平面内），中心在原点 */
export function rectSegs(hx: number, hy: number, z = 0): number[] {
  const p = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
  const out: number[] = [];
  for (let i = 0; i < 4; i++) {
    const a = p[i], b = p[(i + 1) % 4];
    out.push(a[0], a[1], z, b[0], b[1], z);
  }
  return out;
}
