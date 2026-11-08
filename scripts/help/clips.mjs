// 帮助教程的分镜：每段一个名字（输出 public/help/<名字>.webp，和 src/box/help.md 里的 ![](名字) 对应）。
//   setup：录制前摆好场景、视角（不录）；act：录下来的操作；teardown：录完的收尾（不录）。still: true 的是截图，只要 setup 之后的一帧。
//   坐标都是世界坐标（Z 向上），路面默认厚 5、顶面 z = 0。

const box = (x, y, sx, sy, o = {}) => ({ kind: 'box', x, y, z: 0, sx, sy, depth: 5, style: 'normal', ...o });
const obj = (type, x, y, z = 0, rot = 0, o = {}) => ({ kind: 'obj', type, x, y, z, rot, ...o });
const rail = (x, y, z, pieces, o = {}) => ({ kind: 'rail', x, y, z, heading: 0, pieces, ...o });
const straight = (len, kind = 'double') => ({ kind, len, radius: 0, angle: 0, dz: 0 });

/** 默认场景：起点 → 路 → 小节盘点 → 路 → 终点气球 */
const DEFAULT = [
  { id: 1, kind: 'piece', type: 'start', x: 0, y: 0, z: 0, rot: 0 },
  { id: 6, ...box(7.386, -2.5, 15, 5) },
  { id: 7, kind: 'piece', type: 'check', x: 27.31, y: 0, z: 0, rot: 0 },
  { id: 8, ...box(32.234, -2.5, 15, 5) },
  { id: 9, ...obj('PE_Balloon', 69.304, 0.17, -0.01, 2) },
];

/** 绕屏幕点 c 画一段圆弧（旋转模式里用鼠标转） */
async function arc({ glide }, c, r, a0, a1, ms) {
  const n = 8;
  for (let i = 1; i <= n; i++) {
    const a = ((a0 + ((a1 - a0) * i) / n) * Math.PI) / 180;
    await glide({ x: c.x + r * Math.cos(a), y: c.y - r * Math.sin(a) }, ms / n);
  }
}

export const CLIPS = [
  // ---------------- 1.1 界面一览（截图） ----------------
  {
    name: 'ui-overview', still: true,
    async setup({ setDoc, view, select, js }) {
      await setDoc(DEFAULT); await view([22, -34, 26], [30, 2, 0]); await select([6]);
      await js(`(() => {
        const css = document.createElement('style');
        css.textContent = '.rec-badge{position:fixed;z-index:99990;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;background:#ff7a1a;color:#fff;font:700 17px/30px "Segoe UI",sans-serif;text-align:center;box-shadow:0 0 0 3px rgba(255,255,255,.9),0 4px 12px rgba(0,0,0,.35)}';
        document.head.appendChild(css);
        const put = (n, x, y) => { const b = document.createElement('div'); b.className = 'rec-badge'; b.textContent = n; b.style.left = x + 'px'; b.style.top = y + 'px'; document.body.appendChild(b); };
        const r = (s) => document.querySelector(s).getBoundingClientRect();
        const tb = r('#toolbar'), pal = r('#palette'), pr = r('#props'), vp = r('#viewport'), sb = r('#statusbar');
        put('①', tb.left + tb.width * 0.43, tb.bottom - 4);
        put('②', pal.left + pal.width / 2, pal.top + 26);
        put('③', pr.right - 6, pr.top + 22);
        put('④', vp.left + vp.width * 0.62, vp.top + vp.height * 0.72);
        put('⑤', sb.left + 160, sb.top + 2);
        return 1;
      })()`);
    },
  },
  // ---------------- 1.2 视角 ----------------
  {
    name: 'view-orbit',
    async setup({ center, setDoc, view }) { await setDoc(DEFAULT); await view([24, -46, 32], [32, 0, 0]); await center([34, 0, 0], 498); },
    async act({ dragScreen, wheel, glide, wait, elCenter, click, keysShow, keysClear }) {
      await dragScreen({ x: 460, y: 430 }, { x: 700, y: 410 }, { button: 'middle', ms: 1100, keys: ['中键'] });
      await dragScreen({ x: 560, y: 430 }, { x: 440, y: 380 }, { button: 'middle', mods: ['Shift'], ms: 800, keys: ['Shift', '中键'] });
      await glide({ x: 480, y: 400 }, 200);
      await keysShow(['滚轮'], 0); await wheel(-120, 3); await keysClear(); await wait(250);
      { const c = await elCenter('#viewcube canvas'); await glide({ x: c.x, y: c.y - 20 }, 450); await keysShow(['左键'], 500); await click(); } await wait(900);
      await dragScreen({ x: 480, y: 420 }, { x: 560, y: 440 }, { button: 'middle', ms: 600, keys: ['中键'] });
    },
  },
  {
    name: 'view-focus',
    async setup({ setDoc, view }) { await setDoc(DEFAULT); await view([-6, -30, 22], [6, 0, 0]); },
    async act({ at, click, wait, press, glide, keysShow }) {
      await at([28, 0, 0], 500); await keysShow(['左键'], 600); await click(); await wait(950);
      await at([44, 0, 0], 450); await keysShow(['左键'], 600); await click(); await wait(950);
      await press('f'); await wait(1000);
      await glide({ x: 300, y: 140 }, 450); await keysShow(['左键'], 500); await click(); await wait(150);
      await press('f'); await wait(1000);
    },
  },
  {
    name: 'view-fly',
    // 视线朝下看着路（约 28°）：W 顺着视线飞会往下掉，中间按一会儿空格把高度补回来；左右转视角、左右平移，最后转回原来的方向
    async setup({ setDoc, view }) { await setDoc(DEFAULT); await view([-26, 0, 15], [2, 0, 0]); },
    async act({ glide, down, up, keyDown, keyUp, keysShow, keysClear, wait, mouse }) {
      await glide({ x: 500, y: 330 }, 300);
      await keysShow(['按住右键'], 0);
      await down('right'); await wait(200);
      await keysShow(['按住右键', 'W'], 0);
      await keyDown('w');
      let m = mouse(); await glide({ x: m.x + 50, y: m.y }, 450);
      await keysShow(['按住右键', 'W', 'Space'], 0);
      await keyDown(' '); m = mouse(); await glide({ x: m.x + 30, y: m.y }, 600); await keyUp(' ');
      await keysShow(['按住右键', 'W'], 0);
      m = mouse(); await glide({ x: m.x - 80, y: m.y }, 450);
      await keyUp('w');
      await keysShow(['按住右键', 'A'], 0);
      await keyDown('a'); await wait(550); await keyUp('a');
      await keysShow(['按住右键', 'D'], 0);
      await keyDown('d'); await wait(550); await keyUp('d');
      await keysShow(['松开右键'], 700);
      await up('right'); await wait(400);
      await keysClear();
    },
  },
  // ---------------- 1.3 基本操作 ----------------
  {
    name: 'op-place', full: true,
    async setup({ center, setDoc, view }) { await setDoc([box(0, 0, 15, 5)]); await view([10, -26, 19], [12, 5, 0]); await center([14, 6, 0], 498); },
    async act({ place, wait }) {
      await place('road', '平路', [15.2, 0.1, 0]);
      await place('road', '凹路', [5, 12, 0], { rot: 1 });
      await place('road', '细边框凹路', [22, 12, 0], { cancel: true, ms: 500 });
    },
  },
  {
    name: 'op-grab',
    async setup({ center, setDoc, view, select }) { await setDoc([box(0, 0, 10, 5), box(0, 12, 10, 5)]); await view([8, -24, 17], [10, 5, 0]); await center([10, 6, 0]); await select([1]); },
    async act({ at, glide, press, wait, P, click, keysShow }) {
      await at([5, 2.5, 0], 500); await wait(200);
      await press('g'); await wait(200);
      const p = await P([11, -3, 0]); await glide(p, 900); await wait(200);
      await press('x'); await wait(300);
      await glide({ x: p.x + 60, y: p.y - 30 }, 600); await wait(200);
      await press('1', [], { ms: 1400 }); await press('5', [], { ms: 1200 }); await wait(500);
      await press('Enter'); await wait(700);
      await press('g'); await glide({ x: p.x - 40, y: p.y + 60 }, 700); await wait(200);
      await keysShow(['右键'], 700); await click('right'); await wait(500);
    },
  },
  {
    name: 'op-rotate',
    async setup({ center, setDoc, view, select }) { await setDoc([box(0, 0, 20, 5)]); await view([10, -20, 22], [10, 2.5, 0]); await center([10, 2.5, 0]); await select([1]); },
    async act(api) {
      const { P, glide, press, wait, click, keysShow } = api;
      const c = await P([10, 2.5, 0]);
      await glide({ x: c.x + 170, y: c.y }, 500); await wait(200);
      await press('r'); await wait(200);
      await arc(api, c, 170, 0, 90, 1400); await wait(300);
      await keysShow(['左键'], 600); await click(); await wait(600);
      await glide({ x: c.x + 170, y: c.y }, 500);
      await press('r'); await wait(200);
      await arc(api, c, 170, 0, 45, 900); await wait(300);
      await keysShow(['左键'], 600); await click(); await wait(500);
    },
  },
  {
    name: 'op-dup',
    async setup({ center, setDoc, view, select }) { await setDoc([box(0, 0, 10, 5)]); await view([12, -22, 17], [12, 3, 0]); await center([10, 2.5, 0]); await select([1]); },
    async act({ at, press, glide, P, wait, click, keysShow }) {
      await at([5, 2.5, 0], 500); await wait(200);
      await press('d', ['Shift']); await wait(200);
      await glide(await P([18, 2.5, 0]), 1000); await wait(200);
      await keysShow(['左键'], 600); await click(); await wait(700);
      await press('x'); await wait(700);
    },
  },
  // ---------------- 1.4 构建路面 ----------------
  {
    name: 'road-stretch',
    async setup({ center, setDoc, view, select }) { await setDoc([box(0, 0, 15, 5)]); await view([4, -24, 16], [14, 2.5, 0]); await center([14, 2.5, 0]); await select([1]); },
    async act({ drag, wait, fly }) {
      await drag([14.6, 2.5, 0], [24.6, 2.5, 0], { mods: ['Control'], ms: 900 });
      await drag([23.5, 2.5, 0], [23.5, 2.5, 4], { mods: ['Alt'], ms: 800 });
      await drag([6, 2.5, 0], [6, 2.5, -5], { mods: ['Control', 'Alt'], ms: 900 }); await wait(500);
    },
  },
  {
    name: 'road-auto',
    async setup({ center, setDoc, view, select }) { await setDoc([box(0, 0, 30, 5), box(12.5, 8, 5, 12)]); await view([15, -16, 22], [15, 8, 0]); await center([15, 6, 0]); await select([2]); },
    async act({ at, press, wait, glide, P }) {
      await at([15, 12, 0], 500); await wait(200);
      await press('g'); await press('y');
      await glide(await P([15, 8.5, 0]), 900); await wait(300);
      await press('-', [], { ms: 1200 }); await press('3', [], { ms: 1000 }); await wait(300);
      await press('Enter'); await wait(900);
    },
  },
  {
    name: 'road-open',
    async setup({ center, setDoc, view, select }) { await setDoc([box(0, 0, 10, 5), box(10, 0, 10, 5)]); await view([6, -15, 13], [10, 2.5, 0]); await center([10, 2.5, 0]); await select([1]); },
    async act({ at, click, wait, keysShow }) {
      for (let i = 0; i < 3; i++) {
        await at([10, 2.5, 0.05], 500); await wait(250);
        await keysShow(['左键'], 600); await click(); await wait(900);
      }
    },
  },
  // ---------------- 1.5 切分与合并 ----------------
  {
    name: 'split-slope',
    async setup({ center, setDoc, view }) { await setDoc([box(0, 0, 30, 5)]); await view([6, -24, 16], [15, 2.5, 0]); await center([15, 2.5, 0], 498); },
    async act({ press, at, click, wait, drag, keysShow }) {
      await press('3'); await wait(300);
      await at([15, 2.5, 0], 700); await wait(300);
      await keysShow(['左键'], 600); await click(); await wait(500);
      await press('Escape'); await wait(300);
      await at([24, 2.5, 0], 500); await keysShow(['左键'], 600); await click(); await wait(500);
      await drag([28.5, 2.5, 0], [28.5, 2.5, 4], { mods: ['Alt'], ms: 1100 });
    },
  },
  {
    name: 'merge', full: true, tips: true,
    async setup({ center, setDoc, view }) { await setDoc([box(0, 0, 10, 5), box(10, 0, 10, 5), box(0, 12, 10, 5), box(5, 17, 5, 6)]); await view([10, -16, 26], [10, 9, 0]); await center([10, 10, 0], 498); },
    async act({ at, click, wait, press, hold, keysShow, clickEl, elCenter, glide }) {
      await at([4, 2.5, 0], 500); await keysShow(['左键'], 500); await click(); await wait(300);
      let rel = await hold(['Shift']); await at([15, 2.5, 0], 500); await keysShow(['Shift', '左键'], 600); await click(); await rel(); await wait(400);
      await press('j', ['Control']); await wait(900);
      await at([3, 14.5, 0], 600); await keysShow(['左键'], 500); await click(); await wait(300);
      rel = await hold(['Shift']); await at([7.5, 20, 0], 500); await keysShow(['Shift', '左键'], 600); await click(); await rel(); await wait(300);
      await glide(await elCenter('#merge'), 700); await wait(1200);
      void clickEl;
    },
  },
  // ---------------- 1.6 大规模操作 ----------------
  {
    name: 'group',
    async setup({ center, setDoc, view }) { await setDoc([box(0, 0, 20, 5), obj('P_Box', 5, 2.5, 2.5), obj('P_Extra_Point', 14, 2.5, 2.5)]); await view([10, -18, 20], [10, 4, 0]); await center([10, 3, 0], 498); },
    async act({ P, dragScreen, press, glide, click, wait, at, keysShow }) {
      const a = await P([-2, -3, 0]), b = await P([22, 8, 0]);
      await dragScreen({ x: a.x - 20, y: a.y + 25 }, { x: b.x + 20, y: b.y - 25 }, { ms: 900, keys: ['拖动框选'] });
      await press('g', ['Control']); await wait(500);
      await glide({ x: a.x - 60, y: a.y + 60 }, 500); await keysShow(['左键'], 500); await click(); await wait(400);
      await at([5, 2.5, 2.5], 600); await keysShow(['左键'], 500); await click(); await wait(700);
      await press('g'); await glide({ x: (await P([5, 2.5, 2.5])).x + 120, y: (await P([5, 2.5, 2.5])).y + 40 }, 900); await keysShow(['左键'], 500); await click(); await wait(600);
      await press('g', ['Control', 'Shift']); await wait(600);
    },
  },
  // ---------------- 1.7 精细控制 ----------------
  {
    name: 'align',
    async setup({ center, setDoc, view, select }) { await setDoc([box(0, 0, 10, 5), box(14, 9, 10, 5)]); await view([10, -18, 20], [12, 5, 0]); await center([12, 6, 0]); await select([2]); },
    async act({ at, press, glide, P, wait, click, keysShow }) {
      await at([19, 11.5, 0], 500); await press('g');
      await glide(await P([15.8, 4, 0]), 900); await wait(150);
      await glide(await P([15.06, 2.56, 0]), 500); await wait(700);
      await keysShow(['左键'], 600); await click(); await wait(700);
    },
  },
  {
    name: 'vsnap',
    async setup({ center, setDoc, view, select }) {
      // 第二块转了 30°：坐标在它自己的朝向坐标系里
      const a = (30 * Math.PI) / 180, wx = 18, wy = 8;
      const lx = wx * Math.cos(a) + wy * Math.sin(a), ly = -wx * Math.sin(a) + wy * Math.cos(a);
      await setDoc([box(0, 0, 10, 5), box(lx, ly, 10, 5, { ang: 30 })]); await view([8, -18, 22], [12, 6, 0]); await center([12, 6, 0]); await select([2]);
    },
    async act({ keyDown, keyUp, at, down, up, glide, P, wait, keysShow, frame }) {
      // 转了 30° 的那一块，左下角（本地 x0、y0）在世界里的位置就是 (18, 8)
      await keysShow(['按住 V'], 0); await keyDown('v'); await frame(2);
      await at([18, 8, 0], 700); await wait(400);
      await keysShow(['按住 V', '左键拖动'], 0);
      await down(); await glide(await P([10.6, 5.4, 0]), 900); await glide(await P([10, 5, 0]), 400); await wait(400); await up();
      await keyUp('v'); await keysShow(['松开'], 700); await wait(900);
    },
  },
  {
    name: 'grid',
    async setup({ center, setDoc, view, select }) { await setDoc([box(0, 0, 10, 5)]); await view([4, -18, 13], [10, 2.5, 0]); await center([10, 2.5, 0]); await select([1]); },
    async act({ press, wait, drag, call }) {
      await press('Tab', ['Shift']); await wait(500);
      await drag([9.6, 2.5, 0], [17.4, 2.5, 0], { mods: ['Control'], ms: 1800 });
      await press('Tab', ['Shift']); await wait(500);
      await drag([17.4, 2.5, 0], [12.3, 2.5, 0], { mods: ['Control'], ms: 1400 });
      void call;
    },
  },
  // ---------------- 2.1 路面 ----------------
  {
    name: 'box-model',
    async setup({ center, setDoc, view, select }) { await setDoc([box(0, 0, 30, 5), box(12.5, -12.5, 5, 30), box(22, 8, 5, 10)]); await view([12, -22, 30], [14, 2, 0]); await center([14, 2, 0]); await select([3]); },
    async act({ at, press, glide, P, wait, click, keysShow }) {
      await at([24.5, 13, 0], 500); await press('g'); await press('x');
      await glide(await P([8, 13, 0]), 1600); await wait(300);
      await glide(await P([19, 13, 0]), 1200); await wait(300);
      await keysShow(['左键'], 500); await click(); await wait(500);
    },
  },
  {
    name: 'transition',
    async setup({ center, setDoc, view }) {
      await setDoc([box(0, 0, 15, 5), box(20, 0, 15, 5, { style: 'sink' }), { kind: 'piece', type: 'transition', x: 17.5, y: 10, z: 0, rot: 0 }]);
      await view([10, -18, 17], [17, 4, 0]); await center([17.5, 5, 0]);
    },
    async act({ at, click, press, glide, P, wait, keysShow }) {
      await at([17.5, 10, 0], 500); await keysShow(['左键'], 500); await click(); await wait(400);
      await press('g'); await press('y'); await glide(await P([17.5, 6, 0]), 600);
      await press('-', [], { ms: 900 }); await press('7', [], { ms: 900 }); await press('.', [], { ms: 900 }); await press('5', [], { ms: 900 });
      await press('Enter'); await wait(1200);
    },
  },
  {
    name: 'platform',
    async setup({ center, setDoc, view, select }) { await setDoc([box(0, 0, 20, 20, { style: 'sink' }), box(23, 7.5, 15, 5)]); await view([28, -14, 20], [20, 10, 0]); await center([22, 10, 0]); await select([2]); },
    async act({ at, press, glide, P, wait, fly }) {
      await at([30, 10, 0], 500); await press('g'); await press('x');
      await glide(await P([27, 10, 0]), 700);
      await press('-', [], { ms: 900 }); await press('3', [], { ms: 900 }); await press('Enter'); await wait(500);
      await fly([26, 0, 9], [20, 10, 0], 1200); await wait(900);
    },
  },
  // ---------------- 2.2 钢轨 ----------------
  {
    name: 'rail-kinds',
    async setup({ center, setDoc, view, select }) { await setDoc([rail(0, 0, 0, [straight(15)])]); await view([4, -16, 12], [10, 0, 0]); await center([12, 0, 0]); await select([1]); },
    async act({ clickEl, clickText, wait, drag }) {
      await clickEl('#props select[data-rf="kind"] + .sel-btn'); await clickText('.dropdown-menu.sel-pop button', '单轨'); await wait(500);
      await clickEl('#props select[data-rf="kind"] + .sel-btn'); await clickText('.dropdown-menu.sel-pop button', '单双转换'); await wait(500);
      await drag([15, 0, 0.3], [24, 0, 0.3], { mods: ['Control'], ms: 1100 });
    },
  },
  {
    name: 'rail-curve',
    async setup({ center, setDoc, view, select }) {
      await setDoc([rail(0, 0, 0, [{ kind: 'double', len: 0, radius: 10, angle: 90, dz: 0 }]), rail(30, 0, 0, [{ kind: 'mono', len: 0, radius: 6, angle: 360, dz: 3.6 }])]);
      await view([16, -30, 26], [18, 8, 2]); await center([20, 6, 0]); await select([1]);
    },
    async act({ typeInto, wait, select, at, click, keysShow }) {
      await typeInto('#props input[data-rf="angle"]', '180'); await wait(800);
      // 螺旋从 (30, 0) 出发往左绕，圆心 (30, 6)、半径 6：转过四分之一圈时在 (36, 6)，高 0.9
      await at([36, 6, 1.2], 600); await keysShow(['左键'], 500); await click(); await select([2]); await wait(500);
      await typeInto('#props input[data-rf="turns"]', '3'); await wait(1000);
    },
  },
  {
    name: 'rail-side', full: true,
    async setup({ center, setDoc, view }) { await setDoc([box(0, 0, 30, 5)]); await view([10, -18, 15], [14, 4, 0]); await center([15, 3, 0], 498); },
    async act({ place, wait, clickEl }) {
      await place('rail', '侧轨', [15, 4.6, 0]); await wait(600);
      await clickEl('#props [data-seg="end-0"] [data-v="bend"]'); await wait(800);
      await clickEl('#props [data-seg="end-1"] [data-v="bend"]'); await wait(900);
    },
  },
  {
    name: 'rail-tip',
    async setup({ center, setDoc, view, select }) { await setDoc([rail(0, 0, 0, [straight(12)]), rail(18, 0, 0, [straight(4, 'mono')])]); await view([6, -14, 9], [12, 0, 0]); await center([12, 0, 0]); await select([1]); },
    async act({ clickEl, wait, at, click, keysShow, press, glide, P, select }) {
      await clickEl('#props [data-seg="tip-1"] [data-v="round"]'); await wait(900);
      await at([20, 0, 0], 600); await keysShow(['左键'], 500); await click(); await select([2]); await wait(500);
      const c = await P([20, 0, 0]);
      await glide({ x: c.x + 120, y: c.y }, 400);
      await press('r'); await press('y'); await wait(200);
      await press('9', [], { ms: 900 }); await press('0', [], { ms: 900 }); await press('Enter'); await wait(1000);
    },
  },
  // ---------------- 2.3 机关 ----------------
  {
    name: 'sector', full: true,
    async setup({ center, setDoc, view, call }) {
      await setDoc(DEFAULT); await view([22, -30, 24], [34, 0, 0]); await center([34, 0, 0], 498);
      // 小节标签在录之前打开（「显示」菜单里的开关），录的时候只演示切换当前小节
      await call(() => { if (!document.getElementById('sector-eye').classList.contains('active')) document.getElementById('sector-eye').click(); document.body.click(); });
    },
    async act({ clickEl, clickText, wait, place }) {
      await clickEl('#sector', 350); await clickText('#sector-menu button', '第 2 小节', 300); await wait(250);
      // 拖卡片时鼠标对着的是对准方块的角，不是中心：落点往 -y 挪 2.5，箱子才在路中间
      await place('prop', '箱子', [40, -2.5, 2.5]); await wait(400);
      await clickEl('#props select[data-k="sector"] + .sel-btn', 350); await clickText('.dropdown-menu.sel-pop button', '第 1 小节', 300); await wait(700);
    },
    // 收尾（不录）：小节标签关掉，不影响后面的分镜
    async teardown({ call }) { await call(() => { document.getElementById('sector-eye').click(); document.body.click(); }); },
  },
  {
    name: 'module-anchor', full: true,
    async setup({ center, setDoc, view }) { await setDoc([box(0, -2.5, 20, 5), box(-30.06, -2.5, 20, 5)]); await view([-6, -26, 18], [-5, 0, 0]); await center([-5, 0, 0], 498); },
    async act({ place, wait }) {
      // 拖卡片时鼠标对着第一个对准方块的中心：机关原点 (0, 0) 时它在 (2.5, 0)，正好嵌进右边那段路的端头
      await place('module', '推板', [2.5, 0, 0], { ms: 1100 }); await wait(1200);
    },
  },
  {
    name: 'module-stopper', full: true,
    async setup({ center, setDoc, view, select }) {
      await setDoc([box(0, -2.5, 20, 5), box(-30.06, -2.5, 20, 5), obj('P_Modul_25', 0, 0, 0), box(26, -2.5, 15, 5)]);
      await view([-2, -24, 16], [4, 0, 0]); await center([0, 0, 0]); await select([3]);
    },
    async act({ at, click, wait, keysShow, place, fly }) {
      // 推板只有一块挡块，顶面中心在本地 (-9.558, 0, -0.5)
      await at([-9.558, 0, -0.45], 500); await keysShow(['左键'], 500); await click(); await wait(900);
      await keysShow(['左键'], 500); await click(); await wait(600);
      await fly([18, -22, 16], [30, 0, 0], 700);
      await place('module', '风扇', [33.5, 0, 0]); await wait(700);
    },
  },
  // ---------------- 2.4 装饰 ----------------
  {
    name: 'guard',
    // L 形路面：横的一段 (0, 0)～(30, 5)，竖的一段 (25, 5)～(30, 25)。
    // 先单击内侧直边（y = 5），两头各内缩 1.5；再从外侧前边 x = 1.5 处（和内侧护栏的左端对齐）沿路边拖过外拐角，拖到竖的一段顶端前 1.5
    async setup({ center, setDoc, view }) { await setDoc([box(0, 0, 30, 5), box(25, 5, 5, 20)]); await view([6, -22, 26], [16, 8, 0]); await center([16, 8, 0], 498); },
    async act({ press, at, click, wait, down, up, glide, P, keysShow, keysClear }) {
      await press('2'); await wait(300);
      await at([12, 5, 0], 600); await wait(300); await keysShow(['左键'], 600); await click(); await wait(800);
      await at([1.5, 0, 0], 600); await wait(250);
      await keysShow(['沿路边拖'], 0);
      await down();
      for (const w of [[30, 0, 0], [30, 23.5, 0]]) await glide(await P(w), 900);
      await wait(200); await up(); await keysClear(); await wait(700);
      await press('Escape'); await wait(400);
    },
  },
  {
    name: 'column', full: true,
    async setup({ center, setDoc, view }) { await setDoc([box(0, 0, 15, 5, { z: 12, depth: 5 })]); await view([0, -34, 18], [12, 2.5, 4]); await center([12, 3, 5], 498); },
    async act({ place, wait }) {
      await place('deco', '柱子（支撑）', [7.5, 2.5, 12], { ms: 1100 }); await wait(700);
      await place('deco', '灯塔', [24, 6, 0], { ms: 1000 }); await wait(900);
    },
  },
  // ---------------- 2.5 死亡区 ----------------
  {
    name: 'zone', full: true,
    async setup({ center, setDoc, view }) { await setDoc([box(0, 0, 30, 5, { z: 10 })]); await view([8, -40, 26], [15, 2.5, -4]); await center([15, 2, -4], 498); },
    async act({ place, wait, clickEl }) {
      await place('module', '死亡区', [15, 2.5, -8], { ms: 900 }); await wait(400);
      await clickEl('#view-btn', 400); await clickEl('#zone-eye', 300); await wait(700); await clickEl('#zone-eye', 250); await wait(500); await clickEl('#view-btn', 300); await wait(300);
    },
  },
  // ---------------- 3.2 地图码 ----------------
  {
    name: 'share-code', full: true,
    async setup({ center, setDoc, view, js }) {
      await setDoc(DEFAULT); await view([24, -46, 32], [32, 0, 0]); await center([34, 0, 0], 498);
      // 无头浏览器里剪贴板不能用：先在页面里算好地图码，导入时直接「粘贴」进去
      await js(`import('/src/box/share.ts').then(async (m) => { window.__code = await m.encodeShare(window.__proto.doc); return 1; })`);
    },
    async act({ clickEl, wait, js, pasteText, glide, click }) {
      await clickEl('#file-btn', 300); await clickEl('#file-menu [data-act="copy"]', 250); await wait(450);
      await clickEl('#file-btn', 300); await clickEl('#file-menu [data-act="new"]', 250); await wait(450);
      await clickEl('#file-btn', 300); await clickEl('#file-menu [data-act="import"]', 250); await wait(250);
      await js(`document.querySelector('.import-box textarea').focus(); 1`);
      await pasteText(await js('window.__code')); await wait(450);
      await clickEl('.import-box button.primary', 300); await wait(800);
      void glide; void click;
    },
  },
];
