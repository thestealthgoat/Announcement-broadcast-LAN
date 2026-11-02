// Puts a checked backup in place, at startup, before anything opens the database. The marker file
// says how far things got, so a crash at any point recovers on the next boot:
//
//   pending    Checked and ready. The next boot starts the swap.
//   swapping   Files are moving. A boot that finds this puts the previous data back.
//   applied    The restored data is in place but hasn't opened yet. Same as swapping.
//   committed  The restored data opened. Only the cleanup is left.
//
// Every move is a rename inside the data folder, so each one either happens or doesn't, and each
// step can be repeated safely if a crash interrupts it.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DB_NAME, RESTORE_DIR, SWAP_ITEMS, restorePath } from './layout.js';

const MARKER = 'restore.json';
const SAFETY = 'safety';
export const UPLOAD_PREFIX = 'upload-';
export const LAST_RESTORE_KEY = 'backup.lastRestore';

function exists(file) {
  try {
    return fs.lstatSync(file, { throwIfNoEntry: false }) !== undefined;
  } catch (err) {
    if (err.code === 'ENOTDIR') return false; // a file where a folder on the way should be
    throw err;
  }
}

function syncDir(dir) {
  let fd;
  try {
    fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
  } catch {
    // Windows can't sync a folder, and NTFS journals renames anyway.
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Written to the side and renamed, so a crash leaves the old marker or the new one, never half.
function writeMarker(dataDir, marker) {
  const dir = restorePath(dataDir);
  const tmp = path.join(dir, `${MARKER}.tmp`);
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(marker));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, path.join(dir, MARKER));
  syncDir(dir);
}

function readMarker(dataDir) {
  let text;
  try {
    text = fs.readFileSync(restorePath(dataDir, MARKER), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
  const marker = JSON.parse(text);
  if (!marker.stagingName || !marker.phase) throw new Error('missing fields');
  return marker;
}

// Called by the restore route once a backup has passed every check.
export function markRestorePending(dataDir, { id, stagingName, firstRun = false, createdAt = null, appVersion = null }) {
  writeMarker(dataDir, { id, stagingName, firstRun, createdAt, appVersion, phase: 'pending' });
}

function removeRestoreDirIfEmpty(dataDir) {
  try {
    fs.rmdirSync(restorePath(dataDir));
  } catch {}
}

// Failed uploads get cleaned up as they fail, so these are only from a crash.
function removeStrayUploads(dataDir) {
  let names = [];
  try {
    names = fs.readdirSync(restorePath(dataDir));
  } catch {
    return;
  }
  for (const name of names) {
    if (name.startsWith(UPLOAD_PREFIX) || name === `${MARKER}.tmp`) {
      fs.rmSync(restorePath(dataDir, name), { recursive: true, force: true });
    }
  }
}

// If this can't tell, it answers yes, which keeps what's there.
function hasAccounts(dataDir) {
  const file = path.join(dataDir, DB_NAME);
  if (!exists(file)) return false;
  let raw;
  try {
    raw = new DatabaseSync(file);
    return !!raw.prepare('SELECT 1 AS x FROM users LIMIT 1').get();
  } catch {
    return true;
  } finally {
    raw?.close();
  }
}

// Removes the staged data, and the marker last, so an interruption repeats this.
function discard(dataDir, marker) {
  fs.rmSync(restorePath(dataDir, marker.stagingName), { recursive: true, force: true });
  removeStrayUploads(dataDir);
  fs.rmSync(restorePath(dataDir, SAFETY), { recursive: true, force: true });
  fs.rmSync(restorePath(dataDir, MARKER), { force: true });
  removeRestoreDirIfEmpty(dataDir);
}

// Back to exactly how things were. It's safe to run again if interrupted, and it throws rather
// than leaving a mess, because carrying on would mean opening a new empty database and showing
// first-run. `existing` lists what was here when the swap began: anything else came from the
// backup. A marker without that list never moved a file, so there is nothing to undo.
function rollback(dataDir, marker, step = () => {}) {
  if (Array.isArray(marker.existing)) {
    const safety = restorePath(dataDir, SAFETY);
    const existing = new Set(marker.existing);
    for (const name of SWAP_ITEMS) {
      const current = path.join(dataDir, name);
      const saved = path.join(safety, name);
      if (exists(saved)) {
        fs.rmSync(current, { recursive: true, force: true });
        step(`back:cleared:${name}`);
        fs.renameSync(saved, current);
        step(`back:restored:${name}`);
      } else if (!existing.has(name)) {
        fs.rmSync(current, { recursive: true, force: true });
        step(`back:removed:${name}`);
      }
    }
    syncDir(dataDir);
  }
  discard(dataDir, marker);
  step('back:done');
}

function swap(dataDir, marker, step) {
  const staging = restorePath(dataDir, marker.stagingName);
  const safety = restorePath(dataDir, SAFETY);
  const incoming = SWAP_ITEMS.filter((name) => exists(path.join(staging, name)));
  const existing = SWAP_ITEMS.filter((name) => exists(path.join(dataDir, name)));
  writeMarker(dataDir, { ...marker, phase: 'swapping', existing });
  step('swap:journal');
  fs.mkdirSync(safety, { recursive: true });
  for (const name of existing) {
    fs.renameSync(path.join(dataDir, name), path.join(safety, name));
    step(`swap:out:${name}`);
  }
  for (const name of incoming) {
    fs.renameSync(path.join(staging, name), path.join(dataDir, name));
    step(`swap:in:${name}`);
  }
  syncDir(dataDir);
  const applied = { ...marker, phase: 'applied', existing };
  writeMarker(dataDir, applied);
  step('swap:applied');
  return applied;
}

const failure = (marker, message) => ({ id: marker.id, ok: false, at: Date.now(), message });
const success = (marker) => ({ id: marker.id, ok: true, at: Date.now(), createdAt: marker.createdAt, appVersion: marker.appVersion });

function finishCleanup(dataDir, marker, step) {
  fs.rmSync(restorePath(dataDir, SAFETY), { recursive: true, force: true });
  step('commit:safety-removed');
  fs.rmSync(restorePath(dataDir, marker.stagingName), { recursive: true, force: true });
  removeStrayUploads(dataDir);
  fs.rmSync(restorePath(dataDir, MARKER), { force: true });
  removeRestoreDirIfEmpty(dataDir);
  step('commit:done');
}

// Returns { state }, which is one of: none; applied, meaning open the database and then call
// finishRestore or undoRestore; committed; or rolledBack. `onStep` lets tests stop at each point.
export function applyPendingRestore(dataDir, { onStep } = {}) {
  const step = onStep ?? (() => {});
  let marker;
  try {
    marker = readMarker(dataDir);
  } catch (err) {
    // Can't tell what state the files are in, and guessing could lose data.
    throw new Error(`Network Signage could not read its restore record in the "${RESTORE_DIR}" folder inside ${dataDir} (${err.message}). Your data is still in that folder. Ask for help before removing anything.`);
  }

  if (!marker) {
    removeStrayUploads(dataDir);
    // Nothing leaves a safety copy without a marker. If one turns up it could be someone's only
    // copy of their data, so it's set aside rather than deleted, and can't confuse a later restore.
    const safety = restorePath(dataDir, SAFETY);
    if (exists(safety)) {
      if (fs.readdirSync(safety).length) fs.renameSync(safety, restorePath(dataDir, `safety-kept-${Date.now()}`));
      else fs.rmdirSync(safety);
    }
    removeRestoreDirIfEmpty(dataDir);
    return { state: 'none' };
  }

  if (marker.phase === 'committed') {
    finishCleanup(dataDir, marker, step);
    return { state: 'committed', result: success(marker) };
  }

  if (marker.phase === 'swapping' || marker.phase === 'applied') {
    rollback(dataDir, marker, step);
    return { state: 'rolledBack', result: failure(marker, 'The restore did not finish, so your previous data was put back. Nothing was lost. You can try the restore again.') };
  }

  if (marker.phase !== 'pending') throw new Error(`Unknown restore state "${marker.phase}" in ${dataDir}.`);

  if (!exists(restorePath(dataDir, marker.stagingName))) {
    discard(dataDir, marker);
    return { state: 'rolledBack', result: failure(marker, 'The restore could not start because its files were missing. Your data was not changed.') };
  }
  step('swap:start');
  // The route checks this too. This is the check at the moment it would actually take effect.
  if (marker.firstRun && hasAccounts(dataDir)) {
    discard(dataDir, marker);
    return { state: 'rolledBack', result: failure(marker, 'The restore was stopped because setup was finished first. Your data was not changed.') };
  }

  try {
    return { state: 'applied', marker: swap(dataDir, marker, step) };
  } catch (err) {
    rollback(dataDir, readMarker(dataDir), step);
    return { state: 'rolledBack', result: failure(marker, `The restore could not put its files in place (${err.code ?? err.message}), so your previous data was put back. Nothing was lost.`) };
  }
}

// The restored database opened, so the safety copy can go. A cleanup failure doesn't matter to
// the data: the committed marker stays, and the next boot tries again.
export function finishRestore(dataDir, marker, { onStep, log } = {}) {
  const step = onStep ?? (() => {});
  writeMarker(dataDir, { ...marker, phase: 'committed' });
  step('commit:journal');
  try {
    finishCleanup(dataDir, marker, step);
  } catch (err) {
    log?.warn?.({ err: err.message }, 'Could not remove the safety copy after a restore. Will try again at the next start.');
  }
  return success(marker);
}

// The restored database wouldn't open, so the previous data goes back.
export function undoRestore(dataDir, marker, reason) {
  rollback(dataDir, marker);
  return failure(marker, `The restored data would not open (${reason}), so your previous data was put back. Nothing was lost.`);
}
