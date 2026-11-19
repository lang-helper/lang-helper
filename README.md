# lang-helper

自用的日语／英语小工具，四个模式：

| 模式 | 快捷键 | 做什么 |
|---|---|---|
| **写日语** | Alt+1 | 润色日语、中译日、中日混写（不会的词直接打中文） |
| **转中文** | Alt+2 | 日/英 → 中文；单词自动出词条卡片（读音、释义、搭配、例句） |
| **写英文** | Alt+3 | 润色英语、中译英、中英混写 |
| **查名词** | Alt+4 | 找某个东西在日语里的确切叫法：Wikipedia / Wikidata 边打边查；说不出词时 Ctrl+Enter 让 AI 猜，再逐个去维基验证 |

模型是 DeepSeek `deepseek-flash`（关闭思考，流式输出）。

## 目录

```
web/                    网页本体（部署到 GitHub Pages 的就是这个目录）
  index.html            主界面
  tests.html            提示词测试页（可导出结果）
  tests/cases.json      提示词测试用例
  tests/wiki-selftest.html  名词查询自测（真实调用维基）
  js/prompts.js         ★ 所有提示词都在这里
  js/llm.js             DeepSeek 流式调用
  js/wiki.js            名词查询：Wikidata / Wikipedia 接口 + AI 猜 + 验证
  js/wiki-ui.js         名词查询的结果列表
  popup.html            PC 弹窗页面（参考 pot：多家结果卡片）
  js/popup.js           PC 弹窗的逻辑
  js/yandex.js          Yandex 翻译
  js/history.js         本地历史（IndexedDB）
  sheet.html            手机弹窗页（安卓 App 里从底部弹出的那张卡片）
  js/sheet.js           手机弹窗的逻辑
  js/lang.js            原文语言判断、目标语言候选、「像不像一个词」（PC / 手机共用）
  js/bridge.js          和 PC 弹窗 / 安卓壳通信
  sw.js                 离线缓存
ahk/lang-helper.ahk     PC 弹窗（AutoHotkey v2）
ahk/lang-helper.example.ini  PC 弹窗设置模板
android/                安卓 App（透明窗口 + 网页，选中文字 →「译」）
  make-keystore.ps1     生成签名密钥（只做一次）
dev/server.py           本地开发服务器 + 模拟 DeepSeek 接口
.github/workflows/      自动部署到 GitHub Pages、自动打包安卓 APK
```

## 本地运行

```bash
python dev/server.py
```

打开 http://localhost:8787 ，在「设置」里填 API key。

不想花钱、只想测界面：设置里把 Base URL 改成 `http://localhost:8787/mock`，API key 随便填 8 个字符以上。原文里写 `#401`、`#402`、`#500`、`#slow` 可以模拟各种错误和超时。开发服务器还有 `/__dev/mock?mode=ja&text=...`：一键把当前地址切到模拟接口并带文字打开（只在本地有）。

手机弹窗：`/__dev/mock?delay=0&next=/sheet.html&readonly=0&text=...`；换成 `next=/sheet-android.html` 会加一个假的安卓壳（`window.AndroidBridge`，调用记录在 `window.__android`），用来测替换、返回键、粘贴。

本地默认**不启用**离线缓存，免得改了代码看不到效果。要测缓存时，在浏览器控制台执行 `localStorage.setItem('lh.sw','1')` 再刷新。

## PC 弹窗（照 pot 的样子，不用开浏览器）

选中任意窗口里的文字 → 按快捷键 → 弹出小窗口（`web/popup.html`），**窗口中心对准鼠标指针**（超出屏幕时往回收）。布局照 pot：上面是原文卡片，它的底栏一行放 图钉 · 复制 · 清空 · 设置 · 「● 原文语言」（紫点）……「● 目标语言」（橙点）· 「翻译 / 润色」大按钮；下面是各家结果卡片。润色日语时目标标签显示成「● 日语 · 自动」，点它换文体。配色是 pot 的灰 + 青色；底色是 `#161616`，和 Edge 应用窗口暗色模式的标题栏同色、融为一体（关闭用标题栏的 ×、Esc 或 Alt+W）。

**全局快捷键**（可在 `ahk/lang-helper.ini` 里改）：

| 快捷键 | 动作 |
|---|---|
| `Alt+D` | 把选中的文字放进弹窗，切到「翻译」 |
| `Alt+A` | 把选中的文字放进弹窗，切到「润色」 |
| `Alt+Q` | 打开空白弹窗输入，沿用上次用 Shift+Tab 选的「翻译 / 润色」；弹窗在前台时再按一次 = 收起 |

默认**不自动执行**：文字放进去后可以先改一改，再按 Enter（ini 里 `AutoRun=1` 可以改成自动执行）。没选中文字时，`Alt+D` / `Alt+A` 会原样交给当前程序（比如浏览器里 `Alt+D` 照常跳到地址栏）。注意 `Alt+Q` 会占用 Office 的「搜索」快捷键，介意的话在 ini 里换一个。

**弹窗里的按键：**

| 按键 | 动作 |
|---|---|
| `Enter` / `Shift+Enter` | 执行 / 换行 |
| `Ctrl+Enter` | 执行，并且单词也一定问 DeepSeek |
| `Tab` | 换目标语言（会记住） |
| `Shift+Tab` | 翻译 ⇄ 润色（会记住，下次 `Alt+Q` 沿用） |
| `Alt+C` | 复制结果（有 DeepSeek 的就复制它，没有就复制 Yandex 的） |
| `Alt+V` | 用结果**替换原文**（自动切回原窗口粘贴）；每张卡片底部也有「替换」按钮 |
| `Alt+P` | 图钉：固定后点别处不收起，并置顶 |
| `Alt+R` | 重试 |
| `Esc` | 取消 / 收起 |
| `Alt+W` | 收起 |

**目标语言**：候选顺序是 **日语 > 中文 > 英语**。目标 = 排在最前面、且不是原文语言的那个；按 `Tab` 换成剩下那个。界面上只显示当前的目标。

| 原文 | 默认 | 按 Tab 后 |
|---|---|---|
| 中文 | 日语 | 英语 |
| 日语 | 中文 | 英语 |
| 英语 | 日语 | 中文 |

点目标语言标签也等于按 `Tab`。只有汉字的短词（比如「会議」和「会议」）会按字形猜是日语还是中文，猜错时点原文语言标签切换。

**翻译时自动分流：**

- **像一个词**（短，并且没有标点、助词、动词词尾、代词、虚词）→ 只出 **Yandex**，DeepSeek 卡片折叠着，点开它或按 `Ctrl+Enter` 才去问。例：炊飯器、根回し、打ち合わせ、明日の会議、电饭煲、不好意思、follow up。
- **句子** → **Yandex + DeepSeek** 一起出。例：今日は暑い、確認しました、修好了、麻烦你了、Let's go now.
- 翻译时 DeepSeek 只给结果，不给要点。

**润色**：只用 DeepSeek，标出改动、给出要点。原文是什么语言就润色成什么语言；中文或中日混写会「写成日语」（按 Tab 写成英语）。润色成日语时，点目标语言标签换文体（自动 → です・ます → タメ口 → 正式）。

DeepSeek 卡片用的就是主页面那三套提示词：译成日语用「写日语」，译成中文用「转中文」（单词出词条卡片），译成英语用「写英文」。Yandex 用的是非官方接口（和 pot 一样，不需要 key，但严格说不符合 Yandex 的使用条款，也可能突然失效），可以在设置里关掉。百度暂时没接（它的接口不允许网页直接调用，需要中转）。维基查词不放在弹窗里（以后单独做）。

点到别的窗口时弹窗会自动收起；拖动边缘改的大小会记住。排查问题时可以在 ini 里设 `Debug=1`，每一步都会记到 `ahk/debug.log`。
**用法：**

1. 双击 `ahk/lang-helper.ahk`（需要 AutoHotkey v2，这台电脑已经装了）。托盘里会出现图标。
2. 第一次会生成 `ahk/lang-helper.ini`。部署到 GitHub Pages 之前，弹窗打开的是 `http://localhost:8787/`，所以要先开着 `python dev/server.py`；部署后把 ini 里的 `Url` 改成 Pages 的网址。
3. 弹窗用的是一个**独立的 Edge 配置**（和你平时的 Edge 分开），所以第一次要在弹窗的「设置」里再填一次 API key。
4. 想开机自动启动：托盘菜单 →「开机自动启动」。

**原理：** 弹窗就是 Edge 的「应用窗口」（`--app`，没有地址栏和标签页），AutoHotkey 负责快捷键、把选中文字粘贴进去、把结果粘贴回原窗口。AutoHotkey 粘贴后按 `Ctrl+Alt+Shift+F9`（切到翻译）/ `F10`（切到润色）/ `F11`（新开输入）/ `F12`（从设置页回到弹窗页）通知网页；网页通过改窗口标题告诉 AutoHotkey 要「替换」「收起」「固定」：标题栏上只显示「lang-helper」，后面接一串看不见的零宽字符，解出来是 `popup|动作|序号`（脚本也认旧版网页的 `lang-helper-popup|…` 写法）。这样不需要下载任何第三方库或 DLL。`popup.html?text=...&pmode=polish&run=1` 也可以直接带文字打开（`run=1` 表示直接执行）。

**限制：** 以管理员权限运行的窗口收不到替换；极少数程序会拦截模拟的 Ctrl+C / Ctrl+V。

自测（开发用，会在屏幕上短暂弹出窗口并模拟按键）：`AutoHotkeyV2.exe ahk\lang-helper.ahk /selftest <ini> <log>`。

## 查名词的注意事项

- 维基的接口有限速：普通浏览器每分钟 200 次，日常边打边查用不完。本工具每次查询一般只发 2 个请求，并且一个接一个地发；万一被限速，会自动等几秒再查。
- Claude 桌面版内置浏览器和无界面浏览器会被维基当成自动化程序，限速严得多（每分钟约 10 次）。在那里测试时出现「限流了」是正常的。
- AI 猜出来的词会标注：「✓ 有条目」（日文维基里真有这个词，包括重定向，例如「コンビニ」→「コンビニエンスストア」）、「没找到条目」（可能是编的）、「未能验证」（验证时网络失败或被限流）。
- 复制某个日文名时会记进历史（查名词模式），方便以后复习。

## API key 存在哪

- 只存在每台设备自己的浏览器存储里，**不进仓库，也不放 GitHub Secrets**。
- 请求从设备直接发到 DeepSeek，GitHub 碰不到 key。
- 建议给 GitHub 账号开两步验证（防止别人改你的网页代码）。

## 改提示词

1. 改 `web/js/prompts.js`，把 `PROMPT_VERSION` 加一。
2. 打开 `tests.html`，点「运行」：会用真 key 跑完 `tests/cases.json` 里的全部用例（30 条左右，费用约几美分），和上一次的结果并排对比。点「导出结果」可以存成 JSON。
3. 想加自己的例句，直接编辑 `web/tests/cases.json`。

## 部署到 GitHub Pages

1. 在 GitHub 新建一个**公开**仓库 `lang-helper`（免费版 Pages 要求公开；代码里没有任何秘密）。
2. 把这个目录推上去（`main` 分支）。
3. 仓库 **Settings → Pages → Build and deployment → Source** 选 **GitHub Actions**。
4. 等 Actions 跑完，网址是 `https://<你的用户名>.github.io/lang-helper/`。

## 安卓 App（选中文字 →「译」）

在任何 App 里选中文字，弹出的菜单里点 **译**（有的手机要先点「⋮ / 更多」），屏幕下方弹出一张卡片（最高 3/4 屏）：

1. **第一页**：原文（可以改）、目标语言（两个候选都列出来，点一下选）、「翻译」「润色」两个大按钮。
2. **结果页**：上面原文，下面结果卡片。翻译时卡片可以左右滑：先 Yandex（快），再 DeepSeek；像一个词时 DeepSeek 等你滑过去才查（省钱）。润色只有 DeepSeek 一张，标出改动、给要点。
3. 每张结果卡片：**复制**（卡片不关）、**替换**（只在能编辑的输入框里出现：把原文换成结果并关闭）。
4. 返回键：结果页 → 第一页 → 关闭。点上面变暗的地方、或往下拖卡片也会关闭。
5. 桌面图标打开的是同一张卡片，输入框是空的，直接打字。

App 本身只是一个透明窗口，里面打开 `https://stoney239.github.io/lang-helper/sheet.html`。所以**改网页不用重装 App**，推送后下次打开就是新版；只有改了 `android/` 才需要装新 APK。

### 第一次：准备签名密钥（只做一次）

APK 要用同一把密钥签名，以后才能直接覆盖安装新版（换了密钥就得先卸载，App 里的 API key、历史都会丢）。

1. 生成密钥（已经生成过了，在 `android/keystore/`，不会被提交）：
   ```bash
   powershell -ExecutionPolicy Bypass -File android/make-keystore.ps1
   ```
2. **把 `android/keystore/` 整个文件夹另外备份一份**（网盘、U 盘都行）。
3. GitHub 仓库 → **Settings → Secrets and variables → Actions → New repository secret**，加两个：
   - `ANDROID_KEYSTORE_BASE64`：内容是 `android/keystore/secret-base64.txt` 里的全部文字
   - `ANDROID_KEYSTORE_PASSWORD`：内容是 `android/keystore/password.txt` 里的文字

### 打包和安装

1. 推送后 GitHub Actions 自动打包（改了 `android/` 才会触发；也可以在 Actions 页面手动点「Build Android APK」→ Run workflow）。
2. 手机浏览器打开 https://github.com/stoney239/lang-helper/releases/latest/download/lang-helper.apk 下载安装（第一次要允许「安装未知应用」）。
3. 打开 App → 右上角齿轮 → 填一次 API key（App 里的存储和手机浏览器是分开的）。
4. 小米 / HyperOS：如果选中文字后菜单里没有「译」，在 设置 → 应用 → lang-helper 里看看有没有被限制；部分系统要在菜单里点「更多」才看得到。

## 手机浏览器版（不装 App 时）

1. 手机 Chrome 打开上面的网址 → 右上角菜单 →「添加到主屏幕」或「安装应用」。
2. 在设置里填一次 API key。
3. 安装后，在别的 App 里选中文字 →「分享」→ 选 lang-helper，文字会直接带进来执行。
4. 模式切换和「执行」在屏幕底部的深蓝操作栏里，输入法弹出时贴着键盘上沿；点页面任何空白处都会进入输入。

## 快捷键（网页，电脑上）

`Ctrl+Enter` 执行（查名词时是「AI 猜」）　`Esc` 取消／返回　`Alt+1/2/3/4` 切换模式　`Alt+C` 复制结果　`Alt+R` 重试

## 外观

默认暗色，设置里可以切换亮色或跟随系统。布局参考 DeepL：电脑左右两栏，手机上下一张卡片 + 底部操作栏。
