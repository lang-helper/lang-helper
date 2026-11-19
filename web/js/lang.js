// PC 弹窗和手机弹窗共用的语言规则。
//
// 目标语言：候选顺序 日语 > 中文 > 英语。目标 = 排在最前面、且不是原文语言的那个；alt（备选）= 剩下那个。
//   中文 → 日语（备选英语）  日语 → 中文（备选英语）  英语 → 日语（备选中文）
// 润色：原文是什么语言就润色成什么语言；中文 / 中日混写「写成」日语（备选英语）。

import { detectLang } from './detect.js';

export const LANG = { zh: '中文', ja: '日语', en: '英语' };
export const CANDIDATES = ['ja', 'zh', 'en'];

// 简体中文里不会出现的常用字（日文新字体、或和繁体相同的日文写法）。只有汉字的文本里出现这些，就当作日语。
const JP_ONLY = new RegExp(
  '[' +
    '気済駅鉄図円対発変様単読売続総関険経験検権歩毎込畑働峠枠辻覚拡帰戻渋楽薬広仏払戦残浜県恵桜沢滝稲黒' +
    '飯語話時間長東車電書買見聞開門問題際説認識記計設調議論誤請誰貸費資質価個側備優動場報実園圧業機横歴殺決満漢無為' +
    '銀録員頭顔額願類風飛飲館馬鳥鳴齢乗両亜仮伝係倉偽傷労効勢務勝勧協厳収営団増壊夢奨嬢寝専導層帯庁応悪悩愛態慣懐' +
    '択拠挙捜揺損晩暦栄歓歳殻汚浄涙災煙熱獲環産畳穏積竜粋糸紀約紅納純紙級紛細終組結絵給統絶継続維網緑緒線締練縁縄縦縮績織' +
    '罰義聴脳腸臓臨艦荘華蔵衆術衛補製複規視親観訪許訳証評詞試詩誌誕誘誠課談諸講謝護豊責貯貴賀賃賛購跡転軽較載輝輩輪' +
    '農辺連週進遅運過達違遠適選遺還郵郷鉱鋭鎖鎮閉閑閣闘陥陳陸陽隊階隠隣雑難霊頂項順預領頼飼飾養騒驚髪魚鮮鶏黙' +
    ']',
);

/**
 * 原文语言。只有汉字时按字形猜（override 可以手动指定 'zh' | 'ja'）；判断不了时用 fallback。
 * @returns {'zh'|'ja'|'en'}
 */
export function sourceLang(text, { override = null, fallback = 'zh' } = {}) {
  const l = detectLang(text);
  if (l === 'ja' || l === 'en') return l;
  if (l === 'han') return override || (JP_ONLY.test(text) ? 'ja' : 'zh');
  return fallback;
}

/** 只有汉字（中日都可能）时为 true：界面上允许手动切换「中文 / 日语」 */
export function isAmbiguousHan(text) {
  return detectLang(text) === 'han';
}

/** 两个候选目标语言：[首选, 备选] */
export function targetsFor(src, mode) {
  if (mode === 'polish') return src === 'zh' ? ['ja', 'en'] : [src];
  return CANDIDATES.filter((l) => l !== src);
}

export function targetFor(src, mode, alt) {
  const t = targetsFor(src, mode);
  return t[alt && t.length > 1 ? 1 : 0];
}

// 像不像一个词（决定是否只出 Yandex）：短，且没有标点、助词、动词词尾、代词、虚词。
// 日文：汉字 / 片假名后面紧跟助词（「今日は」「会議に」），或出现动词 / 形容词词尾。「の」不算（「明日の会議」也是名词）。
// 只看汉字 / 片假名后面的助词，免得「かばん」「めがね」这种平假名单词被误判。
const JA_GRAMMAR = /[\p{Script=Han}\p{Script=Katakana}ー][はがをにでもへや]|ます|まし|です|でし|した|ない|たい|ませ|だった|ている|てる/u;
const ZH_GRAMMAR = /[我你您他她它们这那了吗呢吧啊呀是在把被给让很都也就还要会能想去来说过着]/;
export function looksLikeTerm(text, src) {
  const t = text.trim();
  if (!t || /[\n。．！？!?、，,；;：:]/.test(t)) return false;
  if (src === 'en') return /^[A-Za-z][A-Za-z0-9'’\- ]*$/.test(t) && t.split(/\s+/).length <= 4;
  if (/[A-Za-z]/.test(t) || /\s/.test(t) || [...t].length > 12) return false;
  if (src === 'ja') return !JA_GRAMMAR.test(t);
  return !ZH_GRAMMAR.test(t);
}

/** 润色成日语时的文体：给界面看的简短名称（给模型的参数是 prompts.js 里的 REGISTERS） */
export const REG_SHORT = { auto: '自动', desu: '礼貌', tame: '随意', formal: '敬语' };
