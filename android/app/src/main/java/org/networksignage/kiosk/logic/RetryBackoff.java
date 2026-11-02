package org.networksignage.kiosk.logic;

/** Doubling delays between attempts, up to a ceiling. Never gives up. */
public final class RetryBackoff {
    private final long baseMs;
    private final long maxMs;
    private long nextMs;

    public RetryBackoff(long baseMs, long maxMs) {
        if (baseMs <= 0 || maxMs < baseMs) throw new IllegalArgumentException("bad delays");
        this.baseMs = baseMs;
        this.maxMs = maxMs;
        this.nextMs = baseMs;
    }

    public long next() {
        long delay = nextMs;
        nextMs = delay > maxMs / 2 ? maxMs : delay * 2;
        return delay;
    }

    public void reset() {
        nextMs = baseMs;
    }
}
