// 编辑器用到的资产库物体（BallanceAssets.blend 中的物体名）
export const ASSET_OBJECTS = [
  // 盘点路面
  'StartPoint_NoExtended', 'StartPoint_Extended_OpenEdge',
  'CheckPoint_NoExtended', 'CheckPoint_Extended_OpenEdge', 'CheckPoint_DoubleExtended_OpenEdge',
  // 装饰
  // 机关底座
  'TrafoBase_Paper', 'TrafoBase_Stone', 'TrafoBase_Wood', 'Slider',
  'Ventilator_1Edge', 'Ventilator_2Face_Adjacent', 'Ventilator_2Face_Opposite', 'Ventilator_3Edge', 'Ventilator_4Face', 'Ventilator_NoEdge_Border', 'Ventilator_NoEdge_Borderless',
  'Latern', 'LaternColumn_Full', 'LaternColumn', 'BarrierRail_1Edge', 'BarrierRail_3Edge', 'BarrierRail_3Edge_N', 'BarrierRail_3Edge_S', 'RailTip', 'RailNail',
  // 特殊路面（box 版编辑器的素材库）：木制路面、特殊路块、钢轨交叉
  'WoodPlate', 'Modul_02', 'Modul_13', 'Modul_42', 'Modul_42_Wide', 'Modul_11', 'ConcaveWood', 'ConvexWood', 'Level9_WoodBarrier', 'WoodSlope',
  'Modul_15', 'Modul_16', 'Turnstile', 'Turnstile_Big', 'RailCrossing', 'MonorailCrossing',
];

// 假机关（资产库「机关模型」分类，集合或物体名）：编辑器里显示用，导出时仍用 BBP 占位符
export const FAKE_MODULES = [
  'Fake_Ball_Paper', 'Fake_Ball_Stone', 'Fake_Ball_Wood', 'Fake_Box', 'Fake_Balloon',
  'Fake_Trafo_Paper', 'Fake_Trafo_Stone', 'Fake_Trafo_Wood',
  'Fake_Modul_01', 'Fake_Modul_03', 'Fake_Modul_08', 'Fake_Modul_17', 'Fake_Modul_19', 'Fake_Modul_25',
  'Fake_Modul_26', 'Fake_Modul_29', 'Fake_Modul_30', 'Fake_Modul_34', 'Fake_Modul_37', 'Fake_Modul_41',
];
