// 三向移动手柄：+X / +Y / +Z 三根箭头（颜色和坐标轴一致），选中东西时显示在它顶面中心。
// 按住一根箭头拖动就沿这根轴移动（拖动逻辑在 app.ts，复用 G 移动的限轴拖动）。
// 箭头画在最上层（不被路面挡住），屏幕上大小固定；每根箭头有一个看不见的粗拾取体，手指也好点中。
import * as THREE from 'three';
import { AXIS_COLORS } from './grid';

const COLORS = [AXIS_COLORS.x, AXIS_COLORS.y, AXIS_COLORS.z];
const DIRS: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export class MoveGizmo {
  group = new THREE.Group();
  private arrows: { mats: THREE.MeshBasicMaterial[]; pick: THREE.Mesh }[] = [];
  private hot: 0 | 1 | 2 | null = null;

  /** 箭头长 1（拾取体比箭头粗、比箭头长一点）；实际大小由 place 的 scale 决定 */
  constructor() {
    const shaftGeo = new THREE.CylinderGeometry(0.022, 0.022, 0.72, 8).translate(0, 0.36 + 0.06, 0);
    const headGeo = new THREE.ConeGeometry(0.075, 0.24, 16).translate(0, 0.78 + 0.06, 0);
    const pickGeo = new THREE.CylinderGeometry(0.13, 0.13, 1.0, 8).translate(0, 0.56, 0);
    const pickMat = new THREE.MeshBasicMaterial({ visible: false });
    DIRS.forEach((d, axis) => {
      const mats = [0, 1].map(() => new THREE.MeshBasicMaterial({ color: COLORS[axis], transparent: true, opacity: 0.85, depthTest: false, depthWrite: false }));
      const g = new THREE.Group();
      const shaft = new THREE.Mesh(shaftGeo, mats[0]);
      const head = new THREE.Mesh(headGeo, mats[1]);
      const pick = new THREE.Mesh(pickGeo, pickMat);
      shaft.renderOrder = head.renderOrder = 50;
      pick.userData.axis = axis;
      g.add(shaft, head, pick);
      g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...d));
      this.group.add(g);
      this.arrows.push({ mats, pick });
    });
    // 中心的小球：看得出手柄的原点
    const dot = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, depthWrite: false }));
    dot.renderOrder = 51;
    this.group.add(dot);
    this.group.visible = false;
  }

  /** 放在 pos，箭头长 scale（世界单位）；pickScale：拾取体加粗的倍数（手指点要粗一些） */
  place(pos: THREE.Vector3, scale: number, pickScale = 1) {
    this.group.position.copy(pos);
    this.group.scale.setScalar(scale);
    for (const a of this.arrows) a.pick.scale.set(pickScale, 1, pickScale);
  }

  /** 高亮一根箭头（悬停或正在拖），别的变淡 */
  /** 三根轴的颜色（换坐标系时 Y、Z 对调） */
  setColors(cs: number[]) { this.arrows.forEach((a, i) => { for (const m of a.mats) m.color.set(cs[i]); }); }

  setHot(axis: 0 | 1 | 2 | null) {
    if (axis === this.hot) return false;
    this.hot = axis;
    this.arrows.forEach((a, i) => { for (const m of a.mats) m.opacity = axis === null ? 0.85 : axis === i ? 1 : 0.35; });
    return true;
  }

  /** 射线碰到哪根箭头（拾取体），没碰到返回 null */
  hit(ray: THREE.Raycaster): 0 | 1 | 2 | null {
    if (!this.group.visible) return null;
    this.group.updateMatrixWorld(true);
    const hits = ray.intersectObjects(this.arrows.map((a) => a.pick), false);
    return hits.length ? (hits[0].object.userData.axis as 0 | 1 | 2) : null;
  }
}

/**
 * 旋转手柄：绕 X / Y / Z 的三个圆环（颜色和坐标轴一致），放在选中整体的中心。
 * 按住一个圆环拖动就绕那根轴转（拖动逻辑在 app.ts，复用 R 旋转）。只能绕竖直轴转的东西（护栏、盘点）只显示 Z 环。
 * 拾取按屏幕距离：鼠标离圆环投影到屏幕上的线足够近就算按到。
 */
export class RotateGizmo {
  group = new THREE.Group();
  private rings: { mesh: THREE.Mesh; mat: THREE.MeshBasicMaterial }[] = [];
  private hot: 0 | 1 | 2 | null = null;
  private shown: [boolean, boolean, boolean] = [true, true, true];
  /** 圆环上的采样点（本地坐标，半径 1），算屏幕距离用 */
  private samples: THREE.Vector3[][] = [];

  constructor() {
    const geo = new THREE.TorusGeometry(1, 0.018, 6, 72);
    for (const axis of [0, 1, 2] as const) {
      const mat = new THREE.MeshBasicMaterial({ color: COLORS[axis], transparent: true, opacity: 0.8, depthTest: false, depthWrite: false });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.renderOrder = 50;
      // 圆环默认在 XY 平面（绕 Z）；绕 X 的转到 YZ 平面，绕 Y 的转到 XZ 平面
      if (axis === 0) mesh.rotation.y = Math.PI / 2;
      if (axis === 1) mesh.rotation.x = Math.PI / 2;
      this.group.add(mesh);
      this.rings.push({ mesh, mat });
      this.samples.push(Array.from({ length: 48 }, (_, i) => {
        const t = (i / 48) * Math.PI * 2, c = Math.cos(t), s = Math.sin(t);
        return axis === 0 ? new THREE.Vector3(0, c, s) : axis === 1 ? new THREE.Vector3(c, 0, s) : new THREE.Vector3(c, s, 0);
      }));
    }
    this.group.visible = false;
  }

  /** 放在 pos，半径 scale（世界单位）；axes：哪几个环显示 */
  place(pos: THREE.Vector3, scale: number, axes: [boolean, boolean, boolean]) {
    this.group.position.copy(pos);
    this.group.scale.setScalar(scale);
    this.shown = axes;
    this.rings.forEach((r, i) => { r.mesh.visible = axes[i]; });
  }

  /** 三个圆环的颜色（换坐标系时 Y、Z 对调） */
  setColors(cs: number[]) { this.rings.forEach((r, i) => r.mat.color.set(cs[i])); }

  setHot(axis: 0 | 1 | 2 | null) {
    if (axis === this.hot) return false;
    this.hot = axis;
    this.rings.forEach((r, i) => { r.mat.opacity = axis === null ? 0.8 : axis === i ? 1 : 0.3; });
    return true;
  }

  /** 屏幕点 (x, y) 离哪个圆环最近（tol 像素以内）；project：世界坐标 → 屏幕坐标 */
  hit(x: number, y: number, tol: number, project: (p: THREE.Vector3) => { x: number; y: number }): 0 | 1 | 2 | null {
    if (!this.group.visible) return null;
    const o = this.group.position, k = this.group.scale.x;
    let best: 0 | 1 | 2 | null = null, bd = tol;
    this.samples.forEach((pts, axis) => {
      if (!this.shown[axis]) return;
      const sp = pts.map((p) => project(p.clone().multiplyScalar(k).add(o)));
      for (let i = 0; i < sp.length; i++) {
        const a = sp[i], b = sp[(i + 1) % sp.length];
        const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / l2));
        const d = Math.hypot(a.x + dx * t - x, a.y + dy * t - y);
        if (d < bd) { bd = d; best = axis as 0 | 1 | 2; }
      }
    });
    return best;
  }
}
