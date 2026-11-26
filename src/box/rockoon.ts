// Rockoon（Ballance 启动器）联动。Rockoon 对应一个确定的游戏实例，所以保存位置交给它决定，BVM 不让用户选目录：
// - 内嵌在 Rockoon 里（侧栏「在线制图器」，?host=rockoon）：postMessage 把导出好的 .nmo 交给 Rockoon，它写进当前实例的
//   ModLoader/Maps，要试玩就接着启动；
// - 在普通浏览器里：把地图码交给 rockoon://bvm 深链（大地图走剪贴板），Rockoon 在内嵌的制图器里打开这张图，
//   再走上面那条路保存 / 试玩。

export const ROCKOON_DOWNLOAD = 'https://dl.ballance.top/rockoon';

/** 打开 Rockoon 以后要做什么：只打开、保存进地图目录、保存并试玩 */
export type RockoonAction = 'open' | 'save' | 'play';

/**
 * Windows 把深链当命令行参数交给 Rockoon，命令行最长 32767 个字符（实测 3 万字符的链接能完整收到）；
 * 留点余量给程序路径和其它参数。地图码更长（大地图、带导入模型）就改走剪贴板
 */
export const MAX_LINK = 30000;

/** 地图码的校验码（SHA-256 前 16 位十六进制）：走剪贴板时 Rockoon 拿它核对剪贴板里的确实是这张图 */
export async function codeHash(code: string): Promise<string> {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code)));
  return [...h.slice(0, 8)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 把地图交给 Rockoon 的深链。地图码（base64url，本身就能放进网址）放得下就直接带上；
 * 放不下（大地图）就放进剪贴板，链接里只带校验码，Rockoon 读剪贴板、核对无误后打开并清空剪贴板。
 * 走剪贴板会替换用户剪贴板里的东西，所以先 askClip 问一句；不同意返回 null。
 * id 让 Rockoon 那边反复试玩同一张图时不新建历史。返回 viaClipboard：是不是走了剪贴板
 */
export async function bvmLink(code: string, name: string, id: string, action: RockoonAction, askClip: () => Promise<boolean>): Promise<{ url: string; viaClipboard: boolean } | null> {
  const q = new URLSearchParams({ action, name, id });
  const inline = `rockoon://bvm?${q}&code=${code}`;
  if (inline.length <= MAX_LINK) return { url: inline, viaClipboard: false };
  if (!await askClip()) return null;
  await navigator.clipboard.writeText(code);
  return { url: `rockoon://bvm?${q}&clip=${await codeHash(code)}`, viaClipboard: true };
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

// ---- 内嵌在 Rockoon 里 ----
// 消息都带 ns: 'bvm-rockoon'：BVM 发 ready / save，Rockoon 回 hello / saved，hello 和 theme 带着 Rockoon 的明暗，
// 还会发 open（地图列表里点「在制图器中编辑」，带 .nmo 文件）和 open-code（浏览器里的 BVM 通过深链交过来的地图码）

const NS = 'bvm-rockoon';
/** Rockoon 页面的来源：正式版 tauri.localhost，开发时 vite 的 1420 端口 */
const HOST_ORIGIN = /^(https?:\/\/tauri\.localhost|tauri:\/\/localhost|http:\/\/(127\.0\.0\.1|localhost):1420)$/;

/** 是不是被 Rockoon 内嵌着 */
export const embedded = window.parent !== window && new URLSearchParams(location.search).get('host') === 'rockoon';
/** 内嵌时 Rockoon 在地址里带的明暗（第一帧就用它，不闪）；之后切换走 theme 消息 */
export const hostTheme = ((): 'dark' | 'light' | null => {
  if (!embedded) return null;
  const t = new URLSearchParams(location.search).get('theme');
  return t === 'dark' || t === 'light' ? t : null;
})();
let hostOrigin: string | null = null;

let seq = 0;
const pending = new Map<number, (r: { ok: boolean; message?: string }) => void>();

export interface HostHandlers {
  /** 打开一个 .nmo 来编辑（文件名、文件内容） */
  openFile(name: string, data: Uint8Array): void;
  /** 打开浏览器里交过来的地图码，再按 action 保存 / 试玩 */
  openCode(code: string, name: string, id: string, action: RockoonAction): void;
  /** Rockoon 的明暗变了（跟着它走，BVM 自己的主题开关在内嵌时藏起来） */
  theme(t: 'dark' | 'light'): void;
}

/** 开始听 Rockoon 的消息 */
export function initHostBridge(h: HostHandlers) {
  if (!embedded) return;
  window.addEventListener('message', (e) => {
    if (e.source !== window.parent || !HOST_ORIGIN.test(e.origin)) return;
    const m = e.data as { ns?: string; type?: string; id?: number | string; ok?: boolean; message?: string; name?: string; data?: Uint8Array; code?: string; action?: string; theme?: string };
    if (m?.ns !== NS) return;
    hostOrigin = e.origin;
    if ((m.type === 'hello' || m.type === 'theme') && (m.theme === 'dark' || m.theme === 'light')) h.theme(m.theme);
    if (m.type === 'open' && typeof m.name === 'string' && m.data instanceof Uint8Array) h.openFile(m.name, m.data);
    else if (m.type === 'open-code' && typeof m.code === 'string') {
      const action: RockoonAction = m.action === 'play' || m.action === 'save' ? m.action : 'open';
      h.openCode(m.code, typeof m.name === 'string' ? m.name : '', typeof m.id === 'string' ? m.id : '', action);
    } else if (m.type === 'saved' && typeof m.id === 'number') {
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
