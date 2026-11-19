// Yandex 翻译。用的是 Yandex 安卓客户端的接口（pot 也这么用）：不需要 key，浏览器可以直接调用。
// 注意：这是非官方接口，严格说不符合 Yandex 的使用条款，随时可能失效；文字会发送给 Yandex。

const ENDPOINT = 'https://translate.yandex.net/api/v1/tr.json/translate';

/**
 * @param {string} text
 * @param {'zh'|'ja'|'en'} from
 * @param {'zh'|'ja'|'en'} to
 */
export async function yandexTranslate(text, from, to, { signal, timeoutMs = 10_000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const onAbort = () => ctrl.abort();
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const id = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now()).replaceAll('-', '') + '-0-0';
    const res = await fetch(`${ENDPOINT}?id=${id}&srv=android`, {
      method: 'POST',
      body: new URLSearchParams({ source_lang: from, target_lang: to, text }),
      signal: ctrl.signal,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
    });
    if (!res.ok) throw new Error(`Yandex 出错（HTTP ${res.status}）`);
    const j = await res.json();
    if (!Array.isArray(j.text)) throw new Error(j.message || 'Yandex 没有返回结果');
    return j.text.join('\n');
  } catch (e) {
    if (e.name === 'AbortError') throw new Error(signal?.aborted ? '已取消' : 'Yandex 超时');
    if (e instanceof TypeError) throw new Error('连不上 Yandex');
    throw e;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
