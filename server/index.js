import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import { openDb } from './db.js';
import { createHub } from './hub.js';
import { createProcessor, resolveFfmpeg } from './media.js';
import { createLiveFeeds } from './live/supervisor.js';
import { createHashBackfill } from './library.js';
import { isLocalAddress, baseUrls } from './lan.js';
import { userFromToken, httpError, createLoginLimiter, COOKIE } from './auth.js';
import { listAdmins, resetAdminPassword } from './recovery.js';
import { createOps } from './ops/index.js';
import { applyPendingRestore, finishRestore, undoRestore, LAST_RESTORE_KEY } from './backup/swap.js';
import { EXPORT_TMP_DIR } from './backup/layout.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import roleRoutes from './routes/roles.js';
import channelRoutes from './routes/channels.js';
import mediaRoutes from './routes/media.js';
import libraryRoutes from './routes/library.js';
import screenRoutes from './routes/screens.js';
import overrideRoutes from './routes/overrides.js';
import settingsRoutes from './routes/settings.js';
import opsRoutes from './routes/ops.js';
import liveRoutes from './routes/live.js';
import templateRoutes from './routes/templates.js';
import backupRoutes from './routes/backup.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_UPLOAD = 20 * 1024 ** 3;
const MAX_BACKUP = 4 * 1024 ** 4; // Far past any real library, but still a limit on an upload anyone can reach during first-run.

const VENDOR = {
  'hls.min.js': 'hls.js/dist/hls.min.js',
  'sortable.min.js': 'sortablejs/Sortable.min.js',
  'pdf.min.mjs': 'pdfjs-dist/legacy/build/pdf.min.mjs',
  'pdf.worker.min.mjs': 'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
};

const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' data: https://fonts.gstatic.com",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self' ws: wss:",
  "worker-src 'self' blob:",
  "frame-src 'self'",
  "frame-ancestors 'self'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

// Opens the database, and is what decides whether a restore that just went in place stays there.
function openAfterRestore(dataDir, restore, log) {
  const file = path.join(dataDir, 'signage.db');
  let result = restore.result ?? null;
  let db = null;
  if (restore.state === 'applied') {
    try {
      db = openDb(file);
      db.get('SELECT 1 AS x FROM users LIMIT 1');
      result = finishRestore(dataDir, restore.marker, { log });
    } catch (err) {
      try {
        db?.close();
      } catch {}
      db = null;
      log.error({ err: err.message }, 'A restored database would not open');
      result = undoRestore(dataDir, restore.marker, err.message);
    }
  }
  db ??= openDb(file);
  if (result) db.setSetting(LAST_RESTORE_KEY, result);
  return db;
}

// `port` can be a function, for when the port comes from a file in the data folder, because a
// restore can replace that file. `onRestart` runs after a restore is accepted. It should stop the
// server and start it again, and `restartsItself` says whether it can do that without help.
export async function createServer({ dataDir, port: portOption = 8080, host = '0.0.0.0', ffmpeg = resolveFfmpeg(), logger = false, ops: opsDeps = {}, hashBackfillDelayMs, onRestart = null, restartsItself = false }) {
  fs.mkdirSync(dataDir, { recursive: true });
  // First, because nothing may have the database open while its files change.
  const restore = applyPendingRestore(dataDir);
  fs.rmSync(path.join(dataDir, EXPORT_TMP_DIR), { recursive: true, force: true }); // from a crash
  const port = typeof portOption === 'function' ? portOption() : portOption;
  const mediaDir = path.join(dataDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const app = Fastify({ logger, bodyLimit: 1024 * 1024 });
  // test/permissions.test.js uses this to prove every route that changes something is checked.
  const routes = [];
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) routes.push({ method, url: r.url });
  });
  const db = openAfterRestore(dataDir, restore, app.log);
  const backup = { restoring: false, restarting: false };
  const hub = createHub(db, app.log, (mediaId) => live.isAvailable(mediaId));
  const processor = createProcessor({ db, hub, mediaDir, ffmpeg, log: app.log });
  const live = createLiveFeeds({ db, hub, dataDir, ffmpeg, log: app.log });
  const hashBackfill = createHashBackfill({ db, mediaDir, isBusy: processor.busy, log: app.log, startDelayMs: hashBackfillDelayMs });

  app.decorateRequest('user', null);
  await app.register(cookie);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD, files: 1 } });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  // LAN-only: refuse anything that did not come from a local address.
  app.addHook('onRequest', async (req, reply) => {
    if (!isLocalAddress(req.ip)) {
      reply.code(403).send({ error: 'This server is only available on the local network.' });
      return reply;
    }
    reply.header('X-Content-Type-Options', 'nosniff');
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const origin = req.headers.origin;
      if (origin) {
        let originHost = null;
        try {
          originHost = new URL(origin).host;
        } catch {}
        if (originHost !== req.headers.host) throw httpError(403, 'Cross-site requests are not allowed.');
      }
      // Anything saved now would be lost in the swap, so it's better refused.
      if (backup.restarting) {
        reply.code(503).send({ error: 'The server is restarting to finish a restore. Try again in a moment.' });
        return reply;
      }
    }
    req.user = userFromToken(db, req.cookies?.[COOKIE]);
  });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode ?? 500;
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'That file is too large.' });
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 && !err.expose ? 'Something went wrong on the server.' : err.message });
  });

  const portRef = () => app.server.address()?.port ?? port;
  const limiter = createLoginLimiter();
  const ops = createOps({ db, hub, dataDir, port: portRef, host, log: app.log, deps: opsDeps });
  const ctx = {
    db, hub, processor, mediaDir, port: portRef, limiter, ops, live, dataDir, backup, onRestart, restartsItself,
    maxUpload: MAX_BACKUP, statfs: opsDeps.statfs ?? fs.promises.statfs, bootId: randomUUID(),
  };
  await app.register(authRoutes, ctx);
  await app.register(userRoutes, ctx);
  await app.register(roleRoutes, ctx);
  await app.register(channelRoutes, ctx);
  await app.register(mediaRoutes, ctx);
  await app.register(libraryRoutes, ctx);
  await app.register(screenRoutes, ctx);
  await app.register(overrideRoutes, ctx);
  await app.register(settingsRoutes, ctx);
  await app.register(opsRoutes, ctx);
  await app.register(liveRoutes, ctx);
  await app.register(templateRoutes, ctx);
  await app.register(backupRoutes, ctx);

  // TVs do not sign in: each one identifies itself and receives only its channel.
  app.register(async (scope) => {
    scope.get('/ws/player', { websocket: true }, (socket) => hub.addPlayer(socket));
    scope.get('/ws/admin', { websocket: true }, (socket, req) => {
      if (!req.user) return socket.close(4401, 'Sign in');
      hub.addAdmin(socket);
    });
  });

  await app.register(fastifyStatic, {
    root: path.join(ROOT, 'public'),
    cacheControl: false,
    setHeaders: (reply) => reply.header('Cache-Control', 'no-cache'),
  });
  await app.register(fastifyStatic, {
    root: mediaDir,
    prefix: '/media/',
    decorateReply: false,
    immutable: true,
    maxAge: '365d',
  });
  // Live video changes every second, so nothing here may be cached or revalidated.
  await app.register(fastifyStatic, {
    root: live.liveDir,
    prefix: '/live/',
    decorateReply: false,
    cacheControl: false,
    etag: false,
    lastModified: false,
    setHeaders: (reply, file) => {
      reply.header('Cache-Control', 'no-store');
      if (file.endsWith('.m3u8')) reply.header('Content-Type', 'application/vnd.apple.mpegurl');
      else if (file.endsWith('.ts')) reply.header('Content-Type', 'video/mp2t');
    },
  });

  const sendPlayer = (req, reply) => reply.sendFile('player/index.html');
  app.get('/', (req, reply) => reply.redirect('/admin/'));
  app.get('/upload', (req, reply) => reply.redirect('/admin/#/upload'));
  app.get('/admin', (req, reply) => reply.redirect('/admin/'));
  app.get('/admin/', (req, reply) => {
    reply.header('Content-Security-Policy', ADMIN_CSP);
    return reply.sendFile('admin/index.html');
  });
  app.get('/tv', sendPlayer);
  app.get('/play/:slug', sendPlayer);
  app.get('/sw.js', (req, reply) => reply.sendFile('player/sw.js'));
  app.get('/vendor/:file', (req, reply) => {
    const rel = VENDOR[req.params.file];
    if (!rel) throw httpError(404, 'Not found');
    reply.header('Cache-Control', 'public, max-age=86400').type('text/javascript');
    return reply.send(fs.createReadStream(path.join(ROOT, 'node_modules', rel)));
  });

  app.addHook('onClose', async () => {
    await hashBackfill.stop();
    await ops.stop();
    await live.stop();
    processor.stop();
    hub.closeAll();
  });

  return {
    app, db, hub, processor, ops, live, routes, hashBackfill,
    listAdmins: () => listAdmins(db),
    async resetAdminPassword(userId) {
      const temp = await resetAdminPassword(db, userId);
      limiter.clear(); // being locked out is usually why someone is here
      return temp;
    },
    async start() {
      await app.listen({ port, host });
      processor.resume();
      live.start();
      hashBackfill.start();
      hub.scheduleOverrideExpiry();
      ops.start(); // Not awaited: a slow check must never hold up serving.
      return { port: portRef(), urls: baseUrls(portRef()) };
    },
    async stop() {
      await app.close();
      db.close();
    },
  };
}
