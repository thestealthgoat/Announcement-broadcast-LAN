import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openDb, pendingMigrations } from '../server/db.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'signage-mig-')), 'signage.db');

test('migrations are selected by version and sorted by number', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-migs-'));
  for (const f of ['010-j.sql', '002-b.sql', '003-c.sql', 'notes.txt', '.gitkeep']) fs.writeFileSync(path.join(dir, f), '');
  assert.deepEqual(pendingMigrations(2, dir).map((m) => m.number), [3, 10]);
  assert.deepEqual(pendingMigrations(1, dir).map((m) => m.name), ['002-b.sql', '003-c.sql', '010-j.sql']);
});

test('a brand-new database ends on the newest version with one default channel', () => {
  const file = tmp();
  const db = openDb(file);
  assert.equal(db.all('SELECT * FROM channels').length, 1);
  db.close();
  const raw = new DatabaseSync(file);
  const { user_version: v } = raw.prepare('PRAGMA user_version').get();
  const newest = Math.max(1, ...pendingMigrations(0).map((m) => m.number));
  assert.equal(v, newest);
  raw.close();
});

test('a real 1.0.x database upgrades and keeps its data', () => {
  // Rebuild a v1 database exactly as 1.0.2 shipped it, from the v1.0.2 tag.
  const sql = execFileSync('git', ['show', 'v1.0.2:server/db.js'], { encoding: 'utf8' }).match(/const SCHEMA = `([\s\S]*?)`;/)[1];
  const file = tmp();
  const raw = new DatabaseSync(file);
  raw.exec(sql);
  raw.exec("PRAGMA user_version = 1");
  raw.exec(`INSERT INTO users (username, name, password_hash, role, can_override, created_at) VALUES ('ada', 'Ada', 'x', 'admin', 1, 1);
    INSERT INTO channels (slug, name, created_at) VALUES ('gym', 'Gym', 1);
    INSERT INTO media (id, type, name, title, created_at) VALUES ('m1', 'text', 'Hello', 'Hello', 1);
    INSERT INTO playlist_items (channel_id, media_id, position, duration) VALUES (1, 'm1', 0, 7);`);
  raw.close();

  const db = openDb(file);
  assert.equal(db.get('SELECT username FROM users').username, 'ada');
  assert.equal(db.get('SELECT slug FROM channels').slug, 'gym', 'no extra default channel on upgrade');
  assert.equal(db.all('SELECT * FROM channels').length, 1);
  assert.equal(db.get('SELECT duration FROM playlist_items').duration, 7);
  db.close();
  const db2 = openDb(file);
  assert.equal(db2.all('SELECT * FROM playlist_items').length, 1, 'reopening is safe');
  db2.close();
});
