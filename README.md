# Ballance Vibe Mapping

BVM 是一个 Ballance 制图器：路面、钢轨、机关像积木一样自由摆放，花纹衔接、UV、专属路块、挡块都由程序按几何关系现算。纯前端（TypeScript + Three.js + Vite），在浏览器里画图，直接导出能玩的 NMO。

在线版本：https://ghomist.github.io/ballance-vibe-mapping/

## 现状

已经能从头画完一张图并导出进游戏玩：

- **路面**：曲线路面（沿曲线放样，端头吸到路面边上自动接上）、平路、凹路、细边框凹路，长宽、厚度、坡度都自由；相接的路面自动拼花纹，每条边可以设成自动 / 开口 / 封口。平凹转换、窄转换是单独的素材，路接到平台上时自动嵌入转换件。
- **钢轨**：直轨（单轨、双轨、单双转换）、弯轨、螺旋、曲线钢轨（多段贝塞尔，截面竖直或平行传递，每个控制点可设侧倾角）、侧轨、螺旋侧轨、交叉轨。端点可选平直或球形闭合，侧轨上轨两头可以弯下去固定在路边。钢轨能绕水平轴 转，立起来当 Tip 用。
- **护栏**：沿路面外沿的连续钢管，高度、立柱深度、管半径等在全图设置里调。
- **木制与特殊路面**：木板、木桥、U 形槽、U 型木板、木制斜坡、旋转门路块等资产库模型，部分能拉伸。
- **盘点、机关、道具、装饰**：起点、小节盘点、各种机关；风扇、变球器、栅栏的专属路块和挡块自动配上。机关可以显示成机关模型或 BBP 占位符。
- **死亡区、云层**：死亡区导出时隐藏；云层和漩涡云层导出时显示。
- **编辑**：Blender 式的 G 移动、R 旋转（限轴、输入数值）、顶点吸附、自动对齐、格栅、绑定、合并、切分、撤销 / 重做。
- **地图**：自动存进历史地图，用一串地图码分享。
- **帮助**：右上角「帮助」或 F1 打开图文教程（`src/box/help.md`），一页一个小节，配实时演示（编辑器本身按分镜自动操作）和截图；悬停在按钮上按 F1 直接跳到相关的小节。
- **手机**：横屏使用（竖着拿时提示横过来，安卓可以全屏锁定横屏）；单指环视、双指平移缩放、轻点选中，长按再拖框选（顶栏的多选按钮打开后单指拖都是框选、轻点加选减选），点顶栏的编辑模式、拖手柄编辑，顶栏收起放不下的按钮。网址加 `?touch` 可以在电脑上打开手机界面调试。
- **其它**：素材离线缓存、亮色 / 暗色主题、按需渲染（画面没变不占 CPU、GPU）、视图左上角显示帧数。

### 已知限制

- 地图存在浏览器的 localStorage 里，最多留 100 张，清除网站数据就没了。重要的地图请复制地图码另存。
- 绕水平轴 转过的路面单独生成网格，有自己的边框，不和别的路面拼花纹。
- 绕水平轴 转过的机关没有专属路块和挡块。
- 倾斜的钢轨不能用 Ctrl / Alt 拖，长度和高差在属性面板里改。
- 斜坡只在上下两头接路，侧面不接。
- 起点、小节盘点、护栏只能绕竖直轴转。
- 一张图只导出一个云层，多放的会在导出时给出提示。
- 机关模型只用于显示：吸附和导出都按 BBP 占位符，导出的机关在游戏里由原版机关替换。
- 有几项还在等游戏里实测确认：立起来的钢轨、倾斜的转换件、影子组物体的影子。

## 运行

```bash
npm install
npm run dev
```

`public/` 下的贴图、资产库模型、机关占位符和 NMO 素材库都已提交，不需要装 Ballance 或 Blender。

| 命令 | 用途 |
|---|---|
| `npm test` | 场景测试（求解器、编辑操作、几何、导出、地图码等） |
| `npx tsc --noEmit` | 类型检查 |
| `npm run build` | 类型检查并构建到 `dist/` |
| `npm run bench` | 可选：看求解器性能，和 `tests/bench/baseline.json` 比较，只报告不算失败（不属于测试，发布前不用跑） |
| `npm run assets` | 重新生成贴图、资产库模型和占位符 |
| `node scripts/build-asset-snap.mjs` | 从模型重新生成素材的吸附点（`src/box/asset-snap.ts`） |
| `npm run nmo-lib` | 重新生成 NMO 素材库（`public/nmo-lib.json`） |
| `node scripts/help/check-demos.mjs` | 把帮助教程的实时演示都跑一遍（默认 2 个 Edge、低优先级，`--jobs` 可调），报告哪段坏了（需要开着开发服务器） |
| `node scripts/help/screenshots.mjs [名字…]` | 重新截帮助教程里的截图（`public/help/`，需要开着开发服务器） |

改了界面或功能时，同步更新帮助教程：正文在 `src/box/help.md`；3D 里的操作是实时演示，分镜在 `src/box/demos.ts`（编辑器本身跑在帮助弹窗的小窗口里，界面改了不用重录，交互方式变了才要改分镜，改完跑 `check-demos`）；界面、菜单类的截图场景在 `scripts/help/stills.mjs`，界面变了重截。

后三个素材命令需要本机装有 Ballance、Blender 和 BBP。默认路径是 `D:/Ballance/Textures`、`D:/BlenderLibrary/BallanceAssets/BallanceAssets.blend`、`D:/Blender/blender.exe`，可以用环境变量 `BALLANCE_TEXTURES`、`BALLANCE_ASSETS`、`BLENDER`、`BBP_DIR` 指定其它位置。

推到 master 后，GitHub Actions 跑测试、构建并发布到 GitHub Pages。

## 地图与导出

顶栏「文件」菜单：

- **新建 / 历史地图**（Ctrl+O）：地图自动存到历史里，可以打开、重命名。顶栏输入框是地图名，也是导出 NMO 的文件名。
- **复制 / 导入地图码**：地图压成一串文字，发给别人就能打开。
- **导出 NMO**：在浏览器里直接生成，放进 Ballance 的地图目录就能玩。没有起点或终点气球时会提示。
- **测试场景**：演示各类拼法的内置场景。

### 导出规则

- **路面**：连通的一片路面合成一个 `A_Floor_BVM_*`，使用 BME 材质和 BBP 的归组。
- **钢轨**：头尾相接的钢轨合成一个 `A_Rail_BVM_*`，去掉接头封盖、焊接顶点、60° 自动平滑，法线和 UV 连续。钢轨归入 `Phys_FloorRails` 和 03 号声音组，不进影子组。
- **护栏**：每段一个 `A_Rail_BVM_Guard_*`，铆钉是不归组的装饰。
- **挡块**：全图合成一个 `A_Stopper_BVM_01`（分开会导致声音出问题）。
- **死亡区**：`DepthTestCubes_*`，隐藏。
- **云层**：物体名固定为 `SkyLayer`，游戏只对这个名字做天空混合。
- **机关**：BBP 占位符，按规范命名并归入各自小节；补齐 `Sector_01…N`。
- **贴图**：一律 external，只存文件名，游戏从自己的 Textures 目录读取。
- **影子组**：游戏按网格生成影子，所以影子组的物体各用独立网格，只有不进影子组的物体才共用。`Modul_11`、`Modul_15` 与原版一样不进影子组。

### NMO 写入器

`src/export/nmo.ts` 是 Virtools 文件格式的写入器，照搬 [libcmo21](https://github.com/yyc12345/libcmo21)（BBP 背后的 BMap）的保存流程，只实现地图需要的组、3D 物体、网格、材质、贴图（外部文件名），整体 zlib 压缩（浏览器自带的 `CompressionStream`）。`src/export/nmo-scene.ts` 把场景描述组装成 Virtools 文档。

资产库物体、机关占位符的网格和所有材质、贴图参数来自 `public/nmo-lib.json`：`npm run nmo-lib` 让 Blender + BBP 导出一个包含全部资产、机关和材质的“目录”关卡，再用 BMap 读回来生成，只在资产库或 BBP 更新时需要重跑。`scripts/blender/dump_nmo.py` 能把 .nmo 读成 JSON，用来检查导出结果。

### 地图码格式

格式说明在 `src/box/share.ts` 开头。线上已有的地图码必须一直能打开：

- 新的可选字段追加到 `EXTRAS` 末尾，不要往 `SPECS` 里插列。
- 新的素材、机关名称追加到 `src/box/share-ids.ts` 和 `tests/box/share-ids.json` 末尾。
- `tests/box/share-codes.json` 留着各个版本的地图码，格式有变化时补一条。

## 操作

状态栏会随当前状态显示可用的按键，下面是完整列表。

### 视角

| 操作 | 效果 |
|---|---|
| 中键 / Shift+中键 / 滚轮 | 环视 / 平移 / 缩放 |
| 右键按住 | 漫游：鼠标转视角，WASD 移动，空格上升，Shift 下降，滚轮调速度 |
| F | 看选中的东西；没有选中时看全部 |
| 视图立方体 | 切换到正交的正视图，环视时回到透视 |
| 自动追踪（默认关，设置里可开） | 点选时视角移到点中的东西上：不拉近，离得太近时按 F 的距离拉远 |

### 选择与放置

| 操作 | 效果 |
|---|---|
| 左键 / 空白处拖动 | 点选 / 框选，Shift 加选；Ctrl+A 全选 |
| 素材库卡片 | 拖到场景里放下（拖动中 R 旋转、右键取消），点一下放到视图中心；手机上竖滑翻页，按住或横拖才放 |
| 属性面板 | 选中后改位置、尺寸、样式等；数字框可以左右拖动，Shift 微调 |

### 变换

| 操作 | 效果 |
|---|---|
| 编辑模式（顶栏）| 1～6：移动 / 拉伸 / 坡面 / 旋转 / 切分 / 花纹，按钮变蓝，再按一次取消（回到选择模式）；按住 G / Ctrl / Alt / R / K / P 临时切换，按钮变橙，松开回去。每个模式在选中的东西上显示自己的手柄（箭头、圆环、抓点、圆圈），顶栏「手柄」可以关掉 |
| 轻按 G | 自由移动：X / Y / Z 限轴，Shift+X 等排除一个轴，输入数字定距离，左键或 Enter 确定，右键或 Esc 取消 |
| 轻按 R | 自由旋转：X / Y / Z 换轴；开着对齐时每 15° 吸附，Ctrl 临时切换 |
| 坐标系 | 默认游戏坐标系（Y 朝上，数字和 Ballance 一致），设置里可换数学坐标系（Z 朝上）；只影响显示和 X / Y / Z 按键 |
| 方向键 / PageUp / PageDown | 微调位置，步长 1，按住 Shift 为 0.1 |
| Ctrl + 拖 | 改尺寸；钢轨改长度；能拉伸的木制件沿长宽方向拉伸；护栏改长度 |
| Alt + 拖 | 路面一头做坡；直轨做坡 |
| Ctrl + 拖侧面下半截 | 改厚度（路面、死亡区） |
| 按住 V + 拖 | 抓住顶点或边中点，拖到别的物体上吸附 |
| 花纹模式里点路面边中点的圆圈 | 依次切换自动 / 开口 / 封口 |
| 花纹模式里点机关挡块上的圆圈 | 这块挡块生成 / 不生成 |

### 工具与命令

| 操作 | 效果 |
|---|---|
| H | 护栏工具 |
| 护栏工具 | 点路边放整条直边（两头各内缩 1.5，设置里可改），沿路边拖放一段，拖把手改长度 |
| 切分工具 | 在鼠标处切开，Tab 换方向，右键或 Esc 退出 |
| Shift+D 或 Ctrl+D | 复制并进入移动模式 |
| Ctrl+J | 合并选中的路面（同样式、同高度、拼起来是矩形） |
| Ctrl+G / Ctrl+Shift+G | 绑定成一个整体 / 解绑 |
| X / Delete / Backspace | 删除 |
| Ctrl+Z / Ctrl+Y | 撤销 / 重做 |
| S / Shift+Tab | 开关自动对齐 / 格栅（默认步长 1，设置里可改） |
| 设置 → 快捷键 | 这里列的都是默认按键，大部分可以改绑（Esc、Enter、方向键、F1 和移动时的 X / Y / Z 固定） |

## 路面规则

地图由互相独立的元素组成，元素之间不存连接关系，每次改动后由 `src/box/solve.ts` 按几何关系重新算：

- 贴在一起、同样式同高度的路面连成一片，花纹和 UV 自动衔接；重叠的部分只画一次。任意 Z 角度的平路都参与拼接。
- 路的端面贴着两头接路的机关（秋千、双向挡板、推板、软木桥、跷跷板、T 型板、终点气球）的对准方块、木栅栏底座顶层的侧面、特殊路块 16 的两头时，自动开口不画边框（对准方块嵌在路面里，路的端面就是方块朝机关中间的那一面）。T 型板中间不带挡块的那个对准方块照常封口；手动设成封口的边优先。
- 样式不同的路相接时不自动处理，两边各画边框。路接路用平凹转换（长 5）或窄转换（长 2.5）；路接到平台侧面时，平台的边框带里自动嵌入长 2.5 的转换件。
- 厚度超过 5 的路面，侧面上方 5 用带边框的材质，下面用无边框的材质（和 BBP 一致）。
- 机关不改路面，但风扇、变球器、栅栏的专属路块自动生成，可以在属性面板里关掉；Modul 19、25、30、37 的挡块默认全部生成，选中机关后点每块挡块上的圆圈逐块开关（实心绿点生成，圆环不生成，关掉的画成红色虚影）；专属路块和路面重叠时裁掉路面，放进路面之间的缺口也能接上。
- 新放的机关归到顶栏选中的小节，属性面板里可改；小节盘点按放置顺序编号。

## 结构

- `src/box`：当前的编辑器
  - `app.ts`：Three.js 视图、交互、素材库、属性面板
  - `types.ts`：地图数据模型；`ops.ts`：编辑操作；`xform.ts`：朝向和旋转；`snap.ts`：吸附特征点；`guard.ts`：护栏路径
  - `solve.ts`：路面求解（连接、花纹、遮挡、专属路块、转换件）
  - `export.ts`：地图 → 场景描述 → NMO
  - `share.ts`、`share-ids.ts`：地图码；`maps.ts`：历史地图
  - `asset-info.ts`、`asset-snap.ts`：资产库物体的信息和吸附点；`scenes.ts`：测试场景
- `src/geom`：网格生成，`floor.ts` 路面、`rail.ts` 钢轨、`railing.ts` 护栏
- `src/view`：素材与材质加载、网格线、预览图、提示框等
- `src/export`：`nmo.ts` 写入器，`nmo-scene.ts` 组装 Virtools 文档，`nmo-lib.ts` 素材库，`scene.ts` 场景描述类型和上一版的导出
- `src/model`：上一版的路网模型。`objects.ts`、`rail.ts`、`stoppers.ts`、`outline.ts` 等当前版本仍在用
- `src/main.ts`、`src/editor.ts`、`legacy.html`：上一版的路网编辑器，线上地址加 `legacy.html` 能打开，地图和当前版本不通用
- `scripts`：素材生成、NMO 素材库；`scripts/blender` 下是 Blender 脚本
- `public/sw.js`：离线缓存
- `tests`：`npm test` 的场景测试；`tests/box` 是求解器金标准和地图码样本
- `promo`：宣传视频的素材和脚本

只有上一版能用的功能：导出 .blend 和场景描述 JSON（.blend 要在开发服务器上跑），以及 `npm run export`、`npm run nmo-check`（读上一版的 .bvm 文件）。

## 致谢

- [Ballance](https://zh.wikipedia.org/wiki/Ballance)（Cyparade / Atari）：原版游戏。贴图、机关文件、关卡里的挡块等素材都来自原版，版权归原作者所有，本仓库只在编辑器里预览用。
- [BallanceBlenderPlugin（BBP）](https://github.com/yyc12345/BallanceBlenderHelper)（yyc12345）：BME 路面材质、机关占位符、物体归组和命名规范都照它来，Blender 导出也靠它；网页端导出以它的结果为准逐项对比。
- [libcmo21 / BMap](https://github.com/yyc12345/libcmo21)（yyc12345）：Virtools 文件格式的读写，网页端 NMO 写入器照搬了它的保存流程，素材库和导出对比也用它读 NMO。
- Ballance 资产库（`BallanceAssets.blend`）：盘点路面、护栏、灯柱、柱子、假机关模型都取自这里。
- [Ballance 制图手册](https://ghomist.github.io/ballance-mapping-manual/)：机关尺寸、对准方块等数值的依据。
- [Ballance Wiki](https://ballance.jxpxxzj.cn/wiki/)：机关和装饰的名称、风扇 / 生命球 / 分数球 / Dome 的构造与样式参考。
- [Three.js](https://threejs.org/)（含 TGALoader、Line2 等扩展）、[Vite](https://vite.dev/)、[TypeScript](https://www.typescriptlang.org/)、[tsx](https://github.com/privatenumber/tsx)、[Blender](https://www.blender.org/)。
