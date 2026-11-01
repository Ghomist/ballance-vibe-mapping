// 离线缓存：素材（贴图、模型、占位符、NMO 资源库）不用每次打开都重新下载。
//   素材：先用缓存里的（立即显示），后台再去取最新的更新缓存（下次打开生效）
//   带哈希的脚本 / 样式：内容不会变，有缓存就直接用
//   页面本身：先走网络（发布新版本后马上生效），断网时用缓存
const CACHE = 'bvm-v1';
const DATA = /\/(textures|assets|elements|fakes)\/[^/]+\.(bmp|tga|png|jpg|json)$|\/nmo-lib\.json$/i;
const HASHED = /\/_app\/[^/]+-[\w-]{8,}\.(js|css)$/;

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const k of await caches.keys()) if (k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

// 第一次打开时页面已经在 Service Worker 接管前下载过素材：页面把用到的地址发过来，补进缓存
self.addEventListener('message', (e) => {
  const urls = (e.data?.urls ?? []).filter((u) => { try { const p = new URL(u); return p.origin === location.origin && (DATA.test(p.pathname) || HASHED.test(p.pathname)); } catch { return false; } });
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    for (const u of urls) if (!(await c.match(u))) await c.add(u).catch(() => {});
  })());
});

async function put(req, res) {
  if (res.ok && res.type === 'basic') (await caches.open(CACHE)).put(req, res.clone());
  return res;
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  if (DATA.test(url.pathname)) {
    e.respondWith((async () => {
      const hit = await caches.match(req, { ignoreSearch: true });
      const fresh = fetch(req).then((r) => put(req, r));
      if (hit) { e.waitUntil(fresh.catch(() => {})); return hit; }
      return fresh;
    })());
  } else if (HASHED.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => hit ?? fetch(req).then((r) => put(req, r))));
  } else if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => put(req, r)).catch(async () => (await caches.match(req)) ?? Response.error()));
  }
});
