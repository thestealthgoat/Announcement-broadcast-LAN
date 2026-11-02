import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import cookie from '@fastify/cookie';
import { openDb } from './db.js';
import { createHub } from './hub.js';
import { createProcessor, resolveFfmpeg } from './media.js';
import { isLocalAddress, baseUrls } from './lan.js';
import { userFromToken, httpError, COOKIE } from './auth.js';
import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import channelRoutes from './routes/channels.js';
import mediaRoutes from './routes/media.js';
import screenRoutes from './routes/screens.js';
import overrideRoutes from './routes/overrides.js';
import settingsRoutes from './routes/settings.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MAX_UPLOAD = 20 * 1024 ** 3;

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

export async function createServer({ dataDir, port = 8080, host = '0.0.0.0', ffmpeg = resolveFfmpeg(), logger = false }) {
  const mediaDir = path.join(dataDir, 'media');
  fs.mkdirSync(mediaDir, { recursive: true });

  const app = Fastify({ logger, bodyLimit: 1024 * 1024 });
  const db = openDb(path.join(dataDir, 'signage.db'));
  const hub = createHub(db, app.log);
  const processor = createProcessor({ db, hub, mediaDir, ffmpeg, log: app.log });

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
    }
    req.user = userFromToken(db, req.cookies?.[COOKIE]);
  });

  app.setErrorHandler((err, req, reply) => {
    const status = err.statusCode ?? 500;
    if (err.code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ error: 'That file is too large.' });
    if (status >= 500) req.log.error(err);
    return reply.code(status).send({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
  });

  const portRef = () => app.server.address()?.port ?? port;
  const ctx = { db, hub, processor, mediaDir, port: portRef };
  await app.register(authRoutes, ctx);
  await app.register(userRoutes, ctx);
  await app.register(channelRoutes, ctx);
  await app.register(mediaRoutes, ctx);
  await app.register(screenRoutes, ctx);
  await app.register(overrideRoutes, ctx);
  await app.register(settingsRoutes, ctx);

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
    processor.stop();
    hub.closeAll();
  });

  return {
    app, db, hub, processor,
    async start() {
      await app.listen({ port, host });
      processor.resume();
      hub.scheduleOverrideExpiry();
      return { port: portRef(), urls: baseUrls(portRef()) };
    },
    async stop() {
      await app.close();
      db.close();
    },
  };
}
