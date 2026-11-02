import { parseVersion, compareVersions, isNewer } from './versions.js';

export const RELEASES_URL = 'https://api.github.com/repos/thestealthgoat/Announcement-broadcast-LAN/releases';
const RELEASE_PAGE = /^\/thestealthgoat\/Announcement-broadcast-LAN\/releases\/tag\/[A-Za-z0-9._-]+$/;
const TIMEOUT_MS = 10000;
const ENABLED_KEY = 'ops.checkForUpdates';
const LATEST_KEY = 'ops.latestRelease';
const DISMISSED_KEY = 'ops.updateDismissed';

// Only a release page of this project may ever be shown to an admin. Returns the clean URL, or null.
export function safeReleaseUrl(value) {
  if (typeof value !== 'string' || value.length > 300) return null;
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.port) return null;
  if (url.username || url.password || url.search || url.hash) return null;
  return RELEASE_PAGE.test(url.pathname) ? url.href : null;
}

// The newest published release that is newer than `current`, leaving out drafts and bad entries.
export function pickLatest(releases, current) {
  let best = null;
  for (const r of releases) {
    if (!r || typeof r !== 'object' || r.draft) continue;
    const parsed = parseVersion(r.tag_name);
    const url = safeReleaseUrl(r.html_url);
    if (!parsed || !url || !isNewer(parsed.text, current)) continue;
    if (!best || compareVersions(parsed.text, best.version) === 1) best = { version: parsed.text, url };
  }
  return best;
}

// The tray menu's entry: nothing at all unless there is a release to open.
export function updateMenuItems(update, open) {
  if (!update) return [];
  return [
    { label: `Update available: ${update.version}`, click: () => open(update.url) },
    { type: 'separator' },
  ];
}

const abortable = (promise, signal) => Promise.race([
  promise,
  new Promise((_, reject) => {
    if (signal.aborted) reject(new Error('aborted'));
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  }),
]);

export function createUpdateChecker({ db, fetch, version, onChange = () => {}, timeoutMs = TIMEOUT_MS }) {
  let controller = null;

  const enabled = () => db.getSetting(ENABLED_KEY, true) !== false;

  // Checked again here because this is what gets shown, and the app may have been upgraded since.
  function stored() {
    const latest = db.getSetting(LATEST_KEY, null);
    const url = safeReleaseUrl(latest?.url);
    if (!url || !parseVersion(latest.version) || !isNewer(latest.version, version)) return null;
    return { version: latest.version, url };
  }

  // Failures are silent on purpose: the last good answer stays and the next check tries again.
  async function check() {
    if (!fetch || !enabled() || controller) return;
    const current = new AbortController();
    controller = current;
    const timer = setTimeout(() => current.abort(), timeoutMs);
    timer.unref?.();
    try {
      const res = await abortable(fetch(RELEASES_URL, {
        headers: { 'User-Agent': `Network-Signage/${version}`, Accept: 'application/vnd.github+json' },
        signal: current.signal,
      }), current.signal);
      if (!res?.ok) return;
      const releases = await abortable(res.json(), current.signal);
      if (!Array.isArray(releases)) return;
      const latest = pickLatest(releases, version);
      if (JSON.stringify(latest) === JSON.stringify(db.getSetting(LATEST_KEY, null))) return;
      db.setSetting(LATEST_KEY, latest);
      onChange();
    } catch {
      // Offline, timed out, rate limited, or not JSON.
    } finally {
      clearTimeout(timer);
      if (controller === current) controller = null;
    }
  }

  return {
    check,
    enabled,
    setEnabled(value) {
      db.setSetting(ENABLED_KEY, value);
      if (!value) controller?.abort();
      onChange();
    },
    cancel: () => controller?.abort(),
    available: () => (enabled() ? stored() : null),
    isDismissed: (v) => db.getSetting(DISMISSED_KEY, null) === v,
    dismiss(v) {
      db.setSetting(DISMISSED_KEY, v);
      onChange();
    },
  };
}
