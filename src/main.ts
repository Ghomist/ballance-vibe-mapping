import { Editor, type Tool } from './editor';
import { OBJ_TYPES } from './model/objects';

const editor = new Editor(document.getElementById('viewport')!);
const status = document.getElementById('status')!;
editor.onStatus = (s) => { status.textContent = s; };

const toolButtons = [...document.querySelectorAll<HTMLButtonElement>('#tools button')];
const syncTools = () => toolButtons.forEach((b) => b.classList.toggle('active', b.dataset.tool === editor.tool));
toolButtons.forEach((b) => b.addEventListener('click', () => { editor.setTool(b.dataset.tool as Tool); syncTools(); }));
const grid = document.getElementById('grid') as HTMLButtonElement;
const syncGrid = () => grid.classList.toggle('active', editor.gridMode);
grid.addEventListener('click', () => { editor.setGridMode(!editor.gridMode); grid.blur(); });

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

editor.onChange = () => { syncTools(); syncGrid(); syncPalette(); };
syncTools();
syncGrid();
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

const file = document.getElementById('file') as HTMLInputElement;
document.getElementById('open')!.addEventListener('click', () => file.click());
file.addEventListener('change', async () => {
  const f = file.files?.[0];
  if (!f) return;
  try { editor.importJSON(await f.text()); } catch (e) { alert(String(e)); }
  file.value = '';
});

if (import.meta.env.DEV) (window as unknown as { editor: Editor }).editor = editor;
