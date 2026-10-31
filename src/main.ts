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

const file = document.getElementById('file') as HTMLInputElement;
document.getElementById('open')!.addEventListener('click', () => file.click());
file.addEventListener('change', async () => {
  const f = file.files?.[0];
  if (!f) return;
  try { editor.importJSON(await f.text()); } catch (e) { alert(String(e)); }
  file.value = '';
});

if (import.meta.env.DEV) (window as unknown as { editor: Editor }).editor = editor;
