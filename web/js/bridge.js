// 和外壳通信的接口。浏览器里直接打开时这些都不生效。
//
// 支持三种壳：
//  - ahk：PC 弹窗（P2）。AutoHotkey 用 Edge 的「应用窗口」打开本页（网址带 ?shell=ahk）。
//         AHK 通过键盘把文字送进来（Alt+1..4 切模式、Ctrl+V 粘贴、Ctrl+Enter 执行）；
//         网页通过「窗口标题」把动作告诉 AHK，AHK 每 0.1 秒看一次。标题栏上只显示「lang-helper」，
//         后面接一串看不见的零宽字符：U+2063 开头，然后每个字符用 7 个 U+200B(0) / U+200C(1) 表示，
//         解出来是 `popup|动作|序号`（设置 / 历史页是 `popup-settings|…`）。
//         「替换原文」时网页先把结果写进剪贴板，AHK 再切回原窗口按 Ctrl+V。
//  - webview2：预留（若以后改用 WebView2.ahk）。chrome.webview.postMessage 双向通信。
//  - android：P4 的安卓壳（android/）。接口见 sheet.js 开头；index.html 在 App 里只当设置 / 历史页。
//
// 壳 → 网页：{ mode?: 'ja'|'zh'|'en'|'wiki', text: string, autorun?: boolean, canReplace?: boolean }
// 网页 → 壳：{ action: 'replace', text } | { action: 'close' } | { action: 'copied' }

const VISIBLE_TITLE = 'lang-helper';
const MODES = ['ja', 'zh', 'en', 'wiki'];
// 暗号的第一段：弹窗页是 popup；设置 / 历史页是 popup-settings（AHK 据此判断能不能往里粘贴）
let page = 'popup';

// 把 ASCII 字符串编码成看不见的零宽字符
const MARK = String.fromCharCode(0x2063); // 不可见分隔符：暗号从这里开始
const ZERO = String.fromCharCode(0x200b); // 零宽空格 = 0
const ONE = String.fromCharCode(0x200c); // 零宽非连接符 = 1
function invisible(s) {
  let out = MARK;
  for (const ch of s) {
    const code = ch.charCodeAt(0) & 0x7f;
    for (let i = 6; i >= 0; i--) out += (code >> i) & 1 ? ONE : ZERO;
  }
  return out;
}

function setShellTitle(payload) {
  document.title = VISIBLE_TITLE + invisible(payload);
}

export function setShellPage(suffix = '') {
  page = 'popup' + suffix;
  if (shellKind() === 'ahk') setShellTitle(page);
}

// ?shell=ahk 只在第一次打开时带着，存进 sessionStorage，之后刷新也记得
const urlShell = new URLSearchParams(location.search).get('shell');
if (urlShell === 'ahk') sessionStorage.setItem('lh.shell', 'ahk');

export function shellKind() {
  if (sessionStorage.getItem('lh.shell') === 'ahk') return 'ahk';
  if (window.chrome && window.chrome.webview) return 'webview2';
  if (window.AndroidBridge) return 'android';
  return '';
}

export function isEmbedded() {
  return !!shellKind();
}

function normalize(msg) {
  let m = msg;
  if (typeof m === 'string') {
    try {
      m = JSON.parse(m);
    } catch {
      m = { text: m };
    }
  }
  return {
    mode: MODES.includes(m?.mode) ? m.mode : null,
    text: String(m?.text ?? ''),
    autorun: m?.autorun !== false,
    canReplace: !!m?.canReplace,
  };
}

export function initBridge(open) {
  window.lh = Object.freeze({ open: (msg) => open(normalize(msg)) });
  const kind = shellKind();
  if (kind === 'ahk') setShellTitle(page);
  if (kind === 'webview2') {
    window.chrome.webview.addEventListener('message', (e) => open(normalize(e.data)));
  }
  // 安卓：选中的文字只给手机弹窗（sheet.js 自己读 getInitial）。
  // 主页面（index.html）在 App 里只当设置 / 历史页用，这里不能读——
  // 以前读了会当成「传进来新文字」把 #settings 清掉，设置页一闪就跳回弹窗。
}

async function writeClipboard(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      /* ignore */
    }
    ta.remove();
    return ok;
  }
}

/** 安卓壳里用系统剪贴板复制（WebView 里 navigator.clipboard 不一定能用）。成功返回 true */
export function shellCopy(text) {
  if (window.AndroidBridge && typeof window.AndroidBridge.copy === 'function') {
    try {
      window.AndroidBridge.copy(String(text));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** 安卓壳里读剪贴板（WebView 不给网页读剪贴板）。不在安卓壳里返回 null */
export function shellPaste() {
  if (window.AndroidBridge && typeof window.AndroidBridge.paste === 'function') {
    try {
      return String(window.AndroidBridge.paste() || '');
    } catch {
      return '';
    }
  }
  return null;
}

/**
 * 安卓壳里保存文件（WebView 不支持网页的「下载」）：壳打开系统的「另存为」，用户选位置。
 * 交给壳了返回 true；不在安卓壳里返回 false（照常用浏览器下载）。
 */
export function shellSaveFile(name, text) {
  if (window.AndroidBridge && typeof window.AndroidBridge.saveFile === 'function') {
    try {
      window.AndroidBridge.saveFile(String(name), String(text));
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** 安卓壳里弹出键盘（网页自己 focus() 不会弹） */
export function shellKeyboard() {
  if (window.AndroidBridge && typeof window.AndroidBridge.showKeyboard === 'function') {
    try {
      window.AndroidBridge.showKeyboard();
    } catch {
      /* ignore */
    }
  }
}

export async function sendToShell(msg) {
  const kind = shellKind();
  if (kind === 'ahk') {
    if (msg.action === 'replace' && !(await writeClipboard(msg.text))) return false;
    setShellTitle(`${page}|${msg.action}|${Date.now()}`);
    return true;
  }
  if (kind === 'webview2') {
    window.chrome.webview.postMessage(msg);
    return true;
  }
  if (kind === 'android' && typeof window.AndroidBridge.postMessage === 'function') {
    window.AndroidBridge.postMessage(JSON.stringify(msg));
    return true;
  }
  return false;
}
