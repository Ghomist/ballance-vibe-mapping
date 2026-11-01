// 网页端 NMO 导出用的素材库（public/nmo-lib.json，由 scripts/build-nmo-lib.ts 生成）。
// 所有数据都已是 Virtools 坐标系（Y 轴朝上、左手系），可以直接写进 .nmo。

export interface NmoTexture {
  /** 贴图文件名（Ballance/Textures 下） */
  file: string | null;
  size: [number, number] | null;
  saveOptions: number;
  videoFormat: number;
}
/** RGBA，0..1 */
export type NmoColor = [number, number, number, number];
export interface NmoMaterial {
  diffuse: NmoColor; ambient: NmoColor; specular: NmoColor; emissive: NmoColor;
  specularPower: number;
  texture: string | null;
  textureBorderColor: NmoColor;
  textureBlendMode: number; textureMinMode: number; textureMagMode: number; textureAddressMode: number;
  sourceBlend: number; destBlend: number; fillMode: number; shadeMode: number;
  alphaTest: boolean; alphaBlend: boolean; perspectiveCorrection: boolean; zWrite: boolean; twoSided: boolean;
  alphaRef: number; alphaFunc: number; zFunc: number;
}
export interface NmoMesh {
  litMode: number;
  pos: number[]; nml: number[]; uv: number[];
  faces: number[]; faceMtl: number[];
  /** 材质槽（材质名） */
  mtls: (string | null)[];
}
export interface NmoLib {
  version: 1;
  textures: Record<string, NmoTexture>;
  materials: Record<string, NmoMaterial>;
  meshes: Record<string, NmoMesh>;
  /** 资产库物体：网格与组 */
  assets: Record<string, { mesh: string; groups: string[] }>;
  /** 机关占位符：网格 */
  elements: Record<string, { mesh: string }>;
  /** 编辑器里的材质名（BME 材质名、Rail、Stopper）→ 导出的材质名 */
  floorMaterials: Record<string, string>;
}

let cache: Promise<NmoLib> | null = null;
/** 载入素材库（网页端） */
export function loadNmoLib(): Promise<NmoLib> {
  cache ??= fetch(`${import.meta.env.BASE_URL}nmo-lib.json`).then((r) => {
    if (!r.ok) throw new Error(`素材库载入失败（${r.status}）`);
    return r.json();
  });
  return cache;
}
