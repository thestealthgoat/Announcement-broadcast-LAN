package org.networksignage.kiosk.logic;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class NavigationPolicyTest {
    private static final ServerAddress SERVER = ServerAddress.parse("192.168.1.20:8080");

    private static boolean mainFrame(String url) {
        return NavigationPolicy.allow(SERVER, url, true);
    }

    @Test
    public void thePlayerCanMoveBetweenItsOwnPages() {
        assertTrue(mainFrame("http://192.168.1.20:8080/tv"));
        assertTrue(mainFrame("http://192.168.1.20:8080/play/lobby"));
        assertTrue(mainFrame("http://192.168.1.20:8080/play/front%20door?x=1#y"));
    }

    @Test
    public void mainFrameCantLeaveTheOrigin() {
        String[] blocked = {
            "http://example.com/",
            "http://192.168.1.21:8080/tv",
            "http://192.168.1.20:8081/tv",
            "http://192.168.1.20/tv",
            "https://192.168.1.20:8080/tv",
            "http://192.168.1.20:8080@evil.example/tv",
            "http://192.168.1.20.evil.example:8080/tv",
            "http://evil.example\\@192.168.1.20:8080/tv",
            "file:///sdcard/x.html",
            "content://settings/system",
            "intent://x#Intent;end",
            "market://details?id=x",
            "javascript:alert(1)",
            "data:text/html,hi",
            "about:blank",
            "not a url",
            "",
            null,
        };
        for (String url : blocked) {
            assertFalse(String.valueOf(url), mainFrame(url));
        }
    }

    @Test
    public void hostComparisonIgnoresCase() {
        ServerAddress named = ServerAddress.parse("signage.local:8080");
        assertTrue(NavigationPolicy.allow(named, "http://SIGNAGE.local:8080/tv", true));
    }

    @Test
    public void defaultPortsMatchWithOrWithoutBeingWritten() {
        ServerAddress plain = ServerAddress.parse("http://signage.local");
        assertTrue(NavigationPolicy.allow(plain, "http://signage.local/tv", true));
        assertTrue(NavigationPolicy.allow(plain, "http://signage.local:80/tv", true));
        assertFalse(NavigationPolicy.allow(plain, "http://signage.local:8080/tv", true));
        ServerAddress secure = ServerAddress.parse("https://signage.local");
        assertTrue(NavigationPolicy.allow(secure, "https://signage.local:443/tv", true));
        assertFalse(NavigationPolicy.allow(secure, "http://signage.local/tv", true));
    }

    @Test
    public void webSlideFramesCanGoAnywhere() {
        assertTrue(NavigationPolicy.allow(SERVER, "https://example.com/dashboard", false));
        assertTrue(NavigationPolicy.allow(SERVER, "http://other.example:9000/", false));
    }

    @Test
    public void nothingIsAllowedWithoutAServer() {
        assertFalse(NavigationPolicy.allow(null, "http://192.168.1.20:8080/tv", true));
    }

    @Test
    public void recognizesThePlayersOwnFiles() {
        assertTrue(NavigationPolicy.isPlayerShell(SERVER, "http://192.168.1.20:8080/player/player.js"));
        assertTrue(NavigationPolicy.isPlayerShell(SERVER, "http://192.168.1.20:8080/player/player.css"));
        assertFalse(NavigationPolicy.isPlayerShell(SERVER, "http://192.168.1.20:8080/media/video.mp4"));
        assertFalse(NavigationPolicy.isPlayerShell(SERVER, "https://example.com/player/player.js"));
    }
}
