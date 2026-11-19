# lang-helper

A personal Japanese / English writing and translation helper. The web app has four modes (the UI itself is in Chinese):

| Mode | Shortcut | What it does |
|---|---|---|
| **Write Japanese** (写日语) | Alt+1 | Polish Japanese, Chinese → Japanese, mixed Chinese/Japanese input (type Chinese for words you don't know) |
| **To Chinese** (转中文) | Alt+2 | Japanese / English → Chinese; single words get a dictionary card (reading, meanings, collocations, examples) |
| **Write English** (写英文) | Alt+3 | Polish English, Chinese → English, mixed Chinese/English input |
| **Term lookup** (查名词) | Alt+4 | Find the exact Japanese name of a thing: live Wikipedia / Wikidata search; when you can't name it, Ctrl+Enter lets the AI guess and each guess is verified against Wikipedia |

Model: DeepSeek `deepseek-flash` (thinking disabled, streaming).

## Layout

```
web/                    The web app (this directory is what gets deployed to GitHub Pages)
  index.html            Main UI
  tests.html            Prompt test page (results can be exported)
  tests/cases.json      Prompt test cases
  tests/wiki-selftest.html  Term lookup self-test (calls Wikipedia for real)
  js/prompts.js         ★ All prompts live here
  js/llm.js             DeepSeek streaming client
  js/wiki.js            Term lookup: Wikidata / Wikipedia APIs + AI guess + verification
  js/wiki-ui.js         Term lookup result list
  popup.html            PC popup page (modelled on pot: one result card per service)
  js/popup.js           PC popup logic
  js/yandex.js          Yandex Translate
  js/history.js         Local history (IndexedDB)
  sheet.html            Mobile bottom sheet (what the Android app shows)
  js/sheet.js           Mobile bottom sheet logic
  js/lang.js            Source-language detection, target candidates, "is this a single word" (shared by PC and mobile)
  js/bridge.js          Messaging with the PC popup / Android shell
  sw.js                 Offline cache (network-first)
ahk/lang-helper.ahk     PC popup (AutoHotkey v2)
ahk/lang-helper.example.ini  PC popup settings template
android/                Android app (transparent window + WebView; select text → "lang-helper")
  make-keystore.ps1     Creates the signing key (run once)
dev/server.py           Local dev server + mock DeepSeek API
.github/workflows/      Deploy to GitHub Pages, build the Android APK
```

## Run locally

```bash
python dev/server.py
```

Open http://localhost:8787 and enter your API key in Settings.

To test the UI without spending money: set Base URL to `http://localhost:8787/mock` in Settings and use any API key of 8+ characters. Put `#401`, `#402`, `#500` or `#slow` in the input to simulate errors and timeouts. The dev server also has `/__dev/mock?mode=ja&text=...`, which switches the current origin to the mock API and opens the app with that text (local only).

Mobile sheet: `/__dev/mock?delay=0&next=/sheet.html&readonly=0&text=...`. Add `&android=1` and every page you open afterwards gets a fake Android shell (`window.AndroidBridge`, calls are logged in `window.__android`) for testing replace, the back key, paste and the settings gear. Visit `/__dev/mock` again without `android=1` to turn it off.

The service worker is **off** on localhost by default so code changes show up immediately. To test caching, run `localStorage.setItem('lh.sw','1')` in the console and reload.

## PC popup (pot-style, no browser tab needed)

Select text in any window → press a hotkey → a small window (`web/popup.html`) opens **centered on the mouse pointer** (pulled back inside the screen if needed). The layout follows pot: the source card on top, whose footer row holds pin · copy · clear · settings · "● source language" (purple dot) … "● target language" (orange dot) · the big Translate / Polish button; result cards from each service below. When polishing Japanese the target chip reads "● 日语 · 自动" and clicking it cycles the register. Colors are pot's grey + cyan; the background is `#161616`, the same as the dark title bar of an Edge app window, so they blend (close with the title bar ×, Esc or Alt+W).

**Global hotkeys** (configurable in `ahk/lang-helper.ini`):

| Hotkey | Action |
|---|---|
| `Alt+D` | Put the selected text into the popup, switch to Translate |
| `Alt+A` | Put the selected text into the popup, switch to Polish |
| `Alt+Q` | Open an empty popup for typing, keeping the Translate / Polish choice last set with Shift+Tab; press again while the popup is in front to hide it |

By default it does **not run automatically**: edit the text first if you like, then press Enter (`AutoRun=1` in the ini makes it run immediately). With nothing selected, `Alt+D` / `Alt+A` are passed through to the current program (e.g. `Alt+D` still jumps to a browser's address bar). Note that `Alt+Q` takes over Office's "Search" shortcut; change it in the ini if that bothers you.

**Keys inside the popup:**

| Key | Action |
|---|---|
| `Enter` / `Shift+Enter` | Run / new line |
| `Ctrl+Enter` | Run, and always ask DeepSeek even for a single word |
| `Tab` | Switch target language (remembered) |
| `Shift+Tab` | Translate ⇄ Polish (remembered; `Alt+Q` reuses it) |
| `Alt+C` | Copy the result (DeepSeek's if present, otherwise Yandex's) |
| `Alt+V` | **Replace the original** with the result (switches back to the source window and pastes); every card also has a Replace button |
| `Alt+P` | Pin: stays open when you click elsewhere, and stays on top |
| `Alt+R` | Retry |
| `Esc` | Cancel / hide |
| `Alt+W` | Hide |

**Target language**: candidates in the order **Japanese > Chinese > English**. The target is the first candidate that isn't the source language; `Tab` switches to the remaining one. Only the current target is shown.

| Source | Default | After Tab |
|---|---|---|
| Chinese | Japanese | English |
| Japanese | Chinese | English |
| English | Japanese | Chinese |

Clicking the target chip is the same as `Tab`. Short all-kanji words (e.g. 会議 vs 会议) are classified as Japanese or Chinese by character forms; click the source chip to flip a wrong guess.

**Automatic routing when translating:**

- **Looks like a single word** (short, with no punctuation, particles, verb endings, pronouns or function words) → **Yandex** only; the DeepSeek card stays collapsed until you open it or press `Ctrl+Enter`. Examples: 炊飯器, 根回し, 打ち合わせ, 明日の会議, 电饭煲, 不好意思, follow up.
- **Sentence** → **Yandex + DeepSeek** together. Examples: 今日は暑い, 確認しました, 修好了, 麻烦你了, Let's go now.
- When translating, DeepSeek returns only the result, no notes.

**Polish**: DeepSeek only, with changes highlighted and notes. Text is polished in its own language; Chinese or mixed Chinese/Japanese is "written as Japanese" (Tab → as English). When polishing into Japanese, click the target chip to change the register (auto → です・ます → タメ口 → formal).

The DeepSeek card uses the same three prompts as the main page: into Japanese = "Write Japanese", into Chinese = "To Chinese" (single words get a dictionary card), into English = "Write English". Yandex uses an unofficial endpoint (same as pot; no key needed, but strictly speaking it isn't within Yandex's terms of use and could stop working at any time); it can be turned off in Settings. Baidu isn't supported yet (its API can't be called directly from a web page and would need a proxy). Term lookup is not in the popup (it may become a separate tool later).

The popup hides itself when another window gets focus; a size you set by dragging the edges is remembered. For troubleshooting set `Debug=1` in the ini and every step is logged to `ahk/debug.log`.

**Usage:**

1. Double-click `ahk/lang-helper.ahk` (requires AutoHotkey v2). An icon appears in the tray.
2. The first run creates `ahk/lang-helper.ini`. Before deploying to GitHub Pages the popup opens `http://localhost:8787/`, so keep `python dev/server.py` running; after deploying, set `Url` in the ini to the Pages URL.
3. The popup uses a **separate Edge profile** (independent from your normal Edge), so enter the API key once more in the popup's Settings.
4. To start with Windows: tray menu → "Start with Windows" (开机自动启动).

**How it works:** the popup is an Edge "app window" (`--app`: no address bar or tabs). AutoHotkey handles the hotkeys, pastes the selection into the popup and pastes results back into the source window. After pasting, AutoHotkey presses `Ctrl+Alt+Shift+F9` (switch to Translate) / `F10` (switch to Polish) / `F11` (fresh input) / `F12` (return from Settings to the popup) to notify the page. The page tells AutoHotkey to replace / hide / pin by changing the window title: the title bar only shows "lang-helper", followed by an invisible string of zero-width characters that decodes to `popup|action|seq` (the script also accepts the older `lang-helper-popup|…` form). No third-party libraries or DLLs are needed. `popup.html?text=...&pmode=polish&run=1` opens the popup with text directly (`run=1` runs it immediately).

**Limitations:** windows running as administrator can't receive the replacement; a few programs block simulated Ctrl+C / Ctrl+V.

Self-test (for development; briefly opens windows and simulates keystrokes): `AutoHotkeyV2.exe ahk\lang-helper.ahk /selftest <ini> <log>`.

## Term lookup notes

- Wikimedia APIs are rate-limited: 200 requests/minute for normal browsers, which everyday type-as-you-search never reaches. Each lookup usually sends 2 requests, one after the other; if rate-limited it waits a few seconds and retries.
- The Claude desktop app's built-in browser and headless browsers are treated as bots by Wikimedia and get a much stricter limit (about 10/minute), so "rate limited" there is expected.
- AI guesses are labelled: "✓ has an article" (a real Japanese Wikipedia article exists, redirects included, e.g. コンビニ → コンビニエンスストア), "no article found" (possibly made up), "couldn't verify" (network error or rate limit during verification).
- Copying a Japanese name records it in history (term lookup mode) for later review.

## Where the API key is stored

- Only in each device's own browser storage. **Never in the repo, never in GitHub Secrets.**
- Requests go straight from the device to DeepSeek; GitHub never sees the key.
- Turn on two-factor authentication for your GitHub account (so nobody else can change the web code).

## Changing prompts

1. Edit `web/js/prompts.js` and bump `PROMPT_VERSION`.
2. Open `tests.html` and click Run: all cases in `tests/cases.json` (about 30, a few cents with a real key) are run and shown side by side with the previous run. "Export" saves the results as JSON.
3. To add your own sentences, edit `web/tests/cases.json`.

## Deploy to GitHub Pages

1. Create a **public** GitHub repository `lang-helper` (free Pages requires public; there are no secrets in the code).
2. Push this directory (`main` branch).
3. Repository **Settings → Pages → Build and deployment → Source**: choose **GitHub Actions**.
4. When the Actions run finishes, the site is at `https://<your-username>.github.io/lang-helper/`.

## Android app (select text → "lang-helper")

Select text in any app and tap **lang-helper** in the selection menu (on some phones it's under "⋮ / More"). A card slides up from the bottom (at most 3/4 of the screen):

1. **First screen**: the source text (editable), the target language (both candidates shown; tap to choose), and two big buttons: Translate (翻译) and Polish (润色).
2. **Result screen**: the source on top, result cards below. When translating, swipe the cards left/right: Yandex first (fast), then DeepSeek; for a single word DeepSeek only runs once you swipe to it (saves money). Polish shows one DeepSeek card with changes highlighted and notes.
3. Each result card: **Copy** (the card stays open) and **Replace** (only shown when the text came from an editable field: puts the result in place of the original and closes).
4. Back key: result screen → first screen → close. Tapping the dimmed area above or dragging the card down also closes it.
5. The launcher icon opens the same card with an empty input, ready to type.

The app itself is just a transparent window that opens `https://stoney239.github.io/lang-helper/sheet.html`. **Web changes don't need a reinstall**: after a push, the next time you open it you get the new version. A new APK is only needed when something under `android/` changes.

### One-time setup: signing key

Every APK must be signed with the same key so new versions install over the old one. With a different key you'd have to uninstall first, and the API key and history stored in the app would be lost.

1. Create the key (output goes to `android/keystore/`, which is git-ignored):
   ```bash
   powershell -ExecutionPolicy Bypass -File android/make-keystore.ps1
   ```
2. **Back up the whole `android/keystore/` folder** somewhere else (cloud drive, USB stick).
3. GitHub repository → **Settings → Secrets and variables → Actions → New repository secret**, add two secrets:
   - `ANDROID_KEYSTORE_BASE64`: the entire contents of `android/keystore/secret-base64.txt`
   - `ANDROID_KEYSTORE_PASSWORD`: the contents of `android/keystore/password.txt`

### Build and install

1. GitHub Actions builds the APK after a push (only when `android/` changes; you can also run "Build Android APK" manually from the Actions page → Run workflow).
2. On the phone, open https://github.com/stoney239/lang-helper/releases/latest/download/lang-helper.apk and install it (allow "Install unknown apps" the first time).
3. Open the app → gear icon (top right) → enter the API key once (the app's storage is separate from the phone's browser).
4. Xiaomi / HyperOS: if "lang-helper" doesn't appear in the selection menu, check Settings → Apps → lang-helper for restrictions; on some systems it's under "More" in the menu.

## Mobile browser version (without the app)

1. Open the Pages URL in Chrome on the phone → menu → "Add to Home screen" / "Install app".
2. Enter the API key once in Settings.
3. After installing, select text in another app → Share → lang-helper, and the text is brought in and run.
4. Mode switching and Run are in the dark-blue bar at the bottom, which sits right above the keyboard when it's open; tapping any empty area focuses the input.

## Keyboard shortcuts (web app, desktop)

`Ctrl+Enter` run (in term lookup: AI guess) · `Esc` cancel / back · `Alt+1/2/3/4` switch mode · `Alt+C` copy result · `Alt+R` retry

## Appearance

Dark by default; Settings can switch to light or follow the system. Layout inspired by DeepL: two columns on desktop; on mobile, one card plus a bottom action bar.
