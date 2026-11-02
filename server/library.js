import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canEditMedia, mediaInScope } from './auth.js';
import { hasPermission } from './permissions.js';
import { UnsafePathError, childPath, mediaFolder } from './safe-path.js';

const ids = (mediaIds) => JSON.stringify(mediaIds);
const RM_WITH_RETRIES = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 };
const ITEM_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Removes folders left by a delete that couldn't finish, or an upload a crash cut short. It only
// touches names this app gives its own items, so `branding` and anything someone else put there are
// safe. Run it before the server accepts uploads, as an upload's folder comes before its row. With
// no library at all it does nothing: that database could be the wrong one, or a new one someone is
// about to restore over, and the folders could be all that's left of a library.
export async function sweepOrphanFolders({ db, mediaDir, log }) {
  try {
    if (!db.get('SELECT 1 AS x FROM media LIMIT 1')) return;
    const known = new Set(db.all('SELECT id FROM media').map((m) => m.id));
    const folders = fs.readdirSync(mediaDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && ITEM_FOLDER.test(e.name) && !known.has(e.name));
    for (const { name } of folders) {
      try {
        await fs.promises.rm(path.join(mediaDir, name), RM_WITH_RETRIES);
      } catch (err) {
        log?.warn?.({ err, folder: name }, 'Could not remove a leftover library folder. Will try again at the next start.');
      }
    }
  } catch (err) {
    log?.warn?.({ err }, 'Could not check the library for leftover folders');
  }
}

// What is using each library item right now. This is the one place that decides whether an item is
// in use: the library, delete warnings, and the cleanup view all read `inUse` from here. Anything new
// that refers to a library item, like a background image in the announcement designer, adds its
// references here and to `inUse`, and every one of those screens follows.
export function mediaUsage(db, mediaIds, now = Date.now()) {
  const usage = new Map(mediaIds.map((id) => [id, { channels: [], overrides: [], backgrounds: [], inUse: false }]));
  if (!mediaIds.length) return usage;
  const list = ids(mediaIds);

  for (const r of db.all(
    `SELECT DISTINCT p.media_id, c.id, c.name FROM playlist_items p JOIN channels c ON c.id = p.channel_id
     WHERE p.media_id IN (SELECT value FROM json_each(?)) ORDER BY c.name COLLATE NOCASE`,
    list,
  )) usage.get(r.media_id).channels.push({ id: r.id, name: r.name });

  for (const o of db.all(
    `SELECT id, media_id, all_channels FROM overrides
     WHERE media_id IN (SELECT value FROM json_each(?)) AND cleared_at IS NULL AND (ends_at IS NULL OR ends_at > ?)`,
    list, now,
  )) {
    const channels = db.all(
      `SELECT c.id, c.name FROM override_channels oc JOIN channels c ON c.id = oc.channel_id
       WHERE oc.override_id = ? ORDER BY c.name COLLATE NOCASE`,
      o.id,
    );
    usage.get(o.media_id).overrides.push({ id: o.id, allChannels: !!o.all_channels, channels });
  }

  // Pictures chosen as a background in the announcement designer.
  for (const r of db.all(
    `SELECT id, name, json_extract(style, '$.image') AS image FROM media
     WHERE json_valid(style) AND json_extract(style, '$.image') IN (SELECT value FROM json_each(?))
     ORDER BY name COLLATE NOCASE`,
    list,
  )) usage.get(r.image)?.backgrounds.push(r.name);
  for (const r of db.all(
    `SELECT name, json_extract(style, '$.image') AS image FROM slide_templates
     WHERE json_valid(style) AND json_extract(style, '$.image') IN (SELECT value FROM json_each(?))`,
    list,
  )) usage.get(r.image)?.backgrounds.push(`Template: ${r.name}`);
  for (const r of db.all(
    `SELECT title, json_extract(style, '$.image') AS image FROM overrides
     WHERE cleared_at IS NULL AND (ends_at IS NULL OR ends_at > ?) AND json_valid(style)
       AND json_extract(style, '$.image') IN (SELECT value FROM json_each(?))`,
    now, list,
  )) usage.get(r.image)?.backgrounds.push(`Active override: ${r.title ?? 'Announcement'}`);

  for (const u of usage.values()) u.inUse = u.channels.length > 0 || u.overrides.length > 0 || u.backgrounds.length > 0;
  return usage;
}

export const isMediaUsed = (db, mediaId) => mediaUsage(db, [mediaId]).get(mediaId).inUse;

export const isLiveFeed = (live, m) => live.isFeed(m.id) || (typeof m.url === 'string' && m.url.startsWith('/live/'));

// Why this person can't change an item: 'scope', 'own', 'rights', or null when they can.
export function editBlock(db, user, mediaId) {
  if (canEditMedia(db, user, mediaId)) return null;
  if (!mediaInScope(db, user, mediaId)) return 'scope';
  return hasPermission(user, 'library.own') ? 'own' : 'rights';
}

// Why this person can't delete an item: 'feed', or any answer from editBlock.
// A live feed belongs to whoever manages live feeds, so library permissions alone can't delete one.
export function deleteBlock(db, live, user, m) {
  if (!live.isFeed(m.id)) return editBlock(db, user, m.id);
  if (!hasPermission(user, 'live.manage')) return 'feed';
  return mediaInScope(db, user, m.id) ? null : 'scope';
}

// Deletes one item and its files. The caller tells the TVs and admin screens afterwards.
// The item is gone once its row is. A folder that can't be removed, as Windows does when something
// has a file open, is only a warning, and the next start's sweep takes care of it.
export async function removeMedia({ db, live, mediaDir, log }, m) {
  const channels = db.all('SELECT DISTINCT channel_id FROM playlist_items WHERE media_id = ?', m.id).map((c) => c.channel_id);
  // Any text slide or override might use a deleted picture as its background, so images update every channel.
  const wasOverride = m.type === 'image' || !!db.get('SELECT 1 AS x FROM overrides WHERE media_id = ? AND cleared_at IS NULL', m.id);
  await live.remove(m.id);
  db.run('DELETE FROM media WHERE id = ?', m.id);
  try {
    await fs.promises.rm(mediaFolder(mediaDir, m.id), RM_WITH_RETRIES);
  } catch (err) {
    log?.warn?.({ err, id: m.id }, 'Could not remove a deleted item\'s folder. Will try again at the next start.');
  }
  return { channels, wasOverride };
}

// Another item holding the same file. An item that failed to process doesn't count, so a retry doesn't warn.
export function findDuplicate(db, sha256, exceptId) {
  const row = db.get(
    `SELECT id, name FROM media WHERE sha256 = ? AND id != ? AND status != 'failed'
     ORDER BY created_at, rowid LIMIT 1`,
    sha256, exceptId,
  );
  return row ? { id: row.id, name: row.name } : null;
}

// The space deleting an item would free, which includes its thumbnail.
export async function itemSize(mediaDir, id) {
  try {
    return await folderSize(mediaFolder(mediaDir, id));
  } catch (err) {
    if (err instanceof UnsafePathError) return 0;
    throw err;
  }
}

export async function folderSize(dir) {
  let total = 0;
  let names;
  try {
    names = await fs.promises.readdir(dir);
  } catch {
    return 0;
  }
  for (const name of names) {
    try {
      total += (await fs.promises.stat(path.join(dir, name))).size;
    } catch {}
  }
  return total;
}

// Hashes library items from before duplicate checking, one file at a time and slowly, so TVs keep
// being served. It waits whenever a video is converting. A converted video's source is gone, so an
// older video's hash is of the converted file.
export function createHashBackfill({ db, mediaDir, isBusy = () => false, log, startDelayMs = 60000, chunkPauseMs = 4, filePauseMs = 50, busyPollMs = 1000 }) {
  let stopped = false;
  let timer = null;
  let wake = null;
  let stream = null;
  let running = null;

  const sleep = (ms) => new Promise((resolve) => {
    wake = resolve;
    timer = setTimeout(resolve, ms);
    timer.unref?.();
  });

  async function hashFile(file) {
    const hash = createHash('sha256');
    stream = fs.createReadStream(file, { highWaterMark: 256 * 1024 });
    try {
      for await (const chunk of stream) {
        hash.update(chunk);
        if (stopped) return null;
        await sleep(chunkPauseMs);
        while (isBusy() && !stopped) await sleep(busyPollMs);
      }
    } finally {
      stream.destroy();
      stream = null;
    }
    return stopped ? null : hash.digest('hex');
  }

  async function pass() {
    let hashed = 0;
    const rows = db.all(
      `SELECT id, file FROM media
       WHERE sha256 IS NULL AND status = 'ready' AND file IS NOT NULL AND type IN ('image', 'video')
       ORDER BY created_at DESC, rowid DESC`,
    );
    for (const m of rows) {
      while (isBusy() && !stopped) await sleep(busyPollMs);
      if (stopped) break;
      try {
        const sha256 = await hashFile(childPath(mediaFolder(mediaDir, m.id), m.file));
        if (!sha256) break;
        // The item may have been deleted while this ran.
        db.run('UPDATE media SET sha256 = ? WHERE id = ? AND sha256 IS NULL AND file = ?', sha256, m.id, m.file);
        hashed += 1;
      } catch (err) {
        // Stays empty, so the next start tries it again.
        if (err.code !== 'ENOENT') log?.warn?.({ err, id: m.id }, 'could not hash a library item');
      }
      await sleep(filePauseMs);
    }
    return hashed;
  }

  return {
    // One full pass. Resolves with how many items were hashed.
    run() {
      running ??= pass().finally(() => { running = null; });
      return running;
    },
    // Not awaited by anything: a slow disk must never hold up serving.
    start() {
      timer = setTimeout(() => {
        this.run().catch((err) => log?.error?.(err));
      }, startDelayMs);
      timer.unref?.();
    },
    async stop() {
      stopped = true;
      clearTimeout(timer);
      wake?.();
      stream?.destroy();
      await running?.catch(() => {});
    },
  };
}
