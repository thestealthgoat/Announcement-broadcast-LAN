package org.networksignage.kiosk;

import android.content.Context;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.networksignage.kiosk.logic.DiscoveredServer;
import org.networksignage.kiosk.logic.ServerPicker;

import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/** Finds signage servers with NsdManager. Every callback reaches the listener on the main thread. */
@SuppressWarnings("deprecation") // resolveService and getHost: the replacements need API 34.
final class ServerDiscovery {
    interface Listener {
        void onServersChanged(List<DiscoveredServer> servers);
        void onDiscoveryFailed();
    }

    private static final String TAG = "SignageDiscovery";
    private static final String SERVICE_TYPE = "_network-signage._tcp";
    private static final long RESOLVE_TIMEOUT_MS = 10000;

    private final NsdManager nsd;
    private final Listener listener;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, DiscoveredServer> found = new HashMap<>();
    // NsdManager allows one resolve at a time on older Android versions, so they queue.
    private final ArrayDeque<NsdServiceInfo> resolveQueue = new ArrayDeque<>();
    private NsdManager.DiscoveryListener active;
    private Object resolving;
    private Runnable resolveTimeout;

    ServerDiscovery(Context context, Listener listener) {
        this.nsd = (NsdManager) context.getSystemService(Context.NSD_SERVICE);
        this.listener = listener;
    }

    boolean isRunning() {
        return active != null;
    }

    void start() {
        if (active != null) return;
        if (nsd == null) {
            listener.onDiscoveryFailed();
            return;
        }
        NsdManager.DiscoveryListener discovery = new SearchCallbacks();
        active = discovery;
        try {
            nsd.discoverServices(SERVICE_TYPE, NsdManager.PROTOCOL_DNS_SD, discovery);
        } catch (RuntimeException e) {
            Log.w(TAG, "Couldn't start discovery", e);
            active = null;
            listener.onDiscoveryFailed();
        }
    }

    void stop() {
        NsdManager.DiscoveryListener discovery = active;
        active = null;
        clearResolving();
        resolveQueue.clear();
        if (discovery == null) return;
        try {
            nsd.stopServiceDiscovery(discovery);
        } catch (RuntimeException e) {
            Log.w(TAG, "Couldn't stop discovery", e);
        }
    }

    /**
     * Searches again from scratch. A running search may not report a service that was already
     * seen, even if its address has changed since then.
     */
    void restart() {
        stop();
        found.clear();
        start();
    }

    /** What's been found by the current search, or the last one. */
    List<DiscoveredServer> servers() {
        return ServerPicker.usable(found.values());
    }

    private void clearResolving() {
        resolving = null;
        if (resolveTimeout != null) main.removeCallbacks(resolveTimeout);
        resolveTimeout = null;
    }

    private void resolveNext() {
        if (resolving != null || active == null) return;
        NsdServiceInfo next = resolveQueue.poll();
        if (next == null) return;
        ResolveCallbacks callbacks = new ResolveCallbacks();
        resolving = callbacks;
        // A resolve that never answers must not block everything behind it.
        resolveTimeout = () -> {
            Log.w(TAG, "Resolve timed out");
            clearResolving();
            resolveNext();
        };
        main.postDelayed(resolveTimeout, RESOLVE_TIMEOUT_MS);
        try {
            nsd.resolveService(next, callbacks);
        } catch (RuntimeException e) {
            Log.w(TAG, "Couldn't resolve a service", e);
            clearResolving();
            resolveNext();
        }
    }

    private static String versionOf(NsdServiceInfo info) {
        try {
            byte[] value = info.getAttributes().get("version");
            return value == null ? null : new String(value, StandardCharsets.UTF_8);
        } catch (RuntimeException e) {
            return null; // Some Android versions throw on a malformed TXT record.
        }
    }

    private final class SearchCallbacks implements NsdManager.DiscoveryListener {
        @Override public void onDiscoveryStarted(String serviceType) {}
        @Override public void onDiscoveryStopped(String serviceType) {}
        @Override public void onStopDiscoveryFailed(String serviceType, int errorCode) {}

        @Override
        public void onStartDiscoveryFailed(String serviceType, int errorCode) {
            Log.w(TAG, "Discovery failed: " + errorCode);
            main.post(() -> {
                if (active != SearchCallbacks.this) return;
                active = null;
                listener.onDiscoveryFailed();
            });
        }

        @Override
        public void onServiceFound(NsdServiceInfo info) {
            main.post(() -> {
                if (active != SearchCallbacks.this) return;
                resolveQueue.add(info);
                resolveNext();
            });
        }

        @Override
        public void onServiceLost(NsdServiceInfo info) {
            main.post(() -> {
                if (active != SearchCallbacks.this) return;
                if (found.remove(info.getServiceName()) != null) listener.onServersChanged(servers());
            });
        }
    }

    private final class ResolveCallbacks implements NsdManager.ResolveListener {
        @Override
        public void onResolveFailed(NsdServiceInfo info, int errorCode) {
            Log.w(TAG, "Resolve failed: " + errorCode);
            main.post(() -> {
                if (resolving != ResolveCallbacks.this) return;
                clearResolving();
                resolveNext();
            });
        }

        @Override
        public void onServiceResolved(NsdServiceInfo info) {
            main.post(() -> {
                if (resolving != ResolveCallbacks.this) return;
                clearResolving();
                if (info.getHost() != null) {
                    found.put(info.getServiceName(), new DiscoveredServer(
                        info.getServiceName(), info.getHost().getHostAddress(), info.getPort(), versionOf(info)));
                    listener.onServersChanged(servers());
                }
                resolveNext();
            });
        }
    }
}
