// Shared by the backup tests: builds archives by hand, and compares folders byte for byte.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { entryHeader, paddingFor, endOfArchive } from '../server/backup/tar.js';
import { latestSchemaVersion, openDb } from '../server/db.js';
import { hashPassword } from '../server/auth.js';

export const tmpDir = (t, prefix = 'signage-backup-') => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t?.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

// Every file below a folder, as { path: hash }, so assert.deepEqual shows exactly what changed.
export function treeHashes(dir, { skip = [] } = {}) {
  const out = {};
  const walk = (rel) => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const name = rel ? `${rel}/${e.name}` : e.name;
      if (skip.includes(name)) continue;
      if (e.isDirectory()) walk(name);
      else out[name] = e.isFile() ? sha256(fs.readFileSync(path.join(dir, name))) : 'not-a-file';
    }
  };
  walk('');
  return out;
}

export function tarEntry({ name, data = Buffer.alloc(0), type = '0', linkname = '', size }) {
  const buf = Buffer.from(data);
  const declared = size ?? buf.length;
  return Buffer.concat([entryHeader({ name, size: declared, type, linkname, mtime: 1700000000 }), buf, Buffer.alloc(paddingFor(buf.length))]);
}

// A database an app of this version would accept, with one account that can sign in.
export async function makeDb(file, { username = 'ada', password = 'correct horse' } = {}) {
  const db = openDb(file);
  const hash = await hashPassword(password);
  db.run("INSERT INTO users (username, name, password_hash, role, can_override, role_id, created_at) VALUES (?, ?, ?, 'admin', 1, 1, 1)", username, username, hash);
  db.get('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
  return file;
}

// Builds a backup by hand. `files` are the payload as [name, bytes]. Everything else comes out
// right unless a test asks otherwise, so each test breaks exactly one thing.
export function craftArchive(files, { manifest = {}, checksums, extra = [], before = [], end = true, raw } = {}) {
  const totalSize = files.reduce((n, [, data]) => n + data.length, 0);
  const manifestBytes = Buffer.from(JSON.stringify({
    format: 'network-signage-backup', formatVersion: 1, appVersion: '1.0.0', schemaVersion: latestSchemaVersion(),
    createdAt: '2026-01-01T00:00:00.000Z', fileCount: files.length, totalSize, ...manifest,
  }));
  const sums = checksums ?? files.map(([name, data]) => `${JSON.stringify({ path: name, sha256: sha256(data) })}\n`).join('');
  return Buffer.concat([
    ...(raw ?? []),
    tarEntry({ name: 'manifest.json', data: manifestBytes }),
    ...before,
    ...files.map(([name, data]) => tarEntry({ name, data })),
    ...extra,
    tarEntry({ name: 'checksums.jsonl', data: sums }),
    ...(end ? [endOfArchive()] : []),
  ]);
}

export const dbTables = (raw) => raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r) => r.name);

// Every row of every table, found by asking the database, so new tables get compared too.
export function dumpDb(file, { skipTables = [], skipSettings = [] } = {}) {
  const raw = new DatabaseSync(file, { readOnly: true });
  try {
    const out = {};
    for (const table of dbTables(raw)) {
      if (skipTables.includes(table)) continue;
      const rows = raw.prepare(`SELECT * FROM "${table}"`).all().map((r) => ({ ...r }));
      out[table] = (table === 'settings' ? rows.filter((r) => !skipSettings.includes(r.key)) : rows)
        .map((r) => JSON.stringify(r)).sort();
    }
    out.user_version = raw.prepare('PRAGMA user_version').get().user_version;
    return out;
  } finally {
    raw.close();
  }
}
