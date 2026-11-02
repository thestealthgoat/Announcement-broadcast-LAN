import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// The player, the admin preview, and the server share one transitions file. It stays a plain
// script for old TV browsers, so it is loaded the same way server/schedule.js loads schedule.js.
const file = fileURLToPath(new URL('../public/player/transitions.js', import.meta.url));
const loaded = { exports: {} };
vm.compileFunction(fs.readFileSync(file, 'utf8'), ['module'], { filename: file })(loaded);

export const { DEFAULT_MS, SPEEDS, isValid, isValidMs, resolve, speedName } = loaded.exports;
