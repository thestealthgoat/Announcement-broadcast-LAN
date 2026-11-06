import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { startServer, setupAdmin } from './helpers.js';
import { createUpdater } from '../electron/updater.js';
import { updateFeedUrl, updateMenuItems } from '../server/ops/updates.js';
import { updateFeed } from '../scripts/make-update-feed.mjs';

const UPDATE = { version: '9.0.0', url: 'https://github.com/thestealthgoat/Announcement-broadcast-LAN/releases/tag/v9.0.0' };
const tick = () => new Promise((resolve) => setImmediate(resolve));

function harness({ available = true, stopFails = false, native = null, quitTimeoutMs } = {}) {
  const calls = [];
  const auto = new EventEmitter();
  auto.setFeedURL = (feed) => calls.push(['feed', feed]);
  auto.checkForUpdates = async () => (available ? { isUpdateAvailable: true } : { isUpdateAvailable: false });
  auto.downloadUpdate = async () => calls.push(['download']);
  auto.quitAndInstall = (...args) => calls.push(['install', ...args]);
  const updater = createUpdater({
    autoUpdater: auto,
    nativeUpdater: native,
    quitTimeoutMs,
    version: '2.0.2',
    stop: async () => {
      calls.push(['stop']);
      if (stopFails) throw new Error('stuck');
    },
    relaunch: () => calls.push(['relaunch']),
  });
  return { auto, calls, updater, names: () => calls.map((c) => c[0]) };
}

test('nothing downloads or installs until someone asks', async () => {
  const { auto, calls, updater } = harness();
  assert.equal(auto.autoDownload, false);
  assert.equal(auto.autoInstallOnAppQuit, false);
  await tick();
  assert.deepEqual(calls, []);
  assert.equal(updater.status().phase, 'idle');
  assert.equal(updater.status().current, '2.0.2');
});

test('downloads from the release the check found, then stops the server before installing', async () => {
  const { auto, calls, updater, names } = harness();
  assert.equal(updater.start(UPDATE).phase, 'downloading');
  await tick();
  assert.deepEqual(calls[0], ['feed', { provider: 'generic', url: 'https://github.com/thestealthgoat/Announcement-broadcast-LAN/releases/download/v9.0.0/' }]);
  auto.emit('download-progress', { percent: 41.6 });
  assert.equal(updater.status().percent, 42);
  auto.emit('update-downloaded');
  assert.equal(updater.status().phase, 'installing');
  await tick();
  assert.deepEqual(names(), ['feed', 'download', 'stop', 'install']);
  assert.deepEqual(calls.at(-1), ['install', true, true], 'silent on Windows, and reopens afterward');
});

test('a second click while one is running does nothing', async () => {
  const { calls, updater } = harness();
  updater.start(UPDATE);
  updater.start(UPDATE);
  await tick();
  assert.equal(calls.filter((c) => c[0] === 'download').length, 1);
});

test('a failed download keeps the app running, reports it, and can be tried again', async () => {
  const { auto, updater, names } = harness();
  updater.start(UPDATE);
  await tick();
  auto.emit('error', new Error('network'));
  assert.equal(updater.status().phase, 'error');
  assert.match(updater.status().error, /still running/);
  assert.ok(!names().includes('stop'));
  assert.equal(updater.start(UPDATE).phase, 'downloading');
  assert.equal(updater.status().error, null);
});

test('no update found at the address is a failure, not silence', async () => {
  const { updater, names } = harness({ available: false });
  updater.start(UPDATE);
  await tick();
  await tick();
  assert.equal(updater.status().phase, 'error');
  assert.ok(!names().includes('download'));
});

test('a failure after the server stopped brings the app back', async () => {
  const stuck = harness({ stopFails: true });
  stuck.updater.start(UPDATE);
  stuck.auto.emit('update-downloaded');
  await tick();
  assert.ok(stuck.names().includes('relaunch'));
  assert.ok(!stuck.names().includes('install'));

  const refused = harness();
  refused.updater.start(UPDATE);
  refused.auto.emit('update-downloaded');
  await tick();
  refused.auto.emit('error', new Error('could not swap the app'));
  assert.ok(refused.names().includes('relaunch'));
});

test('on a Mac the server stays up until the native updater has its copy', async () => {
  const native = new EventEmitter();
  const { auto, updater, names } = harness({ native });
  assert.equal(auto.autoInstallOnAppQuit, true);
  updater.start(UPDATE);
  await tick();
  auto.emit('update-downloaded');
  await tick();
  assert.equal(updater.status().phase, 'downloading');
  assert.ok(!names().includes('stop'));
  native.emit('update-downloaded');
  await tick();
  assert.deepEqual(names().slice(-2), ['stop', 'install']);
});

test('an app that never quits to install comes back by itself', async () => {
  const { auto, updater, names } = harness({ quitTimeoutMs: 5 });
  updater.start(UPDATE);
  await tick();
  auto.emit('update-downloaded');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.deepEqual(names().slice(-3), ['stop', 'install', 'relaunch']);
});

test('the feed address comes from the release page', () => {
  assert.equal(updateFeedUrl(UPDATE), 'https://github.com/thestealthgoat/Announcement-broadcast-LAN/releases/download/v9.0.0/');
});

test('the tray installs when it can, and opens the release page when it cannot', () => {
  const seen = [];
  const [hand] = updateMenuItems(UPDATE, (u) => seen.push(u));
  hand.click();
  assert.deepEqual(seen, [UPDATE.url]);
  const [auto] = updateMenuItems(UPDATE, () => assert.fail('should install'), (u) => seen.push(u));
  assert.match(auto.label, /Install version 9\.0\.0/);
  auto.click();
  assert.equal(seen.at(-1), UPDATE);
});

test('the feed lists each download with a checksum the updater can read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-feed-'));
  try {
    fs.writeFileSync(path.join(dir, 'a-arm64.zip'), 'one');
    fs.writeFileSync(path.join(dir, 'a-x64.zip'), 'three');
    const require = createRequire(import.meta.url);
    const { load } = require('js-yaml');
    const feed = load(updateFeed(dir, '2.0.2', ['a-arm64.zip', 'a-x64.zip'], new Date(0)));
    assert.equal(feed.version, '2.0.2');
    assert.deepEqual(feed.files.map((f) => [f.url, f.size]), [['a-arm64.zip', 3], ['a-x64.zip', 5]]);
    assert.equal(feed.files[0].sha512, createHash('sha512').update('one').digest('base64'));
    assert.equal(feed.sha512, feed.files[0].sha512);
    assert.equal(feed.path, 'a-arm64.zip');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the admin can start an install, and only when there is a release and a way to install it', async (t) => {
  const started = [];
  const updater = {
    start: (u) => {
      started.push(u);
      return { current: '2.0.2', phase: 'downloading' };
    },
    status: () => ({ current: '2.0.2', phase: 'downloading', percent: 5 }),
  };
  const { base, server } = await startServer(t, { updater, ops: { canInstallUpdates: true, version: '2.0.2' } });
  const admin = await setupAdmin(base);
  assert.equal((await admin.post('/api/updates/install', {})).status, 409, 'nothing to install yet');

  server.db.setSetting('ops.latestRelease', UPDATE);
  const notice = (await admin.get('/api/notices')).data.find((n) => n.kind === 'update');
  assert.equal(notice.canInstall, true);
  assert.equal(notice.version, '9.0.0');
  assert.equal((await admin.post('/api/updates/install', {})).status, 200);
  assert.deepEqual(started, [UPDATE]);
  assert.equal((await admin.get('/api/updates/status')).data.percent, 5);
});

test('a copy with no updater says so, and its notice offers only the release page', async (t) => {
  const { base, server } = await startServer(t, { ops: { version: '2.0.2' } });
  const admin = await setupAdmin(base);
  server.db.setSetting('ops.latestRelease', UPDATE);
  const notice = (await admin.get('/api/notices')).data.find((n) => n.kind === 'update');
  assert.equal(notice.canInstall, false);
  assert.equal(notice.link.href, UPDATE.url);
  const res = await admin.post('/api/updates/install', {});
  assert.equal(res.status, 409);
  assert.match(res.data.error, /by hand/);
  assert.equal((await admin.get('/api/updates/status')).data.current, '2.0.2');
});

test('the Mac installer hands the app to the signed-in user, only after ruling out root', () => {
  const script = fs.readFileSync(path.join(import.meta.dirname, '..', 'build', 'pkg-scripts', 'postinstall'), 'utf8');
  assert.ok(script.indexOf('chown') > script.indexOf('loginwindow'));
  assert.equal(spawnSync('/bin/sh', ['-n', path.join(import.meta.dirname, '..', 'build', 'pkg-scripts', 'postinstall')]).status, 0, 'parses, without running');
});
