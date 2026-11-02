// Writes a backup as a stream: manifest first, then the database snapshot, config, and media,
// then a checksum of every file, which is what lets a restore catch damaged media.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { DatabaseSync } from 'node:sqlite';
import { plainError } from '../auth.js';
import { VERSION } from '../version.js';
import { entryHeader, paddingFor, endOfArchive } from './tar.js';
import { BACKUP_EXTENSION, CHECKSUMS_NAME, CONFIG_NAME, DB_NAME, EXPORT_TMP_DIR, FORMAT, FORMAT_VERSION, MANIFEST_NAME, MEDIA_NAME } from './layout.js';

const READ_BYTES = 256 * 1024;
const SKIP_FILE = /\.tmp$|^\.DS_Store$/; // an upload still arriving, or nothing of ours

export const tooBigMessage = (maxSize) => `This library is too big to back up here, because a backup over ${Math.floor(maxSize / 1024 ** 3)} GB could not be restored. Delete items you no longer need, then try again.`;

// Files only, and never a symlink. Names use "/" on every platform.
function listMedia(dataDir) {
  const out = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = fs.readdirSync(path.join(dataDir, ...rel.split('/')), { withFileTypes: true });
    } catch (err) {
      if (err.code === 'ENOENT') return; // deleted just now
      throw err;
    }
    for (const e of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const name = `${rel}/${e.name}`;
      if (e.isDirectory()) walk(name);
      else if (e.isFile() && !SKIP_FILE.test(e.name)) out.push(name);
    }
  };
  walk(MEDIA_NAME);
  return out;
}

function listFiles(dataDir) {
  const names = listMedia(dataDir);
  if (fs.lstatSync(path.join(dataDir, CONFIG_NAME), { throwIfNoEntry: false })?.isFile()) names.unshift(CONFIG_NAME);
  const files = [];
  for (const name of names) {
    const file = path.join(dataDir, ...name.split('/'));
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    if (stat) files.push({ name, file, size: stat.size, mtime: stat.mtimeMs / 1000 });
  }
  return files;
}

const checksumLine = (name, sha256) => `${JSON.stringify({ path: name, sha256 })}\n`;

// The snapshot is taken through SQLite, so it's consistent while TVs play. Sessions come out so a
// stolen backup can't resume anyone's sign-in, then VACUUM drops the pages they were on.
function takeSnapshot(db, file) {
  db.run('VACUUM INTO ?', file);
  const snap = new DatabaseSync(file);
  try {
    snap.exec('PRAGMA journal_mode = DELETE; DELETE FROM sessions;');
    snap.exec('VACUUM');
    return snap.prepare('PRAGMA user_version').get().user_version;
  } finally {
    snap.close();
  }
}

function totalLength(entries) {
  return entries.reduce((sum, e) => sum + entryHeader(e).length + e.size + paddingFor(e.size), endOfArchive().length);
}

function* padding(size) {
  const n = paddingFor(size);
  if (n) yield Buffer.alloc(n);
}

function changed(message) {
  return Object.assign(new Error(message), { changed: true });
}

// Yields exactly the size the header promised, or fails. Padding a short file would make a
// backup that looks whole but isn't, and failing here cuts the download off where it stands.
async function* fileChunks(entry) {
  const fh = await fs.promises.open(entry.file, 'r').catch((err) => {
    throw changed(`${entry.name} could not be opened: ${err.code}`);
  });
  const hash = createHash('sha256');
  try {
    let left = entry.size;
    while (left > 0) {
      const buf = Buffer.allocUnsafe(Math.min(READ_BYTES, left));
      const { bytesRead } = await fh.read(buf, 0, buf.length, entry.size - left);
      if (bytesRead === 0) throw changed(`${entry.name} got shorter`);
      const piece = buf.subarray(0, bytesRead);
      hash.update(piece);
      left -= bytesRead;
      yield piece;
    }
    entry.sha256 = hash.digest('hex');
  } finally {
    await fh.close();
  }
}

// What a backup would hold right now, without making one.
export function summarize(dataDir) {
  const files = listFiles(dataDir);
  const dbSize = fs.statSync(path.join(dataDir, DB_NAME), { throwIfNoEntry: false })?.size ?? 0;
  return { fileCount: files.length + 1, totalSize: files.reduce((n, f) => n + f.size, dbSize) };
}

// Takes the snapshot and returns a stream to send. The temporary snapshot is removed when the
// stream closes, whether it finished, failed, or the client went away.
export function createExport({ db, dataDir, log, maxSize, now = () => new Date() }) {
  const tmpDir = path.join(dataDir, EXPORT_TMP_DIR);
  fs.mkdirSync(tmpDir, { recursive: true });
  const snapshotFile = path.join(tmpDir, `snapshot-${randomUUID()}.db`);
  const cleanup = () => {
    for (const f of [snapshotFile, `${snapshotFile}-journal`]) fs.rmSync(f, { force: true });
    try {
      fs.rmdirSync(tmpDir); // only succeeds when no other backup is running
    } catch {}
  };

  let schemaVersion;
  let files;
  try {
    schemaVersion = takeSnapshot(db, snapshotFile);
    files = listFiles(dataDir);
  } catch (err) {
    cleanup();
    if (err.code === 'ENOSPC' || /disk is full|database or disk/i.test(err.message)) {
      throw plainError(507, 'This computer does not have enough free space to make a backup.');
    }
    throw err;
  }

  const stat = fs.statSync(snapshotFile);
  const payload = [{ name: DB_NAME, file: snapshotFile, size: stat.size, mtime: stat.mtimeMs / 1000 }, ...files];
  const created = now();
  const manifestBytes = Buffer.from(JSON.stringify({
    format: FORMAT,
    formatVersion: FORMAT_VERSION,
    appVersion: VERSION,
    schemaVersion,
    createdAt: created.toISOString(),
    fileCount: payload.length,
    totalSize: payload.reduce((n, f) => n + f.size, 0),
  }, null, 2));
  const mtime = created.getTime() / 1000;
  const manifestEntry = { name: MANIFEST_NAME, size: manifestBytes.length, mtime };
  const checksumsSize = payload.reduce((n, f) => n + Buffer.byteLength(checksumLine(f.name, '0'.repeat(64))), 0);
  const checksumsEntry = { name: CHECKSUMS_NAME, size: checksumsSize, mtime };
  const contentLength = totalLength([manifestEntry, ...payload, checksumsEntry]);

  if (maxSize && contentLength > maxSize) {
    cleanup();
    throw plainError(413, tooBigMessage(maxSize));
  }

  async function* generate() {
    yield entryHeader(manifestEntry);
    yield manifestBytes;
    yield* padding(manifestBytes.length);
    for (const entry of payload) {
      yield entryHeader(entry);
      yield* fileChunks(entry);
      yield* padding(entry.size);
    }
    const sums = Buffer.from(payload.map((f) => checksumLine(f.name, f.sha256)).join(''));
    yield entryHeader(checksumsEntry);
    yield sums;
    yield* padding(sums.length);
    yield endOfArchive();
  }

  const stream = Readable.from(generate(), { objectMode: false, highWaterMark: READ_BYTES });
  stream.once('close', cleanup);
  stream.once('error', (err) => {
    log?.warn?.({ err: err.message }, err.changed ? 'A backup stopped because the library changed during it' : 'A backup stopped');
  });
  // The computer's own date, as the UTC one can be tomorrow's by the evening.
  const stamp = [created.getFullYear(), String(created.getMonth() + 1).padStart(2, '0'), String(created.getDate()).padStart(2, '0')].join('-');
  return { stream, contentLength, filename: `network-signage-${stamp}${BACKUP_EXTENSION}` };
}
