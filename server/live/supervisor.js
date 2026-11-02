// Runs one ffmpeg per enabled feed, and reports each feed as idle, live, error, or off.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { lanAddresses } from '../lan.js';
import { ENCODERS, PLAYLIST, classifyFailure, feedArgs, isSenderDisconnect, playlistSegments, senderAddress } from './ffmpeg-args.js';
import { listDevices, probeCapabilities } from './probe.js';
import { createPidFiles } from './orphans.js';

const POLL_MS = 500;
const FRESH_MS = 4000;      // a playlist older than this means no new video is arriving
const STUCK_MS = 10000;     // a sender that vanished without closing its connection
const MIN_SEGMENTS = 2;     // enough for a player to start at the live edge
const RELISTEN_MS = 150;
const BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30000;
const QUIET_FAILURES = 3;   // a stray connection to a listener should not flash an error
const SETTLED_MS = 3000;
const KILL_AFTER_MS = 3000;
const TAIL_CHARS = 4000;

// What an admin sees when a feed couldn't even be started.
function startProblem(err) {
  if (err?.code === 'ERR_INVALID_ARG_VALUE') return 'The saved capture device name cannot be used. Edit this feed and choose the device again.';
  if (err?.code === 'ENOSPC') return 'The host computer is out of disk space.';
  if (['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EROFS'].includes(err?.code)) return "Could not prepare this feed's folder on the host computer. Trying again.";
  return 'This feed could not start. Trying again.';
}

export function createLiveFeeds({ db, hub, dataDir, ffmpeg, log, platform = process.platform }) {
  const liveDir = path.join(dataDir, 'live');
  fs.mkdirSync(liveDir, { recursive: true });
  const pidFiles = createPidFiles(path.join(dataDir, 'live-pids'), { log });
  const entries = new Map();
  const aborter = new AbortController();
  let stopped = false;
  let poller = null;
  let capsPromise = null;
  let reaped = Promise.resolve();

  const feedDir = (id) => path.join(liveDir, id);
  const loadRow = (id) => db.get('SELECT * FROM live_feeds WHERE media_id = ?', id);

  function capabilities() {
    // Only a usable answer is kept, so the next caller asks again after any other result.
    capsPromise ??= probeCapabilities(ffmpeg, { signal: aborter.signal }).then((caps) => {
      if (!caps.encoders.length) capsPromise = null;
      return caps;
    }, (err) => {
      capsPromise = null;
      throw err;
    });
    return capsPromise;
  }

  // Cleanup that may fail (Windows keeps files busy) without it mattering right now.
  function clearFeedDir(id) {
    try {
      fs.rmSync(feedDir(id), { recursive: true, force: true });
    } catch (err) {
      log?.warn?.({ err, feed: id }, 'Could not remove old live video');
    }
  }

  function setStatus(entry, status, message = null) {
    if (entry.status === status && entry.message === message) return;
    const availabilityChanged = (entry.status === 'live') !== (status === 'live');
    entry.status = status;
    entry.message = message;
    if (stopped || entry.removed) return;
    try {
      if (availabilityChanged) hub.pushMedia(entry.id);
      hub.adminRefresh('live');
      hub.adminRefresh('media');
    } catch (err) {
      log?.error?.(err); // Runs from timers and process events, where a throw would end the server.
    }
  }

  function chooseEncoder(entry, caps) {
    if (entry.softwareOnly && caps.encoders.includes('libx264')) return 'libx264';
    if (caps.encoders.includes(entry.row.encoder)) return entry.row.encoder;
    return caps.best;
  }

  function schedule(entry, ms) {
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => launch(entry), ms);
    entry.timer.unref?.();
  }

  function nextDelay(entry) {
    entry.failures += 1;
    return Math.min(BACKOFF_MS * 2 ** (entry.failures - 1), MAX_BACKOFF_MS);
  }

  function retryLater(entry, message) {
    schedule(entry, nextDelay(entry));
    setStatus(entry, 'error', message);
  }

  // Callers don't wait on this, so it must never reject: that would end the whole server.
  async function launch(entry) {
    try {
      await startFeed(entry);
    } catch (err) {
      if (stopped || entry.removed) return;
      log?.error?.({ err, feed: entry.id }, 'A live feed could not start');
      if (!entry.child) retryLater(entry, startProblem(err));
    }
  }

  async function startFeed(entry) {
    if (stopped || entry.removed || entry.child || !entry.row.enabled) return;
    const generation = ++entry.generation;
    await reaped;
    let caps;
    try {
      caps = await capabilities();
    } catch {
      if (!stopped && generation === entry.generation) retryLater(entry, 'Could not check what ffmpeg can do on this computer. Trying again.');
      return;
    }
    if (stopped || entry.removed || entry.child || generation !== entry.generation) return;
    if (entry.row.input !== 'device' && !caps[entry.row.input]) {
      retryLater(entry, `This computer's copy of ffmpeg cannot receive ${entry.row.input.toUpperCase()}. Choose a different input type.`);
      return;
    }
    const encoder = chooseEncoder(entry, caps);
    if (!encoder) {
      retryLater(entry, 'None of the video encoders work on this computer.');
      return;
    }
    entry.caps = caps;
    entry.encoder = encoder;

    const dir = feedDir(entry.id);
    fs.rmSync(dir, { recursive: true, force: true }); // never serve the last session's video
    fs.mkdirSync(dir, { recursive: true });

    const args = feedArgs(entry.row, encoder, platform);
    const child = spawn(ffmpeg, args, {
      cwd: dir,
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    entry.child = child;
    if (child.pid) pidFiles.write(entry.id, child.pid, ffmpeg, args[args.indexOf('-i') + 1]);
    entry.tail = '';
    entry.sawInput = false;
    entry.sawSegments = false;
    entry.startedAt = Date.now();
    entry.progressAt = Date.now();
    if (entry.status !== 'error') setStatus(entry, 'idle');
    hub.adminRefresh('live');

    child.stderr.on('data', (chunk) => {
      entry.tail = (entry.tail + chunk.toString()).slice(-TAIL_CHARS);
      if (!entry.sawInput && entry.tail.includes('Input #0')) {
        entry.sawInput = true;
        entry.progressAt = Date.now();
      }
    });
    child.on('error', (err) => {
      entry.tail += `\n${err.message}`;
    });
    child.on('close', (code) => {
      if (entry.child === child) {
        entry.child = null;
        pidFiles.remove(entry.id);
      }
      if (stopped || entry.removed || entry.stopping) return;
      onExit(entry, code);
    });
  }

  function onExit(entry, code) {
    const { row, sawInput, sawSegments, tail, encoder } = entry;
    const failure = classifyFailure(tail, row, encoder);
    log?.info?.({ feed: entry.id, code, failure: failure?.kind }, 'live feed ffmpeg exited');

    if (isSenderDisconnect({ input: row.input, code, sawInput, sawSegments, failure })) {
      entry.failures = 0;
      setStatus(entry, 'idle');
      schedule(entry, RELISTEN_MS);
      return;
    }
    if (failure?.kind === 'encoder') {
      // For example NVENC running out of sessions: carry on with the software encoder.
      entry.softwareOnly = true;
      if (chooseEncoder(entry, entry.caps) !== encoder) {
        setStatus(entry, 'idle');
        schedule(entry, RELISTEN_MS);
        return;
      }
      // No other encoder to move to, so going straight back would only repeat the failure.
      retryLater(entry, failure.message);
      return;
    }
    const delay = nextDelay(entry);
    const isDevice = row.input === 'device';
    if (failure?.fatal || isDevice || entry.failures >= QUIET_FAILURES) {
      setStatus(entry, 'error', failure?.message ?? (isDevice ? 'The capture device stopped or could not be opened.' : 'The feed keeps stopping. Trying again.'));
    } else {
      setStatus(entry, 'idle');
    }
    schedule(entry, delay);
  }

  function pollEntry(entry, now) {
    if (!entry.child) return;
    let stat = null;
    let segments = 0;
    const file = path.join(feedDir(entry.id), PLAYLIST);
    try {
      stat = fs.statSync(file);
      segments = playlistSegments(fs.readFileSync(file, 'utf8'));
    } catch {}
    if (stat && now - stat.mtimeMs < FRESH_MS && segments >= MIN_SEGMENTS) {
      entry.sawSegments = true;
      entry.progressAt = now;
      entry.failures = 0;
      setStatus(entry, 'live');
      return;
    }
    if (entry.status === 'live') setStatus(entry, 'idle');
    // A retry that stays up has got past whatever the error was.
    if (entry.status === 'error' && !entry.sawInput && now - entry.startedAt > SETTLED_MS) setStatus(entry, 'idle');
    // A sender can vanish without closing its connection, and ffmpeg would wait on it forever.
    if (entry.sawInput && now - entry.progressAt > STUCK_MS) {
      entry.progressAt = now;
      entry.child.kill('SIGKILL');
    }
  }

  function killChild(entry) {
    const { child } = entry;
    clearTimeout(entry.timer);
    entry.generation += 1;
    if (!child) return Promise.resolve();
    entry.stopping = true;
    return new Promise((resolve) => {
      const force = setTimeout(() => child.kill('SIGKILL'), KILL_AFTER_MS);
      child.once('close', () => {
        clearTimeout(force);
        entry.stopping = false;
        entry.child = null;
        resolve();
      });
      child.kill('SIGTERM');
    });
  }

  function addEntry(id) {
    const entry = {
      id, row: loadRow(id), status: 'off', message: null, encoder: null, child: null, timer: null,
      generation: 0, failures: 0, tail: '', sawInput: false, sawSegments: false, softwareOnly: false,
      stopping: false, removed: false, startedAt: 0, progressAt: 0,
    };
    entries.set(id, entry);
    return entry;
  }

  // Kills children if the process exits by any route that skips stop().
  const killOnExit = () => {
    for (const e of entries.values()) e.child?.kill('SIGKILL');
  };

  // Loaded here rather than in start(), so a TV connecting early never sees a dead feed.
  for (const r of db.all('SELECT media_id FROM live_feeds')) addEntry(r.media_id);

  return {
    liveDir,
    capabilities,

    // True for everything except a local feed that is not live right now.
    isAvailable: (mediaId) => {
      const e = entries.get(mediaId);
      return !e || e.status === 'live';
    },
    isFeed: (mediaId) => entries.has(mediaId),
    statusOf: (mediaId) => entries.get(mediaId)?.status ?? null,

    // Never waits for probing, which carries on in the background.
    start() {
      reaped = pidFiles.reapAll();
      try {
        for (const name of fs.readdirSync(liveDir)) {
          if (!entries.has(name)) fs.rmSync(path.join(liveDir, name), { recursive: true, force: true });
        }
      } catch (err) {
        log?.warn?.({ err }, 'Could not clear old live video');
      }
      process.on('exit', killOnExit);
      poller = setInterval(() => {
        const now = Date.now();
        for (const e of entries.values()) {
          try {
            pollEntry(e, now);
          } catch (err) {
            log?.error?.(err);
          }
        }
      }, POLL_MS);
      poller.unref?.();
      for (const e of entries.values()) {
        if (e.row.enabled) {
          setStatus(e, 'idle');
          launch(e);
        }
      }
    },

    async stop() {
      stopped = true;
      clearInterval(poller);
      aborter.abort();
      process.off('exit', killOnExit);
      await Promise.all([...entries.values()].map(killChild));
      await reaped;
      for (const e of entries.values()) clearFeedDir(e.id);
    },

    // Call after the row is saved. Restarts ffmpeg with the new settings.
    async reload(mediaId) {
      const entry = entries.get(mediaId) ?? addEntry(mediaId);
      await killChild(entry);
      entry.row = loadRow(mediaId);
      Object.assign(entry, { failures: 0, softwareOnly: false, encoder: null });
      clearFeedDir(mediaId);
      if (entry.row.enabled) {
        setStatus(entry, 'idle');
        launch(entry);
      } else {
        setStatus(entry, 'off');
      }
    },

    // Stops ffmpeg and removes the segments. The caller then deletes the media row.
    async remove(mediaId) {
      const entry = entries.get(mediaId);
      if (!entry) return;
      entry.removed = true;
      entry.status = 'off';
      await killChild(entry);
      clearFeedDir(mediaId);
      entries.delete(mediaId);
    },

    describe(mediaId) {
      const e = entries.get(mediaId);
      const host = lanAddresses()[0] ?? 'localhost';
      return {
        status: e?.status ?? 'off',
        message: e?.message ?? null,
        encoder: e?.encoder ?? null,
        encoderLabel: e?.encoder ? ENCODERS[e.encoder].label : null,
        address: e ? senderAddress(e.row, host) : null,
      };
    },

    devices: () => listDevices(ffmpeg, platform, { signal: aborter.signal }),
    childPids: () => [...entries.values()].map((e) => e.child?.pid).filter(Boolean),
  };
}
