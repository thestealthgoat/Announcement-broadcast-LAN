// Takes a backup from a stream into a staging folder and proves it's good. Nothing outside the
// staging folder is touched here, so a refusal at any point leaves existing data as it was.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { httpError, plainError } from '../auth.js';
import { openDb, latestSchemaVersion } from '../db.js';
import { readTar, TarError } from './tar.js';
import { CHECKSUMS_NAME, CONFIG_NAME, DB_NAME, FORMAT, FORMAT_VERSION, MANIFEST_NAME, MEDIA_NAME, restorePath } from './layout.js';
import { UPLOAD_PREFIX } from './swap.js';
import { isSafeStyle } from '../slide-style.js';
import { RESERVED_MEDIA_FOLDERS } from '../safe-path.js';
import { PLAYLIST, ENCODERS } from '../live/ffmpeg-args.js';

const SMALL_MAX = 64 * 1024;
const CHECKSUMS_MAX = 64 * 1024 * 1024;
const SPACE_MARGIN = 64 * 1024 * 1024; // room for database upgrades
const NOT_A_BACKUP = 'This file is not a Network Signage backup, so nothing was changed.';
const DAMAGED = 'This backup is damaged, so nothing was changed. Make a new backup, or use another copy.';
const INCOMPLETE = 'This backup is incomplete, so nothing was changed. The file may not have finished downloading or copying.';
const UNSAFE = 'This backup contains an unsafe file path, so it was refused and nothing was changed.';
const UNSAFE_DATA = 'This backup contains unsafe data, so it was refused and nothing was changed.';
const UPDATE_FIRST = 'This backup came from a newer version of Network Signage, so nothing was changed. Update this computer to the latest version first, then restore it.';

const refuse = (message) => httpError(400, message);

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.ceil(bytes / 1024 ** 2)} MB`;
}

export async function checkFreeSpace(dataDir, statfs, needed) {
  let free;
  try {
    const s = await statfs(dataDir);
    free = s.bavail * s.bsize;
  } catch {
    return; // Not knowable here, and running out later still fails cleanly.
  }
  if (Number.isFinite(free) && free < needed + SPACE_MARGIN) {
    throw plainError(507, `This computer does not have enough free space for this backup, so nothing was changed. It needs about ${formatBytes(needed + SPACE_MARGIN)} and has ${formatBytes(free)}.`);
  }
}

// Relative, normalized, plain, and under a name a backup is allowed to have. The checks are on
// the text alone, before anything is created. Backslashes and colons count on every platform,
// because a backup made here may be opened on Windows.
export function safeEntryPath(name) {
  if (typeof name !== 'string' || !name || name.length > 4096) return false;
  if (name.startsWith('/') || name.endsWith('/') || /[\\:\0]/.test(name)) return false;
  const parts = name.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..')) return false;
  if (path.posix.normalize(name) !== name) return false;
  if (name === DB_NAME || name === CONFIG_NAME) return true;
  return parts[0] === MEDIA_NAME && parts.length >= 2;
}

function parseManifest(buf) {
  let m;
  try {
    m = JSON.parse(buf.toString('utf8'));
  } catch {
    throw refuse(NOT_A_BACKUP);
  }
  if (m?.format !== FORMAT) throw refuse(NOT_A_BACKUP);
  if (!Number.isInteger(m.formatVersion) || m.formatVersion < 1) throw refuse(DAMAGED);
  if (m.formatVersion > FORMAT_VERSION) throw refuse(UPDATE_FIRST);
  if (!Number.isInteger(m.schemaVersion) || m.schemaVersion < 1) throw refuse(DAMAGED);
  if (m.schemaVersion > latestSchemaVersion()) throw refuse(UPDATE_FIRST);
  if (!Number.isSafeInteger(m.fileCount) || m.fileCount < 1) throw refuse(DAMAGED);
  if (!Number.isSafeInteger(m.totalSize) || m.totalSize < 0) throw refuse(DAMAGED);
  return m;
}

function parseChecksums(buf) {
  const out = new Map();
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      throw refuse(DAMAGED);
    }
    if (typeof row?.path !== 'string' || !/^[0-9a-f]{64}$/.test(row?.sha256 ?? '') || out.has(row.path)) throw refuse(DAMAGED);
    out.set(row.path, row.sha256);
  }
  return out;
}

function memorySink(done) {
  const chunks = [];
  return {
    write: async (buf) => { chunks.push(Buffer.from(buf)); },
    end: async () => done(Buffer.concat(chunks)),
  };
}

const ITEM_ID = /^[A-Za-z0-9-]+$/;
const BARE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const BRANDING_FILE = /^\/media\/branding\/[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SLUG = /^[a-z0-9-]+$/;
const HEX = /^#[0-9a-f]{6}$/i;
const FONT_FAMILY = /^[A-Za-z0-9 -]{0,60}$/;
const FEED_INPUTS = ['rtmp', 'srt', 'device'];

const isItemId = (id) => typeof id === 'string' && ITEM_ID.test(id) && !RESERVED_MEDIA_FOLDERS.has(id);
const isBareFile = (value) => value === null || (typeof value === 'string' && BARE_FILE.test(value));

// Only what the server's own routes can save: a plain web address, or this item's live feed.
function isSafeItemUrl(url, id) {
  if (url === null) return true;
  if (typeof url !== 'string') return false;
  if (url === `/live/${id}/${PLAYLIST}`) return true;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function isSafeBranding(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const { logo, fontFile, fontFamily, fontMode, primaryColor, accentColor, textColor } = value;
  const isBrandingFile = (v) => v === undefined || v === null || v === '' || (typeof v === 'string' && BRANDING_FILE.test(v));
  const isColor = (v) => v === undefined || (typeof v === 'string' && HEX.test(v));
  return isBrandingFile(logo) && isBrandingFile(fontFile)
    && (fontFamily === undefined || (typeof fontFamily === 'string' && FONT_FAMILY.test(fontFamily)))
    && (fontMode === undefined || ['system', 'google', 'upload'].includes(fontMode))
    && [primaryColor, accentColor, textColor].every(isColor);
}

function isSafeFeed(feed) {
  if (!isItemId(feed.media_id) || !FEED_INPUTS.includes(feed.input)) return false;
  if (feed.port !== null && !(Number.isInteger(feed.port) && feed.port > 0 && feed.port < 65536)) return false;
  if (feed.encoder !== 'auto' && !Object.hasOwn(ENCODERS, feed.encoder)) return false;
  return Number.isInteger(feed.max_bitrate) && feed.max_bitrate > 0;
}

// Everything in a database that becomes a file path, a web address, or part of a command line. The
// files in the archive are checked by name, but these values are not, and a server would use them
// at its next start with nobody signed in.
function checkDatabaseValues(db) {
  const allSafe = db.all('SELECT id, file, thumb, url, style FROM media').every((m) => (
    isItemId(m.id) && isBareFile(m.file) && isBareFile(m.thumb) && isSafeItemUrl(m.url, m.id) && isSafeStyle(m.style)
  ))
    && db.all('SELECT * FROM live_feeds').every(isSafeFeed)
    && db.all('SELECT style FROM overrides').every((o) => isSafeStyle(o.style))
    && db.all('SELECT style FROM slide_templates').every((o) => isSafeStyle(o.style))
    && db.all('SELECT slug FROM channels').every((c) => typeof c.slug === 'string' && SLUG.test(c.slug));
  if (!allSafe) throw refuse(UNSAFE_DATA);
  const branding = db.get("SELECT value FROM settings WHERE key = 'branding'");
  if (branding) {
    let value;
    try {
      value = JSON.parse(branding.value);
    } catch {
      throw refuse(UNSAFE_DATA);
    }
    if (!isSafeBranding(value)) throw refuse(UNSAFE_DATA);
  }
}

function checkDatabase(file, manifest) {
  let raw;
  let version;
  try {
    raw = new DatabaseSync(file, { readOnly: true });
    const rows = raw.prepare('PRAGMA integrity_check').all();
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw refuse(DAMAGED);
    version = raw.prepare('PRAGMA user_version').get().user_version;
    // An empty file opens fine as a blank database, and this is what rules that out.
    if (!raw.prepare("SELECT 1 AS x FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()) throw refuse(DAMAGED);
    // This app has none, and one could write what the checks below refused, after they've run.
    if (raw.prepare("SELECT 1 AS x FROM sqlite_master WHERE type IN ('trigger', 'view')").get()) throw refuse(UNSAFE_DATA);
  } catch (err) {
    if (err.statusCode) throw err;
    throw refuse(DAMAGED);
  } finally {
    raw?.close();
  }
  if (version !== manifest.schemaVersion) throw refuse(DAMAGED);

  // Runs the upgrades here, so an older backup is proven before it's used.
  let db;
  try {
    db = openDb(file);
    const rows = db.all('PRAGMA integrity_check');
    if (rows.length !== 1 || rows[0].integrity_check !== 'ok') throw refuse(DAMAGED);
    checkDatabaseValues(db);
    db.run('DELETE FROM sessions'); // exports leave none, but a hand-made file might
    db.get('PRAGMA wal_checkpoint(TRUNCATE)');
  } catch (err) {
    if (err.statusCode) throw err;
    throw refuse('This backup could not be upgraded to work with this version, so nothing was changed.');
  } finally {
    db?.close();
  }
}

function checkConfig(file) {
  const stat = fs.statSync(file, { throwIfNoEntry: false });
  if (!stat) return;
  if (stat.size > SMALL_MAX) throw refuse(DAMAGED);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    throw refuse(DAMAGED);
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw refuse(DAMAGED);
}

export function removeStaging(dataDir, stagingName) {
  fs.rmSync(restorePath(dataDir, stagingName), { recursive: true, force: true });
  try {
    fs.rmdirSync(restorePath(dataDir));
  } catch {}
}

function translate(err, manifest) {
  if (err instanceof TarError) {
    if (!manifest) return refuse(NOT_A_BACKUP);
    return refuse(err.kind === 'truncated' ? INCOMPLETE : DAMAGED);
  }
  if (err.code === 'ENOSPC') return plainError(507, 'This computer ran out of free space while reading the backup, so nothing was changed.');
  // A path that collides with one already written, as a duplicate or as both a file and a folder.
  if (err.code === 'EEXIST' || err.code === 'ENOTDIR' || err.code === 'EISDIR') return refuse(DAMAGED);
  return err;
}

// Returns { id, stagingName, manifest } with the staged data proven, or throws a plain-language
// error having removed everything it wrote.
export async function stageBackup(source, { dataDir, statfs = fs.promises.statfs, id = randomUUID() }) {
  const stagingName = `${UPLOAD_PREFIX}${id}`;
  const staging = restorePath(dataDir, stagingName);
  const root = staging + path.sep;
  let manifest = null;
  let checksums = null;
  let count = 0;
  let bytes = 0;
  let openHandle = null;
  const hashes = new Map();
  const madeDirs = new Set();

  const fileSink = async (entry, target) => {
    const dir = path.dirname(target);
    if (!madeDirs.has(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
      madeDirs.add(dir);
    }
    // wx refuses to reuse a path, so a duplicate entry can't replace a checked file.
    const fh = await fs.promises.open(target, 'wx');
    openHandle = fh;
    const hash = createHash('sha256');
    return {
      async write(buf) {
        hash.update(buf);
        let at = 0;
        while (at < buf.length) {
          const { bytesWritten } = await fh.write(buf, at, buf.length - at);
          at += bytesWritten;
        }
      },
      async end() {
        await fh.close();
        openHandle = null;
        hashes.set(entry.name, hash.digest('hex'));
      },
    };
  };

  const onEntry = async (entry) => {
    if (!manifest) {
      if (entry.name !== MANIFEST_NAME || entry.type !== '0' || entry.size > SMALL_MAX) throw refuse(NOT_A_BACKUP);
      return memorySink(async (buf) => {
        const parsed = parseManifest(buf);
        await checkFreeSpace(dataDir, statfs, parsed.totalSize);
        manifest = parsed;
      });
    }
    if (checksums) throw refuse(DAMAGED); // nothing may follow the checksums
    if (entry.type !== '0') throw refuse('This backup contains something other than plain files, so it was refused and nothing was changed.');
    if (entry.name === CHECKSUMS_NAME) {
      if (entry.size > CHECKSUMS_MAX) throw refuse(DAMAGED);
      return memorySink(async (buf) => { checksums = parseChecksums(buf); });
    }
    if (!safeEntryPath(entry.name)) throw refuse(UNSAFE);
    count += 1;
    bytes += entry.size;
    if (count > manifest.fileCount || bytes > manifest.totalSize) throw refuse(DAMAGED);
    const target = path.resolve(staging, ...entry.name.split('/'));
    if (!target.startsWith(root)) throw refuse(UNSAFE);
    return fileSink(entry, target);
  };

  fs.mkdirSync(staging, { recursive: true });
  try {
    await readTar(source, onEntry);
    if (!manifest) throw refuse(NOT_A_BACKUP);
    if (!checksums) throw refuse(INCOMPLETE);
    if (count !== manifest.fileCount || bytes !== manifest.totalSize) throw refuse(DAMAGED);
    if (checksums.size !== hashes.size) throw refuse(DAMAGED);
    for (const [name, sum] of hashes) if (checksums.get(name) !== sum) throw refuse(DAMAGED);
    if (!hashes.has(DB_NAME)) throw refuse(DAMAGED);
    checkConfig(path.join(staging, CONFIG_NAME));
    checkDatabase(path.join(staging, DB_NAME), manifest);
    return { id, stagingName, manifest };
  } catch (err) {
    await openHandle?.close().catch(() => {});
    removeStaging(dataDir, stagingName);
    throw translate(err, manifest);
  }
}
