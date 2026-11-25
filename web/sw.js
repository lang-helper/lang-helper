// Service worker：有网时总是取最新版（network-first），断网或 3 秒没响应时才用缓存。
// 以前是「先用缓存秒开、后台更新」，结果发布新版后要刷新两次才看得到，自用工具不划算。
// 改了 SHELL 列表时把 VERSION 加一。

const VERSION = 'v9';
const CACHE = 'lh-' + VERSION;
const TIMEOUT_MS = 3000;
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
  './js/google.js',
  './js/popup.js',
  './popup.html',
  './css/popup.css',
  './js/lang.js',
  './js/sheet.js',
  './sheet.html',
  './css/sheet.css',
  './wiki.html',
  './js/wiki-page.js',
  './js/wiki-reader.js',
  './css/wiki.css',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches
      .open(CACHE)
      // cache: 'reload'：绕过浏览器的 HTTP 缓存，确保拿到刚发布的新版
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
    // 主页面用「不带参数」的地址去取：「分享」进来的文字（在 ?text= 里）不会被发到服务器
    e.respondWith(networkFirst(new URL('index.html', scope).href));
    return;
  }
  // 其他页面（如 popup.html?shell=ahk）也去掉参数取，参数只留给页面自己的脚本读
  e.respondWith(networkFirst(url.origin + url.pathname));
});

async function networkFirst(href) {
  const cache = await caches.open(CACHE);
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    // cache: 'no-cache'：每次都向服务器确认（没变就是很快的 304），保证是最新版
    const res = await fetch(new Request(href, { cache: 'no-cache', signal: ctrl.signal }));
    clearTimeout(timer);
    if (res.ok) cache.put(href, res.clone());
    return res;
  } catch {
    const cached = await cache.match(href, { ignoreSearch: true });
    return cached || new Response('离线，且没有缓存', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
}
