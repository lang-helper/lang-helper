// 名词查询自测：依次（串行，避免被限流）跑几个查询，把结果写到页面上。
import { searchTerms, getJaSummary, guessTerms } from '../js/wiki.js';

const out = document.getElementById('out');
const lines = [];
const log = (s) => {
  lines.push(s);
  out.textContent = lines.join('\n');
};
const brief = (c) => `${c.ja || '（无日文）'} | ${c.zh} | ${c.en} | ${c.desc.slice(0, 20)}${c.jaAliases?.length ? ' | 别名:' + c.jaAliases.slice(0, 3).join('、') : ''}`;

// 每步之间停一下，别触发 Wikimedia 的限流（?gap=秒，默认 0）
const gap = Number(new URLSearchParams(location.search).get('gap') || 0) * 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  for (const q of ['电饭煲', 'convenience store', '根回し', '电饭锅']) {
    await sleep(gap);
    const t0 = performance.now();
    try {
      const list = await searchTerms(q);
      log(`SEARCH ${q} (${Math.round(performance.now() - t0)}ms, ${list.length})`);
      for (const c of list.slice(0, 3)) log('  ' + brief(c));
    } catch (e) {
      log(`SEARCH ${q} ERROR ${e.code || ''} ${e.message}`);
    }
  }
  await sleep(gap);
  try {
    const s = await getJaSummary('炊飯器');
    log('SUMMARY 炊飯器: ' + s.extract.slice(0, 50));
  } catch (e) {
    log('SUMMARY ERROR ' + e.message);
  }
  await sleep(gap);
  try {
    const t0 = performance.now();
    const { candidates } = await guessTerms('煮饭的那个电器');
    log(`GUESS (${Math.round(performance.now() - t0)}ms)`);
    for (const c of candidates)
      log(`  ${c.ja} (${c.reading}) → ${c.verified ? '✓ ' + c.verified.ja + ' ' + c.verified.id : c.verifyFailed ? '验证失败' : '没找到条目'}`);
  } catch (e) {
    log(`GUESS ERROR ${e.code || ''} ${e.message}`);
  }
  log('DONE');
})();
