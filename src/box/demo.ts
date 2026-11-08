// 帮助教程里的实时演示：网址带 ?demo=名字 时，编辑器只显示 3D 视图，按 demos.ts 里的分镜在页面里模拟鼠标、键盘操作，循环播放。
//   帮助弹窗用 iframe 嵌进来（见 help.ts），所以演示永远是当前版本的样子，改了界面不用重录。
//   演示页面跑在一个内存里的假存储上（index.html 开头的脚本），不读也不写用户的地图和设置。
//   画面上叠一个光标、点击波纹和按键提示；出错时把原因显示在画面上（改动把某段演示弄坏了一眼就能看到）。
import { DEMOS, type DemoApi } from './demos';
import type { Doc, Elem } from './types';
import type { GizmoInfo } from './demos';

type Proto = {
  doc: Doc; sel: number[]; prefs: Record<string, unknown>;
  gizmoInfo(): GizmoInfo;
  view(p: number[], t: number[]): void; project(p: number[]): { x: number; y: number };
  select(ids: number[]): void; camPos(): number[]; camState(): { t: number[]; d: number };
};
const proto = () => (window as unknown as { __proto: Proto }).__proto;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));
const ease = (k: number) => (k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2);

// ---------------- 模拟输入 ----------------
const mods = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false };
const MOD_KEY: Record<string, keyof typeof mods> = { Control: 'ctrlKey', Alt: 'altKey', Shift: 'shiftKey', Meta: 'metaKey' };
let mouse = { x: -50, y: -50 };
let buttons = 0;
/** 模拟的指针捕获：按下时调了 setPointerCapture 的元素收到之后的指针事件（和浏览器一样，松开时自动释放） */
let captured: Element | null = null;
Element.prototype.setPointerCapture = function (this: Element) { captured = this; };
Element.prototype.releasePointerCapture = function (this: Element) { if (captured === this) captured = null; };
Element.prototype.hasPointerCapture = function (this: Element) { return captured === this; };
// 演示里用不到鼠标锁定（漫游），调了也什么都不做
Element.prototype.requestPointerLock = function () { return Promise.resolve(); } as typeof Element.prototype.requestPointerLock;

const BTN = { left: 0, middle: 1, right: 2 } as const;
const BTN_BIT = { left: 1, middle: 4, right: 2 } as const;
type Btn = keyof typeof BTN;
const at = () => captured ?? document.elementFromPoint(mouse.x, mouse.y) ?? document.body;
function pointer(type: string, button = -1) {
  const t = at();
  const init: PointerEventInit = {
    bubbles: true, cancelable: true, composed: true, clientX: mouse.x, clientY: mouse.y, screenX: mouse.x, screenY: mouse.y,
    pointerId: 1, pointerType: 'mouse', isPrimary: true, button, buttons, ...mods,
  };
  t.dispatchEvent(new PointerEvent(type, init));
  const mt = { pointerdown: 'mousedown', pointerup: 'mouseup', pointermove: 'mousemove' }[type];
  if (mt) t.dispatchEvent(new MouseEvent(mt, init));
  return t;
}
async function moveTo(x: number, y: number) { mouse = { x, y }; pointer('pointermove'); }
async function down(b: Btn = 'left') { buttons |= BTN_BIT[b]; overlay.ripple(b); pointer('pointerdown', BTN[b]); await frame(); }
async function up(b: Btn = 'left') {
  buttons &= ~BTN_BIT[b];
  const t = pointer('pointerup', BTN[b]);
  captured = null;
  if (b === 'left') t.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: mouse.x, clientY: mouse.y, ...mods }));
  if (b === 'right') t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: mouse.x, clientY: mouse.y }));
  await frame();
}
async function click(b: Btn = 'left') { await down(b); await sleep(60); await up(b); }

const SPECIAL: Record<string, string> = { ' ': 'Space', Enter: 'Enter', Escape: 'Escape', Tab: 'Tab', Delete: 'Delete', Backspace: 'Backspace', Control: 'ControlLeft', Shift: 'ShiftLeft', Alt: 'AltLeft', '-': 'Minus', '.': 'Period' };
const codeOf = (k: string) => SPECIAL[k] ?? (/^[0-9]$/.test(k) ? `Digit${k}` : /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : k);
function key(type: 'keydown' | 'keyup', k: string) {
  if (MOD_KEY[k]) mods[MOD_KEY[k]] = type === 'keydown';
  const key = k.length === 1 && mods.shiftKey ? k.toUpperCase() : k;
  (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent(type, { key, code: codeOf(k), bubbles: true, cancelable: true, ...mods }));
}
const label = (k: string) => ({ Control: 'Ctrl', Escape: 'Esc', ' ': 'Space' } as Record<string, string>)[k] ?? (k.length === 1 ? k.toUpperCase() : k);

// ---------------- 叠加层：光标、点击波纹、按键提示 ----------------
const overlay = (() => {
  const css = document.createElement('style');
  css.textContent = `
  #demo-cursor{position:fixed;left:-50px;top:-50px;width:32px;height:32px;pointer-events:none;z-index:99999;transform:translate(-3px,-3px);background-repeat:no-repeat;filter:drop-shadow(0 2px 3px rgba(0,0,0,.5))}
  .demo-ripple{position:fixed;width:28px;height:28px;margin:-14px 0 0 -14px;border-radius:50%;border:3px solid #ffb21e;pointer-events:none;z-index:99998;animation:demo-ripple .45s ease-out forwards}
  .demo-ripple.right{border-color:#4aa8ff}.demo-ripple.middle{border-color:#9b6bff}
  @keyframes demo-ripple{from{transform:scale(.4);opacity:1}to{transform:scale(1.5);opacity:0}}
  #demo-keys{position:fixed;left:50%;bottom:14px;transform:translateX(-50%);display:flex;gap:6px;pointer-events:none;z-index:99999}
  #demo-keys span{font:600 15px/1 "Segoe UI","Microsoft YaHei",sans-serif;color:#fff;background:rgba(20,24,34,.86);border:2px solid rgba(255,255,255,.35);border-bottom-width:3px;border-radius:8px;padding:6px 11px}
  #demo-keys span.mouse{background:rgba(255,178,30,.92);border-color:rgba(255,255,255,.5);color:#1b1206}
  #demo-error{position:fixed;left:12px;right:12px;bottom:12px;z-index:99999;padding:8px 12px;border-radius:8px;background:rgba(160,30,30,.9);color:#fff;font:12px/1.5 system-ui,sans-serif;white-space:pre-wrap}`;
  document.head.appendChild(css);
  const cur = document.createElement('div');
  cur.id = 'demo-cursor';
  const keys = document.createElement('div');
  keys.id = 'demo-keys';
  document.body.append(cur, keys);
  // 演示里的假鼠标照着页面真实的指针画：工具、状态变了跟着变，漫游时隐藏
  let shape = '';
  setInterval(() => {
    const t = document.elementFromPoint(mouse.x, mouse.y);
    const v = t ? getComputedStyle(t).cursor : '';
    if (v === shape) return;
    shape = v;
    cur.style.visibility = v === 'none' ? 'hidden' : '';
    const m = v.match(/url\("([^"]+)"\)\s*(\d+)\s+(\d+)/);
    if (m) { cur.style.backgroundImage = `url("${m[1]}")`; cur.style.transform = `translate(-${m[2]}px,-${m[3]}px)`; }
  }, 50);
  let keyTimer = 0;
  return {
    cursor() { cur.style.left = `${mouse.x}px`; cur.style.top = `${mouse.y}px`; },
    ripple(b: Btn) {
      const r = document.createElement('div');
      r.className = `demo-ripple ${b}`;
      r.style.left = `${mouse.x}px`; r.style.top = `${mouse.y}px`;
      document.body.appendChild(r);
      setTimeout(() => r.remove(), 500);
    },
    /** 显示按键提示 ms 毫秒（0：一直显示到下次调用） */
    keys(list: string[], ms = 0) {
      clearTimeout(keyTimer);
      keys.innerHTML = list.map((k) => `<span class="${/键|拖|按住/.test(k) ? 'mouse' : ''}">${k}</span>`).join('');
      if (ms) keyTimer = window.setTimeout(() => { keys.innerHTML = ''; }, ms);
    },
    error(msg: string) {
      const e = document.createElement('div');
      e.id = 'demo-error';
      e.textContent = `演示出错：${msg}`;
      document.body.appendChild(e);
    },
  };
})();

// ---------------- 给分镜用的操作 ----------------
const P = (p: number[]) => proto().project(p);
/** 光标平滑移动到屏幕点（按真实时间，用缓动） */
async function glide(to: { x: number; y: number }, ms = 500) {
  const from = { ...mouse }, t0 = performance.now();
  for (;;) {
    const k = Math.min(1, (performance.now() - t0) / ms);
    const e = ease(k);
    await moveTo(from.x + (to.x - from.x) * e, from.y + (to.y - from.y) * e);
    overlay.cursor();
    if (k >= 1) break;
    await frame();
  }
}
/** 按一下（可以带修饰键），同时显示按键提示 */
async function press(k: string, withMods: string[] = [], { show = true, ms = 900 } = {}) {
  if (show) overlay.keys([...withMods.map(label), label(k)], ms);
  for (const m of withMods) key('keydown', m);
  key('keydown', k); await frame(); key('keyup', k);
  for (const m of [...withMods].reverse()) key('keyup', m);
  await frame();
}
async function hold(list: string[]) {
  for (const k of list) key('keydown', k);
  return async () => { for (const k of [...list].reverse()) key('keyup', k); };
}
/** 世界坐标拖动（可以按住修饰键），每帧按当前相机重新投影 */
async function drag(from: number[], to: number[], { mods: m = [] as string[], ms = 1000, button = 'left' as Btn, show = true } = {}) {
  await glide(P(from), 400); await sleep(120);
  if (show) overlay.keys([...m.map(label), button === 'left' ? '左键拖' : button === 'right' ? '右键拖' : '中键拖']);
  const release = await hold(m);
  await down(button);
  const t0 = performance.now();
  for (;;) {
    const k = Math.min(1, (performance.now() - t0) / ms), e = ease(k);
    const p = P(from.map((v, j) => v + (to[j] - v) * e));
    await moveTo(p.x, p.y); overlay.cursor();
    if (k >= 1) break;
    await frame();
  }
  await sleep(120);
  await up(button);
  await release();
  if (show) overlay.keys([]);
  await sleep(250);
}
/** 屏幕上拖动（中键环视之类） */
async function dragScreen(from: { x: number; y: number }, to: { x: number; y: number }, { mods: m = [] as string[], ms = 1000, button = 'left' as Btn, keys = undefined as string[] | undefined } = {}) {
  await glide(from, 300); await sleep(100);
  if (keys) overlay.keys(keys);
  const release = await hold(m);
  await down(button);
  await glide(to, ms);
  await up(button);
  await release();
  if (keys) overlay.keys([]);
  await sleep(150);
}
/** 直接设文档（元素列表，id 从 1 开始自动编号，也可以自己给 id） */
async function setDoc(elems: Record<string, unknown>[], extra: Partial<Doc> = {}) {
  const P0 = proto();
  P0.select([]);
  const map: Record<number, Elem> = {};
  elems.forEach((e, i) => { const id = (e.id as number | undefined) ?? i + 1; map[id] = { ...e, id } as Elem; });
  const d = P0.doc;
  d.elems = map; d.nextId = Math.max(0, ...Object.keys(map).map(Number)) + 1;
  Object.assign(d, extra);
  P0.doc = d;
  await frame(); await frame();
}
const viewport = () => document.getElementById('viewport')!.getBoundingClientRect();
/** 取景：平移镜头，让世界坐标 pt 落在画面中心（选中东西、属性面板开着时，是面板右边那块的中心） */
async function center(pt: number[]) {
  for (let i = 0; i < 4; i++) {
    await frame();
    const r = viewport(), pr = document.getElementById('props')!;
    const left = pr.classList.contains('shown') && !pr.hidden && getComputedStyle(pr).display !== 'none' ? pr.getBoundingClientRect().right : r.left;
    const sx = (left + r.right) / 2, sy = (r.top + r.bottom) / 2;
    const q = P(pt), dx = q.x - sx, dy = q.y - sy;
    if (Math.hypot(dx, dy) < 2) break;
    const P0 = proto(), p = P0.camPos(), { t, d } = P0.camState();
    const f = [t[0] - p[0], t[1] - p[1], t[2] - p[2]];
    const rr = [f[1], -f[0], 0], rl = Math.hypot(rr[0], rr[1]) || 1; rr[0] /= rl; rr[1] /= rl;
    const u = [rr[1] * f[2], -rr[0] * f[2], rr[0] * f[1] - rr[1] * f[0]], ul = Math.hypot(...u) || 1;
    const k = (2 * d * Math.tan((25 * Math.PI) / 180)) / r.height;
    const off = [0, 1, 2].map((j) => rr[j] * dx * k - (u[j] / ul) * dy * k);
    P0.view(p.map((v, j) => v + off[j]), t.map((v, j) => v + off[j]));
  }
}
/** 镜头缓动到目标视角 */
async function fly(pos: number[], target: number[], ms = 1000) {
  const P0 = proto(), p0 = P0.camPos(), t0 = P0.camState().t, s = performance.now();
  for (;;) {
    const k = Math.min(1, (performance.now() - s) / ms), e = ease(k);
    P0.view(p0.map((v, j) => v + (pos[j] - v) * e), t0.map((v, j) => v + (target[j] - v) * e));
    if (k >= 1) break;
    await frame();
  }
}
function elCenter(sel: string) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
async function clickEl(sel: string, ms = 400) {
  const c = elCenter(sel);
  if (!c) throw new Error(`页面上没有 ${sel}`);
  await glide(c, ms); await sleep(80); await click(); await sleep(180);
}
async function clickText(sel: string, text: string, ms = 350) {
  const el = [...document.querySelectorAll(sel)].find((e) => e.textContent!.trim().startsWith(text));
  if (!el) throw new Error(`页面上没有 ${sel}「${text}」`);
  const r = el.getBoundingClientRect();
  await glide({ x: r.left + r.width / 2, y: r.top + r.height / 2 }, ms); await sleep(80); await click(); await sleep(180);
}
/** 往输入框里填数：点一下它，一个字一个字显示出来，回车提交 */
async function typeInto(sel: string, text: string) {
  await clickEl(sel);
  const inp = document.querySelector<HTMLInputElement>(sel)!;
  inp.focus(); inp.value = '';
  for (const ch of text) { inp.value += ch; overlay.keys([ch], 700); await sleep(160); }
  overlay.keys(['Enter'], 700);
  inp.dispatchEvent(new Event('input', { bubbles: true }));
  inp.dispatchEvent(new Event('change', { bubbles: true }));
  inp.blur();
  await sleep(400);
}
async function wheel(dy: number, n = 1) {
  for (let i = 0; i < n; i++) {
    at().dispatchEvent(new WheelEvent('wheel', { deltaY: dy, clientX: mouse.x, clientY: mouse.y, bubbles: true, cancelable: true, ...mods }));
    await sleep(70);
  }
}

const api: DemoApi = {
  P, glide, down, up, click, press, hold, drag, dragScreen, setDoc, center, fly, clickEl, clickText, typeInto, wheel,
  wait: sleep,
  at: async (p, ms) => glide(P(p), ms),
  keyDown: async (k) => key('keydown', k),
  keyUp: async (k) => key('keyup', k),
  keysShow: async (list, ms = 0) => overlay.keys(list, ms),
  keysClear: async () => overlay.keys([]),
  view: async (p, t) => proto().view(p, t),
  select: async (ids) => proto().select(ids),
  doc: async () => proto().doc,
  pref: (k, v) => { proto().prefs[k] = v; },
  gizmo: () => proto().gizmoInfo(),
  mouse: () => ({ ...mouse }),
};

/** 跑一段演示：摆场景 → 操作 → 停一下 → 从头再来，一直循环 */
export async function runDemo(name: string) {
  const d = DEMOS.find((x) => x.name === name);
  const state = { loops: 0, error: '' };
  (window as unknown as { __demo: typeof state }).__demo = state;
  if (!d) { overlay.error(`没有这段演示：${name}`); state.error = 'missing'; return; }
  document.documentElement.classList.toggle('demo-props', !!d.props);
  // 等编辑器和贴图准备好
  for (let i = 0; i < 100 && !(window as unknown as { __proto?: Proto }).__proto; i++) await sleep(50);
  // 路面贴图加载好之前视图是隐藏的（#viewport.loading），等它出来再开始
  for (let i = 0; i < 60 && document.getElementById('viewport')!.classList.contains('loading'); i++) await sleep(100);
  await sleep(600);
  try {
    for (;;) {
      // 每一轮从干净的状态开始：没有按着的键和鼠标、没有工具、没有选中
      for (const m of Object.keys(MOD_KEY)) if (mods[MOD_KEY[m]]) key('keyup', m);
      if (buttons) { for (const b of ['left', 'middle', 'right'] as Btn[]) if (buttons & BTN_BIT[b]) await up(b); }
      key('keydown', 'Escape'); key('keyup', 'Escape');
      overlay.keys([]);
      await d.setup(api);
      await sleep(d.settle ?? 500);
      await d.act(api);
      await sleep(1300);
      await d.teardown?.(api);
      state.loops++;
    }
  } catch (e) {
    state.error = String((e as Error)?.message ?? e);
    overlay.error(state.error);
    console.error(e);
  }
}
