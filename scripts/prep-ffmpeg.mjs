// Downloads the ffmpeg build for an installer's target into bin/<platform>-<arch>/.
// electron-builder then ships it as a resource.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const [platform, arch] = process.argv.slice(2);
if (!platform || !arch) {
  console.error('usage: prep-ffmpeg <darwin|win32> <arm64|x64>');
  process.exit(1);
}
const meta = JSON.parse(fs.readFileSync('node_modules/ffmpeg-static/package.json', 'utf8'))['ffmpeg-static'];
const tag = meta['binary-release-tag'];
const dir = path.join('bin', `${platform}-${arch}`);
const out = path.join(dir, platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');
if (fs.existsSync(out)) {
  console.log(`${out} already present`);
  process.exit(0);
}
fs.mkdirSync(dir, { recursive: true });
const url = `https://github.com/eugeneware/ffmpeg-static/releases/download/${tag}/ffmpeg-${platform}-${arch}.gz`;
console.log(`Downloading ${url}`);
const res = await fetch(url);
if (!res.ok) throw new Error(`Download failed: ${res.status}`);
await pipeline(Readable.fromWeb(res.body), zlib.createGunzip(), fs.createWriteStream(out));
fs.chmodSync(out, 0o755);
const license = await fetch(`https://github.com/eugeneware/ffmpeg-static/releases/download/${tag}/${platform}-${arch}.LICENSE`);
if (license.ok) fs.writeFileSync(path.join(dir, 'ffmpeg.LICENSE'), Buffer.from(await license.arrayBuffer()));
console.log(`Saved ${out}`);
