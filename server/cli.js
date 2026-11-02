import path from 'node:path';
import os from 'node:os';
import { createServer } from './index.js';

const dataDir = process.env.SIGNAGE_DATA_DIR ?? path.join(os.homedir(), '.network-signage');
const port = Number(process.env.PORT ?? 8080);

const host = process.env.SIGNAGE_HOST ?? '0.0.0.0';
const STOP_TIMEOUT_MS = 15000;

// There's nothing here to start a new copy, so a restore finishes when someone starts this again.
async function exitForRestore() {
  console.log('A backup is ready to restore. Start Network Signage again to finish.');
  await Promise.race([server.stop().catch(() => {}), new Promise((r) => setTimeout(r, STOP_TIMEOUT_MS))]);
  process.exit(0);
}

const server = await createServer({ dataDir, port, host, logger: { level: process.env.LOG_LEVEL ?? 'warn' }, onRestart: exitForRestore });
const { urls } = await server.start();
console.log(`Network Signage is running.\n  Admin: ${urls[0]}/admin/\n  TVs:   ${urls[0]}/tv\n  Data:  ${dataDir}`);

// SIGHUP is a closed terminal, and on Windows a closed console window. Skipping cleanup would leave
// ffmpeg holding its port.
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    try {
      await server.stop();
    } catch (err) {
      console.error(err);
    }
    process.exit(0);
  });
}
