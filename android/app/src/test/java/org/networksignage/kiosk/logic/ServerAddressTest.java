package org.networksignage.kiosk.logic;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

public class ServerAddressTest {
    private static String origin(String raw) {
        return ServerAddress.parse(raw).origin();
    }

    @Test
    public void bareHostGetsTheServerDefaultPort() {
        assertEquals("http://192.168.1.20:8080", origin("192.168.1.20"));
        assertEquals("http://signage.local:8080", origin("signage.local"));
    }

    @Test
    public void keepsAGivenPort() {
        assertEquals("http://192.168.1.20:9000", origin("192.168.1.20:9000"));
        assertEquals("http://signage.local:8080", origin("  signage.local:8080 "));
    }

    @Test
    public void schemeWithoutPortMeansThatSchemesDefault() {
        assertEquals("http://signage.local", origin("http://signage.local"));
        assertEquals("https://signage.local", origin("https://signage.local"));
        assertEquals(80, ServerAddress.parse("http://signage.local").port);
        assertEquals(443, ServerAddress.parse("https://signage.local").port);
    }

    @Test
    public void dropsPathQueryAndFragment() {
        assertEquals("http://192.168.1.20:8080", origin("http://192.168.1.20:8080/tv"));
        assertEquals("http://192.168.1.20:8080", origin("192.168.1.20:8080/play/lobby?x=1#y"));
    }

    @Test
    public void normalizesCase() {
        assertEquals("http://signage.local:8080", origin("HTTP://Signage.LOCAL:8080"));
    }

    @Test
    public void acceptsBracketedIpv6() {
        assertEquals("http://[fd00::1]:8080", origin("[fd00::1]:8080"));
    }

    @Test
    public void rejectsNonsense() {
        String[] bad = {
            null, "", "   ", "not an address", "http://", "://x", "999.1.1.1", "192.168.1",
            "ftp://signage.local", "file:///etc/hosts", "javascript:alert(1)", "content://x/y",
            "signage.local:0", "signage.local:70000", "signage.local:abc", "fe80::1",
            "http://evil.example\\@signage.local",
        };
        for (String raw : bad) {
            assertNull(String.valueOf(raw), ServerAddress.parse(raw));
        }
    }

    @Test
    public void rejectsUserInfoThatHidesTheRealHost() {
        assertNull(ServerAddress.parse("http://192.168.1.20:8080@evil.example"));
        assertNull(ServerAddress.parse("user:pass@signage.local"));
    }

    @Test
    public void rejectsScopedIpv6() {
        assertNull(ServerAddress.parse("http://[fe80::1%25wlan0]:8080"));
        assertNull(ServerAddress.fromHostAndPort("fe80:0:0:0:1:2:3:4%wlan0", 8080));
    }

    @Test
    public void buildsTheAddressesItShows() {
        ServerAddress address = ServerAddress.parse("192.168.1.20:8080");
        assertEquals("http://192.168.1.20:8080/tv", address.playerUrl());
        assertEquals("192.168.1.20:8080", address.display());
        assertEquals("https://signage.local/tv", ServerAddress.parse("https://signage.local").playerUrl());
        assertEquals("https://signage.local", ServerAddress.parse("https://signage.local").display());
    }

    @Test
    public void originSurvivesBeingSavedAndReadBack() {
        for (String raw : new String[] {"10.0.0.5", "http://signage.local", "https://x.test:8443", "[fd00::1]:8080"}) {
            ServerAddress address = ServerAddress.parse(raw);
            assertEquals(address, ServerAddress.parse(address.origin()));
        }
    }

    @Test
    public void fromDiscoveredHostAndPort() {
        assertEquals("http://192.168.1.20:8080", ServerAddress.fromHostAndPort("192.168.1.20", 8080).origin());
        assertEquals("http://[fd00:0:0:0:0:0:0:1]:8080", ServerAddress.fromHostAndPort("fd00:0:0:0:0:0:0:1", 8080).origin());
        assertNull(ServerAddress.fromHostAndPort(null, 8080));
        assertNull(ServerAddress.fromHostAndPort("192.168.1.20", 0));
    }
}
