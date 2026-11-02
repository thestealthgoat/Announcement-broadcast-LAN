// Moving between admin pages quickly: each view's timers must end, and the current view must be the
// page on screen.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createViewSlot } from '../public/admin/view-slot.js';

function view(name, log) {
  return { name, destroy: () => log.push(`destroy ${name}`) };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

test('a view that finishes loading after the person has moved on is destroyed, and never becomes current', async () => {
  const log = [];
  const ctx = { view: null };
  const show = createViewSlot(ctx);
  const slow = deferred();
  const fast = deferred();
  const first = show(() => slow.promise);
  const second = show(() => fast.promise);
  fast.resolve(view('fast', log));
  await second;
  assert.equal(ctx.view.name, 'fast');
  slow.resolve(view('slow', log));
  await first;
  assert.equal(ctx.view.name, 'fast', 'the late one did not take over');
  assert.deepEqual(log, ['destroy slow']);
});

test('moving on destroys the current view once, and nothing points at it while the next one loads', async () => {
  const log = [];
  const ctx = { view: null };
  const show = createViewSlot(ctx);
  await show(async () => view('a', log));
  const next = deferred();
  const showing = show(() => next.promise);
  assert.deepEqual(log, ['destroy a']);
  assert.equal(ctx.view, null, 'a refresh arriving now has nothing stale to call');
  const again = show(async () => view('c', log));
  assert.deepEqual(log, ['destroy a'], 'not destroyed a second time');
  next.resolve(view('b', log));
  await Promise.all([showing, again]);
  assert.equal(ctx.view.name, 'c');
  assert.deepEqual(log, ['destroy a', 'destroy b']);
});

test('a view with nothing to clean up, or that loads nothing, is fine', async () => {
  const ctx = { view: null };
  const show = createViewSlot(ctx);
  const stale = deferred();
  const first = show(() => stale.promise);
  await show(async () => undefined);
  assert.equal(ctx.view, null);
  stale.resolve({});
  await first;
  await show(async () => ({}));
  assert.deepEqual(ctx.view, {});
});

test('a view that fails to load still reports the failure when it is the current page, and only then', async () => {
  const ctx = { view: null };
  const show = createViewSlot(ctx);
  await assert.rejects(show(async () => { throw new Error('boom'); }), /boom/);
  const stale = deferred();
  const first = show(() => stale.promise);
  await show(async () => ({}));
  stale.reject(new Error('late'));
  await first; // nobody is looking at that page any more
});

test('the admin app really goes through the slot', () => {
  const app = fs.readFileSync(path.join(import.meta.dirname, '..', 'public', 'admin', 'app.js'), 'utf8');
  assert.match(app, /createViewSlot\(ctx\)/);
  assert.doesNotMatch(app, /ctx\.view = /, 'nothing else assigns the current view');
  assert.doesNotMatch(app, /ctx\.view\?\.destroy/, 'nothing else destroys it');
});
