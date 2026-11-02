import fs from 'node:fs';
import { VERSION } from '../version.js';
import { lanAddresses } from '../lan.js';
import { createUpdateChecker } from './updates.js';
import { createAddressWatcher } from './address.js';
import { createStorageWatcher, formatBytes } from './storage.js';
import { createDiscovery } from './discovery.js';
import { screensNeedingAttention } from './health.js';
import { hasPermission } from '../permissions.js';

const TICK_MS = 30 * 1000;
const FIRST_UPDATE_CHECK_MS = 30 * 1000;
const UPDATE_EVERY_MS = 24 * 60 * 60 * 1000;
const RESUME_GAP_MS = 2 * 60 * 1000;

// Runs the background checks. `deps` swaps out everything that touches the outside world, and
// a server bound only to loopback (every test server) talks to nothing unless a test asks it to.
export function createOps({ db, hub, dataDir, port, host, log, deps = {} }) {
  const reachable = host === '0.0.0.0' || host === '::';
  const now = deps.now ?? Date.now;
  const addresses = deps.addresses ?? lanAddresses;
  const version = deps.version ?? VERSION;
  const fetchFn = deps.fetch !== undefined ? deps.fetch : (reachable ? globalThis.fetch : null);

  const refresh = () => hub.adminRefresh('notices');
  const updates = createUpdateChecker({ db, fetch: fetchFn, version, onChange: refresh, timeoutMs: deps.updateTimeoutMs });
  const address = createAddressWatcher({ db, now, onChange: refresh });
  const storage = createStorageWatcher({ dataDir, statfs: deps.statfs ?? fs.promises.statfs, onChange: refresh });
  const discovery = (deps.discovery ?? reachable)
    ? createDiscovery({ port, version, log, createBonjour: deps.createBonjour })
    : null;

  let timer = null;
  let stopped = false;
  let queue = Promise.resolve();
  let ticking = false;
  let watchingSince = now();
  let lastTickAt = null;
  let nextUpdateAt = Infinity;
  let attentionKey = '';

  function needingAttention() {
    return screensNeedingAttention(
      db.all('SELECT id, name, channel_id, last_seen, created_at FROM screens'),
      { now: now(), isOnline: hub.isOnline, since: watchingSince },
    );
  }

  const step = async (fn) => {
    try {
      await fn();
    } catch (err) {
      log?.warn?.({ err }, 'A background check failed');
    }
  };

  async function run() {
    if (stopped) return;
    const t = now();
    // A long gap means the computer was asleep, so TVs get a fair chance to reconnect first.
    if (lastTickAt !== null && t - lastTickAt > RESUME_GAP_MS) watchingSince = t;
    lastTickAt = t;

    await step(() => {
      const [primary] = addresses();
      address.check(primary);
      return discovery?.sync(primary);
    });
    await step(() => storage.check());
    await step(() => {
      const key = needingAttention().map((s) => s.id).sort().join();
      if (key === attentionKey) return;
      attentionKey = key;
      hub.adminRefresh('notices');
      hub.adminRefresh('screens');
    });
    if (fetchFn && updates.enabled() && now() >= nextUpdateAt && !stopped) {
      nextUpdateAt = now() + UPDATE_EVERY_MS;
      await step(() => updates.check());
    }
  }

  function tick() {
    queue = queue.then(run);
    return queue;
  }

  function notices(user) {
    const out = [];
    const seesScreens = hasPermission(user, 'screens.manage');
    const moved = seesScreens && address.notice();
    if (moved) {
      out.push({
        id: `address-${moved.to}`, kind: 'address', severity: 'warning', dismissible: true,
        text: `This computer's network address changed from ${moved.from} to ${moved.to}. TVs using the old address need the new one: http://${moved.to}:${port()}/tv. To keep this from happening, reserve an address for this computer on your router (often called a DHCP reservation).`,
      });
    }
    const disk = storage.snapshot();
    if (disk?.low) {
      out.push({
        id: 'low-storage', kind: 'storage', severity: 'warning', dismissible: false,
        text: `This computer is low on storage, with ${formatBytes(disk.free)} free. New uploads may fail. Delete items you no longer need, or free up space on this computer.`,
        link: { href: '#/library', label: 'Open Library' },
      });
    }
    if (seesScreens) {
      const count = needingAttention().length;
      if (count) {
        out.push({
          id: 'screens-offline', kind: 'screens', severity: 'warning', dismissible: false, count,
          text: `${count} ${count === 1 ? 'TV has' : 'TVs have'} been offline for more than 5 minutes.`,
          link: { href: '#/', label: 'See screens' },
        });
      }
    }
    if (hasPermission(user, 'settings.manage')) {
      const update = updates.available();
      if (update && !updates.isDismissed(update.version)) {
        out.push({
          id: `update-${update.version}`, kind: 'update', severity: 'info', dismissible: true,
          text: `Version ${update.version} is available. You have version ${version}. Nothing installs by itself.`,
          link: { href: update.url, label: 'See the release' },
        });
      }
    }
    return out;
  }

  return {
    notices,
    tick,
    start() {
      if (timer || stopped) return queue;
      watchingSince = now();
      nextUpdateAt = now() + FIRST_UPDATE_CHECK_MS;
      timer = setInterval(() => {
        if (ticking) return;
        ticking = true;
        tick().finally(() => { ticking = false; });
      }, deps.tickMs ?? TICK_MS);
      timer.unref?.();
      return tick();
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      updates.cancel();
      await queue;
      await discovery?.stop();
    },
    dismiss(id, user) {
      const notice = notices(user).find((n) => n.id === id);
      if (!notice?.dismissible) return false;
      if (notice.kind === 'address') address.dismiss();
      if (notice.kind === 'update') updates.dismiss(updates.available().version);
      return true;
    },
    attentionIds: () => new Set(needingAttention().map((s) => s.id)),
    status: () => ({
      storage: storage.snapshot(),
      librarySize: db.get('SELECT COALESCE(SUM(size), 0) AS n FROM media').n,
      checkForUpdates: updates.enabled(),
    }),
    setCheckForUpdates(value) {
      updates.setEnabled(value);
      if (value) nextUpdateAt = now();
    },
    availableUpdate: () => (stopped ? null : updates.available()),
  };
}
