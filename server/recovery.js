import { randomInt } from 'node:crypto';
import { hashPassword, httpError } from './auth.js';

// Lookalike characters are left out, since this gets read off one screen and typed on another.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function temporaryPassword() {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

export function listAdmins(db) {
  return db
    .all("SELECT id, username, name FROM users WHERE role = 'admin' ORDER BY name COLLATE NOCASE")
    .map((u) => ({ id: u.id, username: u.username, name: u.name }));
}

// Recovery for a locked-out admin. There is deliberately no web route to this:
// only someone at the host computer can reach it, from the tray menu or a command.
export async function resetAdminPassword(db, userId) {
  const row = db.get('SELECT role FROM users WHERE id = ?', userId);
  if (!row || row.role !== 'admin') throw httpError(400, 'That account is not an admin.');
  const temp = temporaryPassword();
  const hash = await hashPassword(temp);
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, userId);
  db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  return temp;
}
