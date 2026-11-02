import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { startServer, client, setupAdmin, makeEditor } from './helpers.js';
import { hashPassword } from '../server/auth.js';
import { createServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { BUILTIN_ROLES, PERMISSIONS, ROLE_IDS, listRoles } from '../server/permissions.js';

const ALL = PERMISSIONS.map((p) => p.key);
const PASSWORD = 'password-1';
const CLI = fileURLToPath(new URL('../server/reset-admin.js', import.meta.url));

async function makeUser(admin, base, username, roleId, channelIds = []) {
  const r = await admin.post('/api/users', { username, name: username, password: PASSWORD, roleId, channelIds });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = client(base);
  assert.equal((await c.post('/api/login', { username, password: PASSWORD })).status, 200);
  return Object.assign(c, { id: r.data.id });
}

async function makeRole(admin, name, permissions) {
  const r = await admin.post('/api/roles', { name, permissions });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.id;
}

// A database exactly as 1.0.2 shipped it, from the v1.0.2 tag, with real passwords.
async function realOldDatabase() {
  const sql = execFileSync('git', ['show', 'v1.0.2:server/db.js'], { encoding: 'utf8' }).match(/const SCHEMA = `([\s\S]*?)`;/)[1];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-roles-'));
  const raw = new DatabaseSync(path.join(dataDir, 'signage.db'));
  raw.exec(sql);
  raw.exec('PRAGMA user_version = 1');
  raw.exec('PRAGMA foreign_keys = ON');
  const hash = await hashPassword(PASSWORD);
  const add = raw.prepare('INSERT INTO users (username, name, password_hash, role, can_override, created_at) VALUES (?, ?, ?, ?, ?, 1)');
  add.run('ada', 'Ada', hash, 'admin', 1);
  add.run('ovi', 'Ovi', hash, 'editor', 1);
  add.run('ed', 'Ed', hash, 'editor', 0);
  raw.exec(`INSERT INTO channels (id, slug, name, created_at) VALUES (1, 'gym', 'Gym', 1), (2, 'cafe', 'Cafe', 1);
    INSERT INTO user_channels (user_id, channel_id) VALUES (2, 1), (3, 1);
    INSERT INTO media (id, type, name, title, created_at) VALUES ('mine', 'text', 'Mine', 'Mine', 1), ('shared', 'text', 'Shared', 'Shared', 1), ('theirs', 'text', 'Theirs', 'Theirs', 1), ('spare', 'text', 'Spare', 'Spare', 1);
    INSERT INTO playlist_items (id, channel_id, media_id, position) VALUES (1, 1, 'mine', 0), (2, 1, 'shared', 1), (3, 2, 'shared', 0), (4, 2, 'theirs', 1);
    INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ('old-session', 1, 9999999999999);`);
  raw.close();
  return dataDir;
}

test('a real 1.0.2 database keeps exactly the same access for every account', async (t) => {
  const dataDir = await realOldDatabase();
  const server = await createServer({ dataDir, port: 0, host: '127.0.0.1', ops: { fetch: null, discovery: false } });
  const { port } = await server.start();
  t.after(async () => {
    await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${port}`;
  const signIn = async (username) => {
    const c = client(base);
    assert.equal((await c.post('/api/login', { username, password: PASSWORD })).status, 200, `${username} can still sign in`);
    return c;
  };
  const [ada, ovi, ed] = [await signIn('ada'), await signIn('ovi'), await signIn('ed')];

  // Sessions and channel assignments reference users, so they prove the table wasn't rebuilt.
  assert.equal(server.db.get("SELECT user_id FROM sessions WHERE token_hash = 'old-session'").user_id, 1);
  assert.equal(server.db.all('SELECT * FROM user_channels').length, 2);

  const who = async (c) => {
    const { roleName, fullAccess, allChannels, canOverride, role, channelIds } = (await c.get('/api/me')).data;
    return { roleName, fullAccess, allChannels, canOverride, role, channelIds };
  };
  assert.deepEqual(await who(ada), { roleName: 'Admin', fullAccess: true, allChannels: true, canOverride: true, role: 'admin', channelIds: [] });
  assert.deepEqual(await who(ovi), { roleName: 'Editor with Override', fullAccess: false, allChannels: false, canOverride: true, role: 'editor', channelIds: [1] });
  assert.deepEqual(await who(ed), { roleName: 'Editor', fullAccess: false, allChannels: false, canOverride: false, role: 'editor', channelIds: [1] });

  // What each account could do on 1.0.2. Each line runs for every account: [admin, override, editor].
  const expectations = [
    ['see users', (c) => c.get('/api/users'), [200, 403, 403]],
    ['see live feeds', (c) => c.get('/api/live-feeds'), [200, 403, 403]],
    ['create a channel', (c) => c.post('/api/channels', { name: 'New' }), [200, 403, 403]],
    ['rename a channel', (c) => c.patch('/api/channels/2', { name: 'Cafe' }), [200, 403, 403]],
    ['change branding', (c) => c.put('/api/branding', { orgName: 'Org' }), [200, 403, 403]],
    ['change update checks', (c) => c.put('/api/ops/settings', { checkForUpdates: false }), [200, 403, 403]],
    ['pair a screen', (c) => c.post('/api/pair', { code: '0000', channelId: 1 }), [404, 403, 403]],
    ['upload to the library', (c) => c.post('/api/media/text', { title: 'Note' }), [200, 200, 200]],
    ['upload onto an assigned channel', (c) => c.post('/api/media/text?channelId=1', { title: 'Note' }), [200, 200, 200]],
    ['upload onto another channel', (c) => c.post('/api/media/text?channelId=2', { title: 'Note' }), [200, 403, 403]],
    ['read an assigned channel', (c) => c.get('/api/channels/1/items'), [200, 200, 200]],
    ['read another channel', (c) => c.get('/api/channels/2/items'), [200, 403, 403]],
    ['add to an assigned channel', (c) => c.post('/api/channels/1/items', { mediaId: 'theirs' }), [200, 200, 200]],
    ['add to another channel', (c) => c.post('/api/channels/2/items', { mediaId: 'spare' }), [200, 403, 403]],
    ['schedule on an assigned channel', (c) => c.patch('/api/playlist-items/1', { days: 1 }), [200, 200, 200]],
    ['schedule on another channel', (c) => c.patch('/api/playlist-items/4', { days: 1 }), [200, 403, 403]],
    ['edit an item only on their channels', (c) => c.patch('/api/media/mine', { name: 'Mine' }), [200, 200, 200]],
    ['edit a shared item', (c) => c.patch('/api/media/shared', { name: 'Shared' }), [200, 403, 403]],
    ['see screens', (c) => c.get('/api/screens'), [200, 200, 200]],
    ['see overrides', (c) => c.get('/api/overrides'), [200, 200, 200]],
  ];
  for (const [what, call, want] of expectations) {
    assert.deepEqual([(await call(ada)).status, (await call(ovi)).status, (await call(ed)).status], want, what);
  }

  // Overrides reach every channel for anyone with the flag, assigned or not.
  assert.equal((await ed.post('/api/overrides', { title: 'No', allChannels: true })).status, 403);
  const pushed = await ovi.post('/api/overrides', { title: 'Yes', channelIds: [2] });
  assert.equal(pushed.status, 200);
  assert.equal((await ed.del(`/api/overrides/${pushed.data.id}`)).status, 403);
  assert.equal((await ovi.del(`/api/overrides/${pushed.data.id}`)).status, 200);

  // The editor's item is shared the moment someone else's channel uses it.
  assert.equal((await ed.del('/api/media/shared')).status, 403);
  assert.equal((await ed.del('/api/playlist-items/1')).status, 200);

  assert.deepEqual(server.listAdmins().map((a) => a.username), ['ada']);
});

test('the built-in roles in the migration match server/permissions.js', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-roles-'));
  const db = openDb(path.join(dir, 'signage.db'));
  const stored = listRoles(db).filter((r) => r.builtin);
  assert.deepEqual(stored.map((r) => ({ id: r.id, name: r.name, permissions: r.permissions })), BUILTIN_ROLES);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('/api/me lists permissions, and a role change applies on the very next request', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const me = (await admin.get('/api/me')).data;
  assert.deepEqual([...me.permissions].sort(), [...ALL].sort());
  assert.equal(me.roleName, 'Admin');

  const ed = await makeUser(admin, base, 'ed', ROLE_IDS.editor);
  assert.equal((await ed.post('/api/overrides', { title: 'x', allChannels: true })).status, 403);
  await admin.patch(`/api/users/${ed.id}`, { roleId: ROLE_IDS.editorOverride });
  assert.equal((await ed.post('/api/overrides', { title: 'x', allChannels: true })).status, 200, 'same session, new access');
  await admin.patch(`/api/users/${ed.id}`, { roleId: ROLE_IDS.uploader });
  assert.equal((await ed.post('/api/overrides', { title: 'x', allChannels: true })).status, 403, 'and taken away again');

  // Editing the role itself is just as immediate.
  const role = await makeRole(admin, 'Coach', ['library.upload']);
  const coach = await makeUser(admin, base, 'coach', role);
  assert.equal((await coach.post('/api/channels', { name: 'No' })).status, 403);
  await admin.patch(`/api/roles/${role}`, { permissions: ['library.upload', 'channels.manage'] });
  assert.equal((await coach.post('/api/channels', { name: 'Yes' })).status, 200);
});

test('the old columns stay consistent with the role', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const row = (id) => server.db.get('SELECT role, can_override FROM users WHERE id = ?', id);

  const u = await makeUser(admin, base, 'u', ROLE_IDS.uploader);
  assert.deepEqual({ ...row(u.id) }, { role: 'editor', can_override: 0 });
  await admin.patch(`/api/users/${u.id}`, { roleId: ROLE_IDS.editorOverride });
  assert.deepEqual({ ...row(u.id) }, { role: 'editor', can_override: 1 });

  const custom = await makeRole(admin, 'Everything', ALL);
  await admin.patch(`/api/users/${u.id}`, { roleId: custom });
  assert.deepEqual({ ...row(u.id) }, { role: 'admin', can_override: 1 }, 'a custom role with full access counts as admin');
  await admin.patch(`/api/roles/${custom}`, { permissions: ['library.upload'] });
  assert.deepEqual({ ...row(u.id) }, { role: 'editor', can_override: 0 }, 'editing the role updates its people');
});

test('nobody can grant what they do not hold', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const [main] = (await admin.get('/api/channels')).data;
  const other = (await admin.post('/api/channels', { name: 'Other' })).data;
  const managerRole = await makeRole(admin, 'Manager', ['users.manage', 'library.upload']);
  const manager = await makeUser(admin, base, 'manager', managerRole, [main.id]);
  const adminId = (await admin.get('/api/me')).data.id;

  // Giving a role more than they hold.
  assert.equal((await manager.post('/api/roles', { name: 'Big', permissions: ['live.manage'] })).status, 403);
  assert.equal((await manager.post('/api/roles', { name: 'All', permissions: ['channels.all'] })).status, 403);
  assert.equal((await manager.patch(`/api/roles/${managerRole}`, { permissions: ['users.manage', 'library.upload', 'live.manage'] })).status, 403, 'not by editing their own role');
  const small = (await manager.post('/api/roles', { name: 'Small', permissions: ['library.upload'] }));
  assert.equal(small.status, 200, 'what they hold is fine');
  assert.equal((await manager.patch(`/api/roles/${small.data.id}`, { permissions: ['settings.manage'] })).status, 403);

  // Roles beyond their own reach.
  const bigRole = await makeRole(admin, 'Live crew', ['live.manage']);
  assert.equal((await manager.patch(`/api/roles/${bigRole}`, { name: 'Renamed' })).status, 403);
  assert.equal((await manager.del(`/api/roles/${bigRole}`)).status, 403);

  // Giving a person more than they hold, by every route.
  const base1 = { name: 'X', password: PASSWORD };
  assert.equal((await manager.post('/api/users', { ...base1, username: 'a1', roleId: ROLE_IDS.admin })).status, 403);
  assert.equal((await manager.post('/api/users', { ...base1, username: 'a2', role: 'admin' })).status, 403, 'not through the old field');
  assert.equal((await manager.post('/api/users', { ...base1, username: 'a3', roleId: bigRole })).status, 403);
  assert.equal((await manager.post('/api/users', { ...base1, username: 'a4', roleId: small.data.id, channelIds: [other.id] })).status, 403, 'not a channel they lack');
  const hired = await manager.post('/api/users', { ...base1, username: 'a5', roleId: small.data.id, channelIds: [main.id] });
  assert.equal(hired.status, 200);
  assert.equal((await manager.patch(`/api/users/${hired.data.id}`, { roleId: ROLE_IDS.editor })).status, 403);
  assert.equal((await manager.patch(`/api/users/${hired.data.id}`, { channelIds: [other.id] })).status, 403);

  // Their own account gets no special path.
  assert.equal((await manager.patch(`/api/users/${manager.id}`, { roleId: ROLE_IDS.admin })).status, 403);
  assert.equal((await manager.patch(`/api/users/${manager.id}`, { role: 'admin' })).status, 403);
  assert.equal((await manager.patch(`/api/users/${manager.id}`, { canOverride: true })).status, 400);
  assert.equal((await manager.patch(`/api/users/${manager.id}`, { channelIds: [main.id, other.id] })).status, 403);

  // Nor can they get at anyone with more access, since a new password would hand it over.
  assert.equal((await manager.patch(`/api/users/${adminId}`, { password: 'taken-over-now' })).status, 403);
  assert.equal((await manager.patch(`/api/users/${adminId}`, { roleId: ROLE_IDS.uploader })).status, 403);
  assert.equal((await manager.del(`/api/users/${adminId}`)).status, 403);
  assert.equal((await client(base).post('/api/login', { username: 'ada', password: 'taken-over-now' })).status, 401);
  const peer = await makeUser(admin, base, 'peer', managerRole, [main.id, other.id]);
  assert.equal((await manager.patch(`/api/users/${peer.id}`, { password: 'taken-over-now' })).status, 403, 'nor a peer with more channels');

  // Stepping down is allowed.
  assert.equal((await manager.patch(`/api/users/${manager.id}`, { roleId: small.data.id })).status, 200);
  assert.equal((await manager.get('/api/users')).status, 403);
});

test('at least one account with full access always remains', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const me = (await admin.get('/api/me')).data;

  assert.equal((await admin.patch(`/api/users/${me.id}`, { roleId: ROLE_IDS.editor })).status, 400);
  assert.equal((await admin.del(`/api/users/${me.id}`)).status, 400);

  // A custom role with every box ticked is full access too, so it counts.
  const everything = await makeRole(admin, 'Everything', ALL);
  const grace = await makeUser(admin, base, 'grace', everything);
  assert.equal((await grace.get('/api/me')).data.fullAccess, true);
  assert.equal((await admin.patch(`/api/users/${me.id}`, { roleId: ROLE_IDS.editor })).status, 200, 'grace still has full access');

  // Grace is now the last one, so nothing can take her access away.
  const lower = ALL.filter((k) => k !== 'settings.manage');
  assert.equal((await grace.patch(`/api/users/${grace.id}`, { roleId: ROLE_IDS.editor })).status, 400);
  const edit = await grace.patch(`/api/roles/${everything}`, { permissions: lower });
  assert.equal(edit.status, 400);
  assert.match(edit.data.error, /full access/);
  assert.equal((await grace.get('/api/me')).data.fullAccess, true, 'the refused edit changed nothing');

  // With another full-access account, the role can change.
  await grace.patch(`/api/users/${me.id}`, { roleId: ROLE_IDS.admin });
  assert.equal((await grace.patch(`/api/roles/${everything}`, { permissions: lower })).status, 200);
  assert.equal((await grace.get('/api/me')).data.fullAccess, false);

  // Now the admin is the last, and a former admin can't delete them either.
  assert.equal((await grace.del(`/api/users/${me.id}`)).status, 403);
  const other = await makeUser(admin, base, 'other', ROLE_IDS.admin);
  assert.equal((await other.del(`/api/users/${me.id}`)).status, 200);
  assert.equal((await other.del(`/api/users/${other.id}`)).status, 400);
});

test('roles in use cannot be deleted, and built-in roles cannot change', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const role = await makeRole(admin, 'Coach', ['library.upload']);
  const a = await makeUser(admin, base, 'a', role);

  const one = await admin.del(`/api/roles/${role}`);
  assert.equal(one.status, 409);
  assert.match(one.data.error, /^1 person has this role/);
  await makeUser(admin, base, 'b', role);
  const two = await admin.del(`/api/roles/${role}`);
  assert.equal(two.status, 409);
  assert.match(two.data.error, /^2 people have this role/);

  const listed = (await admin.get('/api/roles')).data;
  assert.equal(listed.roles.find((r) => r.id === role).userCount, 2);
  assert.equal(listed.permissions.length, ALL.length);
  assert.ok(listed.permissions.every((p) => p.label && p.group));

  await admin.del(`/api/users/${a.id}`);
  const b = (await admin.get('/api/users')).data.find((u) => u.username === 'b');
  await admin.del(`/api/users/${b.id}`);
  assert.equal((await admin.del(`/api/roles/${role}`)).status, 200);
  assert.equal((await admin.get('/api/roles')).data.roles.some((r) => r.id === role), false);

  for (const r of BUILTIN_ROLES) {
    assert.equal((await admin.patch(`/api/roles/${r.id}`, { name: 'Mine' })).status, 400, r.name);
    assert.equal((await admin.patch(`/api/roles/${r.id}`, { permissions: [] })).status, 400, r.name);
    assert.equal((await admin.del(`/api/roles/${r.id}`)).status, 400, r.name);
  }
  assert.equal((await admin.post('/api/roles', { name: 'admin', permissions: [] })).status, 409, 'names are unique, ignoring case');
  assert.equal((await admin.post('/api/roles', { name: 'Odd', permissions: ['make.coffee'] })).status, 400);
  assert.equal((await admin.post('/api/users', { username: 'x', name: 'X', password: PASSWORD, roleId: 999 })).status, 400);
});

test('an Uploader adds to assigned channels and changes only their own uploads', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const [mine] = (await admin.get('/api/channels')).data;
  const other = (await admin.post('/api/channels', { name: 'Other' })).data;
  const coach = await makeUser(admin, base, 'coach', ROLE_IDS.uploader, [mine.id]);

  // Uploads and adds.
  const own = await coach.post(`/api/media/text?channelId=${mine.id}`, { title: 'Practice moved' });
  assert.equal(own.status, 200);
  assert.equal((await coach.post('/api/media/url', { url: 'http://example.com/' })).status, 200);
  assert.equal((await coach.post(`/api/media/text?channelId=${other.id}`, { title: 'No' })).status, 403);
  const theirs = (await admin.post('/api/media/text', { title: 'Theirs' })).data;
  const added = await coach.post(`/api/channels/${mine.id}/items`, { mediaId: theirs.id });
  assert.equal(added.status, 200, 'anything in the library can go on an assigned channel');
  assert.equal((await coach.post(`/api/channels/${other.id}/items`, { mediaId: theirs.id })).status, 403);
  assert.equal((await coach.get(`/api/channels/${mine.id}/items`)).status, 200);
  assert.equal((await coach.get(`/api/channels/${other.id}/items`)).status, 403);

  // Nothing on the channel can be reordered, edited, scheduled, or removed, even their own item.
  const ids = added.data.map((i) => i.id);
  assert.equal((await coach.put(`/api/channels/${mine.id}/order`, { ids: [...ids].reverse() })).status, 403);
  for (const id of ids) {
    assert.equal((await coach.patch(`/api/playlist-items/${id}`, { duration: 5 })).status, 403);
    assert.equal((await coach.patch(`/api/playlist-items/${id}`, { days: 1 })).status, 403);
    assert.equal((await coach.del(`/api/playlist-items/${id}`)).status, 403);
  }

  // Other people's library items are off limits, and their own stay theirs.
  assert.equal((await coach.patch(`/api/media/${theirs.id}`, { name: 'Mine now' })).status, 403);
  assert.equal((await coach.del(`/api/media/${theirs.id}`)).status, 403);
  assert.equal((await coach.patch(`/api/media/${own.data.id}`, { name: 'Fixed typo' })).status, 200);

  // The shared-item rule still applies to their own upload.
  await admin.post(`/api/channels/${other.id}/items`, { mediaId: own.data.id });
  assert.equal((await coach.patch(`/api/media/${own.data.id}`, { name: 'Again' })).status, 403);
  assert.equal((await coach.del(`/api/media/${own.data.id}`)).status, 403);
  const second = (await coach.post('/api/media/text', { title: 'Oops' })).data;
  assert.equal((await coach.del(`/api/media/${second.id}`)).status, 200);

  // Nor anything else.
  assert.equal((await coach.post('/api/channels', { name: 'No' })).status, 403);
  assert.equal((await coach.post('/api/overrides', { title: 'No', allChannels: true })).status, 403);
  assert.equal((await coach.get('/api/users')).status, 403);
  assert.equal((await coach.put('/api/branding', { orgName: 'No' })).status, 403);
});

test('custom roles: channel limits apply to channels and screens, and a new channel is yours', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const [mine] = (await admin.get('/api/channels')).data;
  const other = (await admin.post('/api/channels', { name: 'Other' })).data;
  const role = await makeRole(admin, 'Site lead', ['channels.manage', 'channels.edit', 'screens.manage']);
  const lead = await makeUser(admin, base, 'lead', role, [mine.id]);

  const made = await lead.post('/api/channels', { name: 'Fresh' });
  assert.equal(made.status, 200);
  assert.equal((await lead.patch(`/api/channels/${made.data.id}`, { name: 'Fresher' })).status, 200, 'they can use what they make');
  assert.equal((await lead.patch(`/api/channels/${other.id}`, { name: 'No' })).status, 403);
  assert.equal((await lead.del(`/api/channels/${other.id}`)).status, 403);
  const listing = (await lead.get('/api/channels')).data;
  assert.deepEqual(listing.filter((c) => c.canManage).map((c) => c.id).sort(), [mine.id, made.data.id].sort());
  assert.equal(listing.find((c) => c.id === mine.id).canAdd, false, 'no channels.add in this role');

  const screen = (name, channelId) => {
    server.db.run('INSERT INTO screens (id, name, channel_id, created_at) VALUES (?, ?, ?, 1)', name, name, channelId);
    return name;
  };
  const here = screen('here', mine.id);
  const there = screen('there', other.id);
  assert.equal((await lead.patch(`/api/screens/${here}`, { name: 'Hall' })).status, 200);
  assert.equal((await lead.patch(`/api/screens/${here}`, { channelId: other.id })).status, 403, 'not onto a channel they lack');
  assert.equal((await lead.patch(`/api/screens/${there}`, { name: 'No' })).status, 403);
  assert.equal((await lead.del(`/api/screens/${there}`)).status, 403);
  assert.equal((await lead.post('/api/pair', { code: '0000', channelId: other.id })).status, 403);
});

test('live feeds: deleting one takes the live permission, not a library one', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const feed = (await admin.post('/api/live-feeds', { name: 'Program', input: 'rtmp', port: 21935, enabled: false })).data;
  const crewRole = await makeRole(admin, 'Live crew', ['live.manage', 'channels.all']);
  const crew = await makeUser(admin, base, 'crew', crewRole);
  const editor = await makeUser(admin, base, 'ed', ROLE_IDS.editor);

  assert.equal((await editor.del(`/api/media/${feed.id}`)).status, 403);
  assert.equal((await crew.del(`/api/media/${(await admin.post('/api/media/text', { title: 'x' })).data.id}`)).status, 403, 'live.manage opens no ordinary items');
  assert.equal((await crew.del(`/api/media/${feed.id}`)).status, 200);
});

test('notices follow permissions', async (t) => {
  let clock = 1_000_000_000_000;
  const { base, server } = await startServer(t, { ops: { now: () => clock, statfs: async () => ({ bsize: 4096, blocks: 1e9, bavail: 5e8 }) } });
  const admin = await setupAdmin(base);
  const [channel] = (await admin.get('/api/channels')).data;
  const screens = await makeUser(admin, base, 's', await makeRole(admin, 'TV crew', ['screens.manage']));
  const settings = await makeUser(admin, base, 'o', await makeRole(admin, 'Office', ['settings.manage']));
  server.db.run("INSERT INTO screens (id, name, channel_id, last_seen, created_at) VALUES ('gone', 'Gone', ?, ?, 1)", channel.id, clock);
  clock += 6 * 60 * 1000;

  const kinds = async (c) => (await c.get('/api/notices')).data.map((n) => n.kind);
  assert.deepEqual(await kinds(screens), ['screens'], 'whoever looks after TVs hears about missing ones');
  assert.deepEqual(await kinds(settings), []);
  assert.equal((await screens.post('/api/notices/made-up/dismiss')).status, 404);
  assert.equal((await settings.post('/api/notices/made-up/dismiss')).status, 404);
  assert.equal((await settings.put('/api/ops/settings', { checkForUpdates: false })).status, 200);
  assert.equal((await screens.put('/api/ops/settings', { checkForUpdates: true })).status, 403);
});

function resetCli(dataDir, ...args) {
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], {
    env: { ...process.env, SIGNAGE_DATA_DIR: dataDir }, encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('recovery means full access, whatever the role is called', async (t) => {
  const { base, server, dataDir } = await startServer(t);
  const admin = await setupAdmin(base);
  const everything = await makeRole(admin, 'Owner', ALL);
  const owner = await makeUser(admin, base, 'owner', everything);
  const almost = await makeUser(admin, base, 'almost', await makeRole(admin, 'Almost', ALL.filter((k) => k !== 'users.manage')));

  assert.deepEqual(server.listAdmins().map((a) => a.username), ['ada', 'owner']);
  await assert.rejects(server.resetAdminPassword(almost.id), /not an admin/i);

  const refused = resetCli(dataDir, 'almost');
  assert.notEqual(refused.status, 0);
  const ok = resetCli(dataDir, 'owner');
  assert.equal(ok.status, 0, ok.out);
  const temp = ok.out.match(/[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}/)[0];
  assert.equal((await client(base).post('/api/login', { username: 'owner', password: temp })).status, 200);

  // The role itself drops below full access, so recovery stops offering it.
  await admin.patch(`/api/roles/${everything}`, { permissions: ['library.upload'] });
  assert.deepEqual(server.listAdmins().map((a) => a.username), ['ada']);
  await assert.rejects(server.resetAdminPassword(owner.id), /not an admin/i);
});

test('old clients: role and canOverride still map onto the built-in roles', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const ed = await makeEditor(admin, base, 'ed');
  const { id } = (await ed.get('/api/me')).data;
  const roleOf = async () => (await ed.get('/api/me')).data.roleId;
  assert.equal(await roleOf(), ROLE_IDS.editor);
  await admin.patch(`/api/users/${id}`, { canOverride: true });
  assert.equal(await roleOf(), ROLE_IDS.editorOverride);
  await admin.patch(`/api/users/${id}`, { role: 'editor' });
  assert.equal(await roleOf(), ROLE_IDS.editorOverride, 'keeps the override it already had');
  await admin.patch(`/api/users/${id}`, { canOverride: false });
  assert.equal(await roleOf(), ROLE_IDS.editor);
  await admin.patch(`/api/users/${id}`, { role: 'admin' });
  assert.equal(await roleOf(), ROLE_IDS.admin);

  await admin.patch(`/api/users/${id}`, { roleId: ROLE_IDS.uploader });
  assert.equal((await admin.patch(`/api/users/${id}`, { canOverride: true })).status, 400, 'an Uploader cannot be half-promoted');
  assert.equal((await admin.patch(`/api/users/${id}`, { role: 'owner' })).status, 400);
});

// ---------- role edits stay within the channels the actor covers ----------

test('someone limited to one channel cannot change or delete a role held by someone on another channel', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const one = (await admin.post('/api/channels', { name: 'One' })).data.id;
  const two = (await admin.post('/api/channels', { name: 'Two' })).data.id;
  const role = async (name, permissions) => {
    const r = await admin.post('/api/roles', { name, permissions });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return r.data.id;
  };
  const addUser = async (username, roleId, channelIds) => {
    const r = await admin.post('/api/users', { username, name: username, password: 'password-1', roleId, channelIds });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  };
  const managerRole = await role('Channel manager', ['users.manage', 'library.upload']);
  const everyChannel = await role('Every channel manager', ['users.manage', 'channels.all', 'library.upload']);
  const onOther = await role('Held on two', ['library.upload']);
  const onBoth = await role('Held on both', ['library.upload']);
  const onMine = await role('Held on one', ['library.upload']);
  const nobody = await role('Held by nobody', ['library.upload']);
  await addUser('mgr', managerRole, [one]);
  await addUser('boss', everyChannel, []);
  await addUser('two', onOther, [two]);
  await addUser('both-a', onBoth, [one]);
  await addUser('both-b', onBoth, [two]);
  await addUser('mine', onMine, [one]);
  const mgr = client(base);
  assert.equal((await mgr.post('/api/login', { username: 'mgr', password: 'password-1' })).status, 200);
  const boss = client(base);
  assert.equal((await boss.post('/api/login', { username: 'boss', password: 'password-1' })).status, 200);

  for (const id of [onOther, onBoth]) {
    const edit = await mgr.patch(`/api/roles/${id}`, { permissions: [] });
    assert.equal(edit.status, 403, JSON.stringify(edit.data));
    assert.match(edit.data.error, /channels/);
    assert.equal((await mgr.patch(`/api/roles/${id}`, { name: `Renamed ${id}` })).status, 403);
    const gone = await mgr.del(`/api/roles/${id}`);
    assert.equal(gone.status, 403, JSON.stringify(gone.data));
  }
  assert.deepEqual(JSON.parse(server.db.get('SELECT permissions FROM roles WHERE id = ?', onOther).permissions), ['library.upload'], 'unchanged');

  // Within their channels, the same as before.
  assert.equal((await mgr.patch(`/api/roles/${onMine}`, { permissions: [] })).status, 200);
  assert.equal((await mgr.patch(`/api/roles/${nobody}`, { name: 'Nobody yet' })).status, 200);
  assert.equal((await mgr.del(`/api/roles/${onMine}`)).status, 409, 'someone still holds it');
  assert.equal((await mgr.del(`/api/roles/${nobody}`)).status, 200);
  // Every channel, or full access, covers everyone.
  assert.equal((await boss.patch(`/api/roles/${onOther}`, { name: 'Boss renamed' })).status, 200);
  assert.equal((await admin.patch(`/api/roles/${onBoth}`, { name: 'Admin renamed' })).status, 200);
  assert.equal((await boss.del(`/api/roles/${onOther}`)).status, 409, 'someone still holds it');
});
