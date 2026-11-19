// Google 翻译。用的是 Google 翻译网页小工具的接口（client=gtx，pot 也这么用）：不需要 key，浏览器可以直接调用。
// 注意：这是非官方接口，严格说不符合 Google 的使用条款，随时可能失效；文字会发送给 Google。
// 文字放在 POST 的正文里（不放进网址），换行会原样保留。

const ENDPOINT = 'https://translate.googleapis.com/translate_a/single';
const CODE = { zh: 'zh-CN', ja: 'ja', en: 'en' };

/**
 * @param {string} text
 * @param {'zh'|'ja'|'en'} from
 * @param {'zh'|'ja'|'en'} to
 */
export async function googleTranslate(text, from, to, { signal, timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const qs = new URLSearchParams({ client: 'gtx', sl: CODE[from] || 'auto', tl: CODE[to] || to, dt: 't' });
    const res = await fetch(`${ENDPOINT}?${qs}`, {
      method: 'POST',
      body: new URLSearchParams({ q: text }),
      signal: ctrl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) throw new Error(`Google 出错（HTTP ${res.status}）`);
    const j = await res.json();
    // [[["译文片段", "原文片段", ...], ...], ...]
    if (!Array.isArray(j?.[0])) throw new Error('Google 没有返回结果');
    return j[0].map((seg) => (Array.isArray(seg) && typeof seg[0] === 'string' ? seg[0] : '')).join('');
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(signal?.aborted ? '已取消' : 'Google 超时');
    if (e instanceof TypeError) throw new Error('连不上 Google');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
