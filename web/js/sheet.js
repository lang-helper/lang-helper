// 安卓 App 的页面（sheet.html），全屏布局（小窗打开时铺满小窗）。
// 入口：桌面图标 / 悬浮球（空输入框），或者选中文字后菜单里的「lang-helper」（部分手机的菜单里没有）。
//
// 只有一个画面，两种状态：
// ① 输入：原文（占满中间，回车 = 翻译）、目标语言（两个候选都显示，点选）、「翻译」「润色」两个大按钮
// ② 结果（body.has-result）：原文框用动画缩到约 1/3 屏，下面的按钮换成结果卡片，从上往下排、
//    上下滚动（Yandex → Google → DeepSeek）。点原文框 / ‹ / 返回键 → 回到 ①。
//    像一个词时 DeepSeek 先收起来，点它才查询。润色只有一张 DeepSeek 卡片（标出改动、给要点）。
//
// 和安卓壳的约定（window.AndroidBridge）：
//   getInitial() → '{"text": "...", "readonly": true|false, "source": "select"|"launcher"}'
//   postMessage('{"action":"close"}' | '{"action":"replace","text":"..."}')
//   copy(text) / paste() → 剪贴板文字 / showKeyboard()
//   返回键：壳调用 window.lhBack()

import { getSettings, saveSettings } from './settings.js';
import { MODES, PROMPT_VERSION, buildMessages } from './prompts.js';
import { streamChat } from './llm.js';
import { splitOutput } from './output.js';
import { detectKind } from './detect.js';
import { diff, renderDiff } from './diff.js';
import * as store from './history.js';
import { yandexTranslate } from './yandex.js';
import { googleTranslate } from './google.js';
import { sendToShell, shellCopy, shellPaste, shellKeyboard, shellKind } from './bridge.js';
import { LANG, sourceLang, isAmbiguousHan, targetsFor, looksLikeTerm } from './lang.js';

const $ = (id) => document.getElementById(id);
const el = {
  sheet: $('sheet'),
  title: $('title'),
  srcCard: $('src-card'),
  src: $('src'),
  detect: $('detect'),
  targets: $('targets'),
  results: $('results'),
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
  result: { yandex: '', google: '', deepseek: '' },
  lazy: null, // 像一个词时：DeepSeek 等点它才查询
  title: '', // 执行后标题栏显示的「翻译 · 中文 → 日语」
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

function closeSheet() {
  cancel();
  if (shellKind()) sendToShell({ action: 'close' });
  else toast('（浏览器里测试：这里会关闭 App）');
}

// 返回键：有结果时 → 回到输入（原文框展开、按钮回来）；输入时 → 关闭
window.lhBack = () => {
  if (isResult()) setResultMode(false);
  else closeSheet();
  return 'handled';
};

// ───────────────────────── 输入 ⇄ 结果（同一个画面） ─────────────────────────

const isResult = () => document.body.classList.contains('has-result');

// 原文框缩小后的高度：至少约 1/3 屏（不会缩成一两行），内容多时最多约 45%
function compactHeight() {
  const H = el.sheet.clientHeight;
  const ta = el.src;
  const keep = ta.style.cssText;
  ta.style.flex = 'none';
  ta.style.height = '0px';
  const textH = ta.scrollHeight; // 文字实际需要的高度
  ta.style.cssText = keep;
  const foot = el.srcCard.querySelector('.src-foot').offsetHeight;
  return Math.round(Math.min(Math.max(textH + foot, H * 0.34, 170), H * 0.46));
}

/** 切换「输入」和「结果」：原文框用动画缩小 / 展开，下面的按钮和结果卡片互换 */
function setResultMode(on) {
  if (isResult() === on) {
    if (on) el.title.textContent = state.title;
    return;
  }
  const card = el.srcCard;
  const from = card.getBoundingClientRect().height;
  for (const a of card.getAnimations?.() ?? []) a.cancel(); // 上一次的动画还没完就直接结束它
  document.body.classList.toggle('has-result', on);
  el.title.textContent = on ? state.title : 'lang-helper';
  let to;
  if (on) {
    to = compactHeight();
    card.style.height = `${to}px`;
  } else {
    card.style.height = ''; // 回到「占满中间」
    to = card.getBoundingClientRect().height;
    cancel();
    renderChoose();
  }
  if (Math.abs(from - to) > 1 && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    // 动画期间不让它被 flex 撑满，只看 height
    card.animate(
      [
        { height: `${from}px`, flexGrow: 0, flexShrink: 0 },
        { height: `${to}px`, flexGrow: 0, flexShrink: 0 },
      ],
      { duration: 280, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    );
  }
}

// 回车 = 翻译（Shift+Enter 换行，给外接键盘用）。
// 手机输入法的回车有的会发 keydown(Enter)，有的只发 beforeinput(insertLineBreak)，两种都接住；
// 拼音输入中按回车是「上屏字母」，不算。
function bindEnter() {
  let allowBreak = false;
  el.src.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    if (ev.shiftKey) {
      allowBreak = true;
      return;
    }
    if (ev.isComposing || ev.keyCode === 229) return;
    ev.preventDefault();
    run('translate');
  });
  el.src.addEventListener('beforeinput', (ev) => {
    if (ev.inputType !== 'insertLineBreak' && ev.inputType !== 'insertParagraph') return;
    if (allowBreak) {
      allowBreak = false;
      return;
    }
    if (ev.isComposing) return;
    ev.preventDefault();
    run('translate');
  });
}

// ───────────────────────── ① 输入：目标语言 ─────────────────────────

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
  state.result = { yandex: '', google: '', deepseek: '' };

  const s = getSettings();
  const src = srcOf(text);
  state.lastSrc = src;
  const tgts = targetsFor(src, mode);
  const tgt = tgts[s.popupAlt && tgts.length > 1 ? 1 : 0];

  state.title =
    mode === 'translate'
      ? `翻译 · ${LANG[src]} → ${LANG[tgt]}`
      : src === tgt
        ? `润色 · ${LANG[src]}`
        : `润色 · ${LANG[src]} → ${LANG[tgt]}`;
  el.results.replaceChildren();
  el.results.scrollTop = 0;
  setResultMode(true);

  if (mode === 'translate') {
    // 卡片从上往下排，顺序就是创建顺序：Yandex → Google → DeepSeek（越快的越靠上，
    // DeepSeek 边出字边变高也不会把上面已经出来的结果挤动）
    if (s.yandex) runMachine('yandex', text, src, tgt, ctrl.signal);
    if (s.google) runMachine('google', text, src, tgt, ctrl.signal);
    const ds = makeCard('deepseek');
    if ((s.yandex || s.google) && looksLikeTerm(text, src)) {
      // 像一个词：DeepSeek 先收起来，点它才去查询（省钱）
      ds.root.classList.add('lazy');
      ds.out.classList.remove('loading');
      ds.out.classList.add('muted');
      ds.out.textContent = '点这里用 DeepSeek 查询';
      state.lazy = {
        root: ds.root,
        start: () => {
          ds.root.classList.remove('lazy');
          ds.out.classList.remove('muted');
          ds.out.classList.add('loading');
          ds.out.textContent = '';
          runDeepSeek(ds, text, src, tgt, mode, ctrl.signal);
        },
      };
      ds.root.addEventListener('click', startLazy);
    } else {
      runDeepSeek(ds, text, src, tgt, mode, ctrl.signal);
    }
  } else {
    runDeepSeek(makeCard('deepseek'), text, src, tgt, mode, ctrl.signal);
  }
}

const SVC = {
  yandex: { name: 'Yandex', logo: 'Y', translate: yandexTranslate },
  google: { name: 'Google', logo: 'G', translate: googleTranslate },
  deepseek: { name: 'DeepSeek', logo: 'D' },
};

function makeCard(svc) {
  const root = make('article', 'res-card');
  root.dataset.svc = svc;
  const head = make('div', 'res-head');
  const name = make('span', 'res-name');
  name.append(make('span', `logo ${svc}`, SVC[svc].logo), SVC[svc].name);
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

// 免 key 的机器翻译（Yandex、Google）：一次出整段结果
async function runMachine(svc, text, src, tgt, signal) {
  const c = makeCard(svc);
  const t0 = performance.now();
  try {
    const r = await SVC[svc].translate(text, src, tgt, { signal });
    state.result[svc] = r;
    c.out.textContent = r;
    c.out.lang = langAttr(tgt);
    c.time.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} 秒`;
    addActions(c, svc);
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

function startLazy() {
  if (!state.lazy) return;
  const go = state.lazy.start;
  state.lazy = null;
  go();
}

// ───────────────────────── 初始化 ─────────────────────────

function init() {
  const init = readInitial();
  state.readonly = init.readonly !== false;
  el.src.value = init.text || '';
  renderChoose();

  for (const b of document.querySelectorAll('[data-close]')) b.addEventListener('click', closeSheet);
  $('back').addEventListener('click', () => setResultMode(false));
  for (const b of document.querySelectorAll('[data-run]')) b.addEventListener('click', () => run(b.dataset.run));
  // 有结果时点原文框 = 要改原文：原文框展开、按钮回来
  el.src.addEventListener('focus', () => setResultMode(false));
  el.src.addEventListener('click', () => setResultMode(false));
  el.src.addEventListener('input', () => {
    state.srcOverride = null;
    renderChoose();
  });
  el.detect.addEventListener('click', () => {
    const text = el.src.value.trim();
    if (!isAmbiguousHan(text)) return;
    setResultMode(false);
    state.srcOverride = srcOf(text) === 'zh' ? 'ja' : 'zh';
    renderChoose();
  });
  $('clear').addEventListener('click', () => {
    setResultMode(false);
    el.src.value = '';
    state.srcOverride = null;
    renderChoose();
    el.src.focus();
  });
  $('paste').addEventListener('click', async () => {
    setResultMode(false);
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
  bindEnter();
  // 小窗改变大小、键盘收起等：缩小后的原文框高度跟着重算
  window.addEventListener('resize', () => {
    if (isResult()) el.srcCard.style.height = `${compactHeight()}px`;
  });

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
