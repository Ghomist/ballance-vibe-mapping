// 机关库的预览图：用一个离屏渲染器把占位符 / 资产模型从斜上方渲染成小图。
import * as THREE from 'three';
import { objType } from '../model/objects';
import { getAsset } from './assets';

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
export function thumbnail(type: string): string | null {
  const hit = cache.get(type);
  if (hit) return hit;
  const t = objType(type);
  const pieces = getAsset(t?.cat === 'deco' ? 'asset' : 'element', type);
  if (!pieces) return null;
  const scene = new THREE.Scene();
  scene.add(new THREE.AmbientLight(0xffffff, 1.4));
  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(3, -4, 6);
  scene.add(sun);
  const group = new THREE.Group();
  for (const pc of pieces) {
    // 占位符本身是半透明的，预览用不透明的同色材质看得更清楚
    const src = pc.material as THREE.MeshLambertMaterial;
    const mat = t?.cat === 'deco' ? pc.material : new THREE.MeshLambertMaterial({ color: src.color, emissive: src.color, emissiveIntensity: 0.15 });
    group.add(new THREE.Mesh(pc.geometry, mat));
  }
  scene.add(group);
  const box = new THREE.Box3().setFromObject(group);
  const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3()).length() || 1;
  const cam = new THREE.PerspectiveCamera(30, 1, 0.1, size * 10);
  cam.up.set(0, 0, 1);
  cam.position.copy(c).add(new THREE.Vector3(0.9, -1.2, 0.9).normalize().multiplyScalar(size * 1.75));
  cam.lookAt(c);
  const r = getRenderer();
  r.setClearColor(0x000000, 0);
  r.render(scene, cam);
  const url = r.domElement.toDataURL('image/png');
  cache.set(type, url);
  return url;
}
