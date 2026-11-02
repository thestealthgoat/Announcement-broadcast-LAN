import { requirePermission, httpError } from '../auth.js';
import { PERMISSIONS, fullAccessUsers, getRole, holdsAll, isFullAccess, isKnownPermission, legacyColumns, listRoles } from '../permissions.js';
import { text } from './auth.js';

const NOT_YOURS = 'You cannot give a role access you do not have yourself.';

export default async function roleRoutes(app, { db, hub }) {
  const requireUsers = requirePermission('users.manage');
  const usersOf = (roleId) => db.get('SELECT COUNT(*) AS n FROM users WHERE role_id = ?', roleId).n;

  const json = (role, actor) => ({
    ...role,
    fullAccess: isFullAccess(role.permissions),
    userCount: usersOf(role.id),
    canAssign: holdsAll(actor.permissions, role.permissions),
  });
  const permissionList = (value) => {
    if (!Array.isArray(value) || !value.every((k) => typeof k === 'string' && isKnownPermission(k))) {
      throw httpError(400, 'Choose from the listed permissions.');
    }
    return [...new Set(value)];
  };
  const roleName = (value, id = 0) => {
    const name = text(value, 'Role name', { max: 60 });
    if (db.get('SELECT 1 AS x FROM roles WHERE name = ? AND id <> ?', name, id)) throw httpError(409, 'There is already a role with that name.');
    return name;
  };
  const customRole = (id) => {
    const role = getRole(db, Number(id));
    if (!role) throw httpError(404, 'Role not found.');
    if (role.builtin) throw httpError(400, 'Built-in roles cannot be changed or deleted.');
    return role;
  };

  app.get('/api/roles', { preHandler: requireUsers }, async (req) => ({
    permissions: PERMISSIONS,
    roles: listRoles(db).map((r) => json(r, req.user)),
  }));

  app.post('/api/roles', { preHandler: requireUsers }, async (req) => {
    const b = req.body ?? {};
    const name = roleName(b.name);
    const permissions = permissionList(b.permissions);
    if (!holdsAll(req.user.permissions, permissions)) throw httpError(403, NOT_YOURS);
    const { lastInsertRowid } = db.run(
      'INSERT INTO roles (name, builtin, permissions) VALUES (?, 0, ?)', name, JSON.stringify(permissions),
    );
    hub.adminRefresh('users');
    return json(getRole(db, Number(lastInsertRowid)), req.user);
  });

  app.patch('/api/roles/:id', { preHandler: requireUsers }, async (req) => {
    const role = customRole(req.params.id);
    if (!holdsAll(req.user.permissions, role.permissions)) throw httpError(403, 'This role has access that you do not have, so you cannot change it.');
    const b = req.body ?? {};
    const name = b.name === undefined ? role.name : roleName(b.name, role.id);
    const permissions = b.permissions === undefined ? role.permissions : permissionList(b.permissions);
    if (!holdsAll(req.user.permissions, permissions)) throw httpError(403, NOT_YOURS);
    const losesFullAccess = isFullAccess(role.permissions) && !isFullAccess(permissions);
    const full = fullAccessUsers(db);
    if (losesFullAccess && full.length && full.every((u) => u.role_id === role.id)) {
      throw httpError(400, 'There must be at least one person with full access.');
    }
    const legacy = legacyColumns(permissions);
    db.tx(() => {
      db.run('UPDATE roles SET name = ?, permissions = ? WHERE id = ?', name, JSON.stringify(permissions), role.id);
      db.run('UPDATE users SET role = ?, can_override = ? WHERE role_id = ?', legacy.role, legacy.canOverride, role.id);
    });
    hub.adminRefresh('users');
    return json(getRole(db, role.id), req.user);
  });

  app.delete('/api/roles/:id', { preHandler: requireUsers }, async (req) => {
    const role = customRole(req.params.id);
    if (!holdsAll(req.user.permissions, role.permissions)) throw httpError(403, 'This role has access that you do not have, so you cannot delete it.');
    const n = usersOf(role.id);
    if (n) {
      throw httpError(409, `${n === 1 ? '1 person has' : `${n} people have`} this role. Move ${n === 1 ? 'them' : 'everyone'} to a different role first.`);
    }
    db.run('DELETE FROM roles WHERE id = ?', role.id);
    hub.adminRefresh('users');
    return { ok: true };
  });
}
