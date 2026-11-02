import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startServer, client, setupAdmin, makeEditor } from './helpers.js';
import { openDb } from '../server/db.js';
import { runRecoveryFlow } from '../electron/recovery.js';

const CLI = fileURLToPath(new URL('../server/reset-admin.js', import.meta.url));

const signIn = (base, username, password) => client(base).post('/api/login', { username, password });

test('a reset replaces the password and signs out old sessions', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  const [{ id, username }] = server.listAdmins();
  assert.equal(username, 'ada');

  const temp = await server.resetAdminPassword(id);
  assert.match(temp, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal((await admin.get('/api/me')).status, 401, 'old session ended');
  assert.equal((await signIn(base, 'ada', 'correct horse')).status, 401, 'old password dead');
  assert.equal((await signIn(base, 'ada', temp)).status, 200, 'temporary password works');
});

test('a reset gets you past a sign-in lockout', async (t) => {
  const { base, server } = await startServer(t);
  await setupAdmin(base);
  for (let i = 0; i < 10; i++) await signIn(base, 'ada', 'wrong');
  assert.equal((await signIn(base, 'ada', 'correct horse')).status, 429);
  const temp = await server.resetAdminPassword(server.listAdmins()[0].id);
  assert.equal((await signIn(base, 'ada', temp)).status, 200);
});

test('only admins can be reset this way, and there is no web route for it', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  await makeEditor(admin, base, 'ed');
  assert.deepEqual(server.listAdmins().map((a) => a.username), ['ada']);
  const editorId = (await admin.get('/api/users')).data.find((u) => u.username === 'ed').id;
  await assert.rejects(server.resetAdminPassword(editorId), /not an admin/i);
  for (const url of ['/api/recover', '/api/reset-admin', '/api/admin/reset']) {
    assert.equal((await client(base).post(url, {})).status, 404, url);
  }
});

function cli(dataDir, ...args) {
  const r = spawnSync(process.execPath, ['--no-warnings', CLI, ...args], {
    env: { ...process.env, SIGNAGE_DATA_DIR: dataDir }, encoding: 'utf8',
  });
  return { status: r.status, out: r.stdout + r.stderr };
}

test('command line: resets by username, and asks when it cannot tell which admin', async (t) => {
  const { base, server, dataDir } = await startServer(t);
  const admin = await setupAdmin(base);
  await admin.post('/api/users', { username: 'grace', name: 'Grace', password: 'another-pass', role: 'admin' });

  const ambiguous = cli(dataDir);
  assert.notEqual(ambiguous.status, 0);
  assert.match(ambiguous.out, /ada/);
  assert.match(ambiguous.out, /grace/);

  const unknown = cli(dataDir, 'nobody');
  assert.notEqual(unknown.status, 0);

  const ok = cli(dataDir, 'grace');
  assert.equal(ok.status, 0, ok.out);
  const temp = ok.out.match(/[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}/)[0];
  assert.equal((await signIn(base, 'grace', temp)).status, 200);
  assert.equal((await signIn(base, 'ada', 'correct horse')).status, 200, 'other admin untouched');
  assert.equal(server.listAdmins().length, 2);
});

test('command line: a missing data folder errors instead of creating an empty database', () => {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signage-empty-')), 'nothing-here');
  const r = cli(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /no signage data/i);
  assert.equal(fs.existsSync(path.join(dir, 'signage.db')), false);
});

test('command line: a database with no admins says so', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-noadmin-'));
  openDb(path.join(dir, 'signage.db')).close();
  const r = cli(dir);
  assert.notEqual(r.status, 0);
  assert.match(r.out, /no admin/i);
});

// The tray flow, with Electron's dialog and clipboard replaced by recorders.
function fakes(answers) {
  const shown = [];
  const copied = [];
  return {
    shown,
    copied,
    dialog: {
      showMessageBox: async (opts) => {
        shown.push(opts);
        return { response: answers(opts, shown.length - 1) };
      },
    },
    clipboard: { writeText: (t) => copied.push(t) },
  };
}

test('tray: confirming resets the chosen admin and shows the password to copy', async (t) => {
  const { base, server } = await startServer(t);
  const admin = await setupAdmin(base);
  await admin.post('/api/users', { username: 'grace', name: 'Grace', password: 'another-pass', role: 'admin' });
  const f = fakes((opts) => opts.buttons.findIndex((b) => b === 'Grace (grace)' || b === 'Copy password'));
  await runRecoveryFlow({ server, dialog: f.dialog, clipboard: f.clipboard });
  assert.equal(f.copied.length, 1);
  const [temp] = f.copied;
  assert.ok(f.shown.at(-1).message.includes('grace') || f.shown.at(-1).detail.includes('grace'));
  assert.ok(f.shown.at(-1).detail.includes(temp));
  assert.equal((await signIn(base, 'grace', temp)).status, 200);
  assert.equal((await signIn(base, 'ada', 'correct horse')).status, 200);
});

test('tray: cancel changes nothing', async (t) => {
  const { base, server } = await startServer(t);
  await setupAdmin(base);
  const f = fakes((opts) => opts.buttons.indexOf('Cancel'));
  await runRecoveryFlow({ server, dialog: f.dialog, clipboard: f.clipboard });
  assert.equal(f.copied.length, 0);
  assert.equal(f.shown.length, 1);
  assert.equal((await signIn(base, 'ada', 'correct horse')).status, 200);
});

test('tray: before setup there is nobody to reset', async (t) => {
  const { server } = await startServer(t);
  const f = fakes(() => 0);
  await runRecoveryFlow({ server, dialog: f.dialog, clipboard: f.clipboard });
  assert.equal(f.shown.length, 1);
  assert.match(f.shown[0].message, /no admin/i);
});
