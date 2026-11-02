import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from '../server/index.js';
import { isValid, isValidMs, resolve, speedName, SPEEDS } from '../server/transitions.js';
import { startServer, setupAdmin, client, player } from './helpers.js';

const isState = (m) => m.type === 'state';

async function placement(admin, title = 'Item', channelId = 1) {
  const media = await admin.post('/api/media/text', { title });
  const items = await admin.post(`/api/channels/${channelId}/items`, { mediaId: media.data.id });
  return items.data[items.data.length - 1];
}

async function tv(t, port, slug = 'main') {
  const p = player(port);
  await p.open;
  t.after(() => p.close());
  p.send({ type: 'hello', preview: true, slug });
  await p.next(isState);
  return p;
}

async function signedInWith(admin, base, username, permissions) {
  const role = await admin.post('/api/roles', { name: `${username} role`, permissions });
  assert.equal(role.status, 200, JSON.stringify(role.data));
  const user = await admin.post('/api/users', { username, name: username, password: 'password-1', roleId: role.data.id });
  assert.equal(user.status, 200, JSON.stringify(user.data));
  const c = client(base);
  await c.post('/api/login', { username, password: 'password-1' });
  return { c, id: user.data.id };
}

// ---------- which transition plays ----------

test('the item setting wins, then a slide or cut chosen in 1.0, then the channel default, then the original column', () => {
  const channel = { style: 'zoom', ms: 1400 };
  assert.deepEqual(resolve({ style: 'wipe-up', ms: 350 }, channel, 'slide'), { style: 'wipe-up', ms: 350 });
  assert.deepEqual(resolve({ style: null, ms: null }, channel, 'slide'), { style: 'slide', ms: 1400 }, 'an explicit 1.0 choice is kept');
  assert.deepEqual(resolve({ style: null, ms: null }, channel, 'cut'), { style: 'cut', ms: 1400 }, 'an explicit 1.0 choice is kept');
  assert.deepEqual(resolve({ style: null, ms: null }, channel, 'fade'), { style: 'zoom', ms: 1400 }, 'fade was the old default, so it follows the channel');
  assert.deepEqual(resolve({ style: null, ms: null }, { style: null, ms: null }, 'slide'), { style: 'slide', ms: 700 });
});

test('style and speed are inherited separately', () => {
  const channel = { style: 'zoom', ms: 1400 };
  assert.deepEqual(resolve({ style: 'cut', ms: null }, channel, 'fade'), { style: 'cut', ms: 1400 });
  assert.deepEqual(resolve({ style: null, ms: 350 }, channel, 'fade'), { style: 'zoom', ms: 350 });
  assert.deepEqual(resolve({ style: null, ms: 350 }, null, 'cut'), { style: 'cut', ms: 350 });
});

test('with no settings at all, an item gets the fade it always had', () => {
  assert.deepEqual(resolve({ style: null, ms: null }, { style: null, ms: null }, 'fade'), { style: 'fade', ms: 700 });
  assert.deepEqual(resolve(null, null, undefined), { style: 'fade', ms: 700 });
});

test('values that should never be stored are skipped, not played', () => {
  assert.deepEqual(resolve({ style: 'spin', ms: 99999 }, { style: 'constructor', ms: 'fast' }, 'slide'), { style: 'slide', ms: 700 });
  assert.deepEqual(resolve({ style: 'push', ms: 199 }, { style: 'wipe', ms: 2001 }, 'bogus'), { style: 'fade', ms: 700 });
});

test('the names and durations on offer', () => {
  for (const s of ['cut', 'fade', 'slide', 'zoom', 'push-left', 'push-right', 'push-up', 'push-down', 'wipe-left', 'wipe-right', 'wipe-up', 'wipe-down']) {
    assert.equal(isValid(s), true, s);
  }
  for (const s of ['push', 'wipe', 'slide-up', 'zoom-in', 'PUSH-LEFT', '', null, undefined, 3, ['fade'], 'toString', '__proto__']) {
    assert.equal(isValid(s), false, String(s));
  }
  for (const ms of Object.values(SPEEDS)) assert.equal(isValidMs(ms), true);
  assert.equal(SPEEDS.normal, 700, 'normal is the speed everything already runs at');
  assert.equal(speedName(1400), 'slow');
  assert.equal(speedName(null), null);
  assert.equal(speedName(123), null);
});

// ---------- API ----------

test('an item accepts every transition and speed, and can go back to following the channel', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const item = await placement(admin);
  assert.equal(item.transitionStyle, null, 'new items have no setting of their own');
  assert.equal(item.transitionSpeed, null);

  let r = await admin.patch(`/api/playlist-items/${item.id}`, { transitionStyle: 'wipe-left', transitionSpeed: 'slow' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.transitionStyle, 'wipe-left');
  assert.equal(r.data.transitionSpeed, 'slow');
  assert.deepEqual(r.data.effectiveTransition, { style: 'wipe-left', ms: 1400 });
  assert.equal(r.data.transition, 'fade', 'the original column keeps a value its check allows');

  r = await admin.patch(`/api/playlist-items/${item.id}`, { duration: 9 });
  assert.equal(r.data.transitionStyle, 'wipe-left', 'fields left out keep their value');
  assert.equal(r.data.transitionSpeed, 'slow');

  r = await admin.patch(`/api/playlist-items/${item.id}`, { transitionStyle: null, transitionSpeed: '' });
  assert.equal(r.data.transitionStyle, null);
  assert.equal(r.data.transitionSpeed, null);
  assert.deepEqual(r.data.effectiveTransition, { style: 'fade', ms: 700 });
});

test('bad transitions and speeds are refused in plain words, and nothing changes', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const item = await placement(admin);
  const cases = [
    [{ transitionStyle: 'spin' }, /transition from the list/],
    [{ transitionStyle: 'constructor' }, /transition from the list/],
    [{ transitionStyle: 5 }, /transition from the list/],
    [{ transitionStyle: ['fade'] }, /transition from the list/],
    [{ transitionStyle: 'push' }, /direction/],
    [{ transitionStyle: 'wipe' }, /direction/],
    [{ transitionStyle: 'slide-up' }, /transition from the list/],
    [{ transitionSpeed: 'warp' }, /fast, normal, or slow/],
    [{ transitionSpeed: 700 }, /fast, normal, or slow/],
    [{ transitionSpeed: 'constructor' }, /fast, normal, or slow/],
    [{ transition: 'push-left' }, /transition from the list/],
    [{ duration: 5, transitionStyle: 'fade', transitionSpeed: 'warp' }, /fast, normal, or slow/],
  ];
  for (const [body, message] of cases) {
    const r = await admin.patch(`/api/playlist-items/${item.id}`, body);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, message);
  }
  const row = server.db.get('SELECT duration, transition, transition_style, transition_ms FROM playlist_items WHERE id = ?', item.id);
  assert.deepEqual({ ...row }, { duration: null, transition: 'fade', transition_style: null, transition_ms: null });

  const channel = await admin.patch('/api/channels/1', { defaultTransitionStyle: 'spin' });
  assert.equal(channel.status, 400);
  assert.match(channel.data.error, /transition from the list/);
  assert.equal((await admin.patch('/api/channels/1', { defaultTransitionSpeed: 'warp' })).status, 400);
  assert.equal((await admin.patch('/api/channels/1', { name: 'Kept out', defaultTransitionSpeed: 'warp' })).status, 400);
  assert.equal(server.db.get('SELECT name FROM channels WHERE id = 1').name, 'Main', 'a refused change saves nothing');
});

test('the original transition field still works and wins over the channel default', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const item = await placement(admin);
  await admin.patch('/api/channels/1', { defaultTransitionStyle: 'zoom' });
  const r = await admin.patch(`/api/playlist-items/${item.id}`, { transition: 'slide' });
  assert.equal(r.status, 200);
  assert.equal(r.data.transition, 'slide');
  assert.equal(r.data.effectiveTransition.style, 'slide');
});

test('items follow the channel default as it changes, unless they have their own', async (t) => {
  const { base, port } = await startServer(t);
  const admin = await setupAdmin(base);
  const follower = await placement(admin, 'Follows');
  const own = await placement(admin, 'Own');
  await admin.patch(`/api/playlist-items/${own.id}`, { transitionStyle: 'cut' });
  const p = await tv(t, port);

  const styles = (msg) => Object.fromEntries(msg.slides.map((s) => [s.name, [s.transition, s.transitionMs]]));

  let r = await admin.patch('/api/channels/1', { defaultTransitionStyle: 'push-up', defaultTransitionSpeed: 'fast' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.defaultTransitionStyle, 'push-up');
  assert.equal(r.data.defaultTransitionSpeed, 'fast');
  assert.equal(r.data.name, 'Main', 'setting a default leaves the name alone');
  assert.deepEqual(styles(await p.next(isState)), { Follows: ['push-up', 350], Own: ['cut', 350] }, 'the TV is told right away');

  const late = await placement(admin, 'Added later');
  assert.equal(late.transitionStyle, null);
  assert.deepEqual(late.effectiveTransition, { style: 'push-up', ms: 350 }, 'a new item starts out on the default');
  await p.next(isState);

  await admin.patch('/api/channels/1', { defaultTransitionStyle: 'zoom' });
  assert.deepEqual(styles(await p.next(isState)), { Follows: ['zoom', 350], Own: ['cut', 350], 'Added later': ['zoom', 350] }, 'a later change reaches them');

  const rows = (await admin.get('/api/channels/1/items')).data;
  const row = rows.find((i) => i.id === follower.id);
  assert.deepEqual(row.effectiveTransition, { style: 'zoom', ms: 350 });
  assert.deepEqual(row.inheritedTransition, { style: 'zoom', ms: 350 });
  const channel = (await admin.get('/api/channels')).data.find((c) => c.id === 1);
  assert.equal(channel.defaultTransitionStyle, 'zoom');
  assert.equal(channel.defaultTransitionSpeed, 'fast');

  await admin.patch('/api/channels/1', { defaultTransitionStyle: null, defaultTransitionSpeed: null });
  assert.deepEqual(styles(await p.next(isState)), { Follows: ['fade', 700], Own: ['cut', 700], 'Added later': ['fade', 700] }, 'clearing goes back to the fade');
});

test('state messages carry the transition, on every page of a PDF too', async (t) => {
  const { base, port, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const item = await placement(admin, 'Words');
  await admin.patch(`/api/playlist-items/${item.id}`, { transitionStyle: 'wipe-down', transitionSpeed: 'slow' });
  const pdf = await admin.post('/api/media/pdf', { name: 'Doc', pages: 2 });
  server.db.run("UPDATE media SET status = 'ready' WHERE id = ?", pdf.data.id);
  const items = (await admin.post('/api/channels/1/items', { mediaId: pdf.data.id })).data;
  await admin.patch(`/api/playlist-items/${items[1].id}`, { transitionStyle: 'push-right', transitionSpeed: 'fast' });

  const p = player(port);
  await p.open;
  t.after(() => p.close());
  p.send({ type: 'hello', preview: true, slug: 'main' });
  const { slides } = await p.next(isState);
  assert.deepEqual(slides.map((s) => [s.type, s.transition, s.transitionMs]), [
    ['text', 'wipe-down', 1400],
    ['image', 'push-right', 350],
    ['image', 'push-right', 350],
  ]);
});

test('overrides stay on cut, whatever the channel default says', async (t) => {
  const { base, port } = await startServer(t);
  const admin = await setupAdmin(base);
  const media = await admin.post('/api/media/text', { title: 'Storm' });
  await admin.post('/api/channels/1/items', { mediaId: media.data.id });
  await admin.patch('/api/channels/1', { defaultTransitionStyle: 'zoom', defaultTransitionSpeed: 'slow' });
  const p = await tv(t, port);

  await admin.post('/api/overrides', { mediaId: media.data.id, allChannels: true });
  let msg = await p.next((m) => isState(m) && m.override);
  assert.deepEqual(msg.override.slides.map((s) => s.transition), ['cut']);

  await admin.post('/api/overrides', { title: 'Typed message', allChannels: true });
  msg = await p.next((m) => isState(m) && m.override?.slides[0].title === 'Typed message');
  assert.deepEqual(msg.override.slides.map((s) => s.transition), ['cut']);
  assert.equal(msg.slides[0].transition, 'zoom', 'the playlist behind it keeps its own');
});

// ---------- permissions ----------

test('the channel default needs channels.edit on that channel, and renaming still needs channels.manage', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const other = (await admin.post('/api/channels', { name: 'Other' })).data.id;

  const { c: editor, id: editorId } = await signedInWith(admin, base, 'editor1', ['channels.edit']);
  await admin.patch(`/api/users/${editorId}`, { channelIds: [1] });
  const { c: manager } = await signedInWith(admin, base, 'manager1', ['channels.manage', 'channels.all']);
  const { c: both } = await signedInWith(admin, base, 'both1', ['channels.manage', 'channels.edit', 'channels.all']);
  const { c: nobody } = await signedInWith(admin, base, 'nobody1', ['channels.all', 'channels.add']);

  const setDefault = { defaultTransitionStyle: 'zoom' };
  assert.equal((await editor.patch('/api/channels/1', setDefault)).status, 200, 'an editor assigned to the channel can');
  assert.equal((await editor.patch(`/api/channels/${other}`, setDefault)).status, 403, 'but not on a channel they are not assigned to');
  assert.equal((await editor.patch('/api/channels/1', { name: 'Renamed' })).status, 403, 'and an editor still cannot rename');
  assert.equal((await editor.patch('/api/channels/1', { name: 'Renamed', ...setDefault })).status, 403, 'not even with a default in the same request');
  assert.equal((await editor.patch('/api/channels/1', {})).status, 403, 'an empty request is treated as a rename');
  assert.equal((await manager.patch('/api/channels/1', setDefault)).status, 403, 'rename rights alone do not cover it');
  assert.equal((await manager.patch('/api/channels/1', { name: 'Renamed' })).status, 200);
  assert.equal((await manager.patch('/api/channels/1', { name: 'Again', ...setDefault })).status, 403, 'a mixed request needs both');
  assert.equal((await both.patch('/api/channels/1', { name: 'Both', defaultTransitionStyle: 'cut' })).data.defaultTransitionStyle, 'cut');
  assert.equal((await nobody.patch('/api/channels/1', setDefault)).status, 403);
  assert.equal((await client(base).patch('/api/channels/1', setDefault)).status, 401);
  assert.equal((await editor.patch('/api/channels/999', setDefault)).status, 404);

  assert.equal((await editor.patch('/api/channels/1', { defaultTransitionSpeed: 'fast' })).data.name, 'Both', 'editor saves do not disturb the name');
});

// ---------- upgrading ----------

test('a 1.0.2 database upgrades in place, and its items behave as before', async (t) => {
  const sql = execFileSync('git', ['show', 'v1.0.2:server/db.js'], { encoding: 'utf8' }).match(/const SCHEMA = `([\s\S]*?)`;/)[1];
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-trans-'));
  const raw = new DatabaseSync(path.join(dataDir, 'signage.db'));
  raw.exec(sql);
  raw.exec('PRAGMA user_version = 1');
  raw.exec(`INSERT INTO channels (slug, name, created_at) VALUES ('gym', 'Gym', 1);
    INSERT INTO media (id, type, name, title, created_at) VALUES ('m1', 'text', 'Default', 'A', 1), ('m2', 'text', 'Fades', 'B', 1), ('m3', 'text', 'Slides', 'C', 1), ('m4', 'text', 'Cuts', 'D', 1);
    INSERT INTO playlist_items (channel_id, media_id, position) VALUES (1, 'm1', 0);
    INSERT INTO playlist_items (channel_id, media_id, position, duration, transition, audio) VALUES (1, 'm2', 1, 7, 'fade', 1), (1, 'm3', 2, 8, 'slide', 0), (1, 'm4', 3, 9, 'cut', 0);`);
  const tableSql = () => raw.prepare("SELECT sql FROM sqlite_master WHERE name = 'playlist_items'").get().sql;
  const before = tableSql();
  raw.close();

  const server = await createServer({ dataDir, port: 0, host: '127.0.0.1', ops: { fetch: null, discovery: false } });
  const { port } = await server.start();
  t.after(async () => {
    await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const rows = server.db.all('SELECT media_id, position, duration, transition, audio, transition_style, transition_ms FROM playlist_items ORDER BY position');
  assert.deepEqual(rows.map((r) => ({ ...r })), [
    { media_id: 'm1', position: 0, duration: null, transition: 'fade', audio: 0, transition_style: null, transition_ms: null },
    { media_id: 'm2', position: 1, duration: 7, transition: 'fade', audio: 1, transition_style: null, transition_ms: null },
    { media_id: 'm3', position: 2, duration: 8, transition: 'slide', audio: 0, transition_style: null, transition_ms: null },
    { media_id: 'm4', position: 3, duration: 9, transition: 'cut', audio: 0, transition_style: null, transition_ms: null },
  ], 'every item survives with nothing changed');
  const channel = server.db.get('SELECT slug, default_transition_style, default_transition_ms FROM channels');
  assert.deepEqual({ ...channel }, { slug: 'gym', default_transition_style: null, default_transition_ms: null });
  const { sql: after } = server.db.get("SELECT sql FROM sqlite_master WHERE name = 'playlist_items'");
  assert.ok(after.startsWith(before.slice(0, -1).trimEnd()), 'the table was added to, not rebuilt');
  assert.match(after, /CHECK \(transition IN \('cut','fade','slide'\)\)/);
  assert.throws(() => server.db.run("UPDATE playlist_items SET transition = 'zoom'"), /CHECK/, 'the original column still only holds its three values');

  const p = player(port);
  await p.open;
  t.after(() => p.close());
  p.send({ type: 'hello', preview: true, slug: 'gym' });
  const { slides } = await p.next(isState);
  assert.deepEqual(slides.map((s) => [s.name, s.transition, s.transitionMs]), [
    ['Default', 'fade', 700],
    ['Fades', 'fade', 700],
    ['Slides', 'slide', 700],
    ['Cuts', 'cut', 700],
  ]);
});
