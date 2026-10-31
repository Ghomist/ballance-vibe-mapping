// 六向移动手柄：±X / ±Y / ±Z 箭头，颜色与 Blender 坐标轴一致；不可用的方向变暗且不可拾取。
import * as THREE from 'three';
import { AXIS_COLORS } from './grid';

export interface GizmoHandle { axis: 0 | 1 | 2; sign: 1 | -1 }

const COLORS = [AXIS_COLORS.x, AXIS_COLORS.y, AXIS_COLORS.z];
const DIRS: [number, number, number][] = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

export class Gizmo {
  group = new THREE.Group();
  private arrows: { mesh: THREE.Group; pick: THREE.Mesh; mats: THREE.MeshBasicMaterial[]; h: GizmoHandle }[] = [];
  private opacity = 0;
  private target = 0;
  private hovered: GizmoHandle | null = null;

  constructor() {
    const shaftGeo = new THREE.CylinderGeometry(0.09, 0.09, 3, 8).translate(0, 2.3, 0);
    const headGeo = new THREE.ConeGeometry(0.42, 1.1, 16).translate(0, 4.3, 0);
    const pickGeo = new THREE.CylinderGeometry(0.7, 0.7, 4.4, 8).translate(0, 2.7, 0);
    const pickMat = new THREE.MeshBasicMaterial({ visible: false });
    for (const axis of [0, 1, 2] as const) {
      for (const sign of [1, -1] as const) {
        const mats = [0, 1].map(() => new THREE.MeshBasicMaterial({ color: COLORS[axis], transparent: true, depthTest: false, depthWrite: false }));
        const g = new THREE.Group();
        const shaft = new THREE.Mesh(shaftGeo, mats[0]);
        const head = new THREE.Mesh(headGeo, mats[1]);
        const pick = new THREE.Mesh(pickGeo, pickMat);
        shaft.renderOrder = head.renderOrder = 40;
        g.add(shaft, head, pick);
        // 默认朝 +Y，旋转到目标方向
        const d = new THREE.Vector3(...DIRS[axis]).multiplyScalar(sign);
        g.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d);
        pick.userData = { gizmo: { axis, sign } };
        this.group.add(g);
        this.arrows.push({ mesh: g, pick, mats, h: { axis, sign } });
      }
    }
    this.group.visible = false;
  }

  /** 显示在 pos 处；valid[axis*2 + (sign>0?0:1)] 表示该方向是否可用 */
  show(pos: THREE.Vector3, valid: boolean[]) {
    this.group.position.copy(pos);
    this.arrows.forEach((a, i) => { a.pick.visible = valid[i]; a.mesh.userData.valid = valid[i]; });
    this.target = 1;
  }

  hide() { this.target = 0; }

  get active() { return this.target > 0; }

  setHovered(h: GizmoHandle | null) { this.hovered = h; }

  pickables(): THREE.Object3D[] {
    return this.target > 0 ? this.arrows.filter((a) => a.pick.visible).map((a) => a.pick) : [];
  }

  tick(dt: number, camera: THREE.Camera) {
    this.opacity += (this.target - this.opacity) * (1 - Math.exp(-dt / 0.06));
    this.group.visible = this.opacity > 0.01;
    // 屏幕上保持大致固定大小
    const dist = camera.position.distanceTo(this.group.position);
    this.group.scale.setScalar(THREE.MathUtils.clamp(dist / 55, 0.35, 4));
    for (const a of this.arrows) {
      const hot = this.hovered && this.hovered.axis === a.h.axis && this.hovered.sign === a.h.sign;
      const base = a.mesh.userData.valid ? (hot ? 1 : 0.75) : 0.12;
      for (const m of a.mats) m.opacity = base * this.opacity;
    }
  }
}
