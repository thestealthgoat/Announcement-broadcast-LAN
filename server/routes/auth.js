import { hashPassword, verifyPassword, createSession, destroySession, publicUser, requireUser, httpError, COOKIE } from '../auth.js';
import { VERSION } from '../version.js';
import { baseUrls } from '../lan.js';
import QRCode from 'qrcode';

export function text(value, field, { max = 200, required = true } = {}) {
  const v = typeof value === 'string' ? value.trim() : '';
  if (required && !v) throw httpError(400, `${field} is required.`);
  if (v.length > max) throw httpError(400, `${field} is too long (limit ${max}).`);
  return v;
}

export function password(value) {
  if (typeof value !== 'string' || value.length < 8) throw httpError(400, 'Password must be at least 8 characters.');
  if (value.length > 200) throw httpError(400, 'Password is too long.');
  return value;
}

export function username(value) {
  const v = text(value, 'Username', { max: 50 });
  if (!/^[\w.@-]+$/.test(v)) throw httpError(400, 'Usernames can use letters, numbers, and . _ - @');
  return v;
}

export default async function authRoutes(app, { db, port, limiter }) {
  const hasUsers = () => !!db.get('SELECT 1 AS x FROM users LIMIT 1');

  app.get('/api/setup/status', async () => ({ needsSetup: !hasUsers() }));

  app.post('/api/setup', async (req, reply) => {
    if (hasUsers()) throw httpError(409, 'Setup is already complete.');
    const b = req.body ?? {};
    const orgName = text(b.orgName, 'Organization name', { max: 100 });
    const name = text(b.name, 'Your name', { max: 100 });
    const uname = username(b.username);
    const hash = await hashPassword(password(b.password));
    if (hasUsers()) throw httpError(409, 'Setup is already complete.');
    const { lastInsertRowid } = db.run(
      "INSERT INTO users (username, name, password_hash, role, can_override, created_at) VALUES (?, ?, ?, 'admin', 1, ?)",
      uname, name, hash, Date.now(),
    );
    db.setSetting('branding', { ...db.branding(), orgName });
    createSession(db, reply, Number(lastInsertRowid));
    return { ok: true };
  });

  app.post('/api/login', async (req, reply) => {
    const b = req.body ?? {};
    const key = req.ip;
    limiter.check(key);
    const row = db.get('SELECT * FROM users WHERE username = ?', String(b.username ?? '').trim());
    const ok = row && (await verifyPassword(String(b.password ?? ''), row.password_hash));
    if (!ok) {
      limiter.fail(key);
      throw httpError(401, 'That username or password is not right.');
    }
    limiter.reset(key);
    db.run('DELETE FROM sessions WHERE expires_at < ?', Date.now());
    createSession(db, reply, row.id);
    return publicUser(db, row);
  });

  app.post('/api/logout', async (req, reply) => {
    destroySession(db, reply, req.cookies[COOKIE]);
    return { ok: true };
  });

  app.get('/api/me', { preHandler: requireUser }, async (req) => req.user);

  app.post('/api/me/password', { preHandler: requireUser }, async (req) => {
    const b = req.body ?? {};
    const row = db.get('SELECT password_hash FROM users WHERE id = ?', req.user.id);
    if (!(await verifyPassword(String(b.current ?? ''), row.password_hash))) {
      throw httpError(400, 'Your current password is not right.');
    }
    const hash = await hashPassword(password(b.next));
    db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, req.user.id);
    return { ok: true };
  });

  app.get('/api/info', { preHandler: requireUser }, async () => ({ urls: baseUrls(port()), version: VERSION }));

  // QR code for a path on this server, using an address other devices can reach.
  app.get('/api/qr.svg', async (req, reply) => {
    const p = String(req.query.path ?? '/');
    if (!p.startsWith('/') || p.startsWith('//')) throw httpError(400, 'Bad path');
    const host = req.headers.host ?? '';
    const base = /^(localhost|127\.|\[::1\])/.test(host) || !host ? baseUrls(port())[0] : `http://${host}`;
    const svg = await QRCode.toString(base + p, { type: 'svg', margin: 1, width: 240 });
    reply.type('image/svg+xml');
    return svg;
  });
}
