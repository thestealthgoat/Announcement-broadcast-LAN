package org.networksignage.kiosk.logic;

import static org.junit.Assert.assertEquals;

import org.junit.Test;
import org.networksignage.kiosk.logic.KeyHoldTracker.Action;

public class KeyHoldTrackerTest {
    private static final int BACK = 4;
    private static final int MENU = 82;

    private final KeyHoldTracker keys = new KeyHoldTracker();

    private Action tap(int key, long at) {
        keys.onDown(key);
        return keys.onUp(key, at);
    }

    @Test
    public void onePressIsOnlyAShortPress() {
        assertEquals(Action.SHORT_PRESS, tap(BACK, 1000));
    }

    @Test
    public void holdingOpensTheMenuAndReleaseDoesNothingMore() {
        keys.onDown(BACK);
        assertEquals(Action.OPEN_MENU, keys.onHoldElapsed());
        assertEquals(Action.NONE, keys.onUp(BACK, 3000));
    }

    @Test
    public void holdTimerAfterReleaseDoesNothing() {
        tap(BACK, 1000);
        assertEquals(Action.NONE, keys.onHoldElapsed());
    }

    @Test
    public void holdFiresOnlyOnce() {
        keys.onDown(MENU);
        assertEquals(Action.OPEN_MENU, keys.onHoldElapsed());
        assertEquals(Action.NONE, keys.onHoldElapsed());
    }

    @Test
    public void threeQuickPressesOpenTheMenu() {
        assertEquals(Action.SHORT_PRESS, tap(BACK, 1000));
        assertEquals(Action.SHORT_PRESS, tap(BACK, 1400));
        assertEquals(Action.OPEN_MENU, tap(BACK, 1800));
        assertEquals(Action.SHORT_PRESS, tap(BACK, 2000));
    }

    @Test
    public void slowPressesDontAddUp() {
        assertEquals(Action.SHORT_PRESS, tap(BACK, 1000));
        assertEquals(Action.SHORT_PRESS, tap(BACK, 2500));
        assertEquals(Action.SHORT_PRESS, tap(BACK, 4000));
        assertEquals(Action.SHORT_PRESS, tap(BACK, 5500));
    }

    @Test
    public void differentKeysDontAddUp() {
        tap(BACK, 1000);
        tap(BACK, 1100);
        assertEquals(Action.SHORT_PRESS, tap(MENU, 1200));
    }

    @Test
    public void aReleaseWithNoPressIsIgnored() {
        assertEquals(Action.NONE, keys.onUp(BACK, 1000));
    }

    @Test
    public void resetForgetsEverything() {
        tap(BACK, 1000);
        tap(BACK, 1100);
        keys.onDown(BACK);
        keys.reset();
        assertEquals(Action.NONE, keys.onHoldElapsed());
        assertEquals(Action.NONE, keys.onUp(BACK, 1200));
        assertEquals(Action.SHORT_PRESS, tap(BACK, 1300));
    }
}
