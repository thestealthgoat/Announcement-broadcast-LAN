import fs from 'node:fs';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

// The TV player and the server share one schedule file. It has to stay a plain script for
// old TV browsers, but package.json makes every .js here an ES module, so it can't go
// through require(). It is wrapped the way Node wraps a CommonJS file instead.
const file = fileURLToPath(new URL('../public/player/schedule.js', import.meta.url));
const loaded = { exports: {} };
vm.compileFunction(fs.readFileSync(file, 'utf8'), ['module'], { filename: file })(loaded);

export const { isActive, status, problem, parseWall, formatWall, localClock } = loaded.exports;

// The host computer's wall clock, which every schedule follows.
export const wallClock = (date = new Date()) => localClock(date);
