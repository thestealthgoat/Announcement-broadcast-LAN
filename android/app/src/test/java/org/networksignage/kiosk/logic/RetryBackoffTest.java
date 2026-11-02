package org.networksignage.kiosk.logic;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

public class RetryBackoffTest {
    @Test
    public void doublesUpToTheCeilingAndStaysThere() {
        RetryBackoff backoff = new RetryBackoff(2000, 30000);
        long[] expected = {2000, 4000, 8000, 16000, 30000, 30000, 30000};
        for (long delay : expected) {
            assertEquals(delay, backoff.next());
        }
    }

    @Test
    public void resetStartsOver() {
        RetryBackoff backoff = new RetryBackoff(2000, 30000);
        backoff.next();
        backoff.next();
        backoff.reset();
        assertEquals(2000, backoff.next());
    }

    @Test
    public void neverOverflowsHoweverLongItRuns() {
        RetryBackoff backoff = new RetryBackoff(1, Long.MAX_VALUE);
        for (int i = 0; i < 200; i++) {
            long delay = backoff.next();
            assertEquals(true, delay > 0);
        }
    }

    @Test(expected = IllegalArgumentException.class)
    public void rejectsACeilingBelowTheBase() {
        new RetryBackoff(5000, 1000);
    }
}
