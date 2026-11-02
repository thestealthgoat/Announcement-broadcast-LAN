// Finds out what this computer's ffmpeg can really do. Builds differ between
// platforms, and a listed hardware encoder may still fail, so encoders get a real test.
import { spawn } from 'node:child_process';
import { ENCODERS, encoderTestArgs } from './ffmpeg-args.js';

const TEST_ENCODE_MS = 15000;
const LIST_MS = 8000;

// Exact names only, because builds with no `srt` still list `srtp`.
export function parseProtocols(text) {
  const sections = { input: [], output: [] };
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const name = line.trim();
    if (/^Input:$/i.test(name)) current = sections.input;
    else if (/^Output:$/i.test(name)) current = sections.output;
    else if (current && name && !name.includes(' ')) current.push(name);
  }
  return sections;
}

export function parseEncoders(text) {
  const names = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*[VAS][F.][S.][X.][B.][D.]\s+(\S+)/);
    if (m && m[1] !== '=') names.push(m[1]);
  }
  return names;
}

function addUnique(list, name) {
  if (!list.includes(name)) list.push(name);
}

export function parseAvfoundationDevices(text) {
  const out = { video: [], audio: [] };
  let section = null;
  for (const line of String(text).split(/\r?\n/)) {
    const heading = line.match(/AVFoundation (video|audio) devices:/);
    if (heading) {
      section = heading[1];
      continue;
    }
    const m = line.match(/\]\s*\[\d+\]\s+(.+?)\s*$/);
    if (!section || !m) continue;
    // Screens are listed here too, and the host's desktop is not a capture input.
    if (section === 'video' && /^Capture screen \d+$/.test(m[1])) continue;
    addUnique(out[section], m[1]);
  }
  return out;
}

// Handles both styles: newer ffmpeg tags each device with its type, and older
// ffmpeg groups devices under "DirectShow video devices" headings.
export function parseDshowDevices(text) {
  const out = { video: [], audio: [] };
  let section = null;
  for (const line of String(text).split(/\r?\n/)) {
    if (/Alternative name/i.test(line)) continue;
    const heading = line.match(/DirectShow (video|audio) devices/i);
    if (heading) {
      section = heading[1].toLowerCase();
      continue;
    }
    const m = line.match(/"([^"]+)"(?:\s*\(([^)]*)\))?\s*$/);
    if (!m) continue;
    const kinds = m[2] ?? section ?? '';
    if (/video/i.test(kinds)) addUnique(out.video, m[1]);
    if (/audio/i.test(kinds)) addUnique(out.audio, m[1]);
  }
  return out;
}

function run(ffmpeg, args, { timeout, signal }) {
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, timeout, killSignal: 'SIGKILL', signal });
    } catch {
      return resolve({ code: -1, output: '' });
    }
    child.stdout.on('data', (d) => { output += d; });
    child.stderr.on('data', (d) => { output += d; });
    child.on('error', () => {});
    child.on('close', (code) => resolve({ code, output })); // code is null if the timeout killed it
  });
}

const cache = new Map(); // finished results by ffmpeg path, so each is probed once per run

// A busy computer can time out, and that says nothing about what ffmpeg supports. Treating it as
// "no RTMP, no SRT" would turn feeds off until a restart, so it's a failure, and never cached.
async function list(ffmpeg, flag, parse, isEmpty, opts) {
  const { code, output } = await run(ffmpeg, ['-hide_banner', flag], opts);
  const parsed = parse(output);
  if (code !== 0 || isEmpty(parsed)) throw new Error(`Could not list ffmpeg's ${flag.slice(1)}`);
  return parsed;
}

export async function probeCapabilities(ffmpeg, { signal, listMs = LIST_MS } = {}) {
  if (cache.has(ffmpeg)) return cache.get(ffmpeg);
  const opts = { timeout: listMs, signal };
  const protocols = await list(ffmpeg, '-protocols', parseProtocols, (p) => !p.input.length, opts);
  const listed = await list(ffmpeg, '-encoders', parseEncoders, (e) => !e.length, opts);
  const encoders = [];
  for (const id of Object.keys(ENCODERS)) {
    if (!listed.includes(id)) continue;
    const r = await run(ffmpeg, ['-hide_banner', '-nostdin', '-loglevel', 'error', ...encoderTestArgs(id)], { timeout: TEST_ENCODE_MS, signal });
    if (r.code === 0) encoders.push(id);
  }
  if (signal?.aborted) throw new Error('Probe stopped');
  const caps = {
    rtmp: protocols.input.includes('rtmp'),
    srt: protocols.input.includes('srt'),
    encoders,
    best: encoders[0] ?? null,
  };
  if (encoders.length) cache.set(ffmpeg, caps);
  return caps;
}

// Not cached: capture cards come and go.
export async function listDevices(ffmpeg, platform = process.platform, { signal } = {}) {
  const none = { supported: false, video: [], audio: [] };
  let format;
  if (platform === 'win32') format = { args: ['-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], parse: parseDshowDevices };
  else if (platform === 'darwin') format = { args: ['-f', 'avfoundation', '-list_devices', 'true', '-i', ''], parse: parseAvfoundationDevices };
  else return none;
  const { output } = await run(ffmpeg, ['-hide_banner', '-nostdin', ...format.args], { timeout: LIST_MS, signal });
  if (/Unknown input format/i.test(output)) return none;
  return { supported: true, ...format.parse(output) };
}
