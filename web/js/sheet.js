// 手机弹窗（sheet.html）：安卓 App 里选中文字 →「译」→ 从底部弹出。
//
// ① 选择页：原文（可改）、目标语言（两个候选都显示，点选）、「翻译」「润色」两个大按钮
// ② 结果页：原文 + 结果卡片。翻译时卡片可以左右滑动（Yandex 在前，DeepSeek 在后）；
//    像一个词时 DeepSeek 等你滑到它才去查询。润色只有一张 DeepSeek 卡片（标出改动、给要点）。
//
// 和安卓壳的约定（window.AndroidBridge）：
//   getInitial() → '{"text": "...", "readonly": true|false, "source": "select"|"launcher"}'
//   postMessage('{"action":"close"}' | '{"action":"replace","text":"..."}')
//   copy(text) / paste() → 剪贴板文字 / showKeyboard()
//   返回键：壳调用 window.lhBack()
//   变暗的背景由壳（窗口自带的变暗效果）负责，点一下就有反应；网页里的 .backdrop 在安卓里是透明的

import { getSettings, saveSettings } from './settings.js';
import { MODES, PROMPT_VERSION, buildMessages } from './prompts.js';
import { streamChat } from './llm.js';
import { splitOutput } from './output.js';
import { detectKind } from './detect.js';
import { diff, renderDiff } from './diff.js';
import * as store from './history.js';
import { yandexTranslate } from './yandex.js';
import { sendToShell, shellCopy, shellPaste, shellKeyboard, shellKind } from './bridge.js';
import { LANG, sourceLang, isAmbiguousHan, targetsFor, looksLikeTerm } from './lang.js';

const $ = (id) => document.getElementById(id);
const el = {
  sheet: $('sheet'),
  backdrop: $('backdrop'),
  grab: $('grab'),
  choose: $('screen-choose'),
  result: $('screen-result'),
  src: $('src'),
  detect: $('detect'),
  targets: $('targets'),
  resultTitle: $('result-title'),
  srcView: $('src-view'),
  results: $('results'),
  dots: $('dots'),
  toast: $('toast'),
};

const ICON = {
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  replace: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h12l-3-3M20 16H8l3 3"/></svg>',
  diff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v8M8 8h8M8 18h8"/></svg>',
};

const state = {
  readonly: true, // 原文所在的地方能不能改（能改才显示「替换」）
  srcOverride: null, // 只有汉字时手动指定 'zh' | 'ja'
  lastSrc: 'zh',
  ctrl: null,
  result: { yandex: '', deepseek: '' },
  lazy: null, // 像一个词时：DeepSeek 等滑到它（或点它）才查询
};

// ───────────────────────── 小工具 ─────────────────────────

function make(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function actButton(svg, label, cls = 'act') {
  const b = make('button', cls);
  b.type = 'button';
  b.innerHTML = svg; // 固定的图标字符串，不含用户数据
  b.append(label);
  return b;
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
    return false;
  }
}

const langAttr = (l) => (l === 'zh' ? 'zh-CN' : l);

function srcOf(text) {
  return sourceLang(text, { override: state.srcOverride, fallback: state.lastSrc });
}

// ───────────────────────── 打开 / 关闭 ─────────────────────────

function readInitial() {
  try {
    if (window.AndroidBridge && typeof window.AndroidBridge.getInitial === 'function') {
      return JSON.parse(window.AndroidBridge.getInitial() || '{}');
    }
  } catch {
    /* ignore */
  }
  // 在电脑浏览器里测试：sheet.html?text=...&readonly=0
  const sp = new URLSearchParams(location.search);
  return { text: sp.get('text') || '', readonly: sp.get('readonly') !== '0', source: sp.get('text') ? 'select' : 'launcher' };
}

let closing = false;
function closeSheet() {
  if (closing) return;
  closing = true;
  cancel();
  document.body.classList.remove('open');
  setTimeout(() => {
    if (shellKind()) sendToShell({ action: 'close' });
    else closing = false; // 浏览器里测试时没有壳，就停在这里
  }, 200);
}

// 返回键：结果页 → 选择页；选择页 → 关闭
window.lhBack = () => {
  if (!el.result.hidden) showScreen('choose');
  else closeSheet();
  return 'handled';
};

function showScreen(name) {
  el.choose.hidden = name !== 'choose';
  el.result.hidden = name !== 'result';
  if (name === 'choose') {
    cancel();
    renderChoose();
  }
}

// 往下拖动把手 / 标题栏关闭
function bindDrag() {
  let y0 = null;
  let dy = 0;
  const start = (ev) => {
    if (ev.target.closest('button, a, textarea')) return;
    y0 = ev.clientY;
    dy = 0;
    el.sheet.classList.add('dragging');
  };
  const move = (ev) => {
    if (y0 == null) return;
    dy = Math.max(0, ev.clientY - y0);
    el.sheet.style.transform = `translateY(${dy}px)`;
  };
  const end = () => {
    if (y0 == null) return;
    y0 = null;
    el.sheet.classList.remove('dragging');
    el.sheet.style.transform = '';
    if (dy > 90) closeSheet();
  };
  for (const zone of [el.grab, ...document.querySelectorAll('.sh-head')]) {
    zone.addEventListener('pointerdown', start);
  }
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', end);
  window.addEventListener('pointercancel', end);
}

// ───────────────────────── ① 选择页 ─────────────────────────

function renderChoose() {
  const text = el.src.value.trim();
  const src = text ? srcOf(text) : state.lastSrc;
  el.src.lang = langAttr(src);
  el.detect.querySelector('span').textContent = text ? LANG[src] : '自动';
  el.detect.classList.toggle('switchable', isAmbiguousHan(text));

  // 目标语言：两个候选都显示出来，点选（会记住选的是首选还是备选）
  const alt = getSettings().popupAlt;
  const tgts = targetsFor(src, 'translate');
  el.targets.replaceChildren(make('span', null, '译成'));
  tgts.forEach((t, i) => {
    const b = make('button', 'tgt', LANG[t]);
    b.type = 'button';
    b.setAttribute('aria-pressed', String((i === 1) === !!alt));
    b.addEventListener('click', () => {
      saveSettings({ popupAlt: i === 1 });
      renderChoose();
    });
    el.targets.append(b);
  });
}

// ───────────────────────── ② 执行 ─────────────────────────

function cancel() {
  state.ctrl?.abort();
  state.ctrl = null;
  state.lazy = null;
}

function run(mode) {
  const text = el.src.value.trim();
  if (!text) {
    el.src.focus();
    toast('先输入文字');
    return;
  }
  el.src.blur();
  cancel();
  const ctrl = new AbortController();
  state.ctrl = ctrl;
  state.result = { yandex: '', deepseek: '' };

  const s = getSettings();
  const src = srcOf(text);
  state.lastSrc = src;
  const tgts = targetsFor(src, mode);
  const tgt = tgts[s.popupAlt && tgts.length > 1 ? 1 : 0];

  el.resultTitle.textContent =
    mode === 'translate'
      ? `翻译 · ${LANG[src]} → ${LANG[tgt]}`
      : src === tgt
        ? `润色 · ${LANG[src]}`
        : `润色 · ${LANG[src]} → ${LANG[tgt]}`;
  el.srcView.textContent = text;
  el.srcView.lang = langAttr(src);
  el.results.replaceChildren();
  el.results.scrollLeft = 0;
  showScreen('result');

  if (mode === 'translate') {
    if (s.yandex) runYandex(text, src, tgt, ctrl.signal);
    const ds = makeCard('deepseek');
    if (s.yandex && looksLikeTerm(text, src)) {
      // 像一个词：DeepSeek 等你滑到它的时候才去查询
      ds.out.classList.remove('loading');
      ds.out.classList.add('muted');
      ds.out.textContent = '滑到这里时查询';
      state.lazy = {
        root: ds.root,
        start: () => {
          ds.out.classList.remove('muted');
          ds.out.textContent = '';
          runDeepSeek(ds, text, src, tgt, mode, ctrl.signal);
        },
      };
      ds.root.addEventListener('click', startLazy); // 点一下也行
    } else {
      runDeepSeek(ds, text, src, tgt, mode, ctrl.signal);
    }
  } else {
    runDeepSeek(makeCard('deepseek'), text, src, tgt, mode, ctrl.signal);
  }
  renderDots();
}

function makeCard(svc) {
  const root = make('article', 'res-card');
  root.dataset.svc = svc;
  const head = make('div', 'res-head');
  const name = make('span', 'res-name');
  name.append(make('span', `logo ${svc}`, svc === 'yandex' ? 'Y' : 'D'), svc === 'yandex' ? 'Yandex' : 'DeepSeek');
  const time = make('span');
  head.append(name, make('span', 'spacer'), time);
  const body = make('div', 'res-body');
  const out = make('div', 'res-out loading');
  body.append(out);
  const foot = make('div', 'res-foot');
  foot.hidden = true;
  root.append(head, body, foot);
  el.results.append(root);
  return { root, body, out, foot, time };
}

// 卡片底部：［改动］……［复制］［替换］
function addActions(c, svc, extra = []) {
  c.foot.replaceChildren(...extra, make('span', 'spacer'));
  const copy = actButton(ICON.copy, '复制');
  copy.addEventListener('click', async () => toast((await copyText(state.result[svc])) ? '已复制' : '复制失败'));
  c.foot.append(copy);
  if (!state.readonly) {
    const rep = actButton(ICON.replace, '替换', 'act primary');
    rep.addEventListener('click', () => {
      if (shellKind()) sendToShell({ action: 'replace', text: state.result[svc] });
      else toast('（浏览器里测试：这里会替换原文）');
    });
    c.foot.append(rep);
  }
  c.foot.hidden = false;
}

async function runYandex(text, src, tgt, signal) {
  const c = makeCard('yandex');
  el.results.prepend(c.root); // Yandex 排第一
  renderDots();
  const t0 = performance.now();
  try {
    const r = await yandexTranslate(text, src, tgt, { signal });
    state.result.yandex = r;
    c.out.textContent = r;
    c.out.lang = langAttr(tgt);
    c.time.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} 秒`;
    addActions(c, 'yandex');
  } catch (e) {
    c.out.classList.add('muted');
    c.out.textContent = e.message;
  } finally {
    c.out.classList.remove('loading');
  }
}

async function runDeepSeek(c, text, src, tgt, mode, signal) {
  const s = getSettings();
  c.out.lang = langAttr(tgt);
  const notes = make('ul', 'res-notes');
  notes.hidden = true;
  c.body.append(notes);

  if (!s.apiKey.trim()) {
    c.out.classList.remove('loading');
    c.out.classList.add('muted');
    c.out.textContent = '还没有设置 API key：返回第一页，点右上角齿轮进入设置。';
    return;
  }

  const showNotes = mode === 'polish';
  const m = MODES[tgt]; // 写日语 / 转中文 / 写英文 三套提示词正好对应目标语言
  const params = { text, notes: showNotes };
  if (tgt === 'ja') params.register = s.register;
  if (tgt === 'zh') params.kind = detectKind(text, src === 'en' ? 'en' : 'ja');
  const renderNotes = (lines) => {
    notes.replaceChildren(...lines.map((t) => make('li', null, t)));
    notes.hidden = !showNotes || lines.length === 0;
  };

  try {
    const r = await streamChat({
      messages: buildMessages(tgt, params),
      temperature: m.temperature,
      maxTokens: m.maxTokens,
      signal,
      onText: (full) => {
        const p = splitOutput(full);
        c.out.classList.remove('loading');
        c.out.textContent = p.result;
        renderNotes(p.notes);
      },
    });
    const p = splitOutput(r.text, true);
    state.result.deepseek = p.result;
    renderNotes(p.notes);
    c.time.textContent = `${(r.total / 1000).toFixed(1)} 秒`;

    // 润色（同一种语言）时标出改动
    const d = mode === 'polish' && m.diff && src === tgt ? diff(text, p.result) : null;
    const ops = d && d.similarity >= 0.3 ? d.ops : null;
    let showDiff = !!ops && s.showDiff;
    const paint = () => {
      if (showDiff) renderDiff(c.out, ops);
      else c.out.textContent = p.result;
    };
    paint();
    const extra = [];
    if (ops) {
      const t = actButton(ICON.diff, '改动');
      t.setAttribute('aria-pressed', String(showDiff));
      t.addEventListener('click', () => {
        showDiff = !showDiff;
        t.setAttribute('aria-pressed', String(showDiff));
        saveSettings({ showDiff });
        paint();
      });
      extra.push(t);
    }
    addActions(c, 'deepseek', extra);

    store
      .put({
        id: store.newId(),
        ts: Date.now(),
        device: s.device,
        mode: tgt,
        register: params.register ?? null,
        kind: params.kind ?? null,
        lang: src,
        input: text,
        output: p.result,
        notes: p.notes,
        model: s.model,
        promptVersion: PROMPT_VERSION,
        from: 'android',
        starred: false,
        reviewed: false,
        synced: false,
      })
      .catch(() => {});
  } catch (e) {
    c.out.classList.remove('loading');
    if (e.code === 'ABORTED') return;
    c.out.classList.add('muted');
    c.out.textContent = e.message + (e.detail ? `：${String(e.detail).slice(0, 120)}` : '');
  }
}

// 卡片下面的小圆点：第几张
function renderDots() {
  const n = el.results.children.length;
  el.dots.replaceChildren(...Array.from({ length: n > 1 ? n : 0 }, () => make('span')));
  updateDots();
}
function startLazy() {
  if (!state.lazy) return;
  const go = state.lazy.start;
  state.lazy = null;
  go();
}

function updateDots() {
  const w = el.results.clientWidth || 1;
  const i = Math.round(el.results.scrollLeft / w);
  [...el.dots.children].forEach((d, k) => d.classList.toggle('on', k === i));
  if (state.lazy && el.results.children[i] === state.lazy.root) startLazy(); // 滑到了 DeepSeek
}

// ───────────────────────── 初始化 ─────────────────────────

function init() {
  const init = readInitial();
  state.readonly = init.readonly !== false;
  if (shellKind() === 'android') document.body.classList.add('in-android');
  el.src.value = init.text || '';
  // 弹窗的高度自适应内容，最多 3/4 屏
  renderChoose();

  el.backdrop.addEventListener('click', closeSheet);
  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', closeSheet);
  $('back').addEventListener('click', () => showScreen('choose'));
  for (const b of document.querySelectorAll('[data-run]')) b.addEventListener('click', () => run(b.dataset.run));
  el.src.addEventListener('input', () => {
    state.srcOverride = null;
    renderChoose();
  });
  el.detect.addEventListener('click', () => {
    const text = el.src.value.trim();
    if (!isAmbiguousHan(text)) return;
    state.srcOverride = srcOf(text) === 'zh' ? 'ja' : 'zh';
    renderChoose();
  });
  $('clear').addEventListener('click', () => {
    el.src.value = '';
    state.srcOverride = null;
    renderChoose();
    el.src.focus();
  });
  $('paste').addEventListener('click', async () => {
    try {
      const t = shellPaste() ?? (await navigator.clipboard.readText());
      if (t) {
        el.src.value = t;
        renderChoose();
      }
    } catch {
      el.src.focus();
      toast('长按输入框粘贴');
    }
  });
  el.results.addEventListener('scroll', updateDots, { passive: true });
  bindDrag();

  requestAnimationFrame(() => document.body.classList.add('open'));
  // 从桌面图标打开（没有选中文字）：直接准备输入（安卓里还要让壳把键盘弹出来）
  if (!el.src.value) {
    setTimeout(() => {
      el.src.focus();
      shellKeyboard();
    }, 250);
  }
  // 测试用：sheet.html?text=...&run=translate|polish 打开就执行
  const autoRun = new URLSearchParams(location.search).get('run');
  if (el.src.value && (autoRun === 'translate' || autoRun === 'polish')) run(autoRun);
}

init();
