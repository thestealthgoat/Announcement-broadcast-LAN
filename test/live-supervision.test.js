import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFile, spawn, spawnSync } from 'node:child_process';
import { createServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { createLiveFeeds } from '../server/live/supervisor.js';
import { probeCapabilities } from '../server/live/probe.js';
import { LOOKUP_MS, commandLineOf, createPidFiles, isOurFfmpeg } from '../server/live/orphans.js';
import { atEnd, client, setupAdmin } from './helpers.js';

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
  atEnd(t, () => fs.rmSync(dir, { recursive: true, force: true }));
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
  atEnd(t, () => {
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
  atEnd(t, async () => {
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
  atEnd(t, () => server.stop());
  const failed = await waitFor('the feed to report the problem', () => (server.live.statusOf('bad') === 'error' ? server.live.describe('bad') : null));
  assert.match(failed.message, /choose the device again/i);
  assert.equal((await fetch(`http://127.0.0.1:${port}/tv`)).status, 200, 'the server is still up');
});

test('capture device names with control characters are refused, and a bad saved row can still be renamed or turned off', async (t) => {
  const dataDir = tempDir(t);
  const server = await createServer({ dataDir, port: 0, host: '127.0.0.1' });
  const { port } = await server.start();
  atEnd(t, () => server.stop());
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
  atEnd(t, () => {
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

test('a lookup that fails keeps the record, and later runs of that feed do not lose it, so the next start can still clear it', { skip: !POSIX }, async (t) => {
  const dir = tempDir(t);
  const script = path.join(dir, 'ffmpeg');
  fs.writeFileSync(script, '#!/bin/sh\nwhile :; do sleep 1; done\n');
  fs.chmodSync(script, 0o755);
  const target = 'rtmp://0.0.0.0:52998/live/feed';
  const leftover = spawn(script, ['-i', target, 'index.m3u8'], { stdio: 'ignore', detached: true });
  stopLater(t, leftover.pid);

  const pidDir = path.join(dir, 'pids');
  const unknown = createPidFiles(pidDir, { lookup: async () => null });
  unknown.write('feed', leftover.pid, script, target);
  await unknown.reapAll();
  assert.equal(alive(leftover.pid), true, 'not checked, so not touched');
  assert.equal(fs.readdirSync(pidDir).length, 1, 'the record is still there');

  // The feed comes back up and writes and removes its own record, as it does on every run.
  unknown.write('feed', 999999, script, target);
  unknown.remove('feed');
  assert.equal(fs.readdirSync(pidDir).length, 1, 'that must not take the old record with it');

  await createPidFiles(pidDir).reapAll();
  await waitFor('the leftover to be stopped', () => leftover.exitCode !== null || leftover.signalCode !== null);
  assert.deepEqual(fs.readdirSync(pidDir), [], 'cleared and forgotten');
});

test('a record whose process has gone is forgotten without asking anything', { skip: !POSIX }, async (t) => {
  const dir = tempDir(t);
  const gone = spawn('sleep', ['0'], { stdio: 'ignore' });
  await new Promise((r) => gone.once('exit', r));
  let lookups = 0;
  const pids = createPidFiles(dir, { lookup: async () => { lookups += 1; return null; } });
  pids.write('feed', gone.pid, '/x/ffmpeg', 'y');
  await pids.reapAll();
  assert.equal(lookups, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('the lookup gets a long enough limit, and stopping the server does not wait it out', { skip: !POSIX }, async (t) => {
  assert.equal(LOOKUP_MS, 15000);
  const dir = tempDir(t);
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  stopLater(t, sleeper.pid);
  let seenSignal = null;
  const pids = createPidFiles(dir, {
    lookup: (pid, { signal }) => new Promise((resolve) => {
      seenSignal = signal;
      signal.addEventListener('abort', () => resolve(null));
    }),
  });
  pids.write('feed', sleeper.pid, '/x/ffmpeg', 'y');
  const reaping = pids.reapAll();
  await waitFor('the lookup to start', () => seenSignal);
  pids.cancel();
  await reaping;
  assert.equal(fs.readdirSync(dir).length, 1, 'still unknown, so the record stays for the next start');
});

test('live.start() does not wait for the lookup: the server is up while it runs', { skip: !POSIX }, async (t) => {
  const { live, dataDir } = supervisor(t, fakeFfmpeg(t, { feed: 'exec sleep 30' }));
  const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
  stopLater(t, sleeper.pid);
  createPidFiles(path.join(dataDir, 'live-pids')).write('another', sleeper.pid, '/x/ffmpeg', 'y');
  const result = live.start();
  assert.equal(result, undefined, 'it returns no promise for anything to wait on');
});

test('a record is never half written: a reader sees all of it or none of it', { skip: !POSIX }, (t) => {
  const dir = tempDir(t);
  const pids = createPidFiles(dir);
  const seen = new Set();
  for (let i = 0; i < 200; i++) {
    pids.write('feed', 1000 + i, '/x/ffmpeg', `rtmp://0.0.0.0:${i}/live/feed`);
    for (const name of fs.readdirSync(dir)) seen.add(name);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'feed.pid'), 'utf8')).pid, 1000 + i);
  }
  assert.deepEqual([...seen], ['feed.pid'], 'no temporary file is left to be read as a record');
});

// Who's listening on a port, asked of the system. The test must not try the port itself: binding it
// even for a moment can make ffmpeg's own bind fail, and that ffmpeg exits and gets replaced under a
// new PID. Connecting would look like a sender, and make ffmpeg exit too.
function listenerOn(port) {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], (err, stdout) => {
      resolve(err ? null : Number(String(stdout).trim().split('\n')[0]) || null);
    });
  });
}
const HAS_LSOF = spawnSync('lsof', ['-v'], { stdio: 'ignore' }).error === undefined;

// A pid file is read whole or not at all, by whichever side, and is gone once a feed stops.
function readPidFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

// However a test using a real ffmpeg ends, its processes go with it. A real ffmpeg listening on a
// port never exits by itself, and SIGKILL on its parent is exactly what doesn't take it along. So
// this remembers every PID the pid file ever named, and stops them by PID in the end, each only if
// its command line still shows it's that ffmpeg.
function cleanUpFeedProcesses(t, pidFile, cli) {
  const seen = new Map();
  const note = () => {
    const record = readPidFile(pidFile);
    if (record?.pid) seen.set(record.pid, record);
  };
  const watcher = setInterval(note, 20);
  atEnd(t, async () => {
    clearInterval(watcher);
    note();
    // A clean stop takes ffmpeg with it. If that isn't quick, it's forced, and the rest is below.
    if (cli.exitCode === null && cli.signalCode === null) {
      const gone = new Promise((resolve) => cli.once('exit', resolve));
      cli.kill('SIGTERM');
      await Promise.race([gone, sleep(8000)]);
      try { cli.kill('SIGKILL'); } catch {}
      note();
    }
    for (const [pid, record] of seen) {
      if (!alive(pid)) continue;
      if (isOurFfmpeg(await commandLineOf(pid), record)) {
        try { process.kill(pid, 'SIGKILL'); } catch {}
      }
    }
  });
  return { watcher, note, seen };
}

test('a real ffmpeg orphaned by SIGKILL is cleared at the next start, so the port works again', { skip: !POSIX || !HAS_LSOF }, async (t) => {
  // Long, as a net only: under load a real ffmpeg takes as long as it takes, and nothing here relies on how long.
  const PATIENCE = 120000;
  const dataDir = tempDir(t);
  const feedPort = await freePort();
  const first = await createServer({ dataDir, port: 0, host: '127.0.0.1' });
  const { port: firstPort } = await first.start();
  let firstStopped = false;
  atEnd(t, async () => {
    if (!firstStopped) await first.stop();
  });
  const firstAdmin = await setupAdmin(`http://127.0.0.1:${firstPort}`);
  const feed = (await firstAdmin.post('/api/live-feeds', { name: 'Program', input: 'rtmp', port: feedPort, enabled: false })).data;
  firstStopped = true;
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
  const closed = new Promise((resolve) => cli.once('exit', resolve));
  const pidFile = path.join(dataDir, 'live-pids', `${feed.id}.pid`);
  const tracked = cleanUpFeedProcesses(t, pidFile, cli);

  // Whichever ffmpeg holds the port is the one to orphan. A retry would change the PID.
  const orphan = await waitFor('ffmpeg to hold the port', async () => {
    const holder = await listenerOn(feedPort);
    return holder && holder === readPidFile(pidFile)?.pid ? holder : null;
  }, PATIENCE);
  cli.kill('SIGKILL');
  await closed;
  assert.equal(alive(orphan), true, 'the orphan survives its parent, which is the problem being fixed');
  assert.equal(await listenerOn(feedPort), orphan, 'and it still holds the port');

  const second = await createServer({ dataDir, port: 0, host: '127.0.0.1' });
  const { port } = await second.start();
  let secondStopped = false;
  atEnd(t, async () => {
    if (!secondStopped) await second.stop();
  });
  await waitFor('the orphan to be stopped', () => !alive(orphan), PATIENCE);
  const replacement = await waitFor('a new ffmpeg to hold the port', async () => {
    const holder = await listenerOn(feedPort);
    return holder && second.live.childPids().includes(holder) ? holder : null;
  }, PATIENCE);
  assert.notEqual(replacement, orphan);
  tracked.note();
  assert.equal(readPidFile(pidFile)?.pid, replacement, 'the file follows the new process');
  assert.equal(second.live.statusOf(feed.id), 'idle', 'no "port in use" error');
  const after = client(`http://127.0.0.1:${port}`);
  await after.post('/api/login', { username: 'ada', password: 'correct horse' });
  assert.equal((await after.get('/api/live-feeds')).data[0].message, null);

  secondStopped = true;
  await second.stop();
  assert.equal(alive(replacement), false, 'a clean stop takes ffmpeg with it');
  assert.equal(fs.existsSync(pidFile), false, 'and leaves no file');
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
  const { pid } = await waitFor('the pid file', () => readPidFile(pidFile));
  stopLater(t, pid);
  const exited = new Promise((resolve) => cli.once('exit', (code, signal) => resolve({ code, signal })));
  cli.kill('SIGHUP');
  assert.deepEqual(await exited, { code: 0, signal: null });
  assert.equal(alive(pid), false, 'ffmpeg went with it');
  assert.equal(fs.existsSync(pidFile), false);
});
