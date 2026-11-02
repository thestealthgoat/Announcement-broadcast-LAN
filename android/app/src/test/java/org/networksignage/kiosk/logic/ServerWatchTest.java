package org.networksignage.kiosk.logic;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class ServerWatchTest {
    @Test
    public void onlyAServerWeKnowCanBeWatched() {
        assertTrue(ServerWatch.hasIdentity("id", null));
        assertTrue(ServerWatch.hasIdentity(null, "Office"));
        assertFalse(ServerWatch.hasIdentity(null, null));
    }

    @Test
    public void checksEveryFewMinutesAndListensBriefly() {
        assertTrue(ServerWatch.CHECK_EVERY_MS >= 60 * 1000 && ServerWatch.CHECK_EVERY_MS <= 5 * 60 * 1000);
        assertTrue(ServerWatch.LISTEN_MS < ServerWatch.CHECK_EVERY_MS);
    }

    @Test
    public void aPlayingTvMovesOnlyWhenTheOldAddressIsDeadAndTheNewOneAnswers() {
        assertTrue(ServerWatch.shouldMove(true, true, false));
        // A host on Ethernet and Wi-Fi can report either address, and that mustn't reload the player.
        assertFalse(ServerWatch.shouldMove(true, true, true));
        assertFalse(ServerWatch.shouldMove(true, false, false));
        assertFalse(ServerWatch.shouldMove(true, false, true));
    }

    @Test
    public void aTvAlreadyFailingToConnectOnlyNeedsTheNewAddressToAnswer() {
        assertTrue(ServerWatch.shouldMove(false, true, false));
        assertFalse(ServerWatch.shouldMove(false, false, false));
    }

    @Test
    public void readsTheDeviceIdFromTheOldAddressCookies() {
        assertEquals("tv-abc-123", ServerWatch.deviceIdFromCookies("signage_device=tv-abc-123"));
        assertEquals("tv-abc-123", ServerWatch.deviceIdFromCookies("other=1; signage_device=tv-abc-123; more=2"));
        assertNull(ServerWatch.deviceIdFromCookies("other=1"));
        assertNull(ServerWatch.deviceIdFromCookies(null));
        assertNull(ServerWatch.deviceIdFromCookies("signage_device="));
        assertNull("not a shape the player writes", ServerWatch.deviceIdFromCookies("signage_device=a b"));
    }

    @Test
    public void writesACookieThePlayerWillRead() {
        assertEquals("signage_device=tv-1; path=/; max-age=157680000", ServerWatch.deviceCookie("tv-1"));
    }
}
