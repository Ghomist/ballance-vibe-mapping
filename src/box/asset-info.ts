// 素材库里的特殊路面（资产库模型，形状固定）：名称、分组、本地包围盒（以资产原点为准，Blender 坐标）
// 由 BallanceAssets.blend 的物体信息整理
export interface AssetInfo {
  name: string; label: string; group: 'wood' | 'special'; min: [number, number, number]; max: [number, number, number];
  /** 能按住 Ctrl 拉伸（沿本地 X / Y 缩放）：木板类（木板、木制斜坡、凹凸木轨道）和波浪板（长 / 宽木桥） */
  stretch?: boolean;
  /** 素材库里放在哪个标签（默认「特殊路面」） */
  tab?: 'road' | 'rail' | 'deco';
  /** 云层：顶栏可以整体显示 / 隐藏（只影响编辑器，导出时总是显示） */
  sky?: boolean;
  /** 吸附、对齐用的顶面（本地 z）：包围盒顶上是空的时候用，比如旋转门路块顶面中间的土堆不算，只认底下的方块 */
  snapTop?: number;
}

export const ASSET_INFO: AssetInfo[] = [
  { name: 'WoodPlate', label: '木板', group: 'wood', min: [-4.755, -4.752, -0.5], max: [4.755, 4.752, 0.0], stretch: true },
  { name: 'Modul_02', label: '短木桥', group: 'wood', min: [0.0, 0.0, -1.5484], max: [5.0, 10.0, 1.228] },
  { name: 'Modul_13', label: '木制斜板', group: 'wood', min: [-6.154, 0.0, -3.6181], max: [0.0, 25.001, 3.0975] },
  { name: 'Modul_42', label: '长木桥', group: 'wood', min: [-2.5, 0.0, -2.4453], max: [2.5, 130.0941, 1.6262], stretch: true },
  { name: 'Modul_42_Wide', label: '宽木桥', group: 'wood', min: [-5.0007, 0.0, -0.9962], max: [5.0007, 55.7975, 3.0753], stretch: true },
  { name: 'Modul_11', label: '木制 U 形槽', group: 'wood', min: [-3.4983, -0.0085, -0.4122], max: [8.5065, 58.6615, 6.7892] },
  { name: 'ConcaveWood', label: '凹木轨道', group: 'wood', min: [-0.0, -9.29, -0.494], max: [200.0, 9.29, 5.2195], stretch: true },
  { name: 'ConvexWood', label: '凸木轨道', group: 'wood', min: [0.0, -8.422, -4.53], max: [150.0, 8.423, 0.0], stretch: true },
  { name: 'Level9_WoodBarrier', label: '木围栏路面', group: 'wood', min: [-25.0, 0.0, -0.0], max: [0.0, 25.0, 3.3651] },
  { name: 'WoodSlope', label: '木制斜坡', group: 'wood', min: [-5.0001, -0.0, -0.7825], max: [5.0005, 46.6938, 24.5868], stretch: true },
  { name: 'Modul_15', label: '特殊路块 15', group: 'special', min: [-0.0, -2.0427, -2.0215], max: [4.5131, 36.9773, 7.576], tab: 'road' },
  { name: 'Modul_16', label: '特殊路块 16', group: 'special', min: [-6.7872, -0.0, -1.7378], max: [7.0609, 37.2046, 5.154], tab: 'road' },
  { name: 'Turnstile', label: '旋转门路块', group: 'special', min: [-2.5, -2.5, -2.5], max: [2.5, 2.5, 3.5316], tab: 'road', snapTop: 2.5 },
  { name: 'Turnstile_Big', label: '大旋转门路块', group: 'special', min: [-2.9368, -2.9368, -2.5], max: [2.9368, 2.9368, 3.5316], tab: 'road', snapTop: 2.5 },
  { name: 'SkyLayer', label: '云层', group: 'special', min: [-946.55, -936.75, 0], max: [946.55, 936.75, 0], tab: 'deco', sky: true },
  { name: 'SkyLayerVortex', label: '云层漩涡', group: 'special', min: [-1357.49, -1411.31, -388.77], max: [1357.49, 1411.31, -28.23], tab: 'deco', sky: true },
  { name: 'RailCrossing', label: '双轨交叉', group: 'special', min: [-2.5, -2.5, -0.35], max: [2.5, 2.5, 0.35], tab: 'rail' },
  { name: 'MonorailCrossing', label: '单轨交叉', group: 'special', min: [-2.5, -2.4999, -0.3234], max: [2.5, 2.5001, 0.3234], tab: 'rail' },
];

export const assetInfo = (name: string) => ASSET_INFO.find((a) => a.name === name);
