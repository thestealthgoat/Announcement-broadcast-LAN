import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server/index.js';
import { resolveFfmpeg } from '../server/media.js';
import { openDb } from '../server/db.js';
import { probeCapabilities } from '../server/live/probe.js';
import { client, setupAdmin, makeEditor, player } from './helpers.js';

const FFMPEG = resolveFfmpeg();
const WAIT_MS = 45000;
const isState = (m) => m.type === 'state';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, check, ms = WAIT_MS) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '0.0.0.0', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

function hold(port) {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(port, '0.0.0.0', () => resolve(s));
  });
}

// Like the shared startServer, but a test can stop it, and restart on the same data.
async function boot(t, dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-live-'))) {
  const server = await createServer({ dataDir, port: 0, host: '127.0.0.1' });
  const { port } = await server.start();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await server.stop();
  };
  t.after(async () => {
    await stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { server, port, base: `http://127.0.0.1:${port}`, dataDir, stop };
}

// Stands in for vMix or OBS. Connecting can miss while ffmpeg restarts, so it retries
// until told to stop, as those programs do.
function sender(input, port) {
  const target = input === 'rtmp'
    ? ['-f', 'flv', `rtmp://127.0.0.1:${port}/live/feed`]
    : ['-f', 'mpegts', `srt://127.0.0.1:${port}?mode=caller`];
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-re',
    '-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p', '-g', '30',
    '-c:a', 'aac', '-b:a', '96k',
    ...target,
  ];
  let child = null;
  let closed = null;
  let stopping = false;
  const launch = () => {
    if (stopping) return;
    child = spawn(FFMPEG, args, { stdio: 'ignore' });
    closed = new Promise((resolve) => child.on('close', resolve));
    closed.then(() => setTimeout(launch, 300));
  };
  launch();
  return {
    async stop() {
      stopping = true;
      child.kill('SIGTERM');
      await closed;
    },
  };
}

function strayFfmpeg(port) {
  if (process.platform === 'win32') return [];
  const listing = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,command='], { encoding: 'utf8' }).stdout;
  return listing.split('\n').filter((line) => {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (!m || !/ffmpeg/.test(m[3])) return false;
    return Number(m[2]) === process.pid || m[3].includes(`0.0.0.0:${port}`);
  });
}

const feedStatus = async (admin, id) => (await admin.get('/api/live-feeds')).data.find((f) => f.id === id);
const waitStatus = (admin, id, status, ms) =>
  waitFor(`feed to be ${status}`, async () => {
    const f = await feedStatus(admin, id);
    return f?.status === status ? f : null;
  }, ms);

async function nextState(p, pred, ms = WAIT_MS) {
  const end = Date.now() + ms;
  for (;;) {
    const s = await p.next(isState, Math.max(end - Date.now(), 1));
    if (pred(s)) return s;
  }
}

async function tv(t, port, slug) {
  const p = player(port);
  await p.open;
  p.send({ type: 'hello', deviceId: `device-${Math.random().toString(36).slice(2, 12)}`, slug });
  t.after(() => p.close());
  return p;
}

// Not spawnSync: the server under test shares this process and has to answer ffmpeg.
const describeStream = (url) => new Promise((resolve) => {
  const child = spawn(FFMPEG, ['-hide_banner', '-nostdin', '-i', url], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 20000, killSignal: 'SIGKILL' });
  let output = '';
  child.stderr.on('data', (d) => { output += d; });
  child.on('close', () => resolve(output));
});

// The whole path, with real ffmpeg and a synthetic source.
async function fullRun(t, input) {
  const { server, port, base, stop } = await boot(t);
  const admin = await setupAdmin(base);
  const [main] = (await admin.get('/api/channels')).data;
  const feedPort = await freePort();

  const text = (await admin.post('/api/media/text', { title: 'Always on' })).data;
  await admin.post(`/api/channels/${main.id}/items`, { mediaId: text.id });

  const created = await admin.post('/api/live-feeds', { name: 'Program', input, port: feedPort });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const feed = created.data;
  assert.equal(feed.url, `/live/${feed.id}/index.m3u8`);
  assert.equal(feed.status, 'idle');
  assert.ok(feed.address.url.includes(`:${feedPort}`));

  const inLibrary = (await admin.get('/api/media')).data.find((m) => m.id === feed.id);
  assert.equal(inLibrary.type, 'hls');
  assert.equal(inLibrary.live, true);
  assert.equal(inLibrary.liveStatus, 'idle');

  await admin.post(`/api/channels/${main.id}/items`, { mediaId: feed.id });
  const p = await tv(t, port, main.slug);
  const hasFeed = (s) => s.slides.some((x) => x.mediaId === feed.id);
  let state = await nextState(p, (s) => s.slides.length >= 1);
  assert.equal(hasFeed(state), false, 'a feed with no signal stays out of the channel');
  assert.equal(state.slides.length, 1, 'the other slide keeps playing');

  // Idle to live.
  let push = sender(input, feedPort);
  t.after(() => push.stop());
  const live = await waitStatus(admin, feed.id, 'live');
  assert.ok(live.encoder, 'reports which encoder is in use');
  state = await nextState(p, hasFeed);
  const slide = state.slides.find((x) => x.mediaId === feed.id);
  assert.equal(slide.type, 'hls');
  assert.equal(slide.src, feed.url);
  assert.equal(slide.duration, 60, 'a sensible default duration');

  // Playlist and segments over HTTP.
  const playlist = await fetch(base + feed.url);
  assert.equal(playlist.status, 200);
  assert.match(playlist.headers.get('content-type'), /mpegurl/i);
  assert.match(playlist.headers.get('cache-control'), /no-store/);
  const listing = await playlist.text();
  assert.match(listing, /#EXT-X-TARGETDURATION:1/);
  assert.match(listing, /#EXT-X-INDEPENDENT-SEGMENTS/);
  assert.doesNotMatch(listing, /ENDLIST/);
  const names = listing.split('\n').filter((l) => l.endsWith('.ts'));
  assert.ok(names.length >= 2);
  const segmentUrl = `${base}/live/${feed.id}/${names.at(-1)}`;
  const segment = await fetch(segmentUrl);
  assert.equal(segment.status, 200);
  assert.equal(segment.headers.get('content-type'), 'video/mp2t');
  assert.ok((await segment.arrayBuffer()).byteLength > 0);

  const info = await describeStream(base + feed.url);
  assert.match(info, /Video: h264/);
  assert.match(info, /yuv420p/);
  assert.match(info, /Audio: aac/);

  // Sender leaves: idle, not an error, and off the channel.
  await push.stop();
  const idle = await waitStatus(admin, feed.id, 'idle');
  assert.equal(idle.message, null, 'a sender stopping is not an error');
  state = await nextState(p, (s) => !hasFeed(s));
  assert.equal(state.slides.length, 1);

  // Reconnect.
  push = sender(input, feedPort);
  await waitStatus(admin, feed.id, 'live');
  await nextState(p, hasFeed);

  // Clean shutdown.
  const pids = server.live.childPids();
  assert.equal(pids.length, 1);
  await push.stop();
  await stop();
  for (const pid of pids) assert.throws(() => process.kill(pid, 0), 'the feed ffmpeg has exited');
  assert.deepEqual(strayFfmpeg(feedPort), [], 'no ffmpeg left behind');
}

test('RTMP feed: idle, live over HTTP as H.264, idle when the sender leaves, live on reconnect, nothing left after stop', async (t) => {
  const caps = await probeCapabilities(FFMPEG);
  if (!caps.rtmp) return t.skip(`RTMP is not in this ffmpeg build (${FFMPEG})`);
  await fullRun(t, 'rtmp');
});

test('SRT feed: same path as RTMP', async (t) => {
  const caps = await probeCapabilities(FFMPEG);
  if (!caps.srt) return t.skip(`SRT is NOT in this ffmpeg build (${FFMPEG}), so the SRT path is unverified on this computer. To run it, set SIGNAGE_FFMPEG to a build with libsrt.`);
  await fullRun(t, 'srt');
});

test('a build with no SRT hides it and refuses it plainly', async (t) => {
  const caps = await probeCapabilities(FFMPEG);
  if (caps.srt) return t.skip('this ffmpeg build has SRT');
  const { base } = await boot(t);
  const admin = await setupAdmin(base);
  const options = (await admin.get('/api/live-feeds/options')).data;
  assert.equal(options.inputs.srt, false);
  const r = await admin.post('/api/live-feeds', { name: 'S', input: 'srt', port: await freePort() });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /cannot receive SRT/);
});

test('override on a feed that is down waits, then swaps to the feed as soon as it is live', async (t) => {
  const { port, base } = await boot(t);
  const admin = await setupAdmin(base);
  const [main] = (await admin.get('/api/channels')).data;
  const feedPort = await freePort();
  const feed = (await admin.post('/api/live-feeds', { name: 'Game', input: 'rtmp', port: feedPort })).data;
  const p = await tv(t, port, main.slug);
  await nextState(p, () => true);

  const ov = await admin.post('/api/overrides', { mediaId: feed.id, allChannels: true });
  assert.equal(ov.status, 200);
  const down = await nextState(p, (s) => s.override);
  assert.equal(down.override.slides.length, 1);
  assert.equal(down.override.slides[0].type, 'text');
  assert.equal(down.override.slides[0].title, 'Waiting for the live feed');

  const push = sender('rtmp', feedPort);
  t.after(() => push.stop());
  const up = await nextState(p, (s) => s.override?.slides[0].type === 'hls');
  assert.equal(up.override.slides[0].src, feed.url);
  assert.notEqual(up.override.slides[0].key, down.override.slides[0].key, 'the player swaps because the key changed');

  await push.stop();
  const again = await nextState(p, (s) => s.override?.slides[0].type === 'text');
  assert.equal(again.override.slides[0].title, 'Waiting for the live feed');
});

test('an external .m3u8 item is unaffected by the live feed rules', async (t) => {
  const { server, port, base } = await boot(t);
  const admin = await setupAdmin(base);
  const [main] = (await admin.get('/api/channels')).data;
  const ext = (await admin.post('/api/media/url', { url: 'http://10.0.0.5/stream.m3u8' })).data;
  assert.equal(ext.type, 'hls');
  assert.equal(ext.live, false);
  assert.equal(server.live.isAvailable(ext.id), true);
  await admin.post(`/api/channels/${main.id}/items`, { mediaId: ext.id });
  const p = await tv(t, port, main.slug);
  const s = await nextState(p, () => true);
  assert.equal(s.slides[0].src, 'http://10.0.0.5/stream.m3u8');
  const moved = await admin.patch(`/api/media/${ext.id}`, { url: 'http://10.0.0.6/other.m3u8' });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.url, 'http://10.0.0.6/other.m3u8');
});

test('feeds are admin-only to manage, but editors can use them on their own channels', async (t) => {
  const { base } = await boot(t);
  const admin = await setupAdmin(base);
  const [main] = (await admin.get('/api/channels')).data;
  const other = (await admin.post('/api/channels', { name: 'Other' })).data;
  const editor = await makeEditor(admin, base, 'ed', { channelIds: [main.id] });
  const anon = client(base);
  const feedPort = await freePort();

  // Turned off, so these checks need no ffmpeg.
  const feed = (await admin.post('/api/live-feeds', { name: 'Program', input: 'rtmp', port: feedPort, enabled: false })).data;
  assert.equal(feed.status, 'off');

  for (const c of [editor, anon]) {
    const expected = c === editor ? 403 : 401;
    assert.equal((await c.get('/api/live-feeds')).status, expected);
    assert.equal((await c.get('/api/live-feeds/options')).status, expected);
    assert.equal((await c.post('/api/live-feeds', { name: 'X', input: 'rtmp', port: await freePort() })).status, expected);
    assert.equal((await c.patch(`/api/live-feeds/${feed.id}`, { name: 'X' })).status, expected);
  }

  const seen = (await editor.get('/api/media')).data.find((m) => m.id === feed.id);
  assert.equal(seen.live, true, 'editors see feeds in the library');
  assert.equal(seen.liveStatus, 'off');
  assert.equal((await editor.post(`/api/channels/${main.id}/items`, { mediaId: feed.id })).status, 200);
  assert.equal((await editor.post(`/api/channels/${other.id}/items`, { mediaId: feed.id })).status, 403);

  // Library routes cannot be used to get around any of this.
  assert.equal((await editor.del(`/api/media/${feed.id}`)).status, 403);
  const badUrl = await admin.patch(`/api/media/${feed.id}`, { url: 'http://evil.example/x.m3u8' });
  assert.equal(badUrl.status, 400);
  assert.equal((await editor.patch(`/api/media/${feed.id}`, { url: 'http://evil.example/x.m3u8' })).status, 400);
  const same = await admin.patch(`/api/media/${feed.id}`, { name: 'Renamed', url: feed.url });
  assert.equal(same.status, 200);
  assert.equal(same.data.url, feed.url);
  assert.equal((await feedStatus(admin, feed.id)).name, 'Renamed');
});

test('port rules: range, the server port, other feeds, and other programs', async (t) => {
  const { port, base } = await boot(t);
  const admin = await setupAdmin(base);
  const make = (body) => admin.post('/api/live-feeds', { name: 'F', input: 'rtmp', ...body });

  for (const bad of [80, 1023, 65536, 'abc', null, 1.5]) {
    const r = await make({ port: bad });
    assert.equal(r.status, 400, `port ${bad}`);
    assert.match(r.data.error, /1024 to 65535/);
  }
  const server = await make({ port });
  assert.equal(server.status, 400);
  assert.match(server.data.error, /web server/);

  const taken = await freePort();
  assert.equal((await make({ port: taken, enabled: false })).status, 200);
  const conflict = await make({ port: taken });
  assert.equal(conflict.status, 409);
  assert.match(conflict.data.error, /another live feed/);

  const busy = await freePort();
  const blocker = await hold(busy);
  t.after(() => blocker.close());
  const refused = await make({ port: busy });
  assert.equal(refused.status, 409);
  assert.match(refused.data.error, /another program/);

  const bitrate = await make({ port: await freePort(), maxBitrate: 100 });
  assert.equal(bitrate.status, 400);
  const nameless = await admin.post('/api/live-feeds', { input: 'rtmp', port: await freePort() });
  assert.equal(nameless.status, 400);
  const noDevice = await admin.post('/api/live-feeds', { name: 'D', input: 'device' });
  assert.equal(noDevice.status, 400);
});

test('deleting the library item stops ffmpeg and removes the feed and its segments', async (t) => {
  const { server, base, dataDir } = await boot(t);
  const admin = await setupAdmin(base);
  const [main] = (await admin.get('/api/channels')).data;
  const feedPort = await freePort();
  const feed = (await admin.post('/api/live-feeds', { name: 'Program', input: 'rtmp', port: feedPort })).data;
  await admin.post(`/api/channels/${main.id}/items`, { mediaId: feed.id });
  const dir = path.join(dataDir, 'live', feed.id);
  const push = sender('rtmp', feedPort);
  t.after(() => push.stop());
  await waitStatus(admin, feed.id, 'live');
  assert.ok(fs.existsSync(path.join(dir, 'index.m3u8')));
  const [pid] = server.live.childPids();

  assert.equal((await admin.del(`/api/media/${feed.id}`)).status, 200);
  assert.throws(() => process.kill(pid, 0), 'ffmpeg stopped');
  assert.equal(fs.existsSync(dir), false, 'segments removed');
  assert.deepEqual(server.live.childPids(), []);
  assert.equal(server.db.get('SELECT 1 AS x FROM live_feeds WHERE media_id = ?', feed.id), undefined);
  assert.equal(server.db.get('SELECT 1 AS x FROM playlist_items WHERE media_id = ?', feed.id), undefined);
  assert.equal((await fetch(base + feed.url)).status, 404);
  assert.equal((await admin.get('/api/live-feeds')).data.length, 0);
  await push.stop();
  await sleep(300);
  assert.deepEqual(server.live.childPids(), [], 'it does not come back');
});

test('boot: enabled feeds start, stale files go, a busy port is a plain error that clears', async (t) => {
  const first = await boot(t);
  const admin = await setupAdmin(first.base);
  const feedPort = await freePort();
  const feed = (await admin.post('/api/live-feeds', { name: 'Program', input: 'rtmp', port: feedPort })).data;
  await waitFor('ffmpeg to start', () => first.server.live.childPids().length === 1);
  await first.stop();
  assert.deepEqual(strayFfmpeg(feedPort), []);

  const stale = path.join(first.dataDir, 'live', feed.id);
  fs.mkdirSync(stale, { recursive: true });
  fs.writeFileSync(path.join(stale, 'seg-1.ts'), 'old');
  const orphan = path.join(first.dataDir, 'live', 'not-a-feed');
  fs.mkdirSync(orphan, { recursive: true });

  const blocker = await hold(feedPort);
  let released = false;
  const release = () => new Promise((resolve) => {
    if (released) return resolve();
    released = true;
    blocker.close(resolve);
  });
  t.after(release);

  const second = await createServer({ dataDir: first.dataDir, port: 0, host: '127.0.0.1' });
  const { port } = await second.start();
  t.after(() => second.stop());
  const after = client(`http://127.0.0.1:${port}`);
  await after.post('/api/login', { username: 'ada', password: 'correct horse' });

  assert.equal(fs.existsSync(orphan), false, 'leftover folders are cleared at boot');
  const failed = await waitStatus(after, feed.id, 'error');
  assert.match(failed.message, new RegExp(`Port ${feedPort} is being used by another program`));
  assert.equal(fs.existsSync(path.join(stale, 'seg-1.ts')), false, 'stale segments are cleared when a feed starts');

  await release();
  await waitStatus(after, feed.id, 'idle');
  const status = await feedStatus(after, feed.id);
  assert.equal(status.message, null);

  const push = sender('rtmp', feedPort);
  t.after(() => push.stop());
  await waitStatus(after, feed.id, 'live');
  await push.stop();
});

test('turning a feed off stops ffmpeg, and turning it on starts it again', async (t) => {
  const { server, base } = await boot(t);
  const admin = await setupAdmin(base);
  const feedPort = await freePort();
  const feed = (await admin.post('/api/live-feeds', { name: 'Program', input: 'rtmp', port: feedPort })).data;
  await waitFor('ffmpeg to start', () => server.live.childPids().length === 1);
  const off = await admin.patch(`/api/live-feeds/${feed.id}`, { enabled: false });
  assert.equal(off.data.status, 'off');
  assert.deepEqual(server.live.childPids(), []);
  const on = await admin.patch(`/api/live-feeds/${feed.id}`, { enabled: true });
  assert.equal(on.status, 200, JSON.stringify(on.data));
  assert.equal(on.data.status, 'idle');
  await waitFor('ffmpeg to restart', () => server.live.childPids().length === 1);

  const newPort = await freePort();
  const moved = await admin.patch(`/api/live-feeds/${feed.id}`, { port: newPort });
  assert.equal(moved.data.port, newPort);
  assert.ok(moved.data.address.url.includes(`:${newPort}`));
  const renamed = await admin.patch(`/api/live-feeds/${feed.id}`, { name: 'New name' });
  assert.equal(renamed.data.name, 'New name');
});

test('options list only what works, and /live/ goes through the LAN filter', async (t) => {
  const { server, base, port } = await boot(t);
  const admin = await setupAdmin(base);
  const options = (await admin.get('/api/live-feeds/options')).data;
  assert.ok(options.encoders.some((e) => e.id === 'libx264'), 'software encoding always passes its test');
  assert.equal(options.best, options.encoders[0].id);
  assert.equal(typeof options.inputs.rtmp, 'boolean');
  assert.ok(options.suggestedPorts.rtmp !== port);

  const outside = await server.app.inject({ url: '/live/x/index.m3u8', remoteAddress: '8.8.8.8' });
  assert.equal(outside.statusCode, 403);
  const inside = await server.app.inject({ url: '/live/x/index.m3u8', remoteAddress: '192.168.1.5' });
  assert.equal(inside.statusCode, 404);
});

test('a 1.0.2 database upgrades to live feeds, and media keeps its type constraint', () => {
  const sql = execFileSync('git', ['show', 'v1.0.2:server/db.js'], { encoding: 'utf8' }).match(/const SCHEMA = `([\s\S]*?)`;/)[1];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signage-live-mig-')), 'signage.db');
  const raw = new DatabaseSync(file);
  raw.exec(sql);
  raw.exec('PRAGMA user_version = 1');
  raw.exec(`INSERT INTO users (username, name, password_hash, role, can_override, created_at) VALUES ('ada', 'Ada', 'x', 'admin', 1, 1);
    INSERT INTO channels (slug, name, created_at) VALUES ('gym', 'Gym', 1);
    INSERT INTO media (id, type, name, title, created_at) VALUES ('m1', 'text', 'Hello', 'Hello', 1);
    INSERT INTO playlist_items (channel_id, media_id, position, duration) VALUES (1, 'm1', 0, 7);`);
  raw.close();

  const db = openDb(file);
  assert.equal(db.get('SELECT duration FROM playlist_items').duration, 7, 'playlists survive');
  assert.throws(() => db.run("INSERT INTO media (id, type, name, created_at) VALUES ('m2', 'live', 'No', 1)"), /CHECK/);
  db.run("INSERT INTO media (id, type, name, url, created_at) VALUES ('f1', 'hls', 'Feed', '/live/f1/index.m3u8', 1)");
  db.run("INSERT INTO live_feeds (media_id, input, port) VALUES ('f1', 'rtmp', 5000)");
  assert.equal(db.get('SELECT max_bitrate FROM live_feeds').max_bitrate, 6000);
  assert.throws(() => db.run("INSERT INTO live_feeds (media_id, input) VALUES ('m1', 'rtmp')"), /CHECK/, 'a listener needs a port');
  db.run("DELETE FROM media WHERE id = 'f1'");
  assert.equal(db.all('SELECT * FROM live_feeds').length, 0, 'deleting the media row cascades');
  assert.equal(db.all('SELECT * FROM playlist_items').length, 1);
  db.close();
});
