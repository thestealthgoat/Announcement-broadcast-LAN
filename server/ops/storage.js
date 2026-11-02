const GB = 1024 ** 3;
export const LOW_FREE_BYTES = 2 * GB;
export const LOW_FREE_RATIO = 0.1;

export const isLowStorage = (free, total) => free < LOW_FREE_BYTES || free / total < LOW_FREE_RATIO;

export function formatBytes(bytes) {
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

// Reads free space on the ticker, so requests only ever see the last reading.
export function createStorageWatcher({ dataDir, statfs, onChange = () => {} }) {
  let snapshot = null;
  return {
    async check() {
      const s = await statfs(dataDir);
      const free = s.bavail * s.bsize;
      const total = s.blocks * s.bsize;
      if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) return;
      const low = isLowStorage(free, total);
      const changed = !!snapshot?.low !== low;
      snapshot = { free, total, low };
      if (changed) onChange();
    },
    snapshot: () => snapshot,
  };
}
