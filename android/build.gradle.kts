// 安卓壳：一个透明窗口 + WebView，网页本体在 GitHub Pages 上（web/sheet.html）。
// 不在本地编译：push 到 GitHub 后由 .github/workflows/android.yml 打包 APK，发到 Releases。
plugins {
    id("com.android.application") version "8.5.2" apply false
}
