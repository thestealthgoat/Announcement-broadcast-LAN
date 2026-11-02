import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../server/db.js';
import { validateStyle } from '../server/slide-style.js';
import { startServer, setupAdmin, client, player, form, waitForMedia } from './helpers.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const hello = (p, slug = 'main') => p.open.then(() => p.send({ type: 'hello', preview: true, slug }));
const isState = (m) => m.type === 'state';

async function uploadImage(admin) {
  const r = await admin.post('/api/media', form('dot.png', PNG, 'image/png'));
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const done = await waitForMedia(admin, r.data.id);
  assert.equal(done.status, 'ready', done.error);
  return done;
}

async function textOnChannel(admin, body) {
  const r = await admin.post('/api/media/text?channelId=1', { title: 'Hello', ...body });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
}

async function roleClient(admin, base, name, permissions) {
  const role = await admin.post('/api/roles', { name, permissions });
  const username = name.toLowerCase().replace(/\W/g, '');
  assert.equal((await admin.post('/api/users', { username, name, password: 'password-1', roleId: role.data.id })).status, 200);
  const c = client(base);
  await c.post('/api/login', { username, password: 'password-1' });
  return c;
}

const HOSTILE = [
  ['a CSS injection in a color', { textColor: 'red;background:url(http://evil.example/x)' }],
  ['a color with a closing brace', { accentColor: '#000000}body{display:none' }],
  ['a named color', { textColor: 'red' }],
  ['a short hex color', { textColor: '#fff' }],
  ['a hex color with a newline', { textColor: '#ffffff\n' }],
  ['a color function', { textColor: 'rgb(0,0,0)' }],
  ['a CSS expression', { background: { type: 'solid', color: 'expression(alert(1))' } }],
  ['a background with a url', { background: { type: 'solid', color: 'url(javascript:alert(1))' } }],
  ['a gradient with free-form CSS', { background: { type: 'gradient', from: '#000000', to: '#ffffff); x: url(y' } }],
  ['a gradient with extra stops', { background: { type: 'gradient', from: '#000000', to: '#ffffff', stops: ['#123456'] } }],
  ['a background of an unknown kind', { background: { type: 'image', url: 'http://evil.example/x.png' } }],
  ['a background given as text', { background: 'linear-gradient(red, blue)' }],
  ['a javascript: address as an image', { image: 'javascript:alert(1)' }],
  ['an outside address as an image', { image: 'http://evil.example/x.png' }],
  ['a path as an image', { image: '../../etc/passwd' }],
  ['an image that does not exist', { image: 'no-such-image' }],
  ['an image given as a number', { image: 12 }],
  ['a ready-made image address', { imageUrl: 'javascript:alert(1)' }],
  ['free-form CSS', { css: 'body { display: none }' }],
  ['an unknown field', { fontFamily: 'Comic Sans' }],
  ['dimming out of range', { dim: 91 }],
  ['negative dimming', { dim: -1 }],
  ['dimming as text', { dim: '50' }],
  ['dimming as a fraction', { dim: 12.5 }],
  ['a size not on the list', { titleSize: '500px' }],
  ['a body size not on the list', { bodySize: 'calc(100vw)' }],
  ['an alignment not on the list', { align: 'justify' }],
  ['a logo position not on the list', { logo: 'center;position:fixed' }],
  ['a countdown that is not a date', { countdown: 'tomorrow' }],
  ['a countdown on an impossible day', { countdown: '2026-02-30T10:00' }],
  ['a countdown with script in it', { countdown: '2026-12-25T10:00<script>' }],
  ['a template that does not exist', { template: 9999 }],
  ['a template given as SQL', { template: '1; DROP TABLE media' }],
  ['an array', ['#000000']],
  ['plain text', 'color: red'],
  ['a number', 7],
];

test('hostile and invalid styles are refused everywhere, with plain messages, and nothing is saved', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const item = await textOnChannel(admin, {});
  const before = server.db.all('SELECT COUNT(*) AS n FROM media')[0].n;

  for (const [what, style] of HOSTILE) {
    const attempts = [
      ['new text', await admin.post('/api/media/text', { title: 'T', style })],
      ['edited text', await admin.patch(`/api/media/${item.id}`, { style })],
      ['override', await admin.post('/api/overrides', { title: 'T', allChannels: true, style })],
    ];
    // A template drops its own template id, so only the id cases differ there.
    if (!(style && Object.hasOwn(style, 'template'))) attempts.push(['template', await admin.post('/api/slide-templates', { name: 'Bad', style })]);
    for (const [where, r] of attempts) {
      assert.equal(r.status, 400, `${what} on ${where}: ${JSON.stringify(r.data)}`);
      assert.match(r.data.error, /^[A-Z][^<>{}]*\.$/, `${what} on ${where} gets a sentence`);
      assert.ok(!r.data.error.includes('evil'), 'the hostile value is not repeated back');
    }
  }
  assert.equal(server.db.all('SELECT COUNT(*) AS n FROM media')[0].n, before);
  assert.equal(server.db.get('SELECT style FROM media WHERE id = ?', item.id).style, null);
  assert.equal((await admin.get('/api/overrides')).data.length, 0);
  assert.equal(server.db.get("SELECT COUNT(*) AS n FROM slide_templates WHERE name = 'Bad'").n, 0);
});

test('a prototype key never gets through, whichever layer sees it first', async (t) => {
  const { base, server } = await startServer(t);
  const raw = '{"title":"T","style":{"__proto__":{"textColor":"#000000"}}}';
  const r = await fetch(`${base}/api/media/text`, { method: 'POST', body: raw, headers: { 'content-type': 'application/json' } });
  assert.equal(r.status, 400);
  assert.throws(() => validateStyle(server.db, JSON.parse('{"__proto__":{"textColor":"#000000"}}')), /does not recognize/);
});

test('a background image must be a ready picture from the library', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const text = await textOnChannel(admin, {});
  const web = await admin.post('/api/media/url', { url: 'http://example.com/' });
  const pdf = await admin.post('/api/media/pdf', { name: 'Doc', pages: 1 });
  server.db.run("INSERT INTO media (id, type, name, status, file, created_at) VALUES ('vid', 'video', 'Clip', 'ready', 'video.mp4', 1)");
  server.db.run("INSERT INTO media (id, type, name, status, file, created_at) VALUES ('slow', 'image', 'Slow', 'processing', 'image.png', 1)");
  for (const image of [text.id, web.data.id, pdf.data.id, 'vid']) {
    const r = await admin.post('/api/media/text', { title: 'T', style: { image } });
    assert.equal(r.status, 400, image);
    assert.match(r.data.error, /picture from the library/);
  }
  assert.match((await admin.post('/api/media/text', { title: 'T', style: { image: 'slow' } })).data.error, /not ready/);
  const good = await uploadImage(admin);
  assert.equal((await admin.post('/api/media/text', { title: 'T', style: { image: good.id } })).status, 200);
});

test('a good style is cleaned up and kept, and clearing it works', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const style = {
    template: 1,
    background: { type: 'gradient', from: '#AABBCC', to: '#112233' },
    dim: 40, textColor: '#FFFFFF', accentColor: '#000000', titleSize: 'large', bodySize: 'small', align: 'right', logo: 'hidden', countdown: '2026-12-25T10:00',
  };
  const made = await textOnChannel(admin, { style });
  assert.deepEqual(made.style, {
    ...style, background: { type: 'gradient', from: '#aabbcc', to: '#112233' }, textColor: '#ffffff',
  });
  const cleared = await admin.patch(`/api/media/${made.id}`, { style: null });
  assert.equal(cleared.status, 200);
  assert.equal(cleared.data.style, null);
  const none = await textOnChannel(admin, { style: {} });
  assert.equal(none.style, null, 'a style that sets nothing is no style');
});

test('only text items take a style', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const web = await admin.post('/api/media/url', { url: 'http://example.com/' });
  const r = await admin.patch(`/api/media/${web.data.id}`, { style: { textColor: '#000000' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /Only text/);
});

test('players receive the style, and a slide with none is unchanged', async (t) => {
  const { base, port } = await startServer(t);
  const admin = await setupAdmin(base);
  const picture = await uploadImage(admin);
  const plain = await textOnChannel(admin, { title: 'Plain' });
  await textOnChannel(admin, { title: 'Styled', style: { image: picture.id, dim: 50, textColor: '#ffffff' } });
  const p = player(port);
  await hello(p);
  const { slides } = await p.next(isState);
  const [a, b] = slides;
  assert.equal('style' in a, false);
  assert.match(a.key, new RegExp(`^p\\d+:${plain.id}:1$`), 'the key has its old form');
  assert.equal(b.style.dim, 50);
  assert.equal(b.style.imageUrl, picture.src, 'the server builds the address');
  assert.match(b.style.imageUrl, /^\/media\/[0-9a-f-]+\/image\.png$/);
  p.close();
});

test('editing a style changes the slide key and reaches the TV right away', async (t) => {
  const { base, port } = await startServer(t);
  const admin = await setupAdmin(base);
  const item = await textOnChannel(admin, { style: { textColor: '#ffffff' } });
  const p = player(port);
  await hello(p);
  const first = (await p.next(isState)).slides[0];

  const r = await admin.patch(`/api/media/${item.id}`, { style: { textColor: '#000000' } });
  assert.equal(r.status, 200);
  const second = (await p.next(isState)).slides[0];
  assert.notEqual(second.key, first.key);
  assert.equal(second.style.textColor, '#000000');

  await admin.patch(`/api/media/${item.id}`, { style: null });
  const third = (await p.next(isState)).slides[0];
  assert.notEqual(third.key, second.key);
  assert.equal('style' in third, false);
  p.close();
});

test('a style edit bumps the revision, as a text edit does', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const item = await textOnChannel(admin, {});
  await admin.patch(`/api/media/${item.id}`, { style: { align: 'left' } });
  assert.equal(server.db.get('SELECT rev FROM media WHERE id = ?', item.id).rev, 2);
});

test('an override carries its style to the TV', async (t) => {
  const { base, port } = await startServer(t);
  const admin = await setupAdmin(base);
  const p = player(port);
  await hello(p);
  await p.next(isState);

  const style = { template: 1, background: { type: 'solid', color: '#b91c1c' }, textColor: '#ffffff' };
  const r = await admin.post('/api/overrides', { title: 'Storm warning', allChannels: true, style });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(r.data.style, style);
  assert.deepEqual((await admin.get('/api/overrides')).data[0].style, style);
  const { override } = await p.next((m) => isState(m) && m.override);
  assert.equal(override.slides[0].title, 'Storm warning');
  assert.deepEqual(override.slides[0].style, style);
  assert.notEqual(override.slides[0].key, `o${r.data.id}`);

  await admin.del(`/api/overrides/${r.data.id}`);
  const plain = await admin.post('/api/overrides', { title: 'Plain', allChannels: true });
  const next = await p.next((m) => isState(m) && m.override?.id === plain.data.id);
  assert.equal(next.override.slides[0].key, `o${plain.data.id}`, 'no style, same key as ever');
  assert.equal('style' in next.override.slides[0], false);
  p.close();
});

test('a library override uses the item\'s own style, and takes none of its own', async (t) => {
  const { base, port } = await startServer(t);
  const admin = await setupAdmin(base);
  const item = await textOnChannel(admin, { style: { align: 'left' } });
  assert.equal((await admin.post('/api/overrides', { mediaId: item.id, allChannels: true, style: { align: 'right' } })).status, 400);
  assert.equal((await admin.post('/api/overrides', { mediaId: item.id, allChannels: true })).status, 200);
  const p = player(port);
  await hello(p);
  const { override } = await p.next((m) => isState(m) && m.override);
  assert.equal(override.slides[0].style.align, 'left');
  p.close();
});

test('deleting a background picture updates TVs and leaves slides and overrides working', async (t) => {
  const { base, port } = await startServer(t);
  const admin = await setupAdmin(base);
  const picture = await uploadImage(admin);
  const style = { background: { type: 'solid', color: '#123456' }, image: picture.id, dim: 50 };
  const item = await textOnChannel(admin, { style });
  const pushed = await admin.post('/api/overrides', { title: 'Now', allChannels: true, style });
  const p = player(port);
  await hello(p);
  const before = await p.next((m) => isState(m) && m.override);
  assert.equal(before.slides[0].style.imageUrl, picture.src);
  assert.equal(before.override.slides[0].style.imageUrl, picture.src);

  assert.equal((await admin.del(`/api/media/${picture.id}`)).status, 200);
  const after = await p.next(isState);
  assert.equal(after.override.id, pushed.data.id, 'the override stays up');
  for (const [was, now] of [[before.slides[0], after.slides[0]], [before.override.slides[0], after.override.slides[0]]]) {
    assert.equal('imageUrl' in now.style, false);
    assert.equal(now.style.background.color, '#123456', 'the color is still there to fall back on');
    assert.notEqual(now.key, was.key, 'the key changes, so the TV redraws');
  }
  assert.equal((await admin.get('/api/media')).data.find((m) => m.id === item.id).title, 'Hello');
  assert.equal((await admin.patch(`/api/media/${item.id}`, { title: 'Still editable' })).status, 200);
  assert.equal((await admin.get('/api/overrides')).data.length, 1);
  p.close();
});

test('a damaged style in the database never stops a channel', async (t) => {
  const { base, port, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const item = await textOnChannel(admin, {});
  server.db.run('UPDATE media SET style = ? WHERE id = ?', '{not json', item.id);
  const p = player(port);
  await hello(p);
  const { slides } = await p.next(isState);
  assert.equal(slides.length, 1);
  assert.equal('style' in slides[0], false);
  assert.equal((await admin.get('/api/media')).status, 200);
  p.close();
});

test('built-in templates are there, valid, readable, and can\'t be changed', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const { data } = await admin.get('/api/slide-templates');
  assert.deepEqual(data.templates.map((x) => x.name), ['Emergency', 'Weather', 'Schedule change', 'Game day', 'General']);
  assert.ok(data.templates.every((x) => x.builtin));
  assert.match(data.clock, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/);
  for (const x of data.templates) {
    assert.deepEqual(validateStyle(server.db, x.style), Object.keys(x.style).length ? x.style : null, `${x.name} passes its own validation`);
    assert.equal((await admin.patch(`/api/slide-templates/${x.id}`, { name: 'Mine' })).status, 403);
    assert.equal((await admin.del(`/api/slide-templates/${x.id}`)).status, 403);
  }
  assert.deepEqual(data.templates.find((x) => x.name === 'General').style, {}, 'General follows branding');
});

test('saved templates can be created, renamed, restyled, and deleted, and items keep their look', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const made = await admin.post('/api/slide-templates', { name: 'Chapel', style: { template: 1, textColor: '#FFFFFF', align: 'left' } });
  assert.equal(made.status, 200, JSON.stringify(made.data));
  assert.equal(made.data.builtin, false);
  assert.deepEqual(made.data.style, { textColor: '#ffffff', align: 'left' }, 'the start-from template id is not kept');

  assert.equal((await admin.post('/api/slide-templates', { name: 'chapel', style: {} })).status, 409);
  assert.equal((await admin.post('/api/slide-templates', { name: 'Emergency', style: {} })).status, 409);
  assert.equal((await admin.post('/api/slide-templates', { name: '  ', style: {} })).status, 400);
  assert.equal((await admin.post('/api/slide-templates', { name: 'x'.repeat(61), style: {} })).status, 400);

  const id = made.data.id;
  const renamed = await admin.patch(`/api/slide-templates/${id}`, { name: 'Chapel day' });
  assert.equal(renamed.data.name, 'Chapel day');
  assert.deepEqual(renamed.data.style, { textColor: '#ffffff', align: 'left' }, 'renaming keeps the look');
  assert.equal((await admin.patch(`/api/slide-templates/${id}`, { name: 'Chapel day' })).status, 200, 'its own name is no clash');
  assert.equal((await admin.patch(`/api/slide-templates/${id}`, { name: 'General' })).status, 409);
  const restyled = await admin.patch(`/api/slide-templates/${id}`, { style: { align: 'right' } });
  assert.deepEqual(restyled.data.style, { align: 'right' });

  const item = await textOnChannel(admin, { style: { template: id, align: 'right' } });
  assert.equal((await admin.del(`/api/slide-templates/${id}`)).status, 200);
  assert.equal((await admin.del(`/api/slide-templates/${id}`)).status, 404);
  assert.equal((await admin.patch('/api/slide-templates/9999', { name: 'Nope' })).status, 404);
  assert.ok(!(await admin.get('/api/slide-templates')).data.templates.some((x) => x.id === id));
  assert.equal((await admin.get('/api/media')).data.find((m) => m.id === item.id).style.align, 'right', 'the item keeps its look');
});

test('anyone who can make a text item or push an override can use templates; only settings can change them', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const uploader = await roleClient(admin, base, 'Coach', ['library.upload', 'library.own', 'channels.all']);
  const pusher = await roleClient(admin, base, 'Front Desk', ['overrides.push']);
  for (const who of [uploader, pusher]) {
    const list = await who.get('/api/slide-templates');
    assert.equal(list.status, 200);
    assert.equal(list.data.templates.length, 5);
    assert.equal((await who.post('/api/slide-templates', { name: 'Nope', style: {} })).status, 403);
  }
  const emergency = (await uploader.get('/api/slide-templates')).data.templates[0];
  const style = { ...emergency.style, template: emergency.id };
  const item = await uploader.post('/api/media/text', { title: 'Practice moved', style });
  assert.equal(item.status, 200, JSON.stringify(item.data));
  assert.equal(item.data.style.template, emergency.id);
  const pushed = await pusher.post('/api/overrides', { title: 'Evacuate', allChannels: true, style });
  assert.equal(pushed.status, 200, JSON.stringify(pushed.data));
  assert.equal((await client(base).get('/api/slide-templates')).status, 401);
});

test('someone who can\'t edit an item can\'t change its style', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  const item = await textOnChannel(admin, {});
  const uploader = await roleClient(admin, base, 'Coach', ['library.upload', 'library.own', 'channels.all']);
  assert.equal((await uploader.patch(`/api/media/${item.id}`, { style: { align: 'left' } })).status, 403);
});

test('a 1.0.2 database upgrades with its items and overrides untouched', async () => {
  const sql = execFileSync('git', ['show', 'v1.0.2:server/db.js'], { encoding: 'utf8' }).match(/const SCHEMA = `([\s\S]*?)`;/)[1];
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signage-designer-')), 'signage.db');
  const raw = new DatabaseSync(file);
  raw.exec(sql);
  raw.exec('PRAGMA user_version = 1');
  raw.exec(`INSERT INTO users (username, name, password_hash, role, can_override, created_at) VALUES ('ada', 'Ada', 'x', 'admin', 1, 1);
    INSERT INTO channels (slug, name, created_at) VALUES ('gym', 'Gym', 1);
    INSERT INTO media (id, type, name, title, body, rev, created_at) VALUES ('m1', 'text', 'Hello', 'Hello', 'World', 4, 1);
    INSERT INTO playlist_items (channel_id, media_id, position, duration) VALUES (1, 'm1', 0, 7);
    INSERT INTO overrides (title, body, all_channels, started_at) VALUES ('Old', 'Message', 1, 1);`);
  raw.close();

  const db = openDb(file);
  const item = db.get("SELECT * FROM media WHERE id = 'm1'");
  assert.equal(item.style, null);
  assert.equal(item.title, 'Hello');
  assert.equal(item.body, 'World');
  assert.equal(item.rev, 4, 'not bumped, so TVs have no reason to redraw');
  const override = db.get('SELECT * FROM overrides');
  assert.equal(override.style, null);
  assert.equal(override.title, 'Old');
  assert.equal(db.get('SELECT duration FROM playlist_items').duration, 7);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM slide_templates WHERE builtin = 1').n, 5);
  db.close();
  const again = openDb(file);
  assert.equal(again.get('SELECT COUNT(*) AS n FROM slide_templates').n, 5, 'reopening is safe');
  again.close();
});
