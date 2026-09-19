package ai.deepseek.dshpad;

import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.Menu;
import android.view.MenuItem;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

/**
 * Full-screen WebView wrapper around the DeepSeek Harness Web GUI.
 *
 * <p>DSH authenticates the browser surface with a per-process launch token: the first
 * {@code GET /?token=...} mints a signed, authority-bound cookie and redirects to clean
 * {@code /}. This activity performs that exchange once, then relies on the WebView cookie
 * store for the rest of the session.
 *
 * <p>It also owns the host half of the page's file picker. The composer's attach control is
 * a hidden {@code <input type="file" multiple>}, and a WebView will not open a chooser for
 * it on its own: {@code onShowFileChooser} must launch a picker and hand the result back.
 * Without that override the attach button is silently inert — no error, no dialog, nothing.
 */
public class MainActivity extends Activity {

    private WebView webView;
    private ProgressBar progress;
    private TextView banner;

    /** Server + token pair currently loaded, so onResume can detect a settings change. */
    private String loadedKey = "";

    /**
     * The page's pending file-picker callback, or null.
     *
     * <p>Exactly one may be outstanding: the WebView accepts one live callback per chooser,
     * and it must be answered — with {@code null} when the user cancels — or the page's next
     * file input never resolves.
     */
    private ValueCallback<Uri[]> filePathCallback;

    /** Request code for the file chooser. */
    private static final int REQUEST_FILE_CHOOSER = 43;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progress = findViewById(R.id.progress);
        banner = findViewById(R.id.banner);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);

        CookieManager cm = CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setProgress(newProgress);
                progress.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                            FileChooserParams params) {
                return launchFileChooser(callback, params);
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request,
                                            WebResourceResponse response) {
                if (response != null && response.getStatusCode() == 401) {
                    showAuthBanner();
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // Keep every navigation, including the token-exchange redirect, inside the WebView.
                return false;
            }
        });

        banner.setOnClickListener(v -> openSettings());

        if (!Prefs.isConfigured(this)) {
            openSettings();
        } else {
            load();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (!Prefs.isConfigured(this)) return;
        String key = Prefs.server(this) + "|" + Prefs.token(this);
        if (!key.equals(loadedKey)) {
            banner.setVisibility(View.GONE);
            load();
        }
    }

    // ── the host half of the page's file picker ──────────────────────────────

    /**
     * Launch a system picker for the page's {@code <input type="file">}.
     *
     * <p>{@link WebChromeClient.FileChooserParams#createIntent()} is used rather than a
     * hand-built intent so the page's own {@code accept} / {@code multiple} / {@code capture}
     * declarations decide the picker. (Today's composer input declares only {@code multiple},
     * so the picker opens unfiltered and will offer the camera app along with file sources.)
     *
     * <p>SAF grants access per URI, so this needs <em>no</em> storage permission — which is
     * what keeps "minimal permissions" intact.
     *
     * @param callback - the page's pending callback; must be answered exactly once.
     * @param params - the page's chooser parameters.
     * @returns whether this activity took ownership of the request.
     */
    private boolean launchFileChooser(ValueCallback<Uri[]> callback, WebChromeClient.FileChooserParams params) {
        // Only one chooser may be outstanding. Answer a stale one with null so the page
        // is never left waiting.
        if (filePathCallback != null) {
            filePathCallback.onReceiveValue(null);
            filePathCallback = null;
        }
        filePathCallback = callback;

        Intent intent = null;
        try {
            intent = params.createIntent();
        } catch (Throwable t) {
            // A malformed accept list can make the framework throw; fall through to the
            // generic picker rather than leaving the page stuck.
        }
        if (intent == null) {
            intent = new Intent(Intent.ACTION_GET_CONTENT)
                    .addCategory(Intent.CATEGORY_OPENABLE)
                    .setType("*/*")
                    .putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        }

        try {
            startActivityForResult(intent, REQUEST_FILE_CHOOSER);
            return true;
        } catch (ActivityNotFoundException | SecurityException e) {
            // No picker on this device: release the callback so the page can try again.
            filePathCallback = null;
            callback.onReceiveValue(null);
            Toast.makeText(this, R.string.no_file_picker, Toast.LENGTH_LONG).show();
            return false;
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE_CHOOSER) {
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                // Handles both shapes a picker may return: a single data URI, and a
                // multi-select ClipData.
                result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
            }
            // `null` on cancel is mandatory — without it the page's next file input hangs.
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(result);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onDestroy() {
        // Never leave the page holding an unanswered callback.
        if (filePathCallback != null) {
            try {
                filePathCallback.onReceiveValue(null);
            } catch (Throwable ignored) {
                // The WebView may already be gone; nothing to answer to.
            }
            filePathCallback = null;
        }
        super.onDestroy();
    }

    /** Build the authenticated root URL carrying this process's launch token. */
    private String targetUrl() {
        String authority = Prefs.normalizeServer(Prefs.server(this));
        return "http://" + authority + "/?token=" + Uri.encode(Prefs.token(this));
    }

    private void load() {
        loadedKey = Prefs.server(this) + "|" + Prefs.token(this);
        banner.setVisibility(View.GONE);
        progress.setVisibility(View.VISIBLE);
        webView.loadUrl(targetUrl());
    }

    private void showAuthBanner() {
        runOnUiThread(() -> {
            banner.setText(R.string.auth_failed);
            banner.setVisibility(View.VISIBLE);
        });
    }

    private void openSettings() {
        startActivity(new Intent(this, SettingsActivity.class));
    }

    @Override
    public boolean onCreateOptionsMenu(Menu menu) {
        getMenuInflater().inflate(R.menu.main, menu);
        return true;
    }

    @Override
    public boolean onOptionsItemSelected(MenuItem item) {
        int id = item.getItemId();
        if (id == R.id.action_settings) {
            openSettings();
            return true;
        }
        if (id == R.id.action_reload) {
            banner.setVisibility(View.GONE);
            load();
            return true;
        }
        return super.onOptionsItemSelected(item);
    }

    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        // Persist the DSH auth cookie so the session survives an app restart.
        CookieManager.getInstance().flush();
    }
}
