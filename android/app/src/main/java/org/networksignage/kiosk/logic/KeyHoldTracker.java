package org.networksignage.kiosk.logic;

/**
 * Tells a deliberate press of Back or Menu from an accidental one. Holding the key opens the
 * menu. Three quick presses do too, for any remote that doesn't report a key as held down.
 */
public final class KeyHoldTracker {
    public static final long HOLD_MS = 1500;
    static final long TAP_WINDOW_MS = 2000;
    static final int TAPS_TO_OPEN = 3;

    public enum Action { NONE, SHORT_PRESS, OPEN_MENU }

    private int key = -1;
    private boolean down;
    private boolean holdFired;
    private int taps;
    private long firstTapAt;

    /** A key went down. Call only for the first event, not for auto-repeats. */
    public void onDown(int keyCode) {
        if (keyCode != key) taps = 0;
        key = keyCode;
        down = true;
        holdFired = false;
    }

    /** The hold timer ran out. */
    public Action onHoldElapsed() {
        if (!down || holdFired) return Action.NONE;
        holdFired = true;
        taps = 0;
        return Action.OPEN_MENU;
    }

    /** The key came back up. */
    public Action onUp(int keyCode, long nowMs) {
        if (!down || keyCode != key) return Action.NONE;
        down = false;
        if (holdFired) return Action.NONE;
        if (taps == 0 || nowMs - firstTapAt > TAP_WINDOW_MS) {
            taps = 0;
            firstTapAt = nowMs;
        }
        taps++;
        if (taps >= TAPS_TO_OPEN) {
            taps = 0;
            return Action.OPEN_MENU;
        }
        return Action.SHORT_PRESS;
    }

    public void reset() {
        key = -1;
        down = false;
        holdFired = false;
        taps = 0;
    }
}
