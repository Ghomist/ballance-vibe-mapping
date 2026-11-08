// 帮助：几乎占满页面的半透明弹窗，左边目录，右边是一篇文字和动图交替的教程（内容在 help.md）。
//   打开：顶栏「帮助」按钮、F1、?；悬停在带 data-help 的按钮上按 F1 直接跳到对应小节。
//   关闭：右上角关闭按钮、点弹窗外面、Esc、再按 F1。
//   记住看到哪里（滚动位置），下次打开接着看。
import source from './help.md?raw';

const STORE = 'bvm.box.help';
/**
 * 动图、截图放在 public/help/：![说明](名字) 是动图（名字.mp4，页面上是自动播放、循环、静音、没有控件的视频），
 * 带扩展名的（名字.webp）是截图
 */
const IMG_DIR = 'help/';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** 行内：[[键]]、**粗体**、`代码`、[文字](链接)；#2.1 这种链接跳到本文的小节 */
function inline(s: string): string {
  return esc(s)
    .replace(/\[\[([^\]]+)\]\]/g, '<kbd>$1</kbd>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t: string, u: string) => (u.startsWith('#')
      ? `<a href="#" data-goto="${u.slice(1)}">${t}</a>`
      : `<a href="${u}" target="_blank" rel="noopener">${t}</a>`));
}

interface TocItem { id: string; label: string; level: 1 | 2 }

/** help.md → HTML：只支持教程里用到的几种写法 */
function render(md: string): { html: string; toc: TocItem[] } {
  const lines = md.replace(/\r/g, '').split('\n');
  const out: string[] = [], toc: TocItem[] = [];
  let para: string[] = [], list: string[] = [], table: string[][] = [];
  const flush = () => {
    if (para.length) { out.push(`<p>${inline(para.join(''))}</p>`); para = []; }
    if (list.length) { out.push(`<ul>${list.map((l) => `<li>${inline(l)}</li>`).join('')}</ul>`); list = []; }
    if (table.length) {
      const [head, , ...rows] = table;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      table = [];
    }
  };
  for (const raw of lines) {
    const l = raw.trimEnd();
    let m: RegExpExecArray | null;
    if (!l.trim()) { flush(); continue; }
    if ((m = /^(#{1,3}) (.+)$/.exec(l))) {
      flush();
      const level = m[1].length, text = m[2];
      if (level === 3) { out.push(`<h3>${inline(text)}</h3>`); continue; }
      // 章、节的编号就是锚点：「2.1 路面」→ s-2.1
      const num = /^([\d.]+?)\.?\s/.exec(text)?.[1] ?? text;
      const id = `s-${num}`;
      toc.push({ id, label: text, level: level as 1 | 2 });
      out.push(`<h${level} id="${id}">${inline(text)}</h${level}>`);
      continue;
    }
    if ((m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(l))) {
      flush();
      const media = /\.\w+$/.test(m[2])
        ? `<img src="${IMG_DIR}${m[2]}" alt="${esc(m[1])}" loading="lazy" decoding="async">`
        : `<video data-src="${IMG_DIR}${m[2]}.mp4" muted loop playsinline preload="none" aria-label="${esc(m[1])}"></video>`;
      out.push(`<figure>${media}<figcaption>${inline(m[1])}</figcaption></figure>`);
      continue;
    }
    if (l.startsWith('> ')) { flush(); out.push(`<div class="callout">${inline(l.slice(2))}</div>`); continue; }
    if (l.startsWith('- ')) { if (para.length) flush(); list.push(l.slice(2)); continue; }
    if (l.startsWith('|')) { if (para.length || list.length) flush(); table.push(l.slice(1, -1).split('|').map((c) => c.trim())); continue; }
    if (list.length || table.length) flush();
    para.push(l.trim());
  }
  flush();
  return { html: out.join('\n'), toc };
}

let root: HTMLDivElement | null = null;
let body: HTMLElement, nav: HTMLElement;
let saveTimer = 0;

function load(): { scroll: number } {
  try { return { scroll: 0, ...JSON.parse(localStorage.getItem(STORE) ?? '{}') }; } catch { return { scroll: 0 }; }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ scroll: Math.round(body.scrollTop) })); } catch { /* 存不了就算了 */ }
}

function build() {
  const { html, toc } = render(source);
  root = document.createElement('div');
  root.id = 'help-modal';
  root.hidden = true;
  root.innerHTML = `
    <div class="help-win" role="dialog" aria-label="BVM 教程">
      <nav class="help-nav">
        <div class="help-brand"><span class="logo"></span>BVM 教程</div>
        ${toc.map((t) => `<a href="#" data-goto="${t.id.slice(2)}" class="lv${t.level}">${esc(t.label)}</a>`).join('')}
      </nav>
      <article class="help-body"><div class="help-doc">${html}</div></article>
      <button class="help-close" title="关闭（Esc）"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
    </div>`;
  document.body.appendChild(root);
  body = root.querySelector('.help-body')!;
  nav = root.querySelector('.help-nav')!;
  // 还没录好的动图：显示一个占位框，不显示破图
  root.querySelectorAll('img, video').forEach((m) => m.addEventListener('error', () => m.closest('figure')?.classList.add('missing'), { once: true }));
  // 动图只在看得见的时候播放（滚到附近才开始加载），看不见就暂停，免得几十段一起放
  const io = new IntersectionObserver((es) => {
    for (const e of es) {
      const v = e.target as HTMLVideoElement;
      if (e.isIntersecting) {
        if (!v.src) { v.src = v.dataset.src!; v.addEventListener('error', () => v.closest('figure')?.classList.add('missing'), { once: true }); }
        void v.play().catch(() => {});
      } else v.pause();
    }
  }, { root: body, rootMargin: '200px 0px' });
  root.querySelectorAll('video').forEach((v) => io.observe(v));
  root.addEventListener('click', (e) => {
    const t = e.target as Element;
    const go = t.closest<HTMLElement>('[data-goto]');
    if (go) { e.preventDefault(); goTo(go.dataset.goto!); return; }
    if (t.closest('.help-close') || !t.closest('.help-win')) closeHelp();
  });
  body.addEventListener('scroll', () => {
    syncNav();
    clearTimeout(saveTimer);
    saveTimer = window.setTimeout(save, 200);
  }, { passive: true });
}

/** 目录里高亮正在看的那一节 */
function syncNav() {
  const hs = [...body.querySelectorAll<HTMLElement>('h1[id], h2[id]')];
  const y = body.scrollTop + 80;
  let cur = hs[0];
  for (const h of hs) if (h.offsetTop <= y) cur = h;
  nav.querySelectorAll('a').forEach((a) => a.classList.toggle('on', a.dataset.goto === cur?.id.slice(2)));
  nav.querySelector('a.on')?.scrollIntoView({ block: 'nearest' });
}

function goTo(num: string) {
  const h = body.querySelector<HTMLElement>(`[id="s-${num}"]`);
  if (!h) return;
  body.scrollTo({ top: h.offsetTop - 16, behavior: 'smooth' });
}

export const helpOpen = () => !!root && !root.hidden && root.classList.contains('shown');

/** 打开帮助；给了小节编号（如 "2.1"）就跳过去，否则回到上次看到的位置 */
export function openHelp(num?: string) {
  if (!root) build();
  root!.hidden = false;
  requestAnimationFrame(() => root!.classList.add('shown'));
  if (num && body.querySelector(`[id="s-${num}"]`)) body.scrollTop = body.querySelector<HTMLElement>(`[id="s-${num}"]`)!.offsetTop - 16;
  else body.scrollTop = load().scroll;
  syncNav();
  save();
}

export function closeHelp() {
  if (!root || root.hidden) return;
  save();
  root.classList.remove('shown');
  setTimeout(() => { if (!root!.classList.contains('shown')) root!.hidden = true; }, 180);
}

/** 鼠标下面的元素带 data-help 时返回它的小节编号 */
function hoveredHelp(): string | undefined {
  const hov = [...document.querySelectorAll(':hover')].pop();
  return hov?.closest<HTMLElement>('[data-help]')?.dataset.help;
}

/**
 * 装上帮助：F1 / ? 开关，开着时把键盘留给弹窗（Esc 关闭，别的键不传给编辑器）。
 * 要在编辑器的键盘监听之前调用（同在 window 的捕获阶段，先注册的先收到）。
 */
export function initHelp(button: HTMLElement) {
  button.addEventListener('click', () => { button.blur(); openHelp(); });
  window.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (helpOpen() || (root && !root.hidden)) {
      if (e.key === 'Escape' || e.key === 'F1') { e.preventDefault(); closeHelp(); }
      // 方向键、翻页键照常滚动正文，但不传给编辑器
      e.stopImmediatePropagation();
      return;
    }
    if (e.key === 'F1' || (e.key === '?' && !typing && !e.ctrlKey && !e.altKey)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      openHelp(e.key === 'F1' ? hoveredHelp() : undefined);
    }
  }, true);
}
