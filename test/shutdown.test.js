// A client that stops reading or sending must never hold up stopping the server.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from '../server/index.js';
import { quitApp } from '../electron/restart.js';
import { atEnd } from './helpers.js';

const POSIX = process.platform !== 'win32';
const ROOT = path.join(import.meta.dirname, '..');
const OPS = { fetch: null, discovery: false };
const GRACE_MS = 3000;
// A safety net only. Stopping takes the grace period plus a little, however slow this computer is.
const LIMIT_MS = 30000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-stop-'));
  atEnd(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

async function boot(t) {
  const dataDir = tempDir(t);
  const server = await createServer({ dataDir, port: 0, host: '127.0.0.1', ops: OPS, hashBackfillDelayMs: 1e8 });
  const { port } = await server.start();
  atEnd(t, () => server.stop());
  return { server, port, dataDir };
}

async function connect(t, port) {
  const sock = net.connect({ port, host: '127.0.0.1' });
  sock.on('error', () => {});
  atEnd(t, () => sock.destroy());
  await new Promise((r) => sock.once('connect', r));
  return sock;
}

async function timedStop(server) {
  const start = Date.now();
  const result = await Promise.race([server.stop().then(() => 'finished'), sleep(LIMIT_MS).then(() => 'still hanging')]);
  return { result, ms: Date.now() - start };
}

test('stop() finishes while a TV has stopped reading a video', async (t) => {
  const { server, port, dataDir } = await boot(t);
  fs.mkdirSync(path.join(dataDir, 'media', 'big'), { recursive: true });
  const big = path.join(dataDir, 'media', 'big', 'video.mp4');
  fs.closeSync(fs.openSync(big, 'w'));
  fs.truncateSync(big, 300 * 1024 * 1024); // far more than the socket buffers hold

  const sock = await connect(t, port);
  sock.write(`GET /media/big/video.mp4 HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
  await new Promise((r) => sock.once('data', r));
  sock.pause(); // like a <video> waiting for playback to catch up

  const { result, ms } = await timedStop(server);
  assert.equal(result, 'finished');
  assert.ok(ms >= GRACE_MS - 500, `stopped after ${ms} ms, so a working download got no grace`);
});

test('stop() finishes while a request body is only half sent', async (t) => {
  const { server, port } = await boot(t);
  const sock = await connect(t, port);
  sock.write(`POST /api/login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await sleep(100);
  const { result } = await timedStop(server);
  assert.equal(result, 'finished');
});

test('stop() finishes while a backup upload is only half sent, and leaves nothing staged', async (t) => {
  const { server, port, dataDir } = await boot(t);
  const sock = await connect(t, port);
  const boundary = 'x-boundary';
  sock.write(`POST /api/setup/restore HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: multipart/form-data; boundary=${boundary}\r\nContent-Length: 100000000\r\n\r\n--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="x.signagebackup"\r\nContent-Type: application/octet-stream\r\n\r\n`);
  sock.write(Buffer.alloc(1024));
  await sleep(200);
  const { result } = await timedStop(server);
  assert.equal(result, 'finished');
  await sleep(100);
  assert.equal(fs.existsSync(path.join(dataDir, '.restore')), false);
});

test('stop() finishes while a TV holds a websocket and answers nothing', async (t) => {
  const { server, port } = await boot(t);
  const sock = await connect(t, port);
  sock.write(`GET /ws/player HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n`);
  await new Promise((r) => sock.once('data', r));
  sock.pause();
  const { result } = await timedStop(server);
  assert.equal(result, 'finished');
});

test('a request that finishes within the grace period is answered, not cut off', async (t) => {
  const { server, port } = await boot(t);
  const sock = await connect(t, port);
  const body = '{"username":"a","password":"b"}';
  sock.write(`POST /api/login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n{`);
  await sleep(100);
  let answer = '';
  sock.on('data', (d) => { answer += d; });
  const stopping = server.stop();
  await sleep(300);
  sock.write(body.slice(1));
  await stopping;
  await new Promise((r) => { if (sock.destroyed) r(); else sock.once('close', r); });
  assert.match(answer, /^HTTP\/1\.1 \d+/, 'the client got an answer');
});

test('stopping twice is the same stop, and the database closes once', async (t) => {
  const { server } = await boot(t);
  await Promise.all([server.stop(), server.stop()]);
  await server.stop();
});

function startCli(t) {
  return new Promise((resolve, reject) => {
    const cli = spawn(process.execPath, ['server/cli.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: '0', SIGNAGE_HOST: '127.0.0.1', SIGNAGE_DATA_DIR: tempDir(t), SIGNAGE_NO_AUTOSTART: '1' },
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    atEnd(t, () => {
      try { cli.kill('SIGKILL'); } catch {} // only this test's own process, by its handle
    });
    const exited = new Promise((r) => cli.once('exit', (code, signal) => r({ code, signal })));
    let out = '';
    cli.stdout.on('data', (d) => {
      out += d;
      const m = out.match(/http:\/\/[^:]+:(\d+)\/admin/);
      if (m) resolve({ cli, port: Number(m[1]), exited });
    });
    cli.once('error', reject);
  });
}

test('one signal with an upload stalled: the command line waits out the grace period and exits cleanly', { skip: !POSIX }, async (t) => {
  const { cli, port, exited } = await startCli(t);
  const sock = await connect(t, port);
  sock.write(`POST /api/login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await sleep(100);
  cli.kill('SIGTERM');
  assert.deepEqual(await Promise.race([exited, sleep(LIMIT_MS).then(() => 'still running')]), { code: 0, signal: null });
});

test('a second signal exits the command line straight away', { skip: !POSIX }, async (t) => {
  const { cli, port, exited } = await startCli(t);
  const sock = await connect(t, port);
  sock.write(`POST /api/login HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{`);
  await sleep(100);
  cli.kill('SIGINT');
  await sleep(200);
  const start = Date.now();
  cli.kill('SIGINT');
  const result = await Promise.race([exited, sleep(LIMIT_MS).then(() => 'still running')]);
  assert.deepEqual(result, { code: 1, signal: null });
  assert.ok(Date.now() - start < GRACE_MS, 'it did not sit out the grace period');
});

test('quitting the tray app exits even if stopping the server never finishes', async () => {
  const calls = [];
  const app = { exit: (code) => calls.push(['exit', code]) };
  const server = { stop: () => new Promise(() => {}) };
  await quitApp({ app, server, timeoutMs: 50 });
  assert.deepEqual(calls, [['exit', 0]]);
});

test('quitting the tray app exits as soon as the server has stopped, or if stopping fails', async () => {
  const calls = [];
  const app = { exit: (code) => calls.push(['exit', code]) };
  const start = Date.now();
  await quitApp({ app, server: { stop: async () => {} }, timeoutMs: 60000 });
  await quitApp({ app, server: { stop: async () => { throw new Error('no'); } }, timeoutMs: 60000 });
  assert.deepEqual(calls, [['exit', 0], ['exit', 0]]);
  assert.ok(Date.now() - start < 5000);
});
