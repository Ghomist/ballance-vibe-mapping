// 机关库的预览图：用一个离屏渲染器把占位符 / 机关模型 / 资产模型从斜上方渲染成小图。
import * as THREE from 'three';
import { FAKE_FIX, fakeModel, objType } from '../model/objects';
import { getAsset, texturesReady } from './assets';

const SIZE = 112;
let renderer: THREE.WebGLRenderer | null = null;
const cache = new Map<string, string>();

function getRenderer() {
  if (!renderer) {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true });
    renderer.setSize(SIZE, SIZE);
    renderer.setPixelRatio(1);
  }
  return renderer;
}

/** 预览图的 dataURL；模型还没加载好时返回 null（加载完会触发 setAssetLoadedCallback，届时再取） */
export function thumbnail(type: string, view: 'model' | 'placeholder' = 'placeholder'): string | null {
  const t = objType(type);
  const fake = t?.cat === 'module' && view === 'model' ? fakeModel(type) : null;
  const key = `${type}:${fake ?? ''}`;
  const hit = cache.get(key);
  if (hit) return hit;
  // 不在机关列表里的（特殊路面等）是资产库模型
  const pieces = fake ? getAsset('fake', fake) : getAsset(!t || t.cat === 'deco' ? 'asset' : 'element', type);
  if (!pieces || !texturesReady(pieces)) return null;
  const fix = (fake && FAKE_FIX[fake]) || {};
  const group = new THREE.Group();
  for (const pc of pieces) {
    // 占位符本身是半透明的，预览用不透明的同色材质看得更清楚
    const src = pc.material as THREE.MeshLambertMaterial;
    const mat = !t || t.cat === 'deco' || fake ? pc.material : new THREE.MeshLambertMaterial({ color: src.color, emissive: src.color, emissiveIntensity: 0.15 });
    const mesh = new THREE.Mesh(pc.geometry, mat);
    // 和视图里一样摆好机关模型（倾斜、转向、上下挪）
    mesh.rotation.order = 'ZYX';
    mesh.rotation.y = ((fix.pitch ?? 0) * Math.PI) / 180;
    mesh.rotation.z = ((fix.rot ?? 0) * Math.PI) / 180;
    mesh.position.set(fix.dx ?? 0, fix.dy ?? 0, fix.dz ?? 0);
    group.add(mesh);
  }
  const url = renderThumb(group);
  cache.set(key, url);
  return url;
}

/** 把一组网格从斜上方渲染成预览图（dataURL）：相机按包围盒取景 */
/** high：从高处往下看（平铺的弧线、曲线从默认机位看只是一条带子） */
export function renderThumb(group: THREE.Object3D, high = false): string {
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, -4, 6);
  scene.add(sun, group);
  const box = new THREE.Box3().setFromObject(group);
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length() || 1;
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, size * 10);
  cam.up.set(0, 0, 1);
  cam.position.copy(c).add((high ? new THREE.Vector3(0.15, -0.55, 1) : new THREE.Vector3(0.9, -1.2, 0.9)).normalize().multiplyScalar(size * (high ? 1.95 : 1.75)));
  cam.lookAt(c);
  const r = getRenderer();
  r.setClearColor(0x000000, 0);
  r.render(scene, cam);
  scene.remove(group);
  return r.domElement.toDataURL('image/png');
}
