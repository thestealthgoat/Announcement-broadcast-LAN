import { requireUser, requirePermission, httpError } from '../auth.js';
import { parseStyle, validateStyle } from '../slide-style.js';
import { text } from './auth.js';

export default async function overrideRoutes(app, { db, hub }) {
  const requireOverride = requirePermission('overrides.push');
  const json = (o) => ({
    id: o.id,
    mediaId: o.media_id,
    mediaName: o.media_id ? db.get('SELECT name FROM media WHERE id = ?', o.media_id)?.name ?? null : null,
    title: o.title,
    body: o.body,
    style: parseStyle(o.style),
    audio: !!o.audio,
    allChannels: !!o.all_channels,
    channelIds: hub.overrideChannelIds(o.id),
    startedAt: o.started_at,
    endsAt: o.ends_at,
  });

  app.get('/api/overrides', { preHandler: requireUser }, async () => hub.activeOverrides().map(json));

  app.post('/api/overrides', { preHandler: requireOverride }, async (req) => {
    const b = req.body ?? {};
    const mediaId = b.mediaId ? String(b.mediaId) : null;
    let title = null;
    let body = null;
    let style = null;
    if (mediaId) {
      const media = db.get('SELECT status FROM media WHERE id = ?', mediaId);
      if (!media) throw httpError(404, 'Library item not found.');
      if (media.status !== 'ready') throw httpError(409, 'That item is not ready yet.');
      if (b.style !== undefined && b.style !== null) throw httpError(400, 'A design only applies to a quick message.');
    } else {
      title = text(b.title, 'Message', { max: 200 });
      body = text(b.body, 'Details', { max: 2000, required: false });
      style = validateStyle(db, b.style ?? null);
    }
    const all = !!b.allChannels;
    const channelIds = all ? [] : (Array.isArray(b.channelIds) ? b.channelIds : []).map(Number);
    if (!all && !channelIds.length) throw httpError(400, 'Choose at least one channel.');
    for (const id of channelIds) {
      if (!db.get('SELECT 1 AS x FROM channels WHERE id = ?', id)) throw httpError(400, 'Unknown channel.');
    }
    let endsAt = null;
    if (b.minutes !== undefined && b.minutes !== null && b.minutes !== '') {
      const minutes = Number(b.minutes);
      if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 1440) throw httpError(400, 'Minutes must be between 1 and 1440.');
      endsAt = Date.now() + minutes * 60000;
    }
    const id = db.tx(() => {
      const { lastInsertRowid } = db.run(
        `INSERT INTO overrides (media_id, title, body, style, audio, all_channels, started_at, ends_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        mediaId, title, body, style ? JSON.stringify(style) : null, b.audio ? 1 : 0, all ? 1 : 0, Date.now(), endsAt, req.user.id,
      );
      for (const c of new Set(channelIds)) {
        db.run('INSERT INTO override_channels (override_id, channel_id) VALUES (?, ?)', lastInsertRowid, c);
      }
      return Number(lastInsertRowid);
    });
    hub.pushAll();
    hub.adminRefresh('overrides');
    return json(db.get('SELECT * FROM overrides WHERE id = ?', id));
  });

  app.delete('/api/overrides/:id', { preHandler: requireOverride }, async (req) => {
    const id = Number(req.params.id);
    if (!db.get('SELECT 1 AS x FROM overrides WHERE id = ?', id)) throw httpError(404, 'Override not found.');
    db.run('UPDATE overrides SET cleared_at = ? WHERE id = ? AND cleared_at IS NULL', Date.now(), id);
    hub.pushAll();
    hub.adminRefresh('overrides');
    return { ok: true };
  });
}
