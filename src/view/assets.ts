// 资产库模型（盘点路面、装饰）与 BBP 机关占位符的加载与缓存。
// 文件由 `npm run assets` 生成到 public/assets 与 public/elements。
import * as THREE from 'three';

export interface AssetPiece { geometry: THREE.BufferGeometry; material: THREE.Material }

interface AssetPartJSON {
  name: string | null; texture: string | null; color?: number[];
  alphaTest?: boolean; alphaBlend?: boolean;
  pos: number[]; uv: number[]; nrm: number[];
}

const cache = new Map<string, AssetPiece[] | 'loading' | 'missing'>();
const texLoader = new THREE.TextureLoader();
const texCache = new Map<string, THREE.Texture>();
const listeners: (() => void)[] = [];
/** 每加载完一个模型就加一，作为网格缓存键的一部分 */
export let assetVersion = 0;

export function setAssetLoadedCallback(cb: () => void) { listeners.push(cb); }

function texture(file: string) {
  let t = texCache.get(file);
  if (!t) {
    t = texLoader.load(`${import.meta.env.BASE_URL}textures/${file}`);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    texCache.set(file, t);
  }
  return t;
}

/** 机关占位符的颜色：火焰橙色、重生点青色；道具球 / 变球器按材质（纸白、石灰、木棕）；其它机关紫色 */
function elementColor(name: string) {
  if (name.startsWith('PS_') || name.startsWith('PC_')) return 0xff9a3c;
  if (name.startsWith('PR_')) return 0x3cd2ff;
  if (name.startsWith('PE_')) return 0xff5d8f;
  if (name.endsWith('_Paper')) return 0xf2ead8;
  if (name.endsWith('_Stone')) return 0x8f98a3;
  if (name.endsWith('_Wood')) return 0xb9773f;
  if (name.startsWith('P_Extra')) return 0x7dff9a;
  if (name === 'P_Box') return 0xd9a35c;
  return 0xb48cff;
}

const elementMats = new Map<number, THREE.Material>();
function elementMaterial(name: string) {
  const c = elementColor(name);
  let m = elementMats.get(c);
  if (!m) {
    m = new THREE.MeshLambertMaterial({ color: c, transparent: true, opacity: 0.55, depthWrite: false, emissive: c, emissiveIntensity: 0.3 });
    elementMats.set(c, m);
  }
  return m;
}

async function load(kind: 'asset' | 'element', name: string): Promise<AssetPiece[]> {
  const url = `${import.meta.env.BASE_URL}${kind === 'asset' ? 'assets' : 'elements'}/${name}.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(url);
  const data = await res.json();
  if (kind === 'element') {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(data.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(data.nrm, 3));
    return [{ geometry: g, material: elementMaterial(name) }];
  }
  return (data.parts as AssetPartJSON[]).map((p) => {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(p.pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(p.uv, 2));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(p.nrm, 3));
    const mat = new THREE.MeshLambertMaterial({
      color: p.texture ? 0xffffff : new THREE.Color(...((p.color ?? [0.8, 0.8, 0.8]) as [number, number, number])),
      map: p.texture ? texture(p.texture) : null,
      transparent: !!p.alphaBlend, alphaTest: p.alphaTest ? 0.5 : 0, side: p.alphaBlend ? THREE.DoubleSide : THREE.FrontSide,
    });
    return { geometry: g, material: mat };
  });
}

/** 取模型；还没加载时发起加载并返回 null，加载完成后回调 */
export function getAsset(kind: 'asset' | 'element', name: string): AssetPiece[] | null {
  const key = `${kind}:${name}`;
  const c = cache.get(key);
  if (Array.isArray(c)) return c;
  if (c === undefined) {
    cache.set(key, 'loading');
    load(kind, name).then(
      (r) => { cache.set(key, r); assetVersion++; for (const f of listeners) f(); },
      () => { cache.set(key, 'missing'); console.warn(`缺少模型 ${name}，运行 npm run assets 生成。`); },
    );
  }
  return null;
}

let stopperMat: THREE.Material | null = null;
/** 挡块：原版的木头贴图（E_Holzbeschlag） */
export function getStopperMaterial(): THREE.Material {
  stopperMat ??= new THREE.MeshLambertMaterial({ map: texture('E_Holzbeschlag.bmp'), side: THREE.DoubleSide });
  return stopperMat;
}

/** 缺少模型时的占位盒子 */
const boxMat = new THREE.MeshLambertMaterial({ color: 0xd8c8aa, transparent: true, opacity: 0.6 });
export function fallbackBox(sx: number, sy: number, sz: number): AssetPiece {
  return { geometry: new THREE.BoxGeometry(sx, sy, sz), material: boxMat };
}
