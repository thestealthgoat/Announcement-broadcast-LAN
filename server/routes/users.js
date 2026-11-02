import { hashPassword, publicUser, requirePermission, httpError } from '../auth.js';
import { ROLE_IDS, fullAccessUsers, getRole, hasPermission, holdsAll, isFullAccess, legacyColumns } from '../permissions.js';
import { text, password, username } from './auth.js';

const LAST_ADMIN = 'There must be at least one person with full access.';

export default async function userRoutes(app, { db, hub }) {
  const requireUsers = requirePermission('users.manage');

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

  // Older clients send role and canOverride, which map onto the built-in roles.
  const chooseRole = (b, row) => {
    const current = row?.role_id ? getRole(db, row.role_id) : null;
    if (b.roleId !== undefined) {
      const chosen = getRole(db, Number(b.roleId));
      if (!chosen) throw httpError(400, 'Choose a role.');
      return chosen;
    }
    if (b.role === undefined && b.canOverride === undefined) {
      if (current) return current;
      throw httpError(400, 'Choose a role.');
    }
    if (b.role !== undefined && b.role !== 'admin' && b.role !== 'editor') throw httpError(400, 'Role must be admin or editor.');
    if (b.role === 'admin') return getRole(db, ROLE_IDS.admin);
    if (b.role === undefined && current?.id === ROLE_IDS.admin) return current;
    const override = b.canOverride === undefined ? !!current?.permissions.includes('overrides.push') : !!b.canOverride;
    const isEditor = current?.id === ROLE_IDS.editor || current?.id === ROLE_IDS.editorOverride;
    if (b.role === undefined && current && !isEditor) {
      if (override === current.permissions.includes('overrides.push')) return current;
      throw httpError(400, "This person's role decides that. Choose a different role instead.");
    }
    return getRole(db, override ? ROLE_IDS.editorOverride : ROLE_IDS.editor);
  };

  // Hashing a password takes a moment, so this reads the person's access as it is once that's done.
  const currentActor = (req) => {
    const row = db.get('SELECT * FROM users WHERE id = ?', req.user.id);
    const actor = row && publicUser(db, row);
    if (!hasPermission(actor, 'users.manage')) throw httpError(403, 'You do not have permission to do that.');
    return actor;
  };
  const assertCanGrant = (actor, role, ids) => {
    if (!holdsAll(actor.permissions, role.permissions)) throw httpError(403, 'You cannot give someone access you do not have yourself.');
    if (!actor.allChannels && !ids.every((id) => actor.channelIds.includes(id))) {
      throw httpError(403, 'You can only assign channels that you are assigned to yourself.');
    }
  };
  // Without this, changing the password of someone with more access would hand that access over.
  const assertWithinActor = (actor, target) => {
    const covered = holdsAll(actor.permissions, target.permissions)
      && (actor.allChannels || target.channelIds.every((id) => actor.channelIds.includes(id)));
    if (!covered) throw httpError(403, 'This person has access that you do not have, so you cannot change their account.');
  };
  const onlyFullAccessAccount = (id) => {
    const full = fullAccessUsers(db);
    return full.length === 1 && full[0].id === id;
  };

  app.get('/api/users', { preHandler: requireUsers }, async () =>
    db.all('SELECT * FROM users ORDER BY name COLLATE NOCASE').map((u) => publicUser(db, u)),
  );

  app.post('/api/users', { preHandler: requireUsers }, async (req) => {
    const b = req.body ?? {};
    const uname = username(b.username);
    const name = text(b.name, 'Name', { max: 100 });
    const hash = await hashPassword(password(b.password));
    const role = chooseRole(b, null);
    const ids = channelIds(b.channelIds);
    assertCanGrant(currentActor(req), role, ids);
    if (db.get('SELECT 1 AS x FROM users WHERE username = ?', uname)) throw httpError(409, 'That username is taken.');
    const legacy = legacyColumns(role.permissions);
    const id = db.tx(() => {
      const { lastInsertRowid } = db.run(
        'INSERT INTO users (username, name, password_hash, role, can_override, role_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        uname, name, hash, legacy.role, legacy.canOverride, role.id, Date.now(),
      );
      setChannels(Number(lastInsertRowid), ids);
      return Number(lastInsertRowid);
    });
    hub.adminRefresh('users');
    return publicUser(db, db.get('SELECT * FROM users WHERE id = ?', id));
  });

  app.patch('/api/users/:id', { preHandler: requireUsers }, async (req) => {
    const id = Number(req.params.id);
    const b = req.body ?? {};
    const hash = b.password ? await hashPassword(password(b.password)) : null;

    const actor = currentActor(req);
    const row = db.get('SELECT * FROM users WHERE id = ?', id);
    if (!row) throw httpError(404, 'User not found.');
    const target = publicUser(db, row);
    assertWithinActor(actor, target);

    const name = b.name === undefined ? row.name : text(b.name, 'Name', { max: 100 });
    const role = chooseRole(b, row);
    const ids = b.channelIds === undefined ? null : channelIds(b.channelIds);
    assertCanGrant(actor, role, ids ?? []);
    if (target.fullAccess && !isFullAccess(role.permissions) && onlyFullAccessAccount(id)) throw httpError(400, LAST_ADMIN);

    const legacy = legacyColumns(role.permissions);
    db.tx(() => {
      db.run(
        'UPDATE users SET name = ?, role = ?, can_override = ?, role_id = ?, password_hash = ? WHERE id = ?',
        name, legacy.role, legacy.canOverride, role.id, hash ?? row.password_hash, id,
      );
      if (hash) db.run('DELETE FROM sessions WHERE user_id = ?', id);
      if (ids) setChannels(id, ids);
    });
    hub.adminRefresh('users');
    return publicUser(db, db.get('SELECT * FROM users WHERE id = ?', id));
  });

  app.delete('/api/users/:id', { preHandler: requireUsers }, async (req) => {
    const id = Number(req.params.id);
    const row = db.get('SELECT * FROM users WHERE id = ?', id);
    if (!row) throw httpError(404, 'User not found.');
    if (id === req.user.id) throw httpError(400, 'You cannot delete your own account.');
    assertWithinActor(req.user, publicUser(db, row));
    if (onlyFullAccessAccount(id)) throw httpError(400, LAST_ADMIN);
    db.run('DELETE FROM users WHERE id = ?', id);
    hub.adminRefresh('users');
    return { ok: true };
  });
}
