// 悬停提示：接管页面上所有带 title 的元素（去掉浏览器自带的提示），换成统一样式的浮层。
//   title 的写法：「标题：说明（快捷键）」，可以换行写更多说明；末尾括号里是纯按键（Ctrl+Z、X / Delete）时画成按键。
//   悬停 350 ms 后淡入；刚看过一个提示后（300 ms 内）移到别的按钮上立刻显示；按下鼠标、滚动、离开时隐藏。

const tip = document.createElement('div');
tip.id = 'tooltip';
tip.setAttribute('role', 'tooltip');
document.body.appendChild(tip);

let target: HTMLElement | null = null;
let showTimer = 0;
let lastHidden = 0;

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** 末尾括号里是不是按键（只有字母、数字、+、/、空格） */
const KEYS = /（([A-Za-z0-9+/ .\-]+)）\s*$/;

function render(text: string): string {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  let first = lines.shift() ?? '';
  let keys = '';
  const m = KEYS.exec(first);
  if (m) { keys = m[1]; first = first.slice(0, m.index).trim(); }
  // 「标题：说明」拆成两行；太长的第一行整句当说明
  let title = first, desc: string[] = [];
  const colon = first.indexOf('：');
  if (colon > 0 && colon <= 8) { title = first.slice(0, colon); desc.push(first.slice(colon + 1)); }
  desc = [...desc, ...lines];
  const kbd = keys
    ? `<span class="tip-keys">${keys.split('/').map((alt) => alt.trim().split('+').map((k) => `<kbd>${esc(k.trim())}</kbd>`).join('<i>+</i>')).join('<i class="or">/</i>')}</span>`
    : '';
  return `<div class="tip-head"><b>${esc(title)}</b>${kbd}</div>${desc.map((d) => `<div class="tip-desc">${esc(d)}</div>`).join('')}<span class="tip-arrow"></span>`;
}

function place(el: HTMLElement) {
  const r = el.getBoundingClientRect();
  const w = tip.offsetWidth, h = tip.offsetHeight, m = 8, gap = 8;
  // 默认在下面；下面放不下就放上面（底部状态栏里的按钮往上弹）
  const below = r.bottom + gap + h + m <= window.innerHeight;
  const top = below ? r.bottom + gap : r.top - gap - h;
  const cx = r.left + r.width / 2;
  const left = Math.min(Math.max(m, cx - w / 2), window.innerWidth - w - m);
  tip.style.left = `${Math.round(left)}px`;
  tip.style.top = `${Math.round(top)}px`;
  tip.dataset.side = below ? 'below' : 'above';
  tip.style.setProperty('--arrow-x', `${Math.round(Math.min(Math.max(12, cx - left), w - 12))}px`);
}

function show(el: HTMLElement) {
  const text = el.dataset.tip;
  if (!text) return;
  // 带 data-help 的按钮：提示一下按 F1 能看对应的教程
  tip.innerHTML = render(text) + (el.closest('[data-help]') ? '<div class="tip-help"><kbd>F1</kbd>看教程</div>' : '');
  tip.classList.add('measuring');
  place(el);
  tip.classList.remove('measuring');
  tip.classList.add('shown');
}
function hide() {
  clearTimeout(showTimer);
  if (tip.classList.contains('shown')) lastHidden = performance.now();
  tip.classList.remove('shown');
  target = null;
}

/** 把元素的 title 搬到 data-tip（不让浏览器再弹自带的提示） */
function adopt(el: HTMLElement) {
  const t = el.getAttribute('title');
  if (t) { el.dataset.tip = t; el.removeAttribute('title'); }
}

export function initTooltips() {
  document.addEventListener('pointerover', (e) => {
    const el = (e.target as Element).closest?.<HTMLElement>('[title], [data-tip]');
    if (!el) return;
    adopt(el);
    if (el === target) return;
    clearTimeout(showTimer);
    target = el;
    const warm = performance.now() - lastHidden < 300 || tip.classList.contains('shown');
    if (tip.classList.contains('shown')) { lastHidden = performance.now(); tip.classList.remove('shown'); }
    showTimer = window.setTimeout(() => { if (target === el && el.isConnected) show(el); }, warm ? 0 : 350);
  });
  document.addEventListener('pointerout', (e) => {
    if (!target) return;
    const to = e.relatedTarget as Node | null;
    if (to && target.contains(to)) return;
    hide();
  });
  // 按下、滚动、按键、窗口失焦：隐藏
  for (const ev of ['pointerdown', 'wheel', 'keydown'] as const) document.addEventListener(ev, hide, true);
  window.addEventListener('blur', hide);
  // 提示内容变了（例如按钮的说明随状态改了）：跟着更新
  new MutationObserver((ms) => {
    for (const m of ms) {
      const el = m.target as HTMLElement;
      if (m.attributeName === 'title' && el.getAttribute('title')) { adopt(el); if (el === target && tip.classList.contains('shown')) show(el); }
    }
  }).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['title'] });
}
