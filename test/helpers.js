import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from '../server/index.js';
import { resolveFfmpeg } from '../server/media.js';

export async function startServer(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-test-'));
  const server = await createServer({ dataDir, port: 0, host: '127.0.0.1' });
  const { port } = await server.start();
  t.after(async () => {
    await server.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });
  return { server, port, base: `http://127.0.0.1:${port}`, dataDir };
}

export function client(base) {
  let cookie = '';
  const call = async (method, url, body, headers = {}) => {
    const isForm = body instanceof FormData;
    const res = await fetch(base + url, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body && !isForm ? { 'content-type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      redirect: 'manual',
    });
    const set = res.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    const type = res.headers.get('content-type') ?? '';
    return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() };
  };
  return {
    get: (u) => call('GET', u),
    post: (u, b, h) => call('POST', u, b ?? {}, h),
    put: (u, b) => call('PUT', u, b),
    patch: (u, b) => call('PATCH', u, b),
    del: (u) => call('DELETE', u),
  };
}

export async function setupAdmin(base) {
  const admin = client(base);
  const r = await admin.post('/api/setup', { orgName: 'Test Org', name: 'Ada', username: 'ada', password: 'correct horse' });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
  return admin;
}

export async function makeEditor(admin, base, username, extra = {}) {
  const r = await admin.post('/api/users', { username, name: username, password: 'editor-pass', role: 'editor', ...extra });
  if (r.status !== 200) throw new Error(JSON.stringify(r));
  const c = client(base);
  await c.post('/api/login', { username, password: 'editor-pass' });
  return c;
}

export function player(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/player`);
  const inbox = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'ping') return;
    const i = waiters.findIndex((w) => w.test(msg));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(msg);
    else inbox.push(msg);
  });
  const open = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return {
    open,
    send: (m) => ws.send(JSON.stringify(m)),
    close: () => ws.close(),
    next(test = () => true, ms = 5000) {
      const i = inbox.findIndex(test);
      if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('timed out waiting for a player message')), ms);
        waiters.push({ test, resolve: (m) => { clearTimeout(t); resolve(m); } });
      });
    },
  };
}

export function ffmpegMake(file, args) {
  const r = spawnSync(resolveFfmpeg(), ['-hide_banner', '-loglevel', 'error', '-y', ...args, file]);
  if (r.status !== 0) throw new Error(r.stderr.toString());
  return fs.readFileSync(file);
}

export function form(name, buf, type) {
  const f = new FormData();
  f.append('file', new Blob([buf], { type }), name);
  return f;
}

export async function waitForMedia(c, id, ms = 30000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = (await c.get('/api/media')).data.find((x) => x.id === id);
    if (m && m.status !== 'processing') return m;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('media did not finish processing');
}
