import { hashPassword, publicUser, requireAdmin, httpError } from '../auth.js';
import { text, password, username } from './auth.js';

export default async function userRoutes(app, { db }) {
  const setChannels = (userId, ids) => {
    db.run('DELETE FROM user_channels WHERE user_id = ?', userId);
    for (const id of ids) db.run('INSERT OR IGNORE INTO user_channels (user_id, channel_id) VALUES (?, ?)', userId, id);
  };
  const channelIds = (value) => {
    if (value === undefined) return [];
    if (!Array.isArray(value)) throw httpError(400, 'channelIds must be a list.');
    for (const id of value) {
      if (!db.get('SELECT 1 AS x FROM channels WHERE id = ?', Number(id))) throw httpError(400, 'Unknown channel.');
    }
    return value.map(Number);
  };
  const role = (value) => {
    if (value !== 'admin' && value !== 'editor') throw httpError(400, 'Role must be admin or editor.');
    return value;
  };
  const adminCount = () => db.get("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").n;

  app.get('/api/users', { preHandler: requireAdmin }, async () =>
    db.all('SELECT * FROM users ORDER BY name COLLATE NOCASE').map((u) => publicUser(db, u)),
  );

  app.post('/api/users', { preHandler: requireAdmin }, async (req) => {
    const b = req.body ?? {};
    const uname = username(b.username);
    const name = text(b.name, 'Name', { max: 100 });
    const r = role(b.role);
    const ids = channelIds(b.channelIds);
    const hash = await hashPassword(password(b.password));
    if (db.get('SELECT 1 AS x FROM users WHERE username = ?', uname)) throw httpError(409, 'That username is taken.');
    const { lastInsertRowid } = db.run(
      'INSERT INTO users (username, name, password_hash, role, can_override, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      uname, name, hash, r, b.canOverride || r === 'admin' ? 1 : 0, Date.now(),
    );
    const id = Number(lastInsertRowid);
    setChannels(id, ids);
    return publicUser(db, db.get('SELECT * FROM users WHERE id = ?', id));
  });

  app.patch('/api/users/:id', { preHandler: requireAdmin }, async (req) => {
    const id = Number(req.params.id);
    const row = db.get('SELECT * FROM users WHERE id = ?', id);
    if (!row) throw httpError(404, 'User not found.');
    const b = req.body ?? {};
    const name = b.name === undefined ? row.name : text(b.name, 'Name', { max: 100 });
    const r = b.role === undefined ? row.role : role(b.role);
    if (row.role === 'admin' && r !== 'admin' && adminCount() === 1) throw httpError(400, 'There must be at least one admin.');
    const canOverride = b.canOverride === undefined ? row.can_override : b.canOverride ? 1 : 0;
    const ids = b.channelIds === undefined ? null : channelIds(b.channelIds);
    const hash = b.password ? await hashPassword(password(b.password)) : row.password_hash;
    db.run(
      'UPDATE users SET name = ?, role = ?, can_override = ?, password_hash = ? WHERE id = ?',
      name, r, r === 'admin' ? 1 : canOverride, hash, id,
    );
    if (b.password) db.run('DELETE FROM sessions WHERE user_id = ?', id);
    if (ids) setChannels(id, ids);
    return publicUser(db, db.get('SELECT * FROM users WHERE id = ?', id));
  });

  app.delete('/api/users/:id', { preHandler: requireAdmin }, async (req) => {
    const id = Number(req.params.id);
    const row = db.get('SELECT * FROM users WHERE id = ?', id);
    if (!row) throw httpError(404, 'User not found.');
    if (id === req.user.id) throw httpError(400, 'You cannot delete your own account.');
    if (row.role === 'admin' && adminCount() === 1) throw httpError(400, 'There must be at least one admin.');
    db.run('DELETE FROM users WHERE id = ?', id);
    return { ok: true };
  });
}
