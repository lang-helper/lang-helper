package app.langhelper;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * 全屏窗口 + WebView，打开 GitHub Pages 上的 sheet.html（界面全部由网页画）。
 *
 * 和网页的约定（window.AndroidBridge，见 web/js/sheet.js 开头）：
 *   getInitial()  → {"text": 选中的文字, "readonly": 能不能替换回去, "source": "select" | "launcher"}
 *   postMessage() ← {"action": "close"} 关闭；{"action": "replace", "text": ...} 把结果替换回原来的输入框
 *   copy(text) / paste() / showKeyboard()
 *   返回键：先问网页（window.lhBack()，结果页 → 选择页），网页没处理就关闭
 */
public class SheetActivity extends Activity {

    private static final Uri HOME = Uri.parse(BuildConfig.SHEET_URL);
    /** 只允许在这个目录下跳转（sheet.html、设置页 index.html#settings 等） */
    private static final String SCOPE = HOME.getPath().substring(0, HOME.getPath().lastIndexOf('/') + 1);

    private WebView web;
    private ClipboardManager clipboard;
    private String initial = "{}";
    /** 当前页面是不是我们自己的网页（AndroidBridge 只给自己的网页用） */
    private volatile boolean trusted = false;
    private boolean done = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        clipboard = getSystemService(ClipboardManager.class);
        initial = buildInitial(getIntent());

        web = new WebView(this);
        web.setBackgroundColor(getColor(R.color.sheet_bg)); // 加载完之前也是深灰，不闪白
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true); // localStorage（设置、API key）
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setSupportZoom(false);
        s.setTextZoom(100); // 卡片高度是固定的，不跟着系统字体大小缩放
        s.setMediaPlaybackRequiresUserGesture(true);
        web.addJavascriptInterface(new Bridge(), "AndroidBridge");
        web.setWebViewClient(new Client());
        setContentView(web);
        trusted = true; // 第一页就是我们自己的网页；之后每次跳转都会重新判断
        web.loadUrl(BuildConfig.SHEET_URL);
    }

    /** 选中文字进来的：带着文字；能不能「替换」要看来源 App 是不是在等结果、文字是不是只读 */
    private String buildInitial(Intent intent) {
        boolean fromSelect = intent != null && Intent.ACTION_PROCESS_TEXT.equals(intent.getAction());
        CharSequence text = fromSelect ? intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT) : null;
        boolean readonly = !fromSelect
                || intent.getBooleanExtra(Intent.EXTRA_PROCESS_TEXT_READONLY, false)
                || getCallingActivity() == null;
        JSONObject o = new JSONObject();
        try {
            o.put("text", text == null ? "" : text.toString());
            o.put("readonly", readonly);
            o.put("source", fromSelect ? "select" : "launcher");
        } catch (JSONException ignored) {
            // 不会发生
        }
        return o.toString();
    }

    private static boolean isOurs(Uri uri) {
        return uri != null
                && "https".equals(uri.getScheme())
                && HOME.getHost().equals(uri.getHost())
                && uri.getPath() != null
                && uri.getPath().startsWith(SCOPE);
    }

    private void close(Intent result) {
        if (done) return;
        done = true;
        if (result != null) setResult(RESULT_OK, result);
        finish();
    }

    private void handleMessage(String json) {
        try {
            JSONObject m = new JSONObject(json);
            String action = m.optString("action");
            if ("close".equals(action)) {
                close(null);
            } else if ("replace".equals(action)) {
                Intent r = new Intent();
                r.putExtra(Intent.EXTRA_PROCESS_TEXT, m.optString("text"));
                close(r);
            }
        } catch (JSONException ignored) {
            // 忽略格式不对的消息
        }
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("window.lhBack ? window.lhBack() : ''", value -> {
            if (!"\"handled\"".equals(value)) close(null);
        });
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.removeJavascriptInterface("AndroidBridge");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    private void openExternally(Uri uri) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (Exception ignored) {
            // 没有能打开的 App
        }
    }

    private void failAndClose() {
        if (done) return;
        Toast.makeText(this, R.string.offline, Toast.LENGTH_LONG).show();
        close(null);
    }

    private final class Client extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            Uri uri = request.getUrl();
            if (isOurs(uri)) return false;
            openExternally(uri); // 外部链接（如 DeepSeek 控制台）用浏览器打开
            return true;
        }

        @Override
        public void doUpdateVisitedHistory(WebView view, String url, boolean isReload) {
            trusted = isOurs(Uri.parse(url));
        }

        @Override
        public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
            trusted = isOurs(Uri.parse(url));
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (request.isForMainFrame()) failAndClose();
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (request.isForMainFrame() && response.getStatusCode() >= 500) failAndClose();
        }
    }

    /** 网页里的 window.AndroidBridge。这些方法在后台线程上被调用。 */
    final class Bridge {
        @JavascriptInterface
        public String getInitial() {
            return trusted ? initial : "{}";
        }

        @JavascriptInterface
        public void postMessage(String json) {
            if (!trusted || json == null) return;
            runOnUiThread(() -> handleMessage(json));
        }

        @JavascriptInterface
        public void copy(String text) {
            if (!trusted || text == null) return;
            runOnUiThread(() -> clipboard.setPrimaryClip(ClipData.newPlainText("lang-helper", text)));
        }

        @JavascriptInterface
        public String paste() {
            if (!trusted) return "";
            try {
                ClipData clip = clipboard.getPrimaryClip();
                if (clip == null || clip.getItemCount() == 0) return "";
                CharSequence t = clip.getItemAt(0).coerceToText(SheetActivity.this);
                return t == null ? "" : t.toString();
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void showKeyboard() {
            if (!trusted) return;
            runOnUiThread(() -> {
                if (web == null) return;
                web.requestFocus();
                InputMethodManager imm = getSystemService(InputMethodManager.class);
                if (imm != null) imm.showSoftInput(web, InputMethodManager.SHOW_IMPLICIT);
            });
        }
    }
}
