// Resets the password of an account with full access, from the host computer: npm run reset-admin -- <username>
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDb } from './db.js';
import { listAdmins, resetAdminPassword } from './recovery.js';

const dataDir = process.env.SIGNAGE_DATA_DIR ?? path.join(os.homedir(), '.network-signage');
const file = path.join(dataDir, 'signage.db');

function fail(message) {
  console.error(message);
  process.exit(1);
}

if (!fs.existsSync(file)) fail(`No signage data found in ${dataDir}. Set SIGNAGE_DATA_DIR to the right folder.`);

const db = openDb(file);
const admins = listAdmins(db);
if (!admins.length) fail('There are no admin accounts yet. Open the admin page to finish setup.');

const wanted = process.argv[2];
const usage = `Choose one: npm run reset-admin -- <username>\n${admins.map((a) => `  ${a.username} (${a.name})`).join('\n')}`;
if (!wanted && admins.length > 1) fail(usage);
const admin = wanted ? admins.find((a) => a.username.toLowerCase() === wanted.toLowerCase()) : admins[0];
if (!admin) fail(`${wanted} is not an admin.\n${usage}`);

const temp = await resetAdminPassword(db, admin.id);
db.close();
console.log(`Password reset for ${admin.username}.\nTemporary password: ${temp}\nSign in, then change it under Settings.`);
console.log('If sign-in was locked after too many attempts, wait 5 minutes or restart the server.');
