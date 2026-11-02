package org.networksignage.kiosk.logic;

import java.net.URI;
import java.net.URISyntaxException;

/** Decides what the WebView may load, so the kiosk can't wander off the signage server. */
public final class NavigationPolicy {
    private NavigationPolicy() {}

    /**
     * Web page slides are iframes on other origins, so subframes are always allowed. The main
     * frame stays on the server's origin, which covers the player's own moves between /tv and
     * /play/&lt;slug&gt;.
     */
    public static boolean allow(ServerAddress server, String url, boolean isMainFrame) {
        return !isMainFrame || isSameOrigin(server, url);
    }

    public static boolean isSameOrigin(ServerAddress server, String url) {
        if (server == null || url == null) return false;
        URI uri;
        try {
            uri = new URI(url);
        } catch (URISyntaxException e) {
            return false;
        }
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null || uri.getRawUserInfo() != null) return false;
        if (!scheme.equalsIgnoreCase(server.scheme) || !host.equalsIgnoreCase(server.host)) return false;
        int port = uri.getPort() == -1 ? ServerAddress.defaultPortFor(server.scheme) : uri.getPort();
        return port == server.port;
    }

    /**
     * True for the player's own script and stylesheet. If one of these fails, the page can look
     * loaded while nothing runs, so it counts as a failed load even though it isn't the main frame.
     */
    public static boolean isPlayerShell(ServerAddress server, String url) {
        if (!isSameOrigin(server, url)) return false;
        try {
            String path = new URI(url).getPath();
            return path != null && path.startsWith("/player/");
        } catch (URISyntaxException e) {
            return false;
        }
    }
}
