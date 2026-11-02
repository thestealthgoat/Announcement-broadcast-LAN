package org.networksignage.kiosk.logic;

import java.util.Objects;

/** One resolved mDNS service. */
public final class DiscoveredServer {
    public final String name;
    public final String host;
    public final int port;
    /** From the service's TXT record. Null if it wasn't there. */
    public final String version;

    public DiscoveredServer(String name, String host, int port, String version) {
        this.name = unescape(name);
        this.host = host;
        this.port = port;
        this.version = version;
    }

    public ServerAddress address() {
        return ServerAddress.fromHostAndPort(host, port);
    }

    public boolean isIpv4() {
        return host != null && host.indexOf(':') < 0;
    }

    public String label() {
        ServerAddress address = address();
        String where = address == null ? host : address.display();
        String label = name + " (" + where + ")";
        return version == null || version.isEmpty() ? label : label + ", version " + version;
    }

    /** Some Android versions report DNS-style escapes, so "My\032Server" means "My Server". */
    static String unescape(String name) {
        if (name == null || name.indexOf('\\') < 0) return name;
        StringBuilder out = new StringBuilder();
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (c == '\\' && i + 3 < name.length() && isDigit(name, i + 1) && isDigit(name, i + 2) && isDigit(name, i + 3)) {
                out.append((char) Integer.parseInt(name.substring(i + 1, i + 4)));
                i += 3;
            } else if (c == '\\' && i + 1 < name.length()) {
                out.append(name.charAt(++i));
            } else {
                out.append(c);
            }
        }
        return out.toString();
    }

    private static boolean isDigit(String text, int index) {
        char c = text.charAt(index);
        return c >= '0' && c <= '9';
    }

    @Override
    public boolean equals(Object other) {
        if (!(other instanceof DiscoveredServer)) return false;
        DiscoveredServer o = (DiscoveredServer) other;
        return port == o.port && Objects.equals(name, o.name) && Objects.equals(host, o.host)
            && Objects.equals(version, o.version);
    }

    @Override
    public int hashCode() {
        return Objects.hash(name, host, port, version);
    }
}
