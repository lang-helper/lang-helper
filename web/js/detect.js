// 粗略判断输入语言，以及是"词"还是"句"。

const KANA = /[぀-ゟ゠-ヿㇰ-ㇿｦ-ﾟ]/;
const HAN = /[㐀-鿿豈-﫿]/g;
const LATIN = /[A-Za-z]/g;

/** @returns {'ja'|'en'|'han'|'other'|null}  han = 只有汉字（中文，或日语的汉字词） */
export function detectLang(text) {
  const t = text.trim();
  if (!t) return null;
  if (KANA.test(t)) return 'ja';
  const latin = (t.match(LATIN) || []).length;
  const han = (t.match(HAN) || []).length;
  if (latin > han) return 'en';
  if (han > 0) return 'han';
  return 'other';
}

/** @returns {'词'|'句'} */
export function detectKind(text, lang) {
  const t = text.trim();
  if (/\n/.test(t)) return '句';
  if (lang === 'en') {
    const words = t.split(/\s+/).filter(Boolean);
    return words.length <= 3 && !/[.!?;:,]$/.test(t) ? '词' : '句';
  }
  return [...t].length <= 12 && !/[。．！？!?、，,；;]/.test(t) ? '词' : '句';
}

/** 输入栏标题：识别出来的原文语言 + 要做的事 */
export function describeInput(mode, text) {
  const lang = detectLang(text);
  if (!lang || lang === 'other') return '自动检测';
  if (mode === 'ja') {
    if (lang === 'ja') return '日语（润色）';
    if (lang === 'han') return '中文（翻译）';
    return '英语（翻译）';
  }
  if (mode === 'en') {
    if (lang === 'en') return '英语（润色）';
    if (lang === 'han') return '中文（翻译）';
    return '日语（翻译）';
  }
  if (mode === 'wiki') return { ja: '日语', en: '英语', han: '中文 / 日文汉字' }[lang] || '自动检测';
  const kind = detectKind(text, lang);
  if (lang === 'en') return `英语 · ${kind}`;
  if (lang === 'ja') return `日语 · ${kind}`;
  return kind === '词' ? '日语汉字词 · 词' : '看起来是中文？写日语请按 Alt+1';
}
