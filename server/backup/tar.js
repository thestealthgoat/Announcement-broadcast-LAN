// A small tar writer and streaming reader, using only what a backup needs: regular files, with
// PAX records for long paths and for files too big for the classic header's size field. The
// output is a normal tar file, so `tar -tf` can list a backup.
export const BLOCK = 512;
export const USTAR_MAX_SIZE = 8 ** 11 - 1; // 8 GB less a byte: eleven octal digits
const NAME_MAX = 100;
const PREFIX_MAX = 155;
const PAX_MAX = 1024 * 1024; // PAX records are held in memory while reading, so they stay small.

export class TarError extends Error {
  constructor(message, kind = 'corrupt') {
    super(message);
    this.kind = kind; // corrupt | truncated
  }
}

export const paddingFor = (size) => (BLOCK - (size % BLOCK)) % BLOCK;
export const endOfArchive = () => Buffer.alloc(BLOCK * 2);

function writeOctal(block, value, offset, width) {
  block.write(`${value.toString(8).padStart(width - 1, '0')}\0`, offset, width, 'latin1');
}

// Sizes past the octal limit use GNU base-256 as well as the PAX record, so readers that
// know only one of the two still find the right length.
function writeSize(block, size) {
  if (size <= USTAR_MAX_SIZE) {
    writeOctal(block, size, 124, 12);
    return;
  }
  block[124] = 0x80;
  let rest = BigInt(size);
  for (let i = 135; i > 124; i--) {
    block[i] = Number(rest & 0xffn);
    rest >>= 8n;
  }
}

function readOctal(block, offset, width) {
  const text = block.toString('latin1', offset, offset + width).replace(/[\0 ]+$/, '').replace(/^ +/, '');
  if (!text) return 0;
  if (!/^[0-7]+$/.test(text)) throw new TarError('An entry has a damaged header.');
  return Number.parseInt(text, 8);
}

function readSize(block) {
  if (block[124] & 0x80) {
    let value = BigInt(block[124] & 0x7f);
    for (let i = 125; i < 136; i++) value = (value << 8n) | BigInt(block[i]);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new TarError('An entry has an impossible size.');
    return Number(value);
  }
  return readOctal(block, 124, 12);
}

function readText(block, offset, width) {
  const end = block.indexOf(0, offset);
  return block.toString('utf8', offset, end === -1 || end > offset + width ? offset + width : end);
}

function checksumOf(block) {
  let sum = 8 * 0x20; // the checksum field counts as spaces
  for (let i = 0; i < BLOCK; i++) if (i < 148 || i >= 156) sum += block[i];
  return sum;
}

function ustarBlock({ name, prefix = '', size, mtime, type, linkname = '' }) {
  const block = Buffer.alloc(BLOCK);
  block.write(name, 0, NAME_MAX, 'utf8');
  writeOctal(block, 0o644, 100, 8);
  writeOctal(block, 0, 108, 8);
  writeOctal(block, 0, 116, 8);
  writeSize(block, size);
  writeOctal(block, Math.max(0, Math.floor(mtime)), 136, 12);
  block[156] = type.charCodeAt(0);
  block.write(linkname, 157, NAME_MAX, 'utf8');
  block.write('ustar\0' + '00', 257, 8, 'latin1');
  block.write(prefix, 345, PREFIX_MAX, 'utf8');
  block.write(`${checksumOf(block).toString(8).padStart(6, '0')}\0 `, 148, 8, 'latin1');
  return block;
}

// Finds a split at a "/" so the path fits the classic name and prefix fields.
function splitForUstar(name) {
  if (!/^[\x20-\x7e]+$/.test(name)) return null;
  if (name.length <= NAME_MAX) return { name, prefix: '' };
  for (let i = name.indexOf('/'); i !== -1; i = name.indexOf('/', i + 1)) {
    if (i > 0 && i <= PREFIX_MAX && name.length - i - 1 <= NAME_MAX) {
      return { name: name.slice(i + 1), prefix: name.slice(0, i) };
    }
  }
  return null;
}

// A record states its own length, digits included, so adding the digits can change the count.
export function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const bodyLength = Buffer.byteLength(body);
  let length = bodyLength + String(bodyLength).length;
  if (String(length).length !== String(bodyLength).length) length = bodyLength + String(length).length;
  return `${length}${body}`;
}

// The bytes that go before an entry's data. Works out to a fixed length for a given name and
// size, which is what lets the export state its total length before it starts.
export function entryHeader({ name, size, mtime = 0, type = '0', linkname = '' }) {
  const fits = splitForUstar(name);
  const records = [];
  if (!fits) records.push(paxRecord('path', name));
  if (size > USTAR_MAX_SIZE) records.push(paxRecord('size', String(size)));
  // Readers that ignore PAX see a harmless shortened name here.
  const main = fits ?? { name: name.replace(/[^\x20-\x7e]/g, '_').slice(-NAME_MAX).replace(/^\/+/, ''), prefix: '' };
  const block = ustarBlock({ ...main, size, mtime, type, linkname });
  if (!records.length) return block;
  const pax = Buffer.from(records.join(''), 'utf8');
  return Buffer.concat([
    ustarBlock({ name: 'PaxHeader/entry', size: pax.length, mtime, type: 'x' }),
    pax,
    Buffer.alloc(paddingFor(pax.length)),
    block,
  ]);
}

function parsePax(buf) {
  const out = {};
  let at = 0;
  while (at < buf.length) {
    const space = buf.indexOf(0x20, at);
    if (space === -1) throw new TarError('An entry has damaged extended details.');
    const lengthText = buf.toString('latin1', at, space);
    const length = Number(lengthText);
    if (!/^[0-9]+$/.test(lengthText) || length <= space - at || at + length > buf.length || buf[at + length - 1] !== 0x0a) {
      throw new TarError('An entry has damaged extended details.');
    }
    const record = buf.toString('utf8', space + 1, at + length - 1);
    const equals = record.indexOf('=');
    if (equals === -1) throw new TarError('An entry has damaged extended details.');
    out[record.slice(0, equals)] = record.slice(equals + 1);
    at += length;
  }
  return out;
}

export function parseHeader(block) {
  if (block.toString('latin1', 257, 262) !== 'ustar') throw new TarError('This is not a recognized archive.');
  if (readOctal(block, 148, 8) !== checksumOf(block)) throw new TarError('An entry has a damaged header.');
  const name = readText(block, 0, NAME_MAX);
  const prefix = readText(block, 345, PREFIX_MAX);
  return {
    name: prefix ? `${prefix}/${name}` : name,
    size: readSize(block),
    mtime: readOctal(block, 136, 12),
    type: block[156] === 0 ? '0' : String.fromCharCode(block[156]),
    linkname: readText(block, 157, NAME_MAX),
  };
}

// Reads an archive from a stream, holding at most one chunk at a time. `onEntry` gets each entry's
// details and returns a sink ({ write, end }) for its data, or nothing to skip the data. It throws
// to refuse the entry. Because each write is awaited, a slow disk slows the upload.
export async function readTar(source, onEntry) {
  const header = Buffer.alloc(BLOCK);
  let filled = 0;
  let zeros = 0;
  let finished = false;
  let pax = null;
  let current = null; // { remaining, pad, sink, paxChunks }

  const endData = async () => {
    if (current.paxChunks) pax = parsePax(Buffer.concat(current.paxChunks));
    else await current.sink?.end();
    current.paxChunks = null;
    current.sink = null;
    if (current.pad === 0) current = null;
  };

  const startEntry = async (block) => {
    const entry = parseHeader(block);
    if (entry.type === 'x') {
      if (pax) throw new TarError('An entry has damaged extended details.');
      if (entry.size > PAX_MAX) throw new TarError('An entry has too many extended details.');
      current = { remaining: entry.size, pad: paddingFor(entry.size), paxChunks: [] };
    } else {
      if (pax?.path !== undefined) entry.name = pax.path;
      if (pax?.size !== undefined) {
        if (!/^[0-9]+$/.test(pax.size) || !Number.isSafeInteger(Number(pax.size))) throw new TarError('An entry has an impossible size.');
        entry.size = Number(pax.size);
      }
      pax = null;
      const sink = await onEntry(entry);
      current = { remaining: entry.size, pad: paddingFor(entry.size), sink };
    }
    if (current.remaining === 0) await endData();
  };

  // destroyOnReturn is off so a refusal can leave the rest of the upload to drain.
  const chunks = typeof source.iterator === 'function' ? source.iterator({ destroyOnReturn: false }) : source;
  for await (const chunk of chunks) {
    let at = 0;
    while (at < chunk.length) {
      if (finished) {
        for (; at < chunk.length; at++) if (chunk[at] !== 0) throw new TarError('There is unexpected data after the end of the archive.');
        break;
      }
      if (current && current.remaining > 0) {
        const take = Math.min(current.remaining, chunk.length - at);
        const piece = chunk.subarray(at, at + take);
        if (current.paxChunks) current.paxChunks.push(Buffer.from(piece));
        else await current.sink?.write(piece);
        at += take;
        current.remaining -= take;
        if (current.remaining === 0) await endData();
        continue;
      }
      if (current) { // padding
        const take = Math.min(current.pad, chunk.length - at);
        at += take;
        current.pad -= take;
        if (current.pad === 0) current = null;
        continue;
      }
      const take = Math.min(BLOCK - filled, chunk.length - at);
      chunk.copy(header, filled, at, at + take);
      filled += take;
      at += take;
      if (filled < BLOCK) continue;
      filled = 0;
      if (header.every((b) => b === 0)) {
        zeros += 1;
        if (zeros === 2) {
          if (pax) throw new TarError('An entry has damaged extended details.');
          finished = true;
        }
        continue;
      }
      if (zeros) throw new TarError('There is unexpected data after the end of the archive.');
      await startEntry(header);
    }
  }
  if (!finished) throw new TarError('The archive ends too soon.', 'truncated');
}
