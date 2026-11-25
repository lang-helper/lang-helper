// wiki 速查的全文：把 MediaWiki 解析好的 HTML 清理成干净的阅读视图。
//
// · 在 DOMParser 建的「死」文档里先处理完再放进页面：那里面的图片不会加载、脚本不会执行。
// · 去掉脚本、样式、编辑链接、导航框、维护模板、脚注角标等，只留正文、表格、信息框。
// · 图片：默认不加载（src / srcset 全部拿掉，换成「点一下加载」的占位按钮）；images=true 时才加载。
//   公式优先用 MathML（浏览器自己排版，不用下载图片）。
// · 链接：同一个维基里的条目 → 在速查里打开（data-wk-title）；其他链接 → 新窗口打开维基百科。

const DROP = [
  'script', 'style', 'link', 'meta', 'noscript', 'iframe', 'frame', 'object', 'embed', 'applet', 'base',
  'form', 'input', 'button', 'textarea', 'select', 'video', 'audio', 'source', 'track', 'picture > source', 'svg',
  '.mw-editsection', '.navbox', '.navbox-styles', '.vertical-navbox', '.navigation-not-searchable', '.navbar',
  '.metadata', '.ambox', '.ombox', '.tmbox', '.cmbox', '.fmbox', '.mbox-small', '.noprint', '.catlinks',
  '.mw-empty-elt', '.authority-control', '.noteTA', '.sistersitebox', '.portalbox', '.toc', '#toc',
  'sup.reference', '.mw-cite-backlink', '.Z3988', '.printfooter', '.shortdescription',
  '.mwe-math-fallback-image-inline', '.mwe-math-fallback-image-display',
];

// 不是普通条目的名字空间（文件、分类、模板、帮助……）：在维基百科上打开
const NAMESPACE =
  /^(file|image|media|category|wikipedia|wp|help|special|template|portal|talk|user|mediawiki|module|draft|wikt|文件|檔案|档案|图像|圖像|分类|分類|维基百科|維基百科|帮助|幫助|特殊|模板|主题|主題|用户|用戶|讨论|討論|ファイル|画像|カテゴリ|ウィキペディア|ヘルプ|特別|テンプレート|ポータル|利用者|ノート)\s*:/i;

// 图片只允许从维基媒体加载（页面的 CSP 也只放行这些）
const IMG_HOST = /(^|\.)(wikimedia\.org|wikipedia\.org)$/;

function absUrl(src, lang) {
  if (!src) return '';
  try {
    const u = new URL(src, `https://${lang}.wikipedia.org/wiki/`);
    return u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

/** 小图标（国旗、勾叉之类）：不加载图片时直接不显示，免得满屏占位按钮 */
function isIcon(img) {
  const w = Number(img.getAttribute('width')) || 0;
  const h = Number(img.getAttribute('height')) || 0;
  return (w && w <= 40) || (h && h <= 30);
}

/**
 * @param {string} html  action=parse 返回的 HTML
 * @param {{lang: string, images: boolean}} o
 * @returns {HTMLElement}  已经清理好的 <div class="wk-doc">，可以直接放进页面
 */
export function cleanArticle(html, { lang, images }) {
  // 样式先用文字替换去掉：DOMParser 解析时也会按页面的 CSP（style-src 'self'）检查，
  // 每个 style 属性都在控制台报一次错（几百条）。剩下的漏网之鱼下面再按元素删。
  const pre = String(html)
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/(<[a-z][^<>]*?)\sstyle="[^"]*"/gi, '$1');
  const doc = new DOMParser().parseFromString(`<!doctype html><body><div class="wk-doc">${pre}</div>`, 'text/html');
  const root = doc.body.firstElementChild;

  for (const n of root.querySelectorAll(DROP.join(','))) n.remove();

  // 属性：事件、样式、各种「自动加载」的属性一律去掉
  for (const n of root.querySelectorAll('*')) {
    for (const a of [...n.attributes]) {
      const k = a.name.toLowerCase();
      if (k.startsWith('on') || k === 'style' || k === 'srcset' || k === 'background' || k === 'poster' || k === 'data-mw') {
        n.removeAttribute(a.name);
      }
    }
  }

  // 图片
  for (const img of [...root.querySelectorAll('img')]) {
    const src = absUrl(img.getAttribute('src'), lang);
    img.removeAttribute('src');
    let host = '';
    try {
      host = new URL(src).hostname;
    } catch {
      /* 没有地址 */
    }
    if (!src || !IMG_HOST.test(host)) {
      img.remove();
      continue;
    }
    img.setAttribute('loading', 'lazy');
    img.setAttribute('decoding', 'async');
    img.setAttribute('referrerpolicy', 'no-referrer');
    if (images) {
      img.dataset.src = src; // 放进页面后再设 src（见 loadImages）
      continue;
    }
    if (isIcon(img)) {
      const alt = img.getAttribute('alt');
      if (alt) img.replaceWith(doc.createTextNode(alt));
      else img.remove();
      continue;
    }
    const ph = doc.createElement('span');
    ph.className = 'wk-imgph';
    ph.setAttribute('role', 'button');
    ph.setAttribute('tabindex', '0');
    ph.dataset.src = src;
    ph.dataset.w = img.getAttribute('width') || '';
    ph.dataset.h = img.getAttribute('height') || '';
    ph.dataset.alt = img.getAttribute('alt') || '';
    ph.textContent = '图片';
    ph.title = '点一下加载这张图片';
    img.replaceWith(ph);
  }

  // 链接
  for (const a of [...root.querySelectorAll('a')]) {
    const href = a.getAttribute('href') || '';
    if (a.classList.contains('new') || !href) {
      a.replaceWith(...a.childNodes); // 红链（还没有的条目）、空链接：只留文字
      continue;
    }
    if (href.startsWith('#')) continue; // 页内跳转
    const url = absUrl(href, lang);
    if (!url) {
      a.replaceWith(...a.childNodes);
      continue;
    }
    a.setAttribute('href', url);
    const u = new URL(url);
    const m = u.hostname === `${lang}.wikipedia.org` && !u.search && /^\/(?:wiki|zh-[a-z]+)\/(.+)$/.exec(u.pathname);
    let title = '';
    if (m) {
      try {
        title = decodeURIComponent(m[1]).replace(/_/g, ' ');
      } catch {
        title = '';
      }
    }
    if (title && !NAMESPACE.test(title) && !a.classList.contains('extiw')) {
      a.dataset.wkTitle = title;
      a.dataset.wkLang = lang;
      if (u.hash) a.dataset.wkHash = u.hash;
    } else {
      a.target = '_blank';
    }
    a.rel = 'noopener noreferrer';
  }

  // 宽表格可以左右滑动，不撑破页面
  for (const t of [...root.querySelectorAll('table')]) {
    if (t.parentElement?.closest('table')) continue;
    const wrap = doc.createElement('div');
    wrap.className = 'wk-tablewrap';
    t.replaceWith(wrap);
    wrap.append(t);
  }

  return document.importNode(root, true);
}

/** 已经放进页面的全文：开始加载图片（images=true 时 cleanArticle 只留了 data-src） */
export function loadImages(root) {
  for (const img of root.querySelectorAll('img[data-src]')) {
    img.src = img.dataset.src;
    delete img.dataset.src;
  }
}

/** 把一个占位按钮换成真正的图片 */
export function showPlaceholder(ph) {
  const img = document.createElement('img');
  img.decoding = 'async';
  img.referrerPolicy = 'no-referrer';
  img.alt = ph.dataset.alt || '';
  if (ph.dataset.w) img.width = Number(ph.dataset.w);
  if (ph.dataset.h) img.height = Number(ph.dataset.h);
  img.src = ph.dataset.src;
  ph.replaceWith(img);
  return img;
}
