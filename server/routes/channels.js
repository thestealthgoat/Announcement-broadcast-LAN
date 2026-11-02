import { requireUser, requirePermission, httpError, canAccessChannel, canAddToChannel, canEditChannel, canManageChannel } from '../auth.js';
import { hasPermission } from '../permissions.js';
import { text } from './auth.js';
import { problem, status, wallClock } from '../schedule.js';
import { SPEEDS, isValid, resolve, speedName } from '../transitions.js';

// The original column only allows these three. It stays as the fallback for items with no newer setting.
const LEGACY_TRANSITIONS = ['cut', 'fade', 'slide'];

// A transition from the API. Undefined keeps what is saved. Null or a cleared field removes the setting.
function transitionStyle(value, current) {
  if (value === undefined) return current;
  if (value === null || value === '') return null;
  if (value === 'push' || value === 'wipe') throw httpError(400, 'Choose a direction for that transition.');
  if (!isValid(value)) throw httpError(400, 'Choose a transition from the list.');
  return value;
}

// A speed from the API, stored as milliseconds. Same rules as above.
function transitionMs(value, current) {
  if (value === undefined) return current;
  if (value === null || value === '') return null;
  if (typeof value !== 'string' || !Object.hasOwn(SPEEDS, value)) throw httpError(400, 'Choose a speed: fast, normal, or slow.');
  return SPEEDS[value];
}

export function slugify(name) {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'channel';
}

const scheduleJson = (r) => ({ startDate: r.start_date, endDate: r.end_date, startTime: r.start_time, endTime: r.end_time, days: r.days });

const channelDefault = (c) => ({ style: c.default_transition_style, ms: c.default_transition_ms });

const itemJson = (r, clock, channel) => ({
  id: r.pid,
  channelId: r.channel_id,
  mediaId: r.media_id,
  position: r.position,
  duration: r.p_duration,
  transition: r.transition,
  transitionStyle: r.transition_style,
  transitionSpeed: speedName(r.transition_ms),
  // What plays, and what would play if this item had no settings of its own.
  effectiveTransition: resolve({ style: r.transition_style, ms: r.transition_ms }, channelDefault(channel), r.transition),
  inheritedTransition: resolve(null, channelDefault(channel), r.transition),
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
    const channel = db.get('SELECT * FROM channels WHERE id = ?', channelId);
    return db.all(
      `SELECT p.id AS pid, p.channel_id, p.media_id, p.position, p.duration AS p_duration, p.transition, p.transition_style, p.transition_ms, p.audio, p.enabled,
              p.start_date, p.end_date, p.start_time, p.end_time, p.days,
              m.type, m.name, m.status, m.error, m.progress, m.thumb, m.duration AS m_duration, m.pages
       FROM playlist_items p JOIN media m ON m.id = p.media_id
       WHERE p.channel_id = ? ORDER BY p.position, p.id`,
      channelId,
    ).map((r) => itemJson(r, clock, channel));
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
      defaultTransitionStyle: c.default_transition_style,
      defaultTransitionSpeed: speedName(c.default_transition_ms),
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

  // The slug is permanent so TV URLs keep working after a rename. Renaming is part of managing
  // channels. The default transition belongs with item transitions, so it needs channels.edit.
  app.patch('/api/channels/:id', { preHandler: requireUser }, async (req) => {
    const b = req.body ?? {};
    const changesDefault = b.defaultTransitionStyle !== undefined || b.defaultTransitionSpeed !== undefined;
    const renames = b.name !== undefined || !changesDefault;
    const needed = [...(renames ? ['channels.manage'] : []), ...(changesDefault ? ['channels.edit'] : [])];
    if (!needed.every((key) => hasPermission(req.user, key))) throw httpError(403, 'You do not have permission to do that.');
    const c = getChannel(req.params.id);
    assertAccess(req, c.id);
    const name = renames ? text(b.name, 'Channel name', { max: 80 }) : c.name;
    const style = transitionStyle(b.defaultTransitionStyle, c.default_transition_style);
    const ms = transitionMs(b.defaultTransitionSpeed, c.default_transition_ms);
    db.run('UPDATE channels SET name = ?, default_transition_style = ?, default_transition_ms = ? WHERE id = ?', name, style, ms, c.id);
    changed(c.id);
    return { id: c.id, slug: c.slug, name, defaultTransitionStyle: style, defaultTransitionSpeed: speedName(ms) };
  });

  app.delete('/api/channels/:id', { preHandler: requireManage }, async (req) => {
    const c = getChannel(req.params.id);
    assertAccess(req, c.id);
    const screens = db.all('SELECT id FROM screens WHERE channel_id = ?', c.id);
    db.run('DELETE FROM channels WHERE id = ?', c.id);
    for (const s of screens) hub.assignScreen(s.id);
    hub.adminRefresh('channels');
    hub.adminRefresh('screens');
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
    // The original field still works, and whoever sends it expects that transition to play.
    const transition = b.transition ?? item.transition;
    if (!LEGACY_TRANSITIONS.includes(transition)) throw httpError(400, 'Choose a transition from the list.');
    const style = transitionStyle(b.transitionStyle, b.transition ?? item.transition_style);
    const ms = transitionMs(b.transitionSpeed, item.transition_ms);
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
      `UPDATE playlist_items SET duration = ?, transition = ?, transition_style = ?, transition_ms = ?, audio = ?, enabled = ?,
         start_date = ?, end_date = ?, start_time = ?, end_time = ?, days = ? WHERE id = ?`,
      duration, transition, style, ms,
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
