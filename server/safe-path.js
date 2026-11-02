// Every path built from a database value goes through here. A database can come from a backup, so
// its values are treated like anything else from outside: a bad one has to fail here, not delete
// or overwrite whatever it happens to point at.
import path from 'node:path';

export class UnsafePathError extends Error {
  constructor(value) {
    super(`A saved name cannot be used as a file or folder: ${JSON.stringify(value)}`);
    this.name = 'UnsafePathError';
  }
}

// Holds the logo and font, and isn't any item's folder.
export const RESERVED_MEDIA_FOLDERS = new Set(['branding']);

// `name` as a direct child of `parent`, or a throw. Slashes, backslashes, and colons count on every
// platform, because the same database can be opened on Windows.
export function childPath(parent, name) {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[/\\:\0]/.test(name)) throw new UnsafePathError(name);
  const result = path.resolve(parent, name);
  if (path.dirname(result) !== path.resolve(parent)) throw new UnsafePathError(name);
  return result;
}

// One library item's folder.
export function mediaFolder(mediaDir, id) {
  if (RESERVED_MEDIA_FOLDERS.has(id)) throw new UnsafePathError(id);
  return childPath(mediaDir, id);
}
