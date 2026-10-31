import { Editor, type Hint, type Tool } from './editor';
import { OBJ_TYPES } from './model/objects';
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

// 机关工具的物件面板
const palette = document.getElementById('palette')!;
const groups: [string, string][] = [['module', '机关'], ['deco', '装饰']];
for (const [cat, title] of groups) {
  const h = document.createElement('h4');
  h.textContent = title;
  palette.appendChild(h);
  for (const t of OBJ_TYPES.filter((x) => x.cat === cat)) {
    const b = document.createElement('button');
    b.dataset.type = t.type;
    b.innerHTML = `<span>${t.label}</span><small>${t.type}</small>`;
    b.addEventListener('click', () => { editor.setObjType(t.type); b.blur(); });
    palette.appendChild(b);
  }
}
const syncPalette = () => {
  palette.hidden = editor.tool !== 'object';
  palette.querySelectorAll<HTMLButtonElement>('button').forEach((b) => b.classList.toggle('active', b.dataset.type === editor.objType));
};

editor.onChange = () => { syncTools(); syncGrid(); syncSnap(); syncPalette(); };
syncTools();
syncGrid();
syncSnap();
syncPalette();

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
  status.textContent = `正在用 Blender 生成 .${format}…`;
  exportBtn.setAttribute('disabled', '');
  try {
    const res = await fetch(`/api/export?format=${format}`, { method: 'POST', body });
    if (!res.ok) throw new Error(await res.text());
    download(await res.blob(), `map.${format}`);
    status.textContent = `已导出 map.${format}`;
  } catch (e) {
    console.error(e);
    alert(`导出失败。需要在本机用 npm run dev 启动编辑器，并安装 Blender 与 BBP。
也可以先“导出场景描述”，再在 Blender 里运行 scripts/blender/build_scene.py。

${String(e).slice(0, 1500)}`);
    status.textContent = '导出失败';
  } finally {
    exportBtn.removeAttribute('disabled');
  }
}));

// 全图设置
const panel = document.getElementById('settings-panel')!;
const FIELDS: { key: keyof typeof editor.settings; label: string; hint: string; step: number }[] = [
  { key: 'guardTop', label: '护栏顶部高度', hint: '横杆顶部离路面（原版约 3.37）', step: 0.05 },
  { key: 'guardPostDepth', label: '护栏立柱深度', hint: '立柱伸到路面以下（手册：1.5）', step: 0.05 },
  { key: 'guardOffset', label: '护栏离路边', hint: '管中心在路边外侧多远', step: 0.05 },
  { key: 'guardRadius', label: '护栏管半径', hint: '', step: 0.01 },
  { key: 'nailDepth', label: '铆钉深度', hint: '铆钉顶部在路面以下（手册：0.7）', step: 0.05 },
  { key: 'propLift', label: '道具离地高度', hint: '球、箱子、加分 / 加命球抬高，防止穿模', step: 0.05 },
];
const renderSettings = () => {
  panel.innerHTML = '<h3>全图设置</h3>' + FIELDS.map((f) => `<label><span>${f.label}<small>${f.hint}</small></span><input type="number" data-key="${f.key}" step="${f.step}" value="${editor.settings[f.key]}"></label>`).join('')
    + '<div class="row"><button id="settings-reset">恢复默认</button><button id="settings-close">关闭</button></div>';
  panel.querySelectorAll<HTMLInputElement>('input').forEach((inp) => inp.addEventListener('change', () => {
    const v = Number(inp.value);
    if (Number.isFinite(v)) editor.setSettings({ [inp.dataset.key!]: v });
  }));
  panel.querySelector('#settings-reset')!.addEventListener('click', () => { editor.setSettings({ ...DEFAULT_SETTINGS }); renderSettings(); });
  panel.querySelector('#settings-close')!.addEventListener('click', () => { panel.hidden = true; });
};
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
