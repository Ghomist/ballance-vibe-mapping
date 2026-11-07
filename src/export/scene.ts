// 导出：把地图展开成“场景描述”（JSON），交给 Blender 脚本（scripts/blender/build_scene.py）用 BBP 生成 .blend / .nmo。
//
// 场景描述里只有最终结果，不含编辑器的结构信息：
//   meshes   路面（按连通块合并，一块一个物体）与钢轨（一条一个物体），三角形 + UV，材质为 BME 材质名
//   assets   资产库物体实例（盘点路面、护栏、装饰），按物体名从 BallanceAssets.blend 追加
//   elements 机关占位符（BBP 元素），带小节号和规范名称
import { buildFloorMeshes } from '../geom/floor';
import { buildRail } from '../geom/rail';
import { checkpoints, findStart, prefabParts } from '../model/checkpoint';
import { buildGuards } from '../geom/railing';
import { objSector, objType } from '../model/objects';
import { stopperMesh } from '../model/stoppers';
import { component } from '../model/ops';
import { Model } from '../model/types';

export interface SceneMeshPart { mat: string; pos: number[]; uv?: number[] }
export interface SceneMesh {
  name: string;
  /** floor：Phys_Floors 等；rail：Phys_FloorRails 等；zone：死亡区（DepthTestCubes，隐藏） */
  kind: 'floor' | 'rail' | 'stopper' | 'zone';
  parts: SceneMeshPart[];
  /** 平滑着色（钢轨） */
  smooth?: boolean;
}
export interface SceneAsset {
  asset: string;
  kind: 'floor' | 'rail' | 'deco';
  pos: [number, number, number];
  rotZ: number;
  pitch?: number;
  /** 完整的朝向（Blender 坐标，3×3 按行）；有它时忽略 rotZ / pitch */
  rot3?: number[];
  /** 拉伸过的木制件：本地 X、Y 的缩放（rot3 里已经带着），UV 要补偿成平铺重复 */
  uvStretch?: [number, number];
  /** 挖掉模型本地的这些矩形 [x0, x1, y0, y1]（盘点路面去掉自带的延伸路） */
  crop?: [number, number, number, number][];
}
export interface SceneElement {
  /** BBP 元素类型（P_Box、PC_TwoFlames…） */
  type: string;
  /** 小节号；起点四火 / 终点气球不需要 */
  sector?: number;
  pos: [number, number, number];
  rotZ: number;
  /** 完整的朝向（Blender 坐标，3×3 按行）；有它时忽略 rotZ */
  rot3?: number[];
}
export interface SceneDesc {
  format: 'bvm-scene';
  version: 1;
  sectors: number;
  meshes: SceneMesh[];
  assets: SceneAsset[];
  elements: SceneElement[];
  warnings: string[];
}

const r5 = (v: number) => Math.round(v * 1e5) / 1e5;

/** BBP 的所有机关占位符类型 */
export const ELEMENT_TYPES = [
  'P_Extra_Life', 'P_Extra_Point', 'P_Trafo_Paper', 'P_Trafo_Stone', 'P_Trafo_Wood', 'P_Ball_Paper', 'P_Ball_Stone', 'P_Ball_Wood',
  'P_Box', 'P_Dome', 'P_Modul_01', 'P_Modul_03', 'P_Modul_08', 'P_Modul_17', 'P_Modul_18', 'P_Modul_19', 'P_Modul_25',
  'P_Modul_26', 'P_Modul_29', 'P_Modul_30', 'P_Modul_34', 'P_Modul_37', 'P_Modul_41',
  'PC_TwoFlames', 'PE_Balloon', 'PR_Resetpoint', 'PS_FourFlames',
];
/** 路面可用的 BME 材质 */
export const FLOOR_MATERIALS = [
  'FloorSide', 'LightingFloorTopBorder', 'LightingFloorTopBorderless', 'FloorTopBorder', 'FloorTopBorderless',
  'FloorTopFlat', 'FloorTopProfil', 'FloorTopProfilFlat',
];

const ASSET_KIND: Record<string, SceneAsset['kind']> = {
  BarrierRail_1Edge: 'rail', BarrierRail_3Edge: 'rail', BarrierRail_3Edge_N: 'rail', BarrierRail_3Edge_S: 'rail', RailTip: 'rail',
  RailCrossing: 'rail', MonorailCrossing: 'rail',
};
export const assetKind = (name: string): SceneAsset['kind'] =>
  ASSET_KIND[name] ?? (/^(CheckPoint_|StartPoint_|TrafoBase_|Ventilator_|Slider|Wood|Modul_|ConcaveWood|ConvexWood|Level9_WoodBarrier|Level13_UWoodPath|Turnstile)/.test(name) ? 'floor' : 'deco');

export function exportScene(m: Model): SceneDesc {
  const warnings: string[] = [];
  const start = findStart(m);
  if (!start) warnings.push('没有起点：游戏里无法开始这一关');
  if (!Object.values(m.objs).some((o) => o.type === 'PE_Balloon')) warnings.push('没有终点气球（PE_Balloon）');
  const sectors = 1 + checkpoints(m).length;

  // ---- 路面：按连通块合并 ----
  const floor = buildFloorMeshes(m);
  const byId = new Map(floor.map((e) => [e.id, e]));
  const done = new Set<number>();
  const meshes: SceneMesh[] = [];
  let fi = 0;
  for (const e of floor) {
    if (done.has(e.id)) continue;
    const comp = component(m, e.id);
    const parts = new Map<string, SceneMeshPart>();
    for (const id of comp) {
      done.add(id);
      const em = byId.get(id);
      if (!em) continue;
      for (const [mat, part] of Object.entries(em.parts)) {
        if (!part || !part.pos.length) continue;
        let p = parts.get(mat);
        if (!p) { p = { mat, pos: [], uv: [] }; parts.set(mat, p); }
        p.pos.push(...part.pos.map(r5));
        p.uv!.push(...part.uv.map(r5));
      }
    }
    if (parts.size) meshes.push({ name: `A_Floor_BVM_${String(++fi).padStart(2, '0')}`, kind: 'floor', parts: [...parts.values()] });
  }

  // ---- 钢轨 ----
  let ri = 0;
  for (const r of Object.values(m.rails)) {
    const rm = buildRail(r);
    if (!rm.pos.length) continue;
    meshes.push({ name: `A_Rail_BVM_${String(++ri).padStart(2, '0')}`, kind: 'rail', smooth: true, parts: [{ mat: 'Rail', pos: rm.pos.map(r5) }] });
  }

  // ---- 护栏：每段一个钢轨物体 ----
  let gi = 0;
  const guardNails: SceneAsset[] = [];
  for (const t of buildGuards(m).values()) {
    if (!t.pos.length) continue;
    meshes.push({ name: `A_Rail_BVM_Guard_${String(++gi).padStart(2, '0')}`, kind: 'rail', smooth: true, parts: [{ mat: 'Rail', pos: t.pos.map(r5) }] });
    // 铆钉：装饰，不归组
    for (const n of t.nails) guardNails.push({ asset: n.name, kind: 'deco', pos: n.pos.map(r5) as [number, number, number], rotZ: n.rotZ });
  }

  // ---- 挡块：合成一个物体 ----
  const sp: number[] = [], su: number[] = [];
  for (const o of Object.values(m.objs)) {
    const st = stopperMesh(o);
    if (st) { sp.push(...st.pos.map(r5)); su.push(...st.uv.map(r5)); }
  }
  if (sp.length) meshes.push({ name: 'A_Stopper_BVM_01', kind: 'stopper', parts: [{ mat: 'Stopper', pos: sp, uv: su }] });

  // ---- 资产与机关 ----
  const assets: SceneAsset[] = [...guardNails];
  const elements: SceneElement[] = [];
  const pushPart = (p: ReturnType<typeof prefabParts>[number], sector?: number) => {
    const pos = p.pos.map(r5) as [number, number, number];
    if (p.type === 'asset') assets.push({ asset: p.name, kind: assetKind(p.name), pos, rotZ: p.rotZ, pitch: p.pitch });
    else elements.push({ type: p.name, sector, pos, rotZ: p.rotZ });
  };
  for (const n of Object.values(m.nodes)) {
    if (n.kind === 'base') { for (const p of prefabParts(m, n)) pushPart(p); continue; }
    if (n.kind !== 'checkpoint') continue;
    for (const p of prefabParts(m, n)) {
      // 起点四火不分小节；小节盘点的两火属于“上一个”小节（PC_TwoFlames_{n-1}），重生点属于本小节
      const sector = p.name === 'PS_FourFlames' ? undefined
        : p.name === 'PC_TwoFlames' ? n.sector! - 1
          : n.prefab === 'start' ? 1 : n.sector;
      pushPart(p, sector);
    }
  }
  for (const o of Object.values(m.objs)) {
    const t = objType(o.type);
    if (o.cat === 'deco') {
      assets.push({ asset: o.type, kind: assetKind(o.type), pos: [r5(o.x), r5(o.y), r5(o.z)], rotZ: o.rot });
    } else {
      elements.push({ type: o.type, sector: o.type === 'PE_Balloon' ? undefined : objSector(m, o), pos: [r5(o.x), r5(o.y), r5(o.z)], rotZ: o.rot });
    }
    if (!t) warnings.push(`未知物件类型 ${o.type}`);
  }

  return { format: 'bvm-scene', version: 1, sectors, meshes, assets, elements, warnings };
}
