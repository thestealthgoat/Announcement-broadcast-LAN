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
     * The remembered server among those found, or null. The ID comes first, because a hostname can
     * change and a name taken by another host gets a number added. The name only counts where
     * there's no ID to compare: a server too old to send one, or a choice saved before IDs existed.
     * The same name with a different ID is a different server, and a TV showing the wrong
     * organisation's signs is worse than one saying it's retrying.
     */
    public static DiscoveredServer findSaved(String savedId, String savedName, Collection<DiscoveredServer> found) {
        List<DiscoveredServer> servers = usable(found);
        if (savedId != null) {
            for (DiscoveredServer server : servers) {
                if (savedId.equals(server.id)) return server;
            }
        }
        if (savedName == null) return null;
        for (DiscoveredServer server : servers) {
            if (savedName.equalsIgnoreCase(server.name) && (savedId == null || server.id == null)) return server;
        }
        return null;
    }

    /** Where a remembered server has moved to, or null to stay put. */
    public static ServerAddress followSaved(String savedId, String savedName, ServerAddress current, Collection<DiscoveredServer> found) {
        DiscoveredServer server = findSaved(savedId, savedName, found);
        if (server == null) return null;
        ServerAddress moved = server.address();
        return moved.equals(current) ? null : moved;
    }

    /** The service at a typed address, so a typed choice can also follow an address change. */
    public static DiscoveredServer atAddress(ServerAddress address, Collection<DiscoveredServer> found) {
        for (DiscoveredServer server : found) {
            if (server.name != null && address.equals(server.address())) return server;
        }
        return null;
    }
}
