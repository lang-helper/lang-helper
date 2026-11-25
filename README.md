# lang-helper

A personal Japanese / English writing and translation helper. The web app has four modes (the UI itself is in Chinese):

| Mode | Shortcut | What it does |
|---|---|---|
| **Write Japanese** (写日语) | Alt+1 | Polish Japanese, Chinese → Japanese, mixed Chinese/Japanese input (type Chinese for words you don't know) |
| **To Chinese** (转中文) | Alt+2 | Japanese / English → Chinese; single words get a dictionary card (reading, meanings, collocations, examples) |
| **Write English** (写英文) | Alt+3 | Polish English, Chinese → English, mixed Chinese/English input |
| **Term lookup** (查名词) | Alt+4 | Find the exact Japanese name of a thing: live Wikipedia / Wikidata search; when you can't name it, Ctrl+Enter lets the AI guess and each guess is verified against Wikipedia |

Model: DeepSeek `deepseek-flash` (thinking disabled, streaming).

There is also a separate **Wiki quick look** page (维基速查, `wiki.html`): type a word in any language and see the matching Chinese, Japanese and English Wikipedia articles side by side, switch between them instantly, and read the full article without images. It is free (Wikipedia APIs, no API key), except an optional "let AI guess" button. See [Wiki quick look](#wiki-quick-look-维基速查).

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
  wiki.html             Wiki quick look: zh / ja / en articles for one word (PC popup, Android "Wiki" icon, plain web)
  js/wiki-page.js       Wiki quick look logic
  js/wiki-reader.js     Cleans Wikipedia article HTML into a reading view (images off until clicked)
  css/wiki.css          Wiki quick look styles
  popup.html            PC popup page (modelled on pot: one result card per service)
  js/popup.js           PC popup logic
  js/yandex.js          Yandex Translate
  js/google.js          Google Translate
  js/history.js         Local history (IndexedDB)
  sheet.html            Mobile page (what the Android app shows; full-screen layout)
  js/sheet.js           Mobile page logic
  js/lang.js            Source-language detection, target candidates, "is this a single word" (shared by PC and mobile)
  js/bridge.js          Messaging with the PC popup / Android shell
  sw.js                 Offline cache (network-first)
ahk/lang-helper.ahk     PC popup (AutoHotkey v2)
ahk/lang-helper.example.ini  PC popup settings template
android/                Android app (full-screen window + WebView)
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

Mobile page: `/__dev/mock?delay=0&next=/sheet.html&readonly=0&text=...` (add `&run=translate` or `&run=polish` to run immediately). Add `&android=1` and every page you open afterwards gets a fake Android shell (`window.AndroidBridge`, calls are logged in `window.__android`) for testing replace, the back key, paste and the settings gear. Visit `/__dev/mock` again without `android=1` to turn it off.

Wiki quick look: `http://localhost:8787/wiki.html#q=边际效应` (no API key needed; it calls the real Wikipedia). As the PC popup: `/__dev/mock?shell=ahk&next=/popup.html&text=边际效应&run=1`, then `Alt+K`. As the Android app: `/__dev/mock?android=1&next=/wiki.html&text=炊飯器`.

The service worker is **off** on localhost by default so code changes show up immediately. To test caching, run `localStorage.setItem('lh.sw','1')` in the console and reload.

## PC popup (pot-style, no browser tab needed)

Select text in any window → press a hotkey → a small window (`web/popup.html`) opens **centered on the mouse pointer** (pulled back inside the screen if needed). The layout follows pot: the source card on top, whose footer row holds pin · copy · clear · settings · "● source language" (purple dot) … "● target language" (orange dot) · the big Translate / Polish button; result cards from each service below. When polishing Japanese the target chip reads "● 日语 · 自动" and clicking it cycles the register. Colors are pot's grey + cyan; the background is `#161616`, the same as the dark title bar of an Edge app window, so they blend (hide it with the title bar ×, Esc or Alt+W; the × only hides the window, so the next hotkey is instant — Shift+click × to really close it).

**Global hotkeys** (configurable in `ahk/lang-helper.ini`):

| Hotkey | Action |
|---|---|
| `Alt+D` | Put the selected text into the popup, switch to Translate |
| `Alt+A` | Put the selected text into the popup, switch to Polish |
| `Alt+Q` | Open an empty popup for typing, keeping the Translate / Polish choice last set with Shift+Tab; press again while the popup is in front to hide it |
| `Alt+S` | Open **Wiki quick look** (zh / ja / en Wikipedia articles): looks up the selected text right away; with nothing selected it opens an empty Wiki quick look to type or paste into. Never shows the translate / polish screen (if the popup was last on it, the switch happens off-screen first) |

By default it does **not run automatically**: edit the text first if you like, then press Enter (`AutoRun=1` in the ini makes it run immediately; Wiki quick look always searches right away, it's free). With nothing selected, `Alt+D` / `Alt+A` are passed through to the current program (e.g. `Alt+D` still jumps to a browser's address bar). Note that `Alt+Q` takes over Office's "Search" shortcut; change it in the ini if that bothers you.

**Keys inside the popup:**

| Key | Action |
|---|---|
| `Enter` / `Shift+Enter` | Run / new line |
| `Ctrl+Enter` | Run, and always ask DeepSeek even for a single word |
| `Tab` | Switch target language (remembered) |
| `Shift+Tab` | Translate ⇄ Polish (remembered; `Alt+Q` reuses it) |
| `Alt+C` | Copy the result (DeepSeek's if present, otherwise Google's, otherwise Yandex's) |
| `Alt+V` | **Replace the original** with the result (switches back to the source window and pastes); every card also has a Replace button |
| `Alt+P` | Pin: stays open when you click elsewhere, and stays on top |
| `Alt+K` | Open **Wiki quick look** for the text in the box (in the same window; `Alt+←` or the ‹ button comes back) |
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

- **Looks like a single word** (short, with no punctuation, particles, verb endings, pronouns or function words) → **Yandex + Google** only; the DeepSeek card stays collapsed until you open it or press `Ctrl+Enter`. Examples: 炊飯器, 根回し, 打ち合わせ, 明日の会議, 电饭煲, 不好意思, follow up.
- **Sentence** → **Yandex + Google + DeepSeek** together. Examples: 今日は暑い, 確認しました, 修好了, 麻烦你了, Let's go now.
- When translating, DeepSeek returns only the result, no notes.
- For a single word there is also a **Wikipedia card**: the matching Chinese / Japanese / English article titles (usually one free request; e.g. 边际效应 → 边际效用 · 限界効用 · Marginal utility, where machine translation says 限界効果). When the word is ambiguous it lists the first few candidates instead (e.g. Mercury → the planet, the element, the god…). Click a row or press `Alt+K` to open Wiki quick look.
- History: DeepSeek results are saved as before. A single-word lookup where you didn't open DeepSeek is saved too (Google's result as the main one, both Yandex's and Google's kept), so words show up in history for review.

**Polish**: DeepSeek only, with changes highlighted and notes. Text is polished in its own language; Chinese or mixed Chinese/Japanese is "written as Japanese" (Tab → as English). When polishing into Japanese, click the target chip to change the register (auto → です・ます → タメ口 → formal). The envelope button under the polish result generates 3 email subject candidates from the polished text (light keigo, details in brackets, a 【ご確認】-style tag only when needed); click one to copy it, click the envelope again to regenerate.

The DeepSeek card uses the same three prompts as the main page: into Japanese = "Write Japanese", into Chinese = "To Chinese" (single words get a dictionary card), into English = "Write English". Yandex and Google use unofficial endpoints (same as pot; no key needed, but strictly speaking they aren't within the providers' terms of use and could stop working at any time); each can be turned off in Settings. Google's text is sent in the request body, not the URL. Bing isn't supported: its free route requires posing as the Edge browser; the official Microsoft Translator API (Azure, 2M characters/month free) would need a key. Baidu isn't supported yet (its API can't be called directly from a web page and would need a proxy). The main page's AI term lookup is not in the popup; the popup has the Wikipedia card and Wiki quick look instead.

The popup hides itself when another window gets focus; a size you set by dragging the edges is remembered. The hidden page sends a heartbeat once a minute; if it stops for 3 minutes (Edge froze or unloaded it) or the page has been open for 6 hours (so it picks up new versions), the script quietly replaces it off-screen while you're idle. For troubleshooting set `Debug=1` in the ini and every step is logged to `ahk/debug.log`.

**Usage:**

1. Double-click `ahk/lang-helper.ahk` (requires AutoHotkey v2). An icon appears in the tray.
2. The first run creates `ahk/lang-helper.ini`. Before deploying to GitHub Pages the popup opens `http://localhost:8787/`, so keep `python dev/server.py` running; after deploying, set `Url` in the ini to the Pages URL.
3. The popup uses a **separate Edge profile** (independent from your normal Edge), so enter the API key once more in the popup's Settings.
4. To start with Windows: tray menu → "Start with Windows" (开机自动启动).
5. Tray icon: `TrayIcon=0` in the ini hides it (hotkeys keep working). Without the tray menu: **reload** = double-click `lang-helper.ahk` again (the new instance replaces the running one); **exit** = run `lang-helper.ahk /exit`, or end AutoHotkey in Task Manager. Notices that would be tray notifications are shown as a tooltip next to the mouse instead.

**How it works:** the popup is an Edge "app window" (`--app`: no address bar or tabs). AutoHotkey handles the hotkeys, pastes the selection into the popup and pastes results back into the source window. After pasting, AutoHotkey presses `Ctrl+Alt+Shift+F9` (switch to Translate) / `F10` (switch to Polish) / `F11` (fresh input) / `F12` (return from Settings or Wiki quick look to the popup) / `F8` (look up the box's text in Wiki quick look) to notify the page. The page tells AutoHotkey to replace / hide / pin by changing the window title: the title bar only shows "lang-helper", followed by an invisible string of zero-width characters that decodes to `popup|action|seq` (`popup-settings|…` on Settings / History, `popup-wiki|…` on Wiki quick look; the script also accepts the older `lang-helper-popup|…` form). No third-party libraries or DLLs are needed. `popup.html?text=...&pmode=polish&run=1` opens the popup with text directly (`run=1` runs it immediately).

**Limitations:** windows running as administrator can't receive the replacement; a few programs block simulated Ctrl+C / Ctrl+V.

Self-test (for development; briefly opens windows and simulates keystrokes): `AutoHotkeyV2.exe ahk\lang-helper.ahk /selftest <ini> <log>`.

## Wiki quick look (维基速查)

For "what is this called in the other language?" and "let me show you the Wikipedia page". `wiki.html` opens from the PC popup (`Alt+K`, or the global `Alt+S`), from the Android app's separate **Wiki** icon, or as a normal web page (`wiki.html#q=word`).

- **Finding the articles**: type a word in Chinese, Japanese or English and press Enter. It first looks the word up as a title on the matching Wikipedia (Chinese for kanji-only input, then Japanese), following redirects and simplified / traditional differences, and gets the other languages' titles from the same request (`prop=langlinks`). Example: 边际效应 → redirect → 边际效用 · 限界効用 · Marginal utility. That article opens directly.
- **When it's not clear what you mean**, it shows a list of candidates first and lets you pick (each with its zh · ja · en names and a one-line description; `↑` / `↓` + `Enter` on the keyboard):
  - The title is a **disambiguation page** → the meanings listed on that page, in the page's order (e.g. Mercury → planet, element, god, …; 3 requests).
  - **No article with that title** → Wikidata search results, by relevance. With only one result it opens directly, noting that it's the closest match.
  - On an article, the list icon in the search box means "other entries": back to the candidate list, or, if there was only one result, search for more. Back also returns to the list.
  - **让 AI 猜** (let AI guess, `Alt+G`): when you can't name it, type a rough word or a description. DeepSeek (the term helper prompt from term lookup) suggests names and each one is checked against Japanese Wikipedia: ✓ ones open like any article, the rest are greyed out as "维基没有这个条目" (no article). This is the only part that costs money, and only when you click it.
- **Switching**: the 中 / 日 / 英 buttons at the top show each article's title (on narrow screens, such as phones and the PC popup, they are three full-width rows so long English names fit on one line; the top bar scrolls away with the page); summaries for all three are fetched in parallel, so switching is instant. `Tab` / `Shift+Tab` or `Alt+1/2/3` switch languages; the last language you picked is remembered. Chinese is always shown in simplified characters.
- **Full text** (`Alt+F`, or 全文 in the bottom bar): the article is fetched with the MediaWiki parse API and rendered by the page itself (`js/wiki-reader.js`): no scripts, styles, edit links, navboxes, maintenance banners or footnote markers. **Images are not loaded**: each becomes a small "图片" placeholder you can click to load just that one; the 图片 button (`Alt+I`, remembered) loads all of them. Formulas use MathML, so they show without images. Links to other articles open inside Wiki quick look (with their own zh / ja / en titles); `Esc`, `Alt+←` or Android's Back goes back.
- **Showing it to someone**: big text in a clean reading view; A / **A** in the bottom bar change the size (remembered). 维基百科 (`Alt+O`) opens the real page (Chinese links use `/zh-cn/`). The copy button at the right end of the title copies that language's title (`Alt+C`); long-press it (or `Alt+L`) to copy the link. In the search box, the backspace-shaped button clears it (the × at the top right of the Android app closes the app).
- **Privacy**: the word is kept after `#` in the address (`wiki.html#q=…`), which browsers never send to the server. Images load only from Wikimedia (the page's CSP).
- **Cost / limits**: free except "让 AI 猜". A lookup is usually 1 request plus up to 3 summaries; the full text is 1 more per language (the other two languages are prefetched while you read the full text). The same rate limits as term lookup apply (see below).

## Term lookup notes

- Wikimedia APIs are rate-limited: 200 requests/minute for normal browsers, which everyday type-as-you-search never reaches. Each lookup usually sends 2 requests, one after the other; if rate-limited it waits a few seconds and retries.
- The Claude desktop app's built-in browser and headless browsers are treated as bots by Wikimedia and get a much stricter limit (about 10/minute), so "rate limited" there is expected.
- AI guesses are labelled: "✓ has an article" (a real Japanese Wikipedia article exists, redirects included, e.g. コンビニ → コンビニエンスストア), "no article found" (possibly made up), "couldn't verify" (network error or rate limit during verification).
- Copying a Japanese name records it in history (term lookup mode) for later review.
- Each expanded result has a "wiki 速查" link that opens the article in Wiki quick look.

## Where the API key is stored

- Only in each device's own browser storage. **Never in the repo, never in GitHub Secrets.**
- Requests go straight from the device to DeepSeek; GitHub never sees the key.
- Turn on two-factor authentication for your GitHub account (so nobody else can change the web code).

## Changing prompts

1. Edit `web/js/prompts.js` and bump `PROMPT_VERSION`.
2. Open `tests.html` and click Run: all cases in `tests/cases.json` (about 30, a few cents with a real key) are run and shown side by side with the previous run. "Export" saves the results as JSON.
3. To add your own sentences, edit `web/tests/cases.json`.

## Deploy to GitHub Pages

The repository lives in its own GitHub organization, **lang-helper**, so the site is at **https://lang-helper.github.io/lang-helper/**.

Why an organization: browser storage (where the API key and history live) is per domain. Under a personal `<user>.github.io` domain, every other Pages site of that user shares the same storage and could read the key. The organization's domain hosts only this tool.

1. The repository must be **public** (free Pages requires it; there are no secrets in the code).
2. Push to `main`.
3. Repository **Settings → Pages → Build and deployment → Source**: **GitHub Actions**.
4. When the Actions run finishes, the site is updated.

If the address ever changes: update `SHEET_URL` in `android/app/build.gradle.kts` (needs a new APK), `Url` in `ahk/lang-helper.ini`, and the links in this README. Storage on the new domain starts empty: export history first, then re-enter the API key and import.

## Android app

Open it from the launcher icon or a floating-ball shortcut. It works full screen and in a small (freeform) window. Text, icons and buttons are sized large so it stays usable in a small window. The layout fills whatever window it gets:

There is a single screen with two states:

1. **Typing**: the source text fills the space; below it the target language (both candidates shown; tap to choose) and two big buttons, Translate (翻译) and Polish (润色), which sit right above the keyboard when it's open. **Enter = Translate** (Shift+Enter on a hardware keyboard inserts a new line).
2. **Results**: after Translate / Polish, the source box animates up to about 1/3 of the screen and the buttons below are replaced by the result cards, stacked vertically and scrolling: Yandex → Google → DeepSeek (fastest first). The title bar shows the direction (e.g. 翻译 · 中文 → 日语). For a single word the DeepSeek card stays folded until you tap it (saves money). Polish shows one DeepSeek card with changes highlighted and notes.
3. Tap the source box (or the ‹ arrow, or press Back) to go back to typing: the box expands and the buttons return.
4. Each result card has large buttons across the bottom: **Copy** (stays open) and **Replace** (only when the text came in from an editable field via the selection menu: puts the result in place of the original and closes).
5. Back key: results → typing → close.
6. Gear → Settings; the history icon is in the settings page's top bar. **Export** opens Android's "Save as" (pick e.g. Downloads); **Import** opens the file picker. The app's history lives only inside the app and is deleted on uninstall, so export it now and then. Text you typed is kept when you go to Settings and come back.

The app also registers a **lang-helper** entry in the text-selection menu (PROCESS_TEXT), but some phones (e.g. HyperOS) don't show third-party entries there.

**Wiki** (Wiki quick look) is a second launcher icon from the same APK (a small black Times New Roman "W" on white, kept small so round icon masks don't clip it), so you know you're looking something up on Wikipedia rather than translating. It is a separate entry in Recents and opens `wiki.html` full screen (small windows work too); the text-selection menu also gets a **Wiki** entry. Inside: type or paste a word, switch 中 / 日 / 英, 全文 for the full text without images, A / **A** for text size; Back goes from full text to summary, then closes. It shares settings with lang-helper and needs no API key. The icon arrives with the next APK build (triggered by the `android/` changes); after that, changes to the page itself arrive without reinstalling.

The app itself is just a window with a WebView that opens `https://lang-helper.github.io/lang-helper/sheet.html`. **Web changes don't need a reinstall**: after a push, the next time you open it you get the new version. A new APK is only needed when something under `android/` changes.

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
2. On the phone, open https://github.com/lang-helper/lang-helper/releases/latest/download/lang-helper.apk and install it (allow "Install unknown apps" the first time).
3. Open the app → gear icon (top right) → enter the API key once (the app's storage is separate from the phone's browser).
4. Xiaomi / HyperOS: if the launcher keeps showing an old icon after an update, restart the phone (the system caches app icons).

## Mobile browser version (without the app)

1. Open the Pages URL in Chrome on the phone → menu → "Add to Home screen" / "Install app".
2. Enter the API key once in Settings.
3. After installing, select text in another app → Share → lang-helper, and the text is brought in and run.
4. Mode switching and Run are in the dark-blue bar at the bottom, which sits right above the keyboard when it's open; tapping any empty area focuses the input.

## Keyboard shortcuts (web app, desktop)

`Ctrl+Enter` run (in term lookup: AI guess) · `Esc` cancel / back · `Alt+1/2/3/4` switch mode · `Alt+C` copy result · `Alt+R` retry

Wiki quick look: `Enter` search · `↑` / `↓` pick a candidate · `Alt+G` let AI guess · `Tab` / `Shift+Tab` or `Alt+1/2/3` switch language · `Alt+F` full text ⇄ summary · `Alt+I` images · `Alt+C` copy title · `Alt+L` copy link · `Alt+O` open on Wikipedia · `Esc` / `Alt+←` back

## Appearance

Dark by default; Settings can switch to light or follow the system. Layout inspired by DeepL: two columns on desktop; on mobile, one card plus a bottom action bar.
