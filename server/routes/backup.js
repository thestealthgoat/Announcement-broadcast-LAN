import { requireFullAccess, httpError, plainError } from '../auth.js';
import { createExport, summarize, tooBigMessage } from '../backup/export.js';
import { stageBackup, checkFreeSpace, removeStaging } from '../backup/restore.js';
import { markRestorePending, LAST_RESTORE_KEY } from '../backup/swap.js';

export const RESTORE_CONFIRMATION = 'replace-everything';
const CUT_CONNECTIONS_AFTER_MS = 2000; // one slow upload or download mustn't hold up a restart
const RESTART_FALLBACK_MS = 1000;
const STILL_CONVERTING = 'A video is still being converted. Back up when it finishes.';

export default async function backupRoutes(app, { db, dataDir, processor, live, backup, maxUpload, statfs, bootId, onRestart, restartsItself }) {
  const hasUsers = () => !!db.get('SELECT 1 AS x FROM users LIMIT 1');
  const downloads = new Set();

  // Closing waits for requests in flight, so a download has to end first, or it would hold that up.
  app.addHook('preClose', async () => {
    for (const stream of downloads) stream.destroy(new Error('The server is shutting down.'));
  });

  // What the page polls during a restart. Anyone may read it, since it's needed before signing in
  // on first run, and it says only whether the last restore worked.
  app.get('/api/backup/status', async () => {
    const last = db.getSetting(LAST_RESTORE_KEY, null);
    return {
      bootId,
      restarting: backup.restarting,
      lastRestore: last && { id: last.id, ok: last.ok, message: last.ok ? null : last.message },
    };
  });

  // Lets the page show a plain reason before the browser starts a download.
  app.get('/api/backup/summary', { preHandler: requireFullAccess }, async () => {
    const summary = summarize(dataDir);
    const blocked = processor.busy() ? STILL_CONVERTING : summary.totalSize > maxUpload ? tooBigMessage(maxUpload) : null;
    return { ...summary, blocked };
  });

  // Needs full access, because no single permission covers it: the file holds every account's
  // password hash as well as all the media and settings.
  app.get('/api/backup/export', { preHandler: requireFullAccess, exposeHeadRoute: false }, async (req, reply) => {
    if (backup.restarting) throw plainError(503, 'The server is restarting. Try again in a moment.');
    // A conversion swaps files partway through, which would stop this backup near the end.
    if (processor.busy()) throw httpError(409, STILL_CONVERTING);
    const { stream, contentLength, filename } = createExport({ db, dataDir, log: req.log, maxSize: maxUpload });
    downloads.add(stream);
    stream.once('close', () => downloads.delete(stream));
    // A stated length means a download cut short shows as failed, not as a smaller file.
    reply.header('Content-Type', 'application/octet-stream');
    reply.header('Content-Length', contentLength);
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.header('Cache-Control', 'no-store');
    return reply.send(stream);
  });

  let restartRequested = false;
  function requestRestart() {
    if (restartRequested) return;
    restartRequested = true;
    setTimeout(() => app.server.closeAllConnections?.(), CUT_CONNECTIONS_AFTER_MS).unref();
    Promise.resolve()
      .then(() => onRestart?.())
      .catch((err) => app.log.error(err));
  }

  async function restore(req, reply, { firstRun }) {
    if (backup.restarting) throw plainError(503, 'The server is already restarting.');
    if (backup.restoring) throw httpError(409, 'A restore is already running. Wait for it to finish.');
    backup.restoring = true;
    let part = null;
    let staged = null;
    const onClose = () => {
      if (!req.raw.complete) part?.file.destroy(httpError(400, 'The connection dropped during the upload.'));
    };
    req.raw.once('close', onClose);
    try {
      const declared = Number(req.headers['content-length']);
      if (Number.isFinite(declared)) await checkFreeSpace(dataDir, statfs, declared);
      part = await req.file();
      if (!part) throw httpError(400, 'No file was sent.');
      staged = await stageBackup(part.file, { dataDir, statfs });
      if (part.file.truncated) throw httpError(413, 'That file is too large.');

      // No await between this check and the marker, so setup can't slip in between. Setup that
      // finished during the upload is caught here, and setup still running is refused by its route.
      if (firstRun && hasUsers()) throw httpError(409, 'Setup was finished while this was uploading, so the backup was not restored.');
      markRestorePending(dataDir, {
        id: staged.id, stagingName: staged.stagingName, firstRun,
        createdAt: staged.manifest.createdAt, appVersion: staged.manifest.appVersion,
      });
      backup.restarting = true;
    } catch (err) {
      part?.file.resume(); // lets the browser finish sending, so it can read the answer
      if (staged) removeStaging(dataDir, staged.stagingName);
      throw err;
    } finally {
      backup.restoring = false;
      req.raw.off('close', onClose);
    }

    // The marker is written, so nothing below can stop the swap at the next boot.
    try {
      await live.stop();
      processor.stop();
    } catch (err) {
      req.log.error(err);
    }
    reply.raw.once('close', requestRestart);
    setTimeout(requestRestart, RESTART_FALLBACK_MS).unref();
    return { ok: true, id: staged.id, bootId, restart: restartsItself ? 'automatic' : 'manual' };
  }

  // Public on purpose, like /api/setup, and for the same reason: there is nobody to sign in as yet.
  app.post('/api/setup/restore', async (req, reply) => {
    if (hasUsers()) throw httpError(409, 'Setup is already complete, so a backup can only be restored from Settings after signing in.');
    return restore(req, reply, { firstRun: true });
  });

  app.post('/api/backup/restore', { preHandler: requireFullAccess }, async (req, reply) => {
    if (req.query.confirm !== RESTORE_CONFIRMATION) throw httpError(400, 'Confirm that this replaces everything on this server.');
    return restore(req, reply, { firstRun: false });
  });
}
