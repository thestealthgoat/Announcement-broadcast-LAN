package org.networksignage.kiosk.logic;

import java.net.URI;
import java.net.URISyntaxException;
import java.util.Locale;

/** A validated server origin: scheme, host, and port. Anything else the user typed is dropped. */
public final class ServerAddress {
    /** The server's default port, assumed when someone types only a host. */
    public static final int DEFAULT_PORT = 8080;

    public final String scheme;
    public final String host;
    public final int port;

    private ServerAddress(String scheme, String host, int port) {
        this.scheme = scheme;
        this.host = host;
        this.port = port;
    }

    /**
     * Accepts what a person is likely to type: {@code 192.168.1.20}, {@code signage.local:8080},
     * {@code http://192.168.1.20:8080/tv}. Returns null if it can't be a server address. An
     * address with a scheme and no port means that scheme's default, as in a browser. With no
     * scheme and no port, it means the signage server's default.
     */
    public static ServerAddress parse(String raw) {
        if (raw == null) return null;
        String text = raw.trim();
        if (text.isEmpty()) return null;
        for (int i = 0; i < text.length(); i++) {
            if (Character.isWhitespace(text.charAt(i))) return null;
        }
        boolean hadScheme = text.contains("://");
        URI uri;
        try {
            uri = new URI(hadScheme ? text : "http://" + text);
        } catch (URISyntaxException e) {
            return null;
        }
        String scheme = uri.getScheme();
        if (scheme == null) return null;
        scheme = scheme.toLowerCase(Locale.ROOT);
        if (!scheme.equals("http") && !scheme.equals("https")) return null;
        // A user-info part is how "http://server@elsewhere" hides where it really goes.
        if (uri.getRawUserInfo() != null) return null;
        String host = uri.getHost();
        // Android WebView can't use a scoped IPv6 address such as fe80::1%wlan0.
        if (host == null || host.isEmpty() || host.indexOf('%') >= 0) return null;
        int port = uri.getPort();
        if (port == -1) {
            port = hadScheme ? defaultPortFor(scheme) : DEFAULT_PORT;
        } else if (port < 1 || port > 65535) {
            return null;
        }
        return new ServerAddress(scheme, host.toLowerCase(Locale.ROOT), port);
    }

    /** From a discovered service, which is always plain HTTP. Null if unusable. */
    public static ServerAddress fromHostAndPort(String host, int port) {
        if (host == null || host.isEmpty()) return null;
        String bracketed = host.indexOf(':') >= 0 && !host.startsWith("[") ? "[" + host + "]" : host;
        return parse("http://" + bracketed + ":" + port);
    }

    static int defaultPortFor(String scheme) {
        return scheme.equals("https") ? 443 : 80;
    }

    /** No trailing slash, and the port is left out when it's the scheme's default. */
    public String origin() {
        return port == defaultPortFor(scheme)
            ? scheme + "://" + host
            : scheme + "://" + host + ":" + port;
    }

    /** Where the kiosk starts. A paired TV is then sent to its channel by the player itself. */
    public String playerUrl() {
        return origin() + "/tv";
    }

    /** For showing on screen. */
    public String display() {
        return scheme.equals("http") ? host + ":" + port : origin();
    }

    @Override
    public boolean equals(Object other) {
        if (!(other instanceof ServerAddress)) return false;
        ServerAddress o = (ServerAddress) other;
        return scheme.equals(o.scheme) && host.equals(o.host) && port == o.port;
    }

    @Override
    public int hashCode() {
        return origin().hashCode();
    }

    @Override
    public String toString() {
        return origin();
    }
}
