// The fixed list of permissions, and the roles built from them. A new permission also
// needs a migration that adds it to the Admin role, or Admin stops counting as full access.
export const PERMISSIONS = [
  { key: 'library.upload', group: 'Library', label: 'Upload to the library' },
  { key: 'library.own', group: 'Library', label: 'Edit and delete items they uploaded' },
  { key: 'library.edit', group: 'Library', label: 'Edit and delete any library item' },
  { key: 'channels.add', group: 'Channels', label: 'Add library items to channels' },
  { key: 'channels.edit', group: 'Channels', label: 'Reorder, change, schedule, and remove items on channels' },
  { key: 'channels.manage', group: 'Channels', label: 'Create, rename, and delete channels' },
  { key: 'channels.all', group: 'Channels', label: 'Work on every channel, not just assigned ones' },
  { key: 'overrides.push', group: 'Everything else', label: 'Push and clear overrides on any channel' },
  { key: 'screens.manage', group: 'Everything else', label: 'Add, move, rename, and remove TVs' },
  { key: 'live.manage', group: 'Everything else', label: 'Create, change, and delete live feeds' },
  { key: 'settings.manage', group: 'Everything else', label: 'Change branding and settings' },
  { key: 'users.manage', group: 'Everything else', label: 'Manage people and roles' },
];

const ALL = PERMISSIONS.map((p) => p.key);
const KNOWN = new Set(ALL);

export const ROLE_IDS = { admin: 1, editor: 2, editorOverride: 3, uploader: 4 };

const EDITOR = ['library.upload', 'library.edit', 'channels.add', 'channels.edit'];
export const BUILTIN_ROLES = [
  { id: ROLE_IDS.admin, name: 'Admin', permissions: ALL },
  { id: ROLE_IDS.editor, name: 'Editor', permissions: EDITOR },
  { id: ROLE_IDS.editorOverride, name: 'Editor with Override', permissions: [...EDITOR, 'overrides.push'] },
  { id: ROLE_IDS.uploader, name: 'Uploader', permissions: ['library.upload', 'library.own', 'channels.add'] },
];

export const isKnownPermission = (key) => KNOWN.has(key);
export const isFullAccess = (permissions) => ALL.every((k) => permissions.includes(k));
export const holdsAll = (held, wanted) => wanted.every((k) => held.includes(k));
export const hasPermission = (user, key) => !!user?.permissions?.includes(key);

const roleJson = (row) => ({
  id: row.id,
  name: row.name,
  builtin: !!row.builtin,
  permissions: JSON.parse(row.permissions).filter(isKnownPermission),
});

export function getRole(db, id) {
  const row = db.get('SELECT * FROM roles WHERE id = ?', id);
  return row ? roleJson(row) : null;
}

export const listRoles = (db) => db.all('SELECT * FROM roles ORDER BY builtin DESC, id').map(roleJson);

// Everyone who counts as an admin for the last-account guard and for password recovery.
export function fullAccessUsers(db) {
  const full = new Set(listRoles(db).filter((r) => isFullAccess(r.permissions)).map((r) => r.id));
  return db.all('SELECT id, username, name, role_id FROM users').filter((u) => full.has(u.role_id));
}

// Nothing reads these columns any more. They stay accurate so a downgrade isn't catastrophic.
export const legacyColumns = (permissions) => ({
  role: isFullAccess(permissions) ? 'admin' : 'editor',
  canOverride: permissions.includes('overrides.push') ? 1 : 0,
});
