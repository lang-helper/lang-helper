package app.langhelper;

/**
 * 「Wiki」（wiki 速查）：桌面上单独的图标，和 lang-helper 分开显示（最近任务里也是单独一项）。
 * 和 SheetActivity 一样的全屏 WebView 和 AndroidBridge，只是打开 wiki.html：
 * 输入一个词 → 中 / 日 / 英维基百科里对应的条目，摘要秒切，全文默认不加载图片。
 * 选中文字后菜单里的「Wiki」也进这里（getInitial() 给文字）。
 */
public class WikiActivity extends SheetActivity {

    @Override
    protected String startUrl() {
        String sheet = BuildConfig.SHEET_URL;
        return sheet.substring(0, sheet.lastIndexOf('/') + 1) + "wiki.html";
    }
}
