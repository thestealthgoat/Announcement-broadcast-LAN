package org.networksignage.kiosk.logic;

import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Following a server whose address changes while a TV is playing. No page load fails when that
 * happens: the player just keeps retrying the dead address, and overrides stop arriving.
 */
public final class ServerWatch {
    public static final long CHECK_EVERY_MS = 3 * 60 * 1000;
    public static final long LISTEN_MS = 20 * 1000;
    public static final int PROBE_TIMEOUT_MS = 3000;

    private static final Pattern DEVICE_COOKIE = Pattern.compile("(?:^|;\\s*)signage_device=([A-Za-z0-9-]+)\\s*(?:;|$)");
    private static final long COOKIE_SECONDS = 157680000; // The same five years the player uses.

    private ServerWatch() {}

    /** A server chosen by typing an address that no service was seen at can't be recognised. */
    public static boolean hasIdentity(String id, String name) {
        return id != null || name != null;
    }

    /**
     * A TV that's playing only moves if its current address has stopped answering. A host on both
     * Ethernet and Wi-Fi can report either address, and each report mustn't reload the player.
     */
    public static boolean shouldMove(boolean playing, boolean newAnswers, boolean currentAnswers) {
        return newAnswers && (!playing || !currentAnswers);
    }

    /**
     * The player keeps its device ID per origin, so a new address would look like a new TV asking
     * to be paired. It also reads this cookie when it finds no saved ID, so moving the cookie keeps
     * the pairing, with no bridge into the page.
     */
    public static String deviceIdFromCookies(String cookies) {
        if (cookies == null) return null;
        Matcher match = DEVICE_COOKIE.matcher(cookies);
        return match.find() ? match.group(1) : null;
    }

    public static String deviceCookie(String deviceId) {
        return "signage_device=" + deviceId + "; path=/; max-age=" + COOKIE_SECONDS;
    }
}
