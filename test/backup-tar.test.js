// The tar code on its own, including sizes past what the classic header can hold.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { spawnSync } from 'node:child_process';
import { BLOCK, USTAR_MAX_SIZE, TarError, entryHeader, endOfArchive, paddingFor, paxRecord, parseHeader, readTar } from '../server/backup/tar.js';
import { safeEntryPath } from '../server/backup/restore.js';
import { tarEntry, tmpDir } from './backup-helpers.js';

const hasTar = spawnSync('tar', ['--version']).status === 0;

async function readAll(buf, chunkSize = buf.length || 1) {
  const chunks = [];
  for (let i = 0; i < buf.length; i += chunkSize) chunks.push(buf.subarray(i, i + chunkSize));
  const out = [];
  await readTar(Readable.from(chunks, { objectMode: false }), async (entry) => {
    const parts = [];
    out.push({ ...entry, parts });
    return { write: async (b) => { parts.push(Buffer.from(b)); }, end: async () => {} };
  });
  return out.map(({ parts, ...e }) => ({ ...e, data: Buffer.concat(parts) }));
}

test('padding rounds up to whole blocks, and is empty on a boundary', () => {
  assert.equal(paddingFor(0), 0);
  assert.equal(paddingFor(1), 511);
  assert.equal(paddingFor(512), 0);
  assert.equal(paddingFor(USTAR_MAX_SIZE + 1), 0);
  assert.equal(paddingFor(20 * 1024 ** 3 + 5), 507);
});

test('a short name and normal size use a single classic header', () => {
  const header = entryHeader({ name: 'media/a/video.mp4', size: 1234, mtime: 1700000000 });
  assert.equal(header.length, BLOCK);
  assert.deepEqual(parseHeader(header), { name: 'media/a/video.mp4', size: 1234, mtime: 1700000000, type: '0', linkname: '' });
});

test('a long path that can split on a slash uses the prefix field', () => {
  const name = `media/${'d'.repeat(120)}/${'f'.repeat(90)}.jpg`;
  const header = entryHeader({ name, size: 1 });
  assert.equal(header.length, BLOCK);
  assert.equal(parseHeader(header).name, name);
});

test('paths too long for the classic fields, or not plain ASCII, survive through PAX', async () => {
  const names = [
    `media/${'a'.repeat(300)}/b.jpg`,
    `media/${'x/'.repeat(400)}deep.png`,
    'media/caf\u00e9 \u5927\u5b66 \ud83d\ude00.jpg',
    `media/${'\u00e9'.repeat(200)}`,
  ];
  for (const name of names) {
    const entries = await readAll(Buffer.concat([tarEntry({ name, data: Buffer.from('hello') }), endOfArchive()]), 7);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, name);
    assert.equal(entries[0].data.toString(), 'hello');
  }
});

test('PAX record lengths include their own digits, right across a digit rollover', () => {
  for (let n = 1; n < 2000; n++) {
    const record = paxRecord('path', 'x'.repeat(n));
    const stated = Number(record.slice(0, record.indexOf(' ')));
    assert.equal(stated, Buffer.byteLength(record), `value length ${n}`);
  }
});

test('the largest classic size stays classic, and one byte more moves to PAX and base-256', () => {
  const limit = entryHeader({ name: 'media/big.mp4', size: USTAR_MAX_SIZE });
  assert.equal(limit.length, BLOCK);
  assert.equal(parseHeader(limit).size, USTAR_MAX_SIZE);

  const over = entryHeader({ name: 'media/big.mp4', size: USTAR_MAX_SIZE + 1 });
  assert.equal(over.length, BLOCK * 3, 'PAX header, its data, then the real header');
  const pax = parseHeader(over.subarray(0, BLOCK));
  assert.equal(pax.type, 'x');
  const records = over.subarray(BLOCK, BLOCK + pax.size).toString();
  assert.match(records, new RegExp(` size=${USTAR_MAX_SIZE + 1}\\n$`));
  assert.equal(parseHeader(over.subarray(BLOCK * 2)).size, USTAR_MAX_SIZE + 1, 'base-256 alone gives the same answer');
});

test('sizes far past 8 GB read back exactly', () => {
  for (const size of [8 * 1024 ** 3, 20 * 1024 ** 3, 2 ** 40 + 12345, Number.MAX_SAFE_INTEGER]) {
    const header = entryHeader({ name: 'media/big.mp4', size });
    assert.equal(parseHeader(header.subarray(header.length - BLOCK)).size, size);
  }
});

test('the reader takes a big file\'s size from PAX, whatever the classic field says', async () => {
  // Stops at the first entry, since the point is the size it reports, without 8 GB of data.
  const header = entryHeader({ name: `media/${'n'.repeat(300)}.mp4`, size: USTAR_MAX_SIZE + 100 });
  const seen = [];
  await assert.rejects(
    readTar(Readable.from([header], { objectMode: false }), async (entry) => {
      seen.push(entry);
    }),
    (err) => err instanceof TarError && err.kind === 'truncated',
  );
  assert.equal(seen[0].size, USTAR_MAX_SIZE + 100);
  assert.equal(seen[0].name, `media/${'n'.repeat(300)}.mp4`);
});

test('tar on this computer reads what we write, including a sparse file past 8 GB', { skip: !hasTar && 'no tar here' }, (t) => {
  const dir = tmpDir(t);
  const file = path.join(dir, 'sparse.tar');
  const size = USTAR_MAX_SIZE + 1 + 4096;
  const name = `media/${'long-name-'.repeat(30)}/video.mp4`;
  const header = entryHeader({ name, size, mtime: 1700000000 });
  const fd = fs.openSync(file, 'w');
  fs.writeSync(fd, header);
  // Skips over the data, so this takes no real disk space or time.
  const tail = Buffer.concat([tarEntry({ name: 'media/after.txt', data: Buffer.from('after') }), endOfArchive()]);
  fs.writeSync(fd, tail, 0, tail.length, header.length + size + paddingFor(size));
  fs.closeSync(fd);
  assert.ok(fs.statSync(file).size > USTAR_MAX_SIZE);

  const listed = spawnSync('tar', ['-tvf', file], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const [big, small] = listed.stdout.trim().split('\n');
  assert.ok(big.includes(String(size)), `tar reports the full size: ${big}`);
  assert.ok(big.includes(name), 'and the long name');
  assert.ok(small.endsWith('media/after.txt'), 'and carries on to the next entry, so the sizes line up');
});

test('any way of splitting the stream reads the same', async () => {
  const data = Buffer.alloc(BLOCK * 3 + 17, 7);
  const archive = Buffer.concat([
    tarEntry({ name: 'a', data }),
    tarEntry({ name: 'empty' }),
    tarEntry({ name: `media/${'long/'.repeat(80)}b`, data: Buffer.from('b') }),
    endOfArchive(),
  ]);
  for (const size of [1, 3, BLOCK - 1, BLOCK, BLOCK + 1, 1500, archive.length]) {
    const entries = await readAll(archive, size);
    assert.deepEqual(entries.map((e) => e.data.length), [data.length, 0, 1], `chunks of ${size}`);
    assert.ok(entries[0].data.equals(data));
  }
});

test('zero padding after the end is fine, as other tar tools add it, but anything else is not', async () => {
  const good = Buffer.concat([tarEntry({ name: 'a', data: Buffer.from('x') }), endOfArchive()]);
  assert.equal((await readAll(Buffer.concat([good, Buffer.alloc(9000)]))).length, 1);
  await assert.rejects(readAll(Buffer.concat([good, Buffer.from('extra')])), TarError);
});

test('an archive with no end, or cut anywhere, counts as cut short', async () => {
  const archive = Buffer.concat([tarEntry({ name: 'a', data: Buffer.alloc(1000, 1) }), endOfArchive()]);
  for (const cut of [100, BLOCK, BLOCK + 10, BLOCK * 3, archive.length - BLOCK]) {
    await assert.rejects(readAll(archive.subarray(0, cut)), (err) => err.kind === 'truncated', `cut at ${cut}`);
  }
});

test('a changed byte in a header is caught by its checksum', async () => {
  const archive = Buffer.concat([tarEntry({ name: 'a', data: Buffer.from('x') }), endOfArchive()]);
  for (const at of [0, 124, 156, 257, 300]) {
    const bad = Buffer.from(archive);
    bad[at] ^= 0x41;
    await assert.rejects(readAll(bad), TarError, `byte ${at}`);
  }
});

test('damaged PAX records are refused', async () => {
  const pax = (body) => Buffer.concat([tarEntry({ name: 'PaxHeader/entry', data: Buffer.from(body), type: 'x' }), tarEntry({ name: 'a' }), endOfArchive()]);
  for (const body of ['nonsense', '5 a=b\n', '99 path=x\n', '9 size=x\n', '11 pathnoeq\n']) {
    await assert.rejects(readAll(pax(body)), TarError, body);
  }
});

test('paths: only plain relative paths under an allowed name pass', () => {
  for (const ok of ['signage.db', 'config.json', 'media/a.jpg', 'media/id/video.mp4', 'media/branding/logo-1.png', 'media/caf\u00e9.jpg', 'media/.hidden']) {
    assert.equal(safeEntryPath(ok), true, ok);
  }
  for (const bad of [
    '', '/', '/etc/passwd', '/media/a', '../a', 'media/../../a', 'media/../signage.db', 'media/./a', './media/a', 'media//a', 'media/', 'media',
    '..', '.', 'media\\..\\a', 'C:\\a', 'C:/a', 'media/c:evil', 'media/a\0b', 'other.txt', 'live/x/seg.ts', 'signage.db-wal', 'signage.db-shm',
    '.autostart-configured', '.restore/safety/signage.db', 'config.json/x', 'signage.db/x', 'Media/a', `media/${'x'.repeat(5000)}`,
  ]) {
    assert.equal(safeEntryPath(bad), false, JSON.stringify(bad));
  }
});
