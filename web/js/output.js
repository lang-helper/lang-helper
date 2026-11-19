// 把模型输出拆成「结果」和「要点」两部分。流式过程中会反复调用。

import { DELIM } from './prompts.js';

/**
 * @param {string} full   目前收到的全部文字
 * @param {boolean} final 是否已经收完（收完时才做最终清理）
 * @returns {{result: string, notes: string[], inNotes: boolean}}
 */
export function splitOutput(full, final = false) {
  let result = full;
  let notes = '';
  const i = full.indexOf(DELIM);
  if (i >= 0) {
    result = full.slice(0, i);
    notes = full.slice(i + DELIM.length);
  } else if (!final) {
    // 末尾可能是分隔符的前半截（例如 "@@NO"），先不显示，免得闪一下。
    for (let k = Math.min(DELIM.length - 1, full.length); k > 0; k--) {
      if (DELIM.startsWith(full.slice(-k))) {
        result = full.slice(0, -k);
        break;
      }
    }
  }

  result = result.replace(/^\n+/, '').replace(/\s+$/, '');
  if (final) result = stripFences(result);

  const noteLines = notes
    .split('\n')
    .map((l) => l.trim().replace(/^(?:[-*•・]|\d+[.、)])\s*/, ''))
    .filter(Boolean);

  return { result, notes: noteLines, inNotes: i >= 0 };
}

function stripFences(s) {
  const m = s.match(/^```[\w-]*\n([\s\S]*?)\n```$/);
  return m ? m[1] : s;
}
