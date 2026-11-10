// 帮助教程的实时演示分镜（demo.ts 播放）：每段一个名字，和 help.md 里的 ![说明](demo:名字) 对应。
//   setup：摆好场景、视角（每一轮开头都会重新摆）；act：演示的操作；teardown：一轮结束后的收尾。
//   坐标都是世界坐标（Z 向上），路面默认厚 5、顶面 z = 0。屏幕上的点用 api.vp(0～1, 0～1) 按视图比例取。
//   props: true 的分镜显示属性面板（要在面板里点的），其余隐藏，画面干净些。
//   改了交互方式（按键、拖法、面板里的控件）要同步改这里；帮助弹窗里出错的演示会把原因显示在画面上。
import type { Doc } from './types';

type XY = { x: number; y: number };
/** 手柄现在在哪（编辑器 __proto.gizmoInfo）：移动箭头、旋转圆环的中心和大小，拉伸 / 坡面的抓点 */
export interface GizmoInfo {
  mode: string | null;
  move: { p: number[]; s: number } | null;
  rot: { p: number[]; s: number } | null;
  handles: { kind: 'size' | 'thick' | 'tilt'; id: number; p: number[] }[];
}
type Btn = 'left' | 'middle' | 'right';
export interface DemoApi {
  P(p: number[]): XY;
  glide(to: XY, ms?: number): Promise<void>;
  at(p: number[], ms?: number): Promise<void>;
  down(b?: Btn): Promise<void>;
  up(b?: Btn): Promise<void>;
  click(b?: Btn): Promise<void>;
  press(k: string, mods?: string[], o?: { show?: boolean; ms?: number }): Promise<void>;
  hold(keys: string[]): Promise<() => Promise<void>>;
  keyDown(k: string): Promise<void>;
  keyUp(k: string): Promise<void>;
  keysShow(list: string[], ms?: number): Promise<void>;
  keysClear(): Promise<void>;
  drag(from: number[], to: number[], o?: { mods?: string[]; ms?: number; button?: Btn; show?: boolean }): Promise<void>;
  dragScreen(from: XY, to: XY, o?: { mods?: string[]; ms?: number; button?: Btn; keys?: string[] }): Promise<void>;
  wheel(dy: number, n?: number): Promise<void>;
  wait(ms: number): Promise<void>;
  setDoc(elems: Record<string, unknown>[], extra?: Partial<Doc>): Promise<void>;
  view(pos: number[], target: number[]): Promise<void>;
  center(pt: number[]): Promise<void>;
  fly(pos: number[], target: number[], ms?: number): Promise<void>;
  select(ids: number[]): Promise<void>;
  doc(): Promise<Doc>;
  pref(k: string, v: unknown): void;
  gizmo(): GizmoInfo;
  clickEl(sel: string, ms?: number): Promise<void>;
  clickText(sel: string, text: string, ms?: number): Promise<void>;
  typeInto(sel: string, text: string): Promise<void>;
  mouse(): XY;
}
export interface Demo {
  name: string;
  /** 显示属性面板 */
  props?: boolean;
  /** 摆好场景后等多久再开始（默认 500 ms） */
  settle?: number;
  setup(a: DemoApi): Promise<void>;
  act(a: DemoApi): Promise<void>;
  teardown?(a: DemoApi): Promise<void>;
}

const box = (x: number, y: number, sx: number, sy: number, o: Record<string, unknown> = {}) => ({ kind: 'box', x, y, z: 0, sx, sy, depth: 5, style: 'normal', ...o });
const obj = (type: string, x: number, y: number, z = 0, rot = 0, o: Record<string, unknown> = {}) => ({ kind: 'obj', type, x, y, z, rot, ...o });
const rail = (x: number, y: number, z: number, pieces: Record<string, unknown>[], o: Record<string, unknown> = {}) => ({ kind: 'rail', x, y, z, heading: 0, pieces, ...o });
const straight = (len: number, kind = 'double') => ({ kind, len, radius: 0, angle: 0, dz: 0 });

/** 默认场景：起点 → 路 → 小节盘点 → 路 → 终点气球 */
const DEFAULT = [
  { id: 1, kind: 'piece', type: 'start', x: 0, y: 0, z: 0, rot: 0 },
  { id: 6, ...box(7.386, -2.5, 15, 5) },
  { id: 7, kind: 'piece', type: 'check', x: 27.31, y: 0, z: 0, rot: 0 },
  { id: 8, ...box(32.234, -2.5, 15, 5) },
  { id: 9, ...obj('PE_Balloon', 69.304, 0.17, -0.01, 2) },
];

/** 视图里按比例取的屏幕点（0～1） */
function vp(fx: number, fy: number): XY {
  const r = document.getElementById('viewport')!.getBoundingClientRect();
  return { x: r.left + r.width * fx, y: r.top + r.height * fy };
}
/** 绕屏幕点 c 画一段圆弧（旋转模式里用鼠标转） */
async function arc(a: DemoApi, c: XY, r: number, a0: number, a1: number, ms: number) {
  const n = 8;
  for (let i = 1; i <= n; i++) {
    const t = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    await a.glide({ x: c.x + r * Math.cos(t), y: c.y - r * Math.sin(t) }, ms / n);
  }
}
/** 移动手柄的箭头：原点 o 沿 ax 轴在屏幕上 px 像素处（手柄约 80 像素长） */
function arrowAt(a: DemoApi, o: number[], ax: number, px = 62) {
  const p = a.P(o), q = [...o];
  q[ax] += 1;
  const b = a.P(q), l = Math.hypot(b.x - p.x, b.y - p.y) || 1;
  return { x: p.x + ((b.x - p.x) / l) * px, y: p.y + ((b.y - p.y) / l) * px, dx: (b.x - p.x) / l, dy: (b.y - p.y) / l };
}

export const DEMOS: Demo[] = [
  // ---------------- 1.2 视角 ----------------
  {
    name: 'view-orbit',
    async setup(a) { await a.setDoc(DEFAULT); await a.view([24, -46, 32], [32, 0, 0]); await a.center([34, 0, 0]); },
    async act(a) {
      await a.dragScreen(vp(0.4, 0.62), vp(0.62, 0.58), { button: 'middle', ms: 1100, keys: ['中键拖'] });
      await a.dragScreen(vp(0.5, 0.62), vp(0.4, 0.5), { button: 'middle', mods: ['Shift'], ms: 800, keys: ['Shift', '中键拖'] });
      await a.glide(vp(0.45, 0.55), 200);
      await a.keysShow(['滚轮']); await a.wheel(-120, 3); await a.keysClear(); await a.wait(300);
      // 视图立方体：点顶面切到俯视，再中键拖一下回到透视
      const cube = document.querySelector('#viewcube canvas')!.getBoundingClientRect();
      await a.glide({ x: cube.left + cube.width / 2, y: cube.top + cube.height / 2 - cube.height * 0.18 }, 450);
      await a.keysShow(['左键'], 500); await a.click(); await a.wait(900);
      await a.dragScreen(vp(0.45, 0.6), vp(0.52, 0.62), { button: 'middle', ms: 600, keys: ['中键拖'] });
    },
  },
  {
    name: 'view-focus',
    async setup(a) { a.pref('followPick', true); await a.setDoc(DEFAULT); await a.view([-6, -30, 22], [6, 0, 0]); },
    async act(a) {
      await a.at([28, 0, 0], 500); await a.keysShow(['左键'], 600); await a.click(); await a.wait(950);
      await a.at([44, 0, 0], 450); await a.keysShow(['左键'], 600); await a.click(); await a.wait(950);
      await a.press('f'); await a.wait(1000);
      await a.glide(vp(0.12, 0.12), 450); await a.keysShow(['左键'], 500); await a.click(); await a.wait(150);
      await a.press('f'); await a.wait(1000);
    },
    async teardown(a) { a.pref('followPick', false); },
  },
  // ---------------- 1.3 基本操作 ----------------
  {
    name: 'op-gizmo',
    async setup(a) { await a.setDoc([box(0, 0, 10, 5), box(16, 0, 10, 5)]); await a.view([10, -26, 16], [12, 2.5, 0]); await a.center([12, 2.5, 0]); await a.select([1]); },
    async act(a) {
      // 按 1 进入移动模式，选中的东西上出现箭头
      await a.press('1', [], { ms: 1000 }); await a.wait(500);
      let p = arrowAt(a, [5, 2.5, 0], 0);
      await a.glide(p, 600); await a.wait(250);
      await a.keysShow(['按住箭头拖']); await a.down();
      await a.glide({ x: p.x + p.dx * 90, y: p.y + p.dy * 90 }, 1000); await a.wait(150); await a.up(); await a.keysClear(); await a.wait(450);
      // 手柄跟着路面走了：按移动后的位置找蓝箭头
      const x1 = ((await a.doc()).elems[1] as { x: number }).x;
      p = arrowAt(a, [x1 + 5, 2.5, 0], 2);
      await a.glide(p, 600); await a.wait(250);
      await a.keysShow(['按住箭头拖']); await a.down();
      await a.glide({ x: p.x, y: p.y - 60 }, 900); await a.wait(150); await a.up(); await a.keysClear(); await a.wait(500);
    },
  },
  {
    name: 'op-grab',
    async setup(a) { await a.setDoc([box(0, 0, 10, 5), box(0, 12, 10, 5)]); await a.view([8, -24, 17], [10, 5, 0]); await a.center([10, 6, 0]); await a.select([1]); },
    async act(a) {
      await a.at([5, 2.5, 0], 500); await a.wait(200);
      await a.press('g'); await a.wait(200);
      const p = a.P([11, -3, 0]); await a.glide(p, 900); await a.wait(200);
      await a.press('x'); await a.wait(300);
      await a.glide({ x: p.x + 60, y: p.y - 30 }, 600); await a.wait(200);
      await a.press('1', [], { ms: 1400 }); await a.press('5', [], { ms: 1200 }); await a.wait(500);
      await a.press('Enter'); await a.wait(700);
      await a.press('g'); await a.glide({ x: p.x - 40, y: p.y + 60 }, 700); await a.wait(200);
      await a.keysShow(['右键'], 700); await a.click('right'); await a.wait(500);
    },
  },
  {
    name: 'op-rotate',
    async setup(a) { await a.setDoc([box(0, 0, 20, 5)]); await a.view([10, -20, 22], [10, 2.5, 0]); await a.center([10, 2.5, 0]); await a.select([1]); },
    async act(a) {
      // 按 2 切到旋转工具：按住蓝色圆环（绕竖直轴）拖一圈的四分之一
      await a.press('2', [], { ms: 1000 }); await a.wait(500);
      const r = a.gizmo().rot!;
      const c = a.P(r.p), k = r.s * 0.7071;
      const s0 = a.P([r.p[0] + k, r.p[1] - k, r.p[2]]);
      const rad = Math.hypot(s0.x - c.x, s0.y - c.y), a0 = (Math.atan2(c.y - s0.y, s0.x - c.x) * 180) / Math.PI;
      await a.glide(s0, 500); await a.wait(200);
      await a.keysShow(['按住圆环拖']); await a.down();
      await arc(a, c, rad, a0, a0 + 90, 1400); await a.wait(200); await a.up(); await a.keysClear(); await a.wait(700);
    },
  },
  {
    name: 'op-dup',
    async setup(a) { await a.setDoc([box(0, 0, 10, 5)]); await a.view([12, -22, 17], [12, 3, 0]); await a.center([10, 2.5, 0]); await a.select([1]); },
    async act(a) {
      await a.at([5, 2.5, 0], 500); await a.wait(200);
      await a.press('d', ['Shift']); await a.wait(200);
      await a.glide(a.P([18, 2.5, 0]), 1000); await a.wait(200);
      await a.keysShow(['左键'], 600); await a.click(); await a.wait(700);
      await a.press('x'); await a.wait(700);
    },
  },
  // ---------------- 1.4 构建路面 ----------------
  {
    name: 'road-stretch',
    async setup(a) { await a.setDoc([box(0, 0, 15, 5)]); await a.view([4, -24, 16], [14, 2.5, 0]); await a.center([14, 2.5, 0]); await a.select([1]); },
    async act(a) {
      /** 按住一个抓点，屏幕上拖 (dx, dy) */
      const pull = async (kind: string, dx: number, dy: number) => {
        const h = a.gizmo().handles.find((x) => x.kind === kind && (kind !== 'size' && kind !== 'tilt' || x.p[0] > 10))!;
        const p = a.P(h.p);
        await a.glide(p, 450); await a.wait(150);
        await a.keysShow(['按住拖']); await a.down();
        await a.glide({ x: p.x + dx, y: p.y + dy }, 800); await a.wait(150); await a.up(); await a.keysClear(); await a.wait(350);
      };
      // 按 3 切到拉伸工具：拖右边的蓝色方块拉长，拖底边上的橙色方块加厚
      await a.press('3', [], { ms: 1000 }); await a.wait(400);
      await pull('size', 120, -25);
      await pull('thick', 0, 50);
      // 按 4 切到坡面工具：拖右边的黄色圆圈往上拉
      await a.press('4', [], { ms: 1000 }); await a.wait(400);
      await pull('tilt', 0, -55); await a.wait(400);
    },
  },
  {
    name: 'road-auto',
    async setup(a) { await a.setDoc([box(0, 0, 30, 5), box(12.5, 8, 5, 12)]); await a.view([15, -16, 22], [15, 8, 0]); await a.center([15, 6, 0]); await a.select([2]); },
    async act(a) {
      await a.at([15, 12, 0], 500); await a.wait(200);
      await a.press('g'); await a.press('z');
      await a.glide(a.P([15, 8.5, 0]), 900); await a.wait(300);
      await a.press('-', [], { ms: 1200 }); await a.press('3', [], { ms: 1000 }); await a.wait(300);
      await a.press('Enter'); await a.wait(900);
    },
  },
  {
    name: 'road-open',
    props: true,
    async setup(a) { await a.setDoc([box(0, 0, 10, 5), box(10, 0, 10, 5)]); await a.view([6, -15, 13], [10, 2.5, 0]); await a.select([1]); await a.center([10, 2.5, 0]); },
    async act(a) {
      // 按 6 进入花纹模式，四条边的中点出现圆圈
      await a.press('6', [], { ms: 1000 }); await a.wait(400);
      for (let i = 0; i < 3; i++) {
        await a.at([10, 2.5, 0.05], 500); await a.wait(250);
        await a.keysShow(['左键'], 600); await a.click(); await a.wait(900);
      }
    },
  },
  // ---------------- 1.5 切分与合并 ----------------
  {
    name: 'split-slope',
    async setup(a) { await a.setDoc([box(0, 0, 30, 5)]); await a.view([6, -24, 16], [15, 2.5, 0]); await a.center([15, 2.5, 0]); },
    async act(a) {
      await a.press('5'); await a.wait(300);
      await a.at([15, 2.5, 0], 700); await a.wait(300);
      await a.keysShow(['左键'], 600); await a.click(); await a.wait(500);
      await a.keysShow(['右键：退出切分'], 800); await a.click('right'); await a.wait(300);
      await a.at([24, 2.5, 0], 500); await a.keysShow(['左键'], 600); await a.click(); await a.wait(500);
      await a.drag([28.5, 2.5, 0], [28.5, 2.5, 4], { mods: ['Alt'], ms: 1100 });
    },
  },
  {
    name: 'merge',
    async setup(a) { await a.setDoc([box(0, 0, 10, 5), box(10, 0, 10, 5), box(0, 12, 10, 5), box(5, 17, 5, 6)]); await a.view([10, -16, 26], [10, 9, 0]); await a.center([10, 10, 0]); },
    async act(a) {
      await a.at([4, 2.5, 0], 500); await a.keysShow(['左键'], 500); await a.click(); await a.wait(300);
      let rel = await a.hold(['Shift']); await a.at([15, 2.5, 0], 500); await a.keysShow(['Shift', '左键'], 600); await a.click(); await rel(); await a.wait(400);
      await a.press('j', ['Control']); await a.wait(900);
      // L 形拼不成矩形：合并不了（会提示原因）
      await a.at([3, 14.5, 0], 600); await a.keysShow(['左键'], 500); await a.click(); await a.wait(300);
      rel = await a.hold(['Shift']); await a.at([7.5, 20, 0], 500); await a.keysShow(['Shift', '左键'], 600); await a.click(); await rel(); await a.wait(300);
      await a.press('j', ['Control']); await a.wait(1200);
    },
  },
  // ---------------- 1.6 大规模操作 ----------------
  {
    name: 'group',
    async setup(a) { await a.setDoc([box(0, 0, 20, 5), obj('P_Box', 5, 2.5, 2.5), obj('P_Extra_Point', 14, 2.5, 2.5)]); await a.view([10, -18, 20], [10, 4, 0]); await a.center([10, 3, 0]); },
    async act(a) {
      const p0 = a.P([-2, -3, 0]), p1 = a.P([22, 8, 0]);
      await a.dragScreen({ x: p0.x - 20, y: p0.y + 25 }, { x: p1.x + 20, y: p1.y - 25 }, { ms: 900, keys: ['拖动框选'] });
      await a.press('g', ['Control']); await a.wait(500);
      await a.glide({ x: p0.x - 50, y: p0.y + 50 }, 500); await a.keysShow(['左键'], 500); await a.click(); await a.wait(400);
      await a.at([5, 2.5, 2.5], 600); await a.keysShow(['左键'], 500); await a.click(); await a.wait(700);
      const q = a.P([5, 2.5, 2.5]);
      await a.press('g'); await a.glide({ x: q.x + 100, y: q.y + 30 }, 900); await a.keysShow(['左键'], 500); await a.click(); await a.wait(600);
      await a.press('g', ['Control', 'Shift']); await a.wait(600);
    },
  },
  // ---------------- 1.7 精细控制 ----------------
  {
    name: 'align',
    async setup(a) { await a.setDoc([box(0, 0, 10, 5), box(14, 9, 10, 5)]); await a.view([10, -18, 20], [12, 5, 0]); await a.center([12, 6, 0]); await a.select([2]); },
    async act(a) {
      await a.at([19, 11.5, 0], 500); await a.press('g');
      await a.glide(a.P([15.8, 4, 0]), 900); await a.wait(150);
      await a.glide(a.P([15.06, 2.56, 0]), 500); await a.wait(700);
      await a.keysShow(['左键'], 600); await a.click(); await a.wait(700);
    },
  },
  {
    name: 'vsnap',
    async setup(a) {
      // 第二块转了 30°：坐标在它自己的朝向坐标系里；它的左下角在世界里是 (18, 8)
      const r = (30 * Math.PI) / 180, wx = 18, wy = 8;
      const lx = wx * Math.cos(r) + wy * Math.sin(r), ly = -wx * Math.sin(r) + wy * Math.cos(r);
      await a.setDoc([box(0, 0, 10, 5), box(lx, ly, 10, 5, { ang: 30 })]); await a.view([8, -18, 22], [12, 6, 0]); await a.center([12, 6, 0]); await a.select([2]);
    },
    async act(a) {
      await a.keysShow(['按住 V']); await a.keyDown('v'); await a.wait(60);
      await a.at([18, 8, 0], 700); await a.wait(400);
      await a.keysShow(['按住 V', '左键拖']);
      await a.down(); await a.glide(a.P([10.6, 5.4, 0]), 900); await a.glide(a.P([10, 5, 0]), 400); await a.wait(400); await a.up();
      await a.keyUp('v'); await a.keysShow(['松开'], 700); await a.wait(900);
    },
  },
  {
    name: 'grid',
    async setup(a) { await a.setDoc([box(0, 0, 10, 5)]); await a.view([4, -18, 13], [10, 2.5, 0]); await a.center([10, 2.5, 0]); await a.select([1]); },
    async act(a) {
      await a.press('Tab', ['Shift']); await a.wait(500);
      await a.drag([9.6, 2.5, 0], [17.4, 2.5, 0], { mods: ['Control'], ms: 1800 });
      await a.press('Tab', ['Shift']); await a.wait(500);
      await a.drag([17.4, 2.5, 0], [12.3, 2.5, 0], { mods: ['Control'], ms: 1400 });
    },
  },
  // ---------------- 2.1 路面 ----------------
  {
    name: 'box-model',
    async setup(a) { await a.setDoc([box(0, 0, 30, 5), box(12.5, -12.5, 5, 30), box(22, 8, 5, 10)]); await a.view([12, -22, 30], [14, 2, 0]); await a.center([14, 2, 0]); await a.select([3]); },
    async act(a) {
      await a.at([24.5, 13, 0], 500); await a.press('g'); await a.press('x');
      await a.glide(a.P([8, 13, 0]), 1600); await a.wait(300);
      await a.glide(a.P([19, 13, 0]), 1200); await a.wait(300);
      await a.keysShow(['左键'], 500); await a.click(); await a.wait(500);
    },
  },
  {
    name: 'transition',
    async setup(a) {
      await a.setDoc([box(0, 0, 15, 5), box(20, 0, 15, 5, { style: 'sink' }), { kind: 'piece', type: 'transition', x: 17.5, y: 10, z: 0, rot: 0 }]);
      await a.view([10, -18, 17], [17, 4, 0]); await a.center([17.5, 5, 0]);
    },
    async act(a) {
      await a.at([17.5, 10, 0], 500); await a.keysShow(['左键'], 500); await a.click(); await a.wait(400);
      await a.press('g'); await a.press('z'); await a.glide(a.P([17.5, 6, 0]), 600);
      for (const k of ['-', '7', '.', '5']) await a.press(k, [], { ms: 900 });
      await a.press('Enter'); await a.wait(1200);
    },
  },
  {
    name: 'platform',
    async setup(a) { await a.setDoc([box(0, 0, 20, 20, { style: 'sink' }), box(23, 7.5, 15, 5)]); await a.view([28, -14, 20], [20, 10, 0]); await a.center([22, 10, 0]); await a.select([2]); },
    async act(a) {
      await a.at([30, 10, 0], 500); await a.press('g'); await a.press('x');
      await a.glide(a.P([27, 10, 0]), 700);
      await a.press('-', [], { ms: 900 }); await a.press('3', [], { ms: 900 }); await a.press('Enter'); await a.wait(500);
      await a.fly([26, 0, 9], [20, 10, 0], 1200); await a.wait(900);
    },
  },
  // ---------------- 2.2 钢轨 ----------------
  {
    name: 'rail-kinds',
    props: true,
    async setup(a) { await a.setDoc([rail(0, 0, 0, [straight(15)])]); await a.view([4, -16, 12], [10, 0, 0]); await a.select([1]); await a.center([12, 0, 0]); },
    async act(a) {
      await a.clickEl('#props select[data-rf="kind"] + .sel-btn'); await a.clickText('.dropdown-menu.sel-pop button', '单轨'); await a.wait(500);
      await a.clickEl('#props select[data-rf="kind"] + .sel-btn'); await a.clickText('.dropdown-menu.sel-pop button', '单双转换'); await a.wait(500);
      await a.drag([15, 0, 0.3], [24, 0, 0.3], { mods: ['Control'], ms: 1100 });
    },
  },
  {
    name: 'rail-curve',
    props: true,
    async setup(a) {
      await a.setDoc([rail(0, 0, 0, [{ kind: 'double', len: 0, radius: 10, angle: 90, dz: 0 }]), rail(30, 0, 0, [{ kind: 'mono', len: 0, radius: 6, angle: 360, dz: 3.6 }])]);
      await a.view([16, -30, 26], [18, 8, 2]); await a.select([1]); await a.center([20, 6, 0]);
    },
    async act(a) {
      await a.typeInto('#props input[data-rf="angle"]', '180'); await a.wait(800);
      // 螺旋从 (30, 0) 出发往左绕，圆心 (30, 6)、半径 6：转过四分之一圈时在 (36, 6)，高 0.9
      await a.at([36, 6, 1.2], 600); await a.keysShow(['左键'], 500); await a.click(); await a.select([2]); await a.wait(500);
      await a.typeInto('#props input[data-rf="turns"]', '3'); await a.wait(1000);
    },
  },
  {
    name: 'rail-side',
    props: true,
    // 侧轨先放在路外，按 G 拖到路边，靠近时贴住最近的路边；再在属性里把两头的上轨弯下去
    async setup(a) {
      await a.setDoc([box(0, 0, 30, 5), rail(5, 12, 0, [straight(20)], { side: { dir: 1 } })]);
      await a.view([10, -18, 17], [14, 5, 0]); await a.select([2]); await a.center([15, 5, 0]);
    },
    async act(a) {
      await a.at([15, 12, 0], 500); await a.press('g');
      await a.glide(a.P([15, 5.2, 0]), 1000); await a.wait(300);
      await a.keysShow(['左键'], 500); await a.click(); await a.wait(500);
      await a.clickEl('#props [data-seg="end-0"] [data-v="bend"]'); await a.wait(600);
      await a.clickEl('#props [data-seg="end-1"] [data-v="bend"]'); await a.wait(800);
    },
  },
  {
    name: 'rail-tip',
    props: true,
    async setup(a) { await a.setDoc([rail(0, 0, 0, [straight(12)]), rail(18, 0, 0, [straight(4, 'mono')])]); await a.view([6, -14, 9], [12, 0, 0]); await a.select([1]); await a.center([12, 0, 0]); },
    async act(a) {
      await a.clickEl('#props [data-seg="tip-1"] [data-v="round"]'); await a.wait(900);
      await a.at([20, 0, 0], 600); await a.keysShow(['左键'], 500); await a.click(); await a.select([2]); await a.wait(500);
      const c = a.P([20, 0, 0]);
      await a.glide({ x: c.x + 100, y: c.y }, 400);
      await a.press('r'); await a.press('z'); await a.wait(200);
      await a.press('9', [], { ms: 900 }); await a.press('0', [], { ms: 900 }); await a.press('Enter'); await a.wait(1000);
    },
  },
  // ---------------- 2.3 机关 ----------------
  {
    name: 'module-anchor',
    // 推板先放在路外，拖手柄把它移到两段路之间：两个对准方块嵌进路端，路端自动开口
    async setup(a) {
      await a.setDoc([box(0, -2.5, 20, 5), box(-30.06, -2.5, 20, 5), obj('P_Modul_25', 0, 14, 0)]);
      await a.view([-6, -26, 22], [-5, 4, 0]); await a.center([-5, 5, 0]); await a.select([3]);
    },
    async act(a) {
      // 用 G + Y 输入距离：沿 Y 移 -14，两个对准方块正好嵌进两段路的端头
      const p = a.P([-5, 14, 0]);
      await a.glide(p, 500); await a.press('g'); await a.press('z'); await a.wait(200);
      await a.glide({ x: p.x, y: p.y + 60 }, 600);
      for (const k of ['-', '1', '4']) await a.press(k, [], { ms: 900 });
      await a.press('Enter'); await a.wait(1400);
    },
  },
  {
    name: 'module-stopper',
    // 推板的挡块：点圆圈关掉、再打开；风扇移到路上，脚下自动换成风扇底座
    async setup(a) {
      await a.setDoc([box(0, -2.5, 20, 5), box(-30.06, -2.5, 20, 5), obj('P_Modul_25', 0, 0, 0), box(26, -2.5, 15, 5), obj('P_Modul_18', 33.5, 12, -0.34)]);
      await a.view([-2, -24, 16], [4, 0, 0]); await a.center([0, 0, 0]); await a.select([3]);
    },
    async act(a) {
      // 按 6 进入花纹模式；推板只有一块挡块，顶面中心在本地 (-9.558, 0, -0.5)
      await a.press('6', [], { ms: 900 }); await a.wait(300);
      await a.at([-9.558, 0, -0.45], 500); await a.keysShow(['左键'], 500); await a.click(); await a.wait(900);
      await a.keysShow(['左键'], 500); await a.click(); await a.wait(500);
      await a.fly([22, -22, 18], [33, 4, 0], 700);
      await a.at([33.5, 12, 0], 400); await a.keysShow(['左键'], 400); await a.click(); await a.wait(200);
      await a.press('g'); await a.press('z'); await a.glide(a.P([33.5, 6, 0]), 500);
      for (const k of ['-', '1', '2']) await a.press(k, [], { ms: 900 });
      await a.press('Enter'); await a.wait(1100);
    },
  },
  // ---------------- 2.4 装饰 ----------------
  {
    name: 'guard',
    // L 形路面：横的一段 (0, 0)～(30, 5)，竖的一段 (25, 5)～(30, 25)。
    // 先单击内侧直边（y = 5），两头各内缩 1.5；再从外侧前边 x = 1.5 处（和内侧护栏的左端对齐）沿路边拖过外拐角，拖到竖的一段顶端前 1.5
    async setup(a) { await a.setDoc([box(0, 0, 30, 5), box(25, 5, 5, 20)]); await a.view([6, -22, 26], [16, 8, 0]); await a.center([16, 8, 0]); },
    async act(a) {
      await a.press('h'); await a.wait(300);
      await a.at([12, 5, 0], 600); await a.wait(300); await a.keysShow(['左键'], 600); await a.click(); await a.wait(800);
      await a.at([1.5, 0, 0], 600); await a.wait(250);
      await a.keysShow(['沿路边拖']);
      await a.down();
      for (const w of [[30, 0, 0], [30, 23.5, 0]]) await a.glide(a.P(w), 900);
      await a.wait(200); await a.up(); await a.keysClear(); await a.wait(700);
      await a.press('Escape'); await a.wait(400);
    },
  },
  {
    name: 'column',
    // 柱子先放在旁边，G 移到悬空路面的正下方：柱头吸到路面底下
    async setup(a) { await a.setDoc([box(0, 0, 15, 5, { z: 12 }), obj('LaternColumn', 22, 2.5, 12 - 98.51)]); await a.view([4, -34, 16], [12, 2.5, 4]); await a.center([12, 2.5, 6]); await a.select([2]); },
    async act(a) {
      await a.at([22, 2.5, 6], 500); await a.press('g'); await a.press('x');
      await a.glide(a.P([10, 2.5, 6]), 600);
      for (const k of ['-', '1', '4', '.', '5']) await a.press(k, [], { ms: 900 });
      await a.press('Enter'); await a.wait(1300);
    },
  },
  // ---------------- 2.5 死亡区 ----------------
  {
    name: 'zone',
    // 路面下方的死亡区，Ctrl 拖一边把它拉成一大片
    async setup(a) { await a.setDoc([box(0, 0, 30, 5, { z: 10 }), { kind: 'zone', x: 10, y: -5, z: -6, sx: 10, sy: 10, depth: 5 }]); await a.view([8, -40, 26], [15, 2.5, -4]); await a.center([15, 2, -4]); await a.select([2]); },
    async act(a) {
      await a.drag([19.6, 0, -6], [34, 0, -6], { mods: ['Control'], ms: 1100 });
      await a.drag([10.4, 0, -6], [-4, 0, -6], { mods: ['Control'], ms: 1100 }); await a.wait(600);
    },
  },
];
