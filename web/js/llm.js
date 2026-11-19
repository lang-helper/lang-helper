// OpenAI 兼容的流式 chat/completions 客户端（默认 DeepSeek）。

import { getSettings } from './settings.js';

export class LLMError extends Error {
  constructor(code, message, detail = '') {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

const STATUS_MSG = {
  400: '请求格式有误',
  401: 'API key 无效或已失效',
  402: '余额不足，请到 DeepSeek 充值',
  403: '没有权限',
  404: '接口地址或模型名不对',
  422: '参数有误（换了服务商的话，试试在设置里取消「关闭思考模式」）',
  429: '请求太频繁，稍等再试',
  500: '服务器出错，稍后重试',
  502: '服务器暂时不可用，稍后重试',
  503: '服务器繁忙，稍后重试',
};

function wrapFailure(err, reason) {
  if (reason === 'USER') return new LLMError('ABORTED', '已取消');
  if (reason === 'FIRST_TOKEN_TIMEOUT') return new LLMError('TIMEOUT', '等了太久没有响应，点「重试」');
  if (reason === 'TOTAL_TIMEOUT') return new LLMError('TIMEOUT', '响应超时，点「重试」');
  if (err instanceof LLMError) return err;
  return new LLMError('NETWORK', '网络错误：连不上接口（检查网络或设置里的 Base URL）', String(err));
}

/**
 * @param {object} o
 * @param {Array} o.messages
 * @param {number} [o.temperature]
 * @param {number} [o.maxTokens]
 * @param {AbortSignal} [o.signal]       外部取消
 * @param {number} [o.firstTokenTimeoutMs]
 * @param {(full: string) => void} [o.onText]  每收到一段内容就回调累计全文
 * @returns {Promise<{text: string, ttft: number, total: number}>}
 */
export async function streamChat({
  messages,
  temperature,
  maxTokens,
  signal,
  firstTokenTimeoutMs,
  totalTimeoutMs = 90_000,
  onText,
  settings,
  responseFormat,
}) {
  const s = settings || getSettings();
  if (!s.apiKey.trim()) throw new LLMError('NO_KEY', '还没有设置 API key');

  const url = s.baseUrl.trim().replace(/\/+$/, '') + '/chat/completions';
  const body = { model: s.model.trim(), messages, stream: true };
  if (temperature != null) body.temperature = temperature;
  if (maxTokens) body.max_tokens = maxTokens;
  if (responseFormat) body.response_format = responseFormat;
  if (s.disableThinking) body.thinking = { type: 'disabled' };

  const ctrl = new AbortController();
  let reason = null;
  const abort = (r) => {
    if (!reason) {
      reason = r;
      ctrl.abort();
    }
  };
  const onOuterAbort = () => abort('USER');
  if (signal) {
    if (signal.aborted) abort('USER');
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }

  const ftMs = firstTokenTimeoutMs ?? Math.max(3, Number(s.firstTokenTimeout) || 8) * 1000;
  const ftTimer = setTimeout(() => abort('FIRST_TOKEN_TIMEOUT'), ftMs);
  const totalTimer = setTimeout(() => abort('TOTAL_TIMEOUT'), totalTimeoutMs);
  const t0 = performance.now();
  let ttft = null;
  let full = '';

  try {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer ' + s.apiKey.trim(),
        },
        body: JSON.stringify(body),
        signal: ctrl.signal,
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch (e) {
      throw wrapFailure(e, reason);
    }

    if (!res.ok) {
      let detail = '';
      try {
        const j = await res.json();
        detail = j?.error?.message || JSON.stringify(j);
      } catch {
        /* ignore */
      }
      throw new LLMError('HTTP_' + res.status, STATUS_MSG[res.status] || `请求失败（HTTP ${res.status}）`, detail);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    read: while (true) {
      let chunk;
      try {
        chunk = await reader.read();
      } catch (e) {
        throw wrapFailure(e, reason);
      }
      if (chunk.done) break;
      buf += decoder.decode(chunk.value, { stream: true });

      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).replace(/\r$/, '');
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue; // 空行、": keep-alive" 注释
        const data = line.slice(5).trim();
        if (data === '[DONE]') break read;
        let j;
        try {
          j = JSON.parse(data);
        } catch {
          continue;
        }
        if (j.error) throw new LLMError('STREAM_ERROR', j.error.message || '服务器返回错误');
        const delta = j.choices?.[0]?.delta;
        if (!delta) continue;
        // 思考内容（reasoning_content）也算"已经有响应"，避免误判首字超时；但不显示。
        if (ttft === null && (delta.content || delta.reasoning_content)) {
          ttft = performance.now() - t0;
          clearTimeout(ftTimer);
        }
        if (delta.content) {
          full += delta.content;
          onText?.(full);
        }
      }
    }

    if (!full) throw new LLMError('EMPTY', '没有返回任何内容，点「重试」');
    return { text: full, ttft: ttft ?? 0, total: performance.now() - t0 };
  } finally {
    clearTimeout(ftTimer);
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', onOuterAbort);
  }
}
