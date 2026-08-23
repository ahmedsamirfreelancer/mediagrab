package com.arqami.mediagrab;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

/**
 * The "pop-up": a full-screen WebView that loads the real platform page
 * (TikTok/Instagram/…) with a mobile user-agent and persistent cookies, and
 * injects download buttons. Tapping one calls back to the native engine via the
 * MGNative JavaScript bridge — nothing is rendered inside the app itself.
 */
public class EmbeddedBrowserActivity extends Activity {

    private WebView web;
    private static final String MOBILE_UA =
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) "
        + "Chrome/126.0.0.0 Mobile Safari/537.36";

    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        String url = getIntent().getStringExtra("url");
        if (url == null || url.isEmpty()) url = "https://www.tiktok.com";

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        LinearLayout bar = new LinearLayout(this);
        bar.setOrientation(LinearLayout.HORIZONTAL);
        bar.setBackgroundColor(Color.parseColor("#15131f"));
        bar.setPadding(24, 18, 24, 18);
        bar.setGravity(Gravity.CENTER_VERTICAL);

        Button close = new Button(this);
        close.setText("✕ إغلاق");
        close.setOnClickListener(v -> finish());

        TextView title = new TextView(this);
        title.setText("  MediaGrab");
        title.setTextColor(Color.WHITE);

        bar.addView(close);
        bar.addView(title);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUserAgentString(MOBILE_UA);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(web, true);

        web.addJavascriptInterface(new Bridge(), "MGNative");
        web.setWebChromeClient(new WebChromeClient());
        web.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String u) {
                view.evaluateJavascript(INJECT, null);
            }
        });

        root.addView(bar, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        root.addView(web, new LinearLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f));
        setContentView(root);

        web.loadUrl(url);
    }

    @Override
    public void onBackPressed() {
        if (web != null && web.canGoBack()) web.goBack();
        else super.onBackPressed();
    }

    private class Bridge {
        @JavascriptInterface
        public void download(String url, String title) {
            DownloaderPlugin.enqueueFromBrowser(url, title);
            runOnUiThread(() -> Toast.makeText(EmbeddedBrowserActivity.this,
                "بدأ التحميل…", Toast.LENGTH_SHORT).show());
        }
    }

    // Injected on every page load: a floating "download current" button plus
    // per-video-link buttons. Buttons pass the page/permalink URL to yt-dlp,
    // which resolves and downloads it — no CDN-URL scraping needed.
    private static final String INJECT =
        "(function(){"
        + "if(window.__mgInjected)return;window.__mgInjected=true;"
        + "function dl(u,t){try{MGNative.download(u,t||document.title);}catch(e){}}"
        + "var b=document.createElement('div');"
        + "b.textContent='\\u2B07 \\u062A\\u062D\\u0645\\u064A\\u0644 \\u0627\\u0644\\u0641\\u064A\\u062F\\u064A\\u0648 \\u0627\\u0644\\u062D\\u0627\\u0644\\u064A';"
        + "b.style.cssText='position:fixed;left:50%;transform:translateX(-50%);bottom:20px;z-index:2147483647;background:#7c3aed;color:#fff;padding:14px 22px;border-radius:30px;font:600 16px sans-serif;box-shadow:0 4px 16px rgba(0,0,0,.45);';"
        + "b.onclick=function(){dl(location.href,document.title);};"
        + "document.body.appendChild(b);"
        + "function add(){var as=document.querySelectorAll('a[href]');for(var i=0;i<as.length;i++){var a=as[i];if(a.__mg)continue;var h=a.href||'';if(/\\/video\\/|\\/reel\\/|\\/reels\\/|\\/p\\/|\\/pin\\/|watch\\?v=|\\/watch\\//.test(h)){a.__mg=1;var x=document.createElement('button');x.textContent='\\u2B07';x.style.cssText='position:absolute;top:6px;right:6px;z-index:2147483647;background:#7c3aed;color:#fff;border:none;border-radius:50%;width:34px;height:34px;font-size:15px;cursor:pointer;';(function(href,lbl){x.onclick=function(e){e.preventDefault();e.stopPropagation();dl(href,lbl);return false;};})(h,a.textContent);try{a.style.position='relative';a.appendChild(x);}catch(e){}}}}"
        + "add();setInterval(add,1500);"
        + "})();";
}
