// PC 弹窗（popup.html）。照 pot 的布局：原文卡片 → 语言条 → 各家结果卡片。
//
// 语言：候选顺序 日语 > 中文 > 英语。目标 = 排在最前面、且不是原文语言的那个；Tab 换成剩下那个（会记住）。
//   中文 → 日语（Tab：英语）  日语 → 中文（Tab：英语）  英语 → 日语（Tab：中文）
// 模式：Shift+Tab 翻译 ⇄ 润色（会记住，Alt+Q 打开时沿用）。
// 翻译时自动分流：像一个词 → 只出 Yandex，DeepSeek 折叠着（点开或 Ctrl+Enter 才问）；句子 → 两个一起出。
// 润色：只用 DeepSeek，标出改动、给要点。
//
// 按键：Enter 执行 · Shift+Enter 换行 · Ctrl+Enter 执行并且一定问 DeepSeek · Tab 换目标语言 · Shift+Tab 翻译/润色
//       Alt+C 复制 · Alt+V 替换原文 · Alt+P 固定 · Alt+R 重试 · Esc 取消/收起
// AHK 触发键：Ctrl+Alt+Shift+F9 = 切到翻译（不执行），F10 = 切到润色（不执行），F11 = 新开输入（清空）

import { getSettings, saveSettings } from './settings.js';
import { MODES, PROMPT_VERSION, buildMessages } from './prompts.js';
import { streamChat } from './llm.js';
import { splitOutput } from './output.js';
import { detectLang, detectKind } from './detect.js';
import { diff, renderDiff } from './diff.js';
import * as store from './history.js';
import { yandexTranslate } from './yandex.js';
import { initBridge, sendToShell, shellKind } from './bridge.js';

const $ = (id) => document.getElementById(id);

const LANG = { zh: '中文', ja: '日语', en: '英语' };
const CANDIDATES = ['ja', 'zh', 'en']; // 候选目标语言的顺序

// 简体中文里不会出现的常用字（日文新字体、或和繁体相同的日文写法）。只有汉字的文本里出现这些，就当作日语。
const JP_ONLY = new RegExp(
  '[' +
    '気済駅鉄図円対発変様単読売続総関険経験検権歩毎込畑働峠枠辻覚拡帰戻渋楽薬広仏払戦残浜県恵桜沢滝稲黒' +
    '飯語話時間長東車電書買見聞開門問題際説認識記計設調議論誤請誰貸費資質価個側備優動場報実園圧業機横歴殺決満漢無為' +
    '銀録員頭顔額願類風飛飲館馬鳥鳴齢乗両亜仮伝係倉偽傷労効勢務勝勧協厳収営団増壊夢奨嬢寝専導層帯庁応悪悩愛態慣懐' +
    '択拠挙捜揺損晩暦栄歓歳殻汚浄涙災煙熱獲環産畳穏積竜粋糸紀約紅納純紙級紛細終組結絵給統絶継続維網緑緒線締練縁縄縦縮績織' +
    '罰義聴脳腸臓臨艦荘華蔵衆術衛補製複規視親観訪許訳証評詞試詩誌誕誘誠課談諸講謝護豊責貯貴賀賃賛購跡転軽較載輝輩輪' +
    '農辺連週進遅運過達違遠適選遺還郵郷鉱鋭鎖鎮閉閑閣闘陥陳陸陽隊階隠隣雑難霊頂項順預領頼飼飾養騒驚髪魚鮮鶏黙' +
    ']',
);

const ICON = {
  copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>',
  replace: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 8h12l-3-3M20 16H8l3 3"/></svg>',
  diff: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v8M8 8h8M8 18h8"/></svg>',
  fold: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 15l6-6 6 6"/></svg>',
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
  result: { deepseek: '', yandex: '' },
  lazyDeepSeek: null, // 单词时 DeepSeek 折叠着：点开时用这个函数去问
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
  const l = detectLang(text);
  if (l === 'ja' || l === 'en') return l;
  if (l === 'han') return state.srcOverride || (JP_ONLY.test(text) ? 'ja' : 'zh');
  return state.lastSrc;
}

function targetFor(src, mode) {
  const alt = getSettings().popupAlt;
  if (mode === 'polish') return src === 'zh' ? (alt ? 'en' : 'ja') : src; // 中文只能「写成」日语 / 英语
  const others = CANDIDATES.filter((l) => l !== src);
  return others[alt ? 1 : 0];
}

// 像不像一个词（决定是否只出 Yandex）：短，且没有标点、助词、动词词尾、代词、虚词
// 日文：汉字 / 片假名后面紧跟助词（「今日は」「会議に」），或出现动词 / 形容词词尾。「の」不算（「明日の会議」也是名词）。
// 只看汉字 / 片假名后面的助词，免得「かばん」「めがね」这种平假名单词被误判。
const JA_GRAMMAR = /[\p{Script=Han}\p{Script=Katakana}ー][はがをにでもへや]|ます|まし|です|でし|した|ない|たい|ませ|だった|ている|てる/u;
const ZH_GRAMMAR = /[我你您他她它们这那了吗呢吧啊呀是在把被给让很都也就还要会能想去来说过着]/;
function looksLikeTerm(text, src) {
  const t = text.trim();
  if (!t || /[\n。．！？!?、，,；;：:]/.test(t)) return false;
  if (src === 'en') return /^[A-Za-z][A-Za-z0-9'’\- ]*$/.test(t) && t.split(/\s+/).length <= 4;
  if (/[A-Za-z]/.test(t) || /\s/.test(t) || [...t].length > 12) return false;
  if (src === 'ja') return !JA_GRAMMAR.test(t);
  return !ZH_GRAMMAR.test(t);
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

// 文体的简短名称（给模型的参数还是 prompts.js 里的 REGISTERS）
const REG_SHORT = { auto: '自动', desu: '礼貌', tame: '随意', formal: '敬语' };

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
  return state.result.deepseek || state.result.yandex || '';
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

function emptyHint() {
  el.cards.replaceChildren(
    make('p', 'pp-empty', state.viewMode === 'translate' ? '按 Enter 翻译' : '按 Enter 润色（DeepSeek）'),
  );
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
  const ctrl = new AbortController();
  state.ctrl = ctrl;
  state.ranText = text;
  state.result = { deepseek: '', yandex: '' };
  state.lazyDeepSeek = null;

  const mode = state.viewMode;
  const src = srcLang(text);
  state.lastSrc = src;
  const tgt = targetFor(src, mode);
  renderTop();
  setBusy(true);

  el.cards.replaceChildren();
  const jobs = [];
  if (mode === 'translate') {
    const term = looksLikeTerm(text, src) && s.yandex;
    if (s.yandex) jobs.push(runYandex(text, src, tgt, ctrl.signal));
    if (term && !opts.forceDeepSeek) {
      // 像一个词：DeepSeek 先折叠着，点开才去问
      const c = card('deepseek', 'DeepSeek', 'D', { folded: true });
      c.foot.hidden = true;
      c.time.textContent = '点开或 Ctrl+Enter 查询';
      el.cards.append(c.root);
      state.lazyDeepSeek = () => {
        c.root.remove();
        runDeepSeek(text, src, tgt, mode, ctrl.signal, c.root);
      };
    } else {
      jobs.push(runDeepSeek(text, src, tgt, mode, ctrl.signal));
    }
  } else {
    jobs.push(runDeepSeek(text, src, tgt, mode, ctrl.signal));
  }
  await Promise.allSettled(jobs);
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

async function runYandex(text, src, tgt, signal) {
  const c = card('yandex', 'Yandex', 'Y');
  el.cards.append(c.root);
  const out = make('div', 'pp-out streaming');
  out.lang = tgt === 'zh' ? 'zh-CN' : tgt;
  c.body.append(out);
  c.foot.hidden = true;
  const t0 = performance.now();
  try {
    const r = await yandexTranslate(text, src, tgt, { signal });
    state.result.yandex = r;
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

// 新开输入（Alt+Q）：清空，回到保存的模式
function fresh() {
  cancel();
  el.src.value = '';
  state.srcOverride = null;
  state.ranText = null;
  state.result = { deepseek: '', yandex: '' };
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
      const act = { KeyC: copyPrimary, KeyV: () => replaceWith(primaryResult()), KeyR: () => run(), KeyP: togglePin }[ev.code];
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
  }
}

init();
