// Small version comparer for release tags like v1.0.10 or 1.1.0-beta.2.
const VERSION_RE = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:-([0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*))?$/;

export function parseVersion(value) {
  if (typeof value !== 'string' || value.length > 64) return null;
  const m = value.trim().match(VERSION_RE);
  if (!m) return null;
  return { numbers: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ?? null, text: value.trim().replace(/^v/, '') };
}

function comparePre(a, b) {
  if (a === b) return 0;
  if (a === null) return 1; // 1.1.0 is newer than 1.1.0-beta.1
  if (b === null) return -1;
  const x = a.split(/[.-]/);
  const y = b.split(/[.-]/);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    const xNum = /^\d+$/.test(x[i]);
    const yNum = /^\d+$/.test(y[i]);
    if (xNum && yNum && Number(x[i]) !== Number(y[i])) return Number(x[i]) < Number(y[i]) ? -1 : 1;
    if (xNum !== yNum) return xNum ? -1 : 1;
    if (!xNum && x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

// Returns -1, 0 or 1, or null when either side is not a version.
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x.numbers[i] !== y.numbers[i]) return x.numbers[i] < y.numbers[i] ? -1 : 1;
  }
  return comparePre(x.pre, y.pre);
}

export const isNewer = (candidate, current) => compareVersions(candidate, current) === 1;
