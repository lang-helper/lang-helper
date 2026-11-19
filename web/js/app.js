import { getSettings, saveSettings, clearSettings } from './settings.js';
import { MODES, PROMPT_VERSION, buildMessages } from './prompts.js';
import { streamChat } from './llm.js';
import { splitOutput } from './output.js';
import { detectLang, detectKind, describeInput } from './detect.js';
import { diff, renderDiff } from './diff.js';
import * as store from './history.js';
import { initBridge, isEmbedded, sendToShell, shellKind, setShellPage, shellSaveFile } from './bridge.js';
import { createWikiView } from './wiki-ui.js';

const $ = (id) => document.getElementById(id);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const el = {
  workspace: $('workspace'),
  input: $('input'),
  detect: $('detect'),
  count: $('count'),
  clear: $('btn-clear'),
  paste: $('btn-paste'),
  targetLabel: $('target-label'),
  status: $('status'),
  output: $('output'),
  wiki: $('wiki'),
  panelOut: $('panel-out'),
  error: $('error'),
  notesWrap: $('notes-wrap'),
  notes: $('notes'),
  outFoot: $('out-foot'),
  diff: $('btn-diff'),
  copy: $('btn-copy'),
  replace: $('btn-replace'),
  retry: $('btn-retry'),
  dock: $('dock'),
  toast: $('toast'),
};

const MODE_KEYS = ['ja', 'zh', 'en', 'wiki'];
const MODE_LABEL = { ja: '写日语', zh: '转中文', en: '写英文', wiki: '查名词' };
const PLACEHOLDER = {
  ja: '输入日语、中文，或中日混写',
  zh: '输入日语或英语的词、句子',
  en: '输入英语、中文，或中英混写',
  wiki: '输入名词（中/英/日），或一段描述',
};
const TARGET_LABEL = { ja: '日语', zh: '中文', en: '英语', wiki: 'Wikipedia' };
const INPUT_LANG = { ja: 'ja', zh: 'ja', en: 'en', wiki: '' };
const coarse = matchMedia('(pointer: coarse)').matches;
const narrow = matchMedia('(max-width: 760px)');

const state = {
  mode: 'ja',
  ctrl: null, // 正在进行的请求
  lastInput: '',
  last: null, // { mode, input, result, notes, diffOps, status }
  lastByMode: {}, // 每个模式各自保留最后一次结果，切换模式再切回来还在
  canReplace: false,
  wikiRecorded: new Set(),
};
let wikiView = null;

// ───────────────────────── 工具 ─────────────────────────

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
  toastTimer = setTimeout(() => (el.toast.hidden = true), 1600);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = make('textarea', 'offscreen');
    ta.value = text;
    ta.setAttribute('readonly', '');
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

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  const md = `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.getFullYear() === new Date().getFullYear() ? md : `${d.getFullYear()}/${md}`;
}

function ymd() {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
}

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme || 'dark');
  const bg = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
}

// ───────────────────────── 模式 / 文体 / 输入 ─────────────────────────

function setMode(mode) {
  if (!MODE_LABEL[mode]) mode = 'ja';
  if (mode !== state.mode && state.ctrl) {
    cancel(true);
    el.output.classList.remove('streaming');
  }
  state.mode = mode;
  for (const b of $$('.mode-btn')) b.setAttribute('aria-selected', String(b.dataset.mode === mode));
  for (const g of $$('.reg-group')) g.hidden = mode !== 'ja';
  el.input.placeholder = PLACEHOLDER[mode];
  el.input.lang = INPUT_LANG[mode];
  el.targetLabel.textContent = TARGET_LABEL[mode];
  el.panelOut.classList.toggle('is-wiki', mode === 'wiki');
  saveSettings({ mode });
  updateInputMeta();
  setBusy(!!state.ctrl);
  showModeOutput();
}

// 切换模式时，显示这个模式自己的最后结果
function showModeOutput() {
  el.error.hidden = true;
  if (state.mode === 'wiki') {
    el.outFoot.hidden = true;
    const q = el.input.value.trim();
    if (q !== wikiView.query) wikiView.search(q);
    else setStatus(q ? state.wikiStatus || '' : '');
    el.workspace.classList.toggle('has-output', !!q);
  } else {
    const L = state.lastByMode[state.mode] || null;
    state.last = L;
    if (L) {
      el.output.lang = MODES[state.mode].outLang;
      renderResult();
      setStatus(L.status || '');
      el.workspace.classList.add('has-output');
    } else {
      el.output.textContent = '';
      renderNotes([]);
      el.outFoot.hidden = true;
      setStatus('');
      el.workspace.classList.remove('has-output');
    }
  }
  autoGrow();
}

let wikiTimer;
let composing = false;
function scheduleWikiSearch(delay = 400) {
  if (state.mode !== 'wiki') return;
  clearTimeout(wikiTimer);
  wikiTimer = setTimeout(() => {
    const q = el.input.value.trim();
    el.workspace.classList.toggle('has-output', !!q);
    autoGrow();
    wikiView.search(q);
  }, delay);
}

function setRegister(reg) {
  for (const b of $$('[data-reg]')) b.setAttribute('aria-checked', String(b.dataset.reg === reg));
  saveSettings({ register: reg });
}

function updateInputMeta() {
  const v = el.input.value;
  el.detect.textContent = describeInput(state.mode, v);
  el.count.textContent = v ? `${[...v].length} 字` : '';
  el.clear.hidden = !v;
}

// 输入框高度：电脑宽屏 / 手机还没结果时由布局撑满；窄窗口和手机有结果时随内容长高（手机最多 40% 屏高）。
function autoGrow() {
  const ta = el.input;
  const grow = coarse ? el.workspace.classList.contains('has-output') : narrow.matches;
  if (!grow) {
    ta.style.height = '';
    return;
  }
  ta.style.height = 'auto';
  const cap = coarse ? Math.round(window.innerHeight * 0.4) : Infinity;
  ta.style.height = Math.min(ta.scrollHeight + 2, cap) + 'px';
}

// 清空原文时连结果一起清掉（和 DeepL 一样）
function resetOutput() {
  cancel(true);
  setBusy(false);
  state.last = null;
  state.lastByMode[state.mode] = null;
  if (state.mode === 'wiki') wikiView.search('');
  el.workspace.classList.remove('has-output');
  el.output.textContent = '';
  el.output.classList.remove('streaming');
  renderNotes([]);
  el.error.hidden = true;
  el.outFoot.hidden = true;
  setStatus('');
}

function focusInputEnd() {
  el.input.focus();
  const n = el.input.value.length;
  el.input.setSelectionRange(n, n);
}

function setInput(text) {
  el.input.value = text;
  autoGrow();
  updateInputMeta();
  scheduleWikiSearch(0);
}

// ───────────────────────── 执行 ─────────────────────────

function setStatus(t) {
  el.status.textContent = t;
}

function setBusy(busy) {
  const idle = state.mode === 'wiki' ? 'AI 猜' : '执行';
  for (const b of $$('.run-btn')) {
    b.classList.toggle('busy', busy);
    b.setAttribute('aria-label', busy ? '停止' : idle);
  }
  for (const l of $$('.run-label')) l.textContent = busy ? '停止' : idle;
}

function cancel(silent) {
  const c = state.ctrl;
  if (!c) return false;
  state.ctrl = null;
  c.abort();
  if (!silent) {
    setBusy(false);
    el.output.classList.remove('streaming');
    setStatus('已取消');
  }
  return true;
}

function renderNotes(lines) {
  el.notes.replaceChildren(...lines.map((t) => make('li', null, t)));
  el.notesWrap.hidden = lines.length === 0;
}

function renderResult() {
  const L = state.last;
  if (!L) return;
  const showDiff = !!L.diffOps && el.diff.getAttribute('aria-pressed') === 'true';
  el.diff.hidden = !L.diffOps;
  if (showDiff) renderDiff(el.output, L.diffOps);
  else el.output.textContent = L.result;
  renderNotes(L.notes);
  el.replace.hidden = !state.canReplace;
  el.outFoot.hidden = false;
}

function showError(e, partial) {
  el.error.replaceChildren(make('div', null, e.message || String(e)));
  if (e.detail) el.error.append(make('div', 'hint', String(e.detail).slice(0, 300)));
  if (e.code === 'NO_KEY' || e.code === 'HTTP_401') {
    const a = make('a', null, '去设置');
    a.href = '#settings';
    el.error.append(a);
  }
  el.error.hidden = false;
  if (!partial) el.output.textContent = '';
  setStatus(e.code === 'ABORTED' ? '已取消' : '出错了');
}

async function run(textArg) {
  const text = (textArg ?? el.input.value).trim();
  if (!text) {
    focusInputEnd();
    return;
  }
  const s = getSettings();
  if (!s.apiKey.trim()) {
    toast('先在设置里填 API key');
    location.hash = '#settings';
    return;
  }
  if (state.mode === 'wiki') return runWikiGuess(text);

  cancel(true);
  const mode = state.mode;
  const m = MODES[mode];
  const lang = detectLang(text);
  const params = { text };
  if (mode === 'ja') params.register = s.register;
  if (mode === 'zh') params.kind = detectKind(text, lang === 'en' ? 'en' : 'ja');

  const ctrl = new AbortController();
  state.ctrl = ctrl;
  state.lastInput = text;
  state.last = null;

  el.workspace.classList.add('has-output');
  autoGrow();
  el.output.lang = m.outLang;
  el.output.textContent = '';
  el.output.classList.add('streaming');
  renderNotes([]);
  el.error.hidden = true;
  el.outFoot.hidden = true;
  setBusy(true);
  setStatus('请求中…');
  if (coarse) {
    el.input.blur(); // 收起输入法，让结果露出来
    requestAnimationFrame(() => $('panel-out').scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  }

  let parts = { result: '', notes: [] };
  try {
    const r = await streamChat({
      messages: buildMessages(mode, params),
      temperature: m.temperature,
      maxTokens: m.maxTokens,
      signal: ctrl.signal,
      onText: (full) => {
        if (state.ctrl !== ctrl) return;
        parts = splitOutput(full);
        el.output.textContent = parts.result;
        renderNotes(parts.notes);
        setStatus('生成中…');
      },
    });
    if (state.ctrl !== ctrl) return;

    parts = splitOutput(r.text, true);
    const d = m.diff ? diff(text, parts.result) : null;
    state.last = {
      mode,
      input: text,
      result: parts.result,
      notes: parts.notes,
      diffOps: d && d.similarity >= 0.3 ? d.ops : null,
      status: `${(r.total / 1000).toFixed(1)} 秒`,
    };
    state.lastByMode[mode] = state.last;
    renderResult();
    setStatus(state.last.status);

    store
      .put({
        id: store.newId(),
        ts: Date.now(),
        device: s.device,
        mode,
        register: params.register ?? null,
        kind: params.kind ?? null,
        lang,
        input: text,
        output: parts.result,
        notes: parts.notes,
        model: s.model,
        promptVersion: PROMPT_VERSION,
        starred: false,
        reviewed: false,
        synced: false,
      })
      .catch((err) => console.warn('保存历史失败', err));
  } catch (e) {
    if (state.ctrl !== ctrl) return; // 已被新的请求或「停止」取代
    showError(e, !!parts.result);
  } finally {
    if (state.ctrl === ctrl) {
      state.ctrl = null;
      setBusy(false);
      el.output.classList.remove('streaming');
    }
  }
}

// 查名词模式下按「AI 猜」
async function runWikiGuess(text) {
  cancel(true);
  const ctrl = new AbortController();
  state.ctrl = ctrl;
  state.lastInput = text;
  el.workspace.classList.add('has-output');
  autoGrow();
  setBusy(true);
  setStatus('AI 正在猜…');
  if (coarse) el.input.blur();
  try {
    await wikiView.guess(text, ctrl.signal);
  } catch (e) {
    if (state.ctrl !== ctrl) return;
    setStatus(e.code === 'ABORTED' ? '已取消' : '出错了');
  } finally {
    if (state.ctrl === ctrl) {
      state.ctrl = null;
      setBusy(false);
    }
  }
}

// 复制名词查询里的某个日文名，并记进历史（同一次查询的同一个词只记一次）
async function copyWikiTerm(c, query, source) {
  const ok = await copyText(c.ja);
  toast(ok ? `已复制「${c.ja}」` : '复制失败');
  if (!ok) return;
  if (isEmbedded()) sendToShell({ action: 'copied' });
  const key = `${query}\u0000${c.ja}`;
  if (state.wikiRecorded.has(key)) return;
  state.wikiRecorded.add(key);
  const s = getSettings();
  const info = c.verified || c;
  const notes = [
    [info.zh || c.zh, info.en || c.en].filter(Boolean).join(' · '),
    c.reading ? `读音：${c.reading}` : '',
    info.jaAliases?.length ? `别名：${info.jaAliases.join('、')}` : '',
    source === 'ai' ? `AI 猜的${c.verified ? '（Wikipedia 有条目）' : '（未验证）'}：${c.note}` : info.desc,
  ].filter(Boolean);
  store
    .put({
      id: store.newId(),
      ts: Date.now(),
      device: s.device,
      mode: 'wiki',
      register: null,
      kind: source,
      lang: detectLang(query),
      input: query,
      output: c.ja,
      notes,
      model: source === 'ai' ? s.model : 'wikidata',
      promptVersion: PROMPT_VERSION,
      starred: false,
      reviewed: false,
      synced: false,
    })
    .catch((err) => console.warn('保存历史失败', err));
}

async function copyResult() {
  if (state.mode === 'wiki') {
    if (!wikiView.copyCurrent()) toast('没有可复制的');
    return;
  }
  const t = state.last?.result ?? el.output.textContent;
  if (!t) return;
  const ok = await copyText(t);
  toast(ok ? '已复制' : '复制失败');
  if (ok && isEmbedded()) sendToShell({ action: 'copied' });
}

// 用结果替换原文（只在 PC 弹窗 / 安卓壳里有用）
function replaceOriginal() {
  const t = state.mode === 'wiki' ? wikiView.currentTerm() : state.last?.result;
  if (t) sendToShell({ action: 'replace', text: t });
}

function retry() {
  run(state.lastInput || el.input.value);
}

// 壳或「分享」传进来的文字
function openWith({ mode, text, autorun = true, canReplace = false }) {
  if (mode) setMode(mode);
  state.canReplace = canReplace || shellKind() === 'ahk';
  if (location.hash) location.hash = '';
  setInput(text);
  // 查名词：只做免费的 Wikipedia 搜索，不自动调用 AI
  if (autorun && text.trim() && state.mode !== 'wiki') run();
  else focusInputEnd();
}

// ───────────────────────── 历史 ─────────────────────────

const H = { items: [], shown: 0, PAGE: 50 };

async function renderHistory(reset) {
  const list = $('h-list');
  if (reset) {
    H.items = await store.query({
      mode: $('h-mode').value,
      q: $('h-search').value,
      starred: $('h-starred').checked,
    });
    H.shown = 0;
    list.replaceChildren();
    if (!H.items.length) list.append(make('p', 'hint empty', '还没有记录。'));
  }
  const next = H.items.slice(H.shown, H.shown + H.PAGE);
  list.append(...next.map(historyItem));
  H.shown += next.length;
  $('h-more').hidden = H.shown >= H.items.length;
  $('h-count').textContent = `${H.items.length} 条`;
}

function historyItem(e) {
  const root = make('article', 'h-item');

  const meta = make('div', 'h-meta');
  const star = make('button', 'star', e.starred ? '★' : '☆');
  star.type = 'button';
  star.title = '收藏';
  star.setAttribute('aria-pressed', String(!!e.starred));
  star.addEventListener('click', async () => {
    e.starred = !e.starred;
    await store.update(e.id, { starred: e.starred });
    star.textContent = e.starred ? '★' : '☆';
    star.setAttribute('aria-pressed', String(e.starred));
  });
  meta.append(
    make('span', 'badge', MODE_LABEL[e.mode] || e.mode),
    make('span', null, fmtTime(e.ts)),
    make('span', null, e.device || ''),
    make('span', 'spacer'),
    star,
  );

  const input = make('div', 'h-in', e.input);
  const output = make('div', 'h-out', e.output);
  output.lang = e.mode === 'wiki' ? 'ja' : MODES[e.mode]?.outLang || '';

  const detail = make('div', 'h-detail');
  detail.hidden = true;
  if (e.notes?.length) {
    const ul = make('ul', 'notes');
    ul.append(...e.notes.map((t) => make('li', null, t)));
    detail.append(ul);
  }
  const actions = make('div', 'bar');
  const bCopy = make('button', 'chip strong', '复制结果');
  const bReuse = make('button', 'chip', '再次使用');
  const bDel = make('button', 'btn ghost danger', '删除');
  for (const b of [bCopy, bReuse, bDel]) b.type = 'button';
  bCopy.addEventListener('click', async () => toast((await copyText(e.output)) ? '已复制' : '复制失败'));
  bReuse.addEventListener('click', () => {
    setMode(e.mode);
    if (e.register) setRegister(e.register);
    location.hash = '';
    setInput(e.input);
  });
  bDel.addEventListener('click', async () => {
    if (!confirm('删除这条记录？')) return;
    await store.remove(e.id);
    H.items = H.items.filter((x) => x.id !== e.id);
    H.shown--;
    root.remove();
    $('h-count').textContent = `${H.items.length} 条`;
  });
  actions.append(bCopy, bReuse, make('span', 'spacer'), bDel);
  detail.append(actions);

  root.append(meta, input, output, detail);
  root.addEventListener('click', (ev) => {
    if (ev.target.closest('button, a, input, select')) return;
    if (String(window.getSelection())) return; // 正在选文字
    const open = root.classList.toggle('open');
    detail.hidden = !open;
  });
  return root;
}

// ───────────────────────── 设置 ─────────────────────────

const FIELDS = ['apiKey', 'baseUrl', 'model', 'firstTokenTimeout', 'device'];

function loadSettingsForm() {
  const s = getSettings();
  for (const k of FIELDS) $('s-' + k).value = s[k];
  $('s-disableThinking').checked = s.disableThinking;
  $('s-yandex').checked = s.yandex;
  $('s-google').checked = s.google;
  $('s-theme').value = s.theme;
  $('s-pver').textContent = PROMPT_VERSION;
}

function bindSettings() {
  for (const k of FIELDS) {
    $('s-' + k).addEventListener('change', (ev) => {
      let v = ev.target.value;
      if (k === 'firstTokenTimeout') v = Math.min(60, Math.max(3, Math.round(Number(v)) || 8));
      else v = v.trim();
      if (k === 'baseUrl' && !v) v = 'https://api.deepseek.com';
      if (k === 'model' && !v) v = 'deepseek-flash';
      saveSettings({ [k]: v });
      ev.target.value = v;
      toast('已保存');
    });
  }
  $('s-disableThinking').addEventListener('change', (ev) => {
    saveSettings({ disableThinking: ev.target.checked });
    toast('已保存');
  });
  $('s-yandex').addEventListener('change', (ev) => {
    saveSettings({ yandex: ev.target.checked });
    toast('已保存');
  });
  $('s-google').addEventListener('change', (ev) => {
    saveSettings({ google: ev.target.checked });
    toast('已保存');
  });
  $('s-theme').addEventListener('change', (ev) => {
    saveSettings({ theme: ev.target.value });
    applyTheme(ev.target.value);
  });
  $('settings-form').addEventListener('submit', (ev) => ev.preventDefault());
  $('s-showKey').addEventListener('click', () => {
    const i = $('s-apiKey');
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    $('s-showKey').textContent = show ? '隐藏' : '显示';
  });
  $('s-test').addEventListener('click', async () => {
    const out = $('s-test-result');
    out.textContent = '测试中…';
    try {
      const r = await streamChat({ messages: [{ role: 'user', content: '只回复 OK' }], maxTokens: 5, temperature: 0 });
      out.textContent = `✓ 连接成功（首字 ${(r.ttft / 1000).toFixed(1)} 秒）`;
    } catch (e) {
      out.textContent = `✗ ${e.message}${e.detail ? '：' + String(e.detail).slice(0, 120) : ''}`;
    }
  });
  $('s-wipe').addEventListener('click', async () => {
    if (!confirm('清除这台设备上的 API key、设置和全部历史记录？此操作无法撤销。')) return;
    await store.wipe();
    clearSettings();
    toast('已清除');
    setTimeout(() => location.reload(), 600);
  });
}

// ───────────────────────── 路由 ─────────────────────────

function route() {
  const v = location.hash.replace(/^#/, '');
  const view = ['history', 'settings'].includes(v) ? v : 'main';
  // PC 弹窗里，这个页面只用来改设置 / 看历史；回到主界面 = 回到弹窗页
  if (view === 'main' && shellKind() === 'ahk') {
    location.replace('popup.html');
    return;
  }
  // 安卓 App 里同理：回到主界面 = 回到手机弹窗
  if (view === 'main' && shellKind() === 'android') {
    location.replace('sheet.html');
    return;
  }
  for (const id of ['main', 'history', 'settings']) $('view-' + id).hidden = id !== view;
  el.dock.hidden = view !== 'main';
  if (view === 'history') renderHistory(true);
  if (view === 'settings') loadSettingsForm();
  if (view === 'main' && !coarse) el.input.focus();
}

// ───────────────────────── 手机：底部操作栏 ─────────────────────────

// 操作栏贴着输入法上沿：
// 支持 interactive-widget=resizes-content 的浏览器（新版 Android Chrome）会自动把页面缩到键盘上方，--kb 为 0；
// 不支持的，就用 visualViewport 算出被键盘挡住的高度，把操作栏往上抬。
function setupDock() {
  const root = document.documentElement.style;
  const vv = window.visualViewport;
  if (vv) {
    const update = () =>
      root.setProperty('--kb', Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) + 'px');
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
  }
  const setDockH = () => root.setProperty('--dock-h', (coarse ? el.dock.offsetHeight : 0) + 'px');
  setDockH();
  if ('ResizeObserver' in window) new ResizeObserver(setDockH).observe(el.dock);
}

// 点空白处就进入输入（手机：主界面任何空白处；电脑：输入栏的空白处）
function bindTapToFocus() {
  document.addEventListener('click', (ev) => {
    if ($('view-main').hidden) return;
    if (ev.target.closest('header, .dock, button, a, input, textarea, select, label, .output, .notes-wrap, .error, .toast')) return;
    if (String(window.getSelection())) return;
    if (!coarse && !ev.target.closest('#panel-in')) return;
    focusInputEnd();
  });
}

// ───────────────────────── 初始化 ─────────────────────────

function bindMain() {
  for (const b of $$('.mode-btn')) {
    b.addEventListener('click', () => {
      setMode(b.dataset.mode);
      if (!coarse) el.input.focus();
    });
  }
  for (const b of $$('[data-reg]')) b.addEventListener('click', () => setRegister(b.dataset.reg));
  for (const b of $$('.run-btn')) b.addEventListener('click', () => (state.ctrl ? cancel(false) : run()));

  el.input.addEventListener('input', (ev) => {
    autoGrow();
    updateInputMeta();
    if (!ev.isComposing && !composing) scheduleWikiSearch(); // 输入法还在选字时不查
  });
  el.input.addEventListener('compositionstart', () => (composing = true));
  el.input.addEventListener('compositionend', () => {
    composing = false;
    scheduleWikiSearch();
  });
  el.input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      run();
    }
  });
  el.clear.addEventListener('click', () => {
    resetOutput();
    setInput('');
    focusInputEnd();
  });
  narrow.addEventListener('change', autoGrow);
  el.paste.addEventListener('click', async () => {
    try {
      const t = await navigator.clipboard.readText();
      if (!t) return toast('剪贴板是空的');
      setInput(t);
      if (state.mode !== 'wiki') run();
    } catch {
      toast('读不到剪贴板，请长按输入框粘贴');
    }
  });
  el.copy.addEventListener('click', copyResult);
  el.retry.addEventListener('click', retry);
  el.replace.addEventListener('click', replaceOriginal);
  el.diff.addEventListener('click', () => {
    const on = el.diff.getAttribute('aria-pressed') !== 'true';
    el.diff.setAttribute('aria-pressed', String(on));
    saveSettings({ showDiff: on });
    renderResult();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') {
      if (cancel(false)) return ev.preventDefault();
      if (isEmbedded()) sendToShell({ action: 'close' });
      else if (location.hash) location.hash = '';
      return;
    }
    if (!ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
    const i = ['Digit1', 'Digit2', 'Digit3', 'Digit4'].indexOf(ev.code);
    if (i >= 0) {
      ev.preventDefault();
      if (location.hash) location.hash = '';
      setMode(MODE_KEYS[i]);
      el.input.focus();
    } else if (ev.code === 'KeyC') {
      ev.preventDefault();
      copyResult();
    } else if (ev.code === 'KeyR') {
      ev.preventDefault();
      retry();
    } else if (ev.code === 'KeyV' && isEmbedded()) {
      ev.preventDefault();
      replaceOriginal();
    } else if (ev.code === 'KeyW' && isEmbedded()) {
      ev.preventDefault();
      sendToShell({ action: 'close' }); // Alt+W：收起弹窗（在弹窗的设置 / 历史页里也能用）
    }
  });

  // 历史页
  let searchTimer;
  $('h-mode').addEventListener('change', () => renderHistory(true));
  $('h-starred').addEventListener('change', () => renderHistory(true));
  $('h-search').addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => renderHistory(true), 200);
  });
  $('h-more').addEventListener('click', () => renderHistory(false));
  $('h-export').addEventListener('click', async () => {
    const entries = await store.all();
    const json = JSON.stringify({ app: 'lang-helper', version: 1, exportedAt: new Date().toISOString(), entries }, null, 1);
    const name = `lang-helper-history-${ymd()}.json`;
    // 安卓 App 里：交给壳弹出系统的「另存为」（保存好了壳会提示）
    if (shellSaveFile(name, json)) return;
    const blob = new Blob([json], { type: 'application/json' });
    const a = make('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    toast(`已导出 ${entries.length} 条`);
  });
  $('h-import').addEventListener('change', async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const list = (Array.isArray(data) ? data : data.entries) || [];
      const ok = list.filter(store.isEntry);
      await store.bulkPut(ok);
      toast(`已导入 ${ok.length} 条`);
      renderHistory(true);
    } catch (e) {
      toast('导入失败：' + e.message);
    }
    ev.target.value = '';
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  if (local && !localStorage.getItem('lh.sw')) return; // 本地开发默认不缓存，免得改了代码看不到
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker 注册失败', e));
}

function init() {
  if (isEmbedded()) document.body.classList.add('embed');
  if (shellKind() === 'ahk') {
    // PC 弹窗里只用这个页面的「设置」「历史」；返回链接回到弹窗页
    state.canReplace = true;
    setShellPage('-settings');
    for (const a of $$('.back')) a.href = 'popup.html';
    // AHK 要往弹窗里粘贴文字前，会先按 Ctrl+Alt+Shift+F12 让页面回到弹窗页
    document.addEventListener('keydown', (ev) => {
      if (ev.ctrlKey && ev.altKey && ev.shiftKey && ev.code === 'F12') {
        ev.preventDefault();
        location.replace('popup.html');
      }
    });
  }
  if (shellKind() === 'android') {
    // 安卓 App 里只用这个页面的「设置」「历史」；返回链接回到手机弹窗。
    // 返回键：壳会调用 window.lhBack()
    for (const a of $$('.back')) a.href = 'sheet.html';
    window.lhBack = () => {
      location.replace('sheet.html');
      return 'handled';
    };
  }
  const s = getSettings();
  applyTheme(s.theme);
  el.diff.setAttribute('aria-pressed', String(s.showDiff));
  wikiView = createWikiView({
    root: el.wiki,
    setStatus: (t) => {
      state.wikiStatus = t;
      if (state.mode === 'wiki') setStatus(t);
    },
    onCopy: copyWikiTerm,
  });
  setRegister(s.register);
  setMode(s.mode);
  bindMain();
  bindSettings();
  bindTapToFocus();
  setupDock();
  window.addEventListener('hashchange', route);
  route();

  // PWA「分享」进来的文字（share_target 用 GET 参数）。读完立刻从地址栏抹掉。
  const sp = new URLSearchParams(location.search);
  const shared = sp.get('text') || sp.get('title') || sp.get('url') || '';
  if (location.search) window.history.replaceState(null, '', location.pathname + location.hash);
  if (shared) openWith({ text: shared });

  initBridge(openWith);
  registerServiceWorker();
}

init();
