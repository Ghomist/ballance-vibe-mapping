// 帮助教程的动图录制：无头 Edge 打开编辑器，按 clips.mjs 里的分镜真实操作（鼠标、键盘事件），逐帧截图，ffmpeg 合成 MP4（截图是 WebP）。
//   页面的时钟（performance.now / requestAnimationFrame）由脚本接管：页面按 60 帧 / 秒推进，每 1/30 秒截一帧，录得再慢画面也是匀速的。
//   不用素材库、顶栏菜单的分镜只录 3D 视图；每段控制在 8 秒以内（超了会提示）。
//   画面上叠一个光标、点击波纹和按键提示，看得出在按什么。
//
// 用法：node scripts/help/record.mjs [只录这些名字…] [--url http://127.0.0.1:5173/] [--keep]
//   不给名字时录全部；输出到 public/help/<名字>.mp4（截图是 .webp）；--keep 保留逐帧的图片（在系统临时目录里）
// 依赖：Edge（EDGE 环境变量可以指定路径）、ffmpeg（PATH 里，带 libx264、libwebp）；先 npm run dev 开着开发服务器。
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLIPS } from './clips.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const OUT = join(ROOT, 'public/help');
const args = process.argv.slice(2);
const opt = (k) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : undefined; };
const URL_ = opt('url') ?? 'http://127.0.0.1:5173/';
const KEEP = args.includes('--keep');
const only = args.filter((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--url'));
const EDGE = process.env.EDGE ?? 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
/** 录制的窗口大小；输出缩到 OUT_W 宽 */
const W = 1280, H = 720, OUT_W = 960;
/**
 * 输出 30 帧 / 秒；页面按 60 帧 / 秒推进（每输出一帧走两步）。
 * 镜头惯性、缓动这些是按帧衰减的，页面帧率和实际使用时一样，动起来才和真的一样（帧率低了松手后会一直飘）
 */
const FPS = 30, DT = 1000 / FPS, SUB = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 浏览器 ----------------
const prof = mkdtempSync(join(tmpdir(), 'bvm-help-prof-'));
const PORT = 9400 + Math.floor(Math.random() * 400);
const proc = spawn(EDGE, ['--headless=new', `--remote-debugging-port=${PORT}`, `--user-data-dir=${prof}`, `--window-size=${W},${H}`,
  '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--hide-scrollbars', '--force-device-scale-factor=1', 'about:blank'], { stdio: 'ignore' });
let ws;
for (let i = 0; i < 100 && !ws; i++) {
  try {
    const page = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((p) => p.type === 'page');
    if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
  } catch { /* 还没起来 */ }
  await sleep(150);
}
// 等连接打开（可能在上面 sleep 的时候已经打开了）
if (ws.readyState !== WebSocket.OPEN) await new Promise((r) => ws.addEventListener("open", r));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') console.log('  页面异常：' + (d.params.exceptionDetails.exception?.description ?? d.params.exceptionDetails.text));
});
const send = (method, params = {}) => new Promise((r, j) => {
  if (process.env.DEBUG) console.log("  ->", method, JSON.stringify(params).slice(0, 80));
  const i = ++seq;
  pending.set(i, (d) => (d.error ? j(new Error(`${method}: ${d.error.message}`)) : r(d.result)));
  ws.send(JSON.stringify({ id: i, method, params }));
});
/** 在页面里求值（返回可序列化的值） */
async function js(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error('页面求值出错：' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text) + '\n' + expr.slice(0, 300));
  return r.result.value;
}
const call = (fn, ...a) => js(`(${fn})(...${JSON.stringify(a)})`);

await send('Page.enable');
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 1, mobile: false });
// 虚拟时钟：开启后 performance.now 只在 __step 时前进，requestAnimationFrame 的回调也只在 __step 时执行
await send('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
  const rNow = performance.now.bind(performance), rRaf = window.requestAnimationFrame.bind(window);
  let virt = false, vt = 0, q = [], id = 0;
  performance.now = () => (virt ? vt : rNow());
  window.requestAnimationFrame = (cb) => { if (!virt) return rRaf(cb); q.push(cb); return -(++id); };
  window.__virtOn = () => { vt = rNow(); virt = true; };
  window.__step = (ms) => {
    vt += ms;
    const cbs = q; q = [];
    for (const cb of cbs) { try { cb(vt); } catch (e) { console.error(e); } }
    window.__tick?.(vt);
  };
})();` });

// 偏好：亮色主题、素材库在右边、对齐开、格栅关；不弹「第一次用」的提示
await send('Page.navigate', { url: URL_ });
await sleep(1500);
await js(`localStorage.clear(); localStorage.setItem('bvm.box.helpTip', '1');
  localStorage.setItem('bvm.box.prefs', JSON.stringify({ side: 'right', theme: 'light', folded: false, libW: 284, align: true, grid: false, sectors: false, autoFollow: true, flySpeed: 25, tab: 'road', gridShown: true, zonesShown: true, skyShown: true }));
  localStorage.removeItem('bvm.box.view'); 1`);
await send('Page.reload');
await sleep(5000);

// ---------------- 叠加层：光标、点击波纹、按键提示（都跟着虚拟时钟动） ----------------
const OVERLAY = `(() => {
  const css = document.createElement('style');
  css.textContent = \`
  #fps { display: none !important; }
  body.rec-notips #tooltip { display: none !important; }
  #rec-cursor{position:fixed;left:-50px;top:-50px;width:24px;height:24px;pointer-events:none;z-index:99999;transform:translate(-3px,-2px);filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))}
  .rec-ripple{position:fixed;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;border:3px solid #ffb21e;pointer-events:none;z-index:99998}
  .rec-ripple.right{border-color:#4aa8ff}.rec-ripple.middle{border-color:#9b6bff}
  #rec-keys{position:fixed;left:50%;bottom:52px;transform:translateX(-50%);display:flex;gap:8px;pointer-events:none;z-index:99999}
  #rec-keys span{font:600 20px/1 "Segoe UI","Microsoft YaHei",sans-serif;color:#fff;background:rgba(20,24,34,.86);border:2px solid rgba(255,255,255,.35);border-bottom-width:4px;border-radius:9px;padding:8px 14px;transition:opacity .15s}
  #rec-keys span.mouse{background:rgba(255,178,30,.92);border-color:rgba(255,255,255,.5);color:#1b1206}\`;
  document.head.appendChild(css);
  const cur = document.createElement('div');
  cur.id = 'rec-cursor';
  cur.innerHTML = '<svg viewBox="0 0 26 26" width="24" height="24"><path d="M3 2 L3 21 L8 16.5 L11.5 24 L15 22.5 L11.5 15 L18 15 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>';
  document.body.appendChild(cur);
  const keys = document.createElement('div'); keys.id = 'rec-keys'; document.body.appendChild(keys);
  const ripples = [];
  let keyUntil = 0;
  window.addEventListener('pointermove', (e) => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px'; }, true);
  window.addEventListener('pointerdown', (e) => {
    const r = document.createElement('div'); r.className = 'rec-ripple' + (e.button === 2 ? ' right' : e.button === 1 ? ' middle' : '');
    r.style.left = e.clientX + 'px'; r.style.top = e.clientY + 'px'; document.body.appendChild(r);
    ripples.push({ r, t: performance.now() });
  }, true);
  window.__tick = (t) => {
    for (let i = ripples.length - 1; i >= 0; i--) {
      const k = (t - ripples[i].t) / 450;
      if (k >= 1) { ripples[i].r.remove(); ripples.splice(i, 1); continue; }
      ripples[i].r.style.transform = 'scale(' + (0.4 + 1.1 * k) + ')'; ripples[i].r.style.opacity = String(1 - k);
    }
    if (keyUntil && t > keyUntil) { keys.innerHTML = ''; keyUntil = 0; }
  };
  /** 显示按键提示 ms 毫秒（0：一直显示到下次调用） */
  window.__keys = (list, ms) => {
    keys.innerHTML = list.map((k) => '<span class="' + (/键$/.test(k) ? 'mouse' : '') + '">' + k + '</span>').join('');
    keyUntil = ms ? performance.now() + ms : 0;
  };
  window.__virtOn();
})()`;
await js(OVERLAY);
/** 开发服务器热更新时页面会整页刷新：叠加层和虚拟时钟都要重新装上 */
async function ensurePage() {
  if (await js('typeof window.__keys === "function" && !!window.__proto')) return;
  for (let i = 0; i < 60 && !(await js('!!window.__proto')); i++) await sleep(250);
  await sleep(3000);
  await js(OVERLAY);
  console.log('  页面刷新过，重新装上叠加层');
}

// ---------------- 帧 ----------------
let recDir = null, fno = 0;
/** 截哪一块（null：整个窗口；只录 3D 视图时是视图里居中的 16:9） */
let crop = null;
/** 推进 n 帧（录制中则每帧截图） */
async function frame(n = 1) {
  for (let i = 0; i < n; i++) {
    await js(`for (let i = 0; i < ${SUB}; i++) window.__step(${DT / SUB})`);
    if (recDir) {
      const { data } = await send('Page.captureScreenshot', { format: 'jpeg', quality: 92, ...(crop ? { clip: { ...crop, scale: 1 } } : {}) });
      writeFileSync(join(recDir, String(fno++).padStart(5, '0') + '.jpg'), Buffer.from(data, 'base64'));
    }
  }
}
const wait = (ms) => frame(Math.max(1, Math.round(ms / DT)));
const ease = (k) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

// ---------------- 输入 ----------------
const MOD = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
let mods = 0, buttons = 0;
let mouse = { x: W / 2, y: H / 2 };
const BTN = { left: 1, right: 2, middle: 4 };
/** 键的 CDP 参数 */
function keyInfo(k) {
  const special = {
    Control: [17, 'ControlLeft'], Shift: [16, 'ShiftLeft'], Alt: [18, 'AltLeft'], Escape: [27, 'Escape'], Enter: [13, 'Enter'], Tab: [9, 'Tab'],
    Delete: [46, 'Delete'], Backspace: [8, 'Backspace'], F1: [112, 'F1'], ' ': [32, 'Space'], ArrowLeft: [37, 'ArrowLeft'], ArrowUp: [38, 'ArrowUp'],
    ArrowRight: [39, 'ArrowRight'], ArrowDown: [40, 'ArrowDown'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'],
  };
  // 回车要带上回车符（13），输入框才会当作真的回车（提交数值）
  if (special[k]) return { key: k, code: special[k][1], vk: special[k][0], text: k === ' ' ? ' ' : k === 'Enter' ? String.fromCharCode(13) : undefined };
  if (/^[0-9]$/.test(k)) return { key: k, code: 'Digit' + k, vk: 48 + +k, text: k };
  if (k === '.') return { key: '.', code: 'Period', vk: 190, text: '.' };
  if (k === '-') return { key: '-', code: 'Minus', vk: 189, text: '-' };
  if (/^[a-zA-Z]$/.test(k)) { const u = k.toUpperCase(); const key = mods & MOD.Shift ? u : k.toLowerCase(); return { key, code: 'Key' + u, vk: u.charCodeAt(0), text: mods & (MOD.Control | MOD.Alt) ? undefined : key }; }
  throw new Error('不认识的键 ' + k);
}
async function keyDown(k) {
  const i = keyInfo(k);
  if (MOD[k]) mods |= MOD[k];
  await send('Input.dispatchKeyEvent', { type: i.text ? 'keyDown' : 'rawKeyDown', key: i.key, code: i.code, windowsVirtualKeyCode: i.vk, text: i.text, unmodifiedText: i.text, modifiers: mods });
}
async function keyUp(k) {
  const i = keyInfo(k);
  if (MOD[k]) mods &= ~MOD[k];
  await send('Input.dispatchKeyEvent', { type: 'keyUp', key: i.key, code: i.code, windowsVirtualKeyCode: i.vk, modifiers: mods });
}
/** 按一下（可以带修饰键：press('d', ['Shift'])），同时显示按键提示 */
async function press(k, withMods = [], { show = true, ms = 900 } = {}) {
  if (show) await keysShow([...withMods.map(label), label(k)], ms);
  for (const m of withMods) await keyDown(m);
  await keyDown(k); await frame(); await keyUp(k);
  for (const m of [...withMods].reverse()) await keyUp(m);
  await frame();
}
const label = (k) => ({ Control: 'Ctrl', Escape: 'Esc', ' ': 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' })[k] ?? (k.length === 1 ? k.toUpperCase() : k);
/** 按住修饰键（显示提示），返回松开的函数 */
async function hold(list) {
  for (const k of list) await keyDown(k);
  return async () => { for (const k of [...list].reverse()) await keyUp(k); };
}
const keysShow = (list, ms = 0) => js(`window.__keys(${JSON.stringify(list)}, ${ms})`);
const keysClear = () => js('window.__keys([], 0)');

async function mouseEv(type, x, y, button = 'none', extra = {}) {
  await send('Input.dispatchMouseEvent', { type, x, y, button, buttons, modifiers: mods, clickCount: type === 'mouseMoved' ? 0 : 1, ...extra });
}
/** 光标平滑移动到屏幕点 */
async function glide(to, ms = 500) {
  const from = { ...mouse }, n = Math.max(1, Math.round(ms / DT));
  for (let i = 1; i <= n; i++) {
    const e = ease(i / n);
    mouse = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
    await mouseEv('mouseMoved', mouse.x, mouse.y);
    await frame();
  }
  mouse = { ...to };
}
async function down(button = 'left') { buttons |= BTN[button]; await mouseEv('mousePressed', mouse.x, mouse.y, button); await frame(); }
async function up(button = 'left') { buttons &= ~BTN[button]; await mouseEv('mouseReleased', mouse.x, mouse.y, button); await frame(); }
async function click(button = 'left') { await down(button); await frame(); await up(button); await frame(); }
async function wheel(dy, n = 1) { for (let i = 0; i < n; i++) { await send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mouse.x, y: mouse.y, deltaX: 0, deltaY: dy, modifiers: mods }); await frame(2); } }

// ---------------- 场景 ----------------
/** 世界坐标 → 屏幕坐标 */
const P = (p) => call((p) => window.__proto.project(p), p);
const at = async (p, ms) => glide(await P(p), ms);
/** 拖动：从世界坐标 from 拖到 to（每帧按当前相机重新投影），可以按住修饰键 */
async function drag(from, to, { mods: m = [], ms = 1200, button = 'left', show = true } = {}) {
  await at(from, 400); await wait(120);
  if (show) await keysShow([...m.map(label), button === 'left' ? '左键' : button === 'right' ? '右键' : '中键'], 0);
  const release = await hold(m);
  await down(button);
  const n = Math.round(ms / DT);
  for (let i = 1; i <= n; i++) {
    const e = ease(i / n);
    mouse = await P(from.map((v, j) => v + (to[j] - v) * e));
    await mouseEv('mouseMoved', mouse.x, mouse.y);
    await frame();
  }
  await wait(120);
  await up(button);
  await release();
  if (show) await keysClear();
  await wait(250);
}
/** 屏幕上拖动（中键环视之类） */
async function dragScreen(from, to, { mods: m = [], ms = 1200, button = 'left', keys } = {}) {
  await glide(from, 300); await wait(100);
  if (keys) await keysShow(keys, 0);
  const release = await hold(m);
  await down(button);
  await glide(to, ms);
  await up(button);
  await release();
  if (keys) await keysClear();
  await wait(150);
}
/** 直接设文档（元素列表，id 从 1 开始自动编号，也可以自己给 id） */
async function setDoc(elems, extra = {}) {
  const map = {};
  elems.forEach((e, i) => { const id = e.id ?? i + 1; map[id] = { ...e, id }; });
  await call((map, extra) => { const P = window.__proto; P.select([]); const d = P.doc; d.elems = map; d.nextId = Math.max(0, ...Object.keys(map).map(Number)) + 1; Object.assign(d, extra); P.doc = d; P.select([]); }, map, extra);
  await frame(4);
}
const view = (pos, target) => call((p, t) => window.__proto.view(p, t), pos, target);
/** 镜头缓动到目标视角 */
async function fly(pos, target, ms = 1000) {
  const s = await call(() => ({ p: window.__proto.camPos(), t: window.__proto.camState().t }));
  const n = Math.round(ms / DT);
  for (let i = 1; i <= n; i++) {
    const e = ease(i / n);
    await view(s.p.map((v, j) => v + (pos[j] - v) * e), s.t.map((v, j) => v + (target[j] - v) * e));
    await frame();
  }
}
/**
 * 取景：平移镜头，让世界坐标 pt 落在画面空白处的中心（默认避开左边的属性面板）。
 * 按投影结果迭代几次，不用知道相机的视角参数
 */
async function center(pt, sx = 620, sy = 330) {
  for (let i = 0; i < 4; i++) {
    const q = await P(pt);
    const dx = q.x - sx, dy = q.y - sy;
    if (Math.hypot(dx, dy) < 2) break;
    await call((dx, dy) => {
      const P = window.__proto, p = P.camPos(), t = P.camState().t, d = P.camState().d;
      const f = [t[0] - p[0], t[1] - p[1], t[2] - p[2]], fl = Math.hypot(...f);
      const r = [f[1], -f[0], 0], rl = Math.hypot(...r) || 1; r[0] /= rl; r[1] /= rl;
      const u = [r[1] * f[2] - 0, -r[0] * f[2], r[0] * f[1] - r[1] * f[0]], ul = Math.hypot(...u) || 1;
      const k = (2 * d * Math.tan((25 * Math.PI) / 180)) / 650;
      const off = [0, 1, 2].map((j) => r[j] * dx * k - (u[j] / ul) * dy * k); // 点在右边就往右挪，点在下面就往下挪
      void fl;
      P.view(p.map((v, j) => v + off[j]), t.map((v, j) => v + off[j]));
    }, dx, dy);
  }
}
const select = (ids) => call((ids) => window.__proto.select(ids), ids);
const doc = () => js('window.__proto.doc');
/** 页面元素的中心（屏幕坐标） */
const elCenter = (sel) => call((sel) => { const el = typeof sel === 'string' ? document.querySelector(sel) : null; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel);
async function clickEl(sel, ms = 450) {
  const c = await elCenter(sel);
  if (!c) throw new Error('页面上没有 ' + sel);
  await glide(c, ms); await wait(80); await click(); await wait(180);
}
/** 素材库：切到标签，把卡片拖到世界坐标（拖动中可以按 R 转向） */
async function place(tab, cardLabel, to, { rot = 0, ms = 700, cancel = false } = {}) {
  await call((tab) => document.querySelector(`#palette .lib-tabs button[data-tab="${tab}"]`)?.click(), tab);
  await frame(2);
  const c = await call((l) => { const el = [...document.querySelectorAll('#palette .lib-card')].find((e) => e.querySelector('span')?.textContent.trim() === l); if (!el) return null; el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 - 8 }; }, cardLabel);
  if (!c) throw new Error('素材库里没有 ' + cardLabel);
  await glide(c, 350); await wait(80);
  await down(); await frame(2);
  const end = await P(to);
  await glide({ x: end.x + 40, y: end.y - 30 }, ms);
  for (let i = 0; i < rot; i++) { await press('r'); await wait(250); }
  await glide(end, 300); await wait(200);
  if (cancel) { await keysShow(['右键'], 800); await click('right'); await wait(200); }
  await up(); await wait(300);
}

/** 点 sel 里文字是 text 的那个元素（下拉菜单项之类） */
async function clickText(sel, text, ms = 400) {
  const c = await call((sel, text) => { const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim().startsWith(text)); if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; }, sel, text);
  if (!c) throw new Error(`页面上没有 ${sel}「${text}」`);
  await glide(c, ms); await wait(80); await click(); await wait(180);
}
/** 往输入框里打字：先点它、全选，再一个字一个字地敲，最后回车 */
async function typeInto(sel, text) {
  await clickEl(sel);
  await call((sel) => { const el = document.querySelector(sel); el.focus(); el.select?.(); }, sel);
  for (const ch of String(text)) { await press(ch, [], { show: false }); await frame(2); }
  await press('Enter', [], { show: false }); await wait(400);
}

const api = { center, clickText, typeInto, pasteText: (t) => send('Input.insertText', { text: t }), frame, wait, glide, down, up, click, wheel, press, hold, keyDown, keyUp, keysShow, keysClear, P, at, drag, dragScreen, setDoc, view, fly, select, doc, js, call, clickEl, place, elCenter, mouse: () => mouse, W, H };

// ---------------- 录制 ----------------
mkdirSync(OUT, { recursive: true });
const todo = only.length ? CLIPS.filter((c) => only.includes(c.name)) : CLIPS;
if (only.length && todo.length !== only.length) console.log('没有这些分镜：' + only.filter((n) => !CLIPS.some((c) => c.name === n)).join('、'));
const failed = [];
for (const c of todo) {
  try { await recordClip(c); } catch (e) { failed.push(c.name); recDir = null; console.log(`${c.name}：失败 —— ${e.message.split(String.fromCharCode(10))[0]}`); }
}
if (failed.length) console.log('失败的分镜：' + failed.join(' '));
async function recordClip(c) {
  const t0 = Date.now();
  await ensurePage();
  // 每段从干净的状态开始：没有选中、没有工具、光标放在画面外
  await press('Escape', [], { show: false });
  await js(`document.querySelectorAll('.rec-badge, .confirm-mask').forEach((e) => e.remove()); document.body.click(); 1`);
  await keysClear();
  mods = 0; buttons = 0;
  // 悬停提示默认不显示（拖素材卡片时会挡住画面），要演示按钮提示的分镜写 tips: true
  await call((on) => document.body.classList.toggle('rec-notips', !on), !!c.tips);
  await c.setup?.(api);
  await wait(c.settle ?? 1500);
  // 不用素材库、顶栏菜单的分镜只录 3D 视图（视图顶部的 16:9），按键提示也挪到这块的中间
  crop = c.full || c.still ? null : await call(() => {
    const r = document.getElementById('viewport').getBoundingClientRect();
    const h = Math.min(r.height, Math.round((r.width * 9) / 16)), w = Math.round((h * 16) / 9);
    // 贴着视图顶部取：左上角的属性面板不会被切掉
    return { x: Math.round(r.left + (r.width - w) / 2), y: Math.round(r.top), width: w, height: h };
  });
  await call((cx, bottom) => { const k = document.getElementById('rec-keys'); k.style.left = cx + 'px'; k.style.bottom = bottom + 'px'; },
    crop ? crop.x + crop.width / 2 : W / 2, crop ? H - (crop.y + crop.height) + 22 : 52);
  const dir = mkdtempSync(join(tmpdir(), `bvm-help-${c.name}-`));
  recDir = dir; fno = 0;
  await wait(c.still ? 0 : 300); // 开头停一下
  if (!c.still) await c.act(api);
  await wait(c.still ? 0 : 700); // 结尾停一下再循环
  recDir = null;
  await c.teardown?.(api); // 收尾（不录）：比如把录的时候打开的显示开关关回去
  if (c.still) {
    // 截图：只要最后一帧
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(dir, String(fno - 1).padStart(5, '0') + '.jpg'), '-vf', `scale=${OUT_W}:-2`, '-c:v', 'libwebp', '-quality', '85', join(OUT, c.name + '.webp')]);
  } else {
    // 动图用 H.264 的 MP4：页面上是自动播放、循环、静音、没有控件的 <video>，看起来和动图一样，体积只有动态 WebP 的几分之一
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', join(dir, '%05d.jpg'), '-vf', `scale=${OUT_W}:-2:flags=lanczos`,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', String(c.crf ?? 28), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', join(OUT, c.name + '.mp4')]);
  }
  if (!KEEP) rmSync(dir, { recursive: true, force: true });
  const file = join(OUT, c.name + (c.still ? '.webp' : '.mp4'));
  const kb = Math.round((await import('node:fs')).statSync(file).size / 1024);
  const sec = fno / FPS;
  console.log(`${c.name}：${sec.toFixed(1)} 秒${sec > 8 ? '（超过 8 秒！）' : ''}，${kb} KB，录了 ${((Date.now() - t0) / 1000).toFixed(0)} 秒${KEEP ? '（帧在 ' + dir + '）' : ''}`);
}
ws.close();
proc.kill();
await new Promise((r) => { proc.once('exit', r); setTimeout(r, 3000); });
try { rmSync(prof, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 浏览器还占着就留给系统清理 */ }
