// What a backup's database says can't reach outside the data folder, whether it came in through a
// restore or was already sitting in a database. Everything here runs inside one temporary folder,
// with a real "victim" folder next to the data folder for a bad row to aim at.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { createExport } from '../server/backup/export.js';
import { childPath, mediaFolder, UnsafePathError } from '../server/safe-path.js';
import { craftArchive, makeDb } from './backup-helpers.js';
import { atEnd, client, setupAdmin } from './helpers.js';

const POSIX = process.platform !== 'win32';
const OPS = { fetch: null, discovery: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UUID = '6f1c1b1e-1111-4222-8333-444455556666';

async function waitFor(what, check, ms = 60000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

// data/ and victim/ side by side, so '../../victim' from data/live or data/media is the victim.
function sandbox(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-safety-'));
  atEnd(t, () => fs.rmSync(parent, { recursive: true, force: true }));
  const dataDir = path.join(parent, 'data');
  const victim = path.join(parent, 'victim');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(victim);
  fs.writeFileSync(path.join(victim, 'precious.txt'), 'do not delete');
  return { parent, dataDir, victim, intact: () => fs.existsSync(path.join(victim, 'precious.txt')) };
}

// Gets as far as ffmpeg would, so a bad folder is really reached, without a real encoder.
function fakeFfmpeg(parent) {
  const file = path.join(parent, 'ffmpeg');
  fs.writeFileSync(file, `#!/bin/sh
case "$*" in
  *-protocols*) printf 'Input:\\n  rtmp\\nOutput:\\n  rtmp\\n'; exit 0 ;;
  *-encoders*) printf ' V....D libx264  test\\n'; exit 0 ;;
  *"-f null"*) exit 0 ;;
esac
exec sleep 30
`);
  fs.chmodSync(file, 0o755);
  return file;
}

async function boot(t, dataDir, opts = {}) {
  const server = await createServer({ dataDir, port: 0, host: '127.0.0.1', ops: OPS, hashBackfillDelayMs: 1e8, ...opts });
  const { port } = await server.start();
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await server.stop();
  };
  atEnd(t, stop);
  return { server, port, base: `http://127.0.0.1:${port}`, stop };
}

async function archiveWith(parent, change) {
  const file = path.join(fs.mkdtempSync(path.join(parent, 'craft-')), 'evil.db');
  await makeDb(file);
  const db = openDb(file);
  change(db);
  db.get('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return craftArchive([['signage.db', fs.readFileSync(file)]]);
}

function restoreForm(bytes) {
  const form = new FormData();
  form.append('file', new Blob([bytes]), 'x.signagebackup');
  return { method: 'POST', body: form };
}

const addMedia = (db, id, fields = {}) => db.run(
  'INSERT INTO media (id, type, name, status, file, thumb, url, style, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1)',
  id, fields.type ?? 'image', 'x', fields.status ?? 'ready', fields.file ?? null, fields.thumb ?? null, fields.url ?? null, fields.style ?? null,
);
const addFeed = (db, id) => db.run("INSERT INTO live_feeds (media_id, input, port, encoder, max_bitrate, enabled) VALUES (?, 'rtmp', 45987, 'auto', 6000, 1)", id);
const noForeignKeys = (db, run) => {
  db.run('PRAGMA foreign_keys = OFF');
  run();
  db.run('PRAGMA foreign_keys = ON');
};

// Each one is a row that a normal server would never write.
const BAD_ROWS = {
  'a feed whose id climbs out of the live folder': (db) => {
    addMedia(db, '../../victim', { type: 'hls', url: '/live/x/index.m3u8' });
    addFeed(db, '../../victim');
  },
  'a feed row with no library item, whose id climbs out': (db) => noForeignKeys(db, () => addFeed(db, '../../victim')),
  'an item id with a folder in it': (db) => addMedia(db, 'a/b'),
  'an item id with a backslash': (db) => addMedia(db, '..\\..\\victim'),
  'an item id of two dots': (db) => addMedia(db, '..'),
  'an item that claims the branding folder': (db) => addMedia(db, 'branding'),
  'a file that climbs out': (db) => addMedia(db, UUID, { type: 'video', status: 'processing', file: '../../victim/precious.txt' }),
  'a file with a folder in it': (db) => addMedia(db, UUID, { file: 'a/b.png' }),
  'a file with a backslash': (db) => addMedia(db, UUID, { file: '..\\x.png' }),
  'a file of two dots': (db) => addMedia(db, UUID, { file: '..' }),
  'a thumbnail that climbs out': (db) => addMedia(db, UUID, { file: 'image.png', thumb: '../other/thumb.jpg' }),
  'a web page that runs a script': (db) => addMedia(db, UUID, { type: 'web', url: 'javascript:alert(1)' }),
  'a web page that is a data address': (db) => addMedia(db, UUID, { type: 'web', url: 'data:text/html,<script>alert(1)</script>' }),
  'a live address that climbs out': (db) => addMedia(db, UUID, { type: 'hls', url: '/live/../../index.m3u8' }),
  "a live address for another item's folder": (db) => addMedia(db, UUID, { type: 'hls', url: '/live/other/index.m3u8' }),
  'a slide carrying its own picture address': (db) => addMedia(db, UUID, { type: 'text', style: JSON.stringify({ imageUrl: 'http://evil.example/x.png' }) }),
  'a slide whose picture id climbs out': (db) => addMedia(db, UUID, { type: 'text', style: JSON.stringify({ image: '../../x' }) }),
  'an override carrying its own picture address': (db) => db.run("INSERT INTO overrides (title, style, all_channels, started_at) VALUES ('x', ?, 1, 1)", JSON.stringify({ imageUrl: 'http://evil.example/x.png' })),
  'a template carrying its own picture address': (db) => db.run("INSERT INTO slide_templates (name, builtin, style) VALUES ('x', 0, ?)", JSON.stringify({ imageUrl: 'http://evil.example/x.png' })),
  'a logo outside the branding folder': (db) => db.setSetting('branding', { logo: '/media/../../victim/precious.txt' }),
  'a logo on another computer': (db) => db.setSetting('branding', { logo: 'http://evil.example/x.png' }),
  'a font on another computer': (db) => db.setSetting('branding', { fontFile: 'https://evil.example/x.ttf' }),
  'a font address that breaks out of its CSS': (db) => db.setSetting('branding', { fontFile: '/media/branding/x.ttf");}body{display:none}' }),
  'a font name that breaks out of its CSS': (db) => db.setSetting('branding', { fontFamily: 'x", url(http://evil.example/)' }),
  'a color that is not a color': (db) => db.setSetting('branding', { primaryColor: 'url(http://evil.example/)' }),
  'branding that is not an object': (db) => db.setSetting('branding', 'x'),
  'a channel address that is not a slug': (db) => db.run("INSERT INTO channels (slug, name, created_at) VALUES ('../../admin', 'x', 1)"),
  'a feed whose port goes into its address': (db) => {
    addMedia(db, UUID, { type: 'hls', url: `/live/${UUID}/index.m3u8` });
    db.run("INSERT INTO live_feeds (media_id, input, port, encoder, max_bitrate, enabled) VALUES (?, 'rtmp', '1/../x', 'auto', 6000, 1)", UUID);
  },
  'a feed with an encoder this app does not have': (db) => {
    addMedia(db, UUID, { type: 'hls', url: `/live/${UUID}/index.m3u8` });
    db.run("INSERT INTO live_feeds (media_id, input, port, encoder, max_bitrate, enabled) VALUES (?, 'rtmp', 45987, '../x', 6000, 1)", UUID);
  },
  'a trigger that could write a bad row later': (db) => db.run("CREATE TRIGGER evil AFTER INSERT ON settings BEGIN INSERT OR IGNORE INTO media (id, type, name, created_at) VALUES ('../../victim', 'image', 'x', 1); END"),
};

for (const [what, change] of Object.entries(BAD_ROWS)) {
  test(`first-run restore refuses ${what}`, async (t) => {
    const { parent, dataDir, victim, intact } = sandbox(t);
    const target = await boot(t, dataDir);
    const res = await fetch(`${target.base}/api/setup/restore`, restoreForm(await archiveWith(parent, change)));
    const body = await res.json();
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.match(body.error, /unsafe/);
    assert.match(body.error, /nothing was changed/);
    assert.equal(fs.existsSync(path.join(dataDir, '.restore')), false, 'nothing staged is left behind');
    assert.equal(target.server.db.get('SELECT COUNT(*) AS n FROM users').n, 0);
    assert.equal(intact(), true);
    assert.deepEqual(fs.readdirSync(victim), ['precious.txt']);
  });
}

test('the crafted backup from the review: refused, and a later boot finds the victim folder untouched', { skip: !POSIX }, async (t) => {
  const { parent, dataDir, intact } = sandbox(t);
  const ffmpeg = fakeFfmpeg(parent);
  const first = await boot(t, dataDir, { ffmpeg, onRestart: () => {} });
  const res = await fetch(`${first.base}/api/setup/restore`, restoreForm(await archiveWith(parent, BAD_ROWS['a feed whose id climbs out of the live folder'])));
  assert.equal(res.status, 400);
  await first.stop();
  const second = await boot(t, dataDir, { ffmpeg });
  assert.deepEqual(second.server.live.childPids(), []);
  assert.equal(second.server.db.get('SELECT COUNT(*) AS n FROM live_feeds').n, 0);
  assert.equal(intact(), true);
});

test('a backup with every normal kind of row is still accepted', async (t) => {
  const { parent, dataDir } = sandbox(t);
  const target = await boot(t, dataDir, { onRestart: () => {} });
  const bytes = await archiveWith(parent, (db) => {
    addMedia(db, UUID, { file: 'image.png', thumb: 'thumb.jpg' });
    addMedia(db, 'seeded-1', { type: 'video', file: 'video.mp4', thumb: 'thumb.jpg' });
    addMedia(db, 'pdf-1', { type: 'pdf', thumb: 'page-1.jpg' });
    addMedia(db, 'page-1', { type: 'web', url: 'https://example.com/a?b=c#d' });
    addMedia(db, 'hls-1', { type: 'hls', url: 'http://10.0.0.2/stream.m3u8' });
    addMedia(db, 'feed-1', { type: 'hls', url: '/live/feed-1/index.m3u8' });
    addFeed(db, 'feed-1');
    addMedia(db, 'gone-picture', { type: 'text', style: JSON.stringify({ image: 'deleted-long-ago', dim: 40, textColor: '#ffffff', template: 99999 }) });
    addMedia(db, 'damaged-style', { type: 'text', style: 'not json' });
    db.run("INSERT INTO channels (slug, name, created_at) VALUES ('gym-2', 'Gym', 1)");
    db.setSetting('branding', { orgName: 'Org "with" quotes', logo: '/media/branding/logo-1700000000000.png', fontFile: '/media/branding/font-1700000000000.woff2', fontMode: 'upload', fontFamily: 'Roboto Slab', primaryColor: '#ABCDEF' });
  });
  const res = await fetch(`${target.base}/api/setup/restore`, restoreForm(bytes));
  const text = await res.text();
  assert.equal(res.status, 200, text);
});

// ---------- a bad row already in a database ----------

test('a bad feed row already in the database: the server boots, the victim is intact, and an admin can delete it', { skip: !POSIX }, async (t) => {
  const { parent, dataDir, intact } = sandbox(t);
  const seed = openDb(path.join(dataDir, 'signage.db'));
  BAD_ROWS['a feed whose id climbs out of the live folder'](seed);
  seed.close();

  const { server, port, base } = await boot(t, dataDir, { ffmpeg: fakeFfmpeg(parent) });
  const id = '../../victim';
  const failed = await waitFor('the feed to report a problem', () => (server.live.statusOf(id) === 'error' ? server.live.describe(id) : null));
  assert.match(failed.message, /damaged/i);
  assert.deepEqual(server.live.childPids(), []);
  assert.equal((await fetch(`http://127.0.0.1:${port}/tv`)).status, 200, 'the server is still up');
  assert.equal(intact(), true);

  const admin = await setupAdmin(base);
  const removed = await admin.del(`/api/media/${encodeURIComponent(id)}`);
  assert.equal(removed.status, 200, JSON.stringify(removed.data));
  assert.equal(server.db.get('SELECT COUNT(*) AS n FROM media').n, 0);
  assert.equal(intact(), true);
});

test('deleting a bad item in bulk, or asking its size, stays inside the media folder too', async (t) => {
  const { dataDir, victim, intact } = sandbox(t);
  const seed = openDb(path.join(dataDir, 'signage.db'));
  addMedia(seed, '../../victim');
  addMedia(seed, 'branding');
  seed.close();
  fs.mkdirSync(path.join(dataDir, 'media', 'branding'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'media', 'branding', 'logo.png'), 'x');

  const { server, base } = await boot(t, dataDir);
  const admin = await setupAdmin(base);
  const ids = ['../../victim', 'branding'];
  const dry = await admin.post('/api/library/bulk/delete', { ids, dryRun: true });
  assert.equal(dry.status, 200, JSON.stringify(dry.data));
  assert.equal(dry.data.totalBytes, 0, 'the size of a folder outside the media folder is not reported');
  const r = await admin.post('/api/library/bulk/delete', { ids, inUseConfirmed: ids });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(server.db.get('SELECT COUNT(*) AS n FROM media').n, 0);
  assert.equal(intact(), true);
  assert.deepEqual(fs.readdirSync(victim), ['precious.txt']);
  assert.equal(fs.existsSync(path.join(dataDir, 'media', 'branding', 'logo.png')), true, 'an item can never take the branding folder with it');
});

test('a bad row waiting for conversion fails cleanly, and ffmpeg never touches or deletes the file it names', { skip: !POSIX }, async (t) => {
  const { parent, dataDir, victim, intact } = sandbox(t);
  const ran = path.join(parent, 'ffmpeg-ran');
  const ffmpeg = path.join(parent, 'ffmpeg');
  fs.writeFileSync(ffmpeg, `#!/bin/sh\necho ran >> "${ran}"\nexit 0\n`);
  fs.chmodSync(ffmpeg, 0o755);
  const seed = openDb(path.join(dataDir, 'signage.db'));
  // The file exists for this one, so the old existence check would have let it through.
  fs.mkdirSync(path.join(dataDir, 'media', UUID), { recursive: true });
  addMedia(seed, UUID, { type: 'video', status: 'processing', file: '../../../victim/precious.txt' });
  addMedia(seed, '../../victim', { type: 'video', status: 'processing', file: 'precious.txt' });
  seed.close();

  const { server } = await boot(t, dataDir, { ffmpeg });
  await waitFor('both to fail', () => server.db.get("SELECT COUNT(*) AS n FROM media WHERE status = 'failed'").n === 2);
  assert.equal(server.processor.busy(), false);
  assert.equal(fs.existsSync(ran), false, 'ffmpeg was never given these paths');
  assert.equal(intact(), true);
  assert.deepEqual(fs.readdirSync(victim), ['precious.txt']);
});

test('the slow hash pass never reads through a bad row', async (t) => {
  const { dataDir } = sandbox(t);
  const seed = openDb(path.join(dataDir, 'signage.db'));
  addMedia(seed, '../../victim', { file: 'precious.txt' });
  seed.close();
  const { server } = await boot(t, dataDir);
  assert.equal(await server.hashBackfill.run(), 0);
  assert.equal(server.db.get('SELECT sha256 FROM media').sha256, null);
});

test('removing a logo whose saved path is bad never reaches beyond the branding folder', async (t) => {
  const { dataDir } = sandbox(t);
  const { server, base } = await boot(t, dataDir);
  const admin = await setupAdmin(base);
  const mediaDir = path.join(dataDir, 'media');
  fs.writeFileSync(path.join(mediaDir, 'keep.txt'), 'x');
  for (const logo of ['..', '/media/branding/..', '../keep.txt', '']) {
    server.db.setSetting('branding', { ...server.db.branding(), logo });
    const r = await admin.del('/api/branding/logo');
    assert.equal(r.status, 200, `${logo}: ${JSON.stringify(r.data)}`);
    assert.equal(fs.existsSync(path.join(mediaDir, 'keep.txt')), true);
    assert.equal(fs.existsSync(mediaDir), true);
  }
});

test('childPath gives a direct child of its parent, or throws', () => {
  const parent = path.join(os.tmpdir(), 'parent');
  assert.equal(childPath(parent, 'abc-1'), path.join(parent, 'abc-1'));
  assert.equal(childPath(parent, 'image.png'), path.join(parent, 'image.png'));
  for (const bad of ['..', '.', '', '../x', '../../x', 'a/b', 'a/../b', '/etc/passwd', 'x/..', 'a\0b', null, undefined, 5, {}]) {
    assert.throws(() => childPath(parent, bad), UnsafePathError, String(bad));
  }
  assert.throws(() => childPath(parent, '..\\x'), UnsafePathError, 'a backslash counts on every platform');
  assert.throws(() => childPath(parent, 'C:\\x'), UnsafePathError);
  assert.throws(() => childPath(parent, 'C:x'), UnsafePathError, 'a drive letter means another folder on Windows');
  assert.equal(mediaFolder(parent, 'abc'), path.join(parent, 'abc'));
  assert.throws(() => mediaFolder(parent, 'branding'), UnsafePathError);
});

// ---------- cleaning up after an export ----------

test('a snapshot that cannot be removed when a backup ends is a warning, not a crash', { skip: !POSIX || process.getuid?.() === 0 }, async (t) => {
  const { dataDir } = sandbox(t);
  const db = openDb(path.join(dataDir, 'signage.db'));
  atEnd(t, () => db.close());
  const warnings = [];
  const { stream } = createExport({ db, dataDir, log: { warn: (o, m) => warnings.push(m) } });
  const tmp = path.join(dataDir, '.backup-tmp');
  fs.chmodSync(tmp, 0o555); // what an antivirus lock looks like from here: the file can't go
  atEnd(t, () => {
    try { fs.chmodSync(tmp, 0o755); } catch {}
  });
  const crashes = [];
  const onCrash = (err) => crashes.push(err);
  process.on('uncaughtException', onCrash);
  atEnd(t, () => process.off('uncaughtException', onCrash));
  stream.on('error', () => {});
  const closed = new Promise((r) => stream.once('close', r));
  stream.destroy();
  await closed;
  await sleep(50);
  assert.deepEqual(crashes, []);
  assert.ok(warnings.some((m) => /could not remove/i.test(m)), JSON.stringify(warnings));
  fs.chmodSync(tmp, 0o755);
});

test('a leftover backup folder that cannot be removed does not stop the server starting', { skip: !POSIX || process.getuid?.() === 0 }, async (t) => {
  const { dataDir } = sandbox(t);
  const tmp = path.join(dataDir, '.backup-tmp');
  fs.mkdirSync(tmp);
  fs.writeFileSync(path.join(tmp, 'snapshot.db'), 'x');
  fs.chmodSync(tmp, 0o555);
  atEnd(t, () => {
    try { fs.chmodSync(tmp, 0o755); } catch {}
  });
  const { base } = await boot(t, dataDir);
  assert.equal((await client(base).get('/api/backup/status')).status, 200);
});
