import { Editor, type Hint, type Tool } from './editor';
import { OBJ_TYPES } from './model/objects';
import { thumbnail } from './view/thumbs';
import { setAssetLoadedCallback, setTextureLoadedCallback } from './view/assets';
import { DEFAULT_SETTINGS } from './model/types';

const editor = new Editor(document.getElementById('viewport')!);
const status = document.getElementById('status')!;
editor.onStatus = (s) => { status.textContent = s; status.classList.toggle('warn', s.startsWith('⚠')); };

// 状态栏左侧：Blender 式的按键提示
const hintsEl = document.getElementById('hints')!;
const MOUSE: Record<string, string> = { LMB: 'l', MMB: 'm', RMB: 'r', Wheel: 'm' };
const mouseIcon = (b: string) => {
  // 鼠标轮廓，按下的那个键涂亮
  const fill = (k: string) => (MOUSE[b] === k ? 'currentColor' : 'none');
  return `<svg class="mouse" viewBox="0 0 10 14" width="10" height="14"><rect x="0.6" y="0.6" width="8.8" height="12.8" rx="4.4" fill="none" stroke="currentColor" stroke-width="1"/>`
    + `<path d="M5 0.6 V5.5" stroke="currentColor" stroke-width="0.8"/>`
    + `<path d="M5 0.6 A4.4 4.4 0 0 0 0.6 5 V5.5 H5 Z" fill="${fill('l')}" opacity="0.9"/>`
    + `<path d="M5 0.6 A4.4 4.4 0 0 1 9.4 5 V5.5 H5 Z" fill="${fill('r')}" opacity="0.9"/>`
    + (b === 'MMB' || b === 'Wheel' ? '<rect x="4" y="2" width="2" height="3" rx="1" fill="currentColor"/>' : '')
    + '</svg>';
};
const keyHtml = (k: string) => (k in MOUSE ? mouseIcon(k) : `<kbd>${k}</kbd>`);
editor.onHints = (hs: Hint[]) => {
  hintsEl.innerHTML = hs.map((h) => `<span class="hint">${h.keys.map(keyHtml).join('')}<span>${h.label}</span></span>`).join('');
};
editor.refreshStatus();

const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('#tools button')];
const syncTools = () => toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === editor.tool));
toolButtons.forEach((b) => b.addEventListener('click', () => { editor.setTool(b.dataset.tool as Tool); syncTools(); }));
const grid = document.getElementById('grid') as HTMLButtonElement;
// 拖动中按住 Alt 临时切换对齐模式：按钮显示临时状态（虚线框），松开后恢复
const syncGrid = () => {
  grid.classList.toggle('active', editor.gridMode !== editor.gridFlipped);
  grid.classList.toggle('temp', editor.gridFlipped);
};
grid.addEventListener('click', () => { editor.setGridMode(!editor.gridMode); grid.blur(); });
const snapBtn = document.getElementById('snap') as HTMLButtonElement;
const syncSnap = () => snapBtn.classList.toggle('active', editor.snapMode);
snapBtn.addEventListener('click', () => { editor.setSnapMode(!editor.snapMode); snapBtn.blur(); });

// 机关库：侧边面板，按住卡片拖到视图里放下（右键 / Esc 取消，拖动中 R 旋转）
const palette = document.getElementById('palette')!;
const viewCanvas = () => document.querySelector<HTMLCanvasElement>('#viewport canvas')!;
const groups: [string, string][] = [['module', '机关'], ['deco', '装饰']];
palette.innerHTML = `
  <div class="lib-head">
    <span class="title">机关库</span><span class="count">${OBJ_TYPES.length} 个</span>
    <button class="fold" id="lib-fold" title="收起 / 展开"><svg viewBox="0 0 16 16"><path d="M6 4l4 4-4 4" /></svg></button>
  </div>
  <div class="lib-search"><input type="search" placeholder="搜索名称或代号…" /></div>
  <div class="lib-body"></div>
  <div class="lib-foot">按住卡片拖到场景里放下 · 拖动中 R 旋转 · 右键 / Esc 取消</div>`;
const body = palette.querySelector('.lib-body')!;
const cards: { el: HTMLElement; type: string; text: string }[] = [];
const sections: HTMLDetailsElement[] = [];
for (const [cat, title] of groups) {
  const list = OBJ_TYPES.filter((x) => x.cat === cat);
  const sec = document.createElement('details');
  sec.className = 'lib-sec';
  sec.open = true;
  sec.innerHTML = `<summary>${title} <small>${list.length}</small></summary>`;
  const grid = document.createElement('div');
  grid.className = 'lib-grid';
  sec.appendChild(grid);
  body.appendChild(sec);
  sections.push(sec);
  for (const t of list) {
    const el = document.createElement('div');
    el.className = 'lib-card';
    el.title = `${t.label}
${t.type}`;
    el.innerHTML = `<div class="thumb"></div><span>${t.label}</span>`;
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      startPlace(t.type, e);
    });
    grid.appendChild(el);
    cards.push({ el, type: t.type, text: `${t.label} ${t.type}`.toLowerCase() });
  }
}
const empty = document.createElement('div');
empty.className = 'lib-empty';
empty.textContent = '没有匹配的机关';
empty.hidden = true;
body.appendChild(empty);
// 搜索：按名称或代号过滤，空的分组隐藏
palette.querySelector<HTMLInputElement>('.lib-search input')!.addEventListener('input', (e) => {
  const q = (e.target as HTMLInputElement).value.trim().toLowerCase();
  let any = false;
  for (const c of cards) { const hit = !q || c.text.includes(q); c.el.classList.toggle('hidden', !hit); any ||= hit; }
  for (const sec of sections) sec.hidden = ![...sec.querySelectorAll('.lib-card')].some((el) => !el.classList.contains('hidden'));
  empty.hidden = any;
});
// 预览图：模型加载好后补上
const fillThumbs = () => {
  for (const c of cards) {
    const box = c.el.querySelector<HTMLDivElement>('.thumb')!;
    if (box.dataset.done === editor.moduleView) continue;
    const url = thumbnail(c.type, editor.moduleView);
    if (url) { box.style.setProperty('--img', `url(${url})`); box.classList.add('loaded'); box.dataset.done = editor.moduleView; }
  }
};
fillThumbs();
setAssetLoadedCallback(fillThumbs);
setTextureLoadedCallback(fillThumbs);
// 机关显示切换后，机关库的预览也换成对应的样子
window.addEventListener('bvm-moduleview', fillThumbs);
palette.querySelector('#lib-fold')!.addEventListener('click', () => palette.classList.toggle('folded'));

function startPlace(type: string, e0: PointerEvent) {
  editor.beginPlace(type);
  const over = (e: PointerEvent) => document.elementFromPoint(e.clientX, e.clientY) === viewCanvas();
  const move = (e: PointerEvent) => editor.placeMove(e.clientX, e.clientY, over(e));
  const finish = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    window.removeEventListener('pointerdown', rightCancel, true);
    window.removeEventListener('contextmenu', noMenu, true);
    window.removeEventListener('keydown', esc);
    document.body.classList.remove('placing');
    // 右键菜单在松开右键后才会弹出：稍后再移除拦截
    setTimeout(() => window.removeEventListener('contextmenu', noMenu, true), 300);
  };
  const up = (e: PointerEvent) => { if (e.button !== 0) return; finish(); editor.endPlace(e.clientX, e.clientY, over(e)); };
  const rightCancel = (e: PointerEvent) => { if (e.button === 2) { e.preventDefault(); e.stopPropagation(); finish(); editor.cancelPlace(); window.addEventListener('contextmenu', noMenu, true); } };
  const noMenu = (e: Event) => { e.preventDefault(); e.stopPropagation(); };
  const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') finish(); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
  window.addEventListener('pointerdown', rightCancel, true);
  window.addEventListener('contextmenu', noMenu, true);
  window.addEventListener('keydown', esc);
  document.body.classList.add('placing');
  move(e0);
}

editor.onChange = () => { syncTools(); syncGrid(); syncSnap(); };
syncTools();
syncGrid();
syncSnap();

document.getElementById('undo')!.addEventListener('click', () => editor.undo());
document.getElementById('redo')!.addEventListener('click', () => editor.redo());
document.getElementById('new')!.addEventListener('click', () => { if (confirm('清空当前地图？')) editor.reset(); });

document.getElementById('save')!.addEventListener('click', () => {
  const blob = new Blob([editor.exportJSON()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'map.bvm';
  a.click();
  URL.revokeObjectURL(a.href);
});

// 导出
const exportBtn = document.getElementById('export')!;
// .blend 要靠本机的 Blender 生成：线上版本（GitHub Pages）没有
if (!import.meta.env.DEV) {
  const b = document.querySelector<HTMLButtonElement>('#export-menu button[data-format="blend"]')!;
  b.disabled = true;
  b.querySelector('small')!.textContent = '需要在本地用 npm run dev 运行编辑器，并安装 Blender + BBP';
}
const exportMenu = document.getElementById('export-menu')!;
exportBtn.addEventListener('click', (e) => { e.stopPropagation(); exportMenu.classList.toggle('open'); });
window.addEventListener('pointerdown', (e) => { if (!exportMenu.contains(e.target as Node) && e.target !== exportBtn) exportMenu.classList.remove('open'); });
const download = (blob: Blob, name: string) => {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};
exportMenu.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.addEventListener('click', async () => {
  exportMenu.classList.remove('open');
  const format = b.dataset.format!;
  const desc = editor.exportScene();
  if (desc.warnings.length && !confirm(`${desc.warnings.join('\n')}\n\n仍然导出？`)) return;
  const body = JSON.stringify(desc);
  if (format === 'json') { download(new Blob([body], { type: 'application/json' }), 'map.scene.json'); return; }
  if (format === 'nmo') {
    // 浏览器里直接生成（纯前端，不需要 Blender）
    status.textContent = '正在生成 .nmo…';
    exportBtn.setAttribute('disabled', '');
    try {
      const { data } = await editor.exportNmo();
      download(new Blob([data as BlobPart], { type: 'application/octet-stream' }), 'map.nmo');
      status.textContent = '已导出 map.nmo';
    } catch (e) {
      console.error(e);
      alert(`导出失败：${String(e).slice(0, 1500)}`);
      status.textContent = '导出失败';
    } finally {
      exportBtn.removeAttribute('disabled');
    }
    return;
  }
  status.textContent = `正在用 Blender 生成 .${format}…`;
  exportBtn.setAttribute('disabled', '');
  try {
    const res = await fetch(`/api/export?format=${format}`, { method: 'POST', body });
    if (!res.ok) throw new Error(await res.text());
    download(await res.blob(), `map.${format}`);
    status.textContent = `已导出 map.${format}`;
  } catch (e) {
    console.error(e);
    alert(`导出失败。.blend 需要在本机用 npm run dev 启动编辑器，并安装 Blender 与 BBP。
也可以先“导出场景描述”，再在 Blender 里运行 scripts/blender/build_scene.py。

${String(e).slice(0, 1500)}`);
    status.textContent = '导出失败';
  } finally {
    exportBtn.removeAttribute('disabled');
  }
}));

// 亮色 / 暗色（记在本地）
const applyTheme = (t: 'dark' | 'light') => {
  document.documentElement.dataset.theme = t;
  editor.setTheme(t);
  document.querySelector('#theme .theme-label')!.textContent = t === 'dark' ? '暗色' : '亮色';
  try { localStorage.setItem('bvm.theme', t); } catch { /* 存不了就算了 */ }
};
let savedTheme: string | null = null;
try { savedTheme = localStorage.getItem('bvm.theme'); } catch { /* 用默认 */ }
applyTheme(savedTheme === 'light' ? 'light' : 'dark');
document.getElementById('theme')!.addEventListener('click', (e) => {
  applyTheme(editor.theme === 'dark' ? 'light' : 'dark');
  (e.currentTarget as HTMLButtonElement).blur();
});

// 意见与反馈：点击时顺便复制群号，并轻提示一下（链接照常打开 QQ）
const toast = (text: string) => {
  const el = document.createElement('div');
  el.className = 'toast';
  el.textContent = text;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 2200);
};
document.getElementById('feedback')!.addEventListener('click', async () => {
  const id = '1005399899';
  try { await navigator.clipboard.writeText(id); toast(`已复制群号 ${id}`); } catch { toast(`QQ 群号：${id}`); }
});

// 全图设置
const panel = document.getElementById('settings-panel')!;
const FIELDS: { key: keyof typeof editor.settings; label: string; hint: string; step: number }[] = [
  { key: 'guardTop', label: '护栏顶部高度', hint: '横杆顶部离路面（默认 2.6，原版约 3.37）', step: 0.05 },
  { key: 'guardPostDepth', label: '护栏立柱深度', hint: '立柱伸到路面以下（默认 2，手册：1.5）', step: 0.05 },
  { key: 'guardOffset', label: '护栏离路边', hint: '管中心在路边外侧多远', step: 0.05 },
  { key: 'guardRadius', label: '护栏管半径', hint: '', step: 0.01 },
  { key: 'nailDepth', label: '铆钉深度', hint: '铆钉顶部在路面以下（手册：0.7）', step: 0.05 },
  { key: 'propLift', label: '道具离地高度', hint: '球、箱子、加分 / 加命球抬高，防止穿模', step: 0.05 },
];
const renderSettings = () => {
  panel.innerHTML = '<h3>全图设置</h3>' + FIELDS.map((f) => `<label><span>${f.label}<small>${f.hint}</small></span><input type="number" data-key="${f.key}" step="${f.step}" value="${editor.settings[f.key]}"></label>`).join('')
    + '<h3 class="sub">显示</h3>'
    + `<label class="stack"><span>机关显示<small>只影响编辑器里的显示，导出仍用占位符</small></span><span class="seg-toggle" id="module-view">${(['model', 'placeholder'] as const).map((v) => `<button data-v="${v}" class="${editor.moduleView === v ? 'on' : ''}">${v === 'model' ? '机关模型' : '占位符'}</button>`).join('')}</span></label>`
    + '<div class="row"><button id="settings-reset">恢复默认</button><button id="settings-close">关闭</button></div>';
  panel.querySelectorAll<HTMLInputElement>('input').forEach((inp) => inp.addEventListener('change', () => {
    const v = Number(inp.value);
    if (Number.isFinite(v)) editor.setSettings({ [inp.dataset.key!]: v });
  }));
  panel.querySelectorAll<HTMLButtonElement>('#module-view button').forEach((btn) => btn.addEventListener('click', () => {
    editor.setModuleView(btn.dataset.v as 'model' | 'placeholder');
    renderSettings();
  }));
  panel.querySelector('#settings-reset')!.addEventListener('click', () => { editor.setSettings({ ...DEFAULT_SETTINGS }); renderSettings(); });
  panel.querySelector('#settings-close')!.addEventListener('click', () => { panel.hidden = true; });
};
// 点设置面板外面（设置按钮除外）就收起
window.addEventListener('pointerdown', (e) => {
  const t = e.target as Element;
  if (!panel.hidden && !panel.contains(t) && !t.closest?.('#settings')) panel.hidden = true;
});
document.getElementById('settings')!.addEventListener('click', (e) => {
  panel.hidden = !panel.hidden;
  if (!panel.hidden) renderSettings();
  (e.currentTarget as HTMLButtonElement).blur();
});

const file = document.getElementById('file') as HTMLInputElement;
document.getElementById('open')!.addEventListener('click', () => file.click());
file.addEventListener('change', async () => {
  const f = file.files?.[0];
  if (!f) return;
  try { editor.importJSON(await f.text()); } catch (e) { alert(String(e)); }
  file.value = '';
});

if (import.meta.env.DEV) (window as unknown as { editor: Editor }).editor = editor;
