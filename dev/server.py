"""lang-helper 本地开发服务器。

- 提供 web/ 下的静态文件（MIME 类型写死，避免 Windows 注册表把 .js 当成 text/plain）
- /mock/chat/completions：模拟 DeepSeek 的流式接口，不花钱、不需要真 key，用来测界面

用法：
    python dev/server.py            # http://localhost:8787
    python dev/server.py --port 9000

在网页设置里把 Base URL 改成 http://localhost:8787/mock 、API key 随便填（至少 8 个字符），就会走模拟接口。
原文里写 #401 / #402 / #500 / #slow 可以模拟对应的错误或超时。

/__dev/mock?theme=dark&mode=ja&text=...：一键把当前地址的设置切到模拟接口（假 key），
然后带着 text 打开主页并自动执行。只在本地开发服务器上存在，不会部署。
"""

import argparse
import json
import re
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB = Path(__file__).resolve().parent.parent / "web"
DELIM = "@@NOTES@@"

# /sheet-android.html 用的假安卓壳：和 android/.../SheetActivity.java 的 Bridge 一样的接口，
# 调用记录在 window.__android 里（测试时用 JS 读出来看）
FAKE_ANDROID = """
(function () {
  var sp = new URLSearchParams(location.search);
  var log = (window.__android = []);
  window.AndroidBridge = {
    getInitial: function () {
      return JSON.stringify({
        text: sp.get('text') || '',
        readonly: sp.get('readonly') !== '0',
        source: sp.get('text') ? 'select' : 'launcher'
      });
    },
    postMessage: function (s) { log.push(['postMessage', JSON.parse(s)]); },
    copy: function (t) { log.push(['copy', t]); },
    paste: function () { log.push(['paste']); return '假剪贴板里的文字'; },
    showKeyboard: function () { log.push(['showKeyboard']); }
  };
})();
"""


def extract_original(user: str) -> str:
    m = re.search(r"【原文】\n([\s\S]*)$", user)
    return (m.group(1) if m else user).strip()


def mock_reply(system: str, user: str) -> str:
    src = extract_original(user)
    if system.startswith("你是日语写作助手"):
        out = src
        for a, b in [
            ("使用する", "使う"),
            ("させていただきます", "します"),
            ("いたしました", "しました"),
            ("いたします", "します"),
            ("における", "の"),
            ("当該", "この"),
        ]:
            out = out.replace(a, b)
        if out == src:
            out = src + "（模拟）"
        return f"{out}\n{DELIM}\n使用する → 使う：模拟要点一\nいたします → します：模拟要点二"
    if system.startswith("你是翻译助手"):
        if "【类型】词" in user:
            return (
                f"{src}（もぎ）｜名词\n释义：①模拟释义一 ②模拟释义二\n"
                f"例：これは{src}です。 —— 这是模拟例句。\n语感：模拟语感说明"
            )
        return f"【模拟译文】{src}\n{DELIM}\n模拟难词（もぎ）：模拟意思"
    if system.startswith("你是术语助手"):
        return json.dumps({"candidates": [
            {"ja": "炊飯器", "reading": "すいはんき", "zh": "电饭煲", "en": "rice cooker", "note": "模拟：最常用的说法"},
            {"ja": "電気釜", "reading": "でんきがま", "zh": "电饭锅", "en": "", "note": "模拟：稍旧的说法"},
            {"ja": "モギモギ器", "reading": "もぎもぎき", "zh": "模拟", "en": "", "note": "模拟：不存在的词，应显示未验证"},
        ]}, ensure_ascii=False)
    if system.startswith("你是英语写作助手"):
        out = src.replace("kindly ", "").replace(" until ", " by ")
        if out == src:
            out = src + " (mock)"
        return f"{out}\n{DELIM}\nkindly → （删去）：模拟要点"
    return "OK"


class Handler(SimpleHTTPRequestHandler):
    mock_delay = 0.02  # 模拟接口每段之间的间隔（秒）；/__dev/mock?delay=0 可改

    extensions_map = {
        ".html": "text/html; charset=utf-8",
        ".js": "text/javascript; charset=utf-8",
        ".mjs": "text/javascript; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".json": "application/json; charset=utf-8",
        ".webmanifest": "application/manifest+json; charset=utf-8",
        ".svg": "image/svg+xml",
        ".png": "image/png",
        ".ico": "image/x-icon",
        "": "application/octet-stream",
    }

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB), **kwargs)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def json_error(self, code: int, msg: str):
        data = json.dumps({"error": {"message": msg, "type": "mock"}}).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.startswith("/__dev/mock"):
            self.dev_mock_setup()
            return
        if self.path.startswith("/__dev/fake-android.js"):
            self.send_bytes(FAKE_ANDROID.encode("utf-8"), "text/javascript; charset=utf-8")
            return
        if self.path.startswith("/sheet-android.html"):
            # sheet.html + 假的安卓壳（window.AndroidBridge），在电脑浏览器里测安卓那条路
            html = (WEB / "sheet.html").read_text(encoding="utf-8")
            html = html.replace(
                '<script type="module" src="js/sheet.js">',
                '<script src="__dev/fake-android.js"></script>\n<script type="module" src="js/sheet.js">',
            )
            self.send_bytes(html.encode("utf-8"), "text/html; charset=utf-8")
            return
        super().do_GET()

    def send_bytes(self, data: bytes, ctype: str):
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def dev_mock_setup(self):
        from urllib.parse import parse_qs, urlencode, urlparse

        q = {k: v[0] for k, v in parse_qs(urlparse(self.path).query).items()}
        try:
            Handler.mock_delay = max(0.0, float(q.get("delay", 0.02)))
        except ValueError:
            pass
        settings = {
            "apiKey": "mock-test-key-123",
            "baseUrl": f"http://{self.headers.get('Host', '127.0.0.1')}/mock",
            "theme": q.get("theme", "dark"),
            "mode": q.get("mode", "ja"),
        }
        nxt = {k: q[k] for k in ("shell", "text", "pmode", "gap", "run", "ds", "readonly") if q.get(k)}
        path = q.get("next", "/")
        if not path.startswith("/") or path.startswith("//"):
            path = "/"
        target = path + (("?" + urlencode(nxt)) if nxt else "")
        page = (
            "<!doctype html><meta charset='utf-8'><script>"
            f"localStorage.setItem('lh.settings', JSON.stringify({json.dumps(settings)}));"
            f"location.replace({json.dumps(target)});"
            "</script>"
        ).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def do_POST(self):
        if self.path.rstrip("/") != "/mock/chat/completions":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(length) or b"{}")
        except json.JSONDecodeError:
            self.json_error(400, "bad json (mock)")
            return
        msgs = body.get("messages") or []
        system = next((m.get("content", "") for m in msgs if m.get("role") == "system"), "")
        user = msgs[-1].get("content", "") if msgs else ""
        self.log_message(
            "mock: model=%s thinking=%s stream=%s temperature=%s max_tokens=%s messages=%d",
            body.get("model"), body.get("thinking"), body.get("stream"),
            body.get("temperature"), body.get("max_tokens"), len(msgs),
        )

        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Bearer ") or len(auth) < 15 or "#401" in user:
            self.json_error(401, "Authentication Fails (mock)")
            return
        if "#402" in user:
            self.json_error(402, "Insufficient Balance (mock)")
            return
        if "#500" in user:
            self.json_error(500, "Internal error (mock)")
            return
        if "#slow" in user:
            time.sleep(12)

        text = mock_reply(system, user)
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.end_headers()
        try:
            self.wfile.write(b": keep-alive\n\n")
            for i in range(0, len(text), 3):
                chunk = {
                    "id": "mock",
                    "object": "chat.completion.chunk",
                    "choices": [{"index": 0, "delta": {"content": text[i:i + 3]}, "finish_reason": None}],
                }
                self.wfile.write(f"data: {json.dumps(chunk, ensure_ascii=False)}\n\n".encode("utf-8"))
                self.wfile.flush()
                if self.mock_delay:
                    time.sleep(self.mock_delay)
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8787)
    args = ap.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"lang-helper dev server: http://localhost:{args.port}/  (mock API: http://localhost:{args.port}/mock)", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
