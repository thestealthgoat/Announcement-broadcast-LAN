// Backup and restore through real HTTP, with real servers on temporary data folders.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server/index.js';
import { hashPassword } from '../server/auth.js';
import { PERMISSIONS } from '../server/permissions.js';
import { readTar, paxRecord } from '../server/backup/tar.js';
import { latestSchemaVersion } from '../server/db.js';
import { RESTORE_CONFIRMATION } from '../server/routes/backup.js';
import { restartApp } from '../electron/restart.js';
import { client, form, player, setupAdmin, waitForMedia } from './helpers.js';
import { craftArchive, dumpDb, makeDb, sha256, tarEntry, tmpDir, treeHashes } from './backup-helpers.js';

const ALL = PERMISSIONS.map((p) => p.key);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const CLI = fileURLToPath(new URL('../server/cli.js', import.meta.url));
const OPS = { fetch: null, discovery: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const restoreUrl = `/api/backup/restore?confirm=${RESTORE_CONFIRMATION}`;

// Takes no real disk space, and is far bigger than any socket buffer.
function sparseFile(file, size) {
  fs.writeFileSync(file, '');
  fs.truncateSync(file, size);
}

async function waitFor(what, check, ms = 15000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

// A server this test can stop and start again on the same data, as a real restart would.
async function boot(t, dataDir = tmpDir(t), opts = {}) {
  const { ops = {}, ...rest } = opts;
  const server = await createServer({ dataDir, port: 0, host: '127.0.0.1', ops: { ...OPS, ...ops }, ...rest });
  const { port } = await server.start();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await server.stop();
  };
  t.after(stop);
  return { server, port, base: `http://127.0.0.1:${port}`, dataDir, stop };
}

async function signIn(base, username = 'ada', password = 'correct horse') {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
  assert.equal(res.status, 200);
  return res.headers.get('set-cookie').split(';')[0];
}

async function downloadBackup(base, cookie) {
  const res = await fetch(`${base}/api/backup/export`, { headers: { cookie } });
  assert.equal(res.status, 200, await (res.status === 200 ? '' : res.clone().text()));
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.equal(Number(res.headers.get('content-length')), bytes.length, 'the stated length is exact');
  return { bytes, headers: res.headers };
}

async function listArchive(bytes) {
  const out = new Map();
  await readTar(Readable.from([bytes], { objectMode: false }), async (entry) => {
    const parts = [];
    out.set(entry.name, { ...entry, parts });
    return { write: async (b) => { parts.push(Buffer.from(b)); }, end: async () => {} };
  });
  return new Map([...out].map(([name, e]) => [name, { ...e, data: Buffer.concat(e.parts) }]));
}

function post(base, url, bytes, cookie) {
  return fetch(base + url, { method: 'POST', headers: cookie ? { cookie } : {}, body: form('x.signagebackup', bytes, 'application/octet-stream') })
    .then(async (res) => ({ status: res.status, data: await res.json() }));
}

// Sends a multipart upload in two parts, so the test can act while it is under way.
function pausedUpload(base, url, bytes, { cookie, splitAt = Math.floor(bytes.length / 2) } = {}) {
  const boundary = '----pausedupload';
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.signagebackup"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const foot = Buffer.from(`\r\n--${boundary}--\r\n`);
  let release;
  const released = new Promise((r) => { release = r; });
  const abort = new AbortController();
  const body = new ReadableStream({
    async start(controller) {
      controller.enqueue(head);
      controller.enqueue(bytes.subarray(0, splitAt));
      await released;
      controller.enqueue(bytes.subarray(splitAt));
      controller.enqueue(foot);
      controller.close();
    },
  });
  const response = fetch(base + url, {
    method: 'POST', body, duplex: 'half', signal: abort.signal,
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, ...(cookie ? { cookie } : {}) },
  }).then(async (res) => ({ status: res.status, data: await res.json() }));
  return { response, finish: release, abort: () => abort.abort() };
}

// Sets up one of everything that has to survive a move. Goes through the API, as an admin would.
async function seed(base, server, dataDir) {
  const admin = await setupAdmin(base);
  const role = (await admin.post('/api/roles', { name: 'Coach', permissions: ['library.upload', 'library.own', 'channels.add'] })).data;
  const madeUser = await admin.post('/api/users', { username: 'coach', name: 'Coach Kim', password: 'coach-password', roleId: role.id });
  assert.equal(madeUser.status, 200, JSON.stringify(madeUser.data));
  const channel = (await admin.post('/api/channels', { name: 'Gym' })).data;

  const image = (await admin.post(`/api/media?channelId=${channel.id}`, form('photo.png', PNG, 'image/png'))).data;
  await waitForMedia(admin, image.id);
  const text = (await admin.post('/api/media/text', { title: 'Game night', body: 'Friday at 7' })).data;
  const items = (await admin.post(`/api/channels/${channel.id}/items`, { mediaId: text.id })).data;
  const placed = items.find((i) => i.mediaId === text.id) ?? items.at(-1);
  const scheduled = await admin.patch(`/api/playlist-items/${placed.id}`, { duration: 12, schedule: { startDate: '2026-01-01', endDate: '2030-12-31', startTime: '08:00', endTime: '17:00', days: 62 } });
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.data));

  await admin.post('/api/branding/logo', form('logo.png', PNG, 'image/png'));
  await admin.put('/api/branding', { orgName: 'Lincoln High', accentColor: '#ff0000' });

  const tv = player(server.port ?? new URL(base).port);
  await tv.open;
  tv.send({ type: 'hello', deviceId: 'device-lobby' });
  const { code } = await tv.next((m) => m.type === 'pair');
  assert.equal((await admin.post('/api/pair', { code, channelId: channel.id, name: 'Lobby TV' })).status, 200);
  tv.close();

  fs.writeFileSync(path.join(dataDir, 'config.json'), '{"port":9001}');
  const media = fs.readdirSync(path.join(dataDir, 'media'));
  assert.ok(media.includes(image.id) && media.includes('branding'));
  return { admin, channel, image, text };
}

// Files that sit in a real data folder and must never reach a backup.
function addFilesToLeaveOut(dataDir, imageId) {
  fs.mkdirSync(path.join(dataDir, 'live', 'feed-1'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'live', 'feed-1', 'seg-1.ts'), 'live segment');
  fs.writeFileSync(path.join(dataDir, '.autostart-configured'), '');
  fs.writeFileSync(path.join(dataDir, 'media', imageId, 'upload.tmp'), 'half an upload');
  fs.mkdirSync(path.join(dataDir, '.restore', 'safety'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, '.restore', 'safety', 'old.txt'), 'previous safety copy');
  fs.writeFileSync(path.join(dataDir, 'Cookies'), 'electron cookies');
  fs.mkdirSync(path.join(dataDir, 'GPUCache'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'GPUCache', 'data_0'), 'electron cache');
}

const IGNORED_SETTINGS = ['ops.lanAddress', 'ops.addressNotice', 'backup.lastRestore'];

test('round trip: everything moves to a new data folder through real HTTP', async (t) => {
  const source = await boot(t);
  const { admin, channel, image } = await seed(source.base, source.server, source.dataDir);
  addFilesToLeaveOut(source.dataDir, image.id);
  const cookie = await signIn(source.base);
  const sessionsBefore = source.server.db.get('SELECT COUNT(*) AS n FROM sessions').n;
  assert.ok(sessionsBefore > 0);
  const tokenHashes = source.server.db.all('SELECT token_hash FROM sessions').map((r) => r.token_hash);

  const { bytes, headers } = await downloadBackup(source.base, cookie);
  assert.match(headers.get('content-disposition'), /attachment; filename="network-signage-\d{4}-\d{2}-\d{2}\.signagebackup"/);
  assert.equal(headers.get('cache-control'), 'no-store');

  const entries = await listArchive(bytes);
  const names = [...entries.keys()];
  assert.equal(names[0], 'manifest.json', 'the manifest comes first');
  assert.equal(names.at(-1), 'checksums.jsonl', 'the checksums come last');
  const manifest = JSON.parse(entries.get('manifest.json').data);
  assert.equal(manifest.format, 'network-signage-backup');
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.schemaVersion, latestSchemaVersion());
  assert.equal(manifest.fileCount, names.length - 2);
  assert.equal(manifest.totalSize, names.slice(1, -1).reduce((n, name) => n + entries.get(name).data.length, 0));
  assert.ok(Date.parse(manifest.createdAt));
  assert.ok(manifest.appVersion);

  for (const n of names) {
    assert.ok(n === 'manifest.json' || n === 'checksums.jsonl' || n === 'signage.db' || n === 'config.json' || n.startsWith('media/'), `unexpected entry ${n}`);
    assert.ok(!/\.tmp$|^live\/|wal$|shm$|autostart|Cookies|GPUCache|\.restore/.test(n), `should be left out: ${n}`);
  }

  const snapshot = entries.get('signage.db').data;
  for (const hash of tokenHashes) assert.equal(snapshot.includes(hash), false, 'no trace of a session in the raw bytes');
  assert.equal(snapshot.includes('correct horse'), false);
  if (spawnSync('tar', ['--version']).status === 0) {
    const file = path.join(tmpDir(t), 'b.tar');
    fs.writeFileSync(file, bytes);
    const listed = execFileSync('tar', ['-tf', file], { encoding: 'utf8' }).trim().split('\n');
    assert.deepEqual(listed, names, 'an ordinary tar tool reads it');
  }

  const mediaBefore = treeHashes(path.join(source.dataDir, 'media'), { skip: [`${image.id}/upload.tmp`] });
  const adminBefore = (await admin.get('/api/users')).data;
  const screensBefore = (await admin.get('/api/screens')).data;
  const channelBefore = (await admin.get(`/api/channels/${channel.id}`)).data;
  const rolesBefore = (await admin.get('/api/roles')).data;
  const brandingBefore = (await admin.get('/api/branding')).data;
  const sourceFile = path.join(source.dataDir, 'signage.db');
  await source.stop();
  const sourceDump = dumpDb(sourceFile, { skipTables: ['sessions'], skipSettings: IGNORED_SETTINGS });

  // The new computer: a fresh install, on first run, with no accounts.
  const target = await boot(t);
  assert.equal((await client(target.base).get('/api/setup/status')).data.needsSetup, true);
  const r = await post(target.base, '/api/setup/restore', bytes);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.restart, 'manual');

  await target.stop();
  const restarted = await boot(t, target.dataDir);
  const after = client(restarted.base);

  assert.equal((await after.get('/api/setup/status')).data.needsSetup, false);
  assert.equal((await client(restarted.base).post('/api/login', { username: 'ada', password: 'wrong' })).status, 401);
  assert.equal((await after.post('/api/login', { username: 'ada', password: 'correct horse' })).status, 200, 'the admin signs in with the same password');
  assert.equal((await client(restarted.base).post('/api/login', { username: 'coach', password: 'coach-password' })).status, 200, 'so does everyone else');

  // The old cookies mean nothing here, which is what stripping sessions is for.
  assert.equal((await fetch(`${restarted.base}/api/me`, { headers: { cookie } })).status, 401, 'old sign-ins are gone');

  assert.deepEqual((await after.get('/api/users')).data, adminBefore);
  assert.deepEqual((await after.get('/api/roles')).data, rolesBefore);
  assert.deepEqual((await after.get('/api/branding')).data, brandingBefore);
  assert.deepEqual((await after.get(`/api/channels/${channel.id}`)).data, channelBefore, 'channel, playlist, and schedules');
  const screen = (await after.get('/api/screens')).data.find((s) => s.name === 'Lobby TV');
  assert.deepEqual({ ...screen, online: false }, { ...screensBefore.find((s) => s.name === 'Lobby TV'), online: false });

  // Every table, found by asking the database, so tables added later are covered without edits.
  // Before the TV connects below, which updates when that screen was last seen.
  assert.deepEqual(dumpDb(path.join(restarted.dataDir, 'signage.db'), { skipTables: ['sessions'], skipSettings: IGNORED_SETTINGS }), sourceDump);

  // The TV is recognized by its id, with no new code, and goes to its channel's playlist.
  const tv = player(restarted.port);
  await tv.open;
  tv.send({ type: 'hello', deviceId: 'device-lobby' });
  const { slug } = await tv.next((m) => m.type === 'assign');
  assert.equal(slug, channel.slug);
  tv.send({ type: 'hello', deviceId: 'device-lobby', slug });
  const state = await tv.next((m) => m.type === 'state');
  assert.ok(state.slides.length >= 2, 'the TV has its playlist');
  tv.close();

  // Media bytes are identical, and really served.
  const mediaAfter = treeHashes(path.join(restarted.dataDir, 'media'));
  assert.deepEqual(mediaAfter, mediaBefore);
  const served = await after.get('/api/media');
  const photo = served.data.find((m) => m.id === image.id);
  assert.ok(Buffer.from(await (await fetch(restarted.base + photo.src)).arrayBuffer()).equals(fs.readFileSync(path.join(restarted.dataDir, 'media', image.id, path.basename(photo.src)))));

  assert.equal(fs.readFileSync(path.join(restarted.dataDir, 'config.json'), 'utf8'), '{"port":9001}');
  assert.equal(fs.existsSync(path.join(restarted.dataDir, '.restore')), false, 'nothing left behind');
  assert.equal(fs.existsSync(path.join(restarted.dataDir, '.backup-tmp')), false);

  const status = (await after.get('/api/backup/status')).data;
  assert.deepEqual(status.lastRestore, { id: r.data.id, ok: true, message: null });
  const notices = (await after.get('/api/notices')).data;
  assert.ok(notices.some((n) => n.kind === 'restore' && /was restored/.test(n.text)));
});

test('restoring over an existing install replaces it, and needs the confirmation', async (t) => {
  const source = await boot(t);
  await seed(source.base, source.server, source.dataDir);
  const { bytes } = await downloadBackup(source.base, await signIn(source.base));
  await source.stop();

  const target = await boot(t);
  const other = await setupAdmin(target.base);
  await other.post('/api/channels', { name: 'Doomed' });
  const cookie = await signIn(target.base);

  const unconfirmed = await post(target.base, '/api/backup/restore', bytes, cookie);
  assert.equal(unconfirmed.status, 400);
  assert.match(unconfirmed.data.error, /Confirm/);
  const wrong = await post(target.base, '/api/backup/restore?confirm=yes', bytes, cookie);
  assert.equal(wrong.status, 400);
  assert.equal(fs.existsSync(path.join(target.dataDir, '.restore')), false);

  const r = await post(target.base, restoreUrl, bytes, cookie);
  assert.equal(r.status, 200, JSON.stringify(r.data));

  // Until it restarts, nothing else may change, because the swap would lose it.
  assert.equal((await other.post('/api/channels', { name: 'Too late' })).status, 503);
  assert.equal((await post(target.base, restoreUrl, bytes, cookie)).status, 503, 'a second restore is refused too');
  assert.equal((await fetch(`${target.base}/api/backup/export`, { headers: { cookie } })).status, 503);
  assert.equal((await client(target.base).get('/api/backup/status')).data.restarting, true);

  await target.stop();
  const restarted = await boot(t, target.dataDir);
  const admin = client(restarted.base);
  assert.equal((await admin.post('/api/login', { username: 'ada', password: 'correct horse' })).status, 200);
  const names = (await admin.get('/api/channels')).data.map((c) => c.name);
  assert.ok(names.includes('Gym'));
  assert.ok(!names.includes('Doomed'), 'what was here before is gone');
});

test('onRestart runs after the answer has gone out, and the app can be told it restarts itself', async (t) => {
  const source = await boot(t);
  await setupAdmin(source.base);
  const { bytes } = await downloadBackup(source.base, await signIn(source.base));
  await source.stop();

  let restarts = 0;
  const target = await boot(t, undefined, { onRestart: () => { restarts += 1; }, restartsItself: true });
  const r = await post(target.base, '/api/setup/restore', bytes);
  assert.equal(r.status, 200);
  assert.equal(r.data.restart, 'automatic');
  assert.ok(r.data.bootId);
  await waitFor('onRestart', () => restarts === 1);
  await sleep(1100);
  assert.equal(restarts, 1, 'only once, even with the fallback timer');
});

test('the tray app stops the server, relaunches, and exits, in that order, and a hung stop can\'t strand it', async () => {
  const calls = [];
  const app = { relaunch: () => calls.push('relaunch'), exit: (code) => calls.push(`exit ${code}`) };
  await restartApp({ app, server: { stop: async () => { await sleep(10); calls.push('stop'); } } });
  assert.deepEqual(calls, ['stop', 'relaunch', 'exit 0']);

  calls.length = 0;
  await restartApp({ app, server: { stop: () => new Promise(() => {}) }, timeoutMs: 20 });
  assert.deepEqual(calls, ['relaunch', 'exit 0']);

  calls.length = 0;
  await restartApp({ app, server: { stop: async () => { throw new Error('nope'); } } });
  assert.deepEqual(calls, ['relaunch', 'exit 0']);
});

test('command line: exits and says to start again, and the next start finishes the restore', async (t) => {
  const source = await boot(t);
  await seed(source.base, source.server, source.dataDir);
  const { bytes } = await downloadBackup(source.base, await signIn(source.base));
  await source.stop();

  const dataDir = tmpDir(t);
  const env = { ...process.env, SIGNAGE_DATA_DIR: dataDir, PORT: '0', SIGNAGE_HOST: '127.0.0.1' };
  const start = () => {
    const child = spawn(process.execPath, ['--no-warnings', CLI], { env });
    child.out = '';
    child.stdout.on('data', (d) => { child.out += d; });
    child.stderr.on('data', (d) => { child.out += d; });
    child.exited = new Promise((resolve) => child.once('exit', (code) => resolve(code)));
    t.after(() => child.kill('SIGKILL')); // only ever this test's own child
    return child;
  };
  const baseOf = async (child) => {
    const match = await waitFor('the server to start', () => child.out.match(/Admin: http:\/\/[^:]+:(\d+)/));
    return `http://127.0.0.1:${match[1]}`;
  };

  const first = start();
  const r = await post(await baseOf(first), '/api/setup/restore', bytes);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.restart, 'manual');
  assert.equal(await first.exited, 0);
  assert.match(first.out, /Start Network Signage again/);

  const second = start();
  const base = await baseOf(second);
  assert.equal((await client(base).post('/api/login', { username: 'ada', password: 'correct horse' })).status, 200);
  second.kill('SIGTERM');
  assert.equal(await second.exited, 0);
});

test('an older backup upgrades in staging, then works', async (t) => {
  // Rebuilds a database exactly as 1.0.2 shipped it, from the v1.0.2 tag.
  const schema = execFileSync('git', ['show', 'v1.0.2:server/db.js'], { encoding: 'utf8' }).match(/const SCHEMA = `([\s\S]*?)`;/)[1];
  const dir = tmpDir(t);
  const file = path.join(dir, 'old.db');
  const raw = new DatabaseSync(file);
  raw.exec(schema);
  raw.exec('PRAGMA user_version = 1');
  const hash = await hashPassword('old-password');
  raw.prepare("INSERT INTO users (username, name, password_hash, role, can_override, created_at) VALUES ('oldie', 'Oldie', ?, 'admin', 1, 1)").run(hash);
  raw.exec(`INSERT INTO channels (slug, name, created_at) VALUES ('gym', 'Gym', 1);
    INSERT INTO media (id, type, name, status, file, created_at) VALUES ('m1', 'image', 'Pic', 'ready', 'image.png', 1);
    INSERT INTO playlist_items (channel_id, media_id, position, duration) VALUES (1, 'm1', 0, 7);`);
  raw.close();

  const archive = craftArchive([['signage.db', fs.readFileSync(file)], ['media/m1/image.png', PNG]], { manifest: { schemaVersion: 1, appVersion: '1.0.2' } });
  const target = await boot(t);
  const r = await post(target.base, '/api/setup/restore', archive);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await target.stop();

  const restarted = await boot(t, target.dataDir);
  const admin = client(restarted.base);
  assert.equal((await admin.post('/api/login', { username: 'oldie', password: 'old-password' })).status, 200);
  const me = (await admin.get('/api/me')).data;
  assert.equal(me.fullAccess, true, 'the upgrade gave the old admin their role');
  await restarted.stop();
  const check = new DatabaseSync(path.join(restarted.dataDir, 'signage.db'), { readOnly: true });
  assert.equal(check.prepare('PRAGMA user_version').get().user_version, latestSchemaVersion());
  assert.equal(check.prepare('SELECT duration FROM playlist_items').get().duration, 7);
  check.close();
});

test('an older backup whose upgrade fails is refused with nothing changed', async (t) => {
  const dir = tmpDir(t);
  const file = await makeDb(path.join(dir, 'x.db'));
  // Says it's old, so the upgrades run, and they fail because their tables are already there.
  const raw = new DatabaseSync(file);
  raw.exec('PRAGMA user_version = 1');
  raw.close();
  const target = await boot(t);
  const r = await post(target.base, '/api/setup/restore', craftArchive([['signage.db', fs.readFileSync(file)]], { manifest: { schemaVersion: 1 } }));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /could not be upgraded/);
  assert.equal(fs.existsSync(path.join(target.dataDir, '.restore')), false);
});

// A running server on an existing install, and a helper that proves a refusal changed nothing.
async function refusalTarget(t, statfs) {
  const target = await boot(t, undefined, statfs ? { ops: { statfs } } : {});
  const admin = await setupAdmin(target.base);
  const media = (await admin.post('/api/media/text', { title: 'Keep me' })).data;
  fs.mkdirSync(path.join(target.dataDir, 'media', media.id), { recursive: true });
  fs.writeFileSync(path.join(target.dataDir, 'media', media.id, 'keep.bin'), 'keep');
  const cookie = await signIn(target.base);
  await target.server.ops.tick(); // so nothing is left for a background check to write
  const dbFile = path.join(target.dataDir, 'signage.db');
  target.server.db.get('PRAGMA wal_checkpoint(TRUNCATE)');
  const before = treeHashes(target.dataDir);
  const refused = async (bytes, status, pattern, label) => {
    const r = await post(target.base, restoreUrl, bytes, cookie);
    assert.equal(r.status, status, `${label}: ${JSON.stringify(r.data)}`);
    if (pattern) assert.match(r.data.error, pattern, label);
    assert.deepEqual(treeHashes(target.dataDir), before, `${label}: existing data is byte for byte unchanged`);
    assert.equal(fs.existsSync(path.join(target.dataDir, '.restore')), false, `${label}: staging was removed`);
    assert.equal((await client(target.base).get('/api/backup/status')).data.restarting, false, label);
  };
  return { target, cookie, refused, dbFile };
}

async function validFiles(t) {
  const file = await makeDb(path.join(tmpDir(t), 'x.db'));
  return [['signage.db', fs.readFileSync(file)], ['media/a/image.png', PNG], ['config.json', Buffer.from('{"port":9000}')]];
}

test('a backup from a newer version is refused with a plain message to update first', async (t) => {
  const files = await validFiles(t);
  const { refused } = await refusalTarget(t);
  await refused(craftArchive(files, { manifest: { schemaVersion: latestSchemaVersion() + 1 } }), 400, /newer version.*Update this computer/, 'newer schema');
  await refused(craftArchive(files, { manifest: { formatVersion: 2 } }), 400, /newer version/, 'newer format');
});

test('wrong, corrupted, and truncated archives are refused with existing data byte-identical', async (t) => {
  const files = await validFiles(t);
  const good = craftArchive(files);
  const { refused } = await refusalTarget(t);

  await refused(Buffer.from('this is not an archive at all'), 400, /not a Network Signage backup/, 'not a tar');
  await refused(Buffer.alloc(0), 400, /not a Network Signage backup/, 'empty');
  await refused(Buffer.alloc(4096), 400, /not a Network Signage backup/, 'all zeros');
  await refused(craftArchive(files, { manifest: { format: 'something-else' } }), 400, /not a Network Signage backup/, 'wrong format name');

  // The manifest must be first.
  const noManifest = Buffer.concat([tarEntry({ name: 'signage.db', data: files[0][1] }), Buffer.alloc(1024)]);
  await refused(noManifest, 400, /not a Network Signage backup/, 'no manifest');
  await refused(craftArchive(files, { raw: [tarEntry({ name: 'media/early.png', data: PNG })] }), 400, /not a Network Signage backup/, 'something before the manifest');

  // Wrong manifest.
  await refused(craftArchive(files, { manifest: { fileCount: 2 } }), 400, /damaged/, 'more files than stated');
  await refused(craftArchive(files, { manifest: { fileCount: 9 } }), 400, /damaged/, 'fewer files than stated');
  await refused(craftArchive(files, { manifest: { totalSize: 10 } }), 400, /damaged/, 'bigger than stated');
  await refused(craftArchive(files, { manifest: { totalSize: 999999999 } }), 400, /damaged/, 'smaller than stated');
  await refused(craftArchive(files, { manifest: { schemaVersion: 2 } }), 400, /damaged|upgraded/, 'schema not matching the database');
  await refused(craftArchive(files, { manifest: { schemaVersion: 'x' } }), 400, /damaged/, 'schema not a number');
  await refused(craftArchive(files, { manifest: { fileCount: -1 } }), 400, /damaged/, 'negative count');

  // Truncated at every kind of place.
  await refused(good.subarray(0, 100), 400, /not a Network Signage backup/, 'cut inside the manifest header');
  await refused(good.subarray(0, 700), 400, /incomplete/, 'cut just after the manifest');
  await refused(good.subarray(0, Math.floor(good.length / 2)), 400, /incomplete/, 'cut in half');
  await refused(good.subarray(0, good.length - 2000), 400, /incomplete/, 'cut near the end');
  await refused(good.subarray(0, good.length - 1024), 400, /incomplete/, 'no end marker');
  await refused(craftArchive(files, { end: false }), 400, /incomplete/, 'no end marker, built that way');

  // A flipped bit in any stored file, which only the checksums can catch.
  const hit = (name, data) => {
    const flipped = Buffer.from(data);
    flipped[Math.floor(flipped.length / 2)] ^= 0xff;
    return craftArchive(files.map(([n, d]) => [n, n === name ? flipped : d]), { checksums: files.map(([n, d]) => `${JSON.stringify({ path: n, sha256: sha256(d) })}\n`).join('') });
  };
  await refused(hit('media/a/image.png', PNG), 400, /damaged/, 'damaged media');
  await refused(hit('signage.db', files[0][1]), 400, /damaged/, 'damaged database');

  // Checksums that don't cover what's there.
  await refused(craftArchive(files, { checksums: '' }), 400, /damaged/, 'empty checksums');
  await refused(craftArchive(files, { checksums: 'not json\n' }), 400, /damaged/, 'garbled checksums');
  const noChecksums = Buffer.concat([tarEntry({ name: 'manifest.json', data: Buffer.from(JSON.stringify({ format: 'network-signage-backup', formatVersion: 1, schemaVersion: latestSchemaVersion(), fileCount: 3, totalSize: files.reduce((n, [, d]) => n + d.length, 0) })) }), ...files.map(([name, data]) => tarEntry({ name, data })), Buffer.alloc(1024)]);
  await refused(noChecksums, 400, /incomplete/, 'no checksums at all');

  // The database itself.
  const bad = (db) => craftArchive([['signage.db', db]]);
  await refused(bad(Buffer.alloc(8192, 0x41)), 400, /damaged/, 'not a database');
  await refused(bad(Buffer.alloc(0)), 400, /damaged/, 'an empty database file');
  const otherDb = path.join(tmpDir(t), 'other.db');
  const raw = new DatabaseSync(otherDb);
  raw.exec('CREATE TABLE elsewhere (x); PRAGMA user_version = ' + latestSchemaVersion());
  raw.close();
  await refused(bad(fs.readFileSync(otherDb)), 400, /damaged/, 'some other program\'s database');
  const damagedDb = Buffer.from(files[0][1]);
  damagedDb.fill(0x55, 4096, 8192); // a real page overwritten, where the header still looks fine
  await refused(bad(damagedDb), 400, /damaged/, 'a database damaged inside');
  await refused(craftArchive([['media/a/image.png', PNG]]), 400, /damaged/, 'no database at all');

  // config.json
  await refused(craftArchive([files[0], ['config.json', Buffer.from('not json')]]), 400, /damaged/, 'bad config');
  await refused(craftArchive([files[0], ['config.json', Buffer.from('[1]')]]), 400, /damaged/, 'config not an object');

  // Paths that collide.
  await refused(craftArchive([files[0], ['media/a', PNG], ['media/a/b', PNG]]), 400, /damaged/, 'a file and a folder with one name');
  await refused(craftArchive([files[0], ['media/a', PNG], ['media/a', PNG]]), 400, /damaged/, 'the same path twice');

  // Trailing data.
  await refused(Buffer.concat([good, Buffer.from('more')]), 400, /damaged/, 'data after the end');
});

test('unsafe entries are refused, and nothing lands outside staging', async (t) => {
  const files = await validFiles(t);
  const outsideRoot = tmpDir(t);
  const { target, refused } = await refusalTarget(t);
  const sentinel = path.join(outsideRoot, 'sentinel.txt');
  const relative = path.relative(path.join(target.dataDir, '.restore', 'upload-x'), sentinel);
  const payload = Buffer.from('written outside');
  const withEntry = (entry) => craftArchive(files, { before: [entry], manifest: { fileCount: files.length + 1, totalSize: files.reduce((n, [, d]) => n + d.length, 0) + (entry.length) } });

  const unsafePaths = [
    relative,
    sentinel,
    '../escape.txt',
    '../../escape.txt',
    'media/../../escape.txt',
    'media/../../../escape.txt',
    '/etc/signage-escape.txt',
    'media/./a.txt',
    'media//a.txt',
    'media\\..\\..\\escape.txt',
    'C:\\escape.txt',
    'media/c:escape.txt',
    'live/x/seg.ts',
    'signage.db-wal',
    '.restore/restore.json',
    'nope.txt',
    `media/${'../'.repeat(60)}escape.txt`, // long enough that the path goes through PAX
  ];
  for (const name of unsafePaths) {
    await refused(withEntry(tarEntry({ name, data: payload })), 400, /unsafe file path/, `path ${name}`);
  }

  for (const [label, type, linkname] of [
    ['symlink out', '2', sentinel],
    ['symlink, relative', '2', '../../../etc/passwd'],
    ['hard link', '1', 'signage.db'],
    ['character device', '3', ''],
    ['block device', '4', ''],
    ['fifo', '6', ''],
    ['directory', '5', ''],
    ['GNU long name', 'L', ''],
    ['global PAX', 'g', ''],
  ]) {
    await refused(withEntry(tarEntry({ name: 'media/link', type, linkname })), 400, /other than plain files/, label);
  }

  // A symlink written and then used as a folder is the classic escape, so try it in that order.
  const chained = craftArchive(files, {
    before: [tarEntry({ name: 'media/out', type: '2', linkname: outsideRoot }), tarEntry({ name: 'media/out/sentinel.txt', data: payload })],
    manifest: { fileCount: files.length + 2 },
  });
  await refused(chained, 400, /other than plain files/, 'symlink then write through it');

  // PAX can rewrite a safe-looking name to a dangerous one.
  const paxPath = Buffer.concat([
    tarEntry({ name: 'PaxHeader/entry', type: 'x', data: Buffer.from(paxRecord('path', '../../escape.txt')) }),
    tarEntry({ name: 'media/safe.txt', data: payload }),
  ]);
  await refused(withEntry(paxPath), 400, /unsafe file path/, 'path rewritten by PAX');

  assert.equal(fs.existsSync(sentinel), false, 'nothing reached the outside folder');
  assert.deepEqual(fs.readdirSync(outsideRoot), []);
  assert.equal(fs.existsSync(path.join(target.dataDir, 'escape.txt')), false);
  assert.equal(fs.existsSync(path.join(target.dataDir, '.restore', 'escape.txt')), false);
  assert.equal(fs.existsSync(path.join(path.dirname(target.dataDir), 'escape.txt')), false);
});

test('first run: the route refuses once an account exists', async (t) => {
  const files = await validFiles(t);
  const archive = craftArchive(files);
  const target = await boot(t);
  assert.equal((await post(target.base, '/api/setup/restore', Buffer.from('junk'))).status, 400, 'open while there are no accounts');
  await setupAdmin(target.base);
  const r = await post(target.base, '/api/setup/restore', archive);
  assert.equal(r.status, 409);
  assert.match(r.data.error, /already complete/);
  assert.equal(fs.existsSync(path.join(target.dataDir, '.restore')), false);
});

test('first run: setup finishing during the upload wins, and the restore is refused', async (t) => {
  const files = await validFiles(t);
  const archive = craftArchive(files, { manifest: {} });
  const target = await boot(t);
  const upload = pausedUpload(target.base, '/api/setup/restore', archive);
  const staging = path.join(target.dataDir, '.restore');
  await waitFor('the upload to start', () => fs.existsSync(staging));

  const admin = await setupAdmin(target.base); // completes while the upload waits
  const media = (await admin.post('/api/media/text', { title: 'Keep me' })).data;
  upload.finish();
  const r = await upload.response;
  assert.equal(r.status, 409, JSON.stringify(r.data));
  assert.match(r.data.error, /Setup was finished/);
  assert.equal(fs.existsSync(staging), false, 'staging was removed');
  assert.equal((await client(target.base).get('/api/backup/status')).data.restarting, false);

  await target.stop();
  const restarted = await boot(t, target.dataDir);
  const after = client(restarted.base);
  assert.equal((await after.post('/api/login', { username: 'ada', password: 'correct horse' })).status, 200, 'the account from setup still works');
  assert.ok((await after.get('/api/media')).data.some((m) => m.id === media.id));
});

test('first run: setup is refused once a restore has been accepted', async (t) => {
  const target = await boot(t);
  const r = await post(target.base, '/api/setup/restore', craftArchive(await validFiles(t)));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const late = await client(target.base).post('/api/setup', { orgName: 'Late', name: 'Late', username: 'late', password: 'late-password' });
  assert.equal(late.status, 503);
});

test('only one restore can run at a time', async (t) => {
  const archive = craftArchive(await validFiles(t));
  const target = await boot(t);
  const first = pausedUpload(target.base, '/api/setup/restore', archive);
  await waitFor('the first upload', () => fs.existsSync(path.join(target.dataDir, '.restore')));
  const second = await post(target.base, '/api/setup/restore', archive);
  assert.equal(second.status, 409);
  assert.match(second.data.error, /already running/);
  first.finish();
  assert.equal((await first.response).status, 200);
});

test('an upload that disconnects partway cleans up, and doesn\'t block the next try', async (t) => {
  const files = await validFiles(t);
  const archive = craftArchive([...files, ['media/big.bin', Buffer.alloc(1024 * 1024, 3)]]);
  const { target, cookie } = await refusalTarget(t);
  const before = treeHashes(target.dataDir);
  const upload = pausedUpload(target.base, restoreUrl, archive, { cookie });
  upload.response.catch(() => {});
  await waitFor('the upload to start', () => fs.existsSync(path.join(target.dataDir, '.restore')));
  upload.abort();
  await waitFor('staging to be removed', () => !fs.existsSync(path.join(target.dataDir, '.restore')));
  assert.deepEqual(treeHashes(target.dataDir), before);
  await waitFor('the lock to be released', async () => {
    const r = await post(target.base, restoreUrl, Buffer.from('junk'), cookie);
    return r.status === 400;
  });
});

test('not enough free space is refused before anything is stored', async (t) => {
  const small = async () => ({ bavail: 1, bsize: 4096 });
  const { refused } = await refusalTarget(t, small);
  await refused(craftArchive(await validFiles(t)), 507, /enough free space/, 'too little room');
});

test('free space is checked from the manifest when the upload doesn\'t state a size', async (t) => {
  const small = async () => ({ bavail: 1, bsize: 4096 });
  const target = await boot(t, undefined, { ops: { statfs: small } });
  const upload = pausedUpload(target.base, '/api/setup/restore', craftArchive(await validFiles(t)));
  upload.finish();
  const r = await upload.response;
  assert.equal(r.status, 507);
  assert.match(r.data.error, /enough free space/);
  assert.equal(fs.existsSync(path.join(target.dataDir, '.restore')), false);
});

test('permissions: export and restore need every permission, and a role one short is refused', async (t) => {
  const target = await boot(t);
  const admin = await setupAdmin(target.base);
  const archive = craftArchive(await validFiles(t));
  const assertRefused = async (cookie, status, label) => {
    const headers = cookie ? { cookie } : {};
    assert.equal((await fetch(`${target.base}/api/backup/export`, { headers })).status, status, `export ${label}`);
    assert.equal((await fetch(`${target.base}/api/backup/summary`, { headers })).status, status, `summary ${label}`);
    assert.equal((await post(target.base, restoreUrl, archive, cookie)).status, status, `restore ${label}`);
  };
  await assertRefused(null, 401, 'signed out');

  for (const missing of ALL) {
    const role = (await admin.post('/api/roles', { name: `Without ${missing}`, permissions: ALL.filter((k) => k !== missing) })).data;
    const username = `no${ALL.indexOf(missing)}`;
    assert.equal((await admin.post('/api/users', { username, name: username, password: 'password-1', roleId: role.id })).status, 200);
    await assertRefused(await signIn(target.base, username, 'password-1'), 403, `without ${missing}`);
  }

  // A custom role holding everything counts, whatever it's called.
  const everything = (await admin.post('/api/roles', { name: 'Everything', permissions: ALL })).data;
  await admin.post('/api/users', { username: 'allofit', name: 'All', password: 'password-1', roleId: everything.id });
  const cookie = await signIn(target.base, 'allofit', 'password-1');
  assert.equal((await fetch(`${target.base}/api/backup/export`, { headers: { cookie } })).status, 200);
  assert.equal((await post(target.base, '/api/backup/restore', archive, cookie)).status, 400, 'reaches the confirmation check');

  // The first-run route can't stand in for the signed-in one.
  assert.equal((await post(target.base, '/api/setup/restore', archive)).status, 409);
  await waitFor('the snapshot to be cleaned up', () => !fs.existsSync(path.join(target.dataDir, '.backup-tmp')));
});

test('a cross-site page can\'t restore, even with a signed-in admin\'s cookie', async (t) => {
  const target = await boot(t);
  await setupAdmin(target.base);
  const cookie = await signIn(target.base);
  const res = await fetch(target.base + restoreUrl, {
    method: 'POST', headers: { cookie, origin: 'http://evil.example' }, body: form('x.tar', Buffer.from('x'), 'application/x-tar'),
  });
  assert.equal(res.status, 403);
});

test('disconnecting partway through a download removes the temporary snapshot', async (t) => {
  const target = await boot(t);
  await setupAdmin(target.base);
  const cookie = await signIn(target.base);
  // Sparse, so a big file costs nothing, and far bigger than any socket buffer.
  fs.mkdirSync(path.join(target.dataDir, 'media', 'big'), { recursive: true });
  sparseFile(path.join(target.dataDir, 'media', 'big', 'video.mp4'), 512 * 1024 * 1024);
  const tmp = path.join(target.dataDir, '.backup-tmp');

  const abort = new AbortController();
  const res = await fetch(`${target.base}/api/backup/export`, { headers: { cookie }, signal: abort.signal });
  assert.equal(res.status, 200);
  const reader = res.body.getReader();
  await reader.read();
  assert.equal(fs.readdirSync(tmp).length, 1, 'the snapshot exists while the download runs');

  // Backpressure: reading nothing more means the server stops well short of the whole file.
  await sleep(100);
  assert.equal(fs.readdirSync(tmp).length, 1, 'still under way, so it isn\'t reading ahead into memory');

  abort.abort();
  await waitFor('the snapshot to be removed', () => !fs.existsSync(tmp));
});

test('a download that finishes removes the temporary snapshot, and the server keeps working', async (t) => {
  const target = await boot(t);
  const admin = await setupAdmin(target.base);
  await downloadBackup(target.base, await signIn(target.base));
  await waitFor('the snapshot to be removed', () => !fs.existsSync(path.join(target.dataDir, '.backup-tmp')));
  assert.equal((await admin.post('/api/channels', { name: 'Still fine' })).status, 200);
});

test('a leftover snapshot from a crash is cleared at the next start', async (t) => {
  const dataDir = tmpDir(t);
  fs.mkdirSync(path.join(dataDir, '.backup-tmp'));
  fs.writeFileSync(path.join(dataDir, '.backup-tmp', 'snapshot-old.db'), 'x');
  await boot(t, dataDir);
  assert.equal(fs.existsSync(path.join(dataDir, '.backup-tmp')), false);
});

// Reads a download until the server cuts it off, to see what a browser would be left with.
async function drain(res) {
  const reader = res.body.getReader();
  const parts = [];
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return { parts, ended: true };
      parts.push(Buffer.from(value));
    }
  } catch {
    return { parts, ended: false };
  }
}

test('a file deleted mid-download fails visibly, and the partial file can\'t be restored', async (t) => {
  const target = await boot(t);
  await setupAdmin(target.base);
  const cookie = await signIn(target.base);
  const dir = path.join(target.dataDir, 'media', 'item');
  fs.mkdirSync(dir, { recursive: true });
  sparseFile(path.join(dir, 'a-first.bin'), 256 * 1024 * 1024);
  const victim = path.join(dir, 'z-later.bin');
  fs.writeFileSync(victim, 'this file will be deleted');

  const res = await fetch(`${target.base}/api/backup/export`, { headers: { cookie } });
  const stated = Number(res.headers.get('content-length'));
  const reader = res.body.getReader();
  const first = await reader.read();
  fs.rmSync(victim);
  const parts = [Buffer.from(first.value)];
  let cut = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(Buffer.from(value));
    }
  } catch {
    cut = true;
  }
  const partial = Buffer.concat(parts);
  assert.equal(cut, true, 'the connection breaks, which a browser shows as a failed download');
  assert.ok(partial.length < stated, 'shorter than the length it promised');
  await waitFor('the snapshot to be removed', () => !fs.existsSync(path.join(target.dataDir, '.backup-tmp')));

  // Anyone who keeps the partial file still can't restore it by mistake.
  const fresh = await boot(t);
  const r = await post(fresh.base, '/api/setup/restore', partial);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /incomplete/);
});

test('a file that shrinks mid-download fails visibly too, rather than padding', async (t) => {
  const target = await boot(t);
  await setupAdmin(target.base);
  const cookie = await signIn(target.base);
  const dir = path.join(target.dataDir, 'media', 'item');
  fs.mkdirSync(dir, { recursive: true });
  sparseFile(path.join(dir, 'a-first.bin'), 128 * 1024 * 1024);
  sparseFile(path.join(dir, 'z-later.bin'), 4 * 1024 * 1024);
  const res = await fetch(`${target.base}/api/backup/export`, { headers: { cookie } });
  const stated = Number(res.headers.get('content-length'));
  fs.truncateSync(path.join(dir, 'z-later.bin'), 1024);
  const { parts, ended } = await drain(res);
  assert.equal(ended, false);
  assert.ok(Buffer.concat(parts).length < stated);
});

test('an export while a video converts is refused with a plain reason', async (t) => {
  const target = await boot(t);
  await setupAdmin(target.base);
  const cookie = await signIn(target.base);
  const realBusy = target.server.processor.busy;
  target.server.processor.busy = () => true;
  t.after(() => { target.server.processor.busy = realBusy; });
  const r = await fetch(`${target.base}/api/backup/export`, { headers: { cookie } });
  assert.equal(r.status, 409);
  assert.match((await r.json()).error, /still being converted/);
  const summary = await (await fetch(`${target.base}/api/backup/summary`, { headers: { cookie } })).json();
  assert.match(summary.blocked, /still being converted/);
  assert.ok(summary.fileCount >= 1);
});

test('a download in progress doesn\'t stop the server from shutting down', async (t) => {
  const target = await boot(t);
  await setupAdmin(target.base);
  const cookie = await signIn(target.base);
  fs.mkdirSync(path.join(target.dataDir, 'media', 'big'), { recursive: true });
  sparseFile(path.join(target.dataDir, 'media', 'big', 'video.mp4'), 512 * 1024 * 1024);
  const res = await fetch(`${target.base}/api/backup/export`, { headers: { cookie } });
  const reader = res.body.getReader();
  await reader.read();
  await target.stop(); // would hang here
  assert.equal(fs.existsSync(path.join(target.dataDir, '.backup-tmp')), false);
  await reader.cancel().catch(() => {});
});

test('restoring while live feeds run stops ffmpeg first, and the feeds come back from the backup', async (t) => {
  const source = await boot(t);
  const admin = await setupAdmin(source.base);
  const feedPort = 21000 + (process.pid % 20000);
  const feed = await admin.post('/api/live-feeds', { name: 'Program', input: 'rtmp', port: feedPort });
  assert.equal(feed.status, 200, JSON.stringify(feed.data));
  const liveFile = path.join(source.dataDir, 'live', feed.data.id, 'seg-test.ts');
  await waitFor('ffmpeg to start', () => source.server.live.childPids().length === 1, 30000);
  fs.writeFileSync(liveFile, 'segment');

  const { bytes } = await downloadBackup(source.base, await signIn(source.base));
  const names = [...(await listArchive(bytes)).keys()];
  assert.ok(!names.some((n) => n.includes('live/') || n.endsWith('seg-test.ts')), 'live segments stayed out');

  const pids = source.server.live.childPids();
  const r = await post(source.base, restoreUrl, bytes, await signIn(source.base));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(source.server.live.childPids(), [], 'no feed is running by the time the answer comes back');
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), /ESRCH/, `ffmpeg ${pid} is gone`);
  assert.equal(source.server.processor.busy(), false);
  await source.stop();

  const restarted = await boot(t, source.dataDir);
  const after = client(restarted.base);
  assert.equal((await after.post('/api/login', { username: 'ada', password: 'correct horse' })).status, 200);
  const feeds = (await after.get('/api/live-feeds')).data;
  assert.equal(feeds.length, 1);
  assert.equal(feeds[0].name, 'Program');
  await waitFor('the feed to start again', () => restarted.server.live.childPids().length === 1, 30000);
  await restarted.stop();
  for (const pid of restarted.server.live.childPids()) assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('a media conversion is stopped by an accepted restore', { skip: process.platform === 'win32' && 'uses a shell script' }, async (t) => {
  // Stands in for ffmpeg, and runs until something stops it.
  const dir = tmpDir(t);
  const pidFile = path.join(dir, 'pid');
  const fake = path.join(dir, 'fake-ffmpeg');
  fs.writeFileSync(fake, `#!/bin/sh\necho $$ > "${pidFile}"\nexec sleep 60\n`, { mode: 0o755 });

  const target = await boot(t, undefined, { ffmpeg: fake });
  const admin = await setupAdmin(target.base);
  const upload = await admin.post('/api/media', form('clip.mp4', Buffer.alloc(64, 1), 'video/mp4'));
  assert.equal(upload.status, 200, JSON.stringify(upload.data));
  await waitFor('the conversion to start', () => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim());
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.equal(target.server.processor.busy(), true);

  const r = await post(target.base, restoreUrl, craftArchive(await validFiles(t)), await signIn(target.base));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await waitFor('the conversion to stop', () => {
    try {
      process.kill(pid, 0);
      return false;
    } catch {
      return !target.server.processor.busy();
    }
  });
});

test('first run: setup and a restore racing to the finish never both succeed', async (t) => {
  const archive = craftArchive(await validFiles(t));
  for (let i = 0; i < 4; i++) {
    const target = await boot(t);
    const upload = pausedUpload(target.base, '/api/setup/restore', archive);
    await waitFor('the upload to start', () => fs.existsSync(path.join(target.dataDir, '.restore')));
    const setup = client(target.base).post('/api/setup', { orgName: 'Org', name: 'Setup', username: 'setupuser', password: 'setup-password' });
    if (i % 2) await sleep(i * 15); // lands the two at different points against password hashing
    upload.finish();
    const [restoreResult, setupResult] = await Promise.all([upload.response, setup]);
    const wins = [restoreResult.status, setupResult.status].filter((s) => s === 200).length;
    assert.equal(wins, 1, `restore ${restoreResult.status}, setup ${setupResult.status}`);
    await target.stop();

    const restarted = await boot(t, target.dataDir);
    const expected = restoreResult.status === 200 ? ['ada', 'correct horse'] : ['setupuser', 'setup-password'];
    assert.equal((await client(restarted.base).post('/api/login', { username: expected[0], password: expected[1] })).status, 200, 'whichever won is what is there');
    await restarted.stop();
  }
});

test('after a restore on a computer with a different address, the notice explains both fixes', async (t) => {
  const world = { addresses: ['192.168.1.20'] };
  const ops = { addresses: () => world.addresses };
  const source = await boot(t, undefined, { ops });
  await setupAdmin(source.base);
  await source.server.ops.tick();
  const { bytes } = await downloadBackup(source.base, await signIn(source.base));
  await source.stop();

  world.addresses = ['192.168.1.77'];
  const target = await boot(t, undefined, { ops });
  assert.equal((await post(target.base, '/api/setup/restore', bytes)).status, 200);
  await target.stop();
  const restarted = await boot(t, target.dataDir, { ops });
  await restarted.server.ops.tick();
  const admin = client(restarted.base);
  await admin.post('/api/login', { username: 'ada', password: 'correct horse' });
  const notice = (await admin.get('/api/notices')).data.find((n) => n.kind === 'address');
  assert.ok(notice, 'the existing address notice fires');
  assert.match(notice.text, /192\.168\.1\.20/);
  assert.match(notice.text, /192\.168\.1\.77/);
  assert.match(notice.text, /Reserve 192\.168\.1\.20 for this computer/);
  assert.match(notice.text, /re-pair each TV/);
  assert.equal((await admin.post(`/api/notices/${encodeURIComponent(notice.id)}/dismiss`)).status, 200);
  assert.equal((await admin.get('/api/notices')).data.some((n) => n.kind === 'address'), false);
});

test('after a restore at the same address, there is no address notice', async (t) => {
  const ops = { addresses: () => ['192.168.1.20'] };
  const source = await boot(t, undefined, { ops });
  await setupAdmin(source.base);
  await source.server.ops.tick();
  const { bytes } = await downloadBackup(source.base, await signIn(source.base));
  await source.stop();
  const target = await boot(t, undefined, { ops });
  assert.equal((await post(target.base, '/api/setup/restore', bytes)).status, 200);
  await target.stop();
  const restarted = await boot(t, target.dataDir, { ops });
  await restarted.server.ops.tick();
  const admin = client(restarted.base);
  await admin.post('/api/login', { username: 'ada', password: 'correct horse' });
  assert.equal((await admin.get('/api/notices')).data.some((n) => n.kind === 'address'), false);
});

test('a nonsense date in a manifest doesn\'t break the notices', async (t) => {
  const target = await boot(t);
  const r = await post(target.base, '/api/setup/restore', craftArchive(await validFiles(t), { manifest: { createdAt: 12345678901234567890 } }));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  await target.stop();
  const restarted = await boot(t, target.dataDir);
  const admin = client(restarted.base);
  await admin.post('/api/login', { username: 'ada', password: 'correct horse' });
  const notice = (await admin.get('/api/notices')).data.find((n) => n.kind === 'restore');
  assert.equal(notice.text, 'Your backup was restored.');
});

test('a backup too big for the upload limit is refused at export, rather than making one that can\'t be restored', async (t) => {
  const target = await boot(t);
  await setupAdmin(target.base);
  const cookie = await signIn(target.base);
  fs.mkdirSync(path.join(target.dataDir, 'media', 'big'), { recursive: true });
  sparseFile(path.join(target.dataDir, 'media', 'big', 'video.mp4'), 20 * 1024 ** 3 + 1);
  const summary = await (await fetch(`${target.base}/api/backup/summary`, { headers: { cookie } })).json();
  assert.match(summary.blocked, /too big/);
  const res = await fetch(`${target.base}/api/backup/export`, { headers: { cookie } });
  assert.equal(res.status, 413);
  assert.match((await res.json()).error, /too big/);
  assert.equal(fs.existsSync(path.join(target.dataDir, '.backup-tmp')), false);
});

test('files the export must not follow: a symlink in media stays out', async (t) => {
  const target = await boot(t);
  await setupAdmin(target.base);
  const secret = path.join(tmpDir(t), 'secret.txt');
  fs.writeFileSync(secret, 'secret');
  fs.symlinkSync(secret, path.join(target.dataDir, 'media', 'link.txt'));
  fs.symlinkSync(path.dirname(secret), path.join(target.dataDir, 'media', 'linkdir'));
  const { bytes } = await downloadBackup(target.base, await signIn(target.base));
  const names = [...(await listArchive(bytes)).keys()];
  assert.ok(!names.includes('media/link.txt'));
  assert.ok(!names.some((n) => n.startsWith('media/linkdir')));
});
