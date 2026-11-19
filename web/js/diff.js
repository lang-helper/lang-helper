// 润色前后对比：日语/中文按字，英语按词。用 LCS 求差异，再把零碎的小相同段并进改动里，读起来更清楚。

const CJK = /[぀-ヿ㐀-鿿豈-﫿]/;

function tokenize(s, cjk) {
  if (cjk) return Array.from(s);
  return s.match(/\s+|[A-Za-z0-9'’]+|[^\sA-Za-z0-9'’]/g) || [];
}

/** @returns {{ops: {t:'eq'|'del'|'ins', s:string}[], similarity: number} | null} */
export function diff(a, b) {
  const cjk = CJK.test(a) || CJK.test(b);
  const A = tokenize(a, cjk);
  const B = tokenize(b, cjk);
  const n = A.length;
  const m = B.length;
  if (n * m > 4_000_000) return null; // 太长就不算了

  const W = m + 1;
  const dp = new Uint16Array((n + 1) * W);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }

  const raw = [];
  const push = (t, s) => {
    const last = raw[raw.length - 1];
    if (last && last.t === t) last.s += s;
    else raw.push({ t, s });
  };
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      push('eq', A[i]);
      i++;
      j++;
    } else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) {
      push('del', A[i++]);
    } else {
      push('ins', B[j++]);
    }
  }
  while (i < n) push('del', A[i++]);
  while (j < m) push('ins', B[j++]);

  return { ops: cleanup(raw, cjk), similarity: (2 * dp[0]) / (n + m || 1) };
}

// 夹在两处改动之间的极短相同段（1 个字 / 一个空格）并进改动，然后把连续改动合成「删一段 + 加一段」。
function cleanup(ops, cjk) {
  const tiny = (s) => (cjk ? [...s].length <= 1 : /^\s*$/.test(s));
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    const prev = ops[k - 1];
    const next = ops[k + 1];
    if (op.t === 'eq' && prev && next && prev.t !== 'eq' && next.t !== 'eq' && tiny(op.s)) {
      out.push({ t: 'del', s: op.s }, { t: 'ins', s: op.s });
    } else {
      out.push({ ...op });
    }
  }
  const merged = [];
  let del = '';
  let ins = '';
  const flush = () => {
    if (del) merged.push({ t: 'del', s: del });
    if (ins) merged.push({ t: 'ins', s: ins });
    del = ins = '';
  };
  for (const op of out) {
    if (op.t === 'del') del += op.s;
    else if (op.t === 'ins') ins += op.s;
    else {
      flush();
      merged.push(op);
    }
  }
  flush();
  return merged;
}

/** 渲染到容器里（只用 textContent，不拼 HTML） */
export function renderDiff(container, ops) {
  container.replaceChildren();
  for (const op of ops) {
    if (op.t === 'eq') container.append(document.createTextNode(op.s));
    else {
      const el = document.createElement(op.t);
      el.textContent = op.s;
      container.append(el);
    }
  }
}
