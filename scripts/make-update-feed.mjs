// Writes the files the in-app updater reads from a release: latest-mac.yml and latest.yml. They list
// each download with its checksum, and the updater refuses a download that doesn't match. Both Mac
// architectures share one file, and the updater picks the right entry by the name.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const TARGETS = {
  mac: { feed: 'latest-mac.yml', files: (v) => [`Network-Signage-${v}-mac-arm64.zip`, `Network-Signage-${v}-mac-x64.zip`] },
  win: { feed: 'latest.yml', files: (v) => [`Network-Signage-${v}-win-x64.exe`] },
};

export function updateFeed(dir, version, names, now = new Date()) {
  const files = names.map((name) => {
    const bytes = fs.readFileSync(path.join(dir, name));
    return { name, sha512: createHash('sha512').update(bytes).digest('base64'), size: bytes.length };
  });
  return [
    `version: ${version}`,
    'files:',
    ...files.flatMap((f) => [`  - url: ${f.name}`, `    sha512: ${f.sha512}`, `    size: ${f.size}`]),
    `path: ${files[0].name}`,
    `sha512: ${files[0].sha512}`,
    `releaseDate: '${now.toISOString()}'`,
    '',
  ].join('\n');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const target = TARGETS[process.argv[2]];
  if (!target) throw new Error('Say which feed to make: mac or win');
  const dir = path.resolve(process.argv[3] ?? 'dist');
  const { version } = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  fs.writeFileSync(path.join(dir, target.feed), updateFeed(dir, version, target.files(version)));
  console.log(`Wrote ${target.feed}`);
}
