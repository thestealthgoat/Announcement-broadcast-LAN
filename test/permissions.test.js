// Every route that changes something must be in one of these lists, so a new route can't skip a check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, setupAdmin, form } from './helpers.js';
import { RESTORE_CONFIRMATION } from '../server/routes/backup.js';
import { PERMISSIONS } from '../server/permissions.js';

const ALL = PERMISSIONS.map((p) => p.key);
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);

// Open to anyone or to any signed-in person, on purpose.
const PUBLIC = new Set([
  'POST /api/setup', // Refuses once any account exists.
  // Same reason as setup: a new computer has nobody to sign in as. It refuses once any account
  // exists, and checks again at the moment it would apply. test/backup.test.js proves both.
  'POST /api/setup/restore',
  'POST /api/login',
  'POST /api/logout',
  'POST /api/me/password', // Self-service, and needs the current password.
]);

let counter = 0;
const unique = (prefix) => `${prefix}${++counter}`;

// `perms` passes the route's check, any one of them being enough, or all of them for `together`.
// `prepare` builds fresh data for each attempt, as the signed-in tester `who`. `expect` is for a
// route that can't finish here.
const ROUTES = [
  ['POST /api/users', ['users.manage'], async ({ admin }) => ({ body: { username: unique('new'), name: 'New', password: 'password-1', roleId: await newRole(admin) } })],
  ['PATCH /api/users/:id', ['users.manage'], async ({ admin }) => ({ id: await newUser(admin), body: { name: 'Changed' } })],
  ['DELETE /api/users/:id', ['users.manage'], async ({ admin }) => ({ id: await newUser(admin) })],

  ['POST /api/roles', ['users.manage'], async () => ({ body: { name: unique('Role '), permissions: ['users.manage'] } })],
  ['PATCH /api/roles/:id', ['users.manage'], async ({ admin }) => ({ id: await newRole(admin), body: { name: unique('Renamed ') } })],
  ['DELETE /api/roles/:id', ['users.manage'], async ({ admin }) => ({ id: await newRole(admin) })],

  ['POST /api/channels', ['channels.manage'], async () => ({ body: { name: unique('Channel ') } })],
  ['PATCH /api/channels/:id', ['channels.manage'], async ({ admin }) => ({ id: await newChannel(admin), body: { name: unique('Renamed ') } })],
  ['DELETE /api/channels/:id', ['channels.manage'], async ({ admin }) => ({ id: await newChannel(admin) })],
  ['POST /api/channels/:id/items', ['channels.add'], async ({ admin }) => ({ id: await newChannel(admin), body: { mediaId: await newMedia(admin) } })],
  ['PUT /api/channels/:id/order', ['channels.edit'], async ({ admin }) => {
    const { channelId, itemId } = await newPlacement(admin);
    return { id: channelId, body: { ids: [itemId] } };
  }],
  ['PATCH /api/playlist-items/:id', ['channels.edit'], async ({ admin }) => ({ id: (await newPlacement(admin)).itemId, body: { duration: 9 } })],
  ['DELETE /api/playlist-items/:id', ['channels.edit'], async ({ admin }) => ({ id: (await newPlacement(admin)).itemId })],

  ['POST /api/media', ['library.upload'], async () => ({ body: form('dot.png', PNG, 'image/png') })],
  ['POST /api/media/pdf', ['library.upload'], async () => ({ body: { name: 'Doc', pages: 1 } })],
  ['POST /api/media/:id/pages/:n', ['library.upload'], async ({ admin, who }) => ({ id: await newPdf(who, admin), n: 1, body: form('page-1.jpg', JPEG, 'image/jpeg') })],
  ['POST /api/media/:id/finish', ['library.upload'], async ({ admin, who }) => ({ id: await newPdf(who, admin, true), body: {} })],
  ['POST /api/media/text', ['library.upload'], async () => ({ body: { title: 'Hello' } })],
  ['POST /api/media/url', ['library.upload'], async () => ({ body: { url: 'http://example.com/' } })],
  ['PATCH /api/media/:id', ['library.edit', 'library.own'], async ({ admin }) => ({ id: await newMedia(admin), body: { name: 'Changed' } }), { sufficient: ['library.edit'] }],
  ['DELETE /api/media/:id', ['library.edit', 'library.own', 'live.manage'], async ({ admin }) => ({ id: await newMedia(admin) }), { sufficient: ['library.edit'] }],

  ['POST /api/library/bulk/move', ['library.edit', 'library.own'], async ({ admin }) => ({ body: { ids: [await newMedia(admin)], folderId: null } }), { sufficient: ['library.edit'] }],
  ['POST /api/library/bulk/tag', ['library.edit', 'library.own'], async ({ admin }) => ({ body: { ids: [await newMedia(admin)], add: [await newTag(admin)] } }), { sufficient: ['library.edit'] }],
  ['POST /api/library/bulk/add-to-channel', ['channels.add'], async ({ admin }) => ({ body: { ids: [await newMedia(admin)], channelId: await newChannel(admin) } })],
  ['POST /api/library/bulk/delete', ['library.edit', 'library.own', 'live.manage'], async ({ admin }) => ({ body: { ids: [await newMedia(admin)] } }), { sufficient: ['library.edit'] }],
  ['POST /api/folders', ['library.edit'], async () => ({ body: { name: unique('Folder ') } })],
  ['PATCH /api/folders/:id', ['library.edit'], async ({ admin }) => ({ id: await newFolder(admin), body: { name: unique('Renamed ') } })],
  ['DELETE /api/folders/:id', ['library.edit'], async ({ admin }) => ({ id: await newFolder(admin) })],
  ['POST /api/tags', ['library.edit'], async () => ({ body: { name: unique('Tag ') } })],
  ['PATCH /api/tags/:id', ['library.edit'], async ({ admin }) => ({ id: await newTag(admin), body: { name: unique('Renamed ') } })],
  ['DELETE /api/tags/:id', ['library.edit'], async ({ admin }) => ({ id: await newTag(admin) })],

  ['POST /api/pair', ['screens.manage'], async ({ admin }) => ({ body: { code: '0000', channelId: await newChannel(admin) } }), { expect: 404 }],
  ['PATCH /api/screens/:id', ['screens.manage'], async ({ server }) => ({ id: newScreen(server), body: { name: 'Hall' } })],
  ['DELETE /api/screens/:id', ['screens.manage'], async ({ server }) => ({ id: newScreen(server) })],

  ['POST /api/overrides', ['overrides.push'], async () => ({ body: { title: 'Fire drill', allChannels: true } })],
  ['DELETE /api/overrides/:id', ['overrides.push'], async ({ admin }) => ({ id: (await admin.post('/api/overrides', { title: 'Drill', allChannels: true })).data.id })],

  ['PUT /api/branding', ['settings.manage'], async () => ({ body: { orgName: 'Org' } })],
  ['POST /api/branding/logo', ['settings.manage'], async () => ({ body: form('logo.png', PNG, 'image/png') })],
  ['DELETE /api/branding/logo', ['settings.manage'], async () => ({})],
  ['POST /api/branding/font', ['settings.manage'], async () => ({ body: form('font.woff2', Buffer.from('font'), 'font/woff2') })],
  ['PUT /api/ops/settings', ['settings.manage'], async () => ({ body: { checkForUpdates: false } })],
  ['POST /api/notices/:id/dismiss', ['screens.manage', 'settings.manage'], async () => ({ id: 'not-showing', body: {} }), { expect: 404, sufficient: ['settings.manage'] }],

  // Replaces everything including every account, so it takes every permission at once.
  ['POST /api/backup/restore', ALL, async () => ({ query: `?confirm=${RESTORE_CONFIRMATION}`, body: form('not-a-backup.tar', Buffer.alloc(1024, 1), 'application/x-tar') }), { expect: 400, together: true }],

  ['POST /api/live-feeds', ['live.manage'], async () => ({ body: { name: 'Feed', input: 'rtmp', port: nextPort(), enabled: false } })],
  ['PATCH /api/live-feeds/:id', ['live.manage'], async ({ admin }) => ({ id: await newFeed(admin), body: { name: 'Renamed' } })],

  ['POST /api/slide-templates', ['settings.manage'], async () => ({ body: { name: unique('Template '), style: { textColor: '#ffffff' } } })],
  ['PATCH /api/slide-templates/:id', ['settings.manage'], async ({ admin }) => ({ id: await newTemplate(admin), body: { name: unique('Renamed ') } })],
  ['DELETE /api/slide-templates/:id', ['settings.manage'], async ({ admin }) => ({ id: await newTemplate(admin) })],
];

let port = 20000 + (process.pid % 20000);
const nextPort = () => ++port;

async function newUser(admin) {
  const r = await admin.post('/api/users', { username: unique('user'), name: 'User', password: 'password-1', roleId: await newRole(admin) });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.id;
}
async function newRole(admin) {
  return (await admin.post('/api/roles', { name: unique('Spare '), permissions: [] })).data.id;
}
async function newChannel(admin) {
  return (await admin.post('/api/channels', { name: unique('Spare ') })).data.id;
}
async function newMedia(admin) {
  return (await admin.post('/api/media/text', { title: 'Item' })).data.id;
}
async function newFolder(admin) {
  return (await admin.post('/api/folders', { name: unique('Spare ') })).data.id;
}
async function newTag(admin) {
  return (await admin.post('/api/tags', { name: unique('Spare ') })).data.id;
}
async function newPlacement(admin) {
  const channelId = await newChannel(admin);
  const items = await admin.post(`/api/channels/${channelId}/items`, { mediaId: await newMedia(admin) });
  return { channelId, itemId: items.data[0].id };
}
// Only the uploader can continue a PDF, so it's theirs if they're allowed to start one.
async function newPdf(who, admin, withPage = false) {
  const start = { name: 'Doc', pages: 1 };
  let owner = who;
  let r = await owner.post('/api/media/pdf', start);
  if (r.status !== 200) {
    owner = admin;
    r = await owner.post('/api/media/pdf', start);
  }
  assert.equal(r.status, 200, JSON.stringify(r.data));
  if (withPage) await owner.post(`/api/media/${r.data.id}/pages/1`, form('page-1.jpg', JPEG, 'image/jpeg'));
  return r.data.id;
}
async function newFeed(admin) {
  const r = await admin.post('/api/live-feeds', { name: 'Feed', input: 'rtmp', port: nextPort(), enabled: false });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.id;
}
async function newTemplate(admin) {
  const r = await admin.post('/api/slide-templates', { name: unique('Spare template '), style: {} });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.id;
}
function newScreen(server) {
  const id = unique('screen-');
  server.db.run('INSERT INTO screens (id, name, created_at) VALUES (?, ?, ?)', id, 'TV', Date.now());
  return id;
}

function send(c, method, url, body) {
  if (method === 'POST') return c.post(url, body);
  if (method === 'PUT') return c.put(url, body ?? {});
  if (method === 'PATCH') return c.patch(url, body ?? {});
  return c.del(url);
}

test('every mutating route is either checked below or public on purpose', async (t) => {
  const { server } = await startServer(t);
  const found = new Set(server.routes.filter((r) => MUTATING.has(r.method)).map((r) => `${r.method} ${r.url}`));
  const listed = new Set([...PUBLIC, ...ROUTES.map(([route]) => route)]);
  assert.deepEqual([...found].filter((r) => !listed.has(r)), [], 'add these routes to the table in test/permissions.test.js');
  assert.deepEqual([...listed].filter((r) => !found.has(r)), [], 'these listed routes no longer exist');
});

test('each permission opens its routes, and nothing else does', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const testers = new Map();

  async function tester(permissions) {
    const key = [...permissions].sort().join();
    if (!testers.has(key)) {
      const role = await admin.post('/api/roles', { name: unique('Tester '), permissions });
      assert.equal(role.status, 200, JSON.stringify(role.data));
      const username = unique('tester');
      assert.equal((await admin.post('/api/users', { username, name: username, password: 'password-1', roleId: role.data.id })).status, 200);
      const c = client(base);
      assert.equal((await c.post('/api/login', { username, password: 'password-1' })).status, 200);
      testers.set(key, c);
    }
    return testers.get(key);
  }

  for (const [route, perms, prepare, opts = {}] of ROUTES) {
    const [method, pattern] = route.split(' ');
    const attempt = async (who) => {
      const { id, n, body, query = '' } = await prepare({ admin, server, who });
      const url = pattern.replace(':id', id).replace(':n', n) + query;
      return send(who, method, url, body);
    };

    await t.test(route, async () => {
      // Everything except what this route asks for, so no other permission opens it by accident.
      const lacking = await tester(ALL.filter((k) => !perms.includes(k)));
      assert.equal((await attempt(lacking)).status, 403, 'refused without the permission');

      // Only what this route asks for, plus every channel so assignment isn't what's being tested.
      const enough = opts.together ? [perms] : (opts.sufficient ?? perms).map((perm) => [perm]);
      for (const held of enough) {
        const holding = await tester([...new Set([...held, 'channels.all'])]);
        const r = await attempt(holding);
        assert.equal(r.status, opts.expect ?? 200, `allowed with ${held}: ${JSON.stringify(r.data)}`);
      }

      assert.equal((await attempt(client(base))).status, 401, 'signed out');
    });
  }
});
