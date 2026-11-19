// 设置只存在本机 localStorage。API key 永远不会离开这台设备（除了发给你填的 Base URL）。

const KEY = 'lh.settings';

function guessDevice() {
  if (sessionStorage.getItem('lh.shell') === 'ahk' || /[?&]shell=ahk/.test(location.search)) return 'pc-popup';
  if (window.chrome && window.chrome.webview) return 'pc-popup';
  if (window.AndroidBridge) return 'android-app';
  return /Android/i.test(navigator.userAgent) ? 'phone' : 'pc';
}

const DEFAULTS = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  disableThinking: true,
  firstTokenTimeout: 8,
  device: guessDevice(),
  mode: 'ja',
  register: 'auto',
  showDiff: true,
  theme: 'dark',
  // PC 弹窗
  yandex: true, // 翻译时同时显示 Yandex 的结果
  popupMode: 'translate', // 'translate' | 'polish'，Tab 切换，Alt+Q 打开时沿用
  popupAlt: false, // true = 用备选目标语言，Alt+S 切换
  popupCollapsed: {}, // 各结果卡片是否折叠 { yandex: true, ... }
  popupPinned: false,
};

export function getSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  localStorage.setItem(KEY, JSON.stringify(next));
  return next;
}

export function clearSettings() {
  for (const k of Object.keys(localStorage)) if (k.startsWith('lh.')) localStorage.removeItem(k);
}
