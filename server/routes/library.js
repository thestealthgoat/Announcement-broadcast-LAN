import path from 'node:path';
import { requireUser, requirePermission, httpError, canAddToChannel } from '../auth.js';
import { deleteBlock, editBlock, folderSize, isLiveFeed, mediaUsage, removeMedia } from '../library.js';
import { addToChannel } from './channels.js';
import { mediaJson } from './media.js';
import { text } from './auth.js';

const TYPES = ['image', 'video', 'pdf', 'web', 'text', 'hls'];
const STATUSES = ['processing', 'ready', 'failed'];
const SORTS = {
  newest: 'm.created_at DESC, m.rowid DESC',
  name: 'm.name COLLATE NOCASE ASC, m.rowid ASC',
  size: 'COALESCE(m.size, 0) DESC, m.rowid DESC',
};
const PAGE_SIZE = 60;
const MAX_PAGE_SIZE = 500;
const MAX_BULK = 5000;

// The wording for each reason an item was skipped, for one item and for several.
const REASONS = {
  gone: ['it no longer exists', 'they no longer exist'],
  scope: ["it's used on a channel you don't manage", "they're used on channels you don't manage"],
  own: ["you didn't upload it", "you didn't upload them"],
  rights: ["you don't have permission to change it", "you don't have permission to change them"],
  feed: ["it's a live feed and you don't manage live feeds", "they're live feeds and you don't manage live feeds"],
  failed: ['it failed to process', 'they failed to process'],
  onChannel: ["it's already on that channel", "they're already on that channel"],
  inUse: ["it's now in use", "they're now in use"],
  error: ['something went wrong on the server', 'something went wrong on the server'],
};

function bulkIds(body) {
  const list = body?.ids;
  if (!Array.isArray(list) || !list.length) throw httpError(400, 'Select at least one item.');
  if (list.length > MAX_BULK) throw httpError(400, `You can change up to ${MAX_BULK} items at a time.`);
  return [...new Set(list.map(String))];
}

// "4 moved, 1 skipped because it's used on a channel you don't manage"
function outcome(verb, results, extra = {}) {
  const done = results.filter((r) => r.ok).length;
  const counts = new Map();
  for (const r of results) if (!r.ok) counts.set(r.reason, (counts.get(r.reason) ?? 0) + 1);
  const parts = [`${done} ${verb}`];
  for (const [reason, n] of counts) parts.push(`${n} skipped because ${REASONS[reason][n === 1 ? 0 : 1]}`);
  for (const r of results) if (!r.ok) r.message = REASONS[r.reason][0];
  return { done, skipped: results.length - done, summary: parts.join(', '), results, ...extra };
}

const escapeLike = (s) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export default async function libraryRoutes(app, { db, hub, live, mediaDir }) {
  const requireOrganize = requirePermission('library.edit');
  const requireLibrary = requirePermission('library.edit', 'library.own');
  const ctx = { db, live, mediaDir };
  const mediaRow = (id) => db.get('SELECT * FROM media WHERE id = ?', id);

  // Tags for many items at once, so a page of results costs two queries rather than one per item.
  const tagsOf = (mediaIds) => {
    const out = new Map();
    for (const r of db.all(
      `SELECT mt.media_id, t.id, t.name FROM media_tags mt JOIN tags t ON t.id = mt.tag_id
       WHERE mt.media_id IN (SELECT value FROM json_each(?)) ORDER BY t.name COLLATE NOCASE`,
      JSON.stringify(mediaIds),
    )) {
      if (!out.has(r.media_id)) out.set(r.media_id, []);
      out.get(r.media_id).push({ id: r.id, name: r.name });
    }
    return out;
  };

  const itemsJson = (user, rows) => {
    const mediaIds = rows.map((m) => m.id);
    const usage = mediaUsage(db, mediaIds);
    const tags = tagsOf(mediaIds);
    return rows.map((m) => ({
      ...mediaJson(m),
      liveStatus: live.statusOf(m.id),
      tags: tags.get(m.id) ?? [],
      usage: usage.get(m.id),
      canEdit: !editBlock(db, user, m.id),
      canDelete: !deleteBlock(db, live, user, m),
    }));
  };

  function filters(q) {
    const where = [];
    const args = [];
    const search = String(q.q ?? '').trim();
    if (search) {
      where.push("m.name LIKE ? ESCAPE '\\'");
      args.push(`%${escapeLike(search)}%`);
    }
    if (q.type) {
      if (!TYPES.includes(q.type)) throw httpError(400, 'Unknown type.');
      where.push('m.type = ?');
      args.push(q.type);
    }
    if (q.status) {
      if (!STATUSES.includes(q.status)) throw httpError(400, 'Unknown status.');
      where.push('m.status = ?');
      args.push(q.status);
    }
    if (q.folder === 'none') where.push('m.folder_id IS NULL');
    else if (q.folder) {
      where.push('m.folder_id = ?');
      args.push(Number(q.folder));
    }
    if (q.tag) {
      where.push('EXISTS (SELECT 1 FROM media_tags mt WHERE mt.media_id = m.id AND mt.tag_id = ?)');
      args.push(Number(q.tag));
    }
    return { clause: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
  }

  // Filters and pages in the database, so a large library stays quick on a phone. GET /api/media
  // stays as it was for the channel and override pickers.
  app.get('/api/library', { preHandler: requireUser }, async (req) => {
    const q = req.query;
    if (q.sort && !SORTS[q.sort]) throw httpError(400, 'Unknown sort.');
    const { clause, args } = filters(q);
    const { n: total } = db.get(`SELECT COUNT(*) AS n FROM media m ${clause}`, ...args);
    const order = SORTS[q.sort ?? 'newest'];
    if (q.idsOnly) {
      const rows = db.all(`SELECT m.id FROM media m ${clause} ORDER BY ${order} LIMIT ?`, ...args, MAX_BULK);
      return { ids: rows.map((r) => r.id), total };
    }
    const limit = Math.min(Math.max(Number(q.limit) || PAGE_SIZE, 1), MAX_PAGE_SIZE);
    const offset = Math.max(Number(q.offset) || 0, 0);
    const rows = db.all(`SELECT m.* FROM media m ${clause} ORDER BY ${order} LIMIT ? OFFSET ?`, ...args, limit, offset);
    return { items: itemsJson(req.user, rows), total, limit, offset };
  });

  // Items nothing is using, oldest first, limited to what this person could delete. Live feeds are
  // never offered, and neither is anything still processing.
  app.get('/api/library/cleanup', { preHandler: requireLibrary }, async (req) => {
    const rows = db.all("SELECT * FROM media WHERE status != 'processing' ORDER BY created_at, rowid")
      .filter((m) => !isLiveFeed(live, m));
    const usage = mediaUsage(db, rows.map((m) => m.id));
    const items = [];
    let totalBytes = 0;
    for (const m of rows) {
      if (usage.get(m.id).inUse || deleteBlock(db, live, req.user, m)) continue;
      const bytes = await folderSize(path.join(mediaDir, m.id));
      totalBytes += bytes;
      items.push({ ...mediaJson(m), bytes });
    }
    return { items, count: items.length, totalBytes };
  });

  app.get('/api/library/:id', { preHandler: requireUser }, async (req) => {
    const m = mediaRow(String(req.params.id));
    if (!m) throw httpError(404, 'Library item not found.');
    return itemsJson(req.user, [m])[0];
  });

  // Runs `apply` on each item this person may change, and reports what happened to every one.
  function forEachEditable(req, list, apply) {
    return db.tx(() => list.map((id) => {
      const m = mediaRow(id);
      if (!m) return { id, name: null, ok: false, reason: 'gone' };
      const block = editBlock(db, req.user, id);
      if (block) return { id, name: m.name, ok: false, reason: block };
      apply(id);
      return { id, name: m.name, ok: true };
    }));
  }

  app.post('/api/library/bulk/move', { preHandler: requireLibrary }, async (req) => {
    const list = bulkIds(req.body);
    const raw = req.body.folderId;
    const folderId = raw === null || raw === undefined || raw === '' ? null : Number(raw);
    if (folderId !== null && !db.get('SELECT 1 AS x FROM folders WHERE id = ?', folderId)) throw httpError(404, 'Folder not found.');
    const results = forEachEditable(req, list, (id) => db.run('UPDATE media SET folder_id = ? WHERE id = ?', folderId, id));
    hub.adminRefresh('media');
    return outcome('moved', results);
  });

  app.post('/api/library/bulk/tag', { preHandler: requireLibrary }, async (req) => {
    const list = bulkIds(req.body);
    const tagList = (v) => (Array.isArray(v) ? v.map(Number) : []);
    const add = tagList(req.body.add);
    const remove = tagList(req.body.remove);
    if (!add.length && !remove.length) throw httpError(400, 'Choose a tag.');
    for (const t of [...add, ...remove]) {
      if (!db.get('SELECT 1 AS x FROM tags WHERE id = ?', t)) throw httpError(404, 'Tag not found.');
    }
    const results = forEachEditable(req, list, (id) => {
      for (const t of add) db.run('INSERT OR IGNORE INTO media_tags (media_id, tag_id) VALUES (?, ?)', id, t);
      for (const t of remove) db.run('DELETE FROM media_tags WHERE media_id = ? AND tag_id = ?', id, t);
    });
    hub.adminRefresh('media');
    return outcome('tagged', results);
  });

  // Needs the same check as adding one item: the channel, not the item, is what's being changed.
  app.post('/api/library/bulk/add-to-channel', { preHandler: requirePermission('channels.add') }, async (req) => {
    const list = bulkIds(req.body);
    const channel = db.get('SELECT id, name FROM channels WHERE id = ?', Number(req.body.channelId));
    if (!channel) throw httpError(404, 'Channel not found.');
    if (!canAddToChannel(req.user, channel.id)) throw httpError(403, 'You cannot add items to this channel.');
    const results = db.tx(() => list.map((id) => {
      const m = mediaRow(id);
      if (!m) return { id, name: null, ok: false, reason: 'gone' };
      if (m.status === 'failed') return { id, name: m.name, ok: false, reason: 'failed' };
      if (db.get('SELECT 1 AS x FROM playlist_items WHERE channel_id = ? AND media_id = ?', channel.id, id)) {
        return { id, name: m.name, ok: false, reason: 'onChannel' };
      }
      addToChannel(db, channel.id, id);
      return { id, name: m.name, ok: true };
    }));
    if (results.some((r) => r.ok)) hub.pushChannel(channel.id);
    hub.adminRefresh('channels');
    hub.adminRefresh('media');
    return outcome(`added to ${channel.name}`, results);
  });

  // With dryRun, says what would happen and what's in use, so the warning can name the channels.
  // An item in use is only deleted if it's listed in inUseConfirmed, so one that came into use
  // after the warning (or after the cleanup list loaded) is kept.
  app.post('/api/library/bulk/delete', { preHandler: requirePermission('library.edit', 'library.own', 'live.manage') }, async (req) => {
    const list = bulkIds(req.body);
    const confirmed = new Set((Array.isArray(req.body.inUseConfirmed) ? req.body.inUseConfirmed : []).map(String));
    const dryRun = !!req.body.dryRun;
    const results = [];
    const channels = new Set();
    let wasOverride = false;
    let totalBytes = 0;
    for (const id of list) {
      const m = mediaRow(id);
      if (!m) {
        results.push({ id, name: null, ok: false, reason: 'gone' });
        continue;
      }
      const block = deleteBlock(db, live, req.user, m);
      if (block) {
        results.push({ id, name: m.name, ok: false, reason: block });
        continue;
      }
      const usage = mediaUsage(db, [id]).get(id);
      if (!dryRun && usage.inUse && !confirmed.has(id)) {
        results.push({ id, name: m.name, ok: false, reason: 'inUse', usage });
        continue;
      }
      const bytes = await folderSize(path.join(mediaDir, id));
      if (dryRun) {
        totalBytes += bytes;
        results.push({ id, name: m.name, ok: true, usage, bytes });
        continue;
      }
      try {
        const gone = await removeMedia(ctx, m);
        gone.channels.forEach((c) => channels.add(c));
        wasOverride ||= gone.wasOverride;
        totalBytes += bytes;
        results.push({ id, name: m.name, ok: true, bytes });
      } catch (err) {
        req.log.error({ err, id }, 'could not delete a library item');
        results.push({ id, name: m.name, ok: false, reason: 'error' });
      }
    }
    if (dryRun) return outcome('can be deleted', results, { dryRun: true, totalBytes });
    if (wasOverride) hub.pushAll();
    else for (const c of channels) hub.pushChannel(c);
    for (const scope of ['media', 'channels', 'overrides', 'live']) hub.adminRefresh(scope);
    return outcome('deleted', results, { totalBytes });
  });

  // Folders and tags share their rules, so they share these routes.
  function nameRoutes({ route, table, label, countSql }) {
    const row = (id) => {
      const r = db.get(`SELECT * FROM ${table} WHERE id = ?`, Number(id));
      if (!r) throw httpError(404, `${label} not found.`);
      return r;
    };
    const assertFree = (name, exceptId = -1) => {
      if (db.get(`SELECT 1 AS x FROM ${table} WHERE name = ? AND id != ?`, name, exceptId)) {
        throw httpError(409, `There is already a ${label.toLowerCase()} called ${name}.`);
      }
    };

    app.get(route, { preHandler: requireUser }, async () =>
      db.all(`SELECT t.id, t.name, (${countSql}) AS count FROM ${table} t ORDER BY t.name COLLATE NOCASE`).map((r) => ({ ...r })),
    );
    app.post(route, { preHandler: requireOrganize }, async (req) => {
      const name = text(req.body?.name, `${label} name`, { max: 80 });
      assertFree(name);
      const { lastInsertRowid } = db.run(`INSERT INTO ${table} (name, created_at) VALUES (?, ?)`, name, Date.now());
      hub.adminRefresh('media');
      return { id: Number(lastInsertRowid), name, count: 0 };
    });
    app.patch(`${route}/:id`, { preHandler: requireOrganize }, async (req) => {
      const r = row(req.params.id);
      const name = text(req.body?.name, `${label} name`, { max: 80 });
      assertFree(name, r.id);
      db.run(`UPDATE ${table} SET name = ? WHERE id = ?`, name, r.id);
      hub.adminRefresh('media');
      return { id: r.id, name };
    });
    // Foreign keys only clear the link: items in a deleted folder return to the top level.
    app.delete(`${route}/:id`, { preHandler: requireOrganize }, async (req) => {
      const r = row(req.params.id);
      const { n } = db.get(`SELECT (${countSql}) AS n FROM ${table} t WHERE t.id = ?`, r.id);
      db.run(`DELETE FROM ${table} WHERE id = ?`, r.id);
      hub.adminRefresh('media');
      return { ok: true, items: n };
    });
  }

  nameRoutes({ route: '/api/folders', table: 'folders', label: 'Folder', countSql: 'SELECT COUNT(*) FROM media m WHERE m.folder_id = t.id' });
  nameRoutes({ route: '/api/tags', table: 'tags', label: 'Tag', countSql: 'SELECT COUNT(*) FROM media_tags mt WHERE mt.tag_id = t.id' });
}
