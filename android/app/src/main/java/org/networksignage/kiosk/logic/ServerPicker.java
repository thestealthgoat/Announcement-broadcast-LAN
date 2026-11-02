package org.networksignage.kiosk.logic;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/** Choices over discovered services. */
public final class ServerPicker {
    private ServerPicker() {}

    /** What to list: one entry per name, usable addresses only, IPv4 preferred, sorted by name. */
    public static List<DiscoveredServer> usable(Collection<DiscoveredServer> found) {
        Map<String, DiscoveredServer> byName = new TreeMap<>(String.CASE_INSENSITIVE_ORDER);
        for (DiscoveredServer server : found) {
            if (server.name == null || server.address() == null) continue;
            DiscoveredServer existing = byName.get(server.name);
            if (existing == null || (!existing.isIpv4() && server.isIpv4())) {
                byName.put(server.name, server);
            }
        }
        return new ArrayList<>(byName.values());
    }

    /**
     * Where a remembered server has moved to, or null to stay put. It only follows the same
     * service name. It never jumps to some other server just because that one is answering,
     * because a TV showing the wrong organisation's signs is worse than one saying it's retrying.
     */
    public static ServerAddress followSaved(String savedName, ServerAddress current, Collection<DiscoveredServer> found) {
        if (savedName == null) return null;
        for (DiscoveredServer server : usable(found)) {
            if (savedName.equalsIgnoreCase(server.name)) {
                ServerAddress moved = server.address();
                return moved.equals(current) ? null : moved;
            }
        }
        return null;
    }

    /** The service name at a typed address, so a typed choice can also follow an address change. */
    public static String nameAt(ServerAddress address, Collection<DiscoveredServer> found) {
        for (DiscoveredServer server : found) {
            if (server.name != null && address.equals(server.address())) return server.name;
        }
        return null;
    }
}
