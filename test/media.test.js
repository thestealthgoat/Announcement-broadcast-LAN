import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { startServer, setupAdmin, ffmpegMake, form, waitForMedia } from './helpers.js';
import { resolveFfmpeg, createProgressParser } from '../server/media.js';

test('video upload is transcoded to H.264/AAC MP4 with a thumbnail and served with ranges', async (t) => {
  const { base, dataDir } = await startServer(t);
  const admin = await setupAdmin(base);
  const src = path.join(dataDir, 'in.webm');
  const buf = ffmpegMake(src, ['-f', 'lavfi', '-i', 'testsrc=size=640x360:rate=10:duration=2', '-f', 'lavfi', '-i', 'sine=duration=2', '-c:v', 'libvpx', '-c:a', 'libvorbis', '-shortest']);
  const up = await admin.post('/api/media', form('clip.webm', buf, 'video/webm'));
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal(up.data.type, 'video');
  const m = await waitForMedia(admin, up.data.id);
  assert.equal(m.status, 'ready', m.error);
  assert.ok(m.src.endsWith('/video.mp4'));
  assert.ok(m.thumb);
  assert.ok(Math.abs(m.duration - 2) < 0.5);

  const out = path.join(dataDir, 'media', m.id, 'video.mp4');
  const probe = spawnSync(resolveFfmpeg(), ['-hide_banner', '-i', out]).stderr.toString();
  assert.match(probe, /Video: h264/);
  assert.match(probe, /Audio: aac/);
  assert.ok(!fs.existsSync(path.join(dataDir, 'media', m.id, 'source.bin')));

  const range = await fetch(base + m.src, { headers: { range: 'bytes=0-99' } });
  assert.equal(range.status, 206, 'TVs need range requests');
  assert.equal((await range.arrayBuffer()).byteLength, 100);
  assert.equal(range.headers.get('content-type'), 'video/mp4');
});

test('images get thumbnails; bad files are refused by content, not by name', async (t) => {
  const { base, dataDir } = await startServer(t);
  const admin = await setupAdmin(base);
  const buf = ffmpegMake(path.join(dataDir, 'in.png'), ['-f', 'lavfi', '-i', 'color=red:size=800x600', '-frames:v', '1']);
  const up = await admin.post('/api/media', form('poster.png', buf, 'image/png'));
  const m = await waitForMedia(admin, up.data.id);
  assert.equal(m.status, 'ready');
  assert.equal(m.type, 'image');
  assert.equal(m.name, 'poster');
  assert.equal((await fetch(base + m.thumb)).status, 200);

  const svg = await admin.post('/api/media', form('x.png', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml'));
  assert.equal(svg.status, 415);
  const fake = await admin.post('/api/media', form('bad.mp4', Buffer.from('not really a video'), 'video/mp4'));
  assert.equal(fake.status, 200);
  const failed = await waitForMedia(admin, fake.data.id);
  assert.equal(failed.status, 'failed');
  assert.ok(failed.error);
});

test('PDF flow stores rendered pages and needs them all', async (t) => {
  const { base, dataDir } = await startServer(t);
  const admin = await setupAdmin(base);
  const jpg = ffmpegMake(path.join(dataDir, 'p.jpg'), ['-f', 'lavfi', '-i', 'color=blue:size=640x360', '-frames:v', '1']);
  const pdf = (await admin.post('/api/media/pdf', { name: 'Menu', pages: 2 })).data;
  assert.equal(pdf.status, 'processing');
  assert.equal((await admin.post(`/api/media/${pdf.id}/pages/1`, form('1.jpg', jpg, 'image/jpeg'))).status, 200);
  assert.equal((await admin.post(`/api/media/${pdf.id}/finish`)).status, 400, 'page 2 is missing');
  assert.equal((await admin.post(`/api/media/${pdf.id}/pages/3`, form('3.jpg', jpg, 'image/jpeg'))).status, 400);
  await admin.post(`/api/media/${pdf.id}/pages/2`, form('2.jpg', jpg, 'image/jpeg'));
  const done = await admin.post(`/api/media/${pdf.id}/finish`);
  assert.equal(done.data.status, 'ready');
  assert.equal(done.data.pages, 2);
});

test('web items allow only http(s) and never YouTube; .m3u8 becomes an HLS item', async (t) => {
  const { base } = await startServer(t);
  const admin = await setupAdmin(base);
  for (const url of ['https://www.youtube.com/watch?v=1', 'https://youtu.be/1', 'javascript:alert(1)', 'file:///etc/passwd', 'nonsense']) {
    assert.equal((await admin.post('/api/media/url', { url })).status, 400, url);
  }
  assert.equal((await admin.post('/api/media/url', { url: 'https://example.com/menu' })).data.type, 'web');
  assert.equal((await admin.post('/api/media/url', { url: 'http://10.0.0.5/live/stream.m3u8' })).data.type, 'hls');
});

test('ffmpeg output is parsed correctly wherever a chunk happens to split', () => {
  const output = '  Duration: 00:01:40.00, start: 0.000000, bitrate: 900 kb/s\nframe=  10 fps=0 time=00:00:50.00 bitrate=1.0kbits/s speed=2x\r';
  for (let cut = 0; cut <= output.length; cut++) {
    const p = createProgressParser();
    p.push(output.slice(0, cut));
    p.push(output.slice(cut));
    assert.equal(p.duration, 100, `split at ${cut}`);
    assert.equal(p.percent, 50, `split at ${cut}`);
  }
  const unknown = createProgressParser();
  unknown.push('Duration: N/A, bitrate: N/A\nframe= 1 time=00:00:07.50 bitrate=1\r');
  assert.equal(unknown.duration, 7.5);
  assert.equal(unknown.percent, null);
});
