import test from 'node:test';
import assert from 'node:assert/strict';
import dgram from 'node:dgram';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startServer, setupAdmin, makeEditor, client, player } from './helpers.js';
import { createServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { createOps } from '../server/ops/index.js';
import { compareVersions, isNewer, parseVersion } from '../server/ops/versions.js';
import { pickLatest, safeReleaseUrl, updateMenuItems, RELEASES_URL } from '../server/ops/updates.js';
import { screensNeedingAttention, OFFLINE_ALERT_MS } from '../server/ops/health.js';
import { isLowStorage, createStorageWatcher } from '../server/ops/storage.js';
import { createDiscovery, realBonjour, hostName, uniqueName } from '../server/ops/discovery.js';

const GB = 1024 ** 3;
const MINUTE = 60000;
const DAY = 24 * 60 * MINUTE;
const RELEASES = 'https://github.com/thestealthgoat/Announcement-broadcast-LAN/releases/tag';

const release = (tag, extra = {}) => ({ tag_name: tag, html_url: `${RELEASES}/${tag}`, draft: false, prerelease: false, ...extra });
const jsonResponse = (body) => ({ ok: true, json: async () => body });
const statfsOf = (freeBytes, totalBytes = 500 * GB) => async () => ({
  bsize: 4096, bavail: freeBytes / 4096, blocks: totalBytes / 4096,
});

// A real server with a fake clock, network and disk. Nothing here leaves the machine.
async function opsServer(t, ops = {}, { addresses = ['192.168.1.20'] } = {}) {
  const world = { clock: Date.now(), addresses, statfs: statfsOf(200 * GB), calls: 0, respond: async () => jsonResponse([]) };
  const started = await startServer(t, {
    ops: {
      now: () => world.clock,
      addresses: () => world.addresses,
      statfs: (dir) => world.statfs(dir),
      fetch: (...args) => {
        world.calls++;
        world.lastCall = args;
        return world.respond(...args);
      },
      version: '1.0.2',
      tickMs: 3600000,
      ...ops,
    },
  });
  const { server } = started;
  await server.ops.tick();
  // Moves time forward in steps small enough not to look like the computer slept.
  const advance = async (ms) => {
    for (let left = ms; left > 0; left -= MINUTE) {
      world.clock += Math.min(left, MINUTE);
      await server.ops.tick();
    }
  };
  return { ...started, world, advance };
}

const noticeIds = async (c) => (await c.get('/api/notices')).data.map((n) => n.id);

async function until(check, ms = 5000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out waiting for a condition');
}

// ---------- version comparer ----------

test('version comparer orders numerically and ignores malformed tags', () => {
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
  assert.equal(compareVersions('1.0.9', '1.0.10'), -1);
  assert.equal(compareVersions('v2.0.0', '1.99.99'), 1);
  assert.equal(compareVersions('v1.0.2', '1.0.2'), 0);
  assert.equal(compareVersions('1.1.0', '1.1.0-beta.1'), 1, 'a final release beats its pre-release');
  assert.equal(compareVersions('1.1.0-beta.10', '1.1.0-beta.9'), 1);
  assert.equal(compareVersions('1.1.0-rc.1', '1.1.0-beta.9'), 1);
  assert.equal(compareVersions('1.1.0-beta', '1.1.0-beta.1'), -1);
  assert.equal(compareVersions('1.1.0-beta.1', '1.1.0-beta.1'), 0);
  for (const bad of ['', 'latest', '1.0', '1.0.0.0', 'v1.x.0', '1.0.0-', '1.0.0-<b>', ' ', '99999999999.0.0', null, 7, {}, undefined]) {
    assert.equal(parseVersion(bad), null, String(bad));
    assert.equal(compareVersions(bad, '1.0.0'), null, String(bad));
    assert.equal(isNewer(bad, '1.0.0'), false, String(bad));
  }
});

// ---------- update notices ----------

test('release links must be release pages of this repository', () => {
  assert.equal(safeReleaseUrl(`${RELEASES}/v1.2.3`), `${RELEASES}/v1.2.3`);
  for (const bad of [
    'http://github.com/thestealthgoat/Announcement-broadcast-LAN/releases/tag/v1.2.3',
    'https://github.com.evil.example/thestealthgoat/Announcement-broadcast-LAN/releases/tag/v1.2.3',
    'https://evil.example/thestealthgoat/Announcement-broadcast-LAN/releases/tag/v1.2.3',
    'https://github.com@evil.example/thestealthgoat/Announcement-broadcast-LAN/releases/tag/v1.2.3',
    'https://user:pw@github.com/thestealthgoat/Announcement-broadcast-LAN/releases/tag/v1.2.3',
    'https://github.com:8443/thestealthgoat/Announcement-broadcast-LAN/releases/tag/v1.2.3',
    'https://github.com/someone-else/Announcement-broadcast-LAN/releases/tag/v1.2.3',
    'https://github.com/thestealthgoat/Announcement-broadcast-LAN/releases/tag/../../../../evil/repo',
    'https://github.com/thestealthgoat/Announcement-broadcast-LAN/releases/tag/a/b',
    'https://github.com/thestealthgoat/Announcement-broadcast-LAN/releases/tag/%2e%2e%2fevil',
    'https://github.com/thestealthgoat/Announcement-broadcast-LAN/releases/tag/v1.2.3?next=https://evil.example',
    'https://github.com/thestealthgoat/Announcement-broadcast-LAN/releases/tag/v1.2.3#x',
    'https://github.com/thestealthgoat/Announcement-broadcast-LAN/archive/v1.2.3.zip',
    'javascript:alert(1)',
    'not a url',
    '',
    null,
    42,
    {},
  ]) {
    assert.equal(safeReleaseUrl(bad), null, String(bad));
  }
});

test('the newest release wins: drafts are out, pre-releases are in', () => {
  assert.deepEqual(pickLatest([release('v1.0.9'), release('v1.0.10'), release('v1.0.3')], '1.0.2').version, '1.0.10');
  assert.equal(pickLatest([release('v9.0.0', { draft: true }), release('v1.0.3')], '1.0.2').version, '1.0.3');
  assert.equal(pickLatest([release('v1.1.0-beta.1', { prerelease: true })], '1.0.2').version, '1.1.0-beta.1');
  assert.equal(pickLatest([release('v1.0.2'), release('v1.0.1')], '1.0.2'), null, 'same or older is not an update');
  assert.equal(pickLatest([null, 3, 'x', {}, { tag_name: 5 }, release('nightly')], '1.0.2'), null);
  assert.equal(pickLatest([release('v9.0.0', { html_url: 'https://evil.example/x' }), release('v1.0.3')], '1.0.2').version, '1.0.3');
});

test('update check: finds a release shortly after startup, then once a day', async (t) => {
  const { base, world, advance, server } = await opsServer(t);
  const admin = await setupAdmin(base);
  world.respond = async () => jsonResponse([release('v1.0.3', { prerelease: true }), release('v1.0.2')]);
  assert.equal(world.calls, 0, 'not during startup itself');

  await advance(MINUTE);
  assert.equal(world.calls, 1);
  const [url, options] = world.lastCall;
  assert.equal(url, RELEASES_URL);
  assert.match(options.headers['User-Agent'], /Network-Signage/);
  assert.ok(options.signal instanceof AbortSignal, 'has a timeout');

  const [notice] = (await admin.get('/api/notices')).data;
  assert.equal(notice.id, 'update-1.0.3');
  assert.equal(notice.severity, 'info');
  assert.equal(notice.dismissible, true);
  assert.equal(notice.link.href, `${RELEASES}/v1.0.3`);
  assert.match(notice.text, /1\.0\.3/);
  assert.deepEqual(server.ops.availableUpdate(), { version: '1.0.3', url: `${RELEASES}/v1.0.3` });

  await advance(10 * MINUTE);
  assert.equal(world.calls, 1, 'not again the same day');
  world.clock += DAY;
  await server.ops.tick();
  assert.equal(world.calls, 2, 'next day');
});

test('update check: failures and malformed answers are silent and keep the last good answer', async (t) => {
  const { base, world, advance, server } = await opsServer(t, { updateTimeoutMs: 30 });
  const admin = await setupAdmin(base);
  const bad = [
    async () => { throw new Error('network down'); },
    () => { throw new Error('thrown synchronously'); },
    async () => ({ ok: false, status: 403, json: async () => ({ message: 'rate limited' }) }),
    async () => ({ ok: true, json: async () => { throw new SyntaxError('not JSON'); } }),
    async () => jsonResponse({ message: 'not a list' }),
    async () => jsonResponse(null),
    async () => null,
    () => new Promise(() => {}), // never answers, so the timeout has to end it
    async () => ({ ok: true, json: () => new Promise(() => {}) }),
  ];
  for (const respond of bad) {
    world.respond = respond;
    world.clock += DAY;
    await server.ops.tick();
  }
  assert.equal(world.calls, bad.length);
  assert.deepEqual(await noticeIds(admin), []);

  world.respond = async () => jsonResponse([{ junk: true }, release('oops'), release('v1.0.4', { html_url: 7 })]);
  world.clock += DAY;
  await server.ops.tick();
  assert.deepEqual(await noticeIds(admin), [], 'garbage entries are not updates');

  world.respond = async () => jsonResponse([release('v1.0.5')]);
  world.clock += DAY;
  await server.ops.tick();
  assert.deepEqual(await noticeIds(admin), ['update-1.0.5']);

  for (const respond of bad) {
    world.respond = respond;
    world.clock += DAY;
    await server.ops.tick();
  }
  assert.deepEqual(await noticeIds(admin), ['update-1.0.5'], 'a failed check does not forget the release');
  await advance(MINUTE);
});

test('update check: turning it off stops every request and hides what was found', async (t) => {
  const { base, world, advance, server } = await opsServer(t);
  const admin = await setupAdmin(base);
  world.respond = async () => jsonResponse([release('v1.0.5')]);

  assert.equal((await admin.get('/api/ops/status')).data.checkForUpdates, true, 'on by default');
  const off = await admin.put('/api/ops/settings', { checkForUpdates: false });
  assert.equal(off.data.checkForUpdates, false);

  await advance(10 * MINUTE);
  world.clock += 3 * DAY;
  await server.ops.tick();
  assert.equal(world.calls, 0, 'fetch is never called while the setting is off');
  assert.deepEqual(await noticeIds(admin), []);

  await admin.put('/api/ops/settings', { checkForUpdates: true });
  await advance(MINUTE);
  assert.equal(world.calls, 1, 'turning it on checks soon');
  assert.deepEqual(await noticeIds(admin), ['update-1.0.5']);

  await admin.put('/api/ops/settings', { checkForUpdates: false });
  assert.deepEqual(await noticeIds(admin), [], 'off hides a stored result too');
  assert.equal(server.ops.availableUpdate(), null);
  assert.equal(server.db.getSetting('ops.checkForUpdates'), false);
});

test('update check: a request in flight when the setting goes off is thrown away', async (t) => {
  const { base, world, advance, server } = await opsServer(t);
  const admin = await setupAdmin(base);
  let answer;
  world.respond = () => new Promise((resolve) => { answer = resolve; });
  const stepping = advance(MINUTE);
  await until(() => answer);
  await admin.put('/api/ops/settings', { checkForUpdates: false });
  answer(jsonResponse([release('v1.0.5')]));
  await stepping;
  assert.equal(server.db.getSetting('ops.latestRelease', null), null);
});

test('update check: a hostile html_url is neither stored nor shown', async (t) => {
  const { base, world, advance, server } = await opsServer(t);
  const admin = await setupAdmin(base);
  world.respond = async () => jsonResponse([release('v9.9.9', { html_url: 'https://evil.example/thestealthgoat/Announcement-broadcast-LAN/releases/tag/v9.9.9' })]);
  await advance(MINUTE);
  assert.equal(world.calls, 1);
  assert.equal(server.db.getSetting('ops.latestRelease', null), null);
  assert.deepEqual(await noticeIds(admin), []);

  // Even a bad value that got into the settings table some other way stays hidden.
  server.db.setSetting('ops.latestRelease', { version: '9.9.9', url: 'https://evil.example/' });
  assert.deepEqual(await noticeIds(admin), []);
  assert.equal(server.ops.availableUpdate(), null);
});

test('update notice: dismissal lasts for that version only, and upgrading clears it', async (t) => {
  const { base, world, advance, server } = await opsServer(t);
  const admin = await setupAdmin(base);
  world.respond = async () => jsonResponse([release('v1.0.5')]);
  await advance(MINUTE);
  assert.deepEqual(await noticeIds(admin), ['update-1.0.5']);

  assert.equal((await admin.post('/api/notices/update-1.0.5/dismiss')).status, 200);
  assert.deepEqual(await noticeIds(admin), []);
  assert.deepEqual(server.ops.availableUpdate()?.version, '1.0.5', 'the tray still offers it');
  world.clock += DAY;
  await server.ops.tick();
  assert.deepEqual(await noticeIds(admin), [], 'stays dismissed after the next check');

  world.respond = async () => jsonResponse([release('v1.0.6'), release('v1.0.5')]);
  world.clock += DAY;
  await server.ops.tick();
  assert.deepEqual(await noticeIds(admin), ['update-1.0.6']);

  // Already running the version that was found: the stored answer must not nag.
  server.db.setSetting('ops.latestRelease', { version: '1.0.2', url: `${RELEASES}/v1.0.2` });
  assert.deepEqual(await noticeIds(admin), []);
});

test('tray item appears only when there is an update', () => {
  assert.deepEqual(updateMenuItems(null, () => {}), []);
  const opened = [];
  const [item, separator] = updateMenuItems({ version: '1.0.5', url: `${RELEASES}/v1.0.5` }, (u) => opened.push(u));
  assert.equal(item.label, 'Update available: 1.0.5');
  assert.equal(separator.type, 'separator');
  item.click();
  assert.deepEqual(opened, [`${RELEASES}/v1.0.5`]);
});

test('stopping the server during an update check is clean', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-test-'));
  let clock = Date.now();
  let requested;
  const seen = new Promise((resolve) => { requested = resolve; });
  const server = await createServer({
    dataDir, port: 0, host: '127.0.0.1',
    ops: {
      now: () => clock, discovery: false, tickMs: 3600000,
      fetch: () => {
        requested();
        return new Promise(() => {}); // would answer after the database closes
      },
    },
  });
  await server.start();
  clock += MINUTE;
  server.ops.tick();
  await seen;
  await server.stop();
  assert.equal(server.ops.availableUpdate(), null, 'the tray can still ask after the database closes');
  fs.rmSync(dataDir, { recursive: true, force: true });
});

function bareOps(t, host, deps) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-test-'));
  const db = openDb(path.join(dir, 'signage.db'));
  const hub = { adminRefresh() {}, isOnline: () => false };
  const ops = createOps({ db, hub, dataDir: dir, port: () => 9, host, deps: { statfs: statfsOf(200 * GB), addresses: () => ['192.168.1.20'], tickMs: 3600000, ...deps } });
  t.after(async () => {
    await ops.stop();
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return ops;
}

test('a server bound only to this computer contacts nothing unless a test asks it to', async (t) => {
  const realFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = realFetch; });
  let calls = 0;
  let bonjours = 0;
  globalThis.fetch = async () => {
    calls++;
    return jsonResponse([]);
  };
  let clock = Date.now();
  const createBonjour = async () => {
    bonjours++;
    return fakeBonjour();
  };

  const local = bareOps(t, '127.0.0.1', { now: () => clock, createBonjour });
  await local.start();
  clock += MINUTE;
  await local.tick();
  assert.equal(calls, 0);
  assert.equal(bonjours, 0);

  const everywhere = bareOps(t, '0.0.0.0', { now: () => clock, createBonjour });
  await everywhere.start();
  clock += MINUTE;
  await everywhere.tick();
  assert.equal(calls, 1, 'a normal install uses the real fetch');
  assert.equal(bonjours, 1, 'a normal install publishes');

  const optedOut = bareOps(t, '0.0.0.0', { now: () => clock, createBonjour, fetch: null, discovery: false });
  await optedOut.start();
  clock += MINUTE;
  await optedOut.tick();
  assert.equal(calls, 1);
  assert.equal(bonjours, 1);
});

// ---------- address changes ----------

test('address: the first address is stored silently, and a change raises a notice', async (t) => {
  const { base, world, server } = await opsServer(t);
  const admin = await setupAdmin(base);
  assert.deepEqual(await noticeIds(admin), []);
  assert.equal(server.db.getSetting('ops.lanAddress'), '192.168.1.20');

  await server.ops.tick();
  assert.deepEqual(await noticeIds(admin), [], 'no change, no notice');

  world.addresses = ['192.168.1.77'];
  await server.ops.tick();
  const [notice] = (await admin.get('/api/notices')).data;
  assert.equal(notice.id, 'address-192.168.1.77');
  assert.equal(notice.severity, 'warning');
  assert.equal(notice.dismissible, true);
  assert.match(notice.text, /192\.168\.1\.20/);
  assert.match(notice.text, /192\.168\.1\.77/);
  assert.match(notice.text, /router/);
  assert.equal(server.db.getSetting('ops.lanAddress'), '192.168.1.77');
});

test('address: having no address is not a change', async (t) => {
  const { base, world, server } = await opsServer(t);
  const admin = await setupAdmin(base);
  world.addresses = [];
  await server.ops.tick();
  assert.deepEqual(await noticeIds(admin), []);
  assert.equal(server.db.getSetting('ops.lanAddress'), '192.168.1.20', 'the last address is remembered');
  world.addresses = ['192.168.1.20'];
  await server.ops.tick();
  assert.deepEqual(await noticeIds(admin), [], 'the network came back on the same address');
});

test('address: starting with no network stores nothing, then the first address is silent', async (t) => {
  const { base, world, server } = await opsServer(t, {}, { addresses: [] });
  const admin = await setupAdmin(base);
  assert.equal(server.db.getSetting('ops.lanAddress', null), null);
  world.addresses = ['10.0.0.8'];
  await server.ops.tick();
  assert.equal(server.db.getSetting('ops.lanAddress'), '10.0.0.8');
  assert.deepEqual(await noticeIds(admin), []);
});

test('address: dismissal holds until the next change', async (t) => {
  const { base, world, server } = await opsServer(t);
  const admin = await setupAdmin(base);
  world.addresses = ['192.168.1.77'];
  await server.ops.tick();
  assert.equal((await admin.post('/api/notices/address-192.168.1.77/dismiss')).status, 200);
  assert.deepEqual(await noticeIds(admin), []);

  await server.ops.tick();
  await server.ops.tick();
  assert.deepEqual(await noticeIds(admin), [], 'stays dismissed');

  world.addresses = ['192.168.1.20'];
  await server.ops.tick();
  const [notice] = (await admin.get('/api/notices')).data;
  assert.equal(notice.id, 'address-192.168.1.20', 'the next change raises it again');
  assert.match(notice.text, /from 192\.168\.1\.77 to 192\.168\.1\.20/);
});

test('address: an undismissed notice tracks the address the TVs still use', async (t) => {
  const { base, world, server } = await opsServer(t);
  const admin = await setupAdmin(base);
  world.addresses = ['192.168.1.77'];
  await server.ops.tick();
  world.addresses = ['192.168.1.88'];
  await server.ops.tick();
  const [notice] = (await admin.get('/api/notices')).data;
  assert.match(notice.text, /from 192\.168\.1\.20 to 192\.168\.1\.88/);

  world.addresses = ['192.168.1.20'];
  await server.ops.tick();
  assert.deepEqual(await noticeIds(admin), [], 'back where the TVs expect it: nothing to fix');
});

test('address: a change while the app was closed is noticed at the next start', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-test-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const boot = (address) => createServer({
    dataDir, port: 0, host: '127.0.0.1',
    ops: { fetch: null, discovery: false, addresses: () => [address], statfs: statfsOf(200 * GB), tickMs: 3600000 },
  });
  const first = await boot('192.168.1.20');
  await first.start();
  await first.ops.tick();
  assert.equal(first.ops.notices({ permissions: ['screens.manage'] }).length, 0);
  await first.stop();

  const second = await boot('192.168.1.77');
  await second.start();
  await second.ops.tick();
  assert.deepEqual(second.ops.notices({ permissions: ['screens.manage'] }).map((n) => n.id), ['address-192.168.1.77']);
  assert.deepEqual(second.ops.notices({ permissions: [] }), []);
  await second.stop();
});

test('address: admins are told over the socket with the notices scope', async (t) => {
  const { base, port, world, server } = await opsServer(t);
  await setupAdmin(base);
  const login = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'ada', password: 'correct horse' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/admin`, { headers: { cookie } });
  t.after(() => ws.close());
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  const told = new Promise((resolve) => {
    ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data);
      if (msg.type === 'refresh' && msg.scopes.includes('notices')) resolve();
    });
  });
  world.addresses = ['192.168.1.77'];
  await server.ops.tick();
  await told;
});

// ---------- screen health ----------

test('screen health thresholds', () => {
  const now = 1000000000;
  const screen = (over) => ({ id: 'a', channel_id: 1, last_seen: now - OFFLINE_ALERT_MS - 1, created_at: 1, ...over });
  const check = (s, opts = {}) => screensNeedingAttention([s], { now, isOnline: () => false, ...opts }).length;
  assert.equal(check(screen()), 1, 'just over 5 minutes');
  assert.equal(check(screen({ last_seen: now - OFFLINE_ALERT_MS })), 0, 'exactly 5 minutes is not over');
  assert.equal(check(screen({ channel_id: null })), 0, 'unpaired');
  assert.equal(check(screen(), { isOnline: () => true }), 0, 'connected, even with an old heartbeat');
  assert.equal(check(screen({ last_seen: null, created_at: now - 10 * MINUTE })), 1, 'falls back to when it was added');
  assert.equal(check(screen({ last_seen: now - DAY }), { since: now - MINUTE }), 0, 'server only just began watching');
  assert.equal(check(screen({ last_seen: now - DAY }), { since: now - 6 * MINUTE }), 1);
});

async function pairedTv(port, deviceId, slug) {
  const p = player(port);
  await p.open;
  p.send({ type: 'hello', deviceId, slug });
  await p.next((m) => m.type === 'state');
  return p;
}

test('screen health: a paired TV gone for over 5 minutes needs attention, and coming back clears it', async (t) => {
  const { base, port, server, world, advance } = await opsServer(t);
  const admin = await setupAdmin(base);
  const [main] = (await admin.get('/api/channels')).data;
  const tv = await pairedTv(port, 'device-health-1', main.slug);
  await advance(10 * MINUTE);
  assert.deepEqual(await noticeIds(admin), [], 'online with a stale last_seen is still online');

  tv.close();
  await until(() => !server.hub.isOnline('device-health-1'));
  // Heartbeats use the real clock, so record the last one on the test's clock.
  server.db.run('UPDATE screens SET last_seen = ? WHERE id = ?', world.clock, 'device-health-1');

  await advance(5 * MINUTE);
  assert.deepEqual(await noticeIds(admin), [], 'exactly 5 minutes is not over 5');
  await advance(MINUTE);
  const [notice] = (await admin.get('/api/notices')).data;
  assert.equal(notice.id, 'screens-offline');
  assert.equal(notice.count, 1);
  assert.equal(notice.dismissible, false);
  assert.match(notice.text, /1 TV has been offline/);
  let row = (await admin.get('/api/screens')).data.find((s) => s.id === 'device-health-1');
  assert.equal(row.needsAttention, true);

  const back = await pairedTv(port, 'device-health-1', main.slug);
  t.after(() => back.close());
  assert.deepEqual(await noticeIds(admin), [], 'clears the moment it reconnects');
  row = (await admin.get('/api/screens')).data.find((s) => s.id === 'device-health-1');
  assert.equal(row.needsAttention, false);
});

test('screen health: unpaired, previews and removed screens do not count', async (t) => {
  const { base, port, server, advance } = await opsServer(t);
  const admin = await setupAdmin(base);
  const [main] = (await admin.get('/api/channels')).data;

  // Shows a pairing code, then vanishes.
  const unpaired = player(port);
  await unpaired.open;
  unpaired.send({ type: 'hello', deviceId: 'device-unpaired' });
  await unpaired.next((m) => m.type === 'pair');
  unpaired.close();

  const preview = player(port);
  await preview.open;
  preview.send({ type: 'hello', preview: true, slug: main.slug });
  await preview.next((m) => m.type === 'state');
  preview.close();

  const paired = await pairedTv(port, 'device-removed', main.slug);
  paired.close();
  await until(() => !server.hub.isOnline('device-removed') && !server.hub.isOnline('device-unpaired'));

  await advance(6 * MINUTE);
  assert.deepEqual(
    (await admin.get('/api/screens')).data.filter((s) => s.needsAttention).map((s) => s.id),
    ['device-removed'],
  );
  assert.equal((await admin.get('/api/notices')).data[0].count, 1);

  await admin.del('/api/screens/device-removed');
  assert.deepEqual(await noticeIds(admin), [], 'removing a screen clears it');
});

test('screen health: the server being down or asleep does not count against TVs', async (t) => {
  const { base, port, server, world, advance } = await opsServer(t);
  const admin = await setupAdmin(base);
  const [main] = (await admin.get('/api/channels')).data;
  const tv = await pairedTv(port, 'device-sleep', main.slug);
  tv.close();
  await until(() => !server.hub.isOnline('device-sleep'));

  world.clock += 8 * 60 * MINUTE; // the computer slept overnight
  await server.ops.tick();
  assert.deepEqual(await noticeIds(admin), [], 'TVs get a chance to reconnect after waking');
  await advance(4 * MINUTE);
  assert.deepEqual(await noticeIds(admin), []);
  await advance(2 * MINUTE);
  assert.deepEqual(await noticeIds(admin), ['screens-offline'], 'still gone, so now it counts');
});

// ---------- media cache full ----------

test('a TV reports a full cache in its heartbeat', async (t) => {
  const { base, port, server } = await opsServer(t);
  const admin = await setupAdmin(base);
  const [main] = (await admin.get('/api/channels')).data;
  const tv = await pairedTv(port, 'device-cache', main.slug);
  const row = async () => (await admin.get('/api/screens')).data.find((s) => s.id === 'device-cache');
  assert.equal((await row()).storageFull, false);

  tv.send({ type: 'hb', item: 'x', cacheFull: true });
  await until(async () => (await row()).storageFull === true);

  tv.send({ type: 'hb', item: 'x', cacheFull: false });
  await until(async () => (await row()).storageFull === false);

  tv.send({ type: 'hb', item: 'x', cacheFull: 'yes' });
  tv.send({ type: 'hb', item: 'x' });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal((await row()).storageFull, false, 'an older player that says nothing is not full');

  tv.send({ type: 'hb', item: 'x', cacheFull: true });
  await until(async () => (await row()).storageFull === true);
  tv.close();
  await until(() => !server.hub.isOnline('device-cache'));
  assert.equal((await row()).storageFull, false, 'only a connected TV reports this');
});

test('the player sends its cache state with each heartbeat', () => {
  const source = fs.readFileSync(new URL('../public/player/player.js', import.meta.url), 'utf8');
  assert.match(source, /type: 'hb'[^}]*cacheFull: MediaCache\.isFull\(\)/);
  assert.match(source, /isFull: function \(\) \{ return full; \}/);
});

// ---------- storage warnings ----------

test('storage thresholds: under 2 GB or under 10% free', () => {
  assert.equal(isLowStorage(2 * GB, 15 * GB), false, 'exactly 2 GB, above 10%');
  assert.equal(isLowStorage(2 * GB - 1, 15 * GB), true);
  assert.equal(isLowStorage(50 * GB, 500 * GB), false, 'exactly 10%');
  assert.equal(isLowStorage(50 * GB - 1, 500 * GB), true);
  assert.equal(isLowStorage(1000 * GB, 2000 * GB), false);
});

test('storage: warns from a reading taken on the ticker, and clears again', async (t) => {
  const { base, world, server } = await opsServer(t);
  const admin = await setupAdmin(base);
  assert.deepEqual(await noticeIds(admin), []);

  let reads = 0;
  world.statfs = async (dir) => {
    reads++;
    assert.ok(fs.existsSync(dir), 'asks about the data folder');
    return statfsOf(GB, 500 * GB)();
  };
  await server.ops.tick();
  const [notice] = (await admin.get('/api/notices')).data;
  assert.equal(notice.id, 'low-storage');
  assert.equal(notice.dismissible, false);
  assert.match(notice.text, /1\.0 GB free/);
  const before = reads;
  await admin.get('/api/notices');
  await admin.get('/api/ops/status');
  assert.equal(reads, before, 'requests never touch the disk');

  world.statfs = statfsOf(49 * GB);
  await server.ops.tick();
  assert.deepEqual(await noticeIds(admin), ['low-storage'], 'under 10% of 500 GB');

  world.statfs = statfsOf(200 * GB);
  await server.ops.tick();
  assert.deepEqual(await noticeIds(admin), []);
});

test('storage: a failed or nonsense reading raises no alarm and breaks nothing', async (t) => {
  const { base, world, server } = await opsServer(t);
  const admin = await setupAdmin(base);
  world.statfs = async () => { throw new Error('EIO'); };
  await server.ops.tick();
  assert.deepEqual(await noticeIds(admin), []);
  assert.equal((await admin.get('/api/ops/status')).data.storage.free, 200 * GB, 'the last reading stays');

  const fresh = createStorageWatcher({ dataDir: '/x', statfs: async () => ({ bsize: 0, bavail: 0, blocks: 0 }) });
  await fresh.check();
  assert.equal(fresh.snapshot(), null);
});

test('settings status reports library size and free space', async (t) => {
  const { base, server } = await opsServer(t);
  const admin = await setupAdmin(base);
  assert.equal((await admin.get('/api/ops/status')).data.librarySize, 0);
  const add = (id, size) => server.db.run("INSERT INTO media (id, type, name, size, created_at) VALUES (?, 'image', 'x', ?, 1)", id, size);
  add('a', 3 * GB);
  add('b', GB);
  add('c', null);
  const status = (await admin.get('/api/ops/status')).data;
  assert.equal(status.librarySize, 4 * GB);
  assert.equal(status.storage.free, 200 * GB);
  assert.equal(status.storage.total, 500 * GB);
  assert.equal(status.storage.low, false);
});

// ---------- who sees what ----------

test('/api/notices: signed out 401, editors get only low storage, admins get everything', async (t) => {
  const { base, port, world, server, advance } = await opsServer(t);
  const admin = await setupAdmin(base);
  const editor = await makeEditor(admin, base, 'eddie');
  const anon = client(base);
  assert.equal((await anon.get('/api/notices')).status, 401);
  assert.deepEqual((await editor.get('/api/notices')).data, []);
  assert.deepEqual((await admin.get('/api/notices')).data, []);

  const [main] = (await admin.get('/api/channels')).data;
  const tv = await pairedTv(port, 'device-perms', main.slug);
  tv.close();
  await until(() => !server.hub.isOnline('device-perms'));
  world.respond = async () => jsonResponse([release('v1.0.5')]);
  world.addresses = ['192.168.1.77'];
  world.statfs = statfsOf(GB);
  await advance(6 * MINUTE);

  const all = (await admin.get('/api/notices')).data;
  assert.deepEqual(all.map((n) => n.id).sort(), ['address-192.168.1.77', 'low-storage', 'screens-offline', 'update-1.0.5']);
  for (const n of all) {
    assert.equal(typeof n.text, 'string');
    assert.ok(['info', 'warning'].includes(n.severity));
    assert.equal(typeof n.dismissible, 'boolean');
  }
  assert.deepEqual(await noticeIds(editor), ['low-storage']);
  assert.equal((await anon.get('/api/notices')).status, 401);

  assert.equal((await anon.post('/api/notices/update-1.0.5/dismiss')).status, 401);
  assert.equal((await editor.post('/api/notices/update-1.0.5/dismiss')).status, 403);
  assert.equal((await admin.post('/api/notices/low-storage/dismiss')).status, 404, 'not dismissible');
  assert.equal((await admin.post('/api/notices/screens-offline/dismiss')).status, 404, 'not dismissible');
  assert.equal((await admin.post('/api/notices/made-up/dismiss')).status, 404);
  assert.ok((await noticeIds(admin)).includes('update-1.0.5'));

  assert.equal((await anon.get('/api/ops/status')).status, 401);
  assert.equal((await editor.put('/api/ops/settings', { checkForUpdates: false })).status, 403);
  assert.equal((await admin.put('/api/ops/settings', { checkForUpdates: 'no' })).status, 400);
  assert.equal(server.db.getSetting('ops.checkForUpdates', true), true);
});

// ---------- discovery (through a fake, so tests stay off the real network) ----------

function fakeBonjour(log = []) {
  return {
    publish(config) {
      log.push(['publish', config]);
      return { on() {} };
    },
    unpublishAll(done) {
      log.push(['unpublishAll']);
      done();
    },
    destroy(done) {
      log.push(['destroy']);
      done();
    },
  };
}

test('discovery publishes the service and version, and close unpublishes', async (t) => {
  const log = [];
  const { port, server } = await opsServer(t, { discovery: true, createBonjour: async () => fakeBonjour(log) });
  const [, config] = log.find(([what]) => what === 'publish');
  assert.equal(config.type, 'network-signage');
  assert.equal(config.port, port);
  assert.deepEqual(config.txt, { version: '1.0.2', id: server.db.getSetting('ops.serverId', null) });
  assert.match(config.txt.id, /^[0-9a-f-]{36}$/);
  assert.match(config.host, /^[^.]+\.local$/);
  assert.deepEqual(log.map(([what]) => what), ['publish']);

  await server.ops.tick();
  assert.deepEqual(log.map(([what]) => what), ['publish'], 'once per address');

  await server.ops.stop();
  assert.deepEqual(log.map(([what]) => what), ['publish', 'unpublishAll', 'destroy']);
});

test('discovery publishes again when the address changes, not when the network drops', async (t) => {
  const log = [];
  const { world, server } = await opsServer(t, { discovery: true, createBonjour: async () => fakeBonjour(log) });
  world.addresses = [];
  await server.ops.tick();
  assert.deepEqual(log.map(([what]) => what), ['publish']);
  world.addresses = ['192.168.1.77'];
  await server.ops.tick();
  assert.deepEqual(log.map(([what]) => what), ['publish', 'unpublishAll', 'destroy', 'publish']);
});

test('discovery publishes again when the network comes back on the same address', async (t) => {
  const log = [];
  const { world, server } = await opsServer(t, { discovery: true, createBonjour: async () => fakeBonjour(log) });
  world.addresses = [];
  await server.ops.tick();
  world.addresses = ['192.168.1.20'];
  await server.ops.tick();
  assert.deepEqual(log.map(([what]) => what), ['publish', 'unpublishAll', 'destroy', 'publish']);
  await server.ops.tick();
  assert.equal(log.filter(([what]) => what === 'publish').length, 2, 'and only once');
});

test('discovery publishes again after the computer wakes, even on the same address', async (t) => {
  const log = [];
  const { world, server } = await opsServer(t, { discovery: true, createBonjour: async () => fakeBonjour(log) });
  await server.ops.tick();
  world.clock += MINUTE;
  await server.ops.tick();
  assert.equal(log.filter(([what]) => what === 'publish').length, 1, 'a normal gap changes nothing');
  world.clock += 5 * MINUTE;
  await server.ops.tick();
  assert.equal(log.filter(([what]) => what === 'publish').length, 2);
  world.clock += MINUTE;
  await server.ops.tick();
  assert.equal(log.filter(([what]) => what === 'publish').length, 2);
});

test('discovery retries after an error on a later tick, backing off instead of storming', async () => {
  let clock = 1000000;
  let attempts = 0;
  let healthy = false;
  const warnings = [];
  const discovery = createDiscovery({
    port: () => 9,
    version: '1.0.2',
    now: () => clock,
    log: { warn: ({ err }) => warnings.push(err.message) },
    createBonjour: async () => {
      attempts++;
      if (!healthy) throw new Error('no network yet');
      return fakeBonjour();
    },
  });
  const tick = (ms) => {
    clock += ms;
    return discovery.sync('192.168.1.20');
  };
  await tick(0);
  assert.equal(attempts, 1);
  await tick(0);
  await tick(30000);
  assert.equal(attempts, 1, 'not on the very next tick');
  await tick(30000);
  assert.equal(attempts, 2, 'after a minute');
  await tick(60000);
  assert.equal(attempts, 2, 'the wait doubles');
  await tick(60000);
  assert.equal(attempts, 3);
  for (let i = 0; i < 200; i++) await tick(30000);
  assert.ok(attempts <= 3 + 7 + 3, `${attempts} tries in 100 minutes`);
  assert.equal(warnings.length, attempts);

  healthy = true;
  await tick(20 * MINUTE);
  const settled = attempts;
  await tick(20 * MINUTE);
  assert.equal(attempts, settled, 'once it works, it stays put');
  await discovery.stop();
});

test('an error from the library itself is retried too, once per failure', async () => {
  let clock = 1000000;
  const handlers = [];
  const log = [];
  const discovery = createDiscovery({
    port: () => 9,
    version: '1.0.2',
    now: () => clock,
    log: { warn() {} },
    createBonjour: async (onFatal) => {
      handlers.push(onFatal);
      return fakeBonjour(log);
    },
  });
  await discovery.sync('192.168.1.20');
  handlers[0](new Error('bind failed'));
  handlers[0](new Error('bind failed again'));
  await discovery.sync('192.168.1.20');
  assert.deepEqual(log.map(([what]) => what), ['publish', 'unpublishAll', 'destroy'], 'the down state sticks for now');
  clock += 60000;
  await discovery.sync('192.168.1.20');
  assert.deepEqual(log.map(([what]) => what), ['publish', 'unpublishAll', 'destroy', 'publish']);
  clock += 60000;
  handlers[0](new Error('from the instance already replaced'));
  await discovery.sync('192.168.1.20');
  assert.equal(log.filter(([what]) => what === 'publish').length, 2, 'a stale error changes nothing');
  await discovery.stop();
});

test('the SRV target always ends in .local, whatever the hostname looks like', () => {
  assert.equal(hostName('DESKTOP-AB12'), 'DESKTOP-AB12.local');
  assert.equal(hostName('Owens-Mac.local'), 'Owens-Mac.local');
  assert.equal(hostName('server.school.example'), 'server.local');
  assert.equal(hostName('My Host_1'), 'My-Host-1.local');
  assert.equal(hostName(''), 'network-signage.local');
  assert.equal(hostName('---'), 'network-signage.local');
  assert.equal(hostName('x'.repeat(100)).length, 63 + '.local'.length);
});

test('the server ID is made once, and stays through a restart and a copy of the database', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-test-'));
  const restored = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-test-'));
  t.after(() => {
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(restored, { recursive: true, force: true });
  });
  const published = [];
  const createBonjour = async () => ({
    ...fakeBonjour(),
    publish(config) {
      published.push(config.txt.id);
      return { on() {} };
    },
  });
  const boot = async (dir) => {
    const server = await createServer({
      dataDir: dir, port: 0, host: '127.0.0.1',
      ops: { fetch: null, discovery: true, createBonjour, addresses: () => ['192.168.1.20'], statfs: statfsOf(200 * GB), tickMs: 3600000 },
    });
    await server.start();
    await server.ops.tick();
    await server.stop();
  };
  await boot(dataDir);
  await boot(dataDir);
  fs.copyFileSync(path.join(dataDir, 'signage.db'), path.join(restored, 'signage.db'));
  await boot(restored);
  assert.equal(published.length, 3);
  assert.equal(new Set(published).size, 1);
  assert.match(published[0], /^[0-9a-f-]{36}$/);

  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-test-'));
  t.after(() => fs.rmSync(other, { recursive: true, force: true }));
  await boot(other);
  assert.notEqual(published[3], published[0], 'a separate install gets its own');
});

test('discovery failing cannot stop the server', async (t) => {
  const failures = {
    'cannot load or start': async () => { throw new Error('no bonjour'); },
    'publish throws': async () => ({ ...fakeBonjour(), publish() { throw new Error('bad publish'); } }),
    'teardown throws': async () => ({
      publish: () => ({ on() {} }),
      unpublishAll() { throw new Error('bad unpublish'); },
      destroy() { throw new Error('bad destroy'); },
    }),
    'teardown never finishes': async () => ({ publish: () => ({ on() {} }), unpublishAll() {}, destroy(done) { done(); } }),
    'fails later on its own': async (onError) => {
      setTimeout(() => onError(new Error('late failure')), 5);
      return fakeBonjour();
    },
  };
  for (const [name, createBonjour] of Object.entries(failures)) {
    const { base, server } = await opsServer(t, { discovery: true, createBonjour });
    await new Promise((r) => setTimeout(r, 20));
    await server.ops.tick();
    const admin = await setupAdmin(base);
    assert.equal((await admin.get('/api/notices')).status, 200, name);
  }
});

test('a real bind failure in the mDNS library reaches the log instead of crashing', async (t) => {
  // Everything here stays on loopback: the port is already taken, so nothing gets sent.
  const holder = dgram.createSocket({ type: 'udp4', reuseAddr: false });
  await new Promise((resolve) => holder.bind(0, '127.0.0.1', resolve));
  t.after(() => holder.close());
  const errors = [];
  let reported;
  const failed = new Promise((resolve) => { reported = resolve; });
  const discovery = createDiscovery({
    port: () => 9,
    version: '1.0.2',
    log: { warn: ({ err }) => { errors.push(err); reported(); } },
    createBonjour: (onFatal, onTransient) => realBonjour(onFatal, onTransient, {
      port: holder.address().port, bind: '127.0.0.1', interface: '127.0.0.1', reuseAddr: false, multicast: false,
    }),
  });
  await discovery.sync('192.168.1.20');
  await failed;
  await discovery.stop();
  assert.equal(errors[0].code, 'EADDRINUSE');
});

test('a failed send only gets noted: the service stays published for when it works again', async () => {
  const log = [];
  const notes = [];
  let transient;
  const discovery = createDiscovery({
    port: () => 9,
    version: '1.0.2',
    log: { debug: ({ err }) => notes.push(err.code), warn() { throw new Error('not a warning'); } },
    createBonjour: async (onFatal, onTransient) => {
      transient = onTransient;
      return fakeBonjour(log);
    },
  });
  await discovery.sync('192.168.1.20');
  transient(Object.assign(new Error('send failed'), { code: 'EHOSTUNREACH' }));
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(notes, ['EHOSTUNREACH']);
  assert.deepEqual(log.map(([what]) => what), ['publish']);
  await discovery.stop();
});

test('the real mDNS library publishes, can be browsed, and says goodbye', async () => {
  // One instance talking to itself by unicast on loopback: no multicast, and nothing leaves this computer.
  const probe = dgram.createSocket('udp4');
  await new Promise((resolve) => probe.bind(0, '127.0.0.1', resolve));
  const { port: mdnsPort } = probe.address();
  await new Promise((resolve) => probe.close(resolve));

  let instance;
  const sent = [];
  const errors = [];
  const discovery = createDiscovery({
    port: () => 18473,
    version: '1.2.3',
    name: 'Loopback Test',
    id: 'test-id',
    host: 'signage-host.local',
    addresses: () => ['192.168.50.9'],
    log: { warn: ({ err }) => errors.push(err) },
    createBonjour: async (onFatal, onTransient) => {
      instance = await realBonjour(onFatal, onTransient, { ip: '127.0.0.1', port: mdnsPort, bind: '127.0.0.1', multicast: false });
      const { mdns } = instance.server;
      const respond = mdns.respond;
      mdns.respond = (records, ...rest) => {
        sent.push(records);
        return respond(records, ...rest);
      };
      return instance;
    },
  });
  await discovery.sync('127.0.0.1');
  const found = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the service was not found')), 5000);
    instance.find({ type: 'network-signage' }, (service) => {
      clearTimeout(timer);
      resolve(service);
    });
  });
  assert.equal(found.name, 'Loopback Test');
  assert.equal(found.port, 18473);
  assert.deepEqual(found.txt, { version: '1.2.3', id: 'test-id' });
  assert.equal(found.fqdn, 'Loopback Test._network-signage._tcp.local');
  assert.equal(found.host, 'signage-host.local');
  assert.deepEqual(found.addresses, ['192.168.50.9'], 'only addresses the app itself would use');
  const records = sent.flat().filter((r) => r.type === 'A' || r.type === 'AAAA');
  assert.ok(records.length > 0);
  for (const r of records) assert.deepEqual([r.type, r.name, r.data], ['A', 'signage-host.local', '192.168.50.9']);

  await discovery.stop();
  const goodbye = sent.flat().find((r) => r.type === 'PTR' && r.ttl === 0 && r.name === '_network-signage._tcp.local');
  assert.ok(goodbye, 'closing announces that the service is gone');
  assert.deepEqual(errors, []);
});

// Two real library instances that hear each other by unicast on loopback, as two hosts would.
async function twoHosts(t) {
  const socket = () => new Promise((resolve) => {
    const s = dgram.createSocket('udp4');
    s.bind(0, '127.0.0.1', () => resolve(s));
  });
  const [a, b] = [await socket(), await socket()];
  const host = (mine, theirs, name, id, addresses) => {
    const sent = [];
    let instance;
    const discovery = createDiscovery({
      port: () => 18473, version: '1.2.3', name, id, host: `${id}.local`, addresses: () => addresses,
      log: { warn() {} },
      createBonjour: async (onFatal, onTransient) => {
        instance = await realBonjour(onFatal, onTransient, { socket: mine, ip: '127.0.0.1', port: theirs.address().port, bind: false, multicast: false });
        const { mdns } = instance.server;
        const respond = mdns.respond;
        mdns.respond = (records, ...rest) => {
          sent.push(...(records.answers ?? records));
          return respond(records, ...rest);
        };
        return instance;
      },
    });
    return { discovery, sent, instance: () => instance };
  };
  const first = host(a, b, 'Same Name', 'first', ['192.168.50.1']);
  const second = host(b, a, 'Same Name', 'second', ['192.168.50.2']);
  t.after(async () => {
    await first.discovery.stop();
    await second.discovery.stop();
  });
  return { first, second };
}

const names = (sent) => sent.filter((r) => r.type === 'PTR' && r.name === '_network-signage._tcp.local' && r.ttl !== 0).map((r) => r.data);

test('a second host with the same name still gets published, under a suffixed name', async (t) => {
  const { first, second } = await twoHosts(t);
  await first.discovery.sync('192.168.50.1');
  await until(() => names(first.sent).length > 0);
  await second.discovery.sync('192.168.50.2');
  await until(() => names(second.sent).includes('Same Name (2)._network-signage._tcp.local'));
  assert.ok(!names(second.sent).includes('Same Name._network-signage._tcp.local'), 'the taken name is never claimed');

  const goodbyes = second.sent.filter((r) => r.ttl === 0);
  assert.deepEqual(goodbyes, [], 'and giving it up does not tell TVs the first host has gone');

  const found = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('the second host was not found')), 5000);
    first.instance().find({ type: 'network-signage' }, (service) => {
      if (service.txt.id !== 'second') return;
      clearTimeout(timer);
      resolve(service);
    });
  });
  assert.equal(found.name, 'Same Name (2)');
  assert.deepEqual(found.addresses, ['192.168.50.2']);
});

test('a suffixed name still fits a DNS label', () => {
  assert.equal(uniqueName('Short', 1), 'Short');
  assert.equal(uniqueName('Short', 2), 'Short (2)');
  const long = uniqueName(`Network Signage on ${'é'.repeat(60)}`, 3);
  assert.ok(Buffer.byteLength(long) <= 63, long);
  assert.ok(long.endsWith(' (3)'));
});
