// 名词查询的结果区：Wikipedia/Wikidata 候选列表 + AI 候选，点开看详情。

import { searchTerms, getJaSummary, guessTerms, wikiUrl } from './wiki.js';

const COPY_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';

function make(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function copyButton(title) {
  const b = make('button', 'icon-btn wk-copy');
  b.type = 'button';
  b.title = title;
  b.setAttribute('aria-label', title);
  // 固定的图标字符串，不含任何用户数据
  b.innerHTML = COPY_SVG;
  return b;
}

function link(href, text) {
  const a = make('a', null, text);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

/**
 * @param {object} o
 * @param {HTMLElement} o.root
 * @param {(t: string) => void} o.setStatus
 * @param {(c: object, query: string, source: 'wiki'|'ai') => void} o.onCopy  复制某个候选的日文名
 */
export function createWikiView({ root, setStatus, onCopy }) {
  root.replaceChildren();
  const aiSec = make('section', 'wk-sec');
  aiSec.hidden = true;
  const aiTitle = make('div', 'wk-sec-title', 'AI 候选');
  const aiList = make('ul', 'wk-list');
  aiSec.append(aiTitle, aiList);

  const wikiSec = make('section', 'wk-sec');
  const wikiTitle = make('div', 'wk-sec-title', 'Wikipedia / Wikidata');
  const wikiList = make('ul', 'wk-list');
  wikiSec.append(wikiTitle, wikiList);

  const empty = make('p', 'wk-empty hint');
  root.append(aiSec, wikiSec, empty);

  let query = '';
  let searchCtrl = null;
  let seq = 0;
  let current = null; // 当前展开的候选 { c, source }
  let wikiCands = [];
  let aiCands = [];

  function setEmpty(text) {
    empty.textContent = text;
    empty.hidden = !text;
  }

  function idleHint() {
    setEmpty('输入名词（中文、英文、日文都行）会边打边查。说不出词时，写一段描述后按 Ctrl+Enter 让 AI 猜。');
  }
  idleHint();
  wikiSec.hidden = true;

  // ───── 单个候选 ─────
  function item(c, source, q) {
    const li = make('li', 'wk-item');
    const row = make('div', 'wk-row');
    const main = make('div', 'wk-main');
    const ja = make('span', 'wk-ja', c.ja || '（没有日文条目）');
    ja.lang = 'ja';
    if (!c.ja) ja.classList.add('missing');
    main.append(ja);
    if (c.reading) {
      const r = make('span', 'wk-reading', c.reading);
      r.lang = 'ja';
      main.append(r);
    }
    if (source === 'ai') {
      main.append(
        c.verified
          ? make('span', 'wk-badge ok', '✓ 有条目')
          : c.verifyFailed
            ? make('span', 'wk-badge', '未能验证')
            : make('span', 'wk-badge warn', '没找到条目'),
      );
    }
    row.append(main);
    if (c.ja) {
      const b = copyButton('复制日文');
      b.addEventListener('click', () => onCopy(c, q, source));
      row.append(b);
    }
    li.append(row);

    const info = c.verified || c;
    const sub = [info.zh || c.zh, info.en || c.en].filter(Boolean).join(' · ');
    if (sub) li.append(make('div', 'wk-sub', sub));
    const desc = source === 'ai' ? c.note : c.desc;
    if (desc) li.append(make('div', 'wk-desc', desc));

    const detail = make('div', 'wk-detail');
    detail.hidden = true;
    li.append(detail);

    li.addEventListener('click', (ev) => {
      if (ev.target.closest('button, a')) return;
      if (String(window.getSelection())) return;
      const open = !li.classList.contains('open');
      for (const x of root.querySelectorAll('.wk-item.open')) {
        x.classList.remove('open');
        x.querySelector('.wk-detail').hidden = true;
      }
      if (open) {
        li.classList.add('open');
        detail.hidden = false;
        current = { c, source };
        if (!detail.dataset.loaded) fillDetail(detail, c, source);
      } else current = null;
    });
    return li;
  }

  function fillDetail(detail, c, source) {
    detail.dataset.loaded = '1';
    const info = source === 'ai' ? c.verified : c;
    if (source === 'ai' && c.verified?.ja && c.verified.ja !== c.ja) {
      detail.append(kv('条目名', c.verified.ja, 'ja'));
    }
    if (!info) {
      detail.append(
        make(
          'div',
          'hint',
          c.verifyFailed
            ? '刚才去 Wikipedia 验证时失败了（可能被限流），按 Alt+R 重试，或用下面的链接自己搜。'
            : '日文维基里没有这个标题的条目：可能是 AI 编的，也可能只是叫法不常见。',
        ),
      );
      const links = make('div', 'wk-links');
      links.append(
        link(`https://ja.wikipedia.org/w/index.php?search=${encodeURIComponent(c.ja)}`, '在日文维基里搜'),
        link(`https://www.google.com/search?q=${encodeURIComponent(c.ja)}`, 'Google 搜'),
      );
      detail.append(links);
      return;
    }
    if (info.jaAliases?.length) detail.append(kv('日文别名', info.jaAliases.join('、'), 'ja'));
    if (info.descJa) detail.append(kv('日文简介', info.descJa, 'ja'));
    const ext = make('div', 'wk-extract hint');
    ext.lang = 'ja';
    if (info.links?.ja) {
      ext.textContent = '读取日文维基…';
      getJaSummary(info.links.ja)
        .then((s) => (ext.textContent = s?.extract ? s.extract.slice(0, 220) + (s.extract.length > 220 ? '…' : '') : ''))
        .catch(() => (ext.textContent = ''));
      detail.append(ext);
    }
    const links = make('div', 'wk-links');
    // wiki 速查：中 / 日 / 英条目并排看、秒切、不加载图片
    const q = info.links?.ja || info.links?.zh || info.links?.en;
    if (q) links.append(link(`wiki.html#q=${encodeURIComponent(q)}`, 'wiki 速查'));
    if (info.links?.ja) links.append(link(wikiUrl('ja', info.links.ja), '日文维基'));
    if (info.links?.zh) links.append(link(wikiUrl('zh', info.links.zh), '中文维基'));
    if (info.links?.en) links.append(link(wikiUrl('en', info.links.en), 'English'));
    links.append(link(`https://www.wikidata.org/wiki/${info.id}`, 'Wikidata'));
    detail.append(links);
  }

  function kv(k, v, lang) {
    const d = make('div', 'wk-kv');
    const vv = make('span', null, v);
    if (lang) vv.lang = lang;
    d.append(make('span', 'wk-k', k), vv);
    return d;
  }

  // ───── 对外 ─────
  async function search(q) {
    q = q.trim();
    query = q;
    searchCtrl?.abort();
    clearAi();
    current = null;
    if (!q) {
      wikiCands = [];
      wikiList.replaceChildren();
      wikiSec.hidden = true;
      idleHint();
      setStatus('');
      return;
    }
    const my = ++seq;
    const ctrl = new AbortController();
    searchCtrl = ctrl;
    setStatus('搜索中…');
    try {
      const list = await searchTerms(q, { signal: ctrl.signal });
      if (my !== seq) return;
      wikiCands = list;
      wikiList.replaceChildren(...list.map((c) => item(c, 'wiki', q)));
      wikiSec.hidden = list.length === 0;
      setEmpty(list.length ? '' : '没找到对应条目。可以换个说法，或按 Ctrl+Enter 让 AI 猜。');
      setStatus(list.length ? `${list.length} 条` : '');
    } catch (e) {
      if (my !== seq || e.name === 'AbortError') return;
      if (e.code === 'RATE') {
        // 被 Wikipedia 限流：等冷却结束后自动再查一次
        const sec = Math.ceil(e.waitMs / 1000);
        setEmpty(`Wikipedia 暂时限流了，${sec} 秒后自动重试…`);
        setStatus('限流中');
        clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          if (query === q && my === seq) search(q);
        }, e.waitMs + 300);
        return;
      }
      setEmpty('查询失败：' + (e.message || e));
      setStatus('出错了');
    }
  }
  let retryTimer;

  async function guess(q, signal) {
    q = q.trim();
    query = q;
    aiSec.hidden = false;
    aiList.replaceChildren(make('li', 'wk-loading hint', 'AI 正在猜，猜完会逐个去 Wikidata 验证…'));
    setEmpty('');
    aiCands = [];
    let res;
    try {
      res = await guessTerms(q, { signal });
    } catch (e) {
      const msg = e.code === 'ABORTED' ? '已取消' : e.message || String(e);
      aiList.replaceChildren(make('li', 'wk-error', msg));
      throw e;
    }
    const { candidates, ms, verifyFailed } = res;
    aiCands = candidates;
    aiList.replaceChildren(...candidates.map((c) => item(c, 'ai', q)));
    if (!candidates.length) aiList.append(make('li', 'hint', 'AI 没给出候选。'));
    const ok = candidates.filter((c) => c.verified).length;
    setStatus(
      verifyFailed
        ? `AI ${candidates.length} 个候选（验证失败，可能被限流）`
        : `AI ${candidates.length} 个候选，${ok} 个有条目 · ${(ms / 1000).toFixed(1)} 秒`,
    );
    return candidates;
  }

  function clearAi() {
    aiCands = [];
    aiSec.hidden = true;
    aiList.replaceChildren();
  }

  /** Alt+C：复制展开的那个；没有展开的，就复制排在最前面的一个 */
  function copyCurrent() {
    const target = current || firstShown();
    if (!target?.c.ja) return false;
    onCopy(target.c, query, target.source);
    return true;
  }
  function firstShown() {
    if (!aiSec.hidden && aiCands.length) return { c: aiCands[0], source: 'ai' };
    if (!wikiSec.hidden && wikiCands.length) return { c: wikiCands[0], source: 'wiki' };
    return null;
  }

  return {
    search,
    guess,
    clearAi,
    copyCurrent,
    currentTerm: () => (current || firstShown())?.c.ja || '',
    hasContent: () => !!query,
    get query() {
      return query;
    },
  };
}
