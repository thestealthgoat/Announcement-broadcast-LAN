package org.networksignage.kiosk;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.DialogInterface;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.provider.Settings;
import android.util.Log;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.webkit.CookieManager;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;
import android.widget.Toast;

import org.networksignage.kiosk.logic.DiscoveredServer;
import org.networksignage.kiosk.logic.KeyHoldTracker;
import org.networksignage.kiosk.logic.NavigationPolicy;
import org.networksignage.kiosk.logic.RetryBackoff;
import org.networksignage.kiosk.logic.ServerAddress;
import org.networksignage.kiosk.logic.ServerPicker;

import java.util.ArrayList;
import java.util.List;

/**
 * A fullscreen WebView showing the player, plus the native screens around it. This has been
 * compiled and unit tested, but has not yet run on any device or emulator.
 */
public class KioskActivity extends Activity implements ServerDiscovery.Listener {
    private static final String TAG = "SignageKiosk";

    private static final long LOAD_TIMEOUT_MS = 20000;
    private static final long REDISCOVER_EVERY_MS = 30000;
    private static final long CRASH_MEMORY_MS = 5 * 60 * 1000;
    private static final long MENU_TIMEOUT_MS = 30000;

    private enum Mode {
        /** Choosing a server. The WebView is on about:blank. */
        SETUP,
        /** Waiting for the server to answer a load. */
        CONNECTING,
        /** The last load failed, and the next try is scheduled. */
        RETRYING,
        /** The player page is up. From here on, it handles server outages itself. */
        PLAYING
    }

    private final Handler handler = new Handler(Looper.getMainLooper());
    private final RetryBackoff retryBackoff = new RetryBackoff(2000, 30000);
    private final RetryBackoff crashBackoff = new RetryBackoff(1000, 30000);
    private final KeyHoldTracker keys = new KeyHoldTracker();

    private ServerStore store;
    private ServerDiscovery discovery;
    private ServerAddress server;
    private Mode mode = Mode.SETUP;
    private boolean tryCancelledByStop;
    private long lastDiscoveryRestart;
    private long lastCrashAt;
    private List<DiscoveredServer> listedServers = new ArrayList<>();
    private String setupInitialText = "";
    private AlertDialog menu;

    private FrameLayout webContainer;
    private WebView webView;
    private View statusScreen;
    private TextView statusTitle;
    private TextView statusAddress;
    private View statusChangeServer;
    private View setupScreen;
    private TextView setupStatus;
    private LinearLayout setupServers;
    private EditText setupAddress;
    private TextView setupError;
    private Button setupCancel;
    private View setupBoot;
    private TextView setupBootNote;

    private final Runnable retry = this::loadPlayer;
    private final Runnable loadTimeout = () -> {
        webView.stopLoading();
        onLoadFailed("timed out");
    };
    private final Runnable holdElapsed = () -> act(keys.onHoldElapsed());

    // ---------- lifecycle ----------

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        setContentView(R.layout.activity_kiosk);
        bindViews();
        store = new ServerStore(this);
        discovery = new ServerDiscovery(this, this);
        server = store.address();
        createWebView();
        if (server == null) {
            showSetup();
        } else {
            loadPlayer();
        }
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (mode == Mode.SETUP) {
            discovery.start();
        } else if (tryCancelledByStop) {
            loadPlayer();
        }
        tryCancelledByStop = false;
    }

    @Override
    protected void onResume() {
        super.onResume();
        enterImmersive();
        if (webView != null) {
            webView.onResume();
            webView.resumeTimers();
        }
        refreshBootOption();
    }

    @Override
    protected void onPause() {
        super.onPause();
        keys.reset();
        handler.removeCallbacks(holdElapsed);
        if (webView != null) {
            webView.onPause();
            webView.pauseTimers();
        }
        CookieManager.getInstance().flush();
    }

    @Override
    protected void onStop() {
        super.onStop();
        tryCancelledByStop = mode == Mode.CONNECTING || mode == Mode.RETRYING;
        handler.removeCallbacks(retry);
        handler.removeCallbacks(loadTimeout);
        discovery.stop();
    }

    @Override
    protected void onDestroy() {
        handler.removeCallbacksAndMessages(null);
        discovery.stop();
        if (menu != null) menu.dismiss();
        destroyWebView();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) enterImmersive();
    }

    @SuppressWarnings("deprecation") // The flags still work, and the replacement needs API 30.
    private void enterImmersive() {
        getWindow().getDecorView().setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION);
    }

    private void bindViews() {
        webContainer = findViewById(R.id.web_container);
        statusScreen = findViewById(R.id.status_screen);
        statusTitle = findViewById(R.id.status_title);
        statusAddress = findViewById(R.id.status_address);
        statusChangeServer = findViewById(R.id.status_change_server);
        setupScreen = findViewById(R.id.setup_screen);
        setupStatus = findViewById(R.id.setup_status);
        setupServers = findViewById(R.id.setup_servers);
        setupAddress = findViewById(R.id.setup_address);
        setupError = findViewById(R.id.setup_error);
        setupCancel = findViewById(R.id.setup_cancel);
        setupBoot = findViewById(R.id.setup_boot);
        setupBootNote = findViewById(R.id.setup_boot_note);

        statusChangeServer.setOnClickListener(v -> showSetup());
        findViewById(R.id.setup_connect).setOnClickListener(v -> connectToTypedAddress());
        setupCancel.setOnClickListener(v -> leaveSetup());
        findViewById(R.id.setup_boot_button).setOnClickListener(v -> openBootPermission());
        setupAddress.setOnEditorActionListener((v, actionId, event) -> {
            if (actionId != EditorInfo.IME_ACTION_GO) return false;
            connectToTypedAddress();
            return true;
        });
    }

    // ---------- WebView ----------

    /*
     * Deliberately not done here:
     * - No addJavascriptInterface. The page has no bridge to the app.
     * - WebChromeClient doesn't override onShowCustomView. WebView reports the fullscreen API
     *   as unsupported in that case, so the player's goFullscreen() on keydown does nothing.
     *   The window is already fullscreen.
     */
    @SuppressLint("SetJavaScriptEnabled") // The player needs it. The main frame is locked to the server.
    @SuppressWarnings("deprecation") // Deprecated settings are still set, for older WebViews.
    private void createWebView() {
        WebView view = new WebView(this);
        view.setBackgroundColor(Color.BLACK);
        view.setOverScrollMode(View.OVER_SCROLL_NEVER);
        view.setVerticalScrollBarEnabled(false);
        view.setHorizontalScrollBarEnabled(false);
        view.setFocusable(true);
        view.setFocusableInTouchMode(true);
        view.setVisibility(View.INVISIBLE);

        WebSettings settings = view.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true); // The player's device ID and last state.
        settings.setDatabaseEnabled(true);   // Along with IndexedDB, which is its media cache.
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);
        settings.setGeolocationEnabled(false);
        settings.setSupportZoom(false);
        settings.setTextZoom(100);
        settings.setUserAgentString(settings.getUserAgentString()
            + " NetworkSignageKiosk/" + BuildConfig.VERSION_NAME);

        // Web slides are iframes on other origins, and many of them need their own cookies.
        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, true);

        view.setWebViewClient(new KioskWebClient());
        view.setWebChromeClient(new KioskChromeClient());
        webContainer.addView(view, new FrameLayout.LayoutParams(
            FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        webView = view;
    }

    private void destroyWebView() {
        if (webView == null) return;
        webContainer.removeView(webView);
        webView.destroy();
        webView = null;
    }

    private final class KioskWebClient extends WebViewClient {
        @Override
        public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
            boolean allowed = NavigationPolicy.allow(server, request.getUrl().toString(), request.isForMainFrame());
            if (!allowed) Log.w(TAG, "Blocked a main-frame navigation off the server");
            return !allowed;
        }

        // A backstop for navigations that skip the check above, such as a form POST.
        @Override
        public void onPageStarted(WebView view, String url, Bitmap favicon) {
            if (mode == Mode.SETUP || view != webView || url == null || url.startsWith("about:")) return;
            if (!NavigationPolicy.allow(server, url, true)) {
                view.stopLoading();
                onLoadFailed("left the server");
            }
        }

        // Not onPageFinished alone: the player can start preloading a slow web slide before its
        // load event, so that would be late. This one means the server has answered.
        @Override
        public void onPageCommitVisible(WebView view, String url) {
            onPageUp(view, url);
        }

        @Override
        public void onPageFinished(WebView view, String url) {
            onPageUp(view, url);
        }

        @Override
        public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
            if (isFatalToPlayer(request)) onLoadFailed("error " + error.getErrorCode());
        }

        @Override
        public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse response) {
            if (isFatalToPlayer(request)) onLoadFailed("HTTP " + response.getStatusCode());
        }

        // Never proceeds. A certificate problem on the server is a failed load. On a slide, the
        // slide just doesn't show.
        @Override
        public void onReceivedSslError(WebView view, SslErrorHandler sslHandler, SslError error) {
            sslHandler.cancel();
            if (NavigationPolicy.isSameOrigin(server, error.getUrl())) onLoadFailed("certificate");
        }

        // Called only on API 26+. Returning true keeps the app alive when the renderer dies.
        @Override
        public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
            Log.w(TAG, "The WebView renderer went away");
            if (view != webView) return true;
            recoverFromRendererLoss();
            return true;
        }

        private boolean isFatalToPlayer(WebResourceRequest request) {
            // Failures in web slides and media are the player's to handle, not ours.
            return request.isForMainFrame()
                || NavigationPolicy.isPlayerShell(server, request.getUrl().toString());
        }
    }

    private static final class KioskChromeClient extends WebChromeClient {
        // Without this, video shows WebView's grey play icon while it loads.
        @Override
        public Bitmap getDefaultVideoPoster() {
            Bitmap poster = Bitmap.createBitmap(1, 1, Bitmap.Config.ARGB_8888);
            poster.eraseColor(Color.TRANSPARENT);
            return poster;
        }
    }

    // ---------- connecting and retrying ----------

    private void loadPlayer() {
        handler.removeCallbacks(retry);
        handler.removeCallbacks(loadTimeout);
        if (server == null) {
            showSetup();
            return;
        }
        // Across retries the "trying to reach" screen just stays up.
        if (mode != Mode.RETRYING) showStatus(R.string.connecting_title);
        mode = Mode.CONNECTING;
        handler.postDelayed(loadTimeout, LOAD_TIMEOUT_MS);
        webView.loadUrl(server.playerUrl());
    }

    private void onPageUp(WebView view, String url) {
        if (mode != Mode.CONNECTING || view != webView || !NavigationPolicy.isSameOrigin(server, url)) return;
        handler.removeCallbacks(loadTimeout);
        discovery.stop();
        retryBackoff.reset();
        mode = Mode.PLAYING;
        statusScreen.setVisibility(View.GONE);
        setupScreen.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.requestFocus();
    }

    private void onLoadFailed(String why) {
        if (mode == Mode.SETUP || mode == Mode.RETRYING) return;
        Log.w(TAG, "Load failed: " + why);
        enterRetrying(retryBackoff.next());
    }

    private void enterRetrying(long delayMs) {
        handler.removeCallbacks(loadTimeout);
        handler.removeCallbacks(retry);
        mode = Mode.RETRYING;
        showStatus(R.string.retry_title);
        handler.postDelayed(retry, delayMs);
        rediscover();
    }

    /** Looks for the remembered service, in case the host's address changed. */
    private void rediscover() {
        if (store.serviceName() == null) return;
        long now = SystemClock.elapsedRealtime();
        if (!discovery.isRunning()) {
            lastDiscoveryRestart = now;
            discovery.start();
        } else if (now - lastDiscoveryRestart >= REDISCOVER_EVERY_MS) {
            lastDiscoveryRestart = now;
            discovery.restart();
        }
    }

    private void recoverFromRendererLoss() {
        // The dead WebView can't be reused. Backs off so a slide that always crashes it can't spin.
        long now = SystemClock.elapsedRealtime();
        if (now - lastCrashAt > CRASH_MEMORY_MS) crashBackoff.reset();
        lastCrashAt = now;
        destroyWebView();
        createWebView();
        if (mode != Mode.SETUP) enterRetrying(crashBackoff.next());
    }

    private void showStatus(int titleRes) {
        setupScreen.setVisibility(View.GONE);
        webView.setVisibility(View.INVISIBLE);
        statusTitle.setText(titleRes);
        statusAddress.setText(server == null ? "" : server.display());
        statusScreen.setVisibility(View.VISIBLE);
        statusChangeServer.requestFocus();
    }

    // ---------- discovery results ----------

    @Override
    public void onServersChanged(List<DiscoveredServer> servers) {
        if (mode == Mode.SETUP) {
            listServers(servers);
        } else if (mode == Mode.CONNECTING || mode == Mode.RETRYING) {
            ServerAddress moved = ServerPicker.followSaved(store.serviceName(), server, servers);
            if (moved != null) {
                Log.i(TAG, "The server has moved to " + moved);
                server = moved;
                store.save(moved, store.serviceName());
                mode = Mode.RETRYING; // Keeps the same screen, showing the new address.
                showStatus(R.string.retry_title);
                loadPlayer();
            }
        }
    }

    @Override
    public void onDiscoveryFailed() {
        if (mode == Mode.SETUP) setupStatus.setText(R.string.setup_search_failed);
    }

    // ---------- setup screen ----------

    private void showSetup() {
        handler.removeCallbacks(retry);
        handler.removeCallbacks(loadTimeout);
        mode = Mode.SETUP;
        webView.stopLoading();
        webView.loadUrl("about:blank"); // Stops the player, including any sound.
        webView.setVisibility(View.INVISIBLE);
        statusScreen.setVisibility(View.GONE);
        setupScreen.setVisibility(View.VISIBLE);
        setupError.setVisibility(View.GONE);
        setupCancel.setVisibility(server == null ? View.GONE : View.VISIBLE);
        setupInitialText = server == null ? "" : server.display();
        setupAddress.setText(setupInitialText);
        setupStatus.setText(R.string.setup_searching);
        refreshBootOption();
        listedServers = new ArrayList<>();
        setupServers.removeAllViews();
        setupAddress.requestFocus();
        lastDiscoveryRestart = SystemClock.elapsedRealtime();
        discovery.restart();
    }

    private void listServers(List<DiscoveredServer> servers) {
        if (servers.equals(listedServers)) return;
        View focused = getCurrentFocus();
        boolean listHadFocus = focused != null && focused.getParent() == setupServers;
        String focusedName = listHadFocus ? (String) focused.getTag() : null;
        listedServers = new ArrayList<>(servers);
        setupServers.removeAllViews();
        Button toFocus = null;
        for (DiscoveredServer item : servers) {
            Button button = new Button(this, null, 0, R.style.KioskButton);
            button.setLayoutParams(new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT));
            ((LinearLayout.LayoutParams) button.getLayoutParams()).topMargin =
                Math.round(10 * getResources().getDisplayMetrics().density);
            button.setText(item.label());
            button.setTag(item.name);
            button.setOnClickListener(v -> chooseServer(item.address(), item.name));
            setupServers.addView(button);
            if (toFocus == null || item.name.equals(focusedName)) toFocus = button;
        }
        setupStatus.setText(servers.isEmpty() ? R.string.setup_searching : R.string.setup_found);
        // Removing a focused button drops focus, so put it somewhere the remote can reach. Don't
        // take it from a person who has started typing in the address box.
        boolean typing = !setupInitialText.contentEquals(setupAddress.getText());
        View now = getCurrentFocus();
        if (listHadFocus || now == null || (now == setupAddress && !typing)) {
            if (toFocus != null) {
                toFocus.requestFocus();
            } else {
                setupAddress.requestFocus();
            }
        }
    }

    private void connectToTypedAddress() {
        ServerAddress typed = ServerAddress.parse(setupAddress.getText().toString());
        if (typed == null) {
            setupError.setText(R.string.setup_address_invalid);
            setupError.setVisibility(View.VISIBLE);
            return;
        }
        String name = ServerPicker.nameAt(typed, discovery.servers());
        // Retyping the same address shouldn't forget which service it is.
        if (name == null && typed.equals(server)) name = store.serviceName();
        chooseServer(typed, name);
    }

    private void chooseServer(ServerAddress address, String serviceName) {
        server = address;
        store.save(address, serviceName);
        leaveSetup();
    }

    /** Goes back to the player, with whichever server is now remembered. */
    private void leaveSetup() {
        InputMethodManager input = (InputMethodManager) getSystemService(INPUT_METHOD_SERVICE);
        if (input != null) input.hideSoftInputFromWindow(setupAddress.getWindowToken(), 0);
        discovery.stop();
        retryBackoff.reset();
        setupScreen.setVisibility(View.GONE);
        mode = Mode.CONNECTING;
        loadPlayer();
    }

    // ---------- starting after power-on (optional, see BootReceiver) ----------

    private void refreshBootOption() {
        boolean useful = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !Settings.canDrawOverlays(this);
        setupBoot.setVisibility(useful ? View.VISIBLE : View.GONE);
    }

    /** Only ever from the person pressing the button. It opens the system's own screen. */
    private void openBootPermission() {
        Intent intent = new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
            Uri.parse("package:" + getPackageName()));
        try {
            startActivity(intent);
        } catch (ActivityNotFoundException e) {
            setupBootNote.setText(R.string.setup_boot_unavailable);
        }
    }

    // ---------- Back and Menu ----------

    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        if (code != KeyEvent.KEYCODE_BACK && code != KeyEvent.KEYCODE_MENU) {
            return super.dispatchKeyEvent(event);
        }
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            if (event.getRepeatCount() == 0) {
                keys.onDown(code);
                handler.removeCallbacks(holdElapsed);
                handler.postDelayed(holdElapsed, KeyHoldTracker.HOLD_MS);
            }
        } else if (event.getAction() == KeyEvent.ACTION_UP) {
            handler.removeCallbacks(holdElapsed);
            if (event.isCanceled()) {
                keys.reset();
            } else {
                KeyHoldTracker.Action action = keys.onUp(code, SystemClock.elapsedRealtime());
                if (action == KeyHoldTracker.Action.SHORT_PRESS && code == KeyEvent.KEYCODE_BACK) {
                    shortBackPress();
                } else if (action == KeyHoldTracker.Action.OPEN_MENU) {
                    act(action);
                }
            }
        }
        return true; // Neither key reaches the WebView or the default handling, which would exit.
    }

    private void act(KeyHoldTracker.Action action) {
        if (action == KeyHoldTracker.Action.OPEN_MENU) showMenu();
    }

    private void shortBackPress() {
        if (mode == Mode.SETUP && server != null) {
            leaveSetup();
        } else {
            Toast.makeText(this, R.string.back_hint, Toast.LENGTH_SHORT).show();
        }
    }

    /** The deliberate way out, and the way to change server. Stays closed unless someone asks. */
    private void showMenu() {
        if (menu != null && menu.isShowing()) return;
        AlertDialog.Builder builder = new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle(R.string.menu_title)
            .setMessage(server == null
                ? getString(R.string.menu_message_no_server)
                : getString(R.string.menu_message, server.display()))
            .setNegativeButton(R.string.menu_keep, null)
            .setNeutralButton(R.string.menu_exit, (d, w) -> finishAndRemoveTask());
        if (mode != Mode.SETUP) {
            builder.setPositiveButton(R.string.menu_change_server, (d, w) -> showSetup());
        }
        menu = builder.create();
        menu.setOnKeyListener(new IgnoreHeldKeyRelease());
        Runnable closeMenu = menu::dismiss;
        // If someone sets this off and walks away, the sign shouldn't be left covered.
        menu.setOnDismissListener(d -> {
            handler.removeCallbacks(closeMenu);
            enterImmersive();
        });
        menu.show();
        handler.postDelayed(closeMenu, MENU_TIMEOUT_MS);
        Button keep = menu.getButton(DialogInterface.BUTTON_NEGATIVE);
        if (keep != null) keep.requestFocus();
    }

    /**
     * The menu opens while the key is still held, so its repeats and release land on the dialog,
     * which would treat them as Back and close straight away. Ignores them until a fresh press.
     */
    private static final class IgnoreHeldKeyRelease implements DialogInterface.OnKeyListener {
        private boolean freshPress;

        @Override
        public boolean onKey(DialogInterface dialog, int keyCode, KeyEvent event) {
            if (keyCode != KeyEvent.KEYCODE_BACK && keyCode != KeyEvent.KEYCODE_MENU) return false;
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) freshPress = true;
            return !freshPress;
        }
    }
}
