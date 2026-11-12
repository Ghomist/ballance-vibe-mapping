// 帮助教程的截图（screenshots.mjs 截）：每张一个名字，输出 public/help/<名字>.webp，和 src/box/help.md 里的 ![说明](名字.webp) 对应。
//   setup：摆好场景、打开要拍的界面（可以真实操作：点菜单、按住右键……）；teardown：拍完收尾（松开按键、关菜单）。
//   界面、菜单、漫游这类用截图；3D 里的操作用实时演示（src/box/demos.ts）。

const box = (x, y, sx, sy, o = {}) => ({ kind: 'box', x, y, z: 0, sx, sy, depth: 5, style: 'normal', ...o });
const obj = (type, x, y, z = 0, rot = 0, o = {}) => ({ kind: 'obj', type, x, y, z, rot, ...o });

/** 默认场景：起点 → 路 → 小节盘点 → 路 → 终点气球 */
const DEFAULT = [
  { id: 1, kind: 'piece', type: 'start', x: 0, y: 0, z: 0, rot: 0 },
  { id: 6, ...box(7.386, -2.5, 15, 5) },
  { id: 7, kind: 'piece', type: 'check', x: 27.31, y: 0, z: 0, rot: 0 },
  { id: 8, ...box(32.234, -2.5, 15, 5) },
  { id: 9, ...obj('PE_Balloon', 69.304, 0.17, -0.01, 2) },
];

export const STILLS = [
  // 1.1 界面一览：六个区域加编号
  {
    name: 'ui-overview',
    async setup({ center, setDoc, view, select, js }) {
      await setDoc(DEFAULT); await view([22, -34, 26], [30, 2, 0]); await select([6]); await center([28, 1, 0], 820, 460);
      await js(`(() => {
        const css = document.createElement('style');
        css.textContent = '.rec-badge{position:fixed;z-index:99990;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;background:#ff7a1a;color:#fff;font:700 19px/34px "Segoe UI",sans-serif;text-align:center;box-shadow:0 0 0 3px rgba(255,255,255,.9),0 4px 12px rgba(0,0,0,.35)}';
        document.head.appendChild(css);
        const put = (n, x, y) => { const b = document.createElement('div'); b.className = 'rec-badge'; b.textContent = n; b.style.left = x + 'px'; b.style.top = y + 'px'; document.body.appendChild(b); };
        const r = (s) => document.querySelector(s).getBoundingClientRect();
        const tb = r('#toolbar'), pal = r('#palette'), pr = r('#props'), vp = r('#viewport'), sb = r('#statusbar');
        put('①', tb.left + tb.width * 0.47, tb.bottom + 14);
        put('②', pal.left + pal.width / 2, pal.top + 26);
        put('③', pr.right - 6, pr.top + 22);
        put('④', vp.left + vp.width * 0.62, vp.top + vp.height * 0.72);
        put('⑤', sb.left + 160, sb.top + 2);
        const bar = r('#selbar');
        put('⑥', bar.right + 8, bar.top + 2);
        return 1;
      })()`);
    },
    async teardown({ js }) { await js(`document.querySelectorAll('.rec-badge').forEach((e) => e.remove()); 1`); },
  },
  // 1.2 漫游：按住右键、按着 W 时画面上的按键提示
  {
    name: 'view-fly',
    async setup({ setDoc, view, glide, down, keyDown, wait, W, H }) {
      await setDoc(DEFAULT); await view([-30, -6, 14], [10, 0, 2]);
      await glide({ x: W * 0.4, y: H * 0.5 }, 100);
      await down('right'); await wait(200);
      await keyDown('w'); await wait(250);
    },
    async teardown({ keyUp, up }) { await keyUp('w'); await up('right'); },
  },
  // 2.3 小节：顶栏的小节菜单打开，机关头上显示小节编号
  {
    name: 'sector',
    async setup({ center, setDoc, view, call, clickEl }) {
      await setDoc([...DEFAULT, obj('P_Box', 42.234, 0, 2.5, 0, { sector: 2 })]); await view([20, -30, 22], [34, 0, 0]); await center([34, 0, 0], 800);
      await call(() => { if (!document.getElementById('sector-eye').classList.contains('active')) document.getElementById('sector-eye').click(); document.body.click(); });
      await clickEl('#sector', 100);
    },
    async teardown({ call, press }) { await press('Escape', [], { show: false }); await call(() => { document.body.click(); document.getElementById('sector-eye').click(); }); },
  },
  // 3.2 地图码：导入框里粘贴了一串地图码
  {
    name: 'share-code',
    async setup({ setDoc, view, center, js, clickEl, pasteText }) {
      await setDoc(DEFAULT); await view([24, -46, 32], [32, 0, 0]); await center([34, 0, 0], 800);
      await js(`import('/src/box/share.ts').then(async (m) => { window.__code = await m.encodeShare(window.__proto.doc); return 1; })`);
      await clickEl('#file-btn', 100); await clickEl('#file-menu .submenu:has([data-act="import"]) > .sub-trigger', 100); await clickEl('#file-menu [data-act="import"]', 100);
      await js(`document.querySelector('.import-box textarea').focus(); 1`);
      await pasteText(await js('window.__code'));
    },
    async teardown({ js }) { await js(`document.querySelectorAll('.confirm-mask').forEach((e) => e.remove()); 1`); },
  },
];
