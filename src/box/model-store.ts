// 导入模型的本地存储：每个登记过的模型（导入的、打开地图 / 粘贴 / 蓝图带进来的）都存进浏览器的 IndexedDB，
// 按内容编号存，刷新后先读回来再显示地图。localStorage 只有几 MB，装不下模型的网格和贴图，所以自动保存的地图、
// 历史地图里只记 custom:编号，不带网格；分享出去的地图码、地图文件、剪贴板照旧带着网格。
import { type CustomModel, customModel, onCustomModel, registerModel } from './custom-model';

const DB = 'bvm-custom-models', STORE = 'models';
/** 已经在库里的编号（读回来的、存过的），不重复写 */
const stored = new Set<string>();
let failed = false;

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await open();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => { res(r ? r.result : undefined); db.close(); };
    t.onerror = t.onabort = () => { rej(t.error); db.close(); };
  });
}

/**
 * 启动时调一次：把库里的模型都登记回来（返回读到了几个），之后新登记的模型自动存进去。
 * onFail：存不进去时（隐私模式、空间满了）提醒一次
 */
export async function initModelStore(onFail: (msg: string) => void): Promise<number> {
  let n = 0;
  try {
    const keys = ((await tx('readonly', (s) => s.getAllKeys())) ?? []) as string[];
    const vals = ((await tx('readonly', (s) => s.getAll())) ?? []) as CustomModel[];
    keys.forEach((k, i) => { stored.add(k); if (vals[i]) { registerModel(vals[i], k); n++; } });
  } catch { /* 读不了：没有存过的模型，照常往下 */ }
  const save = (key: string) => {
    if (stored.has(key) || failed) return;
    const m = customModel(`custom:${key}`);
    if (!m) return;
    stored.add(key);
    tx('readwrite', (s) => s.put(m, key)).catch(() => {
      stored.delete(key);
      if (!failed) { failed = true; onFail('浏览器不让存导入的模型（存储空间满了或者是隐私模式）：刷新后这些模型会变成占位盒子。用「文件 → 保存为文件」存一份 .bvm，里面带着模型'); }
    });
  };
  started = true;
  onCustomModel(save);
  // 读库之前就登记了的（比如启动时打开的地图码里带的）也存一下
  for (const k of pendingKeys.splice(0)) save(k);
  return n;
}
/** initModelStore 之前登记的模型编号 */
const pendingKeys: string[] = [];
let started = false;
onCustomModel((k) => { if (!started) pendingKeys.push(k); });
