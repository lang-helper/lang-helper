; lang-helper PC 弹窗（AutoHotkey v2）—— 参考 pot 的划词翻译 / 输入翻译
;
;   Alt+D  把选中的文字放进弹窗，切到「翻译」（单词只出 Yandex；句子 Yandex + DeepSeek）
;   Alt+A  把选中的文字放进弹窗，切到「润色」（DeepSeek）
;   Alt+Q  打开空白弹窗输入（沿用上次用 Shift+Tab 选的「翻译 / 润色」）；弹窗在前台时再按 = 收起
;   默认不自动执行：可以先改一改，再按 Enter（ini 里 AutoRun=1 可改成自动执行）
;   没选中文字时，Alt+D / Alt+A 原样交给当前程序（比如浏览器里 Alt+D 照常跳到地址栏）
;
; 弹窗里：Enter 执行 · Tab 换目标语言 · Shift+Tab 翻译⇄润色 · Alt+C 复制 · Alt+V 替换原文 · Esc 收起
; 点到别的窗口时自动收起；点弹窗左上角的图钉（Alt+P）可以固定（并置顶）。
; 点标题栏的 × 也只是收起（窗口不关，下次马上出来）；Shift+点 × 才真的关掉。
;
; 弹窗就是 Edge 的「应用窗口」（--app，没有地址栏和标签页），用独立的配置目录，不影响你平时的 Edge。
; AHK → 网页：粘贴文字后按 Ctrl+Alt+Shift+F9（切到翻译）/ F10（切到润色）/ F11（新开输入）/ F12（回到弹窗页）
; 网页 → AHK：窗口标题 =「lang-helper」+ 看不见的零宽字符暗号（解出来是「popup|动作|序号」），AHK 每 0.1 秒看一次。
;
; 设置在同目录的 lang-helper.ini（第一次运行时从 lang-helper.example.ini 复制）。
;
; 托盘图标可以隐藏（ini 里 TrayIcon=0）。没有托盘菜单时：
;   重新加载 = 再双击一次本脚本（新的会替换掉正在运行的）
;   退出     = 运行「lang-helper.ahk /exit」，或在任务管理器里结束 AutoHotkey

#Requires AutoHotkey v2.0
#SingleInstance Force
Persistent

; /exit：上面的 #SingleInstance Force 已经把正在运行的那个关掉了，这里自己也退出 = 退出 lang-helper
if A_Args.Length >= 1 && A_Args[1] = "/exit"
    ExitApp

; 弹窗窗口标题：看得见的「lang-helper」+ 看不见的暗号（U+2063 开头的零宽字符，见 DecodeTitle）
global TITLE_PREFIX := "lang-helper" Chr(0x2063)
global PAGE_POPUP := "popup"
global OLD_TITLE := "lang-helper-popup"   ; 旧版网页直接把暗号写在标题里
global INI := A_ScriptDir "\lang-helper.ini"
global START_MS := UnixMs()
global CFG := ""
global gOrigHwnd := 0     ; 按快捷键时的前台窗口（替换原文时切回去）
global gSavedClip := ""   ; 按快捷键前的剪贴板内容（用完还原）
global gHasSaved := false
global gLastSeq := ""
global gPinned := false
global gShownAt := 0
global gBlurTicks := 0
global gPopupHwnd := 0    ; 记住自己打开的弹窗窗口（页面重新加载时标题会短暂变化，不能只靠标题找）
global gLastInvoke := 0
global gPopupAlive := false   ; 上一次检查时弹窗窗口还在（用来发现「窗口没了」）
global gLaunchingUntil := 0   ; 正在启动弹窗窗口（到这个时刻为止），这期间别再开第二个
global gLastRewarm := 0       ; 上一次因为「窗口没了」而重新准备的时间（防止反复重开）
global OFFSCREEN := -32000    ; 后台准备弹窗时把窗口开在屏幕外的这个位置
global gLastAlive := 0        ; 最近一次收到网页任何信号（含每分钟的心跳）的时间
global gSawHeartbeat := false ; 这个弹窗的网页会发心跳（旧版网页不发，就不按心跳判断）
global STALE_MS := 180000     ; 藏着的弹窗超过 3 分钟没心跳 = 网页被 Edge 冻结 / 回收了
global gPopupSeen := false    ; 这次运行里见过弹窗窗口（之后窗口没了 = 确实关掉了，不用再等它重新加载）
global gPopupBornAt := 0      ; 现在这个弹窗窗口是什么时候开的
global REFRESH_MS := 6 * 3600000  ; 点 × 只是收起、网页一直开着：开了 6 小时就趁你不用时在后台换新（拿到网页的新版本）

SetTitleMatchMode 1       ; 标题「以……开头」
DetectHiddenWindows true
; AutoHotkey 默认每次移动 / 显示 / 激活窗口后都停 0.1 秒，弹出一次要白等 0.3 秒；
; 激活是否成功另有 WinWaitActive 确认，这里只留一点点
SetWinDelay 10

if A_Args.Length >= 1 && A_Args[1] = "/selftest" {
    INI := A_Args.Length >= 2 ? A_Args[2] : INI
    CFG := LoadConfig(INI)
    SetTimer(WatchPopup, 100)
    SelfTest(A_Args.Length >= 3 ? A_Args[3] : A_ScriptDir "\selftest.log")
    ExitApp
}

CFG := LoadConfig(INI)
SetupTray()
RegisterHotkeys()
SetTimer(WatchPopup, 100)
SetTimer(CheckPopupHealth, 30000)
if CFG.Prewarm
    SetTimer(() => EnsurePopup(true), -1500)

; ───────────────────────── 设置 ─────────────────────────

LoadConfig(path) {
    example := A_ScriptDir "\lang-helper.example.ini"
    if !FileExist(path) && FileExist(example)
        FileCopy(example, path)
    c := {}
    c.Url := IniRead(path, "Popup", "Url", "http://localhost:8787/")
    c.Width := Integer(IniRead(path, "Popup", "Width", "480"))
    c.Height := Integer(IniRead(path, "Popup", "Height", "640"))
    c.SavedW := Integer(IniRead(path, "Popup", "SavedW", "0"))
    c.SavedH := Integer(IniRead(path, "Popup", "SavedH", "0"))
    c.Prewarm := IniRead(path, "Popup", "Prewarm", "1") = "1"
    c.HideOnBlur := IniRead(path, "Popup", "HideOnBlur", "1") = "1"
    c.HideAfterCopy := IniRead(path, "Popup", "HideAfterCopy", "0") = "1"
    c.Debug := IniRead(path, "Popup", "Debug", "0") = "1"
    c.AutoRun := IniRead(path, "Popup", "AutoRun", "0") = "1"
    c.TrayIcon := IniRead(path, "Popup", "TrayIcon", "1") = "1"
    c.Edge := IniRead(path, "Popup", "Edge", "")
    if c.Edge = ""
        c.Edge := FindEdge()
    c.Profile := IniRead(path, "Popup", "Profile", "")
    if c.Profile = ""
        c.Profile := EnvGet("LOCALAPPDATA") "\lang-helper\edge-popup"
    c.Keys := Map()
    defaults := Map("translate", "!d", "polish", "!a", "input", "!q")
    for kind, def in defaults
        c.Keys[kind] := Trim(IniRead(path, "Hotkeys", kind, def))
    return c
}

FindEdge() {
    for p in [EnvGet("ProgramFiles(x86)") "\Microsoft\Edge\Application\msedge.exe"
            , EnvGet("ProgramFiles") "\Microsoft\Edge\Application\msedge.exe"
            , EnvGet("LOCALAPPDATA") "\Microsoft\Edge\Application\msedge.exe"]
        if FileExist(p)
            return p
    return "msedge.exe"
}

; Url 以 / 结尾时打开其中的 popup.html
PopupUrl() {
    u := CFG.Url
    if SubStr(u, -1) = "/"
        u .= "popup.html"
    return u (InStr(u, "?") ? "&" : "?") "shell=ahk"
}

RegisterHotkeys() {
    for kind, key in CFG.Keys {
        if key = ""
            continue
        ; $：自己 Send 出去的同一组合键不会再次触发（「交还给当前程序」要用）
        try Hotkey("$" key, Invoker(kind))
        catch as e
            MsgBox("快捷键 " key "（" kind "）注册失败：`n" e.Message, "lang-helper", "Icon!")
    }
}

Invoker(kind) {
    return (*) => InvokeOnce(kind)
}

; 按住不放时键盘会自动连发：等按键松开再结束这个线程，连发就会被丢掉（同一热键同时只跑一个线程）
InvokeOnce(kind) {
    global gLastInvoke
    if A_TickCount - gLastInvoke < 300
        return
    try Invoke(kind)
    catch as e
        DebugLog("Invoke 出错：" e.Message)
    KeyWait(MainKey(CFG.Keys[kind]))
    gLastInvoke := A_TickCount
}

MainKey(hk) {
    while hk != "" && InStr("^!+#<>*~$", SubStr(hk, 1, 1))
        hk := SubStr(hk, 2)
    return hk
}

; 调试日志：ini 里 Debug=1 时写到 ahk\debug.log（超过 200KB 自动清空）
DebugLog(msg) {
    if !CFG || !CFG.Debug
        return
    f := A_ScriptDir "\debug.log"
    try {
        if FileExist(f) && FileGetSize(f) > 200000
            FileDelete(f)
        FileAppend(FormatTime(, "MM-dd HH:mm:ss") "." Format("{:03}", A_MSec) "  " msg "`n", f, "UTF-8")
    }
}

; 「!d」→ Send 用的「!d」；「^!Space」→「^!{Space}」
SendableKey(hk) {
    mods := ""
    while hk != "" && InStr("^!+#<>*~$", SubStr(hk, 1, 1)) {
        c := SubStr(hk, 1, 1)
        hk := SubStr(hk, 2)
        if InStr("^!+#", c)
            mods .= c
    }
    return mods (StrLen(hk) > 1 ? "{" hk "}" : hk)
}

; ───────────────────────── 弹窗 ─────────────────────────

FindPopup() {
    global gPopupHwnd
    if gPopupHwnd && WinExist("ahk_id " gPopupHwnd)
        return gPopupHwnd
    gPopupHwnd := SearchPopup()
    return gPopupHwnd
}

; 按标题找弹窗窗口。也认旧版网页的标题「lang-helper-popup…」（网页还没更新到新版时也能用）
SearchPopup() {
    if hwnd := WinExist(TITLE_PREFIX " ahk_exe msedge.exe")
        return hwnd
    return WinExist(OLD_TITLE " ahk_exe msedge.exe")
}

WaitPopup(seconds) {
    t0 := A_TickCount
    while A_TickCount - t0 < seconds * 1000 {
        if hwnd := SearchPopup()
            return hwnd
        Sleep(100)
    }
    ; 等的时候可能被别的线程（快捷键 / 后台准备）打断，回来时已经超时了：最后再找一次
    return SearchPopup()
}

; 暗号「|」前面那一段：popup = 弹窗页，popup-settings = 设置 / 历史页
PageOf(hwnd) {
    try return StrSplit(DecodeTitle(WinGetTitle(hwnd)), "|")[1]
    return ""
}

; 解出标题里看不见的暗号：U+2063 之后，每 7 个零宽字符（U+200B = 0，U+200C = 1）是一个 ASCII 字符
DecodeTitle(title) {
    p := InStr(title, Chr(0x2063))
    if !p {
        ; 旧版网页：标题直接是「lang-helper-popup|动作|序号」
        if SubStr(title, 1, StrLen(OLD_TITLE)) = OLD_TITLE
            return SubStr(title, StrLen("lang-helper-") + 1)
        return ""
    }
    bits := SubStr(title, p + 1)
    out := ""
    code := 0, n := 0
    Loop Parse bits {
        if A_LoopField = Chr(0x200C)
            code := code * 2 + 1
        else if A_LoopField = Chr(0x200B)
            code := code * 2
        else
            continue
        if ++n = 7 {
            out .= Chr(code)
            code := 0, n := 0
        }
    }
    return out
}

; hideAfter = 后台准备（预热）：开好后藏起来，把焦点还给原来的窗口
EnsurePopup(hideAfter := false) {
    global gPopupHwnd, gLaunchingUntil
    if hwnd := FindPopup()
        return hwnd
    ; 正在开弹窗（通常是后台在准备）：等它出来，不要再开一个。
    ; 你按快捷键时最多等 5 秒（平时 1–2 秒就出来）：万一那个没出来，就自己开，不干等
    if A_TickCount < gLaunchingUntil {
        wait := (gLaunchingUntil - A_TickCount) / 1000
        if hwnd := WaitPopup(hideAfter ? wait : Min(wait, 5)) {
            gPopupHwnd := hwnd
            return hwnd
        }
    }
    ; 脚本刚启动、还没见过弹窗时：页面可能正在重新加载（标题里暂时没有暗号），先等一下，免得重复开窗口。
    ; 见过的弹窗窗口没了（关掉了 / Edge 退出了），就不用白等这 1.2 秒
    if !gPopupSeen && (hwnd := WaitPopup(1.2)) {
        gPopupHwnd := hwnd
        return hwnd
    }
    ; 从「再找一次」到「开 Edge」之间不让别的线程插进来：以前后台准备被快捷键打断，
    ; 回来后又开了一个，快捷键那边就跟着干等了十几秒
    Critical("On")
    if hwnd := FindPopup() {
        Critical("Off")
        return hwnd
    }
    DebugLog(hideAfter ? "后台准备新的弹窗窗口" : "启动新的弹窗窗口（冷启动，要几秒）")
    DirCreate(CFG.Profile)
    prev := WinExist("A")
    t0 := A_TickCount
    args := Format('--app="{1}" --user-data-dir="{2}" --no-first-run --no-default-browser-check --window-size={3},{4}'
        , PopupUrl(), CFG.Profile, CFG.Width, CFG.Height)
    ; 藏着的弹窗别被 Edge 降速 / 冻结（心跳要按时发，再显示时也不用等它醒）
    args .= " --disable-renderer-backgrounding --disable-background-timer-throttling --disable-backgrounding-occluded-windows"
    ; 后台准备：开在屏幕外面，看不见（要用的时候 PlaceNearMouse 会挪到鼠标旁边）
    if hideAfter
        args .= " --window-position=" OFFSCREEN "," OFFSCREEN
    gLaunchingUntil := A_TickCount + 15000
    try Run('"' CFG.Edge '" ' args)
    catch as e {
        gLaunchingUntil := 0
        Critical("Off")
        MsgBox("启动 Edge 失败：`n" e.Message, "lang-helper", "Icon!")
        return 0
    }
    Critical("Off")
    if hideAfter
        HideOffscreenSoon(prev, t0)
    hwnd := WaitPopup(15)
    gLaunchingUntil := 0
    if !hwnd {
        DebugLog("弹窗页面 15 秒内没打开")
        Notify("打不开弹窗页面：" CFG.Url "`n网络通吗？或者改 lang-helper.ini 里的 Url。", "Iconx")
        return 0
    }
    gPopupHwnd := hwnd
    DebugLog("弹窗窗口准备好了（" A_TickCount - t0 " ms）")
    if CFG.SavedW > 200 && CFG.SavedH > 200
        WinMove(, , CFG.SavedW, CFG.SavedH, hwnd)
    ; 后台准备的：藏起来。但这期间你已经按快捷键把它叫出来了的话（gShownAt 更新过），就别藏
    if hideAfter && gShownAt < t0 {
        WinHide(hwnd)
        if prev && prev != hwnd && WinExist(prev)
            try WinActivate(prev)
    }
    return hwnd
}

; 后台准备的窗口开在屏幕外：一出现就藏起来、把焦点还给原来的窗口（不等网页加载完），基本看不到。
; 注意：最小化的窗口坐标也是 -32000，所以要排除最小化的（不然会把你平时最小化的 Edge 藏掉）。
HideOffscreenSoon(prev, t0) {
    t := A_TickCount
    while A_TickCount - t < 4000 {
        for h in WinGetList("ahk_exe msedge.exe ahk_class Chrome_WidgetWin_1") {
            if !IsOffscreen(h) || !DllCall("IsWindowVisible", "ptr", h)
                continue
            if gShownAt >= t0         ; 这期间你已经按快捷键把它叫出来了：别藏
                return
            WinHide(h)
            if prev && prev != h && WinExist(prev)
                try WinActivate(prev)
            DebugLog("后台窗口已藏好（" A_TickCount - t0 " ms）")
            return
        }
        Sleep(30)
    }
}

; 在屏幕外（我们故意开在 -32000 的位置），并且不是最小化
IsOffscreen(hwnd) {
    try {
        if WinGetMinMax(hwnd) = -1
            return false
        WinGetPos(&x, &y, , , hwnd)
        return x <= OFFSCREEN + 1000 && y <= OFFSCREEN + 1000
    }
    return false
}

; 每 30 秒：藏着的弹窗如果超过 3 分钟没心跳（网页被 Edge 冻结 / 回收了，再显示会黑好几秒），
; 趁你没在用（2 秒没碰键盘鼠标）把它关掉；WatchPopup 发现窗口没了，会在屏幕外悄悄准备一个新的。
CheckPopupHealth() {
    if A_TickCount < gLaunchingUntil
        return
    hwnd := FindPopup()
    if !hwnd || IsVisible(hwnd)
        return
    ; 点 × 只是收起，网页一直开着：开了 6 小时以上，趁你 1 分钟没碰键盘鼠标在后台换一个新的（拿到网页的新版本）
    if gPopupBornAt && A_TickCount - gPopupBornAt > REFRESH_MS && A_TimeIdlePhysical >= 60000 {
        DebugLog("弹窗网页开了 " Round((A_TickCount - gPopupBornAt) / 3600000, 1) " 小时，后台换一个新的")
        try WinClose(hwnd)
        return
    }
    if !gSawHeartbeat || A_TickCount - gLastAlive < STALE_MS || A_TimeIdlePhysical < 2000
        return
    DebugLog("弹窗网页 " Round((A_TickCount - gLastAlive) / 60000) " 分钟没心跳（被 Edge 冻结 / 回收了），后台换一个新的")
    try WinClose(hwnd)
}

; 等网页有反应（收到任何信号，包括心跳），最多 ms 毫秒
WaitPageAlive(since, ms) {
    t := A_TickCount
    while gLastAlive < since && A_TickCount - t < ms
        Sleep(50)
    return gLastAlive >= since
}

; 弹窗窗口没了（Shift+点了标题栏的 ×、Edge 自己退出了……）：等你闲下来（2 秒没碰键盘鼠标）
; 再在后台重新准备一个，下次按快捷键还是 0.5 秒左右就出来，不用冷启动 Edge（要 2.5–4 秒）
RewarmWhenIdle() {
    global gLastRewarm
    if FindPopup() || A_TickCount < gLaunchingUntil
        return                       ; 已经有了 / 正在开
    if A_TimeIdlePhysical < 2000 {
        SetTimer(RewarmWhenIdle, -1000)
        return
    }
    if A_TickCount - gLastRewarm < 60000 {
        DebugLog("1 分钟内已经重新准备过，这次不自动重开（等下次按快捷键再开）")
        return
    }
    gLastRewarm := A_TickCount
    EnsurePopup(true)
}

IsVisible(hwnd) {
    return hwnd && DllCall("IsWindowVisible", "ptr", hwnd)
}

ShowPopup(hwnd) {
    global gShownAt, gBlurTicks
    gShownAt := A_TickCount
    gBlurTicks := 0
    WinShow(hwnd)
    ok := false
    Loop 3 {                         ; 偶尔一次激活不成功，多试几次
        try WinActivate(hwnd)
        if WinWaitActive(hwnd, , 0.7) {
            ok := true
            break
        }
        DebugLog("激活弹窗失败，重试 " A_Index)
    }
    gShownAt := A_TickCount
    if !ok
        return false
    ; 停在设置 / 历史页时，先回到弹窗页
    if PageOf(hwnd) != PAGE_POPUP {
        Send("^!+{F12}")
        t0 := A_TickCount
        while PageOf(hwnd) != PAGE_POPUP && A_TickCount - t0 < 4000
            Sleep(100)
        WinActivate(hwnd)
        if PageOf(hwnd) != PAGE_POPUP || !WinWaitActive(hwnd, , 1)
            return false
    }
    Sleep(60)
    return true
}

HidePopup(reactivate := true) {
    if hwnd := FindPopup() {
        SaveSize(hwnd)
        WinHide(hwnd)
    }
    if reactivate && gOrigHwnd && WinExist(gOrigHwnd)
        try WinActivate(gOrigHwnd)
}

; 记住用户拖出来的大小（物理像素，下次启动后用 WinMove 还原）
SaveSize(hwnd) {
    try WinGetPos(, , &w, &h, hwnd)
    catch
        return
    if w > 200 && h > 200 && (w != CFG.SavedW || h != CFG.SavedH) {
        CFG.SavedW := w, CFG.SavedH := h
        try IniWrite(w, INI, "Popup", "SavedW")
        try IniWrite(h, INI, "Popup", "SavedH")
    }
}

PlaceNearMouse(hwnd) {
    CoordMode("Mouse", "Screen")
    MouseGetPos(&mx, &my)
    WinGetPos(, , &w, &h, hwnd)
    l := 0, t := 0, r := A_ScreenWidth, b := A_ScreenHeight
    Loop MonitorGetCount() {
        MonitorGetWorkArea(A_Index, &ml, &mt, &mr, &mb)
        if (mx >= ml && mx < mr && my >= mt && my < mb) {
            l := ml, t := mt, r := mr, b := mb
            break
        }
    }
    ; 弹窗中心对准鼠标指针；超出屏幕（工作区）就往回收
    x := Max(l, Min(mx - w // 2, r - w))
    y := Max(t, Min(my - h // 2, b - h))
    WinMove(x, y, , , hwnd)
}

; 点弹窗标题栏的 × = 收起（和 Esc 一样），窗口不关：下次按快捷键还是马上出来，不用重新启动 Edge（要 2.5–4 秒）。
; 真要关掉（比如想让网页重新加载）：按住 Shift 再点 ×，或者在弹窗里按 F5 刷新。
#HotIf OverPopupClose()
LButton:: {
    DebugLog("点了 ×：收起（窗口不关）")
    HidePopup()
}
#HotIf

; 鼠标是不是正指着弹窗标题栏的 ×（每次按鼠标左键都会问一下，所以要快：不是弹窗就马上返回）
OverPopupClose() {
    if !gPopupHwnd
        return false
    CoordMode("Mouse", "Screen")
    MouseGetPos(&mx, &my, &win)
    if win != gPopupHwnd
        return false
    ; 先粗看：在窗口右上角（× 大约 46×32，按屏幕缩放放大）
    try WinGetPos(&x, &y, &w, , win)
    catch
        return false
    s := A_ScreenDPI / 96
    if mx < x + w - 80 * s || my > y + 60 * s
        return false
    ; 再问 Edge 这一点是什么：HTCLOSE(20) = 标题栏的 ×
    try return SendMessage(0x84, 0, (mx & 0xFFFF) | ((my & 0xFFFF) << 16), , win, , , , 200) = 20
    return false
}

; 按下快捷键。kind = translate | polish | input
Invoke(kind) {
    global gOrigHwnd, gSavedClip, gHasSaved
    t0 := A_TickCount
    popup := FindPopup()
    active := WinExist("A")
    DebugLog("按下 " kind "：弹窗=" (popup ? (IsVisible(popup) ? "显示中" : "隐藏") : "不存在") " 前台=" (active = popup ? "弹窗" : WinGetProcessNameSafe(active)))

    ; 已经在弹窗里：Alt+D / Alt+A = 切到翻译 / 润色，Alt+Q = 收起
    ; （必须是「看得见」的弹窗：刚隐藏的窗口有时仍被 Windows 当作前台，以前会因此弹不出来）
    if popup && active = popup && IsVisible(popup) {
        switch kind {
            case "translate": Send("^!+{F9}")
            case "polish": Send("^!+{F10}")
            case "input": HidePopup()
        }
        return
    }
    ; 弹窗固定着、但不在前台：Alt+Q 把它切到前台
    if kind = "input" && popup && IsVisible(popup) {
        gOrigHwnd := active
        ShowPopup(popup)
        return
    }

    text := ""
    if kind != "input" {
        SetTimer(RestoreClip, 0)
        gSavedClip := ClipboardAll()
        gHasSaved := true
        A_Clipboard := ""
        Send("^c")
        if ClipWait(0.35)
            text := A_Clipboard
        if Trim(text, " `t`r`n") = "" {
            ; 没选中文字：还原剪贴板，把按键原样交给当前程序
            RestoreClip()
            Send(SendableKey(CFG.Keys[kind]))
            return
        }
    }

    gOrigHwnd := active
    hwnd := EnsurePopup()
    if !hwnd {
        RestoreClip()
        return
    }
    if !IsVisible(hwnd) || IsOffscreen(hwnd)   ; 屏幕外的（后台准备的）也挪到鼠标旁边
        PlaceNearMouse(hwnd)
    tShow := A_TickCount
    if !ShowPopup(hwnd) {
        DebugLog("弹窗没能激活，放弃这次操作")
        RestoreClip()
        return
    }
    ; 网页一阵子没心跳：可能刚被唤醒 / 正在重新加载。等它有反应再粘贴、发指令，免得文字丢了
    if gSawHeartbeat && A_TickCount - gLastAlive > 90000 {
        ok := WaitPageAlive(tShow, 6000)
        DebugLog("网页" (ok ? "醒了" : "6 秒内没反应") "（等了 " A_TickCount - tShow " ms）")
    }
    if kind = "input" {
        Send("^!+{F11}")              ; 新开输入：清空，回到上次的「翻译 / 润色」
        DebugLog("就绪：" A_TickCount - t0 " ms")
        return
    }
    Send("^a")
    Send("^v")
    Sleep(60)
    Send(kind = "translate" ? "^!+{F9}" : "^!+{F10}")   ; 切到翻译 / 润色，光标停在末尾，不执行
    DebugLog("就绪：" A_TickCount - t0 " ms")
    if CFG.AutoRun {
        Sleep(60)
        Send("{Enter}")
    }
    SetTimer(RestoreClip, -800)      ; 稍后把剪贴板还原成按快捷键之前的内容
}

RestoreClip() {
    if gHasSaved
        A_Clipboard := gSavedClip
}

; 每 0.1 秒：处理网页发来的动作；没固定时，弹窗不在前台就收起
WatchPopup() {
    global gLastSeq, gBlurTicks, gPopupAlive, gLastAlive, gSawHeartbeat, gPopupSeen, gPopupBornAt
    hwnd := FindPopup()
    if !hwnd {
        if gPopupAlive {
            gPopupAlive := false
            gSawHeartbeat := false           ; 新窗口重新开始算
            gLastAlive := 0
            DebugLog("弹窗窗口没了（Shift+点了 × / 后台换新 / Edge 退出了），闲下来后在后台重新准备")
            if CFG.Prewarm
                SetTimer(RewarmWhenIdle, -2000)
        }
        return
    }
    if !gPopupAlive {                        ; 新出现的弹窗窗口
        gPopupSeen := true
        gPopupBornAt := A_TickCount
    }
    gPopupAlive := true
    try title := WinGetTitle(hwnd)
    catch
        return
    parts := StrSplit(DecodeTitle(title), "|")
    if parts.Length >= 3 && parts[3] != gLastSeq {
        gLastSeq := parts[3]
        if IsNumber(parts[3]) && Number(parts[3]) >= START_MS {  ; 脚本启动前留下的旧信号忽略
            gLastAlive := A_TickCount
            if parts[2] = "alive" {          ; 心跳：只记时间，不写日志（每分钟一次，太多）
                if !gSawHeartbeat
                    DebugLog("收到网页心跳（之后藏久了没心跳会在后台刷新弹窗）")
                gSawHeartbeat := true
            } else
                HandleSignal(parts[2], hwnd)
        }
    }

    if !CFG.HideOnBlur || gPinned || !IsVisible(hwnd) || A_TickCount - gShownAt < 500
        return
    act := WinExist("A")
    if !act || act = hwnd || SamePid(act, hwnd) {   ; act=0：正在切换窗口，不算失焦
        gBlurTicks := 0
        return
    }
    gBlurTicks += 1
    if gBlurTicks >= 3 {             ; 连续 0.3 秒不在前台（拖动窗口时不会误收）
        gBlurTicks := 0
        DebugLog("失焦收起（前台=" WinGetProcessNameSafe(act) "）")
        SaveSize(hwnd)
        WinHide(hwnd)
    }
}

SamePid(a, b) {
    try return WinGetPID(a) = WinGetPID(b)
    return false
}

WinGetProcessNameSafe(hwnd) {
    try return WinGetProcessName(hwnd) " / " WinGetClass(hwnd)
    return "无"
}

HandleSignal(action, hwnd) {
    global gPinned
    DebugLog("网页信号：" action)
    switch action {
        case "close":
            HidePopup()
        case "replace":
            DoReplace()
        case "copied":
            SetTimer(RestoreClip, 0)  ; 用户要的就是刚复制的结果，不要再还原剪贴板
            if CFG.HideAfterCopy
                HidePopup()
        case "pin-on", "pin-off":
            gPinned := action = "pin-on"
            try WinSetAlwaysOnTop(gPinned, hwnd)
    }
}

; 网页已经把结果写进剪贴板：收起弹窗，切回原窗口，粘贴
DoReplace() {
    SetTimer(RestoreClip, 0)
    Sleep(60)
    HidePopup()
    if !gOrigHwnd || !WinWaitActive(gOrigHwnd, , 1.5)
        return
    Sleep(60)
    Send("^v")
    SetTimer(RestoreClip, -800)
}

UnixMs() {
    return DateDiff(A_NowUTC, "19700101000000", "Seconds") * 1000
}

; ───────────────────────── 托盘菜单 ─────────────────────────

SetupTray() {
    ; TrayIcon=0：不显示托盘图标（快捷键照常工作；重新加载 / 退出见文件开头的说明）
    A_IconHidden := !CFG.TrayIcon
    DebugLog("启动：TrayIcon=" (CFG.TrayIcon ? 1 : 0) " Url=" CFG.Url)
    A_IconTip := "lang-helper（" HotkeyText(CFG.Keys["translate"]) " 翻译 · " HotkeyText(CFG.Keys["polish"]) " 润色 · " HotkeyText(CFG.Keys["input"]) " 输入）"
    m := A_TrayMenu
    m.Delete()
    m.Add("打开弹窗", (*) => Invoke("input"))
    m.Add("编辑设置", (*) => Run('notepad.exe "' INI '"'))
    m.Add("开机自动启动", ToggleStartup)
    if FileExist(StartupLink())
        m.Check("开机自动启动")
    m.Add()
    m.Add("重新加载", (*) => Reload())
    m.Add("退出", (*) => ExitApp())
    m.Default := "打开弹窗"
}

; 提示：有托盘图标时用系统通知；图标隐藏时系统通知出不来，改成鼠标旁边的提示（6 秒后消失）
Notify(msg, icon := "Iconi") {
    if !A_IconHidden {
        TrayTip(msg, "lang-helper", icon)
        return
    }
    ToolTip("lang-helper：" msg)
    SetTimer(() => ToolTip(), -6000)
}

HotkeyText(k) {
    mods := ""
    while k != "" && InStr("^!+#", SubStr(k, 1, 1)) {
        c := SubStr(k, 1, 1)
        k := SubStr(k, 2)
        mods .= c = "^" ? "Ctrl+" : c = "!" ? "Alt+" : c = "+" ? "Shift+" : "Win+"
    }
    return mods StrUpper(k)
}

StartupLink() {
    return A_Startup "\lang-helper.lnk"
}

ToggleStartup(name, *) {
    link := StartupLink()
    if FileExist(link) {
        FileDelete(link)
        A_TrayMenu.Uncheck(name)
        return
    }
    ; 优先用不随版本变化的启动器路径（商店 / winget 安装的 AutoHotkey）
    exe := EnvGet("LOCALAPPDATA") "\Microsoft\WindowsApps\AutoHotkeyV2.exe"
    if !FileExist(exe)
        exe := A_AhkPath
    FileCreateShortcut(exe, link, A_ScriptDir, '"' A_ScriptFullPath '"', "lang-helper PC 弹窗")
    A_TrayMenu.Check(name)
}

; ───────────────────────── 自测（开发用） ─────────────────────────
; AutoHotkeyV2.exe lang-helper.ahk /selftest <ini> <log>
; 建一个临时窗口当「原文」，依次测：划词翻译 + 替换、划词润色 + 替换、没选中时交还、输入 + Esc、失焦自动收起。

SelfTest(logPath) {
    out := []
    g := Gui("+AlwaysOnTop", "lh-selftest-source")
    ed := g.AddEdit("w460 r3", "")
    g.Show("x80 y80")

    Focus() {
        WinActivate("lh-selftest-source")
        ok := WinWaitActive("lh-selftest-source", , 2)
        ed.Focus()
        return ok
    }

    SelectCase(name, text, kind, waitMs) {
        ed.Value := text
        if !Focus() {
            out.Push(name ": 源窗口没能激活，跳过")
            return
        }
        Send("^a")
        Sleep(150)
        t0 := A_TickCount
        Invoke(kind)
        popup := FindPopup()
        out.Push(name ": 弹窗=" (IsVisible(popup) ? "显示" : "没显示") " 用时=" (A_TickCount - t0) "ms")
        if popup && WinActive(popup)
            Send("{Enter}")          ; 默认不自动执行：按 Enter
        Sleep(waitMs)
        if popup && WinActive(popup) {
            Send("!v")               ; 替换原文
            Sleep(1500)
        } else {
            out.Push(name ": 弹窗不在前台，没法按 Alt+V")
        }
        out.Push(name ": 原文窗口现在是「" ed.Value "」 弹窗=" (IsVisible(FindPopup()) ? "还开着" : "已收起"))
    }

    EnsurePopup(true)
    Sleep(1500)
    SelectCase("划词翻译", "这个bug我已经修好了", "translate", 3000)
    SelectCase("划词润色", "当該ファイルにおける設定を使用する", "polish", 2500)

    ; 没选中文字：不应该弹窗
    ed.Value := "abc"
    Focus()
    Send("{End}")
    Sleep(100)
    Invoke("translate")
    Sleep(400)
    out.Push("没选中时 Alt+D: 弹窗=" (IsVisible(FindPopup()) ? "显示了（不对）" : "没显示（对）"))

    ; 模拟按住 Alt+Q 时的键盘连发：连续触发两次，弹窗应该还开着（以前会闪一下就关掉）
    Focus()
    InvokeOnce("input")
    InvokeOnce("input")
    Sleep(300)
    out.Push("连发两次 Alt+Q: 弹窗=" (IsVisible(FindPopup()) ? "还开着（对）" : "被收起了（不对）"))
    if WinActive(FindPopup())
        Send("{Esc}")
    Sleep(600)

    ; 隐藏后马上再按 Alt+Q：应该能再次弹出（以前隐藏的窗口有时仍被当作前台，导致弹不出来）
    Focus()
    Invoke("input")
    Sleep(300)
    if WinActive(FindPopup())
        Send("{Esc}")
    Sleep(500)
    WinActivate("ahk_id " FindPopup())   ; 人为制造「隐藏的弹窗仍是前台」
    Sleep(200)
    Invoke("input")
    Sleep(300)
    out.Push("隐藏后再按 Alt+Q: 弹窗=" (IsVisible(FindPopup()) ? "显示（对）" : "没显示（不对）"))
    if WinActive(FindPopup())
        Send("{Esc}")
    Sleep(600)

    ; 输入 + Esc
    Focus()
    Invoke("input")
    popup := FindPopup()
    out.Push("Alt+Q: 弹窗=" (IsVisible(popup) ? "显示" : "没显示") " 前台=" (WinActive(popup) ? "是" : "否"))
    if WinActive(popup)
        Send("{Esc}")
    Sleep(600)
    out.Push("Esc 后: 弹窗=" (IsVisible(FindPopup()) ? "还开着" : "已收起"))

    ; 失焦自动收起
    Focus()
    Invoke("input")
    Sleep(700)
    Focus()                          ; 点回原窗口
    Sleep(900)
    out.Push("失焦后: 弹窗=" (IsVisible(FindPopup()) ? "还开着" : "已自动收起"))

    ; 图钉：固定后点别处不收起，并置顶；再取消固定
    Focus()
    Invoke("input")
    popup := FindPopup()
    if WinActive(popup)
        Send("!p")
    Sleep(500)
    Focus()
    Sleep(900)
    topmost := popup && (WinGetExStyle(popup) & 0x8)
    out.Push("固定后失焦: 弹窗=" (IsVisible(popup) ? "还开着（对）" : "收起了（不对）") " 置顶=" (topmost ? "是" : "否"))
    WinActivate(popup)
    if WinWaitActive(popup, , 2)
        Send("!p")                   ; 取消固定，免得影响以后
    Sleep(500)
    out.Push("取消固定后: 置顶=" ((WinGetExStyle(popup) & 0x8) ? "是（不对）" : "否（对）"))

    if hwnd := FindPopup()
        WinClose(hwnd)
    g.Destroy()
    s := ""
    for line in out
        s .= line "`n"
    try FileDelete(logPath)
    FileAppend(s, logPath, "UTF-8")
}
