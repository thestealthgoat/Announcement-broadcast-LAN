import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startServer, setupAdmin, ffmpegMake, form, waitForMedia } from './helpers.js';

async function image(admin, dataDir, name) {
  const buf = ffmpegMake(path.join(dataDir, `${name}.png`), ['-f', 'lavfi', '-i', 'color=teal:size=64x64', '-frames:v', '1']);
  const up = await admin.post('/api/media', form(`${name}.png`, buf, 'image/png'));
  return waitForMedia(admin, up.data.id);
}

test('a picture used as a designer background counts as in use', async (t) => {
  const { base, dataDir } = await startServer(t);
  const admin = await setupAdmin(base);
  const used = await image(admin, dataDir, 'used');
  const spare = await image(admin, dataDir, 'spare');
  const slide = await admin.post('/api/media/text', { title: 'Game day', style: { image: used.id } });
  assert.equal(slide.status, 200, JSON.stringify(slide.data));

  const cleanup = (await admin.get('/api/library/cleanup')).data;
  const ids = (cleanup.items ?? cleanup).map((m) => m.id);
  assert.ok(ids.includes(spare.id), 'an unused picture is offered for cleanup');
  assert.ok(!ids.includes(used.id), 'a background picture is not offered for cleanup');

  const dry = await admin.post('/api/library/bulk/delete', { ids: [used.id], dryRun: true });
  const row = dry.data.results.find((r) => r.id === used.id);
  assert.equal(row.usage.inUse, true);
  assert.deepEqual(row.usage.backgrounds, ['Game day']);

  const blocked = await admin.post('/api/library/bulk/delete', { ids: [used.id] });
  assert.equal(blocked.data.results[0].ok, false, 'needs explicit confirmation');
  const confirmed = await admin.post('/api/library/bulk/delete', { ids: [used.id], inUseConfirmed: [used.id] });
  assert.equal(confirmed.data.results[0].ok, true);
  assert.equal((await admin.get('/api/media')).data.some((m) => m.id === slide.data.id), true, 'the text slide survives');
});
