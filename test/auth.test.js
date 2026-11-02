import test from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, setupAdmin, makeEditor } from './helpers.js';
import { isLocalAddress } from '../server/lan.js';

test('first-run wizard creates one admin and then locks', async (t) => {
  const { base } = await startServer(t);
  const anon = client(base);
  assert.equal((await anon.get('/api/setup/status')).data.needsSetup, true);
  assert.equal((await anon.get('/api/channels')).status, 401);
  assert.equal((await anon.post('/api/setup', { orgName: 'X', name: 'A', username: 'a', password: 'short' })).status, 400);
  const admin = await setupAdmin(base);
  assert.equal((await admin.get('/api/me')).data.role, 'admin');
  assert.equal((await anon.get('/api/setup/status')).data.needsSetup, false);
  assert.equal((await anon.post('/api/setup', { orgName: 'X', name: 'A', username: 'b', password: 'long enough pw' })).status, 409);
  assert.equal((await anon.get('/api/branding')).data.orgName, 'Test Org');
  const channels = (await admin.get('/api/channels')).data;
  assert.equal(channels.length, 1, 'ships with one default channel');
});

test('sign-in rejects bad passwords and rate limits', async (t) => {
  const { base } = await startServer(t);
  await setupAdmin(base);
  const c = client(base);
  for (let i = 0; i < 10; i++) {
    assert.equal((await c.post('/api/login', { username: 'ada', password: 'wrong' })).status, 401);
  }
  assert.equal((await c.post('/api/login', { username: 'ada', password: 'correct horse' })).status, 429);
});

test('editors only touch assigned channels; override is a separate flag', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const mine = (await admin.post('/api/channels', { name: 'Gym Lobby' })).data;
  const other = (await admin.post('/api/channels', { name: 'Cafeteria' })).data;
  assert.equal(mine.slug, 'gym-lobby');
  const ed = await makeEditor(admin, base, 'ed', { channelIds: [mine.id] });

  // Admin-only surfaces
  assert.equal((await ed.get('/api/users')).status, 403);
  assert.equal((await ed.post('/api/channels', { name: 'Nope' })).status, 403);
  assert.equal((await ed.put('/api/branding', { orgName: 'Nope' })).status, 403);
  assert.equal((await ed.post('/api/pair', { code: '1234', channelId: mine.id })).status, 403);

  // Content on own channel works, on another channel does not
  const item = (await ed.post('/api/media/text', { title: 'Hello', body: 'World' })).data;
  assert.equal((await ed.post(`/api/channels/${mine.id}/items`, { mediaId: item.id })).status, 200);
  assert.equal((await ed.post(`/api/channels/${other.id}/items`, { mediaId: item.id })).status, 403);
  assert.equal((await ed.get(`/api/channels/${other.id}/items`)).status, 403);
  assert.equal((await ed.post(`/api/media/text?channelId=${other.id}`, { title: 'x' })).status, 403);

  // Once the shared item is on someone else's channel, the editor cannot change it
  assert.equal((await ed.patch(`/api/media/${item.id}`, { title: 'Edited' })).status, 200);
  await admin.post(`/api/channels/${other.id}/items`, { mediaId: item.id });
  assert.equal((await ed.patch(`/api/media/${item.id}`, { title: 'Again' })).status, 403);
  assert.equal((await ed.del(`/api/media/${item.id}`)).status, 403);

  // Override needs the flag
  const o = { title: 'Fire drill', allChannels: true };
  assert.equal((await ed.post('/api/overrides', o)).status, 403);
  const { id } = (await ed.get('/api/me')).data;
  await admin.patch(`/api/users/${id}`, { canOverride: true });
  const created = await ed.post('/api/overrides', o);
  assert.equal(created.status, 200);
  assert.equal((await ed.del(`/api/overrides/${created.data.id}`)).status, 200);
});

test('the last admin cannot be removed or demoted', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const me = (await admin.get('/api/me')).data;
  assert.equal((await admin.patch(`/api/users/${me.id}`, { role: 'editor' })).status, 400);
  assert.equal((await admin.del(`/api/users/${me.id}`)).status, 400);
});

test('cross-site writes are refused', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const r = await admin.post('/api/channels', { name: 'Evil' }, { origin: 'http://evil.example' });
  assert.equal(r.status, 403);
});

test('LAN filter accepts private ranges and refuses public ones', () => {
  for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.1', '192.168.1.5', '169.254.1.1', '::1', '::ffff:192.168.1.5', 'fd00::1', 'fe80::1%en0']) {
    assert.equal(isLocalAddress(ip), true, ip);
  }
  for (const ip of ['8.8.8.8', '172.32.0.1', '192.169.0.1', '::ffff:8.8.8.8', '2001:4860::1', '']) {
    assert.equal(isLocalAddress(ip), false, ip);
  }
});
