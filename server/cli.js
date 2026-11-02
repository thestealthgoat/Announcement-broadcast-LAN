import path from 'node:path';
import os from 'node:os';
import { createServer } from './index.js';

const dataDir = process.env.SIGNAGE_DATA_DIR ?? path.join(os.homedir(), '.network-signage');
const port = Number(process.env.PORT ?? 8080);

const host = process.env.SIGNAGE_HOST; // Tests bind to loopback, which also keeps them off the network.

const server = await createServer({ dataDir, port, host, logger: { level: process.env.LOG_LEVEL ?? 'warn' } });
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
