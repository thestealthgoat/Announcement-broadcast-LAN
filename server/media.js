import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { childPath, mediaFolder } from './safe-path.js';

const require = createRequire(import.meta.url);

export function resolveFfmpeg() {
  if (process.env.SIGNAGE_FFMPEG) return process.env.SIGNAGE_FFMPEG;
  if (process.resourcesPath) {
    const packaged = path.join(process.resourcesPath, 'ffmpeg', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
    if (fs.existsSync(packaged)) return packaged;
  }
  try {
    const p = require('ffmpeg-static');
    if (p && fs.existsSync(p)) return p;
  } catch {}
  return 'ffmpeg';
}

// Returns null when the first bytes are not an allowed image format.
export function sniffImage(buf) {
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.toString('latin1', 0, 6) === 'GIF87a' || buf.toString('latin1', 0, 6) === 'GIF89a') return 'gif';
  if (buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function parseTime(h, m, s) {
  return Number(h) * 3600 + Number(m) * 60 + Number(s);
}

// Reads duration and position from ffmpeg's stderr, which can arrive split at any byte.
export function createProgressParser() {
  let pending = '';
  let total = 0;
  let time = 0;
  return {
    push(text) {
      pending += text;
      if (!total) {
        const d = pending.match(/Duration: (\d+):(\d+):([\d.]+),/);
        if (d) total = parseTime(d[1], d[2], d[3]);
      }
      for (const t of pending.matchAll(/time=(\d+):(\d+):([\d.]+)\s/g)) time = parseTime(t[1], t[2], t[3]);
      pending = pending.slice(-256);
    },
    // A source with no stated duration still gets one from how far ffmpeg got.
    get duration() {
      return total || time;
    },
    get percent() {
      return total ? Math.min(99, Math.floor((time / total) * 100)) : null;
    },
  };
}

export function createProcessor({ db, hub, mediaDir, ffmpeg = resolveFfmpeg(), log }) {
  const queue = [];
  let running = false;
  let currentChild = null;
  let stopped = false;

  function runFfmpeg(args, onStderr) {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
      currentChild = child;
      let tail = '';
      child.stderr.on('data', (d) => {
        const text = d.toString();
        tail = (tail + text).slice(-2000);
        onStderr?.(text);
      });
      child.on('error', reject);
      child.on('close', (code) => {
        currentChild = null;
        if (code === 0) resolve();
        else reject(new Error(tail.trim().split('\n').pop() || `ffmpeg exited with ${code}`));
      });
    });
  }

  async function processVideo(media, dir) {
    const source = childPath(dir, media.file);
    const output = path.join(dir, 'video.mp4');
    const progress = createProgressParser();
    let lastPct = null;
    await runFfmpeg(
      [
        '-i', source,
        '-map', '0:v:0', '-map', '0:a:0?',
        '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
        '-preset', 'veryfast', '-crf', '23', '-maxrate', '8M', '-bufsize', '16M',
        '-vf', 'scale=1920:1080:force_original_aspect_ratio=decrease:force_divisible_by=2',
        '-fpsmax', '60',
        '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000',
        '-movflags', '+faststart',
        output,
      ],
      (text) => {
        progress.push(text);
        const pct = progress.percent;
        if (pct !== null && pct !== lastPct) {
          lastPct = pct;
          db.run('UPDATE media SET progress = ? WHERE id = ?', pct, media.id);
          hub.adminRefresh('media');
        }
      },
    );
    await runFfmpeg([
      '-ss', String(Math.min(1, progress.duration / 2)), '-i', output,
      '-frames:v', '1', '-vf', 'scale=480:-2', '-q:v', '4', path.join(dir, 'thumb.jpg'),
    ]);
    const size = fs.statSync(output).size;
    if (media.file !== 'video.mp4') fs.rmSync(source, { force: true });
    db.run(
      `UPDATE media SET status = 'ready', progress = NULL, file = 'video.mp4', thumb = 'thumb.jpg',
       duration = ?, size = ?, rev = rev + 1 WHERE id = ?`,
      progress.duration || null, size, media.id,
    );
  }

  async function processImage(media, dir) {
    await runFfmpeg([
      '-i', childPath(dir, media.file),
      '-frames:v', '1', '-vf', "scale='min(480,iw)':-2", '-q:v', '4', path.join(dir, 'thumb.jpg'),
    ]);
    db.run("UPDATE media SET status = 'ready', thumb = 'thumb.jpg', rev = rev + 1 WHERE id = ?", media.id);
  }

  async function drain() {
    if (running) return;
    running = true;
    // Always cleared, because backups are refused while this says a conversion is running.
    try {
      while (queue.length && !stopped) {
        const id = queue.shift();
        const media = db.get('SELECT * FROM media WHERE id = ?', id);
        if (!media) continue;
        try {
          const dir = mediaFolder(mediaDir, id);
          if (media.type === 'video') await processVideo(media, dir);
          else await processImage(media, dir);
        } catch (err) {
          if (stopped) break;
          log.error({ err, id }, 'media processing failed');
          const friendly = media.type === 'video' ? 'Could not convert this video.' : 'This does not look like a valid image.';
          db.run("UPDATE media SET status = 'failed', progress = NULL, error = ? WHERE id = ?", friendly, id);
        }
        if (db.get('SELECT 1 AS x FROM media WHERE id = ?', id)) hub.pushMedia(id);
        else removeDeletedFolder(id);
        hub.adminRefresh('media');
      }
    } finally {
      running = false;
    }
  }

  // The item was deleted while converting. If this fails, the next start's sweep takes care of it.
  function removeDeletedFolder(id) {
    try {
      fs.rmSync(mediaFolder(mediaDir, id), { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch (err) {
      log.warn({ err, id }, 'Could not remove a deleted item\'s folder. Will try again at the next start.');
    }
  }

  // Whether an interrupted item's file is there. A record whose path can't be used counts as no.
  function hasFile(m) {
    try {
      return !!m.file && fs.existsSync(childPath(mediaFolder(mediaDir, m.id), m.file));
    } catch {
      return false;
    }
  }

  return {
    enqueue(id) {
      queue.push(id);
      drain().catch((err) => log.error(err));
    },
    busy: () => running || queue.length > 0,
    // Picks up work that a shutdown interrupted.
    resume() {
      for (const m of db.all("SELECT * FROM media WHERE status = 'processing'")) {
        if (hasFile(m)) this.enqueue(m.id);
        else db.run("UPDATE media SET status = 'failed', error = 'The upload was interrupted. Please upload it again.' WHERE id = ?", m.id);
      }
    },
    stop() {
      stopped = true;
      currentChild?.kill();
    },
  };
}
