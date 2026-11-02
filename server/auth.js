import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const COOKIE = 'signage_session';

export function httpError(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [, salt, key] = stored.split('$');
  const expected = Buffer.from(key, 'hex');
  const actual = await scryptAsync(password, Buffer.from(salt, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

const hashToken = (t) => createHash('sha256').update(t).digest('hex');

export function createSession(db, reply, userId) {
  const token = randomBytes(32).toString('hex');
  db.run(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    hashToken(token), userId, Date.now() + SESSION_MS,
  );
  reply.setCookie(COOKIE, token, {
    path: '/', httpOnly: true, sameSite: 'lax', maxAge: SESSION_MS / 1000,
  });
}

export function destroySession(db, reply, token) {
  if (token) db.run('DELETE FROM sessions WHERE token_hash = ?', hashToken(token));
  reply.clearCookie(COOKIE, { path: '/' });
}

export function userFromToken(db, token) {
  if (!token) return null;
  const row = db.get(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`,
    hashToken(token), Date.now(),
  );
  return row ? publicUser(db, row) : null;
}

export function publicUser(db, row) {
  return {
    id: row.id,
    username: row.username,
    name: row.name,
    role: row.role,
    canOverride: row.role === 'admin' || !!row.can_override,
    channelIds: db
      .all('SELECT channel_id FROM user_channels WHERE user_id = ?', row.id)
      .map((r) => r.channel_id),
  };
}

export const requireUser = async (req) => {
  if (!req.user) throw httpError(401, 'Please sign in.');
};

export const requireAdmin = async (req) => {
  if (!req.user) throw httpError(401, 'Please sign in.');
  if (req.user.role !== 'admin') throw httpError(403, 'Only admins can do that.');
};

export const requireOverride = async (req) => {
  if (!req.user) throw httpError(401, 'Please sign in.');
  if (!req.user.canOverride) throw httpError(403, 'You do not have override permission.');
};

export function canEditChannel(user, channelId) {
  return user.role === 'admin' || user.channelIds.includes(channelId);
}

// A library item is shared, so an editor may change it only if every channel
// using it is one of theirs.
export function canEditMedia(db, user, mediaId) {
  if (user.role === 'admin') return true;
  return db
    .all('SELECT DISTINCT channel_id FROM playlist_items WHERE media_id = ?', mediaId)
    .every((r) => user.channelIds.includes(r.channel_id));
}

// Small in-memory limiter for sign-in attempts.
export function createLoginLimiter({ max = 10, windowMs = 5 * 60 * 1000 } = {}) {
  const hits = new Map();
  return {
    check(key) {
      const h = hits.get(key);
      if (h && h.until > Date.now() && h.count >= max) {
        throw httpError(429, 'Too many attempts. Try again in a few minutes.');
      }
    },
    fail(key) {
      const h = hits.get(key);
      if (!h || h.until <= Date.now()) hits.set(key, { count: 1, until: Date.now() + windowMs });
      else h.count += 1;
    },
    reset: (key) => hits.delete(key),
    clear: () => hits.clear(),
  };
}
