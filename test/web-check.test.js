import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, setupAdmin } from './helpers.js';
import { refusesFraming } from '../server/web-check.js';

const refuses = (headers) => refusesFraming(new Headers(headers));

test('reads a refusal to be framed the way a browser does', () => {
  assert.equal(refuses({}), false);
  assert.equal(refuses({ 'x-frame-options': 'DENY' }), true);
  assert.equal(refuses({ 'x-frame-options': 'SAMEORIGIN' }), true);
  assert.equal(refuses({ 'content-security-policy': "default-src 'self'" }), false);
  assert.equal(refuses({ 'content-security-policy': "frame-ancestors 'none'" }), true);
  assert.equal(refuses({ 'content-security-policy': "default-src *; frame-ancestors 'self' https://a.example" }), true);
  assert.equal(refuses({ 'content-security-policy': 'frame-ancestors *' }), false);
  assert.equal(refuses({ 'content-security-policy': 'frame-ancestors *', 'x-frame-options': 'DENY' }), false, 'frame-ancestors wins');
  assert.equal(refuses({ 'content-security-policy': "frame-ancestors *, frame-ancestors 'none'" }), true, 'every policy must allow it');
});

test('checks a page before it is added, without adding it', async (t) => {
  const site = http.createServer((req, res) => {
    if (req.url === '/moved') {
      res.writeHead(302, { location: '/denied' });
    } else if (req.url === '/denied') {
      res.writeHead(200, { 'x-frame-options': 'DENY' });
    } else if (req.url === '/missing') {
      res.writeHead(404);
    } else {
      res.writeHead(200);
    }
    res.end('page');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  t.after(() => site.close());
  const page = `http://127.0.0.1:${site.address().port}`;

  const { base, port } = await startServer(t);
  const admin = await setupAdmin(base);
  const check = async (url) => (await admin.post('/api/media/url/check', { url })).data;

  const fine = await check(`${page}/`);
  assert.equal(fine.status, 'ok');
  assert.equal(fine.previewable, true);
  assert.equal((await check(`${page}/denied`)).status, 'blocked');
  assert.equal((await check(`${page}/moved`)).status, 'blocked', 'the page a redirect lands on decides');
  assert.equal((await check(`${page}/missing`)).status, 'error');
  site.closeAllConnections();

  const stream = await check(`${page}/feed.m3u8`);
  assert.equal(stream.status, 'stream');
  assert.equal(stream.previewable, false);
  const self = await check(`http://127.0.0.1:${port}/admin/`);
  assert.equal(self.status, 'invalid');
  assert.equal(self.previewable, false, 'never frames the signed-in admin');
  assert.equal((await admin.post('/api/media/url/check', { url: 'https://youtu.be/x' })).status, 400);

  const closed = http.createServer();
  await new Promise((resolve) => closed.listen(0, '127.0.0.1', resolve));
  const gone = closed.address().port;
  await new Promise((resolve) => closed.close(resolve));
  assert.equal((await check(`http://127.0.0.1:${gone}/`)).status, 'unknown');

  assert.equal((await admin.get('/api/media')).data.length, 0);
});

test('checking a page needs a login', async (t) => {
  const { base } = await startServer(t);
  await setupAdmin(base);
  const res = await fetch(`${base}/api/media/url/check`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'http://127.0.0.1:1/' }),
  });
  assert.equal(res.status, 401);
});

test('the admin page may frame other sites for a preview, and nothing may frame it', async (t) => {
  const { base } = await startServer(t);
  const csp = (await fetch(`${base}/admin/`)).headers.get('content-security-policy');
  assert.match(csp, /frame-src 'self' http: https:/);
  assert.match(csp, /frame-ancestors 'self'/);
});
