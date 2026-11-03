import * as THREE from 'three';
import type { MatName } from '../geom/floor';

// 贴图来自 Ballance 安装目录的 Textures 文件夹，由 `npm run textures` 复制到 public/textures。
const TEXTURE_FILES: Record<MatName, string> = {
  FloorTopBorder: 'Floor_Top_Border.bmp',
  FloorTopBorderless: 'Floor_Top_Borderless.bmp',
  FloorTopFlat: 'Floor_Top_Flat.bmp',
  FloorTopProfil: 'Floor_Top_Profil.bmp',
  FloorTopProfilFlat: 'Floor_Top_ProfilFlat.bmp',
  FloorSide: 'Floor_Side.bmp',
  LightingFloorTopBorder: 'Floor_Top_Border.bmp',
  LightingFloorTopBorderless: 'Floor_Top_Borderless.bmp',
};

const FALLBACK_COLORS: Record<MatName, number> = {
  FloorTopBorder: 0xc8b89a,
  FloorTopBorderless: 0xd8c8aa,
  FloorTopFlat: 0xd8c8aa,
  FloorTopProfil: 0xb8a88a,
  FloorTopProfilFlat: 0xc0b090,
  FloorSide: 0x8a7a66,
  LightingFloorTopBorder: 0xb8a88a,
  LightingFloorTopBorderless: 0xc0b090,
};

const cache = new Map<MatName, THREE.Material>();
const loader = new THREE.TextureLoader();
const pending = new Map<MatName, Promise<void>>();

/** 路面贴图都加载完（或失败）时完成：打开编辑器时等它再显示视图，免得先闪一下没贴图的路面 */
export function floorTexturesReady(): Promise<void> {
  for (const n of Object.keys(TEXTURE_FILES) as MatName[]) getMaterial(n);
  return Promise.all(pending.values()).then(() => {});
}

export function getMaterial(name: MatName): THREE.Material {
  let mat = cache.get(name);
  if (mat) return mat;
  // 构造路面一律平直着色（不做折痕平滑）
  const m = new THREE.MeshLambertMaterial({ color: FALLBACK_COLORS[name], flatShading: true });
  let done!: () => void;
  pending.set(name, new Promise<void>((r) => { done = r; }));
  loader.load(
    `${import.meta.env.BASE_URL}textures/${TEXTURE_FILES[name]}`,
    (tex) => {
      // UV 与 BME 相同，为 Blender 约定（v 向上），即 three.js 默认的 flipY
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 8;
      m.map = tex;
      m.color.set(0xffffff);
      m.needsUpdate = true;
      done();
    },
    undefined,
    () => { console.warn(`缺少贴图 ${TEXTURE_FILES[name]}，使用纯色代替。运行 npm run textures 复制贴图。`); done(); },
  );
  cache.set(name, m);
  return m;
}

let railMat: THREE.Material | null = null;

/** 钢轨：游戏里是环境贴图的金属质感，预览用高光材质近似 */
export function getRailMaterial(): THREE.Material {
  railMat ??= new THREE.MeshPhongMaterial({ color: 0x9ea8b4, specular: 0xe8f0ff, shininess: 70 });
  return railMat;
}
