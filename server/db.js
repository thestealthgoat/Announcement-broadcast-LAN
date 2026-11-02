import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = fileURLToPath(new URL('./migrations/', import.meta.url));

const SCHEMA = `
CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','editor')),
  can_override INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE channels (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE user_channels (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, channel_id)
);
CREATE TABLE media (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('image','video','pdf','web','text','hls')),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('processing','ready','failed')),
  error TEXT,
  progress INTEGER,
  file TEXT,
  thumb TEXT,
  duration REAL,
  pages INTEGER,
  url TEXT,
  title TEXT,
  body TEXT,
  size INTEGER,
  rev INTEGER NOT NULL DEFAULT 1,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE playlist_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  position INTEGER NOT NULL,
  duration REAL,
  transition TEXT NOT NULL DEFAULT 'fade' CHECK (transition IN ('cut','fade','slide')),
  audio INTEGER NOT NULL DEFAULT 0,
  enabled INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX playlist_items_channel ON playlist_items(channel_id, position);
CREATE TABLE screens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  channel_id INTEGER REFERENCES channels(id) ON DELETE SET NULL,
  pair_code TEXT UNIQUE,
  last_seen INTEGER,
  current_item TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  media_id TEXT REFERENCES media(id) ON DELETE CASCADE,
  title TEXT,
  body TEXT,
  audio INTEGER NOT NULL DEFAULT 0,
  all_channels INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ends_at INTEGER,
  cleared_at INTEGER,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE TABLE override_channels (
  override_id INTEGER NOT NULL REFERENCES overrides(id) ON DELETE CASCADE,
  channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  PRIMARY KEY (override_id, channel_id)
);
`;

export const DEFAULT_BRANDING = {
  orgName: 'Network Signage',
  logo: null,
  primaryColor: '#1f2937',
  accentColor: '#3b82f6',
  textColor: '#ffffff',
  fontMode: 'system', // system | google | upload
  fontFamily: '',
  fontFile: null,
};

// Schema upgrades are numbered files, like 002-schedule.sql, applied once in order.
// Each runs in a transaction, so a failed upgrade leaves the database as it was.
export function pendingMigrations(version, dir = MIGRATIONS_DIR) {
  return fs.readdirSync(dir)
    .map((name) => ({ name, number: Number(name.match(/^(\d+)-.*\.sql$/)?.[1]) }))
    .filter((m) => m.number > version)
    .sort((a, b) => a.number - b.number);
}

export const latestSchemaVersion = (dir = MIGRATIONS_DIR) => Math.max(1, ...pendingMigrations(0, dir).map((m) => m.number));

function migrate(raw, db) {
  let { user_version: version } = raw.prepare('PRAGMA user_version').get();
  if (version === 0) {
    raw.exec('BEGIN');
    raw.exec(SCHEMA);
    raw.exec('PRAGMA user_version = 1');
    raw.exec('COMMIT');
    db.run("INSERT INTO channels (slug, name, created_at) VALUES ('main', 'Main', ?)", Date.now());
    version = 1;
  }
  for (const m of pendingMigrations(version)) {
    raw.exec('BEGIN');
    try {
      raw.exec(fs.readFileSync(MIGRATIONS_DIR + m.name, 'utf8'));
      raw.exec(`PRAGMA user_version = ${m.number}`);
      raw.exec('COMMIT');
    } catch (err) {
      raw.exec('ROLLBACK');
      throw new Error(`Database upgrade ${m.name} failed: ${err.message}`);
    }
  }
}

export function openDb(file) {
  const raw = new DatabaseSync(file);
  try {
    raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  } catch (err) {
    raw.close();
    throw err;
  }

  const cache = new Map();
  const stmt = (sql) => {
    let s = cache.get(sql);
    if (!s) cache.set(sql, (s = raw.prepare(sql)));
    return s;
  };
  const db = {
    get: (sql, ...args) => stmt(sql).get(...args),
    all: (sql, ...args) => stmt(sql).all(...args),
    run: (sql, ...args) => stmt(sql).run(...args),
    tx(fn) {
      raw.exec('BEGIN IMMEDIATE');
      try {
        const out = fn();
        raw.exec('COMMIT');
        return out;
      } catch (e) {
        raw.exec('ROLLBACK');
        throw e;
      }
    },
    close: () => raw.close(),
    getSetting(key, fallback) {
      const row = db.get('SELECT value FROM settings WHERE key = ?', key);
      return row ? JSON.parse(row.value) : fallback;
    },
    setSetting(key, value) {
      db.run(
        'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        key,
        JSON.stringify(value),
      );
    },
    branding: () => ({ ...DEFAULT_BRANDING, ...db.getSetting('branding', {}) }),
  };

  try {
    migrate(raw, db);
  } catch (err) {
    raw.close(); // a restore that fails here moves this file next, and Windows needs it closed
    throw err;
  }
  return db;
}
