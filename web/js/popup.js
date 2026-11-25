// PC 弹窗（popup.html）。照 pot 的布局：原文卡片 → 语言条 → 各家结果卡片。
//
// 语言：候选顺序 日语 > 中文 > 英语。目标 = 排在最前面、且不是原文语言的那个；Tab 换成剩下那个（会记住）。
//   中文 → 日语（Tab：英语）  日语 → 中文（Tab：英语）  英语 → 日语（Tab：中文）
// 模式：Shift+Tab 翻译 ⇄ 润色（会记住，Alt+Q 打开时沿用）。
// 翻译时自动分流：像一个词 → 只出 Yandex + Google，DeepSeek 折叠着（点开或 Ctrl+Enter 才问）；句子 → 全部一起出。
// 润色：只用 DeepSeek，标出改动、给要点。
//
// 按键：Enter 执行 · Shift+Enter 换行 · Ctrl+Enter 执行并且一定问 DeepSeek · Tab 换目标语言 · Shift+Tab 翻译/润色
//       Alt+C 复制 · Alt+V 替换原文 · Alt+P 固定 · Alt+R 重试 · Esc 取消/收起
// AHK 触发键：Ctrl+Alt+Shift+F9 = 切到翻译（不执行），F10 = 切到润色（不执行），F11 = 新开输入（清空）
//             F8 = 用输入框里的文字打开 wiki 速查（wiki.html，同一个窗口）
// 像一个词时多一张「维基百科」卡片：中 / 日 / 英对应的条目名，点一下或 Alt+K 打开 wiki 速查。

import { getSettings, saveSettings } from './settings.js';
import { MODES, PROMPT_VERSION, SUBJECT, buildMessages, buildSubjectMessages } from './prompts.js';
import { streamChat } from './llm.js';
import { splitOutput } from './output.js';
import { detectLang, detectKind } from './detect.js';
import { diff, renderDiff } from './diff.js';
import * as store from './history.js';
import { yandexTranslate } from './yandex.js';
import { googleTranslate } from './google.js';
import { initBridge, sendToShell, shellKind } from './bridge.js';
import { LANG, sourceLang, targetFor as pickTarget, looksLikeTerm, REG_SHORT } from './lang.js';
import { findArticles } from './wiki.js';

const $ = (id) => document.getElementById(id);

const ICON = {
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  replace: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h12l-3-3M20 16H8l3 3"/></svg>',
  diff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v8M8 8h8M8 18h8"/></svg>',
  fold: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
  mail: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/></svg>',
};

const el = {
  src: $('src'),
  detect: $('detect'),
  target: $('target'),
  cards: $('cards'),
  run: $('run'),
  runLabel: $('run-label'),
  pin: $('pin'),
  toast: $('toast'),
};

const state = {
  viewMode: 'translate', // 当前显示的模式（Alt+D / Alt+A 只改这个；Shift+Tab 会同时保存）
  srcOverride: null, // 只有汉字时手动指定 'zh' | 'ja'
  lastSrc: 'zh',
  ctrl: null,
  ranText: null, // 上次执行时的原文（切换语言 / 模式后，同一段原文自动重跑）
  result: { deepseek: '', yandex: '', google: '' },
  lazyDeepSeek: null, // 单词时 DeepSeek 折叠着：点开时用这个函数去问
  subjectCtrl: null, // 正在生成邮件标题
  wiki: null, // 维基卡片查到的结果 { q, res }（打开 wiki 速查时带过去，省一次请求）
};

// ───────────────────────── 小工具 ─────────────────────────

function make(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function iconButton(svg, title) {
  const b = make('button', 'pp-icon');
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  b.innerHTML = svg; // 固定的图标字符串，不含用户数据
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
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = make('textarea', 'offscreen');
    ta.value = text;
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

function autoGrow() {
  el.src.style.height = 'auto';
  el.src.style.height = el.src.scrollHeight + 2 + 'px';
}

function focusEnd() {
  el.src.focus();
  const n = el.src.value.length;
  el.src.setSelectionRange(n, n);
}

// 弹窗标题栏颜色跟着背景走（Edge 应用窗口用 theme-color 给标题栏上色）
function syncTitleBarColor() {
  const bg = getComputedStyle(document.body).getPropertyValue('--bg').trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}

// ───────────────────────── 语言 / 模式 ─────────────────────────

function srcLang(text) {
  return sourceLang(text, { override: state.srcOverride, fallback: state.lastSrc });
}

function targetFor(src, mode) {
  return pickTarget(src, mode, getSettings().popupAlt);
}
function renderTop() {
  const s = getSettings();
  el.pin.setAttribute('aria-pressed', String(!!s.popupPinned));

  const text = el.src.value.trim();
  const isHan = detectLang(text) === 'han';
  const src = text ? srcLang(text) : state.lastSrc;
  const tgt = targetFor(src, state.viewMode);
  el.src.lang = src === 'zh' ? 'zh-CN' : src;

  // 原文卡片里的「● 中文」
  el.detect.querySelector('span').textContent = text ? LANG[src] : '自动';
  el.detect.classList.toggle('switchable', isHan);
  el.detect.title = isHan ? '只有汉字：点这里在「中文 / 日语」之间切换' : '识别出的原文语言';

  // 执行按钮显示当前模式
  const polish = state.viewMode === 'polish';
  el.run.classList.toggle('polish', polish);
  if (!state.ctrl) el.runLabel.textContent = polish ? '润色' : '翻译';

  // 「翻译」按钮左边的「● 日语」：目标语言。润色成日语时顺带显示文体，点一下换文体。
  const cyclesRegister = polish && tgt === 'ja';
  el.target.querySelector('span').textContent = cyclesRegister
    ? `${LANG[tgt]} · ${REG_SHORT[s.register] || REG_SHORT.auto}`
    : LANG[tgt];
  el.target.title = cyclesRegister
    ? '点这里换文体：自动（跟随原文、去掉过重敬语）→ 礼貌（です・ます）→ 随意（タメ口）→ 敬语（正式）' +
      (src === 'zh' ? '；Tab 换成英语' : '')
    : polish && src !== 'zh'
      ? '润色：保持原文的语言'
      : '目标语言（Tab 切换）';
}

// 点目标语言标签：润色成日语时换文体，否则等于按 Tab
function onTargetClick() {
  const text = el.src.value.trim();
  const src = text ? srcLang(text) : state.lastSrc;
  const tgt = targetFor(src, state.viewMode);
  if (state.viewMode === 'polish' && tgt === 'ja') {
    const keys = Object.keys(REG_SHORT);
    const cur = getSettings().register;
    saveSettings({ register: keys[(keys.indexOf(cur) + 1) % keys.length] });
    renderTop();
    rerunIfShown();
  } else if (state.viewMode === 'translate' || src === 'zh') {
    toggleAlt();
  }
}

function setViewMode(mode, persist) {
  state.viewMode = mode === 'polish' ? 'polish' : 'translate';
  if (persist) saveSettings({ popupMode: state.viewMode });
  renderTop();
}

function toggleMode() {
  setViewMode(state.viewMode === 'translate' ? 'polish' : 'translate', true);
  rerunIfShown();
}

function toggleAlt() {
  saveSettings({ popupAlt: !getSettings().popupAlt });
  renderTop();
  rerunIfShown();
}

// 已经对这段原文执行过一次，切换语言 / 模式后自动重跑
function rerunIfShown() {
  const text = el.src.value.trim();
  if (text && state.ranText === text) run();
}

// ───────────────────────── 卡片 ─────────────────────────

function card(svc, name, logo, { folded } = {}) {
  const s = getSettings();
  const c = make('article', 'pp-card');
  c.dataset.svc = svc;
  if (folded ?? s.popupCollapsed?.[svc]) c.classList.add('folded');
  const h = make('header', 'pp-card-h');
  const title = make('span', 'pp-svc');
  title.append(make('span', `pp-logo ${svc}`, logo), name);
  const time = make('span', 'pp-time');
  const fold = iconButton(ICON.fold, '折叠 / 展开');
  fold.classList.add('pp-fold');
  h.append(title, make('span', 'spacer'), time, fold);
  h.addEventListener('click', () => {
    const isFolded = c.classList.toggle('folded');
    if (svc === 'deepseek' && !isFolded && state.lazyDeepSeek) {
      const go = state.lazyDeepSeek;
      state.lazyDeepSeek = null;
      go();
      return;
    }
    saveSettings({ popupCollapsed: { ...getSettings().popupCollapsed, [svc]: isFolded } });
  });
  const b = make('div', 'pp-card-b');
  const f = make('div', 'pp-card-f');
  const copy = iconButton(ICON.copy, '复制');
  copy.addEventListener('click', () => copyFrom(svc));
  f.append(copy);
  if (shellKind() === 'ahk') {
    const rep = iconButton(ICON.replace, '用这个结果替换原文');
    rep.addEventListener('click', () => replaceWith(state.result[svc]));
    f.append(rep);
  }
  c.append(h, b, f);
  return { root: c, body: b, foot: f, time };
}

async function copyFrom(svc) {
  const t = state.result[svc];
  if (!t) return toast('还没有结果');
  const ok = await copyText(t);
  toast(ok ? '已复制' : '复制失败');
  if (ok) sendToShell({ action: 'copied' });
}

function primaryResult() {
  return state.result.deepseek || state.result.google || state.result.yandex || '';
}

async function copyPrimary() {
  const t = primaryResult();
  if (!t) return toast('还没有结果');
  const ok = await copyText(t);
  toast(ok ? '已复制' : '复制失败');
  if (ok) sendToShell({ action: 'copied' });
}

function replaceWith(t) {
  if (t) sendToShell({ action: 'replace', text: t });
  else toast('还没有结果');
}

// 还没执行时，结果区留空（不显示提示文字）
function emptyHint() {
  el.cards.replaceChildren();
}

// ───────────────────────── 执行 ─────────────────────────

function cancel() {
  if (!state.ctrl) return false;
  state.ctrl.abort();
  state.ctrl = null;
  for (const o of document.querySelectorAll('.pp-out.streaming')) o.classList.remove('streaming');
  setBusy(false);
  return true;
}

function setBusy(busy) {
  el.run.classList.toggle('busy', busy);
  el.runLabel.textContent = busy ? '停止' : state.viewMode === 'polish' ? '润色' : '翻译';
}

/** @param {{forceDeepSeek?: boolean}} [opts]  Ctrl+Enter：单词也一定问 DeepSeek */
async function run(opts = {}) {
  const text = el.src.value.trim();
  if (!text) {
    el.src.focus();
    return;
  }
  const s = getSettings();
  cancel();
  state.subjectCtrl?.abort();
  const ctrl = new AbortController();
  state.ctrl = ctrl;
  state.ranText = text;
  state.result = { deepseek: '', yandex: '', google: '' };
  state.lazyDeepSeek = null;

  const mode = state.viewMode;
  const src = srcLang(text);
  state.lastSrc = src;
  const tgt = targetFor(src, mode);
  renderTop();
  setBusy(true);

  el.cards.replaceChildren();
  const jobs = [];
  let lazy = null;
  if (mode === 'translate') {
    const term = looksLikeTerm(text, src) && (s.yandex || s.google);
    if (s.yandex) jobs.push(runMachine('yandex', text, src, tgt, ctrl.signal));
    if (s.google) jobs.push(runMachine('google', text, src, tgt, ctrl.signal));
    if (term) runWikiCard(text, ctrl.signal); // 免费的维基百科接口；不算进 jobs，不拖慢「记历史」
    if (term && !opts.forceDeepSeek) {
      // 像一个词：DeepSeek 先折叠着，点开才去问
      const c = card('deepseek', 'DeepSeek', 'D', { folded: true });
      c.foot.hidden = true;
      c.time.textContent = '点开或 Ctrl+Enter 查询';
      el.cards.append(c.root);
      lazy = () => {
        c.root.remove();
        runDeepSeek(text, src, tgt, mode, ctrl.signal, c.root);
      };
      state.lazyDeepSeek = lazy;
    } else {
      jobs.push(runDeepSeek(text, src, tgt, mode, ctrl.signal));
    }
  } else {
    jobs.push(runDeepSeek(text, src, tgt, mode, ctrl.signal));
  }
  await Promise.allSettled(jobs);
  // 查单词：机翻都出来了、也没点开 DeepSeek → 把这个词记进历史（DeepSeek 的结果会另外记）
  if (lazy && state.lazyDeepSeek === lazy && !ctrl.signal.aborted) {
    store
      .putLookup({ device: s.device, from: 'popup', src, tgt, text, results: state.result })
      .catch((e) => console.warn('保存历史失败', e));
  }
  if (state.ctrl === ctrl) {
    state.ctrl = null;
    setBusy(false);
  }
}

async function runDeepSeek(text, src, tgt, mode, signal, replaceNode) {
  const s = getSettings();
  const c = card('deepseek', 'DeepSeek', 'D', { folded: false });
  if (replaceNode && replaceNode.isConnected) replaceNode.replaceWith(c.root);
  else if (replaceNode) el.cards.append(c.root);
  else el.cards.prepend(c.root); // DeepSeek 放在最上面
  const out = make('div', 'pp-out streaming');
  out.lang = tgt === 'zh' ? 'zh-CN' : tgt;
  const notes = make('ul', 'pp-notes');
  notes.hidden = true;
  const err = make('div', 'pp-err');
  err.hidden = true;
  c.body.append(out, notes, err);
  c.foot.hidden = true;

  if (!s.apiKey.trim()) {
    out.classList.remove('streaming');
    err.hidden = false;
    err.textContent = '还没有设置 API key：点右上角齿轮进入设置。';
    return;
  }

  const showNotes = mode === 'polish'; // 翻译时不要要点
  const mk = tgt; // 写日语 / 转中文 / 写英文 三套提示词正好对应目标语言
  const m = MODES[mk];
  const params = { text, notes: showNotes };
  if (mk === 'ja') params.register = s.register;
  if (mk === 'zh') params.kind = detectKind(text, src === 'en' ? 'en' : 'ja');

  const renderNotes = (lines) => {
    notes.replaceChildren(...lines.map((t) => make('li', null, t)));
    notes.hidden = !showNotes || lines.length === 0;
  };

  try {
    const r = await streamChat({
      messages: buildMessages(mk, params),
      temperature: m.temperature,
      maxTokens: m.maxTokens,
      signal,
      onText: (full) => {
        const p = splitOutput(full);
        out.textContent = p.result;
        renderNotes(p.notes);
      },
    });
    const p = splitOutput(r.text, true);
    out.classList.remove('streaming');
    state.result.deepseek = p.result;
    renderNotes(p.notes);
    c.time.textContent = `${(r.total / 1000).toFixed(1)} 秒`;

    // 润色（同一种语言）时标出改动
    const d = mode === 'polish' && m.diff && src === tgt ? diff(text, p.result) : null;
    const ops = d && d.similarity >= 0.3 ? d.ops : null;
    let showDiff = !!ops && s.showDiff;
    const paint = () => {
      if (showDiff) renderDiff(out, ops);
      else out.textContent = p.result;
    };
    paint();
    if (ops) {
      const t = iconButton(ICON.diff, '显示 / 隐藏改动');
      t.setAttribute('aria-pressed', String(showDiff));
      t.addEventListener('click', () => {
        showDiff = !showDiff;
        t.setAttribute('aria-pressed', String(showDiff));
        saveSettings({ showDiff });
        paint();
      });
      c.foot.append(t);
    }
    if (mode === 'polish') {
      const t = iconButton(ICON.mail, '生成邮件标题（再点一次重新生成）');
      t.addEventListener('click', () => genSubjects(c.body, tgt, p.result));
      c.foot.append(t);
    }
    c.foot.hidden = false;

    store
      .put({
        id: store.newId(),
        ts: Date.now(),
        device: s.device,
        mode: mk,
        register: params.register ?? null,
        kind: params.kind ?? null,
        lang: src,
        input: text,
        output: p.result,
        notes: p.notes,
        model: s.model,
        promptVersion: PROMPT_VERSION,
        from: 'popup',
        starred: false,
        reviewed: false,
        synced: false,
      })
      .catch((e) => console.warn('保存历史失败', e));
  } catch (e) {
    out.classList.remove('streaming');
    if (e.code === 'ABORTED') {
      if (!out.textContent) out.textContent = '已取消';
      return;
    }
    err.hidden = false;
    err.textContent = e.message + (e.detail ? `：${String(e.detail).slice(0, 120)}` : '');
  }
}

// 润色后一键生成邮件标题：3 个候选，点一下复制（不会因 HideAfterCopy 收起弹窗，正文还要用）
async function genSubjects(body, lang, text) {
  state.subjectCtrl?.abort();
  const ctrl = new AbortController();
  state.subjectCtrl = ctrl;
  let box = body.querySelector('.pp-subjects');
  if (!box) {
    box = make('div', 'pp-subjects');
    body.append(box);
  }
  const head = make('div', 'pp-subjects-h', '邮件标题 · 生成中…');
  const list = make('div', 'pp-subjects-l');
  box.replaceChildren(head, list);

  const paint = (full) => {
    const lines = full
      .split('\n')
      .map((l) => l.trim().replace(/^(?:[-*•・]|\d+[.、)])\s*/, ''))
      .filter(Boolean);
    list.replaceChildren(
      ...lines.map((t) => {
        const b = make('button', 'pp-subject', t);
        b.type = 'button';
        b.lang = lang;
        b.title = '复制这个标题';
        b.addEventListener('click', async () => toast((await copyText(t)) ? '已复制标题' : '复制失败'));
        return b;
      }),
    );
  };

  try {
    const r = await streamChat({
      messages: buildSubjectMessages(lang, text),
      temperature: SUBJECT.temperature,
      maxTokens: SUBJECT.maxTokens,
      signal: ctrl.signal,
      onText: paint,
    });
    paint(r.text);
    head.textContent = '邮件标题（点一下复制）';
  } catch (e) {
    if (e.code === 'ABORTED') return;
    head.textContent = '生成标题失败：' + e.message;
  } finally {
    if (state.subjectCtrl === ctrl) state.subjectCtrl = null;
  }
}

// 免 key 的机器翻译（Yandex、Google）：一次出整段结果
const MACHINE = {
  yandex: { name: 'Yandex', logo: 'Y', translate: yandexTranslate },
  google: { name: 'Google', logo: 'G', translate: googleTranslate },
};

async function runMachine(svc, text, src, tgt, signal) {
  const m = MACHINE[svc];
  const c = card(svc, m.name, m.logo);
  el.cards.append(c.root);
  const out = make('div', 'pp-out streaming');
  out.lang = tgt === 'zh' ? 'zh-CN' : tgt;
  c.body.append(out);
  c.foot.hidden = true;
  const t0 = performance.now();
  try {
    const r = await m.translate(text, src, tgt, { signal });
    state.result[svc] = r;
    out.textContent = r;
    c.time.textContent = `${((performance.now() - t0) / 1000).toFixed(1)} 秒`;
    c.foot.hidden = false;
  } catch (e) {
    out.classList.add('muted');
    out.textContent = e.message;
  } finally {
    out.classList.remove('streaming');
  }
}

// ───────────────────────── 维基百科 ─────────────────────────

const WIKI_TAG = { zh: '中', ja: '日', en: '英' };
const WIKI_HTML_LANG = { zh: 'zh-CN', ja: 'ja', en: 'en' };

/** 像一个词时：查中 / 日 / 英维基里对应的条目名（通常 1 个请求） */
async function runWikiCard(text, signal) {
  const c = card('wiki', '维基百科', 'W');
  c.foot.replaceChildren();
  c.foot.hidden = true;
  c.time.textContent = 'Alt+K 速查';
  el.cards.append(c.root);
  const out = make('div', 'pp-out muted', '查找对应词条…');
  c.body.append(out);
  try {
    const res = await findArticles(text, { signal });
    if (signal.aborted) return;
    state.wiki = { q: text, res };
    const a = res.list[0];
    if (!a) {
      out.textContent = '没找到对应的维基词条（Alt+K 打开速查换个说法）';
      return;
    }
    const rows = make('div', 'pp-wiki');
    if (res.list.length > 1) {
      // 拿不准（消歧义 / 搜索出好几个）：列出前几个候选，点哪个就在速查里打开哪个
      for (const x of res.list.slice(0, 4)) {
        const r = make('button', 'pp-wiki-row pp-wiki-cand');
        r.type = 'button';
        const names = ['zh', 'ja', 'en'].map((l) => x.labels?.[l] || x.links[l]).filter(Boolean);
        r.append(make('span', 'pp-wiki-name', [...new Set(names)].join(' · ')));
        if (x.desc) r.append(make('span', 'pp-wiki-desc', x.desc));
        r.addEventListener('click', () => openWiki(text, null, x.id));
        rows.append(r);
      }
      rows.append(
        make('div', 'pp-wiki-note', `${res.kind === 'disambig' ? '有好几个意思' : '没有同名条目，这是搜索结果'}（共 ${res.list.length} 个，Alt+K 打开速查挑）`),
      );
      out.replaceWith(rows);
      return;
    }
    for (const l of ['zh', 'ja', 'en']) {
      const r = make('button', 'pp-wiki-row');
      r.type = 'button';
      r.disabled = !a.links[l];
      r.title = a.links[l] ? '在 wiki 速查里打开' : '没有对应条目';
      const name = make('span', 'pp-wiki-name', a.links[l] ? a.labels[l] || a.links[l] : '—');
      name.lang = WIKI_HTML_LANG[l];
      r.append(make('span', 'pp-wiki-tag', WIKI_TAG[l]), name);
      r.addEventListener('click', () => openWiki(text, l));
      rows.append(r);
    }
    if (a.via) rows.append(make('div', 'pp-wiki-note', `重定向：${a.via}`));
    else if (res.kind === 'search') rows.append(make('div', 'pp-wiki-note', '没有同名条目，这是最接近的结果'));
    out.replaceWith(rows);
  } catch (e) {
    if (signal.aborted || e.name === 'AbortError') return;
    out.textContent = e.code === 'RATE' ? e.message : '查维基失败：' + (e.message || e);
  }
}

/** 在这个窗口里打开 wiki 速查（Alt+K / AHK 的 F8）。回来时恢复现在的原文 */
function openWiki(text, lang, id) {
  const q = (text ?? el.src.value).trim().slice(0, 200);
  const cur = el.src.value.trim();
  sessionStorage.setItem(
    'lh.popupRestore',
    JSON.stringify({ text: el.src.value, mode: state.viewMode, run: !!cur && state.ranText === cur }),
  );
  if (q && state.wiki?.q === q) sessionStorage.setItem('lh.wikiPrefetch', JSON.stringify(state.wiki));
  else sessionStorage.removeItem('lh.wikiPrefetch');
  cancel();
  const hash = q ? `#q=${encodeURIComponent(q)}${lang ? '&lang=' + lang : ''}${id ? '&id=' + id : ''}` : '';
  location.replace('wiki.html' + hash);
}

// 从 wiki 速查回来：恢复原文。之前执行过、而且是一个词的，自动重新执行（单词只问免费的机翻，DeepSeek 折叠着）；
// 句子不自动执行，免得再花一次 DeepSeek 的钱
function restoreFromWiki() {
  let r = null;
  try {
    r = JSON.parse(sessionStorage.getItem('lh.popupRestore') || 'null');
  } catch {
    /* ignore */
  }
  sessionStorage.removeItem('lh.popupRestore');
  if (!r?.text) return;
  el.src.value = r.text;
  autoGrow();
  setViewMode(r.mode, false);
  const t = r.text.trim();
  if (r.run && state.viewMode === 'translate' && looksLikeTerm(t, srcLang(t))) run();
}

// 新开输入（Alt+Q）：清空，回到保存的模式
function fresh() {
  cancel();
  state.subjectCtrl?.abort();
  el.src.value = '';
  state.srcOverride = null;
  state.ranText = null;
  state.result = { deepseek: '', yandex: '', google: '' };
  state.lazyDeepSeek = null;
  setViewMode(getSettings().popupMode, false);
  autoGrow();
  emptyHint();
  el.src.focus();
}

// 图钉（Alt+P）：固定后点别处不收起，并置顶
function togglePin() {
  const pinned = !getSettings().popupPinned;
  saveSettings({ popupPinned: pinned });
  renderTop();
  sendToShell({ action: pinned ? 'pin-on' : 'pin-off' });
  toast(pinned ? '已固定' : '已取消固定');
}

// ───────────────────────── 绑定 ─────────────────────────

function bind() {
  el.pin.addEventListener('click', togglePin);
  el.target.addEventListener('click', onTargetClick);
  el.run.addEventListener('click', () => (state.ctrl ? cancel() : run()));
  $('clear').addEventListener('click', fresh);
  $('copy-src').addEventListener('click', async () => {
    const t = el.src.value;
    if (t) toast((await copyText(t)) ? '已复制原文' : '复制失败');
  });
  el.detect.addEventListener('click', () => {
    const text = el.src.value.trim();
    if (detectLang(text) !== 'han') return;
    state.srcOverride = srcLang(text) === 'zh' ? 'ja' : 'zh';
    renderTop();
    rerunIfShown();
  });
  el.src.addEventListener('input', () => {
    autoGrow();
    renderTop();
  });

  document.addEventListener('keydown', (ev) => {
    // AHK 发来的触发键：只切模式、不执行（你可以先改原文，再按 Enter）
    if (ev.ctrlKey && ev.altKey && ev.shiftKey) {
      if (ev.code === 'F9' || ev.code === 'F10') {
        ev.preventDefault();
        cancel();
        state.srcOverride = null;
        state.ranText = null;
        autoGrow();
        setViewMode(ev.code === 'F9' ? 'translate' : 'polish', false);
        emptyHint();
        focusEnd();
        return;
      }
      if (ev.code === 'F11') {
        ev.preventDefault();
        fresh();
        return;
      }
      if (ev.code === 'F8') {
        ev.preventDefault();
        openWiki();
        return;
      }
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      if (!cancel()) sendToShell({ action: 'close' });
      return;
    }
    if (ev.key === 'Tab' && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      ev.preventDefault();
      if (ev.shiftKey) toggleMode();
      else toggleAlt();
      return;
    }
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) {
      if (document.activeElement === el.src || ev.ctrlKey) {
        ev.preventDefault();
        run({ forceDeepSeek: ev.ctrlKey });
      }
      return;
    }
    if (ev.altKey && !ev.ctrlKey && !ev.metaKey) {
      const act = {
        KeyC: copyPrimary,
        KeyV: () => replaceWith(primaryResult()),
        KeyR: () => run(),
        KeyP: togglePin,
        KeyK: () => openWiki(),
        KeyW: () => {
          cancel();
          sendToShell({ action: 'close' }); // Alt+W：收起弹窗
        },
      }[ev.code];
      if (act) {
        ev.preventDefault();
        act();
      }
    }
  });

  // 弹窗出现时让输入框获得焦点，并把图钉状态告诉 AHK（AHK 可能刚重启过）
  window.addEventListener('focus', () => {
    el.src.focus();
    sendToShell({ action: getSettings().popupPinned ? 'pin-on' : 'pin-off' });
  });
}

function init() {
  document.body.classList.add('embed');
  const s = getSettings();
  state.viewMode = s.popupMode;
  initBridge(() => {});
  bind();
  renderTop();
  emptyHint();
  syncTitleBarColor();
  el.src.focus();
  setTimeout(() => sendToShell({ action: s.popupPinned ? 'pin-on' : 'pin-off' }), 300);

  // ?text=...&pmode=polish&run=1：带文字打开（开发测试、以后从别的程序调用都可以用）
  const sp = new URLSearchParams(location.search);
  const text = sp.get('text');
  if (location.search) window.history.replaceState(null, '', location.pathname);
  if (text) {
    el.src.value = text;
    autoGrow();
    setViewMode(sp.get('pmode') === 'polish' ? 'polish' : 'translate', false);
    if (sp.get('run') === '1') run({ forceDeepSeek: sp.get('ds') === '1' });
  } else {
    restoreFromWiki();
  }
}

init();
