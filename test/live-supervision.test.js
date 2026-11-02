import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { createLiveFeeds } from '../server/live/supervisor.js';
import { probeCapabilities } from '../server/live/probe.js';
import { commandLineOf, createPidFiles, isOurFfmpeg } from '../server/live/orphans.js';
import { client, setupAdmin } from './helpers.js';

const POSIX = process.platform !== 'win32';
const ROOT = path.join(import.meta.dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, check, ms = 20000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-supervise-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// Stops only what this test started, by its own PID.
function stopLater(t, pid) {
  t.after(() => {
    try { process.kill(pid, 'SIGKILL'); } catch {}
  });
}

// A stand-in for ffmpeg that does what the test's shell snippet says, and logs every run.
function fakeFfmpeg(t, { protocols = "printf 'Input:\\n  rtmp\\n  file\\nOutput:\\n  rtmp\\n'", encoders = 'libx264', testEncode = 'exit 0', feed = 'exit 1' }) {
  const dir = tempDir(t);
  const file = path.join(dir, 'ffmpeg');
  const runs = path.join(dir, 'runs.log');
  const listing = encoders ? encoders.split(' ').map((e) => ` V....D ${e}  test`).join('\\n') : '';
  fs.writeFileSync(file, `#!/bin/sh
echo "$*" >> "${runs}"
case "$*" in
  *-protocols*) ${protocols}; exit 0 ;;
  *-encoders*) printf '${listing}\\n'; exit 0 ;;
  *"-f null"*) ${testEncode} ;;
esac
${feed}
`);
  fs.chmodSync(file, 0o755);
  return {
    path: file,
    feedRuns: () => (fs.existsSync(runs) ? fs.readFileSync(runs, 'utf8').split('\n').filter((l) => l.includes('index.m3u8')) : []),
  };
}

// The real supervisor and a real database, with no web server around them.
function supervisor(t, ffmpeg) {
  const dataDir = tempDir(t);
  const db = openDb(path.join(dataDir, 'signage.db'));
  db.run("INSERT INTO media (id, type, name, url, created_at) VALUES ('f1', 'hls', 'Feed', '/live/f1/index.m3u8', 1)");
  db.run("INSERT INTO live_feeds (media_id, input, port) VALUES ('f1', 'rtmp', 52001)");
  const live = createLiveFeeds({ db, hub: { pushMedia() {}, adminRefresh() {} }, dataDir, ffmpeg: ffmpeg.path });
  t.after(async () => {
    await live.stop();
    db.close();
  });
  return { live, db, dataDir };
}

// ---------- launch must never bring the server down ----------

test('a saved device name with a NUL cannot stop the server booting', async (t) => {
  const dataDir = tempDir(t);
  const seed = openDb(path.join(dataDir, 'signage.db'));
  seed.run("INSERT INTO media (id, type, name, url, created_at) VALUES ('bad', 'hls', 'Bad', '/live/bad/index.m3u8', 1)");
  seed.run("INSERT INTO live_feeds (media_id, input, device) VALUES ('bad', 'device', ?)", 'Cam\0era');
  seed.close();

  const server = await createServer({ dataDir, port: 0, host: '127.0.0.1' });
  const { port } = await server.start();
  t.after(() => server.stop());
  const failed = await waitFor('the feed to report the problem', () => (server.live.statusOf('bad') === 'error' ? server.live.describe('bad') : null));
  assert.match(failed.message, /choose the device again/i);
  assert.equal((await fetch(`http://127.0.0.1:${port}/tv`)).status, 200, 'the server is still up');
});

test('capture device names with control characters are refused, and a bad saved row can still be renamed or turned off', async (t) => {
  const dataDir = tempDir(t);
  const server = await createServer({ dataDir, port: 0, host: '127.0.0.1' });
  const { port } = await server.start();
  t.after(() => server.stop());
  const admin = await setupAdmin(`http://127.0.0.1:${port}`);

  for (const body of [{ device: 'Cam\u0000era' }, { device: 'Cam\nera' }, { device: 'Cam', audioDevice: 'Mic\u0007' }, { device: 'Cam\u007f' }]) {
    const r = await admin.post('/api/live-feeds', { name: 'D', input: 'device', enabled: false, ...body });
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, /can't be used/);
  }
  const good = await admin.post('/api/live-feeds', { name: 'D', input: 'device', enabled: false, device: 'FaceTime HD Camera' });
  assert.equal(good.status, 200, JSON.stringify(good.data));
  assert.equal((await admin.patch(`/api/live-feeds/${good.data.id}`, { audioDevice: 'Bad\u0001' })).status, 400);

  server.db.run('UPDATE live_feeds SET device = ? WHERE media_id = ?', 'Cam\0era', good.data.id);
  const renamed = await admin.patch(`/api/live-feeds/${good.data.id}`, { name: 'Renamed', enabled: false });
  assert.equal(renamed.status, 200, JSON.stringify(renamed.data));
});

test('a filesystem error while starting a feed is an error status and a retry, not a crash', { skip: !POSIX || process.getuid?.() === 0 }, async (t) => {
  const ffmpeg = fakeFfmpeg(t, { feed: 'exec sleep 30' });
  const { live, dataDir } = supervisor(t, ffmpeg);
  const dir = path.join(dataDir, 'live', 'f1');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'seg-1.ts'), 'old');
  fs.chmodSync(dir, 0o555); // the old segments can't be removed
  t.after(() => {
    try { fs.chmodSync(dir, 0o755); } catch {}
  });

  live.start();
  await waitFor('the error status', () => live.statusOf('f1') === 'error');
  assert.match(live.describe('f1').message, /folder/);
  assert.deepEqual(live.childPids(), []);

  fs.chmodSync(dir, 0o755);
  await waitFor('the retry to start ffmpeg', () => live.childPids().length === 1);
});

test('stop survives a segment folder it cannot remove', { skip: !POSIX || process.getuid?.() === 0 }, async (t) => {
  const ffmpeg = fakeFfmpeg(t, { feed: 'exec sleep 30' });
  const { live, dataDir } = supervisor(t, ffmpeg);
  live.start();
  await waitFor('ffmpeg', () => live.childPids().length === 1);
  const dir = path.join(dataDir, 'live', 'f1');
  fs.writeFileSync(path.join(dir, 'seg-1.ts'), 'x');
  fs.chmodSync(dir, 0o555);
  try {
    await live.stop();
  } finally {
    fs.chmodSync(dir, 0o755);
  }
});

// ---------- a probe that failed is not an answer ----------

test('a probe that times out fails, is not cached, and the next probe gets the real answer', { skip: !POSIX }, async (t) => {
  const flag = path.join(tempDir(t), 'hang');
  fs.writeFileSync(flag, '');
  const ffmpeg = fakeFfmpeg(t, { protocols: `if [ -e "${flag}" ]; then exec sleep 30; fi; printf 'Input:\\n  rtmp\\nOutput:\\n'` });
  await assert.rejects(probeCapabilities(ffmpeg.path, { listMs: 200 }), /could not list/i);
  fs.rmSync(flag);
  const caps = await probeCapabilities(ffmpeg.path);
  assert.equal(caps.rtmp, true);
  assert.deepEqual(caps.encoders, ['libx264']);
});

test('an empty listing is a failure too, for protocols and for encoders', { skip: !POSIX }, async (t) => {
  await assert.rejects(probeCapabilities(fakeFfmpeg(t, { protocols: 'true' }).path), /could not list/i);
  await assert.rejects(probeCapabilities(fakeFfmpeg(t, { encoders: '' }).path), /could not list/i);
});

test('a real listing with no SRT is still an answer', { skip: !POSIX }, async (t) => {
  const caps = await probeCapabilities(fakeFfmpeg(t, {}).path);
  assert.equal(caps.srt, false);
  assert.equal(caps.rtmp, true);
});

test('a failed probe is retried with backoff, and the feed recovers with no restart', { skip: !POSIX }, async (t) => {
  const flag = path.join(tempDir(t), 'broken');
  fs.writeFileSync(flag, '');
  const ffmpeg = fakeFfmpeg(t, {
    protocols: `if [ -e "${flag}" ]; then exit 0; fi; printf 'Input:\\n  rtmp\\nOutput:\\n'`,
    feed: 'exec sleep 30',
  });
  const { live } = supervisor(t, ffmpeg);
  live.start();
  await waitFor('the error status', () => live.statusOf('f1') === 'error');
  assert.match(live.describe('f1').message, /ffmpeg/);
  fs.rmSync(flag);
  await waitFor('the feed to start', () => live.childPids().length === 1);
  await waitFor('the error to clear', () => live.statusOf('f1') === 'idle');
  assert.equal(live.describe('f1').message, null);
});

test('no working encoder is retried too, and clears once one works', { skip: !POSIX }, async (t) => {
  const flag = path.join(tempDir(t), 'broken');
  fs.writeFileSync(flag, '');
  const ffmpeg = fakeFfmpeg(t, { testEncode: `if [ -e "${flag}" ]; then exit 1; fi; exit 0`, feed: 'exec sleep 30' });
  const { live } = supervisor(t, ffmpeg);
  live.start();
  await waitFor('the error status', () => live.statusOf('f1') === 'error');
  assert.match(live.describe('f1').message, /encoders/);
  fs.rmSync(flag);
  await waitFor('the feed to start', () => live.childPids().length === 1);
});

// ---------- hardware encoder failures ----------

test('a hardware encoder failing with nothing to fall back to backs off instead of spinning', { skip: !POSIX }, async (t) => {
  const ffmpeg = fakeFfmpeg(t, { encoders: 'h264_videotoolbox', feed: 'echo "Could not open encoder" >&2; exit 1' });
  const { live } = supervisor(t, ffmpeg);
  live.start();
  await waitFor('the first run', () => ffmpeg.feedRuns().length >= 1);
  await sleep(1800);
  const runs = ffmpeg.feedRuns().length;
  assert.ok(runs <= 3, `${runs} runs in 1.8 seconds: at 150 ms this would be about 12`);
  assert.equal(live.statusOf('f1'), 'error');
  assert.match(live.describe('f1').message, /hardware encoder/);
});

test('a hardware encoder failing moves straight to software when that is a real change', { skip: !POSIX }, async (t) => {
  const ffmpeg = fakeFfmpeg(t, {
    encoders: 'h264_videotoolbox libx264',
    feed: 'case "$*" in *libx264*) exec sleep 30 ;; esac; echo "Could not open encoder" >&2; exit 1',
  });
  const { live } = supervisor(t, ffmpeg);
  live.start();
  await waitFor('one hardware try, then software, with no backoff', () => ffmpeg.feedRuns().length === 2 && live.childPids().length === 1, 900);
  assert.equal(live.describe('f1').encoder, 'libx264');
  assert.equal(live.statusOf('f1'), 'idle');
});

// ---------- leftover ffmpeg ----------

test('only a process whose command line is really our ffmpeg counts as ours', () => {
  const record = { pid: 1234, exe: '/Applications/Network Signage.app/ffmpeg', target: 'rtmp://0.0.0.0:5000/live/feed' };
  const line = '/Applications/Network Signage.app/ffmpeg -hide_banner -listen 1 -i rtmp://0.0.0.0:5000/live/feed -f hls index.m3u8';
  assert.equal(isOurFfmpeg(line, record), true);
  assert.equal(isOurFfmpeg('"C:\\Program Files\\x\\ffmpeg.exe" -i "video=My Cam" index.m3u8', { exe: 'C:\\Program Files\\x\\ffmpeg.exe', target: 'video=My Cam' }), true);
  assert.equal(isOurFfmpeg('/usr/bin/vim notes.txt', record), false, 'the PID was reused');
  assert.equal(isOurFfmpeg('/opt/other/ffmpeg -i rtmp://0.0.0.0:5000/live/feed out.mp4', record), false, "someone else's ffmpeg");
  assert.equal(isOurFfmpeg('/Applications/Network Signage.app/ffmpeg -i rtmp://0.0.0.0:6000/live/feed index.m3u8', record), false, 'a different feed');
  assert.equal(isOurFfmpeg('', record), false);
  assert.equal(isOurFfmpeg(null, record), false);
});

test('command lines are read with ps, or on Windows from Win32_Process, and a failed lookup is unknown', async () => {
  const calls = [];
  const run = async (cmd, args) => {
    calls.push([cmd, args]);
    return ' C:\\x\\ffmpeg.exe -i a index.m3u8\r\n';
  };
  assert.equal(await commandLineOf(1234, { platform: 'win32', run }), 'C:\\x\\ffmpeg.exe -i a index.m3u8');
  assert.equal(calls[0][0], 'powershell.exe');
  assert.match(calls[0][1].join(' '), /Win32_Process.*ProcessId=1234/);
  assert.equal(await commandLineOf(1234, { platform: 'darwin', run }), 'C:\\x\\ffmpeg.exe -i a index.m3u8');
  assert.equal(calls[1][0], 'ps');
  assert.deepEqual(calls[1][1], ['-ww', '-p', '1234', '-o', 'command=']);
  assert.equal(await commandLineOf(1234, { platform: 'win32', run: async () => null }), null);
  assert.equal(await commandLineOf(1234, { platform: 'win32', run: async () => '\r\n' }), null, 'Windows hides the command line from other accounts');
});

test('a recorded PID that is not our ffmpeg is left alone, and corrupt files never signal anything', { skip: !POSIX }, async (t) => {
  const dir = tempDir(t);
  const stranger = spawn('sleep', ['30'], { stdio: 'ignore' });
  stopLater(t, stranger.pid);
  const pids = createPidFiles(dir);
  pids.write('reused', stranger.pid, '/x/ffmpeg', 'rtmp://0.0.0.0:5000/live/feed');
  for (const [name, content] of Object.entries({
    garbage: 'not json', zero: '{"pid":0}', group: '{"pid":-1}', init: '{"pid":1}', float: '{"pid":1.5}', text: '{"pid":"12"}',
    own: JSON.stringify({ pid: process.pid, exe: process.execPath, target: 'x' }),
  })) {
    fs.writeFileSync(path.join(dir, `${name}.pid`), content);
  }
  await pids.reapAll();
  await sleep(100);
  assert.equal(alive(stranger.pid), true, 'a process that is not ours keeps running');
  assert.deepEqual(fs.readdirSync(dir), [], 'the files are gone either way');
});

test('a real ffmpeg orphaned by SIGKILL is cleared at the next start, so the port works again', { skip: !POSIX }, async (t) => {
  const dataDir = tempDir(t);
  const feedPort = await freePort();
  const first = await createServer({ dataDir, port: 0, host: '127.0.0.1' });
  const { port: firstPort } = await first.start();
  const firstAdmin = await setupAdmin(`http://127.0.0.1:${firstPort}`);
  const feed = (await firstAdmin.post('/api/live-feeds', { name: 'Program', input: 'rtmp', port: feedPort, enabled: false })).data;
  await first.stop();
  const seed = openDb(path.join(dataDir, 'signage.db'));
  seed.run('UPDATE live_feeds SET enabled = 1 WHERE media_id = ?', feed.id);
  seed.close();

  // The real command-line server, killed the way a force quit kills it.
  const cli = spawn(process.execPath, ['server/cli.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(await freePort()), SIGNAGE_HOST: '127.0.0.1', SIGNAGE_DATA_DIR: dataDir, SIGNAGE_NO_AUTOSTART: '1' },
    stdio: 'ignore',
  });
  stopLater(t, cli.pid);
  const pidFile = path.join(dataDir, 'live-pids', `${feed.id}.pid`);
  const { pid: orphan } = await waitFor('the pid file', () => (fs.existsSync(pidFile) ? JSON.parse(fs.readFileSync(pidFile, 'utf8')) : null));
  stopLater(t, orphan);
  // By trying to bind: connecting would look like a sender, and make ffmpeg exit.
  await waitFor('ffmpeg to hold the port', () => new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(true));
    s.listen(feedPort, '0.0.0.0', () => s.close(() => resolve(false)));
  }));
  const closed = new Promise((resolve) => cli.once('exit', resolve));
  cli.kill('SIGKILL');
  await closed;
  await sleep(200);
  assert.equal(alive(orphan), true, 'the orphan survives its parent, which is the problem being fixed');

  const second = await createServer({ dataDir, port: 0, host: '127.0.0.1' });
  const { port } = await second.start();
  let secondStopped = false;
  t.after(async () => {
    if (!secondStopped) await second.stop();
  });
  await waitFor('the orphan to be stopped', () => !alive(orphan));
  const [replacement] = await waitFor('a new ffmpeg', () => {
    const pids = second.live.childPids();
    return pids.length === 1 ? pids : null;
  });
  assert.notEqual(replacement, orphan);
  stopLater(t, replacement);
  assert.equal(JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid, replacement, 'the file follows the new process');
  await sleep(1500);
  assert.equal(second.live.statusOf(feed.id), 'idle', 'no "port in use" error');
  const after = client(`http://127.0.0.1:${port}`);
  await after.post('/api/login', { username: 'ada', password: 'correct horse' });
  assert.equal((await after.get('/api/live-feeds')).data[0].message, null);

  secondStopped = true;
  await second.stop();
  assert.equal(fs.existsSync(pidFile), false, 'a clean stop leaves no file');
});

test('a feed deleted while the server was down still gets its orphan cleared', { skip: !POSIX }, async (t) => {
  // Stays a script run by sh, so its command line looks like a feed's. Killing sh leaves at most a one-second sleep.
  const dir = tempDir(t);
  const script = path.join(dir, 'ffmpeg');
  fs.writeFileSync(script, '#!/bin/sh\nwhile :; do sleep 1; done\n');
  fs.chmodSync(script, 0o755);
  const target = 'rtmp://0.0.0.0:52999/live/feed';
  const leftover = spawn(script, ['-i', target, 'index.m3u8'], { stdio: 'ignore', detached: true });
  stopLater(t, leftover.pid);
  await sleep(100);

  const { live, dataDir } = supervisor(t, fakeFfmpeg(t, { feed: 'exec sleep 30' }));
  createPidFiles(path.join(dataDir, 'live-pids')).write('deleted-feed', leftover.pid, script, target);
  live.start();
  await waitFor('the orphan to be stopped', () => leftover.exitCode !== null || leftover.signalCode !== null);
  await waitFor('its file to go', () => !fs.existsSync(path.join(dataDir, 'live-pids', 'deleted-feed.pid')));
});

test('SIGHUP shuts the command-line server down cleanly, with no ffmpeg left behind', { skip: !POSIX }, async (t) => {
  const dataDir = tempDir(t);
  const ffmpeg = fakeFfmpeg(t, { feed: 'exec sleep 30' });
  const seed = openDb(path.join(dataDir, 'signage.db'));
  seed.run("INSERT INTO media (id, type, name, url, created_at) VALUES ('f1', 'hls', 'Feed', '/live/f1/index.m3u8', 1)");
  seed.run("INSERT INTO live_feeds (media_id, input, port) VALUES ('f1', 'rtmp', 52002)");
  seed.close();
  const cli = spawn(process.execPath, ['server/cli.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(await freePort()), SIGNAGE_HOST: '127.0.0.1', SIGNAGE_DATA_DIR: dataDir, SIGNAGE_NO_AUTOSTART: '1', SIGNAGE_FFMPEG: ffmpeg.path },
    stdio: 'ignore',
  });
  stopLater(t, cli.pid);
  const pidFile = path.join(dataDir, 'live-pids', 'f1.pid');
  const { pid } = await waitFor('the pid file', () => (fs.existsSync(pidFile) ? JSON.parse(fs.readFileSync(pidFile, 'utf8')) : null));
  stopLater(t, pid);
  const exited = new Promise((resolve) => cli.once('exit', (code, signal) => resolve({ code, signal })));
  cli.kill('SIGHUP');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(alive(pid), false, 'ffmpeg went with it');
  assert.equal(fs.existsSync(pidFile), false);
});
