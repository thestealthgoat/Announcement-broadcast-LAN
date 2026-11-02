import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { atEnd, startServer, client, setupAdmin, form, waitForMedia, ffmpegMake, player } from './helpers.js';
import { createServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { createHashBackfill, isMediaUsed, mediaUsage } from '../server/library.js';
import { createProcessor } from '../server/media.js';
import { ROLE_IDS } from '../server/permissions.js';

const PASSWORD = 'password-1';
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');

async function makeUser(admin, base, username, roleId, channelIds = []) {
  const r = await admin.post('/api/users', { username, name: username, password: PASSWORD, roleId, channelIds });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const c = client(base);
  assert.equal((await c.post('/api/login', { username, password: PASSWORD })).status, 200);
  return c;
}
const newChannel = async (admin, name) => (await admin.post('/api/channels', { name })).data.id;
const newText = async (c, title) => {
  const r = await c.post('/api/media/text', { title });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.id;
};
const place = async (admin, channelId, mediaId) => assert.equal((await admin.post(`/api/channels/${channelId}/items`, { mediaId })).status, 200);
const list = async (c, query = '') => (await c.get(`/api/library${query}`)).data;
const names = (page) => page.items.map((m) => m.name);
const resultFor = (r, id) => r.data.results.find((x) => x.id === id);

// Puts a row and its file straight on disk, the way an older version would have left them.
function seedFile(server, dataDir, id, bytes, { type = 'image', file = 'image.png', status = 'ready', createdAt = Date.now() } = {}) {
  const dir = path.join(dataDir, 'media', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, file), bytes);
  server.db.run(
    'INSERT INTO media (id, type, name, status, file, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    id, type, id, status, file, bytes.length, createdAt,
  );
}

test('a real 1.0.2 database gains library columns and keeps its items and playlists', () => {
  const sql = execFileSync('git', ['show', 'v1.0.2:server/db.js'], { encoding: 'utf8' }).match(/const SCHEMA = `([\s\S]*?)`;/)[1];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signage-lib-')), 'signage.db');
  const raw = new DatabaseSync(file);
  raw.exec(sql);
  raw.exec('PRAGMA user_version = 1');
  raw.exec(`INSERT INTO users (username, name, password_hash, role, can_override, created_at) VALUES ('ada', 'Ada', 'x', 'admin', 1, 1);
    INSERT INTO channels (slug, name, created_at) VALUES ('gym', 'Gym', 1), ('hall', 'Hall', 1);
    INSERT INTO media (id, type, name, title, created_at) VALUES ('m1', 'text', 'Hello', 'Hello', 1);
    INSERT INTO media (id, type, name, file, size, created_at) VALUES ('m2', 'image', 'Poster', 'image.png', 10, 2);
    INSERT INTO playlist_items (channel_id, media_id, position, duration) VALUES (1, 'm1', 0, 7), (1, 'm2', 1, 8), (2, 'm2', 0, 9);
    INSERT INTO overrides (media_id, all_channels, started_at) VALUES ('m2', 1, 5);`);
  raw.close();

  const db = openDb(file);
  assert.deepEqual(db.all('SELECT id, name, folder_id, sha256 FROM media ORDER BY id').map((r) => ({ ...r })), [
    { id: 'm1', name: 'Hello', folder_id: null, sha256: null },
    { id: 'm2', name: 'Poster', folder_id: null, sha256: null },
  ]);
  assert.deepEqual(db.all('SELECT channel_id, media_id, position, duration FROM playlist_items ORDER BY id').map((r) => ({ ...r })), [
    { channel_id: 1, media_id: 'm1', position: 0, duration: 7 },
    { channel_id: 1, media_id: 'm2', position: 1, duration: 8 },
    { channel_id: 2, media_id: 'm2', position: 0, duration: 9 },
  ]);
  assert.equal(db.all('SELECT * FROM overrides').length, 1);
  db.close();
  const again = openDb(file);
  assert.equal(again.all('SELECT * FROM playlist_items').length, 3, 'reopening is safe');
  again.close();
});

test('deleting a folder moves its items to the top level and deleting a tag only unlinks it', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const channel = await newChannel(admin, 'Gym');
  const folder = (await admin.post('/api/folders', { name: 'Sports' })).data;
  assert.equal((await admin.post('/api/folders', { name: 'sports' })).status, 409, 'names are unique, ignoring case');
  const tag = (await admin.post('/api/tags', { name: 'Fall' })).data;
  const id = await newText(admin, 'Game');
  await place(admin, channel, id);
  assert.equal((await admin.post('/api/library/bulk/move', { ids: [id], folderId: folder.id })).data.done, 1);
  assert.equal((await admin.post('/api/library/bulk/tag', { ids: [id], add: [tag.id] })).data.done, 1);
  assert.equal((await admin.get('/api/folders')).data[0].count, 1);
  assert.equal((await admin.get('/api/tags')).data[0].count, 1);

  const inFolder = await list(admin, `?folder=${folder.id}&tag=${tag.id}`);
  assert.deepEqual(names(inFolder), ['Game']);
  assert.equal(inFolder.items[0].folderId, folder.id);

  const removed = await admin.del(`/api/folders/${folder.id}`);
  assert.equal(removed.status, 200);
  assert.equal(removed.data.items, 1);
  assert.equal((await admin.del(`/api/tags/${tag.id}`)).status, 200);

  const after = (await admin.get(`/api/library/${id}`)).data;
  assert.equal(after.name, 'Game', 'the item survives');
  assert.equal(after.folderId, null);
  assert.deepEqual(after.tags, []);
  assert.equal(after.usage.channels[0].name, 'Gym', 'and stays on its channel');
  assert.equal(server.db.all('SELECT * FROM media').length, 1);
  assert.equal(server.db.all('SELECT * FROM playlist_items').length, 1);
});

test('search, sort, filters, and paging work in the database', async (t) => {
  const { base, server, dataDir } = await startServer(t);
  const admin = await setupAdmin(base);
  seedFile(server, dataDir, 'big', Buffer.alloc(3000), { createdAt: 1000 });
  seedFile(server, dataDir, 'Apple', Buffer.alloc(1000), { createdAt: 3000 });
  seedFile(server, dataDir, 'cherry', Buffer.alloc(2000), { createdAt: 2000, type: 'video', file: 'video.mp4' });
  seedFile(server, dataDir, 'broken_100%', Buffer.alloc(10), { createdAt: 4000, status: 'failed' });
  seedFile(server, dataDir, 'broken_x', Buffer.alloc(10), { createdAt: 500, status: 'processing' });

  assert.deepEqual(names(await list(admin)), ['broken_100%', 'Apple', 'cherry', 'big', 'broken_x'], 'newest first by default');
  assert.deepEqual(names(await list(admin, '?sort=name')), ['Apple', 'big', 'broken_100%', 'broken_x', 'cherry'], 'ignoring case');
  assert.deepEqual(names(await list(admin, '?sort=size')).slice(0, 3), ['big', 'cherry', 'Apple']);
  assert.deepEqual(names(await list(admin, '?q=APP')), ['Apple'], 'search ignores case');
  assert.deepEqual(names(await list(admin, `?q=${encodeURIComponent('100%')}`)), ['broken_100%'], 'a percent sign is literal');
  assert.deepEqual(names(await list(admin, `?q=${encodeURIComponent('_x')}`)), ['broken_x'], 'an underscore is literal');
  assert.deepEqual(names(await list(admin, '?type=video')), ['cherry']);
  assert.deepEqual(names(await list(admin, '?status=failed')), ['broken_100%']);
  assert.deepEqual(names(await list(admin, '?status=processing')), ['broken_x']);
  assert.equal((await list(admin, '?folder=none')).total, 5);

  const first = await list(admin, '?limit=2');
  const second = await list(admin, '?limit=2&offset=2');
  assert.equal(first.total, 5);
  assert.deepEqual(names(first), ['broken_100%', 'Apple']);
  assert.deepEqual(names(second), ['cherry', 'big']);
  assert.equal((await list(admin, '?type=image&idsOnly=1')).ids.length, 4);

  for (const bad of ['?sort=rowid;DROP', '?type=nope', '?status=nope']) assert.equal((await admin.get(`/api/library${bad}`)).status, 400, bad);
  assert.equal((await client(base).get('/api/library')).status, 401);
  assert.equal(server.db.all('SELECT * FROM media').length, 5);
});

test('GET /api/media only gains fields, and the library stays quick with thousands of items', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const channel = await newChannel(admin, 'Gym');
  server.db.tx(() => {
    for (let i = 0; i < 5000; i++) {
      server.db.run("INSERT INTO media (id, type, name, title, created_at) VALUES (?, 'text', ?, 'x', ?)", `seed-${i}`, `Item ${i}`, i);
      if (i % 2) server.db.run('INSERT INTO playlist_items (channel_id, media_id, position) VALUES (?, ?, ?)', channel, `seed-${i}`, i);
    }
  });
  const old = (await admin.get('/api/media')).data;
  assert.ok(Array.isArray(old), 'still a plain array for the pickers');
  assert.equal(old.length, 5000);
  for (const key of ['id', 'type', 'name', 'status', 'thumb', 'src', 'createdAt', 'createdBy', 'live', 'liveStatus']) assert.ok(key in old[0], key);

  const started = performance.now();
  const page = await list(admin, '?q=Item%2049&sort=name&limit=60');
  const cleanup = (await admin.get('/api/library/cleanup')).data;
  assert.ok(performance.now() - started < 5000, 'seconds at most, even on a slow machine');
  assert.equal(page.total, 111);
  assert.equal(cleanup.count, 2500);
});

test('every item reports the channels and active overrides using it, and an ended override does not count', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const gym = await newChannel(admin, 'Gym');
  const hall = await newChannel(admin, 'Hall');
  const id = await newText(admin, 'Shared');
  await place(admin, gym, id);
  await place(admin, hall, id);
  await place(admin, hall, id);
  let m = (await admin.get(`/api/library/${id}`)).data;
  assert.deepEqual(m.usage.channels.map((c) => c.name), ['Gym', 'Hall'], 'a channel is named once');
  assert.equal(m.usage.inUse, true);

  const lone = await newText(admin, 'Lone');
  assert.equal(isMediaUsed(server.db, lone), false);
  const o = (await admin.post('/api/overrides', { mediaId: lone, channelIds: [gym], minutes: 5 })).data;
  m = (await admin.get(`/api/library/${lone}`)).data;
  assert.equal(m.usage.overrides.length, 1);
  assert.equal(m.usage.overrides[0].channels[0].name, 'Gym');
  assert.equal(isMediaUsed(server.db, lone), true);
  assert.equal(mediaUsage(server.db, [lone], Date.now() + 6 * 60000).get(lone).inUse, false, 'it has ended by then');
  await admin.del(`/api/overrides/${o.id}`);
  assert.equal(isMediaUsed(server.db, lone), false);
});

test('an Editor limited to some channels gets per-item results from every bulk action', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const mine = await newChannel(admin, 'Mine');
  const other = await newChannel(admin, 'Other');
  const editor = await makeUser(admin, base, 'ed', ROLE_IDS.editor, [mine]);
  const folder = (await admin.post('/api/folders', { name: 'F' })).data;
  const tag = (await admin.post('/api/tags', { name: 'T' })).data;

  const ok = [await newText(admin, 'One'), await newText(admin, 'Two'), await newText(admin, 'Three'), await newText(admin, 'Four')];
  await place(admin, mine, ok[0]);
  const blocked = await newText(admin, 'Elsewhere');
  await place(admin, other, blocked);
  const ids = [...ok, blocked];

  const moved = await editor.post('/api/library/bulk/move', { ids, folderId: folder.id });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.summary, "4 moved, 1 skipped because it's used on a channel you don't manage");
  assert.equal(resultFor(moved, blocked).ok, false);
  assert.equal(resultFor(moved, blocked).reason, 'scope');
  assert.equal(server.db.get('SELECT folder_id FROM media WHERE id = ?', blocked).folder_id, null, 'really not moved');
  assert.equal(server.db.get('SELECT folder_id FROM media WHERE id = ?', ok[0]).folder_id, folder.id);

  const tagged = await editor.post('/api/library/bulk/tag', { ids, add: [tag.id] });
  assert.equal(tagged.data.done, 4);
  assert.equal(server.db.get('SELECT COUNT(*) AS n FROM media_tags WHERE media_id = ?', blocked).n, 0);
  const untagged = await editor.post('/api/library/bulk/tag', { ids: [ok[1]], remove: [tag.id] });
  assert.equal(untagged.data.done, 1);
  assert.equal(server.db.get('SELECT COUNT(*) AS n FROM media_tags').n, 3);

  // Adding to a channel checks the channel, and doesn't need rights over the item.
  assert.equal((await editor.post('/api/library/bulk/add-to-channel', { ids, channelId: other })).status, 403);
  assert.equal((await editor.post('/api/library/bulk/add-to-channel', { ids, channelId: 99999 })).status, 404);
  const added = await editor.post('/api/library/bulk/add-to-channel', { ids: [ok[0], ok[1], 'missing'], channelId: mine });
  assert.equal(added.data.summary, "1 added to Mine, 1 skipped because it's already on that channel, 1 skipped because it no longer exists");

  const deleted = await editor.post('/api/library/bulk/delete', { ids: [ok[2], blocked] });
  assert.equal(deleted.data.done, 1);
  assert.equal(resultFor(deleted, blocked).reason, 'scope');
  assert.ok(server.db.get('SELECT 1 AS x FROM media WHERE id = ?', blocked));
  assert.ok(!server.db.get('SELECT 1 AS x FROM media WHERE id = ?', ok[2]));
  // The result is the same as the single-item route's refusal.
  assert.equal((await editor.del(`/api/media/${blocked}`)).status, 403);
});

test('an Uploader only changes their own items, and only on their channels', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const mine = await newChannel(admin, 'Mine');
  const other = await newChannel(admin, 'Other');
  const coach = await makeUser(admin, base, 'coach', ROLE_IDS.uploader, [mine]);
  const folder = (await admin.post('/api/folders', { name: 'F' })).data;
  const tag = (await admin.post('/api/tags', { name: 'T' })).data;

  const own = await newText(coach, 'Own');
  const ownSpread = await newText(coach, 'Own but spread');
  await place(admin, other, ownSpread);
  const theirs = await newText(admin, 'Theirs');
  const ids = [own, ownSpread, theirs];

  const moved = await coach.post('/api/library/bulk/move', { ids, folderId: folder.id });
  assert.equal(moved.data.summary, "1 moved, 1 skipped because it's used on a channel you don't manage, 1 skipped because you didn't upload it");
  assert.equal((await coach.post('/api/library/bulk/tag', { ids, add: [tag.id] })).data.done, 1);

  // Folders and tags themselves need library.edit.
  assert.equal((await coach.post('/api/folders', { name: 'Nope' })).status, 403);
  assert.equal((await coach.post('/api/tags', { name: 'Nope' })).status, 403);
  assert.equal((await coach.del(`/api/folders/${folder.id}`)).status, 403);

  const row = (await list(coach)).items;
  assert.equal(row.find((m) => m.id === own).canEdit, true);
  assert.equal(row.find((m) => m.id === theirs).canEdit, false);
  assert.equal(row.find((m) => m.id === theirs).canDelete, false);
  assert.equal(row.find((m) => m.id === ownSpread).canDelete, false);

  const plan = await coach.post('/api/library/bulk/delete', { ids, dryRun: true });
  assert.equal(plan.data.dryRun, true);
  assert.equal(plan.data.done, 1);
  assert.equal(server.db.all('SELECT * FROM media').length, 3, 'a dry run deletes nothing');
  const gone = await coach.post('/api/library/bulk/delete', { ids });
  assert.equal(gone.data.summary, "1 deleted, 1 skipped because it's used on a channel you don't manage, 1 skipped because you didn't upload it");
  assert.deepEqual(server.db.all('SELECT id FROM media ORDER BY id').map((r) => r.id).sort(), [ownSpread, theirs].sort());

  // Adding is allowed for an Uploader on an assigned channel, even for someone else's item.
  assert.equal((await coach.post('/api/library/bulk/add-to-channel', { ids: [theirs], channelId: mine })).data.done, 1);
  assert.equal((await coach.post('/api/library/bulk/add-to-channel', { ids: [theirs], channelId: other })).status, 403);
});

test('bulk delete needs live.manage for a live feed, whatever else someone holds', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const editor = await makeUser(admin, base, 'ed', ROLE_IDS.editor, []);
  const feed = (await admin.post('/api/live-feeds', { name: 'Feed', input: 'rtmp', port: 21000 + (process.pid % 20000), enabled: false })).data;
  const refused = await editor.post('/api/library/bulk/delete', { ids: [feed.id] });
  assert.equal(refused.data.summary, "0 deleted, 1 skipped because it's a live feed and you don't manage live feeds");
  assert.ok(server.db.get('SELECT 1 AS x FROM media WHERE id = ?', feed.id));
  assert.ok(server.db.get('SELECT 1 AS x FROM live_feeds WHERE media_id = ?', feed.id));

  const done = await admin.post('/api/library/bulk/delete', { ids: [feed.id] });
  assert.equal(done.data.done, 1);
  assert.ok(!server.db.get('SELECT 1 AS x FROM live_feeds WHERE media_id = ?', feed.id));
});

test('deleting an item in use names the channels first and needs that confirmed', async (t) => {
  const { base, server, dataDir } = await startServer(t);
  const admin = await setupAdmin(base);
  const gym = await newChannel(admin, 'Gym');
  const lobby = await newChannel(admin, 'Lobby');
  seedFile(server, dataDir, 'poster', Buffer.alloc(2048));
  await place(admin, gym, 'poster');
  await place(admin, lobby, 'poster');

  const plan = (await admin.post('/api/library/bulk/delete', { ids: ['poster'], dryRun: true })).data;
  const planned = plan.results[0];
  assert.deepEqual(planned.usage.channels.map((c) => c.name), ['Gym', 'Lobby']);
  assert.ok(planned.bytes >= 2048);
  assert.ok(fs.existsSync(path.join(dataDir, 'media', 'poster')));

  // Without the confirmation it stays, the way a cleanup list that has gone stale must.
  const unconfirmed = (await admin.post('/api/library/bulk/delete', { ids: ['poster'] })).data;
  assert.equal(unconfirmed.summary, "0 deleted, 1 skipped because it's now in use");
  assert.deepEqual(unconfirmed.results[0].usage.channels.map((c) => c.name), ['Gym', 'Lobby']);
  assert.ok(server.db.get("SELECT 1 AS x FROM media WHERE id = 'poster'"));
  assert.equal(server.db.all('SELECT * FROM playlist_items').length, 2);

  const confirmed = (await admin.post('/api/library/bulk/delete', { ids: ['poster'], inUseConfirmed: ['poster'] })).data;
  assert.equal(confirmed.done, 1);
  assert.ok(!fs.existsSync(path.join(dataDir, 'media', 'poster')));
  assert.equal(server.db.all('SELECT * FROM playlist_items').length, 0);
});

test('bulk actions refuse an empty, oversized, or malformed request without changing anything', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const id = await newText(admin, 'Stays');
  for (const body of [{}, { ids: [] }, { ids: 'nope' }, { ids: Array.from({ length: 5001 }, (_, i) => `x${i}`) }]) {
    assert.equal((await admin.post('/api/library/bulk/delete', body)).status, 400);
    assert.equal((await admin.post('/api/library/bulk/move', body)).status, 400);
  }
  assert.equal((await admin.post('/api/library/bulk/move', { ids: [id], folderId: 12345 })).status, 404);
  assert.equal((await admin.post('/api/library/bulk/tag', { ids: [id] })).status, 400);
  assert.equal((await admin.post('/api/library/bulk/tag', { ids: [id], add: [12345] })).status, 404);
  assert.ok(server.db.get('SELECT 1 AS x FROM media WHERE id = ?', id));
});

test('cleanup offers only unused items, oldest first, and leaves out feeds, overrides, and processing', async (t) => {
  const { base, server, dataDir } = await startServer(t);
  const admin = await setupAdmin(base);
  const gym = await newChannel(admin, 'Gym');
  seedFile(server, dataDir, 'old-unused', Buffer.alloc(4096), { createdAt: 100 });
  seedFile(server, dataDir, 'new-unused', Buffer.alloc(1024), { createdAt: 900 });
  seedFile(server, dataDir, 'failed', Buffer.alloc(512), { createdAt: 500, status: 'failed' });
  seedFile(server, dataDir, 'on-channel', Buffer.alloc(100), { createdAt: 1 });
  seedFile(server, dataDir, 'on-override', Buffer.alloc(100), { createdAt: 2 });
  seedFile(server, dataDir, 'ended-override', Buffer.alloc(256), { createdAt: 700 });
  seedFile(server, dataDir, 'converting', Buffer.alloc(100), { createdAt: 3, status: 'processing', type: 'video', file: 'source.bin' });
  await place(admin, gym, 'on-channel');
  await admin.post('/api/overrides', { mediaId: 'on-override', allChannels: true });
  const ended = (await admin.post('/api/overrides', { mediaId: 'ended-override', allChannels: true })).data;
  await admin.del(`/api/overrides/${ended.id}`);
  await admin.post('/api/live-feeds', { name: 'Feed', input: 'rtmp', port: 22000 + (process.pid % 20000), enabled: false });

  const data = (await admin.get('/api/library/cleanup')).data;
  assert.deepEqual(data.items.map((m) => m.name), ['old-unused', 'failed', 'ended-override', 'new-unused']);
  assert.equal(data.count, 4);
  assert.equal(data.items[0].bytes, 4096);
  assert.equal(data.totalBytes, 4096 + 1024 + 512 + 256);
  assert.equal(server.db.all('SELECT * FROM media').length, 8, 'looking deletes nothing');

  // An item that comes into use after the list loaded is kept by the confirmed delete.
  await place(admin, gym, 'new-unused');
  const result = (await admin.post('/api/library/bulk/delete', { ids: data.items.map((m) => m.id) })).data;
  assert.equal(result.done, 3);
  assert.equal(result.results.find((r) => r.id === 'new-unused').reason, 'inUse');
  assert.ok(server.db.get("SELECT 1 AS x FROM media WHERE id = 'new-unused'"));
  assert.ok(fs.existsSync(path.join(dataDir, 'media', 'new-unused')));
  assert.ok(!fs.existsSync(path.join(dataDir, 'media', 'old-unused')));
});

test('cleanup lists only what someone could delete and needs a library permission', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const coach = await makeUser(admin, base, 'coach', ROLE_IDS.uploader, []);
  await newText(admin, 'Theirs');
  await newText(coach, 'Own');
  assert.deepEqual((await coach.get('/api/library/cleanup')).data.items.map((m) => m.name), ['Own']);
  const role = (await admin.post('/api/roles', { name: 'Viewer', permissions: ['screens.manage'] })).data.id;
  const viewer = await makeUser(admin, base, 'viewer', role);
  assert.equal((await viewer.get('/api/library/cleanup')).status, 403);
  assert.equal((await client(base).get('/api/library/cleanup')).status, 401);
});

test('uploading the same image warns with the existing item, keeps both, and the copy can be discarded', async (t) => {
  const { base, server, dataDir } = await startServer(t);
  const admin = await setupAdmin(base);
  const gym = await newChannel(admin, 'Gym');
  const buf = ffmpegMake(path.join(dataDir, 'a.png'), ['-f', 'lavfi', '-i', 'color=red:size=64x64', '-frames:v', '1']);
  const first = await admin.post('/api/media', form('poster.png', buf, 'image/png'));
  assert.equal(first.status, 200);
  assert.equal(first.data.duplicateOf, null);
  assert.equal(server.db.get('SELECT sha256 FROM media WHERE id = ?', first.data.id).sha256, sha(buf), 'the hash is of the bytes sent');

  const second = await admin.post(`/api/media?channelId=${gym}`, form('copy.png', buf, 'image/png'));
  assert.equal(second.status, 200, 'a match never blocks the upload');
  assert.deepEqual(second.data.duplicateOf, { id: first.data.id, name: 'poster' });
  assert.equal((await waitForMedia(admin, second.data.id)).status, 'ready');
  assert.equal((await waitForMedia(admin, first.data.id)).status, 'ready');

  const different = await admin.post('/api/media', form('dot.png', PNG, 'image/png'));
  assert.equal(different.data.duplicateOf, null);
  await waitForMedia(admin, different.data.id);

  // Discarding is the ordinary delete, and takes only the copy.
  assert.equal((await admin.del(`/api/media/${second.data.id}`)).status, 200);
  assert.equal((await admin.get(`/api/library/${second.data.id}`)).status, 404);
  assert.ok(!fs.existsSync(path.join(dataDir, 'media', second.data.id)));
  assert.equal((await admin.get(`/api/library/${first.data.id}`)).data.status, 'ready');
  assert.ok(fs.existsSync(path.join(dataDir, 'media', first.data.id, first.data.src.split('/').pop())));

  const again = await admin.post('/api/media', form('third.png', buf, 'image/png'));
  assert.equal(again.data.duplicateOf.id, first.data.id, 'the original is still found');
  await waitForMedia(admin, again.data.id);
});

test('a video hash is of the uploaded source, kept after conversion deletes it', async (t) => {
  const { base, server, dataDir } = await startServer(t);
  const admin = await setupAdmin(base);
  const buf = ffmpegMake(path.join(dataDir, 'in.webm'), ['-f', 'lavfi', '-i', 'testsrc=size=160x90:rate=5:duration=1', '-c:v', 'libvpx']);
  const up = await admin.post('/api/media', form('clip.webm', buf, 'video/webm'));
  const m = await waitForMedia(admin, up.data.id);
  assert.equal(m.status, 'ready', m.error);
  assert.ok(!fs.existsSync(path.join(dataDir, 'media', m.id, 'source.bin')));
  assert.equal(server.db.get('SELECT sha256 FROM media WHERE id = ?', m.id).sha256, sha(buf));
  const again = await admin.post('/api/media', form('again.webm', buf, 'video/webm'));
  assert.equal(again.data.duplicateOf.id, m.id, 'the same source is spotted after the first was converted');
  await waitForMedia(admin, again.data.id);
});

test('duplicates ignore failed items and never match PDFs, text, or web items', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const bad = Buffer.from('not really a video');
  const first = await admin.post('/api/media', form('bad.mp4', bad, 'video/mp4'));
  assert.equal((await waitForMedia(admin, first.data.id)).status, 'failed');
  const retry = await admin.post('/api/media', form('bad.mp4', bad, 'video/mp4'));
  assert.equal(retry.data.duplicateOf, null, 'trying again after a failure is not a duplicate');
  await waitForMedia(admin, retry.data.id);

  const pdf = (await admin.post('/api/media/pdf', { name: 'Doc', pages: 1 })).data;
  const text = await newText(admin, 'Note');
  const web = (await admin.post('/api/media/url', { url: 'http://example.com/' })).data;
  for (const id of [pdf.id, text, web.id]) assert.equal(server.db.get('SELECT sha256 FROM media WHERE id = ?', id).sha256, null);
});

test('the background pass hashes older files on its own and a later upload then matches', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-lib-'));
  const server = await createServer({ dataDir, port: 0, host: '127.0.0.1', ops: { fetch: null, discovery: false }, hashBackfillDelayMs: 0 });
  t.after(async () => {
    await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  const image = Buffer.concat([PNG, Buffer.from('older')]);
  const video = Buffer.alloc(600 * 1024, 7);
  seedFile(server, dataDir, 'older-image', image);
  seedFile(server, dataDir, 'older-video', video, { type: 'video', file: 'video.mp4' });
  seedFile(server, dataDir, 'failed-video', Buffer.alloc(10), { type: 'video', file: 'source.bin', status: 'failed' });
  server.db.run("INSERT INTO media (id, type, name, title, created_at) VALUES ('note', 'text', 'Note', 'Note', 1)");
  server.db.run("INSERT INTO media (id, type, name, status, file, created_at) VALUES ('lost', 'image', 'Lost', 'ready', 'image.png', 1)");
  const { port } = await server.start();
  const base = `http://127.0.0.1:${port}`;
  const admin = await setupAdmin(base);

  const hashOf = (id) => server.db.get('SELECT sha256 FROM media WHERE id = ?', id).sha256;
  const end = Date.now() + 20000;
  while ((!hashOf('older-image') || !hashOf('older-video')) && Date.now() < end) await new Promise((r) => setTimeout(r, 50));
  assert.equal(hashOf('older-image'), sha(image));
  assert.equal(hashOf('older-video'), sha(video));
  assert.equal(hashOf('note'), null, 'text has no file');
  assert.equal(hashOf('lost'), null, 'a missing file is left alone');
  assert.equal(hashOf('failed-video'), null, 'a failed item is left alone');

  const up = await admin.post('/api/media', form('new.png', image, 'image/png'));
  assert.equal(up.data.duplicateOf.id, 'older-image');
  await waitForMedia(admin, up.data.id);
});

test('the background pass waits while a video converts, survives deletions, and stops promptly', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-lib-'));
  const db = openDb(path.join(dir, 'signage.db'));
  const seed = (id, bytes) => {
    fs.mkdirSync(path.join(dir, id), { recursive: true });
    fs.writeFileSync(path.join(dir, id, 'image.png'), bytes);
    db.run("INSERT INTO media (id, type, name, file, created_at) VALUES (?, 'image', ?, 'image.png', 1)", id, id);
  };
  seed('a', Buffer.alloc(1024, 1));
  seed('b', Buffer.alloc(1024, 2));
  fs.rmSync(path.join(dir, 'a'), { recursive: true }); // deleted just as the pass reaches it
  let busy = true;
  const pass = createHashBackfill({ db, mediaDir: dir, isBusy: () => busy, startDelayMs: 0, chunkPauseMs: 0, filePauseMs: 0, busyPollMs: 5 });
  const running = pass.run();
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(db.get("SELECT sha256 FROM media WHERE id = 'b'").sha256, null, 'nothing is read during a conversion');
  busy = false;
  assert.equal(await running, 1);
  assert.equal(db.get("SELECT sha256 FROM media WHERE id = 'b'").sha256, sha(Buffer.alloc(1024, 2)));
  assert.equal(db.get("SELECT sha256 FROM media WHERE id = 'a'").sha256, null);
  assert.equal(await pass.run(), 0, 'nothing left, apart from the file that is gone');

  // Stopping in the middle of a large file leaves no half-written hash behind.
  seed('c', Buffer.alloc(4 * 1024 * 1024, 3));
  const slow = createHashBackfill({ db, mediaDir: dir, startDelayMs: 0, chunkPauseMs: 50, filePauseMs: 0 });
  const unfinished = slow.run();
  await new Promise((r) => setTimeout(r, 30));
  await slow.stop();
  await unfinished;
  assert.equal(db.get("SELECT sha256 FROM media WHERE id = 'c'").sha256, null);
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('bulk actions reach a connected TV, and someone with no library permission gets a plain reason', async (t) => {
  const { base, port } = await startServer(t);
  const admin = await setupAdmin(base);
  const gym = (await admin.post('/api/channels', { name: 'Gym' })).data;
  const a = await newText(admin, 'A');
  const b = await newText(admin, 'B');
  const tv = player(port);
  await tv.open;
  t.after(() => tv.close());
  tv.send({ type: 'hello', deviceId: 'device-lib1', slug: gym.slug });
  const isState = (m) => m.type === 'state';
  assert.deepEqual((await tv.next(isState)).slides, []);

  await admin.post('/api/library/bulk/add-to-channel', { ids: [a, b], channelId: gym.id });
  const added = await tv.next((m) => isState(m) && m.slides.length === 2);
  assert.deepEqual(added.slides.map((s) => s.title), ['A', 'B'], 'in the order selected');
  await admin.post('/api/library/bulk/delete', { ids: [a], inUseConfirmed: [a] });
  assert.equal((await tv.next((m) => isState(m) && m.slides.length === 1)).slides[0].title, 'B');

  const role = (await admin.post('/api/roles', { name: 'Live only', permissions: ['live.manage'] })).data.id;
  const liveOnly = await makeUser(admin, base, 'liveonly', role);
  const spare = await newText(admin, 'Spare');
  const refused = await liveOnly.post('/api/library/bulk/delete', { ids: [spare, b] });
  assert.equal(refused.data.summary, "0 deleted, 1 skipped because you don't have permission to change it, 1 skipped because it's used on a channel you don't manage");
  assert.equal((await liveOnly.del(`/api/media/${spare}`)).status, 403);
});

test('deleting a channel or a folder never deletes the library item or its file', async (t) => {
  const { base, server, dataDir } = await startServer(t);
  const admin = await setupAdmin(base);
  const gym = await newChannel(admin, 'Gym');
  seedFile(server, dataDir, 'keep', Buffer.alloc(100));
  await place(admin, gym, 'keep');
  const folder = (await admin.post('/api/folders', { name: 'F' })).data;
  await admin.post('/api/library/bulk/move', { ids: ['keep'], folderId: folder.id });
  await admin.del(`/api/channels/${gym}`);
  await admin.del(`/api/folders/${folder.id}`);
  const row = server.db.get("SELECT folder_id FROM media WHERE id = 'keep'");
  assert.equal(row.folder_id, null);
  assert.ok(fs.existsSync(path.join(dataDir, 'media', 'keep', 'image.png')));
  assert.equal((await admin.get('/api/library/keep')).data.usage.inUse, false);
});

// ---------- channel scope follows backgrounds and overrides ----------

const seedImage = (server, dataDir, id, createdBy = null) => {
  fs.mkdirSync(path.join(dataDir, 'media', id), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'media', id, 'image.png'), PNG);
  server.db.run("INSERT INTO media (id, type, name, status, file, created_by, created_at) VALUES (?, 'image', ?, 'ready', 'image.png', ?, ?)", id, id, createdBy, Date.now());
};

async function scopeWorld(t) {
  const { server, base, dataDir } = await startServer(t);
  const admin = await setupAdmin(base);
  const a = await newChannel(admin, 'A');
  const b = await newChannel(admin, 'B');
  const ed = await makeUser(admin, base, 'ed', ROLE_IDS.editor, [a]);
  return { server, base, dataDir, admin, a, b, ed };
}

test('a picture that is the background of a slide on another channel cannot be deleted or changed by an editor outside it', async (t) => {
  const { server, dataDir, admin, a, b, ed } = await scopeWorld(t);
  for (const id of ['bg-b', 'bg-a', 'bg-both', 'bg-unplaced']) seedImage(server, dataDir, id);
  await admin.post(`/api/media/text?channelId=${b}`, { title: 'On B', style: { image: 'bg-b' } });
  await admin.post(`/api/media/text?channelId=${a}`, { title: 'On A', style: { image: 'bg-a' } });
  await admin.post(`/api/media/text?channelId=${a}`, { title: 'A too', style: { image: 'bg-both' } });
  await admin.post(`/api/media/text?channelId=${b}`, { title: 'B too', style: { image: 'bg-both' } });
  await admin.post('/api/media/text', { title: 'Nowhere', style: { image: 'bg-unplaced' } });

  assert.equal((await ed.del('/api/media/bg-b')).status, 403);
  assert.equal((await ed.patch('/api/media/bg-b', { name: 'Mine now' })).status, 403);
  assert.equal((await ed.del('/api/media/bg-both')).status, 403);
  const dry = await ed.post('/api/library/bulk/delete', { ids: ['bg-b', 'bg-both', 'bg-a'], dryRun: true });
  assert.deepEqual(dry.data.results.map((r) => [r.id, r.ok, r.reason]), [['bg-b', false, 'scope'], ['bg-both', false, 'scope'], ['bg-a', true, undefined]]);
  const bulk = await ed.post('/api/library/bulk/delete', { ids: ['bg-b', 'bg-both'], inUseConfirmed: ['bg-b', 'bg-both'] });
  assert.deepEqual(bulk.data.results.map((r) => r.reason), ['scope', 'scope']);
  const move = await ed.post('/api/library/bulk/move', { ids: ['bg-b'], folderId: null });
  assert.equal(move.data.results[0].reason, 'scope');

  // Only their own channel, or no channel at all: the same as before.
  assert.equal((await ed.patch('/api/media/bg-a', { name: 'Fine' })).status, 200);
  assert.equal((await ed.del('/api/media/bg-unplaced')).status, 200);
  assert.equal((await admin.del('/api/media/bg-b')).status, 200, 'someone with every channel still can');
});

test('what an active override shows cannot be changed by an editor it reaches beyond', async (t) => {
  const { server, dataDir, admin, a, b, ed } = await scopeWorld(t);
  for (const id of ['ov-all', 'ov-b', 'ov-a', 'ov-style', 'ov-ended', 'ov-cleared', 'ov-behind']) seedImage(server, dataDir, id);
  const all = await admin.post('/api/overrides', { mediaId: 'ov-all', allChannels: true });
  assert.equal(all.status, 200, JSON.stringify(all.data));
  await admin.post('/api/overrides', { mediaId: 'ov-b', channelIds: [b] });
  await admin.post('/api/overrides', { mediaId: 'ov-a', channelIds: [a] });
  await admin.post('/api/overrides', { title: 'Quick', style: { image: 'ov-style' }, allChannels: true });
  const ended = await admin.post('/api/overrides', { mediaId: 'ov-ended', allChannels: true });
  server.db.run('UPDATE overrides SET ends_at = 1 WHERE id = ?', ended.data.id);
  const cleared = await admin.post('/api/overrides', { mediaId: 'ov-cleared', allChannels: true });
  assert.equal((await admin.del(`/api/overrides/${cleared.data.id}`)).status, 200);

  const slide = (await admin.post('/api/media/text', { title: 'Shown', style: { image: 'ov-behind' } })).data;
  await admin.post('/api/overrides', { mediaId: slide.id, allChannels: true });
  const text = (await admin.post('/api/media/text', { title: 'All of them' })).data;
  await admin.post('/api/overrides', { mediaId: text.id, allChannels: true });
  const active = () => server.db.get('SELECT COUNT(*) AS n FROM overrides WHERE cleared_at IS NULL AND (ends_at IS NULL OR ends_at > ?)', Date.now()).n;
  const before = active();

  for (const id of ['ov-all', 'ov-b', 'ov-style', 'ov-behind', slide.id, text.id]) {
    assert.equal((await ed.del(`/api/media/${id}`)).status, 403, id);
    const r = await ed.post('/api/library/bulk/delete', { ids: [id], inUseConfirmed: [id] });
    assert.equal(r.data.results[0].reason, 'scope', id);
  }
  assert.equal((await ed.patch(`/api/media/${text.id}`, { title: 'Changed on every screen' })).status, 403);
  assert.equal(active(), before, 'nothing was removed');

  // An override on their own channel is theirs to affect, and one that's over no longer counts.
  assert.equal((await ed.del('/api/media/ov-a')).status, 200);
  assert.equal((await ed.del('/api/media/ov-ended')).status, 200);
  assert.equal((await ed.del('/api/media/ov-cleared')).status, 200);
  assert.equal((await admin.del('/api/media/ov-all')).status, 200, 'someone with every channel still can');
});

// ---------- deleting on Windows, where a file can stay busy ----------

const POSIX_USER = process.platform !== 'win32' && process.getuid?.() !== 0;

test('a folder that cannot be removed: the item still deletes with a warning, and the next start sweeps the folder', { skip: !POSIX_USER }, async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-sweep-'));
  atEnd(t, () => fs.rmSync(dataDir, { recursive: true, force: true }));
  const boot = async () => {
    const server = await createServer({ dataDir, port: 0, host: '127.0.0.1', ops: { fetch: null, discovery: false }, hashBackfillDelayMs: 1e8 });
    const { port } = await server.start();
    return { server, base: `http://127.0.0.1:${port}` };
  };
  const first = await boot();
  const mediaDir = path.join(dataDir, 'media');
  const admin = await setupAdmin(first.base);
  const stuck = '11111111-2222-4333-8444-555555555555';
  const keeper = '11111111-2222-4333-8444-666666666666';
  seedImage(first.server, dataDir, stuck);
  seedImage(first.server, dataDir, keeper);
  fs.chmodSync(mediaDir, 0o555); // nothing directly inside can be removed now
  atEnd(t, () => {
    try { fs.chmodSync(mediaDir, 0o755); } catch {}
  });
  try {
    const single = await admin.del(`/api/media/${stuck}`);
    assert.equal(single.status, 200, JSON.stringify(single.data));
  } finally {
    fs.chmodSync(mediaDir, 0o755);
  }
  assert.equal(first.server.db.get('SELECT 1 AS x FROM media WHERE id = ?', stuck), undefined, 'the item is gone');
  assert.equal(fs.existsSync(path.join(mediaDir, stuck)), true, 'the folder stayed behind');
  await first.server.stop();

  const second = await boot();
  atEnd(t, () => second.server.stop());
  assert.equal(fs.existsSync(path.join(mediaDir, stuck)), false, 'swept');
  assert.equal(fs.existsSync(path.join(mediaDir, keeper, 'image.png')), true, 'an item with a row stays');
});

test('the sweep only removes folders that look like a UUID, have no row, and only when nothing is restoring', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-sweep-'));
  atEnd(t, () => fs.rmSync(dataDir, { recursive: true, force: true }));
  const mediaDir = path.join(dataDir, 'media');
  const boot = async () => {
    const server = await createServer({ dataDir, port: 0, host: '127.0.0.1', ops: { fetch: null, discovery: false }, hashBackfillDelayMs: 1e8 });
    await server.start();
    return server;
  };
  const orphan = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
  const others = ['branding', 'fx', 'not-a-uuid', 'BBBBBBBB-CCCC-4DDD-8EEE-FFFFFFFFFFFF', 'seeded'];
  for (const name of [orphan, ...others]) {
    fs.mkdirSync(path.join(mediaDir, name), { recursive: true });
    fs.writeFileSync(path.join(mediaDir, name, 'keep.txt'), 'x');
  }
  const seed = openDb(path.join(dataDir, 'signage.db'));
  seed.run("INSERT INTO media (id, type, name, created_at) VALUES ('seeded', 'text', 'x', 1)");
  seed.close();

  // A restore that gets stopped at startup: the boot that deals with it sweeps nothing.
  const restoreDir = path.join(dataDir, '.restore');
  fs.mkdirSync(restoreDir, { recursive: true });
  fs.writeFileSync(path.join(restoreDir, 'restore.json'), JSON.stringify({ id: 'x', stagingName: 'upload-gone', firstRun: false, phase: 'pending' }));
  let server = await boot();
  await server.stop();
  assert.equal(fs.existsSync(path.join(mediaDir, orphan, 'keep.txt')), true, 'a restore was in the picture, so nothing is swept');

  // Now a normal start.
  server = await boot();
  await server.stop();
  assert.equal(fs.existsSync(path.join(mediaDir, orphan)), false);
  for (const name of others) assert.equal(fs.existsSync(path.join(mediaDir, name, 'keep.txt')), true, name);

  // A plain file with a UUID's name is not a folder, so it's left alone too.
  fs.writeFileSync(path.join(mediaDir, orphan), 'x');
  server = await boot();
  await server.stop();
  assert.equal(fs.existsSync(path.join(mediaDir, orphan)), true);
});

test('a database with no library at all never empties the media folder, because that database may be the wrong one', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-sweep-'));
  atEnd(t, () => fs.rmSync(dataDir, { recursive: true, force: true }));
  const folder = path.join(dataDir, 'media', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, 'image.png'), PNG);
  const server = await createServer({ dataDir, port: 0, host: '127.0.0.1', ops: { fetch: null, discovery: false }, hashBackfillDelayMs: 1e8 });
  await server.start();
  await server.stop();
  assert.equal(fs.existsSync(path.join(folder, 'image.png')), true);
});

// ---------- conversions keep going ----------

test('a folder that cannot be removed after an item is deleted mid-conversion does not stop later conversions', { skip: !POSIX_USER }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-drain-'));
  atEnd(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  const mediaDir = path.join(dir, 'media');
  fs.mkdirSync(mediaDir);
  const flag = path.join(dir, 'hold');
  fs.writeFileSync(flag, '');
  const ffmpeg = path.join(dir, 'ffmpeg');
  fs.writeFileSync(ffmpeg, `#!/bin/sh\nwhile [ -e "${flag}" ]; do sleep 0.02; done\nexit 1\n`);
  fs.chmodSync(ffmpeg, 0o755);
  const db = openDb(path.join(dir, 'signage.db'));
  atEnd(t, () => db.close());
  const add = (id) => {
    fs.mkdirSync(path.join(mediaDir, id));
    fs.writeFileSync(path.join(mediaDir, id, 'image.png'), PNG);
    db.run("INSERT INTO media (id, type, name, status, file, created_at) VALUES (?, 'image', ?, 'processing', 'image.png', 1)", id, id);
  };
  add('first');
  add('second');
  const warnings = [];
  const log = { error() {}, warn: (o, m) => warnings.push(m) };
  const processor = createProcessor({ db, hub: { pushMedia() {}, adminRefresh() {} }, mediaDir, ffmpeg, log });
  processor.enqueue('first');
  processor.enqueue('second');
  db.run("DELETE FROM media WHERE id = 'first'");
  fs.chmodSync(mediaDir, 0o555);
  atEnd(t, () => {
    try { fs.chmodSync(mediaDir, 0o755); } catch {}
  });
  fs.rmSync(flag);
  const end = Date.now() + 30000;
  while (processor.busy() && Date.now() < end) await new Promise((r) => setTimeout(r, 20));
  fs.chmodSync(mediaDir, 0o755);
  assert.equal(processor.busy(), false, 'a stuck busy flag refuses every backup until a restart');
  assert.equal(db.get("SELECT status FROM media WHERE id = 'second'").status, 'failed', 'the next item got its turn');
  assert.ok(warnings.some((m) => /could not remove/i.test(m)), JSON.stringify(warnings));
});
