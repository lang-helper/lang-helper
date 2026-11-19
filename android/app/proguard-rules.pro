# 网页通过 window.AndroidBridge 调用这些方法，不能被混淆或删掉
-keepclassmembers class app.langhelper.SheetActivity$Bridge {
    @android.webkit.JavascriptInterface <methods>;
}
