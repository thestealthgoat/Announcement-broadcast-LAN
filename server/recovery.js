import { randomInt } from 'node:crypto';
import { hashPassword, httpError } from './auth.js';
import { fullAccessUsers } from './permissions.js';

// Lookalike characters are left out, since this gets read off one screen and typed on another.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';

function temporaryPassword() {
  const group = () => Array.from({ length: 4 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

// An admin here is anyone with full access, whatever their role is called.
export function listAdmins(db) {
  return fullAccessUsers(db)
    .map((u) => ({ id: u.id, username: u.username, name: u.name }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

// Recovery for a locked-out admin. There is deliberately no web route to this:
// only someone at the host computer can reach it, from the tray menu or a command.
export async function resetAdminPassword(db, userId) {
  if (!fullAccessUsers(db).some((u) => u.id === userId)) throw httpError(400, 'That account is not an admin with full access.');
  const temp = temporaryPassword();
  const hash = await hashPassword(temp);
  db.run('UPDATE users SET password_hash = ? WHERE id = ?', hash, userId);
  db.run('DELETE FROM sessions WHERE user_id = ?', userId);
  return temp;
}
