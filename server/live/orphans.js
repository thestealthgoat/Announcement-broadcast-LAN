// A force quit or crash skips every cleanup path, and the ffmpeg it leaves keeps the feed's port.
// So each running feed has a small file saying which process it is, and the next start clears
// whatever those files still point at. A PID can be reused by anything, so nothing gets a signal
// until its command line shows it's the ffmpeg that file describes. If that can't be checked,
// it's left alone.
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { PLAYLIST } from './ffmpeg-args.js';

// Windows can take this long to start PowerShell on a busy computer. Nothing waits on it except
// the feeds that follow, because a feed must not start while something may still hold its port.
export const LOOKUP_MS = 15000;
const TERM_WAIT_MS = 1500;
const KILL_WAIT_MS = 2000;
const POLL_MS = 50;

const runCommand = (cmd, args, signal) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: LOOKUP_MS, windowsHide: true, signal }, (err, stdout) => resolve(err ? null : String(stdout)));
});

// The process's full command line, or null if it can't be found out.
export async function commandLineOf(pid, { platform = process.platform, run = runCommand, signal } = {}) {
  const output = platform === 'win32'
    ? await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], signal)
    : await run('ps', ['-ww', '-p', String(pid), '-o', 'command='], signal);
  return output?.trim() || null;
}

export function isOurFfmpeg(commandLine, record) {
  if (!commandLine || !record?.exe || !record?.target) return false;
  return /ffmpeg/i.test(commandLine)
    && commandLine.includes(record.exe)
    && commandLine.includes(record.target)
    && commandLine.includes(PLAYLIST);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // Running, but under another account, so certainly not ours to stop.
  }
}

async function waitForExit(pid, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!isAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
  return !isAlive(pid);
}

function signal(pid, name) {
  try {
    process.kill(pid, name);
  } catch {}
}

export function createPidFiles(dir, { log, lookup = commandLineOf } = {}) {
  const fileFor = (id) => path.join(dir, `${encodeURIComponent(id)}.pid`);
  const aborter = new AbortController();

  const forget = (file) => {
    try {
      fs.rmSync(file, { force: true });
    } catch (err) {
      log?.warn?.({ err }, 'Could not remove a live feed process file');
    }
  };

  function keepForNextStart(file, pid) {
    const kept = path.join(dir, `unchecked-${pid}.pid`);
    if (file === kept) return;
    try {
      fs.renameSync(file, kept);
    } catch (err) {
      log?.warn?.({ err }, 'Could not keep a live feed process file');
    }
  }

  async function reap(file) {
    let record = null;
    try {
      record = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    const pid = record?.pid;
    // 0, -1, and 1 are not processes to signal: the first two mean whole groups.
    if (Number.isInteger(pid) && pid > 1 && pid !== process.pid && isAlive(pid)) {
      const commandLine = await lookup(pid, { signal: aborter.signal });
      if (commandLine === null) {
        // Could still be ours and still holding the port, so the next start tries again. It moves
        // out of the feed's own name, because that feed's next run writes and removes that file.
        log?.warn?.({ pid }, 'Could not check a leftover live feed process, so it was left running');
        keepForNextStart(file, pid);
        return;
      }
      if (isOurFfmpeg(commandLine, record)) {
        log?.warn?.({ pid }, 'Stopping an ffmpeg left behind by an earlier run');
        signal(pid, 'SIGTERM');
        if (!await waitForExit(pid, TERM_WAIT_MS)) {
          signal(pid, 'SIGKILL');
          await waitForExit(pid, KILL_WAIT_MS);
        }
      }
    }
    forget(file);
  }

  return {
    write(id, pid, exe, target) {
      try {
        fs.mkdirSync(dir, { recursive: true });
        // Moved into place, so a crash or a reader can never find half a record: that would lose
        // track of a running ffmpeg. The name doesn't end in .pid, so it's never read as one.
        const tmp = `${fileFor(id)}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify({ pid, exe, target }));
        fs.renameSync(tmp, fileFor(id));
      } catch (err) {
        log?.warn?.({ err }, 'Could not record a live feed process'); // Only costs the cleanup after a crash.
      }
    },
    remove: (id) => forget(fileFor(id)),
    // Ends any lookup still running, for shutting down without waiting on one.
    cancel: () => aborter.abort(),
    // Never rejects, so a feed can always wait on it.
    async reapAll() {
      let names = [];
      try {
        const all = fs.readdirSync(dir);
        for (const n of all) if (n.endsWith('.tmp')) forget(path.join(dir, n)); // from a crash mid-write
        names = all.filter((n) => n.endsWith('.pid'));
      } catch {}
      await Promise.all(names.map((n) => reap(path.join(dir, n)).catch((err) => {
        log?.warn?.({ err }, 'Could not clear a leftover live feed process');
      })));
    },
  };
}
