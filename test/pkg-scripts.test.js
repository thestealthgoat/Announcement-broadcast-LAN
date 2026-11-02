// The macOS installer's preinstall script. It must never be run as it is here: it would stop a real
// running copy of the app. So these tests run a copy where the process name is changed AND pkill and
// pgrep are replaced by stand-ins that act on one process this test started, by its PID. The real
// pkill is never run. What the real tools are asked to do is checked from the arguments they'd get.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { atEnd } from './helpers.js';

const POSIX = process.platform !== 'win32';
const SOURCE = path.join(import.meta.dirname, '..', 'build', 'pkg-scripts', 'preinstall');
const REAL_NAME = 'Network Signage';
const STAND_IN_NAME = 'signage-test-stand-in';
const SHORT_WAIT = 2;
const SHELLS = POSIX ? ['/bin/sh', '/bin/dash'].filter((s) => fs.existsSync(s)) : [];

function sandbox(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'signage-pkg-'));
  atEnd(t, () => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'calls.log');
  const pidFile = path.join(dir, 'pid');
  const stub = (name, body) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, `#!/bin/sh\necho "${name} $*" >> "${log}"\npid=$(cat "${pidFile}" 2>/dev/null)\n${body}\n`);
    fs.chmodSync(file, 0o755);
    return file;
  };
  const pkill = stub('pkill', 'if [ -z "$pid" ]; then exit 1; fi\nif [ "$1" = "-9" ]; then kill -9 "$pid"; else kill -TERM "$pid"; fi\nexit 0');
  const pgrep = stub('pgrep', 'if [ -z "$pid" ]; then exit 1; fi\nkill -0 "$pid" 2>/dev/null');
  const copy = fs.readFileSync(SOURCE, 'utf8')
    .replaceAll(REAL_NAME, STAND_IN_NAME)
    .replaceAll('/usr/bin/pkill', pkill)
    .replaceAll('/usr/bin/pgrep', pgrep)
    .replace(/WAIT_SECONDS=\d+/, `WAIT_SECONDS=${SHORT_WAIT}`);
  // The guard that keeps this file safe to run on a computer with the real app open.
  assert.ok(!copy.includes(REAL_NAME) && !copy.includes('/usr/bin/pkill') && !copy.includes('/usr/bin/pgrep'), 'the copy must not be able to reach a real process');
  const script = path.join(dir, 'preinstall-copy');
  fs.writeFileSync(script, copy);
  return { pidFile, script, calls: () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []) };
}

// Prints when it's ready, so a signal can't arrive before its handler is set.
async function standIn(t, onTerm) {
  const child = spawn(process.execPath, ['-e', `process.on('SIGTERM', () => { ${onTerm} }); setInterval(() => {}, 1000); console.log('ready');`], { stdio: ['ignore', 'pipe', 'ignore'] });
  atEnd(t, () => {
    try { child.kill('SIGKILL'); } catch {} // only the process this test started
  });
  const exited = new Promise((r) => child.once('exit', (code, signal) => r({ code, signal })));
  await new Promise((r) => child.stdout.once('data', r));
  return { child, exited };
}

const run = (shell, script) => new Promise((resolve) => {
  const start = Date.now();
  const p = spawn(shell, [script], { stdio: 'ignore' });
  p.once('exit', (code) => resolve({ code, ms: Date.now() - start }));
});

test('the real script names the real app exactly, waits about 20 seconds, and is plain POSIX sh', { skip: !POSIX }, () => {
  const source = fs.readFileSync(SOURCE, 'utf8');
  assert.match(source, /^#!\/bin\/sh\n/);
  assert.match(source, /APP_NAME="Network Signage"/);
  assert.match(source, /WAIT_SECONDS=20\n/);
  assert.match(source, /\/usr\/bin\/pkill -x "\$APP_NAME"/);
  assert.match(source, /\/usr\/bin\/pgrep -x "\$APP_NAME"/);
  assert.match(source, /\/usr\/bin\/pkill -9 -x "\$APP_NAME"/);
  assert.match(source, /\nexit 0\n$/);
  assert.doesNotMatch(source, /\[\[|function |\$\{[A-Za-z_]+\/|sleep 0\.|local /, 'nothing beyond POSIX sh');
  for (const shell of SHELLS) assert.equal(spawnSync(shell, ['-n', SOURCE]).status, 0, `${shell} can parse it`);
});

for (const shell of SHELLS) {
  test(`${shell}: nothing running means no waiting and a clean exit`, async (t) => {
    const { script, calls } = sandbox(t);
    const { code } = await run(shell, script);
    assert.equal(code, 0);
    assert.deepEqual(calls(), [`pkill -x ${STAND_IN_NAME}`, `pgrep -x ${STAND_IN_NAME}`]);
  });

  test(`${shell}: an app that quits when asked is not force-killed`, async (t) => {
    const { script, pidFile, calls } = sandbox(t);
    const { child, exited } = await standIn(t, 'process.exit(0);');
    fs.writeFileSync(pidFile, String(child.pid));
    const { code } = await run(shell, script);
    assert.equal(code, 0);
    assert.deepEqual(await exited, { code: 0, signal: null });
    assert.equal(calls().filter((c) => c.includes('-9')).length, 0);
  });

  test(`${shell}: an app that takes a moment to quit is waited for`, async (t) => {
    const { script, pidFile, calls } = sandbox(t);
    const { child, exited } = await standIn(t, 'setTimeout(() => process.exit(0), 1000);');
    fs.writeFileSync(pidFile, String(child.pid));
    let scriptDone = false;
    const running = run(shell, script).then((r) => { scriptDone = true; return r; });
    const result = await exited;
    assert.deepEqual(result, { code: 0, signal: null }, 'it left on its own');
    assert.equal(scriptDone, false, 'the script was still waiting when it left');
    assert.equal((await running).code, 0);
    assert.equal(calls().filter((c) => c.includes('-9')).length, 0);
  });

  test(`${shell}: an app that hangs on quit is force-killed by its exact name, and the script still exits 0`, async (t) => {
    const { script, pidFile, calls } = sandbox(t);
    const { child, exited } = await standIn(t, '/* hung, like 1.0.2 with a TV still streaming */');
    fs.writeFileSync(pidFile, String(child.pid));
    const { code, ms } = await run(shell, script);
    assert.equal(code, 0);
    assert.deepEqual(await exited, { code: null, signal: 'SIGKILL' });
    assert.ok(ms >= SHORT_WAIT * 1000 - 200, `waited ${ms} ms first`);
    assert.ok(calls().includes(`pkill -9 -x ${STAND_IN_NAME}`), calls().join('\n'));
    assert.equal(calls()[0], `pkill -x ${STAND_IN_NAME}`, 'asked nicely first');
  });
}
