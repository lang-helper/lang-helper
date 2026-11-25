package app.langhelper;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.inputmethod.InputMethodManager;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;

/**
 * 全屏窗口 + WebView，打开 GitHub Pages 上的 sheet.html（界面全部由网页画）。
 *
 * 和网页的约定（window.AndroidBridge，见 web/js/sheet.js 开头）：
 *   getInitial()  → {"text": 选中的文字, "readonly": 能不能替换回去, "source": "select" | "launcher"}
 *   postMessage() ← {"action": "close"} 关闭；{"action": "replace", "text": ...} 把结果替换回原来的输入框
 *   copy(text) / paste() / showKeyboard()
 *   saveFile(name, text)：历史「导出」——WebView 不支持网页下载，改成系统的「另存为」
 *   历史「导入」的 <input type=file>：由下面的 WebChromeClient 打开系统的选文件
 *   返回键：先问网页（window.lhBack()，有结果时 → 回到输入），网页没处理就关闭
 */
public class SheetActivity extends Activity {

    private static final Uri HOME = Uri.parse(BuildConfig.SHEET_URL);
    /** 只允许在这个目录下跳转（sheet.html、设置页 index.html#settings 等） */
    private static final String SCOPE = HOME.getPath().substring(0, HOME.getPath().lastIndexOf('/') + 1);

    private static final int REQ_SAVE = 1;
    private static final int REQ_PICK = 2;

    private WebView web;
    private ClipboardManager clipboard;
    /** 「另存为」选好位置后要写进去的内容 */
    private String pendingSave;
    /** 网页在等选好的文件 */
    private ValueCallback<Uri[]> fileCallback;
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
        web.setWebChromeClient(new Chrome());
        setContentView(web);
        trusted = true; // 第一页就是我们自己的网页；之后每次跳转都会重新判断
        web.loadUrl(startUrl());
    }

    /** 打开哪一页。WikiActivity（「维基速查」图标）改成 wiki.html */
    protected String startUrl() {
        return BuildConfig.SHEET_URL;
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
    @SuppressWarnings("deprecation")
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK) {
            if (fileCallback != null) {
                Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
                fileCallback.onReceiveValue(uri == null ? null : new Uri[] { uri });
                fileCallback = null;
            }
            return;
        }
        if (requestCode == REQ_SAVE) {
            String text = pendingSave;
            pendingSave = null;
            Uri uri = resultCode == RESULT_OK && data != null ? data.getData() : null;
            if (uri == null || text == null) return; // 取消了
            try (OutputStream os = getContentResolver().openOutputStream(uri, "w")) {
                if (os == null) throw new java.io.IOException("no stream");
                os.write(text.getBytes(StandardCharsets.UTF_8));
                Toast.makeText(this, R.string.saved, Toast.LENGTH_SHORT).show();
            } catch (Exception e) {
                Toast.makeText(this, R.string.save_failed, Toast.LENGTH_LONG).show();
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
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

    /** 网页里的 <input type=file>（历史「导入」）：打开系统的选文件 */
    private final class Chrome extends WebChromeClient {
        @Override
        @SuppressWarnings("deprecation")
        public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
            if (!trusted) return false;
            if (fileCallback != null) fileCallback.onReceiveValue(null); // 上一次没选完的就当取消
            fileCallback = callback;
            // 不用网页给的类型（.json 在很多文件管理器里不算 application/json），什么文件都能选，由网页自己检查内容
            Intent pick = new Intent(Intent.ACTION_GET_CONTENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*");
            try {
                startActivityForResult(pick, REQ_PICK);
                return true;
            } catch (Exception e) {
                fileCallback = null;
                return false;
            }
        }
    }

    /** 网页里的 window.AndroidBridge。这些方法在后台线程上被调用。 */
    final class Bridge {
        @JavascriptInterface
        @SuppressWarnings("deprecation")
        public void saveFile(String name, String text) {
            if (!trusted || text == null) return;
            runOnUiThread(() -> {
                pendingSave = text;
                Intent save = new Intent(Intent.ACTION_CREATE_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType("application/json")
                        .putExtra(Intent.EXTRA_TITLE, name == null || name.isEmpty() ? "lang-helper.json" : name);
                try {
                    startActivityForResult(save, REQ_SAVE);
                } catch (Exception e) {
                    pendingSave = null;
                    Toast.makeText(SheetActivity.this, R.string.save_failed, Toast.LENGTH_LONG).show();
                }
            });
        }

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
