// Service worker：缓存网页外壳，打开更快、断网也能打开（调用 API 当然还是要联网）。
// 策略：先用缓存秒开，同时在后台拉新版本，下次打开就是新的（stale-while-revalidate）。
// 改了 SHELL 列表时把 VERSION 加一。

const VERSION = 'v5';
const CACHE = 'lh-' + VERSION;
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/bridge.js',
  './js/detect.js',
  './js/diff.js',
  './js/history.js',
  './js/llm.js',
  './js/output.js',
  './js/prompts.js',
  './js/settings.js',
  './js/theme.js',
  './js/wiki.js',
  './js/wiki-ui.js',
  './js/yandex.js',
  './js/popup.js',
  './popup.html',
  './css/popup.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      // cache: 'reload'：绕过浏览器的 HTTP 缓存（GitHub Pages 会缓存 10 分钟），确保拿到刚发布的新版
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('lh-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // API 请求等跨域请求不碰

  const scope = new URL(self.registration.scope);
  const isAppPage =
    req.mode === 'navigate' && (url.pathname === scope.pathname || url.pathname === scope.pathname + 'index.html');

  if (isAppPage) {
    // 主页面一律用缓存里的 index.html，并且用"不带参数"的地址去更新：
    // 这样「分享」进来的文字（在 ?text= 里）不会被发到服务器。
    e.respondWith(staleWhileRevalidate(e, new Request(new URL('index.html', scope).href)));
    return;
  }
  e.respondWith(staleWhileRevalidate(e, req));
});

async function staleWhileRevalidate(event, req) {
  const cache = await caches.open(CACHE);
  const cached = await cache.match(req, { ignoreSearch: true });
  const network = fetch(req)
    .then((res) => {
      if (res.ok) cache.put(req, res.clone());
      return res;
    })
    .catch(() => null);
  if (cached) {
    event.waitUntil(network);
    return cached;
  }
  return (await network) || new Response('离线，且没有缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
