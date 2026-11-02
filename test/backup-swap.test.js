// Kills a real process at every step of a restore, then boots and checks the data is whole.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { applyPendingRestore, finishRestore, markRestorePending, LAST_RESTORE_KEY } from '../server/backup/swap.js';
import { restorePath } from '../server/backup/layout.js';
import { createServer } from '../server/index.js';
import { openDb } from '../server/db.js';
import { client } from './helpers.js';
import { makeDb, tmpDir, treeHashes } from './backup-helpers.js';

const SWAP = fileURLToPath(new URL('../server/backup/swap.js', import.meta.url));
const DB = fileURLToPath(new URL('../server/db.js', import.meta.url));
const STAGING = 'upload-test';
const ELECTRON_FILES = { Cookies: 'chromium cookies', SingletonLock: 'lock', '.autostart-configured': '' };

// Runs a restore in its own process, and either records each step or dies at one with SIGKILL, as
// close as it gets to losing power there. Nothing after that point runs.
const CHILD = `
  import { applyPendingRestore, finishRestore } from ${JSON.stringify(SWAP)};
  import { openDb } from ${JSON.stringify(DB)};
  import fs from 'node:fs';
  const [dataDir, killAt, record] = process.argv.slice(1);
  const onStep = (name) => {
    if (record) fs.appendFileSync(record, name + '\\n');
    if (name === killAt) process.kill(process.pid, 'SIGKILL');
  };
  const outcome = applyPendingRestore(dataDir, { onStep });
  if (outcome.state === 'applied') {
    const db = openDb(dataDir + '/signage.db');
    finishRestore(dataDir, outcome.marker, { onStep });
    db.close();
  }
`;

function runChild(dataDir, killAt = '', record = '') {
  const r = spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', CHILD, dataDir, killAt, record], { encoding: 'utf8' });
  return r;
}

// Leaves the previous database with its newest row only in the WAL, as a crashed server would.
// A swap that loses the WAL loses that row, so byte checks alone wouldn't catch it.
const WITH_WAL = `
  import { DatabaseSync } from 'node:sqlite';
  const raw = new DatabaseSync(process.argv[1]);
  raw.exec("PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0; INSERT INTO channels (slug, name, created_at) VALUES ('only-in-wal', 'Only in WAL', 1);");
  process.kill(process.pid, 'SIGKILL');
`;

async function makeOldData(dataDir, { config = true } = {}) {
  fs.mkdirSync(path.join(dataDir, 'media', 'old-item'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'media', 'old-item', 'image.png'), 'old media');
  if (config) fs.writeFileSync(path.join(dataDir, 'config.json'), '{"port":1111}');
  for (const [name, text] of Object.entries(ELECTRON_FILES)) fs.writeFileSync(path.join(dataDir, name), text);
  fs.mkdirSync(path.join(dataDir, 'live'), { recursive: true });
  const file = path.join(dataDir, 'signage.db');
  await makeDb(file, { username: 'olduser', password: 'old-password' });
  spawnSync(process.execPath, ['--no-warnings', '--input-type=module', '-e', WITH_WAL, file]);
  assert.ok(fs.statSync(`${file}-wal`).size > 0, 'the setup left a real WAL');
}

async function makeStaged(dataDir, { config = true } = {}) {
  const staging = restorePath(dataDir, STAGING);
  fs.mkdirSync(path.join(staging, 'media', 'new-item'), { recursive: true });
  fs.writeFileSync(path.join(staging, 'media', 'new-item', 'video.mp4'), 'new media');
  if (config) fs.writeFileSync(path.join(staging, 'config.json'), '{"port":2222}');
  await makeDb(path.join(staging, 'signage.db'), { username: 'newuser', password: 'new-password' });
}

async function prepare(t, opts = {}) {
  const dataDir = tmpDir(t, 'signage-swap-');
  await makeOldData(dataDir, opts);
  await makeStaged(dataDir, opts);
  const before = treeHashes(dataDir, { skip: ['.restore'] });
  markRestorePending(dataDir, { id: 'restore-1', stagingName: STAGING, createdAt: '2026-01-01T00:00:00.000Z', appVersion: '1.0.0' });
  return { dataDir, before };
}

const usernames = (dataDir) => {
  const raw = new DatabaseSync(path.join(dataDir, 'signage.db'), { readOnly: true });
  try {
    return raw.prepare('SELECT username FROM users').all().map((r) => r.username);
  } finally {
    raw.close();
  }
};

async function signsIn(t, dataDir, username, password) {
  const server = await createServer({ dataDir, port: 0, host: '127.0.0.1', ops: { fetch: null, discovery: false } });
  const { port } = await server.start();
  try {
    return (await client(`http://127.0.0.1:${port}`).post('/api/login', { username, password })).status === 200;
  } finally {
    await server.stop();
  }
}

function assertNoLeftovers(dataDir) {
  assert.equal(fs.existsSync(restorePath(dataDir)), false, 'the restore folder is gone');
}

async function assertPrevious(t, dataDir, before, where) {
  assert.deepEqual(treeHashes(dataDir, { skip: ['.restore'] }), before, `${where}: previous data is byte for byte as it was`);
  assertNoLeftovers(dataDir);
  assert.ok(await signsIn(t, dataDir, 'olduser', 'old-password'), `${where}: the previous account signs in`);
  const raw = new DatabaseSync(path.join(dataDir, 'signage.db'), { readOnly: true });
  assert.ok(raw.prepare("SELECT 1 AS x FROM channels WHERE slug = 'only-in-wal'").get(), `${where}: the row that was only in the WAL survived`);
  raw.close();
  assert.ok(!fs.existsSync(path.join(dataDir, 'media', 'new-item')), `${where}: nothing from the backup stayed`);
}

async function assertRestored(t, dataDir, where) {
  assertNoLeftovers(dataDir);
  assert.deepEqual(usernames(dataDir), ['newuser'], `${where}: restored account`);
  assert.equal(fs.readFileSync(path.join(dataDir, 'media', 'new-item', 'video.mp4'), 'utf8'), 'new media', `${where}: restored media`);
  assert.equal(fs.readFileSync(path.join(dataDir, 'config.json'), 'utf8'), '{"port":2222}', `${where}: restored config`);
  assert.ok(!fs.existsSync(path.join(dataDir, 'media', 'old-item')), `${where}: previous media is gone`);
  for (const [name, text] of Object.entries(ELECTRON_FILES)) {
    assert.equal(fs.readFileSync(path.join(dataDir, name), 'utf8'), text, `${where}: ${name} was left alone`);
  }
  assert.ok(await signsIn(t, dataDir, 'newuser', 'new-password'), `${where}: the restored account signs in`);
}

async function listSteps(t) {
  const { dataDir } = await prepare(t);
  const record = path.join(tmpDir(t), 'steps.txt');
  const r = runChild(dataDir, '', record);
  assert.equal(r.status, 0, r.stderr);
  return fs.readFileSync(record, 'utf8').trim().split('\n');
}

test('without any crash, the steps run in order and the backup ends up in place', async (t) => {
  const steps = await listSteps(t);
  assert.deepEqual(steps, [
    'swap:start', 'swap:journal',
    'swap:out:signage.db', 'swap:out:signage.db-wal', 'swap:out:signage.db-shm', 'swap:out:media', 'swap:out:config.json',
    'swap:in:signage.db', 'swap:in:media', 'swap:in:config.json',
    'swap:applied', 'commit:journal', 'commit:safety-removed', 'commit:done',
  ]);
});

test('a crash at any step leaves either all the previous data or all the backup, never a mix', async (t) => {
  const steps = await listSteps(t);
  for (const step of steps) {
    await t.test(`killed at ${step}`, async (st) => {
      const { dataDir, before } = await prepare(st);
      const r = runChild(dataDir, step);
      assert.equal(r.signal, 'SIGKILL', `the child really died: ${r.stderr}`);

      // Booting recovers. Before the journal there is nothing to undo, so the restore carries on;
      // from the journal until the database opens it goes back; after commit it stands.
      const outcome = applyPendingRestore(dataDir);
      if (step === 'swap:start') {
        assert.equal(outcome.state, 'applied');
        finishRestore(dataDir, outcome.marker);
        await assertRestored(st, dataDir, step);
      } else if (step.startsWith('commit:')) {
        assert.equal(outcome.state, step === 'commit:done' ? 'none' : 'committed');
        await assertRestored(st, dataDir, step);
      } else {
        assert.equal(outcome.state, 'rolledBack');
        assert.equal(outcome.result.ok, false);
        assert.equal(outcome.result.id, 'restore-1');
        await assertPrevious(st, dataDir, before, step);
      }
    });
  }
});

test('a crash during the recovery itself is recovered by the next boot', async (t) => {
  // Finds the recovery's own steps, by dying mid-swap and then watching it put things back.
  const { dataDir: scout } = await prepare(t);
  runChild(scout, 'swap:applied');
  const record = path.join(tmpDir(t), 'steps.txt');
  assert.equal(runChild(scout, '', record).status, 0);
  const steps = fs.readFileSync(record, 'utf8').trim().split('\n');
  assert.ok(steps.some((s) => s === 'back:restored:signage.db'), steps.join());
  assert.equal(steps.at(-1), 'back:done');

  for (const step of steps) {
    await t.test(`killed at ${step}`, async (st) => {
      const { dataDir, before } = await prepare(st);
      runChild(dataDir, 'swap:applied');
      assert.equal(runChild(dataDir, step).signal, 'SIGKILL');
      applyPendingRestore(dataDir);
      await assertPrevious(st, dataDir, before, step);
    });
  }
});

test('a config.json the old install never had is removed again on the way back', async (t) => {
  const { dataDir, before } = await prepare(t, { config: false });
  fs.writeFileSync(restorePath(dataDir, STAGING, 'config.json'), '{"port":3333}');
  assert.equal(runChild(dataDir, 'swap:in:config.json').signal, 'SIGKILL');
  applyPendingRestore(dataDir);
  assert.equal(fs.existsSync(path.join(dataDir, 'config.json')), false);
  await assertPrevious(t, dataDir, before, 'no old config');
});

test('a config.json the backup doesn\'t have is gone after a restore, as it replaces everything', async (t) => {
  const { dataDir } = await prepare(t);
  fs.rmSync(restorePath(dataDir, STAGING, 'config.json'));
  const outcome = applyPendingRestore(dataDir);
  finishRestore(dataDir, outcome.marker);
  assert.equal(fs.existsSync(path.join(dataDir, 'config.json')), false);
});

test('a swap that can\'t get started puts nothing at risk', async (t) => {
  // Reaches the failure path for real: the safety folder can't be made, so no file has moved yet.
  const { dataDir, before } = await prepare(t);
  const safety = restorePath(dataDir, 'safety');
  fs.writeFileSync(safety, 'a file where the safety folder needs to go');
  const outcome = applyPendingRestore(dataDir);
  assert.equal(outcome.state, 'rolledBack');
  assert.match(outcome.result.message, /previous data was put back/);
  await assertPrevious(t, dataDir, before, 'failed swap');
});

test('a move that fails partway puts everything back in the same boot', async (t) => {
  const { dataDir, before } = await prepare(t);
  const outcome = applyPendingRestore(dataDir, {
    onStep: (name) => {
      if (name === 'swap:in:signage.db') throw Object.assign(new Error('simulated'), { code: 'EPERM' });
    },
  });
  assert.equal(outcome.state, 'rolledBack');
  assert.match(outcome.result.message, /EPERM/);
  await assertPrevious(t, dataDir, before, 'failed move');
});

test('createServer: a restored database that won\'t open puts the previous data back and says so', async (t) => {
  const { dataDir } = await prepare(t);
  fs.writeFileSync(restorePath(dataDir, STAGING, 'signage.db'), Buffer.alloc(8192, 0x7a));
  const server = await createServer({ dataDir, port: 0, host: '127.0.0.1', ops: { fetch: null, discovery: false } });
  const { port } = await server.start();
  t.after(() => server.stop());
  const base = `http://127.0.0.1:${port}`;
  const admin = client(base);
  assert.equal((await admin.post('/api/login', { username: 'olduser', password: 'old-password' })).status, 200);
  assert.ok(fs.existsSync(path.join(dataDir, 'media', 'old-item', 'image.png')));
  assertNoLeftovers(dataDir);
  const status = (await admin.get('/api/backup/status')).data;
  assert.equal(status.lastRestore.ok, false);
  assert.equal(status.lastRestore.id, 'restore-1');
  const notice = (await admin.get('/api/notices')).data.find((n) => n.kind === 'restore');
  assert.equal(notice.severity, 'warning');
  assert.match(notice.text, /previous data was put back/);
  assert.equal((await admin.post(`/api/notices/${notice.id}/dismiss`)).status, 200);
  assert.equal((await admin.get('/api/notices')).data.some((n) => n.kind === 'restore'), false, 'stays dismissed');
});

test('createServer: when the swap can\'t be undone it refuses to start rather than show first-run', async (t) => {
  const { dataDir } = await prepare(t);
  runChild(dataDir, 'swap:out:signage.db');
  const saved = restorePath(dataDir, 'safety', 'signage.db');
  assert.ok(fs.existsSync(saved));
  // A safety folder nothing can be moved out of.
  const restoreDir = restorePath(dataDir, 'safety');
  fs.chmodSync(restoreDir, 0o500);
  await assert.rejects(createServer({ dataDir, port: 0, host: '127.0.0.1', ops: { fetch: null, discovery: false } }));
  assert.equal(fs.existsSync(path.join(dataDir, 'signage.db')), false, 'no new empty database was made');
  fs.chmodSync(restoreDir, 0o700);
  assert.equal(applyPendingRestore(dataDir).state, 'rolledBack', 'and the next boot still can');
  assert.deepEqual(usernames(dataDir), ['olduser']);
});

test('createServer: an unreadable restore record stops the boot, and changes nothing', async (t) => {
  const { dataDir, before } = await prepare(t);
  fs.writeFileSync(restorePath(dataDir, 'restore.json'), '{not json');
  await assert.rejects(createServer({ dataDir, port: 0, host: '127.0.0.1' }), /restore record/);
  assert.deepEqual(treeHashes(dataDir, { skip: ['.restore'] }), before);
});

test('a first-run restore is dropped at boot if accounts appeared after it was accepted', async (t) => {
  const dataDir = tmpDir(t, 'signage-swap-');
  const existing = openDb(path.join(dataDir, 'signage.db'));
  existing.run("INSERT INTO users (username, name, password_hash, role, role_id, created_at) VALUES ('late', 'Late', 'x', 'admin', 1, 1)");
  existing.close();
  await makeStaged(dataDir);
  markRestorePending(dataDir, { id: 'r', stagingName: STAGING, firstRun: true });
  const outcome = applyPendingRestore(dataDir);
  assert.equal(outcome.state, 'rolledBack');
  assert.match(outcome.result.message, /setup was finished/);
  assert.deepEqual(usernames(dataDir), ['late']);
  assertNoLeftovers(dataDir);
});

test('stray uploads from a crash are cleared at boot, and a safety copy with no marker is kept', (t) => {
  const dataDir = tmpDir(t, 'signage-swap-');
  fs.mkdirSync(restorePath(dataDir, 'upload-old', 'media'), { recursive: true });
  fs.writeFileSync(restorePath(dataDir, 'upload-old', 'media', 'x'), 'x');
  assert.equal(applyPendingRestore(dataDir).state, 'none');
  assertNoLeftovers(dataDir);

  fs.mkdirSync(restorePath(dataDir, 'safety'), { recursive: true });
  fs.writeFileSync(restorePath(dataDir, 'safety', 'signage.db'), 'irreplaceable');
  assert.equal(applyPendingRestore(dataDir).state, 'none');
  const [kept] = fs.readdirSync(restorePath(dataDir));
  assert.match(kept, /^safety-kept-/);
  assert.equal(fs.readFileSync(restorePath(dataDir, kept, 'signage.db'), 'utf8'), 'irreplaceable');
});

test('a successful boot records the restore for the page to find', async (t) => {
  const { dataDir } = await prepare(t);
  const server = await createServer({ dataDir, port: 0, host: '127.0.0.1', ops: { fetch: null, discovery: false } });
  t.after(() => server.stop());
  const saved = server.db.getSetting(LAST_RESTORE_KEY);
  assert.equal(saved.id, 'restore-1');
  assert.equal(saved.ok, true);
  assertNoLeftovers(dataDir);
});
