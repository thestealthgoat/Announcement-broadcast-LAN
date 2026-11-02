import path from 'node:path';

// What a backup is made of, as a fixed list of names rather than "everything but". In the desktop
// app the data folder is also Electron's own folder, so caches, cookies, and lock files live there
// too, and they must stay out of a backup and stay put during a restore.
export const DB_NAME = 'signage.db';
export const CONFIG_NAME = 'config.json';
export const MEDIA_NAME = 'media';
export const MANIFEST_NAME = 'manifest.json';
export const CHECKSUMS_NAME = 'checksums.jsonl';

export const FORMAT = 'network-signage-backup';
export const FORMAT_VERSION = 1;
export const BACKUP_EXTENSION = '.signagebackup';

export const RESTORE_DIR = '.restore';
export const EXPORT_TMP_DIR = '.backup-tmp';

// Everything a swap moves. The WAL and SHM go too, as an old database isn't whole without its WAL.
export const SWAP_ITEMS = [DB_NAME, `${DB_NAME}-wal`, `${DB_NAME}-shm`, MEDIA_NAME, CONFIG_NAME];

export const restorePath = (dataDir, ...parts) => path.join(dataDir, RESTORE_DIR, ...parts);
