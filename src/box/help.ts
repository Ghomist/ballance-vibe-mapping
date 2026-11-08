// 帮助：几乎占满页面的半透明弹窗，左边目录，右边一页一个小节（内容在 help.md），切换小节时有个小动效。
//   ![说明](demo:名字)：实时演示，嵌一个只有 3D 视图的编辑器（?demo=名字，分镜在 demos.ts），看得见时才启动，同时最多两个；
//   ![说明](名字.webp)：截图（public/help/）。
//   打开：顶栏「帮助」按钮、F1、?；悬停在带 data-help 的按钮上按 F1 直接跳到对应小节。
//   关闭：右上角关闭按钮、点弹窗外面、Esc、再按 F1。记住看到哪一节，下次打开接着看。
import source from './help.md?raw';

const STORE = 'bvm.box.help';
const IMG_DIR = 'help/';
/** 同时运行的实时演示最多几个（每个都是一个完整的编辑器） */
const MAX_LIVE = 2;

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

/** 一段 markdown → HTML：只支持教程里用到的几种写法 */
function renderBlock(lines: string[]): string {
  const out: string[] = [];
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
    if ((m = /^### (.+)$/.exec(l))) { flush(); out.push(`<h3>${inline(m[1])}</h3>`); continue; }
    if ((m = /^!\[([^\]]*)\]\(([^)]+)\)$/.exec(l))) {
      flush();
      const media = m[2].startsWith('demo:')
        ? `<div class="demo-frame" data-demo="${esc(m[2].slice(5))}"><span class="demo-wait">演示加载中…</span></div>`
        : `<img src="${IMG_DIR}${m[2]}" alt="${esc(m[1])}" loading="lazy" decoding="async">`;
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
  return out.join('\n');
}

/** 一页：一个小节（## 1.1 …）；没有小节的章（# 4. 快捷键速查）整章一页 */
interface Page { id: string; chapter: string; title: string; html: string }
interface Chapter { id: string; title: string; pages: Page[] }
const numOf = (title: string) => /^([\d.]+?)\.?\s/.exec(title)?.[1] ?? title;

function parse(md: string): Chapter[] {
  const chapters: Chapter[] = [];
  let ch: Chapter | null = null, chLines: string[] = [];
  let page: { id: string; title: string; lines: string[] } | null = null;
  const endPage = () => { if (ch && page) ch.pages.push({ id: page.id, chapter: ch.title, title: page.title, html: renderBlock(page.lines) }); page = null; };
  const endChapter = () => {
    endPage();
    if (ch && !ch.pages.length) ch.pages.push({ id: ch.id, chapter: ch.title, title: ch.title, html: renderBlock(chLines) });
  };
  for (const l of md.replace(/\r/g, '').split('\n')) {
    let m: RegExpExecArray | null;
    if ((m = /^# (.+)$/.exec(l))) { endChapter(); ch = { id: numOf(m[1]), title: m[1], pages: [] }; chapters.push(ch); chLines = []; continue; }
    if ((m = /^## (.+)$/.exec(l))) { endPage(); page = { id: numOf(m[1]), title: m[1], lines: [] }; continue; }
    if (page) (page as { lines: string[] }).lines.push(l); else chLines.push(l);
  }
  endChapter();
  return chapters;
}

let root: HTMLDivElement | null = null;
let body: HTMLElement, nav: HTMLElement, doc: HTMLElement;
let chapters: Chapter[] = [];
let pages: Page[] = [];
let cur = -1;
let io: IntersectionObserver | null = null;
/** 看得见的演示框和露出来的比例 */
const visible = new Map<HTMLElement, number>();

function load(): { page?: string } {
  try { return JSON.parse(localStorage.getItem(STORE) ?? '{}'); } catch { return {}; }
}
function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ page: pages[cur]?.id })); } catch { /* 存不了就算了 */ }
}

function build() {
  chapters = parse(source);
  pages = chapters.flatMap((c) => c.pages);
  root = document.createElement('div');
  root.id = 'help-modal';
  root.hidden = true;
  root.innerHTML = `
    <div class="help-win" role="dialog" aria-label="BVM 教程">
      <nav class="help-nav">
        <div class="help-brand"><span class="logo"></span>BVM 教程</div>
        ${chapters.map((c) => `<a href="#" data-goto="${esc(c.pages[0].id)}" class="lv1" data-ch="${esc(c.id)}">${esc(c.title)}</a>`
          + (c.pages[0].id !== c.id ? c.pages.map((p) => `<a href="#" data-goto="${esc(p.id)}" class="lv2">${esc(p.title)}</a>`).join('') : '')).join('')}
      </nav>
      <article class="help-body"><div class="help-doc"></div></article>
      <button class="help-close" title="关闭（Esc）"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" /></svg></button>
    </div>`;
  document.body.appendChild(root);
  body = root.querySelector('.help-body')!;
  nav = root.querySelector('.help-nav')!;
  doc = root.querySelector('.help-doc')!;
  root.addEventListener('click', (e) => {
    const t = e.target as Element;
    const go = t.closest<HTMLElement>('[data-goto]');
    if (go) { e.preventDefault(); goTo(go.dataset.goto!); return; }
    if (t.closest('.help-close') || !t.closest('.help-win')) closeHelp();
  });
  // 演示框露出一半以上才启动，同时最多 MAX_LIVE 个（露得多的优先），看不见就停掉
  io = new IntersectionObserver((es) => {
    for (const e of es) {
      const f = e.target as HTMLElement;
      if (e.intersectionRatio >= 0.5) visible.set(f, e.intersectionRatio); else visible.delete(f);
    }
    syncDemos();
  }, { root: body, threshold: [0, 0.5, 0.75, 1] });
}

/** 按露出来的多少开关演示：露得最多的几个运行，其余拿掉 iframe（拿掉就释放了它的 3D 画布） */
function syncDemos() {
  const live = new Set([...visible].sort((a, b) => b[1] - a[1]).slice(0, MAX_LIVE).map(([f]) => f));
  doc.querySelectorAll<HTMLElement>('.demo-frame').forEach((f) => {
    const frame = f.querySelector('iframe');
    if (live.has(f) && !frame) {
      const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
      const ifr = document.createElement('iframe');
      ifr.src = `${location.pathname}?demo=${encodeURIComponent(f.dataset.demo!)}&theme=${theme}`;
      ifr.tabIndex = -1;
      ifr.title = '演示';
      ifr.addEventListener('load', () => f.classList.add('ready'), { once: true });
      f.appendChild(ifr);
    } else if (!live.has(f) && frame) {
      frame.remove();
      f.classList.remove('ready');
    }
  });
}

/** 显示第 i 页：往后翻从右边滑进来，往前翻从左边 */
function show(i: number) {
  if (i < 0 || i >= pages.length) return;
  const dir = cur < 0 || i === cur ? 0 : i > cur ? 1 : -1;
  cur = i;
  const p = pages[i];
  visible.clear();
  io?.disconnect();
  const prev = pages[i - 1], next = pages[i + 1];
  doc.innerHTML = `${p.title !== p.chapter ? `<div class="help-chapter">${esc(p.chapter)}</div>` : ''}<h1>${inline(p.title)}</h1>${p.html}
    <div class="help-pager">
      ${prev ? `<a href="#" data-goto="${esc(prev.id)}" class="prev"><small>上一节</small>${esc(prev.title)}</a>` : '<span></span>'}
      ${next ? `<a href="#" data-goto="${esc(next.id)}" class="next"><small>下一节</small>${esc(next.title)}</a>` : '<span></span>'}
    </div>`;
  doc.querySelectorAll('img').forEach((m) => m.addEventListener('error', () => m.closest('figure')?.classList.add('missing'), { once: true }));
  body.scrollTop = 0;
  doc.classList.remove('enter-next', 'enter-prev', 'enter');
  void doc.offsetWidth; // 重新触发动画
  doc.classList.add(dir > 0 ? 'enter-next' : dir < 0 ? 'enter-prev' : 'enter');
  doc.querySelectorAll<HTMLElement>('.demo-frame').forEach((f) => io!.observe(f));
  // 目录高亮：有小节的高亮小节，整章一页的高亮章
  nav.querySelectorAll<HTMLElement>('a').forEach((a) => a.classList.toggle('on', a.classList.contains('lv2') ? a.dataset.goto === p.id : a.dataset.ch === p.id));
  nav.querySelector('a.on')?.scrollIntoView({ block: 'nearest' });
  save();
}

/** 跳到小节（"2.1"）或章（"2"：章里第一节） */
function goTo(num: string) {
  let i = pages.findIndex((p) => p.id === num);
  if (i < 0) { const c = chapters.find((x) => x.id === num); if (c) i = pages.indexOf(c.pages[0]); }
  if (i >= 0) show(i);
}

export const helpOpen = () => !!root && !root.hidden && root.classList.contains('shown');

/** 打开帮助；给了小节编号（如 "2.1"）就跳过去，否则回到上次看到的那一节 */
export function openHelp(num?: string) {
  if (!root) build();
  root!.hidden = false;
  requestAnimationFrame(() => root!.classList.add('shown'));
  cur = -1;
  goTo(num ?? load().page ?? pages[0].id);
  if (cur < 0) show(0);
}

export function closeHelp() {
  if (!root || root.hidden) return;
  save();
  root.classList.remove('shown');
  // 关掉时停掉所有演示（拿掉 iframe）
  io?.disconnect(); visible.clear();
  doc.querySelectorAll('.demo-frame iframe').forEach((f) => f.remove());
  doc.querySelectorAll('.demo-frame.ready').forEach((f) => f.classList.remove('ready'));
  setTimeout(() => { if (!root!.classList.contains('shown')) root!.hidden = true; }, 180);
}

/** 鼠标下面的元素带 data-help 时返回它的小节编号 */
function hoveredHelp(): string | undefined {
  const hov = [...document.querySelectorAll(':hover')].pop();
  return hov?.closest<HTMLElement>('[data-help]')?.dataset.help;
}

/**
 * 装上帮助：F1 / ? 开关，开着时把键盘留给弹窗（Esc 关闭，← → 翻页，别的键不传给编辑器）。
 * 要在编辑器的键盘监听之前调用（同在 window 的捕获阶段，先注册的先收到）。
 */
export function initHelp(button: HTMLElement) {
  button.addEventListener('click', () => { button.blur(); openHelp(); });
  window.addEventListener('keydown', (e) => {
    const typing = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
    if (helpOpen() || (root && !root.hidden)) {
      if (e.key === 'Escape' || e.key === 'F1') { e.preventDefault(); closeHelp(); }
      else if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); show(cur + 1); }
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); show(cur - 1); }
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
