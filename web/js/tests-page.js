// 提示词测试页：批量跑 tests/cases.json，和上一次运行并排对比。

import { MODES, REGISTERS, PROMPT_VERSION, buildMessages } from './prompts.js';
import { streamChat } from './llm.js';
import { splitOutput } from './output.js';
import { detectLang, detectKind } from './detect.js';
import { getSettings } from './settings.js';

const $ = (id) => document.getElementById(id);
const LAST = 'lh.tests.last';
const PREV = 'lh.tests.prev';
const CONCURRENCY = 2;

const cases = await (await fetch('tests/cases.json', { cache: 'no-store' })).json();
$('pver').textContent = PROMPT_VERSION;
for (const m of Object.keys(MODES)) {
  const c = document.querySelector(`[data-count="${m}"]`);
  if (c) c.textContent = `(${cases[m]?.length || 0})`;
}

// notes:false 的用例 = PC 弹窗 / 手机「翻译」时的调用方式（只要译文、不要要点），另记一个 key
const keyOf = (mode, c) => `${mode}|${c.register || ''}|${c.input}` + (c.notes === false ? '|nonotes' : '');
const load = (k) => {
  try {
    return JSON.parse(localStorage.getItem(k) || 'null');
  } catch {
    return null;
  }
};

function make(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function paramsFor(mode, c) {
  const p = { text: c.input };
  if (mode === 'ja') p.register = c.register || 'auto';
  if (mode === 'zh') {
    const lang = detectLang(c.input);
    p.kind = detectKind(c.input, lang === 'en' ? 'en' : 'ja');
  }
  if (c.notes === false) p.notes = false;
  return p;
}

function describeParams(mode, p) {
  const parts = [];
  if (mode === 'ja') parts.push(`文体：${REGISTERS[p.register]}`);
  if (mode === 'zh') parts.push(`类型：${p.kind}`);
  if (p.notes === false) parts.push('翻译模式：不要要点');
  return parts.join(' · ');
}

function render(current, prev) {
  const root = $('results');
  root.replaceChildren();
  for (const mode of Object.keys(MODES)) {
    const list = cases[mode] || [];
    if (!list.length) continue;
    root.append(make('h2', null, MODES[mode].label));
    const table = make('table', 't-table');
    const head = make('tr');
    for (const h of ['#', '原文', '关注点', '本次结果', '本次要点', '上次结果']) head.append(make('th', null, h));
    table.append(head);
    list.forEach((c, i) => {
      const k = keyOf(mode, c);
      const cur = current?.results?.[k];
      const old = prev?.results?.[k];
      const p = paramsFor(mode, c);
      const tr = make('tr');
      tr.append(make('td', 'num', String(i + 1)));
      const tdIn = make('td', null, c.input);
      tdIn.lang = mode === 'en' ? 'en' : 'ja';
      const pdesc = describeParams(mode, p);
      if (pdesc) tdIn.append(make('div', 'hint', pdesc));
      tr.append(tdIn, make('td', 'hint', c.focus || ''));

      const tdOut = make('td', null, cur ? cur.error || cur.output : '');
      tdOut.lang = MODES[mode].outLang;
      if (cur && old && !cur.error && cur.output !== old.output) tdOut.classList.add('changed');
      if (cur && c.expectUnchanged && cur.output.trim() !== c.input.trim()) tdOut.classList.add('flag');
      // 翻译模式要求不给要点：给了就标红
      if (cur && !cur.error && c.notes === false && (cur.notes?.length || /@@NOTES@@/.test(cur.output))) {
        tdOut.classList.add('flag');
        tdOut.append(make('div', 'hint', '✗ 翻译模式不该有要点'));
      }
      if (cur?.ms) tdOut.append(make('div', 'hint', `${(cur.ms / 1000).toFixed(1)}s`));
      tr.append(tdOut, make('td', 't-notes', cur?.notes?.join('\n') || ''));
      const tdOld = make('td', 't-notes', old ? old.error || old.output : '');
      tdOld.lang = MODES[mode].outLang;
      tr.append(tdOld);
      table.append(tr);
    });
    root.append(table);
  }
}

async function runAll() {
  const modes = [...document.querySelectorAll('input[data-mode]:checked')].map((x) => x.dataset.mode);
  const jobs = modes.flatMap((mode) => (cases[mode] || []).map((c) => ({ mode, c })));
  if (!jobs.length) return;
  if (!confirm(`将调用 ${jobs.length} 次 API（粗略估计每次不到 0.1 美分）。继续？`)) return;

  const last = load(LAST);
  if (last) localStorage.setItem(PREV, JSON.stringify(last));
  const prev = last;
  const current = { ts: Date.now(), promptVersion: PROMPT_VERSION, results: { ...(last?.results || {}) } };
  // 本次要跑的先清掉，避免和旧结果混在一起
  for (const { mode, c } of jobs) delete current.results[keyOf(mode, c)];

  const btn = $('run');
  btn.disabled = true;
  let done = 0;
  const progress = () => ($('progress').textContent = `${done} / ${jobs.length}`);
  progress();
  render(current, prev);

  let next = 0;
  async function worker() {
    while (next < jobs.length) {
      const { mode, c } = jobs[next++];
      const m = MODES[mode];
      const t0 = performance.now();
      try {
        const r = await streamChat({
          messages: buildMessages(mode, paramsFor(mode, c)),
          temperature: m.temperature,
          maxTokens: m.maxTokens,
        });
        const parts = splitOutput(r.text, true);
        current.results[keyOf(mode, c)] = { output: parts.result, notes: parts.notes, ms: performance.now() - t0 };
      } catch (e) {
        current.results[keyOf(mode, c)] = { output: '', notes: [], error: `✗ ${e.message}` };
      }
      done++;
      progress();
      render(current, prev);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  localStorage.setItem(LAST, JSON.stringify(current));
  btn.disabled = false;
}

$('run').addEventListener('click', runAll);

// 导出本次和上次的结果（不含 API key），方便拿去和别人/Claude 一起看
$('export').addEventListener('click', () => {
  const last = load(LAST);
  if (!last) return alert('还没有运行结果');
  const pad = (n) => String(n).padStart(2, '0');
  const d = new Date();
  const name = `lang-helper-tests-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.json`;
  const data = { exportedAt: d.toISOString(), model: getSettings().model, promptVersion: PROMPT_VERSION, cases, last, prev: load(PREV) };
  const a = make('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
});
render(load(LAST), load(PREV));
