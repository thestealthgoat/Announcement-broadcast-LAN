package org.networksignage.kiosk.logic;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public class ServerPickerTest {
    private static DiscoveredServer server(String name, String host) {
        return new DiscoveredServer(name, host, 8080, "2.0.0");
    }

    private static DiscoveredServer withId(String name, String host, String id) {
        return new DiscoveredServer(name, host, 8080, "2.0.0", id);
    }

    private static ServerAddress address(String raw) {
        return ServerAddress.parse(raw);
    }

    @Test
    public void listsServersSortedByName() {
        List<DiscoveredServer> list = ServerPicker.usable(Arrays.asList(
            server("zebra", "10.0.0.2"), server("Alpha", "10.0.0.1"), server("mid", "10.0.0.3")));
        assertEquals("Alpha", list.get(0).name);
        assertEquals("mid", list.get(1).name);
        assertEquals("zebra", list.get(2).name);
    }

    @Test
    public void leavesOutUnusableAddresses() {
        List<DiscoveredServer> list = ServerPicker.usable(Arrays.asList(
            server("scoped", "fe80:0:0:0:1:2:3:4%wlan0"), server("none", null), server("good", "10.0.0.1"),
            new DiscoveredServer("bad port", "10.0.0.9", 0, null)));
        assertEquals(1, list.size());
        assertEquals("good", list.get(0).name);
    }

    @Test
    public void prefersIpv4ForTheSameName() {
        List<DiscoveredServer> list = ServerPicker.usable(Arrays.asList(
            server("host", "fd00:0:0:0:0:0:0:1"), server("host", "10.0.0.1"), server("host", "fd00:0:0:0:0:0:0:2")));
        assertEquals(1, list.size());
        assertEquals("10.0.0.1", list.get(0).host);
    }

    @Test
    public void followsTheSavedServiceToItsNewAddress() {
        ServerAddress moved = ServerPicker.followSaved(null, "Office",
            address("10.0.0.1:8080"), Arrays.asList(server("Other", "10.0.0.7"), server("Office", "10.0.0.2")));
        assertEquals(address("10.0.0.2:8080"), moved);
    }

    @Test
    public void staysPutWhenTheAddressIsUnchanged() {
        assertNull(ServerPicker.followSaved(null, "Office",
            address("10.0.0.1:8080"), Collections.singletonList(server("Office", "10.0.0.1"))));
    }

    @Test
    public void neverJumpsToADifferentServer() {
        assertNull(ServerPicker.followSaved(null, "Office",
            address("10.0.0.1:8080"), Collections.singletonList(server("Other", "10.0.0.7"))));
    }

    @Test
    public void aTypedAddressWithNoKnownServiceDoesntFollowAnything() {
        assertNull(ServerPicker.followSaved(null, null,
            address("10.0.0.1:8080"), Collections.singletonList(server("Other", "10.0.0.7"))));
    }

    @Test
    public void theIdFollowsAServerWhoseHostnameChanged() {
        ServerAddress moved = ServerPicker.followSaved("abc", "Network Signage on old-name",
            address("10.0.0.1:8080"), Collections.singletonList(withId("Network Signage on new-name", "10.0.0.2", "abc")));
        assertEquals(address("10.0.0.2:8080"), moved);
    }

    @Test
    public void theIdFollowsASuffixedName() {
        ServerAddress moved = ServerPicker.followSaved("abc", "Office",
            address("10.0.0.1:8080"), Arrays.asList(withId("Office", "10.0.0.7", "someone-else"), withId("Office (2)", "10.0.0.2", "abc")));
        assertEquals(address("10.0.0.2:8080"), moved);
    }

    @Test
    public void theIdWinsOverTheName() {
        DiscoveredServer match = ServerPicker.findSaved("abc", "Office",
            Arrays.asList(server("Office", "10.0.0.7"), withId("Renamed", "10.0.0.2", "abc")));
        assertEquals("Renamed", match.name);
    }

    @Test
    public void theSameNameWithADifferentIdIsADifferentServer() {
        assertNull(ServerPicker.followSaved("abc", "Office",
            address("10.0.0.1:8080"), Collections.singletonList(withId("Office", "10.0.0.2", "someone-else"))));
    }

    @Test
    public void fallsBackToTheNameForAServerWithNoId() {
        assertEquals(address("10.0.0.2:8080"), ServerPicker.followSaved("abc", "Office",
            address("10.0.0.1:8080"), Collections.singletonList(server("Office", "10.0.0.2"))));
    }

    @Test
    public void aChoiceSavedBeforeIdsExistedStillFollowsItsName() {
        DiscoveredServer match = ServerPicker.findSaved(null, "Office", Collections.singletonList(withId("Office", "10.0.0.2", "abc")));
        assertEquals("abc", match.id);
    }

    @Test
    public void anIdIsNoMatchForNoSavedChoice() {
        assertNull(ServerPicker.findSaved(null, null, Collections.singletonList(withId("Office", "10.0.0.2", "abc"))));
    }

    @Test
    public void matchesATypedAddressToItsService() {
        List<DiscoveredServer> found = Arrays.asList(server("Office", "10.0.0.1"), server("Lobby", "10.0.0.2"));
        assertEquals("Lobby", ServerPicker.atAddress(address("10.0.0.2:8080"), found).name);
        assertNull(ServerPicker.atAddress(address("10.0.0.3:8080"), found));
        assertNull(ServerPicker.atAddress(address("10.0.0.2:9000"), found));
    }

    @Test
    public void labelShowsWhereAndWhichVersion() {
        assertEquals("Office (10.0.0.1:8080), version 2.0.0", server("Office", "10.0.0.1").label());
        assertEquals("Office (10.0.0.1:8080)", new DiscoveredServer("Office", "10.0.0.1", 8080, null).label());
    }

    @Test
    public void decodesEscapedNames() {
        assertEquals("My Server", new DiscoveredServer("My\\032Server", "10.0.0.1", 8080, null).name);
        assertEquals("a.b", new DiscoveredServer("a\\.b", "10.0.0.1", 8080, null).name);
        assertEquals("plain", new DiscoveredServer("plain", "10.0.0.1", 8080, null).name);
        assertEquals("trailing\\", new DiscoveredServer("trailing\\", "10.0.0.1", 8080, null).name);
    }
}
