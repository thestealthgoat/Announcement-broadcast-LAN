import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as acorn from 'acorn';
import { startServer, setupAdmin, player } from './helpers.js';
import { toSlides } from '../server/hub.js';

const isState = (m) => m.type === 'state';

async function tv(port, hello) {
  const p = player(port);
  await p.open;
  p.send({ type: 'hello', ...hello });
  return p;
}

test('playlist edits reach a playing TV over the socket with no refresh', async (t) => {
  const { base, port } = await startServer(t);
  const admin = await setupAdmin(base);
  const [main] = (await admin.get('/api/channels')).data;
  const p = await tv(port, { deviceId: 'device-aaaa', slug: main.slug });
  t.after(() => p.close());
  assert.deepEqual((await p.next(isState)).slides, []);

  const a = (await admin.post('/api/media/text', { title: 'A', body: 'first' })).data;
  const b = (await admin.post('/api/media/text', { title: 'B' })).data;
  await admin.post(`/api/channels/${main.id}/items`, { mediaId: a.id });
  let s = await p.next((m) => isState(m) && m.slides.length === 1);
  assert.equal(s.slides[0].title, 'A');
  assert.equal(s.slides[0].audio, false, 'audio defaults off');
  assert.equal(s.slides[0].duration, 10);

  const items = (await admin.post(`/api/channels/${main.id}/items`, { mediaId: b.id })).data;
  await p.next((m) => isState(m) && m.slides.length === 2);

  await admin.put(`/api/channels/${main.id}/order`, { ids: [items[1].id, items[0].id] });
  s = await p.next((m) => isState(m) && m.slides[0].title === 'B');

  await admin.patch(`/api/playlist-items/${items[1].id}`, { enabled: false });
  s = await p.next((m) => isState(m) && m.slides.length === 1);
  assert.equal(s.slides[0].title, 'A');

  await admin.patch(`/api/media/${a.id}`, { title: 'A2' });
  s = await p.next((m) => isState(m) && m.slides[0]?.title === 'A2');

  assert.equal((await admin.put(`/api/channels/${main.id}/order`, { ids: [items[0].id] })).status, 400);
});

test('pairing: TV shows a code, admin assigns it, and it remembers', async (t) => {
  const { base, port } = await startServer(t);
  const admin = await setupAdmin(base);
  const [main] = (await admin.get('/api/channels')).data;
  const p = await tv(port, { deviceId: 'device-bbbb' });
  t.after(() => p.close());
  const { code } = await p.next((m) => m.type === 'pair');
  assert.match(code, /^\d{4}$/);

  assert.equal((await admin.post('/api/pair', { code: '0000', channelId: main.id })).status, 404);
  assert.equal((await admin.post('/api/pair', { code, channelId: main.id, name: 'Lobby TV' })).status, 200);
  assert.equal((await p.next((m) => m.type === 'assign')).slug, main.slug);

  const p2 = await tv(port, { deviceId: 'device-bbbb' });
  t.after(() => p2.close());
  assert.equal((await p2.next((m) => m.type === 'assign')).slug, main.slug, 'remembers after reconnecting');

  // Heartbeat shows on the dashboard
  const p3 = await tv(port, { deviceId: 'device-bbbb', slug: main.slug });
  t.after(() => p3.close());
  await p3.next(isState);
  p3.send({ type: 'hb', item: 'Lunch menu' });
  await new Promise((r) => setTimeout(r, 100));
  const [screen] = (await admin.get('/api/screens')).data;
  assert.equal(screen.name, 'Lobby TV');
  assert.equal(screen.online, true);
  assert.equal(screen.currentItem, 'Lunch menu');
  assert.equal(screen.pairCode, null);

  // Deleting the channel sends the TV back to pairing
  const extra = (await admin.post('/api/channels', { name: 'Temp' })).data;
  await admin.patch(`/api/screens/${screen.id}`, { channelId: extra.id });
  assert.equal((await p3.next((m) => m.type === 'assign')).slug, extra.slug);
  await admin.del(`/api/channels/${extra.id}`);
  await p3.next((m) => m.type === 'unassign');
  const p4 = await tv(port, { deviceId: 'device-bbbb' });
  t.after(() => p4.close());
  assert.match((await p4.next((m) => m.type === 'pair')).code, /^\d{4}$/);
});

test('override hits selected channels, ends on a timer, and clears on demand', async (t) => {
  const { base, port } = await startServer(t);
  const admin = await setupAdmin(base);
  const [main] = (await admin.get('/api/channels')).data;
  const gym = (await admin.post('/api/channels', { name: 'Gym' })).data;
  const a = await tv(port, { deviceId: 'device-cccc', slug: main.slug });
  const b = await tv(port, { deviceId: 'device-dddd', slug: gym.slug });
  t.after(() => { a.close(); b.close(); });
  await a.next(isState);
  await b.next(isState);

  const o = (await admin.post('/api/overrides', { title: 'Storm', body: 'Go inside', channelIds: [gym.id] })).data;
  const hit = await b.next((m) => isState(m) && m.override);
  assert.equal(hit.override.slides[0].title, 'Storm');
  assert.equal(hit.override.remainingMs, null);
  assert.equal((await a.next(isState)).override, null, 'other channels are untouched');
  assert.equal((await admin.get('/api/overrides')).data.length, 1);

  await admin.del(`/api/overrides/${o.id}`);
  await b.next((m) => isState(m) && !m.override);
  assert.equal((await admin.get('/api/overrides')).data.length, 0);

  await admin.post('/api/overrides', { title: 'Short', allChannels: true, minutes: 0.01 });
  const timed = await a.next((m) => isState(m) && m.override);
  assert.ok(timed.override.remainingMs > 0 && timed.override.remainingMs <= 600);
  await new Promise((r) => setTimeout(r, 800));
  assert.equal((await admin.get('/api/overrides')).data.length, 0);
  let last;
  do last = await a.next(isState, 1000); while (last.override);
  assert.equal(last.override, null, 'the timer pushed the end to the TV');

  assert.equal((await admin.post('/api/overrides', { title: 'x' })).status, 400, 'needs a target');
  assert.equal((await admin.post('/api/overrides', { allChannels: true })).status, 400, 'needs content');
});

test('a PDF becomes one slide per page; videos default to full length', () => {
  const placement = { key: 'p1', duration: null, transition: 'slide', audio: 0 };
  const pdf = toSlides({ id: 'm', type: 'pdf', name: 'Menu', pages: 3, rev: 1 }, placement);
  assert.equal(pdf.length, 3);
  assert.equal(pdf[2].src, '/media/m/page-3.jpg');
  assert.equal(new Set(pdf.map((s) => s.key)).size, 3);
  const video = toSlides({ id: 'v', type: 'video', name: 'V', file: 'video.mp4', rev: 1 }, placement)[0];
  assert.equal(video.duration, null);
});

test('pages load: admin, player, service worker, vendored libraries', async (t) => {
  const { base } = await startServer(t);
  assert.equal((await fetch(`${base}/`, { redirect: 'manual' })).headers.get('location'), '/admin/');
  for (const url of ['/admin/', '/tv', '/play/anything', '/sw.js', '/player/player.js', '/player/schedule.js', '/vendor/hls.min.js', '/vendor/sortable.min.js', '/vendor/pdf.min.mjs', '/vendor/pdf.worker.min.mjs']) {
    const r = await fetch(base + url);
    assert.equal(r.status, 200, url);
    await r.arrayBuffer();
  }
  assert.equal((await fetch(`${base}/vendor/secret`)).status, 404);
});

test('player code stays ES5 so old TV browsers can parse it', () => {
  for (const name of ['player.js', 'schedule.js']) {
    const file = path.join(import.meta.dirname, '..', 'public', 'player', name);
    acorn.parse(fs.readFileSync(file, 'utf8'), { ecmaVersion: 5 });
  }
});
