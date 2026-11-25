// wiki 速查（wiki.html）：输入一个词 → 中 / 日 / 英三个维基条目，摘要秒切，全文默认不加载图片。
//
// 入口：
//  · PC 弹窗（AHK 的 Edge 小窗）：弹窗里 Alt+K，或全局快捷键（默认 Alt+S）。窗口标题暗号是 popup-wiki|…
//    AHK 发来的键：Ctrl+Alt+Shift+F8 = 用输入框里的文字查询 · F11 = 清空输入框（之后 AHK 会粘贴）
//                  F12 = 回到弹窗页 · F9 / F10 = 带着当前的词回弹窗去翻译 / 润色
//  · 安卓 App 的「维基速查」图标 / 选中文字后的「查维基」（AndroidBridge.getInitial 给文字，返回键调 window.lhBack）
//  · 普通网页：wiki.html#q=边际效应&lang=ja（参数放在 # 后面，不会发给服务器）
//
// 按键：Enter 查询 · Tab / Shift+Tab 换语言 · Alt+1/2/3 中/日/英 · Alt+F 全文⇄摘要 · Alt+I 图片
//       Alt+C 复制条目名 · Alt+L 复制链接 · Alt+O 在维基百科打开 · Alt+← 返回 · Esc 返回 / 收起

import { getSettings, saveSettings } from './settings.js';
import {
  WIKI_LANGS,
  findArticles,
  moreArticles,
  guessArticles,
  articleByTitle,
  getSummary,
  getArticle,
  wikiUrl,
} from './wiki.js';
import { cleanArticle, loadImages, showPlaceholder } from './wiki-reader.js';
import { sendToShell, setShellPage, shellCopy, shellKeyboard, shellKind } from './bridge.js';

const $ = (id) => document.getElementById(id);
const el = {
  q: $('q'),
  back: $('back'),
  close: $('close'),
  others: $('others'),
  clear: $('clear'),
  langs: $('langs'),
  status: $('status'),
  alts: $('alts'),
  art: $('art'),
  title: $('title'),
  desc: $('desc'),
  summary: $('summary'),
  full: $('full'),
  idle: $('idle'),
  tools: $('tools'),
  tFull: $('t-full'),
  tFullLabel: $('t-full-label'),
  tImg: $('t-img'),
  tCopy: $('t-copy'),
  tOpen: $('t-open'),
  toast: $('toast'),
};

const TAG = { zh: '中', ja: '日', en: '英' };
const NAME = { zh: '中文', ja: '日语', en: '英语' };
const HTML_LANG = { zh: 'zh-CN', ja: 'ja', en: 'en' };
const FONT_MIN = 13;
const FONT_MAX = 30;
const shell = shellKind();

const state = {
  q: '',
  list: [], // 候选条目 [{id, links: {zh, ja, en}, labels, desc, via, ai?}]
  kind: '', // 候选从哪来：title（同名条目）| disambig（消歧义页的义项）| search（搜索）| more（「不是这个意思？」）| ai
  sel: -1, // 正在看第几个；-1 = 在候选列表里挑
  aiMs: 0,
  lang: getSettings().wikiLang || 'ja', // 用户上次选的语言
  full: false, // 正在看全文
  stack: [], // 点正文里的链接之前的状态，返回时恢复
  seq: 0,
  ctrl: null, // 当前查询 / 选中条目的请求
  fullCtrl: null,
  retry: 0,
};

// ───────────────────────── 小工具 ─────────────────────────

function make(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

let toastTimer;
function toast(msg) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.toast.hidden = true), 1400);
}

async function copyText(text) {
  if (shellCopy(text)) return true;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = make('textarea');
    ta.value = text;
    ta.className = 'offscreen';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      /* ignore */
    }
    ta.remove();
    return ok;
  }
}

const current = () => state.list[state.sel] || null;
const isAbort = (e) => e?.name === 'AbortError';

function setStatus(text, cls = '') {
  el.status.textContent = text;
  el.status.className = 'wk-status' + (cls ? ' ' + cls : '');
  el.status.hidden = !text;
}

function setHash() {
  const a = current();
  const parts = [];
  if (state.q) parts.push('q=' + encodeURIComponent(state.q));
  if (a && state.lang) parts.push('lang=' + state.lang);
  if (a?.id && state.list.length > 1) parts.push('id=' + a.id);
  history.replaceState(null, '', location.pathname + location.search + (parts.length ? '#' + parts.join('&') : ''));
}

// 字号：存在设置里（拿给别人看时调大）
function applyFont(px) {
  document.documentElement.style.setProperty('--wk-fs', px + 'px');
}
function bumpFont(d) {
  const px = Math.max(FONT_MIN, Math.min(FONT_MAX, (getSettings().wikiFont || defaultFont()) + d));
  saveSettings({ wikiFont: px });
  applyFont(px);
}
function defaultFont() {
  return shell === 'android' || matchMedia('(pointer: coarse)').matches ? 19 : 17;
}

function syncTitleBarColor() {
  const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}

// ───────────────────────── 查询 ─────────────────────────

const PICK = -1; // state.sel = PICK：在候选列表里挑

/**
 * 查一个词。有同名条目、或只有一个候选 → 直接打开；拿不准（消歧义页、搜索出好几个）→ 先列出候选让你挑。
 * prefetched：弹窗已经查好的结果（省一次请求）；id：直接打开这个候选（弹窗卡片里点的那个）
 */
async function search(q, { prefetched, lang, id } = {}) {
  q = q.trim();
  state.ctrl?.abort();
  state.fullCtrl?.abort();
  clearTimeout(state.retry);
  state.q = q;
  state.list = [];
  state.kind = '';
  state.sel = PICK;
  state.full = false;
  state.stack = [];
  if (lang && WIKI_LANGS.includes(lang)) state.lang = lang;
  el.q.value = q;
  setStatus('');
  render();
  if (!q) {
    setHash();
    return;
  }
  const my = ++state.seq;
  const ctrl = new AbortController();
  state.ctrl = ctrl;
  setStatus('查找中…', 'busy');
  try {
    const res = prefetched?.kind && prefetched.list ? prefetched : await findArticles(q, { signal: ctrl.signal });
    if (my !== state.seq) return;
    state.list = res.list;
    state.kind = res.kind;
    const want = id ? res.list.findIndex((a) => a.id === id) : -1;
    if (want >= 0) select(want);
    else if (res.list.length === 1) select(0);
    else showPicker();
  } catch (e) {
    if (my !== state.seq || isAbort(e)) return;
    failed(e, () => search(q, { lang, id }));
  }
}

function failed(e, retry) {
  if (e.code === 'RATE') {
    const sec = Math.ceil(e.waitMs / 1000);
    setStatus(`维基百科暂时限流了，${sec} 秒后自动重试…`, 'warn');
    state.retry = setTimeout(retry, e.waitMs + 300);
    return;
  }
  setStatus('查询失败：' + (e.message || e) + '（检查网络后按 Enter 重试）', 'warn');
}

/** 候选列表：拿不准的时候先在这里挑 */
function showPicker() {
  state.sel = PICK;
  state.full = false;
  state.fullCtrl?.abort();
  const q = state.q;
  const n = state.list.length;
  const text = !n
    ? ''
    : {
        disambig: `「${q}」有好几个意思（维基的消歧义页），选一个：`,
        search: `没有叫「${q}」的条目，下面是搜索结果，选一个：`,
        more: `「${q}」可能是：`,
        ai: `AI 猜的候选（DeepSeek · ${(state.aiMs / 1000).toFixed(1)} 秒）。标 ✓ 的维基上有条目：`,
      }[state.kind] || `选一个：`;
  setStatus(text, 'note');
  setHash();
  render();
  window.scrollTo({ top: 0 });
}

/** 打开第 i 个候选：三种语言的摘要一起取（之后切换语言是瞬间的） */
function select(i) {
  state.sel = i;
  state.fullCtrl?.abort();
  const a = current();
  if (!a) return;
  a.sumErr = {}; // 上次失败的（比如被限流）重新取
  if (!a.links[state.lang]) state.lang = [state.lang, 'ja', 'en', 'zh'].find((l) => a.links[l]);
  const [from, to] = a.via ? a.via.split(' → ') : [];
  setStatus(
    a.via
      ? `「${from}」是重定向，条目名是「${to}」`
      : state.kind === 'search' && state.list.length === 1
        ? `没有叫「${state.q}」的条目，这是最接近的结果`
        : '',
    'note',
  );
  setHash();
  render();
  const ctrl = state.ctrl && !state.ctrl.signal.aborted ? state.ctrl : (state.ctrl = new AbortController());
  // 当前语言先取，其余的跟着（最多同时 3 个请求，Wikimedia 允许）
  const order = [state.lang, ...WIKI_LANGS.filter((l) => l !== state.lang)].filter((l) => a.links[l]);
  for (const l of order) {
    getSummary(l, a.links[l], { signal: ctrl.signal })
      .then((s) => {
        a.sums = { ...a.sums, [l]: s };
        if (current() === a) render();
      })
      .catch((e) => {
        if (isAbort(e)) return;
        a.sumErr = { ...a.sumErr, [l]: e };
        if (current() === a) render();
      });
  }
  if (state.full) loadFull();
}

function pickLang(l) {
  const a = current();
  if (!a?.links[l] || l === state.lang) return;
  state.lang = l;
  saveSettings({ wikiLang: l });
  setHash();
  render();
  if (state.full) loadFull();
  window.scrollTo({ top: 0 });
}

function cycleLang(d) {
  const a = current();
  if (!a) return;
  const avail = WIKI_LANGS.filter((l) => a.links[l]);
  if (avail.length < 2) return;
  const i = avail.indexOf(state.lang);
  pickLang(avail[(i + d + avail.length) % avail.length]);
}

/** 输入框里的「其他条目」图标：有好几个候选 → 回到候选列表；只有一个 → 搜索更多 */
function otherEntries() {
  if (!state.q) return;
  if (state.list.length > 1) {
    if (current()) showPicker();
    return;
  }
  loadMore();
}

/** 搜索更多候选，和现在这个一起列出来挑 */
async function loadMore() {
  const a = current();
  const my = state.seq;
  setStatus('查找其他条目…', 'busy');
  try {
    const more = await moreArticles(state.q, a?.id, { signal: state.ctrl?.signal });
    if (my !== state.seq) return;
    if (!more.length) {
      setStatus('没有其他候选了。可以试试「让 AI 猜」。', 'note');
      return;
    }
    state.list = a ? [a, ...more] : more;
    state.kind = 'more';
    showPicker();
  } catch (e) {
    if (isAbort(e) || my !== state.seq) return;
    setStatus(e.code === 'RATE' ? e.message : '查找失败：' + (e.message || e), 'warn');
  }
}

/** 说不出词时让 AI 猜（DeepSeek，花钱，只在点按钮时调用）；猜完去日文维基核对 */
async function aiGuess() {
  const q = (el.q.value || state.q).trim();
  if (!q) {
    el.q.focus();
    return toast('先输入一个词，或者一段描述');
  }
  if (!getSettings().apiKey?.trim()) return toast('还没有设置 DeepSeek API key（在设置页里填）');
  const prev = state.list.length ? snapshot() : null;
  state.ctrl?.abort();
  state.fullCtrl?.abort();
  clearTimeout(state.retry);
  const my = ++state.seq;
  const ctrl = new AbortController();
  state.ctrl = ctrl;
  state.q = q;
  setStatus('AI 正在猜，猜完会去维基核对…', 'busy');
  try {
    const r = await guessArticles(q, { signal: ctrl.signal });
    if (my !== state.seq) return;
    if (prev) state.stack.push(prev); // 返回键回到 AI 猜之前的结果
    state.list = r.list;
    state.kind = 'ai';
    state.aiMs = r.ms;
    if (!r.list.length) {
      state.sel = PICK;
      render();
      setStatus('AI 没给出候选，换个说法试试。', 'warn');
      return;
    }
    showPicker();
  } catch (e) {
    if (my !== state.seq || isAbort(e) || e.code === 'ABORTED') return;
    setStatus('AI 出错：' + (e.message || e), 'warn');
  }
}

// ───────────────────────── 画面 ─────────────────────────

function render() {
  const a = current();
  el.idle.hidden = !!state.q;
  el.others.hidden = !a; // 看着某个条目时才有：回到候选列表 / 搜更多
  el.langs.hidden = !a;
  el.art.hidden = !a;
  el.tools.hidden = !a;
  if (a) renderLangs(a);
  else el.langs.replaceChildren();
  renderAlts(a);
  if (a) renderArticle(a);
}

function labelOf(a, l) {
  return a.sums?.[l]?.display || a.labels?.[l] || a.links[l] || '';
}

function renderLangs(a) {
  const btns = WIKI_LANGS.map((l) => {
    const b = make('button', 'wk-lang');
    b.type = 'button';
    b.dataset.lang = l;
    b.disabled = !a.links[l];
    b.setAttribute('aria-pressed', String(l === state.lang));
    b.title = a.links[l] ? `${NAME[l]}维基：${labelOf(a, l)}` : `${NAME[l]}维基没有对应条目`;
    const name = make('span', 'wk-lang-name', a.links[l] ? labelOf(a, l) : '没有条目');
    name.lang = HTML_LANG[l];
    b.append(make('span', 'wk-tag', TAG[l]), name);
    return b;
  });
  el.langs.replaceChildren(...btns);
}

function actionButton(text, onClick, cls = 'wk-link') {
  const b = make('button', cls, text);
  b.type = 'button';
  b.addEventListener('click', onClick);
  return b;
}

/** 正文上面：挑候选时是候选列表；看条目时是「换一个 / 不是这个意思？ / 让 AI 猜」 */
function renderAlts(a) {
  el.alts.replaceChildren();
  const busy = el.status.classList.contains('busy');
  if (!state.q || (busy && !state.list.length)) {
    el.alts.hidden = true;
    return;
  }
  const ai = actionButton('让 AI 猜（DeepSeek）', aiGuess);
  ai.title = '说不出准确的词时，写个大概或一段描述，让 AI 猜对应的名词（花一点钱），再去维基核对';
  if (a) {
    if (state.kind !== 'ai') {
      const row = make('div', 'wk-alt-actions');
      row.append(ai);
      el.alts.append(row);
    }
  } else if (state.list.length) {
    el.alts.append(candidateList(state.list));
    if (state.kind !== 'ai') {
      const row = make('div', 'wk-alt-actions');
      row.append(make('span', 'wk-hint', '都不是？'), ai);
      el.alts.append(row);
    }
  } else if (state.kind) {
    el.alts.append(make('p', 'wk-miss', `没找到「${state.q}」对应的维基条目。换个说法、让 AI 猜，或者直接去维基百科搜：`));
    const row = make('div', 'wk-alt-links');
    row.append(actionButton('让 AI 猜（DeepSeek）', aiGuess, 'wk-chip'));
    for (const l of WIKI_LANGS) {
      const link = make('a', 'wk-chip', `${NAME[l]}维基里搜`);
      link.href = `https://${l}.wikipedia.org/w/index.php?search=${encodeURIComponent(state.q)}`;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      row.append(link);
    }
    el.alts.append(row);
  }
  el.alts.hidden = !el.alts.childElementCount;
}

function candidateList(list) {
  const box = make('div', 'wk-alt-list');
  list.slice(0, 20).forEach((x, i) => {
    const ok = WIKI_LANGS.some((l) => x.links[l]);
    const b = make(ok ? 'button' : 'div', 'wk-alt' + (ok ? '' : ' off'));
    if (ok) {
      b.type = 'button';
      b.addEventListener('click', () => {
        select(i);
        window.scrollTo({ top: 0 });
      });
    }
    const line = make('span', 'wk-alt-names');
    const names = WIKI_LANGS.filter((l) => x.labels?.[l] || x.links[l]);
    names.forEach((l, k) => {
      const n = make('span', null, x.labels?.[l] || x.links[l]);
      n.lang = HTML_LANG[l];
      if (k) line.append(' · ');
      line.append(n);
      if (l === 'ja' && x.ai?.reading && x.ai.reading !== n.textContent) {
        const r = make('span', 'wk-alt-reading', `（${x.ai.reading}）`);
        r.lang = 'ja';
        line.append(r);
      }
    });
    b.append(line);
    if (x.ai) {
      b.append(
        x.ai.verified
          ? make('span', 'wk-badge ok', '✓ 有条目')
          : x.ai.verifyFailed
            ? make('span', 'wk-badge', '没能核对（可能被限流）')
            : make('span', 'wk-badge warn', '维基没有这个条目'),
      );
    }
    if (x.desc) b.append(make('span', 'wk-alt-desc', x.desc));
    box.append(b);
  });
  return box;
}

function renderArticle(a) {
  const l = state.lang;
  const s = a.sums?.[l];
  const err = a.sumErr?.[l];
  el.art.lang = HTML_LANG[l];
  el.title.textContent = labelOf(a, l);
  el.desc.textContent = s?.description || (l === 'zh' || !s ? a.desc : '') || '';
  el.desc.hidden = !el.desc.textContent;
  el.summary.hidden = state.full;
  el.full.hidden = !state.full;
  if (!state.full) {
    el.summary.classList.toggle('loading', !s && !err);
    if (s) {
      el.summary.replaceChildren();
      if (s.thumb && getSettings().wikiImages) {
        const img = make('img', 'wk-thumb');
        img.referrerPolicy = 'no-referrer';
        img.alt = '';
        img.src = s.thumb;
        el.summary.append(img);
      }
      for (const para of (s.extract || '（这个条目没有摘要，看看全文）').split(/\n+/)) el.summary.append(make('p', null, para));
    } else if (err) {
      el.summary.replaceChildren(
        make('p', 'wk-miss', err.code === 'RATE' ? err.message : err.code === 'MISSING' ? '这个条目不存在了' : '摘要读取失败：' + err.message),
      );
    } else {
      el.summary.replaceChildren(make('p', 'wk-hint', '读取摘要…'));
    }
  }
  el.tFullLabel.textContent = state.full ? '摘要' : '全文';
  el.tFull.setAttribute('aria-pressed', String(state.full));
  el.tImg.setAttribute('aria-pressed', String(!!getSettings().wikiImages));
  el.tOpen.href = wikiUrl(l, a.links[l]);
}

// ───────────────────────── 全文 ─────────────────────────

function toggleFull() {
  if (!current()) return;
  state.full = !state.full;
  render();
  if (state.full) loadFull();
  else state.fullCtrl?.abort();
}

async function loadFull() {
  const a = current();
  const l = state.lang;
  if (!a?.links[l]) return;
  state.fullCtrl?.abort();
  const ctrl = new AbortController();
  state.fullCtrl = ctrl;
  const key = `${l}:${a.links[l]}`;
  if (el.full.dataset.key === key && el.full.dataset.images === String(!!getSettings().wikiImages)) return;
  el.full.dataset.key = '';
  el.full.replaceChildren(make('p', 'wk-hint', '读取全文…'));
  try {
    const r = await getArticle(l, a.links[l], { signal: ctrl.signal });
    if (ctrl.signal.aborted || current() !== a || state.lang !== l) return;
    const images = !!getSettings().wikiImages;
    const doc = cleanArticle(r.html, { lang: l, images });
    doc.lang = HTML_LANG[l];
    el.full.replaceChildren(doc);
    el.full.dataset.key = key;
    el.full.dataset.images = String(images);
    if (images) loadImages(doc);
    prefetchOthers(a, l);
  } catch (e) {
    if (isAbort(e)) return;
    el.full.replaceChildren(
      make('p', 'wk-miss', e.code === 'RATE' ? e.message : '全文读取失败：' + (e.message || e) + '（Alt+F 两次重试）'),
    );
  }
}

// 看全文时，顺便在后台把另外两种语言的全文也取好（切换时不用等）
function prefetchOthers(a, l) {
  const ctrl = state.fullCtrl;
  (async () => {
    for (const o of WIKI_LANGS) {
      if (o === l || !a.links[o] || ctrl.signal.aborted) continue;
      try {
        await getArticle(o, a.links[o], { signal: ctrl.signal });
      } catch {
        return;
      }
    }
  })();
}

function toggleImages() {
  const on = !getSettings().wikiImages;
  saveSettings({ wikiImages: on });
  toast(on ? '加载图片' : '不加载图片');
  if (on) {
    for (const ph of [...el.full.querySelectorAll('.wk-imgph')]) showPlaceholder(ph);
    el.full.dataset.images = 'true';
  } else if (state.full) {
    el.full.dataset.key = '';
    loadFull();
  }
  render();
}

// 正文里的链接：同一个维基里的条目在速查里打开（顺便查出它的中 / 日 / 英）
async function followLink(lang, title, hash) {
  const prev = snapshot();
  state.ctrl?.abort();
  state.fullCtrl?.abort();
  const my = ++state.seq;
  const ctrl = new AbortController();
  state.ctrl = ctrl;
  setStatus('打开「' + title + '」…', 'busy');
  try {
    const res = await articleByTitle(lang, title, { signal: ctrl.signal });
    if (my !== state.seq) return;
    if (!res.list.length) {
      setStatus('');
      openExternal(wikiUrl(lang, title) + (hash || ''));
      return;
    }
    state.stack.push(prev);
    state.q = title;
    el.q.value = title;
    state.list = res.list;
    state.kind = 'title';
    state.full = prev.full;
    state.lang = lang;
    select(0);
    window.scrollTo({ top: 0 });
  } catch (e) {
    if (my !== state.seq || isAbort(e)) return;
    failed(e, () => followLink(lang, title, hash));
  }
}

function snapshot() {
  return {
    q: state.q,
    list: state.list,
    kind: state.kind,
    sel: state.sel,
    aiMs: state.aiMs,
    lang: state.lang,
    full: state.full,
    scroll: window.scrollY,
  };
}

/**
 * 返回（Esc / Alt+← / 安卓返回键）。处理了返回 true。顺序：
 * 从候选里挑的条目 → 全文退回摘要 → 回到候选列表；点链接 / AI 猜之前的结果；全文 → 摘要
 */
function back() {
  const a = current();
  if (a && state.list.length > 1) {
    if (state.full) toggleFull();
    else showPicker();
    return true;
  }
  const prev = state.stack.pop();
  if (prev) {
    state.ctrl?.abort();
    state.fullCtrl?.abort();
    state.seq++;
    state.ctrl = null;
    Object.assign(state, { ...prev, scroll: undefined });
    el.q.value = prev.q;
    if (prev.sel >= 0) select(prev.sel);
    else showPicker();
    requestAnimationFrame(() => window.scrollTo({ top: prev.scroll || 0 }));
    return true;
  }
  if (state.full) {
    toggleFull();
    return true;
  }
  return false;
}

// ───────────────────────── 复制 / 打开 ─────────────────────────

/**
 * 在浏览器里打开维基百科等外部网址。PC 弹窗里交给 AHK 用系统默认浏览器打开
 * （弹窗是单独配置的 Edge 小窗，自己开新窗口会开出一个 Edge，还可能藏在后面）。
 * 网址经窗口标题传过去，太长的（超过标题能放的长度）就还是自己开。
 */
function openExternal(url) {
  if (shell === 'ahk' && /^https:\/\/[!-~]+$/.test(url) && url.length <= 500) {
    sendToShell({ action: 'open ' + url });
    return;
  }
  window.open(url, '_blank', 'noopener');
}

async function copyTitle() {
  const a = current();
  if (!a) return toast('还没有条目');
  const t = labelOf(a, state.lang);
  const ok = await copyText(t);
  toast(ok ? `已复制：${t}` : '复制失败');
  if (ok) sendToShell({ action: 'copied' });
}

async function copyLink() {
  const a = current();
  if (!a) return toast('还没有条目');
  const ok = await copyText(wikiUrl(state.lang, a.links[state.lang]));
  toast(ok ? '已复制链接' : '复制失败');
}

// ───────────────────────── 弹窗（AHK） ─────────────────────────

/** 回到翻译弹窗。text 给了就带着这个词回去（mode：translate / polish） */
// 不给 text：回到进来之前的样子（popup.js 跳过来时存在 lh.popupRestore 里）
function toPopup(text, mode) {
  if (text != null) sessionStorage.setItem('lh.popupRestore', JSON.stringify({ text, mode, run: false }));
  location.replace('popup.html');
}

// ───────────────────────── 绑定 ─────────────────────────

function bind() {
  el.q.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.isComposing && ev.keyCode !== 229) {
      ev.preventDefault();
      search(el.q.value);
      if (shell === 'android' || matchMedia('(pointer: coarse)').matches) el.q.blur(); // 收起键盘，看结果
    }
  });
  el.clear.addEventListener('click', () => {
    search('');
    el.q.focus();
    shellKeyboard();
  });
  el.others.addEventListener('click', otherEntries);
  el.back.addEventListener('click', () => toPopup());
  el.close.addEventListener('click', () => sendToShell({ action: 'close' }));

  el.langs.addEventListener('click', (ev) => {
    const b = ev.target.closest('.wk-lang');
    if (b && !b.disabled) pickLang(b.dataset.lang);
  });
  el.tFull.addEventListener('click', toggleFull);
  el.tImg.addEventListener('click', toggleImages);
  $('t-smaller').addEventListener('click', () => bumpFont(-1));
  $('t-bigger').addEventListener('click', () => bumpFont(1));
  el.tCopy.addEventListener('click', (ev) => (ev.shiftKey ? copyLink() : copyTitle()));
  el.tCopy.addEventListener('contextmenu', (ev) => {
    ev.preventDefault(); // 手机上长按 = 复制链接
    copyLink();
  });

  // 全文里：占位图片点一下加载；条目链接在速查里打开；页内跳转自己滚动（不改地址栏的 #）
  el.full.addEventListener('click', (ev) => {
    const ph = ev.target.closest('.wk-imgph');
    if (ph) {
      ev.preventDefault();
      showPlaceholder(ph);
      return;
    }
    const a = ev.target.closest('a');
    if (!a || ev.ctrlKey || ev.metaKey || ev.shiftKey || ev.button) return;
    const href = a.getAttribute('href') || '';
    if (href.startsWith('#')) {
      ev.preventDefault();
      let id = '';
      try {
        id = decodeURIComponent(href.slice(1));
      } catch {
        return;
      }
      el.full.querySelector(`[id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'start' });
      return;
    }
    if (a.dataset.wkTitle) {
      ev.preventDefault();
      followLink(a.dataset.wkLang, a.dataset.wkTitle, a.dataset.wkHash);
    }
  });
  el.full.addEventListener('keydown', (ev) => {
    if ((ev.key === 'Enter' || ev.key === ' ') && ev.target.classList?.contains('wk-imgph')) {
      ev.preventDefault();
      showPlaceholder(ev.target);
    }
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey && ev.altKey && ev.shiftKey) {
      const act = {
        F8: () => search(el.q.value), // AHK：粘贴好了，查
        F11: () => {
          search('');
          el.q.focus(); // AHK 接着会粘贴进来
        },
        F12: () => {
          sessionStorage.removeItem('lh.popupRestore'); // AHK 要往弹窗里粘贴新的文字
          location.replace('popup.html');
        },
        F9: () => toPopup(el.q.value.trim(), 'translate'),
        F10: () => toPopup(el.q.value.trim(), 'polish'),
      }[ev.code];
      if (act) {
        ev.preventDefault();
        act();
      }
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (back()) return;
      if (shell === 'ahk' || shell === 'android') sendToShell({ action: 'close' });
      return;
    }
    if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && !ev.altKey && !ev.ctrlKey && !current()) {
      const items = [...el.alts.querySelectorAll('button.wk-alt')];
      if (!items.length) return;
      ev.preventDefault();
      const i = items.indexOf(document.activeElement);
      const next = ev.key === 'ArrowDown' ? (i < 0 ? 0 : Math.min(i + 1, items.length - 1)) : i <= 0 ? -1 : i - 1;
      if (next < 0) el.q.focus();
      else items[next].focus();
      return;
    }
    if (ev.key === 'Tab' && !ev.ctrlKey && !ev.altKey && !ev.metaKey && current()) {
      ev.preventDefault();
      cycleLang(ev.shiftKey ? -1 : 1);
      return;
    }
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey && ev.code === 'ArrowLeft') {
      // Alt+←：退回上一个条目 / 摘要；PC 弹窗里再按回到翻译。普通浏览器里没东西可退时照常「后退」
      if (back()) ev.preventDefault();
      else if (shell === 'ahk') {
        ev.preventDefault();
        toPopup();
      }
      return;
    }
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey) {
      const act = {
        Digit1: () => pickLang('zh'),
        Digit2: () => pickLang('ja'),
        Digit3: () => pickLang('en'),
        KeyF: toggleFull,
        KeyI: toggleImages,
        KeyC: copyTitle,
        KeyL: copyLink,
        KeyO: () => current() && el.tOpen.click(),
        KeyR: () => search(el.q.value),
        KeyG: aiGuess,
        KeyW: () => sendToShell({ action: 'close' }),
      }[ev.code];
      if (act) {
        ev.preventDefault();
        act();
      }
    }
  });

  // PC 弹窗：所有「新窗口打开」的链接（维基百科按钮、正文里的外部链接、去维基搜）都交给默认浏览器
  if (shell === 'ahk') {
    document.addEventListener('click', (ev) => {
      const a = ev.target.closest?.('a[target="_blank"]');
      if (!a || ev.defaultPrevented || ev.button) return;
      ev.preventDefault();
      openExternal(a.href);
    });
  }

  // 安卓返回键：先退回上一个条目 / 摘要，没有可退的就关闭
  window.lhBack = () => (back() ? 'handled' : '');
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { q: p.get('q') || '', lang: p.get('lang') || '', id: p.get('id') || '' };
}

function init() {
  applyFont(getSettings().wikiFont || defaultFont());
  syncTitleBarColor();
  bind();

  if (shell === 'ahk') {
    document.body.classList.add('in-popup');
    setShellPage('-wiki');
    el.back.hidden = false;
    $('keys').hidden = false;
    // 弹窗出现时光标回到输入框（AHK 往里粘贴）
    window.addEventListener('focus', () => {
      if (document.activeElement !== el.q) el.q.focus({ preventScroll: true });
    });
  }
  if (shell === 'android') {
    document.body.classList.add('in-app');
    el.close.hidden = false;
  }
  if (!matchMedia('(pointer: coarse)').matches) $('keys').hidden = false;

  // 文字从哪来：网址 # 后面 > 安卓选中的文字 > 空
  let { q, lang, id } = readHash();
  if (!q && shell === 'android') {
    try {
      q = JSON.parse(window.AndroidBridge.getInitial() || '{}').text || '';
    } catch {
      q = '';
    }
    q = q.trim().slice(0, 200);
  }
  let prefetched = null;
  try {
    const p = JSON.parse(sessionStorage.getItem('lh.wikiPrefetch') || 'null');
    sessionStorage.removeItem('lh.wikiPrefetch');
    if (p && p.q === q.trim()) prefetched = p.res;
  } catch {
    /* ignore */
  }
  render();
  if (q) search(q, { prefetched, lang, id });
  if (!q || shell === 'ahk') {
    el.q.focus({ preventScroll: true }); // PC 弹窗里光标总在输入框（打字就是换个词查）
    if (!q) shellKeyboard();
  }
}

init();
