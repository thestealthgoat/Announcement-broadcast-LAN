import { requireUser, requirePermission, httpError, canAccessChannel } from '../auth.js';
import { text } from './auth.js';

export default async function screenRoutes(app, { db, hub, ops }) {
  const requireScreens = requirePermission('screens.manage');
  const assertChannel = (req, channelId) => {
    if (channelId !== null && !canAccessChannel(req.user, channelId)) throw httpError(403, 'You are not assigned to this channel.');
  };
  const channelOrNull = (req, value) => {
    if (value === null || value === '') return null;
    const id = Number(value);
    if (!db.get('SELECT 1 AS x FROM channels WHERE id = ?', id)) throw httpError(404, 'Channel not found.');
    assertChannel(req, id);
    return id;
  };

  app.get('/api/screens', { preHandler: requireUser }, async () => {
    const attention = ops.attentionIds();
    return db.all(
      `SELECT s.*, c.name AS channel_name, c.slug AS channel_slug
       FROM screens s LEFT JOIN channels c ON c.id = s.channel_id
       ORDER BY s.name COLLATE NOCASE`,
    ).map((s) => ({
      id: s.id, name: s.name, channelId: s.channel_id, channelName: s.channel_name, channelSlug: s.channel_slug,
      pairCode: s.pair_code, online: hub.isOnline(s.id), lastSeen: s.last_seen,
      currentItem: hub.isOnline(s.id) ? s.current_item : null,
      needsAttention: attention.has(s.id), storageFull: hub.isCacheFull(s.id),
    }));
  });

  app.post('/api/pair', { preHandler: requireScreens }, async (req) => {
    const code = String(req.body?.code ?? '').trim();
    const channelId = channelOrNull(req, req.body?.channelId);
    if (!channelId) throw httpError(400, 'Choose a channel.');
    const screen = db.get('SELECT * FROM screens WHERE pair_code = ?', code);
    if (!screen) throw httpError(404, 'No TV is showing that code.');
    const name = text(req.body?.name, 'Name', { max: 80, required: false }) || screen.name;
    db.run('UPDATE screens SET channel_id = ?, pair_code = NULL, name = ? WHERE id = ?', channelId, name, screen.id);
    hub.assignScreen(screen.id);
    hub.adminRefresh('screens');
    hub.adminRefresh('channels');
    return { ok: true };
  });

  app.patch('/api/screens/:id', { preHandler: requireScreens }, async (req) => {
    const screen = db.get('SELECT * FROM screens WHERE id = ?', req.params.id);
    if (!screen) throw httpError(404, 'Screen not found.');
    assertChannel(req, screen.channel_id);
    const b = req.body ?? {};
    const name = b.name === undefined ? screen.name : text(b.name, 'Name', { max: 80 });
    const channelId = b.channelId === undefined ? screen.channel_id : channelOrNull(req, b.channelId);
    db.run('UPDATE screens SET name = ?, channel_id = ? WHERE id = ?', name, channelId, screen.id);
    if (channelId !== screen.channel_id) hub.assignScreen(screen.id);
    hub.adminRefresh('screens');
    hub.adminRefresh('notices');
    hub.adminRefresh('channels');
    return { ok: true };
  });

  // Forgets a screen. If that TV is still on, it falls back to a pairing code.
  app.delete('/api/screens/:id', { preHandler: requireScreens }, async (req) => {
    const screen = db.get('SELECT * FROM screens WHERE id = ?', req.params.id);
    if (!screen) throw httpError(404, 'Screen not found.');
    assertChannel(req, screen.channel_id);
    db.run('UPDATE screens SET channel_id = NULL WHERE id = ?', screen.id);
    hub.assignScreen(screen.id);
    db.run('DELETE FROM screens WHERE id = ?', screen.id);
    hub.adminRefresh('screens');
    hub.adminRefresh('notices');
    hub.adminRefresh('channels');
    return { ok: true };
  });
}
