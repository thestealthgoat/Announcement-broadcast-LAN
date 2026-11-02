export const OFFLINE_ALERT_MS = 5 * 60 * 1000;

// Paired screens that have been gone too long. `since` is when this server began watching:
// its own downtime is not the TVs' fault, so the clock cannot start before then.
export function screensNeedingAttention(screens, { now, isOnline, since = 0 }) {
  return screens.filter((s) => {
    if (s.channel_id === null || s.channel_id === undefined) return false;
    if (isOnline(s.id)) return false;
    return now - Math.max(s.last_seen ?? s.created_at ?? 0, since) > OFFLINE_ALERT_MS;
  });
}
