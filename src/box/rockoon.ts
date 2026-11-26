// Rockoon（Ballance 启动器）联动：导出的 .nmo 直接写进游戏目录的 ModLoader/Maps，试玩用 rockoon:// 深链叫 Rockoon 启动这张图。
// 浏览器写本地文件夹靠 File System Access API（Chrome / Edge 桌面版才有）：第一次让用户选一次游戏目录，
// 句柄存进 IndexedDB，以后每次只需要浏览器确认一下权限（同一次打开网页里通常只问一次）。

const DB = 'bvm-rockoon', STORE = 'handles', KEY = 'game';

type Perm = 'granted' | 'denied' | 'prompt';
/** TS 自带的 DOM 类型里还没有这几个方法 */
type DirHandle = FileSystemDirectoryHandle & {
  queryPermission?(d: { mode: 'readwrite' }): Promise<Perm>;
  requestPermission?(d: { mode: 'readwrite' }): Promise<Perm>;
};
type PickerWindow = Window & { showDirectoryPicker?(o?: { id?: string; mode?: 'readwrite' }): Promise<DirHandle> };

/** 这个浏览器能不能直接写本地文件夹 */
export const rockoonSupported = () => typeof (window as PickerWindow).showDirectoryPicker === 'function' && typeof indexedDB !== 'undefined';

function openDb(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  return new Promise((res, rej) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => { res(r.result); db.close(); };
    t.onerror = t.onabort = () => { rej(t.error); db.close(); };
  });
}

/** 选好的目录：root = 游戏根目录（能放贴图），没有 root 时只有 Maps（用户直接选了 Maps 文件夹） */
export interface GameDir { maps: FileSystemDirectoryHandle; root?: FileSystemDirectoryHandle; label: string }

const child = async (d: FileSystemDirectoryHandle, name: string) => {
  try { return await d.getDirectoryHandle(name); } catch { return null; }
};

/** 认出用户选的是哪一层：游戏根目录（有 ModLoader 或 Bin）、ModLoader、或者 Maps 本身 */
async function resolve(h: FileSystemDirectoryHandle): Promise<GameDir | null> {
  const name = h.name.toLowerCase();
  if (name === 'maps') return { maps: h, label: h.name };
  if (name === 'modloader') {
    const maps = await h.getDirectoryHandle('Maps', { create: true });
    return { maps, label: `${h.name}/Maps` };
  }
  const ml = await child(h, 'ModLoader');
  if (ml) return { root: h, maps: await ml.getDirectoryHandle('Maps', { create: true }), label: h.name };
  // 装了游戏但还没装 BML / BMLPlus：有 Bin 就认，Maps 先建出来
  if (await child(h, 'Bin')) {
    const maps = await (await h.getDirectoryHandle('ModLoader', { create: true })).getDirectoryHandle('Maps', { create: true });
    return { root: h, maps, label: h.name };
  }
  return null;
}

async function ensurePerm(h: DirHandle): Promise<boolean> {
  if (!h.queryPermission || !h.requestPermission) return true;
  if ((await h.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
  return (await h.requestPermission({ mode: 'readwrite' })) === 'granted';
}

/** 记住的目录名（设置里显示用），没选过是 null */
export async function savedDirName(): Promise<string | null> {
  try { return ((await idb('readonly', (s) => s.get(KEY))) as DirHandle | undefined)?.name ?? null; } catch { return null; }
}

/**
 * 拿到游戏目录（要在点击里直接调用：选目录、要权限都需要用户刚点过）。
 * repick：不管记没记住都重新选。返回 null = 用户取消；抛错 = 选的不是游戏目录
 */
export async function getGameDir(repick = false): Promise<GameDir | null> {
  if (!repick) {
    try {
      const h = (await idb('readonly', (s) => s.get(KEY))) as DirHandle | undefined;
      if (h && await ensurePerm(h)) {
        const g = await resolve(h);
        if (g) return g;
      }
    } catch { /* 句柄失效（文件夹被删、换了位置）：重新选 */ }
  }
  let h: DirHandle;
  try {
    h = await (window as PickerWindow).showDirectoryPicker!({ id: 'rockoon-game', mode: 'readwrite' });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return null;
    throw e;
  }
  const g = await resolve(h);
  if (!g) throw new Error(`「${h.name}」不像 Ballance 游戏目录：要选装着 Bin、ModLoader 的那个文件夹（Rockoon 里实例的目录），或者直接选 ModLoader/Maps`);
  try { await idb('readwrite', (s) => s.put(h, KEY)); } catch { /* 存不住就下次再选 */ }
  return g;
}

async function writeFile(dir: FileSystemDirectoryHandle, name: string, data: Uint8Array) {
  const f = await dir.getFileHandle(name, { create: true });
  const w = await f.createWritable();
  await w.write(data as BlobPart);
  await w.close();
}

/**
 * 把 .nmo（和导入模型的贴图）写进游戏目录。贴图写进 Textures，已经有同名文件的不覆盖（别把原版贴图换掉）。
 * 返回没能放进 Textures 的贴图（只选了 Maps 时全部都是），调用方打包下载
 */
export async function writeToGame(g: GameDir, file: string, data: Uint8Array, textures: Map<string, Uint8Array>): Promise<{ skipped: Map<string, Uint8Array> }> {
  await writeFile(g.maps, file, data);
  const skipped = new Map<string, Uint8Array>();
  if (!textures.size) return { skipped };
  const tex = g.root ? await g.root.getDirectoryHandle('Textures', { create: true }) : null;
  for (const [name, d] of textures) {
    if (!tex) { skipped.set(name, d); continue; }
    try { await tex.getFileHandle(name); continue; } catch { /* 没有同名文件：写 */ }
    await writeFile(tex, name, d);
  }
  return { skipped };
}

/** 试玩用的深链：map 是相对 ModLoader/Maps 的路径（正斜杠） */
export const playUrl = (map: string) => `rockoon://play?map=${encodeURIComponent(map)}`;

export const ROCKOON_DOWNLOAD = 'https://dl.ballance.top/rockoon';

// ---- 内嵌在 Rockoon 里（Rockoon 的「在线制图器」页面用 iframe 打开 ?host=rockoon）----
// 这时导出、试玩直接交给 Rockoon：它写进当前实例的 ModLoader/Maps、启动游戏，不用选目录、不走深链。
// 消息都带 ns: 'bvm-rockoon'：BVM 发 ready / save，Rockoon 回 hello / saved，Rockoon 还会发 open（地图列表里点「在制图器中编辑」）

const NS = 'bvm-rockoon';
/** Rockoon 页面的来源：正式版 tauri.localhost，开发时 vite 的 1420 端口 */
const HOST_ORIGIN = /^(https?:\/\/tauri\.localhost|tauri:\/\/localhost|http:\/\/(127\.0\.0\.1|localhost):1420)$/;

/** 是不是被 Rockoon 内嵌着 */
export const embedded = window.parent !== window && new URLSearchParams(location.search).get('host') === 'rockoon';
let hostOrigin: string | null = null;
/** Rockoon 已经应答（之后 save 才发得出去） */
export const hostReady = () => hostOrigin !== null;

let seq = 0;
const pending = new Map<number, (r: { ok: boolean; message?: string }) => void>();

/** 开始听 Rockoon 的消息；onOpen：Rockoon 要打开一张地图来编辑（文件名、文件内容） */
export function initHostBridge(onOpen: (name: string, data: Uint8Array) => void) {
  if (!embedded) return;
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !HOST_ORIGIN.test(e.origin)) return;
    const m = e.data as { ns?: string; type?: string; id?: number; ok?: boolean; message?: string; name?: string; data?: Uint8Array };
    if (m?.ns !== NS) return;
    hostOrigin = e.origin;
    if (m.type === 'open' && typeof m.name === 'string' && m.data instanceof Uint8Array) onOpen(m.name, m.data);
    else if (m.type === 'saved' && typeof m.id === 'number') {
      pending.get(m.id)?.({ ok: !!m.ok, message: m.message });
      pending.delete(m.id);
    }
  });
  // 只是打个招呼，不带数据，所以发给任意来源；Rockoon 回 hello 以后才知道它的来源
  window.parent.postMessage({ ns: NS, type: 'ready' }, '*');
}

/**
 * 交给 Rockoon 保存（play：保存完直接启动）。Rockoon 那边出了问题（没选游戏、用户不让覆盖、没装 BMLPlus）
 * 会自己弹窗说明，这里只拿到 ok 和一句话
 */
export function saveToHost(file: string, data: Uint8Array, textures: Map<string, Uint8Array>, play: boolean): Promise<{ ok: boolean; message?: string }> {
  if (!hostOrigin) return Promise.resolve({ ok: false, message: 'Rockoon 还没连上，稍等一下再试' });
  const id = ++seq;
  const origin = hostOrigin;
  return new Promise((res) => {
    pending.set(id, res);
    window.parent.postMessage({ ns: NS, type: 'save', id, file, data, textures: [...textures].map(([name, d]) => ({ name, data: d })), play }, origin);
  });
}

/**
 * 叫 Rockoon 起来。要在用户刚点过的时候调用，否则浏览器不让打开外部程序。
 * 网页拿不到「打开成功没有」：Rockoon 起来时浏览器窗口会失去焦点，等 wait 毫秒还没失去焦点就当没拉起来（没装 / 太旧），返回 false
 */
export function launchRockoon(url: string, wait = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.removeEventListener('blur', onLeave);
      document.removeEventListener('visibilitychange', onVis);
      clearTimeout(timer);
      resolve(ok);
    };
    const onLeave = () => finish(true);
    const onVis = () => { if (document.hidden) finish(true); };
    window.addEventListener('blur', onLeave);
    document.addEventListener('visibilitychange', onVis);
    // 浏览器先弹「要打开 Rockoon 吗」：用户还在看这个框时不算失败，所以多等一会儿
    const timer = setTimeout(() => finish(false), wait);
    const a = document.createElement('a');
    a.href = url;
    a.click();
  });
}
