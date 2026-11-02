import path from 'node:path';
import os from 'node:os';
import { createServer } from './index.js';

const dataDir = process.env.SIGNAGE_DATA_DIR ?? path.join(os.homedir(), '.network-signage');
const port = Number(process.env.PORT ?? 8080);

const server = await createServer({ dataDir, port, logger: { level: process.env.LOG_LEVEL ?? 'warn' } });
const { urls } = await server.start();
console.log(`Network Signage is running.\n  Admin: ${urls[0]}/admin/\n  TVs:   ${urls[0]}/tv\n  Data:  ${dataDir}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    await server.stop();
    process.exit(0);
  });
}
