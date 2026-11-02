import { requireUser, requirePermission, httpError, canAccessChannel, canAddToChannel, canEditChannel, canManageChannel } from '../auth.js';
import { hasPermission } from '../permissions.js';
import { text } from './auth.js';
import { problem, status, wallClock } from '../schedule.js';

const TRANSITIONS = ['cut', 'fade', 'slide'];

export function slugify(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'channel';
}

const scheduleJson = (r) => ({ startDate: r.start_date, endDate: r.end_date, startTime: r.start_time, endTime: r.end_time, days: r.days });

const itemJson = (r, clock) => ({
  id: r.pid,
  channelId: r.channel_id,
  mediaId: r.media_id,
  position: r.position,
  duration: r.p_duration,
  transition: r.transition,
  audio: !!r.audio,
  enabled: !!r.enabled,
  ...scheduleJson(r),
  scheduleStatus: status(scheduleJson(r), clock),
  media: {
    id: r.media_id, type: r.type, name: r.name, status: r.status, error: r.error, progress: r.progress,
    thumb: r.thumb ? `/media/${r.media_id}/${r.thumb}` : null, duration: r.m_duration, pages: r.pages,
  },
});

export default async function channelRoutes(app, { db, hub }) {
  const requireEdit = requirePermission('channels.edit');
  const requireManage = requirePermission('channels.manage');
  const getChannel = (id) => {
    const c = db.get('SELECT * FROM channels WHERE id = ?', Number(id));
    if (!c) throw httpError(404, 'Channel not found.');
    return c;
  };
  const assertAccess = (req, channelId) => {
    if (!canAccessChannel(req.user, channelId)) throw httpError(403, 'You are not assigned to this channel.');
  };
  const items = (channelId) => {
    const clock = wallClock();
    return db.all(
      `SELECT p.id AS pid, p.channel_id, p.media_id, p.position, p.duration AS p_duration, p.transition, p.audio, p.enabled,
              p.start_date, p.end_date, p.start_time, p.end_time, p.days,
              m.type, m.name, m.status, m.error, m.progress, m.thumb, m.duration AS m_duration, m.pages
       FROM playlist_items p JOIN media m ON m.id = p.media_id
       WHERE p.channel_id = ? ORDER BY p.position, p.id`,
      channelId,
    ).map((r) => itemJson(r, clock));
  };
  const changed = (channelId) => {
    hub.pushChannel(channelId);
    hub.adminRefresh('channels');
  };

  app.get('/api/channels', { preHandler: requireUser }, async (req) =>
    db.all(
      `SELECT c.*, (SELECT COUNT(*) FROM playlist_items p WHERE p.channel_id = c.id) AS item_count,
              (SELECT COUNT(*) FROM screens s WHERE s.channel_id = c.id) AS screen_count
       FROM channels c ORDER BY c.name COLLATE NOCASE`,
    ).map((c) => ({
      id: c.id, slug: c.slug, name: c.name, itemCount: c.item_count, screenCount: c.screen_count,
      canAccess: canAccessChannel(req.user, c.id),
      canAdd: canAddToChannel(req.user, c.id),
      canEdit: canEditChannel(req.user, c.id),
      canManage: canManageChannel(req.user, c.id),
    })),
  );

  app.post('/api/channels', { preHandler: requireManage }, async (req) => {
    const name = text(req.body?.name, 'Channel name', { max: 80 });
    const root = slugify(name);
    let slug = root;
    for (let n = 2; db.get('SELECT 1 AS x FROM channels WHERE slug = ?', slug); n++) slug = `${root}-${n}`;
    const { lastInsertRowid } = db.run('INSERT INTO channels (slug, name, created_at) VALUES (?, ?, ?)', slug, name, Date.now());
    // Someone limited to assigned channels would otherwise lock themselves out of the one they just made.
    if (!hasPermission(req.user, 'channels.all')) {
      db.run('INSERT INTO user_channels (user_id, channel_id) VALUES (?, ?)', req.user.id, lastInsertRowid);
    }
    hub.adminRefresh('channels');
    return { id: Number(lastInsertRowid), slug, name };
  });

  // The slug is permanent so TV URLs keep working after a rename.
  app.patch('/api/channels/:id', { preHandler: requireManage }, async (req) => {
    const c = getChannel(req.params.id);
    assertAccess(req, c.id);
    const name = text(req.body?.name, 'Channel name', { max: 80 });
    db.run('UPDATE channels SET name = ? WHERE id = ?', name, c.id);
    changed(c.id);
    return { id: c.id, slug: c.slug, name };
  });

  app.delete('/api/channels/:id', { preHandler: requireManage }, async (req) => {
    const c = getChannel(req.params.id);
    assertAccess(req, c.id);
    const screens = db.all('SELECT id FROM screens WHERE channel_id = ?', c.id);
    const cleared = db.tx(() => {
      db.run('DELETE FROM channels WHERE id = ?', c.id);
      // The deleted channel's rows cascade away, which can leave an override aimed at nothing.
      return db.run(
        `UPDATE overrides SET cleared_at = ? WHERE cleared_at IS NULL AND all_channels = 0
         AND NOT EXISTS (SELECT 1 FROM override_channels oc WHERE oc.override_id = overrides.id)`,
        Date.now(),
      ).changes;
    });
    for (const s of screens) hub.assignScreen(s.id);
    hub.adminRefresh('channels');
    hub.adminRefresh('screens');
    if (cleared) hub.adminRefresh('overrides');
    return { ok: true };
  });

  app.get('/api/channels/:id/items', { preHandler: requireUser }, async (req) => {
    const c = getChannel(req.params.id);
    assertAccess(req, c.id);
    return items(c.id);
  });

  app.post('/api/channels/:id/items', { preHandler: requirePermission('channels.add') }, async (req) => {
    const c = getChannel(req.params.id);
    assertAccess(req, c.id);
    const media = db.get('SELECT id FROM media WHERE id = ?', String(req.body?.mediaId ?? ''));
    if (!media) throw httpError(404, 'Library item not found.');
    addToChannel(db, c.id, media.id);
    changed(c.id);
    return items(c.id);
  });

  app.put('/api/channels/:id/order', { preHandler: requireEdit }, async (req) => {
    const c = getChannel(req.params.id);
    assertAccess(req, c.id);
    const ids = req.body?.ids;
    const existing = db.all('SELECT id FROM playlist_items WHERE channel_id = ?', c.id).map((r) => r.id);
    if (
      !Array.isArray(ids) || ids.length !== existing.length ||
      new Set(ids).size !== ids.length || !ids.every((id) => existing.includes(id))
    ) {
      throw httpError(400, 'That order does not match the playlist. Reload and try again.');
    }
    db.tx(() => ids.forEach((id, i) => db.run('UPDATE playlist_items SET position = ? WHERE id = ?', i, id)));
    changed(c.id);
    return items(c.id);
  });

  const getItem = (req) => {
    const item = db.get('SELECT * FROM playlist_items WHERE id = ?', Number(req.params.id));
    if (!item) throw httpError(404, 'Playlist item not found.');
    assertAccess(req, item.channel_id);
    return item;
  };

  app.patch('/api/playlist-items/:id', { preHandler: requireEdit }, async (req) => {
    const item = getItem(req);
    const b = req.body ?? {};
    let duration = item.duration;
    if (b.duration !== undefined) {
      if (b.duration === null || b.duration === '') duration = null;
      else {
        duration = Number(b.duration);
        if (!Number.isFinite(duration) || duration < 1 || duration > 86400) throw httpError(400, 'Duration must be 1 second or more.');
      }
    }
    const transition = b.transition ?? item.transition;
    if (!TRANSITIONS.includes(transition)) throw httpError(400, 'Unknown transition.');
    // Fields left out keep their value. A cleared form field sends '', which means no value.
    const merged = (key, current) => (b[key] === undefined ? current : b[key] === '' ? null : b[key]);
    const schedule = {
      startDate: merged('startDate', item.start_date),
      endDate: merged('endDate', item.end_date),
      startTime: merged('startTime', item.start_time),
      endTime: merged('endTime', item.end_time),
      days: merged('days', item.days),
    };
    const why = problem(schedule);
    if (why) throw httpError(400, why);
    db.run(
      `UPDATE playlist_items SET duration = ?, transition = ?, audio = ?, enabled = ?,
         start_date = ?, end_date = ?, start_time = ?, end_time = ?, days = ? WHERE id = ?`,
      duration, transition,
      b.audio === undefined ? item.audio : b.audio ? 1 : 0,
      b.enabled === undefined ? item.enabled : b.enabled ? 1 : 0,
      schedule.startDate, schedule.endDate, schedule.startTime, schedule.endTime, schedule.days,
      item.id,
    );
    changed(item.channel_id);
    return items(item.channel_id).find((i) => i.id === item.id);
  });

  app.delete('/api/playlist-items/:id', { preHandler: requireEdit }, async (req) => {
    const item = getItem(req);
    db.run('DELETE FROM playlist_items WHERE id = ?', item.id);
    changed(item.channel_id);
    return { ok: true };
  });
}

export function addToChannel(db, channelId, mediaId) {
  const { p } = db.get('SELECT COALESCE(MAX(position), -1) + 1 AS p FROM playlist_items WHERE channel_id = ?', channelId);
  db.run('INSERT INTO playlist_items (channel_id, media_id, position) VALUES (?, ?, ?)', channelId, mediaId, p);
}
