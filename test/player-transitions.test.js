import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Runs the real schedule.js, transitions.js, and player.js against a small stand-in for the
// browser, with time under the test's control. No transitionend ever fires here, on purpose.
// Every style write is recorded, so a test can see how a transition starts and finishes.
const dir = path.join(import.meta.dirname, '..', 'public', 'player');
const read = (f) => fs.readFileSync(path.join(dir, f), 'utf8');
const scripts = ['schedule.js', 'transitions.js', 'player.js'].map((f) => new vm.Script(read(f), { filename: f }));

function element(tag, dropped) {
  const log = [];
  const el = {
    tagName: tag.toUpperCase(), children: [], parentNode: null, className: '', hidden: false, textContent: '', log,
    get offsetWidth() { log.push('flush'); return 0; },
    set innerHTML(_) { for (const c of [...el.children]) el.removeChild(c); },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { c.parentNode = null; el.children.splice(el.children.indexOf(c), 1); return c; },
    setAttribute() {}, removeAttribute() {},
    listeners: {},
    addEventListener(name, fn) { el.listeners[name] = fn; },
  };
  // Like a real browser, a style this one doesn't understand is thrown away.
  el.style = new Proxy({}, {
    set(target, prop, value) {
      if (dropped.has(prop)) return true;
      target[prop] = value;
      log.push([prop, value]);
      return true;
    },
  });
  if (tag === 'video') {
    Object.assign(el, {
      paused: true, muted: true, currentTime: 0, duration: 100, plays: 0,
      canPlayType: () => '', load() {},
      play() { el.paused = false; el.plays += 1; },
      pause() { el.paused = true; },
    });
  }
  return el;
}

const text = (el) => [el.textContent, ...el.children.map(text)].join('');

function boot({ unsupported = [] } = {}) {
  const dropped = new Set(unsupported);
  const create = (tag) => element(tag, dropped);
  const els = { stage: create('div'), message: create('div'), hint: create('div') };
  const sockets = [];
  class FakeSocket {
    constructor() { this.readyState = 1; sockets.push(this); }
    send() {}
    close() { this.readyState = 3; }
  }
  const env = {
    document: {
      cookie: '', documentElement: create('html'), getElementById: (id) => els[id], createElement: create,
      getElementsByTagName: () => [create('head')], addEventListener() {},
    },
    location: { pathname: '/play/main', search: '', host: 'tv.test', protocol: 'http:', reload() {}, replace() {} },
    localStorage: { getItem: () => null, setItem() {} },
    navigator: {}, screen: { height: 1080 }, innerHeight: 1080, isSecureContext: false, WebSocket: FakeSocket,
    Date, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  env.window = env;
  const context = vm.createContext(env);
  for (const s of scripts) s.runInContext(context);
  const layers = () => els.stage.children.filter((c) => c.className === 'layer');
  const visible = () => layers().filter((l) => l.style.visibility === 'visible');
  return {
    receive: (msg) => sockets[sockets.length - 1].onmessage({ data: JSON.stringify(msg) }),
    layers,
    visible,
    named: (name) => visible().find((l) => text(l) === name),
    hidden: () => layers().filter((l) => l.style.visibility !== 'visible'),
    idle: () => els.stage.children.some((c) => c.className === 'idle' && c.style.display !== 'none'),
    Transitions: env.SignageTransitions,
  };
}

const slide = (name, transition, transitionMs, duration = 10) => ({
  key: name, mediaId: name, type: 'text', name, title: name, transition, transitionMs, audio: false, duration, schedule: null,
});
const video = (name, transition, transitionMs, duration = 10) => ({ ...slide(name, transition, transitionMs, duration), type: 'video', src: `/media/${name}/v.mp4` });
const state = (slides, more = {}) => ({ type: 'state', clock: '2026-11-02T12:00:00', channel: { id: 1, slug: 'main', name: 'Main' }, slides, override: null, ...more });

function clock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.UTC(2026, 10, 2, 12) });
  return (ms) => t.mock.timers.tick(ms);
}

// What happened to a layer's style, leaving out prefixed copies and the player's own bookkeeping.
const writes = (layer) => layer.log.filter((w) => w === 'flush' || !/^webkit|^zIndex$|^visibility$/.test(w[0]));
const prefixed = (layer, prop) => layer.log.filter((w) => w[0] === prop).map((w) => w[1]);

const moves = (props, ms) => props.flatMap((p) => ({
  opacity: [`opacity ${ms}ms ease`],
  transform: [`-webkit-transform ${ms}ms ease`, `transform ${ms}ms ease`],
  clipPath: [`-webkit-clip-path ${ms}ms ease`, `clip-path ${ms}ms ease`],
}[p])).join(', ');

const T_X = (v) => `translateX(${v})`;
const T_Y = (v) => `translateY(${v})`;
const SHOWN = 'inset(0 0 0 0)';

// Each transition: the incoming layer's start and end, and how the outgoing layer leaves, if it moves.
const EXPECTED = {
  fade: { from: { opacity: '0' }, to: { opacity: '1' } },
  slide: { from: { transform: T_X('100%') }, to: { transform: T_X('0') }, out: { transform: T_X('-100%') } },
  'push-left': { from: { transform: T_X('100%') }, to: { transform: T_X('0') }, out: { transform: T_X('-100%') } },
  'push-right': { from: { transform: T_X('-100%') }, to: { transform: T_X('0') }, out: { transform: T_X('100%') } },
  'push-up': { from: { transform: T_Y('100%') }, to: { transform: T_Y('0') }, out: { transform: T_Y('-100%') } },
  'push-down': { from: { transform: T_Y('-100%') }, to: { transform: T_Y('0') }, out: { transform: T_Y('100%') } },
  'wipe-left': { from: { clipPath: 'inset(0 0 0 100%)' }, to: { clipPath: SHOWN } },
  'wipe-right': { from: { clipPath: 'inset(0 100% 0 0)' }, to: { clipPath: SHOWN } },
  'wipe-up': { from: { clipPath: 'inset(100% 0 0 0)' }, to: { clipPath: SHOWN } },
  'wipe-down': { from: { clipPath: 'inset(0 0 100% 0)' }, to: { clipPath: SHOWN } },
  zoom: { from: { transform: 'scale(0.7)', opacity: '0' }, to: { transform: 'scale(1)', opacity: '1' } },
};

for (const [name, want] of Object.entries(EXPECTED)) {
  test(`${name}: starts, animates, and cleans up with no transitionend`, (t) => {
    const pass = clock(t);
    const tv = boot();
    tv.receive(state([slide('A', 'cut', 700), slide('B', name, 1000)]));
    pass(10000);
    const incoming = tv.named('B');
    const outgoing = tv.named('A');
    assert.ok(incoming && outgoing, 'both are on screen during the transition, so there is no blank frame');
    assert.ok(Number(incoming.style.zIndex) > Number(outgoing.style.zIndex), 'the new one is on top');

    // The start is set and takes effect before the transition is, then the end sets it moving.
    const props = Object.keys(want.to);
    assert.deepEqual(writes(incoming), [
      ...Object.entries(want.from),
      'flush',
      ['transition', moves(props, 1000)],
      ...Object.entries(want.to),
    ]);
    if (want.out) {
      assert.deepEqual(writes(outgoing), [['transition', moves(['transform'], 1000)], ...Object.entries(want.out)]);
      assert.deepEqual(prefixed(outgoing, 'webkitTransform'), [want.out.transform], 'prefixed for old TVs');
    } else {
      assert.deepEqual(writes(outgoing), [], 'the old slide holds still underneath');
    }
    if (want.to.transform) assert.deepEqual(prefixed(incoming, 'webkitTransform'), [want.from.transform, want.to.transform]);
    if (want.to.clipPath) assert.deepEqual(prefixed(incoming, 'webkitClipPath'), [want.from.clipPath, want.to.clipPath]);

    pass(1000);
    assert.ok(tv.named('A'), 'still there as the transition finishes');
    pass(100);
    assert.equal(tv.named('A'), undefined, 'gone without any event');
    assert.equal(outgoing.parentNode, null);
    assert.deepEqual(tv.visible(), [incoming]);
    for (const prop of ['transition', 'webkitTransition', 'transform', 'webkitTransform', 'clipPath', 'webkitClipPath', 'opacity']) {
      assert.ok(!incoming.style[prop], `${prop} is cleared once it is finished`);
    }
  });
}

test('nothing waits for transitionend or animates "all"', () => {
  for (const file of ['player.js', 'transitions.js']) {
    const code = read(file).replace(/\/\/.*$/gm, '');
    assert.doesNotMatch(code, /transitionend|'all /, file);
  }
});

test('cut is instant: no animation, no timer, and the old slide leaves at once', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state([slide('A', 'cut', 700), slide('B', 'cut', 2000)]));
  const a = tv.named('A');
  pass(10000);
  assert.deepEqual(tv.visible().map(text), ['B'], 'with no time passing after the swap');
  assert.equal(a.parentNode, null);
  assert.deepEqual(writes(tv.named('B')), []);
});

test('the first slide appears with no transition, because there is nothing to move from', (t) => {
  clock(t);
  const tv = boot();
  tv.receive(state([slide('A', 'zoom', 700)]));
  assert.deepEqual(writes(tv.named('A')), []);
});

test('an upgraded item fades over 700 ms exactly as before', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state([slide('A', 'fade', 700), slide('B', 'fade', 700)]));
  const a = tv.named('A');
  pass(10000);
  const b = tv.named('B');
  assert.equal(b.style.opacity, '1');
  assert.deepEqual(writes(b).slice(0, 3), [['opacity', '0'], 'flush', ['transition', 'opacity 700ms ease']]);
  pass(799);
  assert.ok(a.parentNode, 'the old timing: 700 ms plus 100');
  pass(1);
  assert.equal(a.parentNode, null);
});

test('a state saved before transitions had speeds, with no speed at all, still gets 700 ms', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state([slide('A', 'fade'), slide('B', 'slide')]));
  pass(10000);
  assert.deepEqual(writes(tv.named('B'))[2], ['transition', moves(['transform'], 700)]);
});

test('a name or speed this player does not know falls back to a 700 ms fade', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state([slide('A', 'cut'), slide('B', 'spiral', 50), slide('C', 'constructor', 'fast')]));
  pass(10000);
  assert.deepEqual(writes(tv.named('B')).slice(0, 3), [['opacity', '0'], 'flush', ['transition', 'opacity 700ms ease']]);
  pass(10000);
  assert.deepEqual(writes(tv.named('C')).slice(0, 3), [['opacity', '0'], 'flush', ['transition', 'opacity 700ms ease']]);
});

for (const name of ['wipe-left', 'wipe-right', 'wipe-up', 'wipe-down']) {
  test(`${name} becomes a fade at the same speed where clip-path is missing`, (t) => {
    const pass = clock(t);
    const tv = boot({ unsupported: ['clipPath', 'webkitClipPath'] });
    tv.receive(state([slide('A', 'cut'), slide('B', name, 350)]));
    const a = tv.named('A');
    pass(10000);
    assert.equal(tv.Transitions.playable(name), 'fade');
    assert.deepEqual(writes(tv.named('B')), [['opacity', '0'], 'flush', ['transition', 'opacity 350ms ease'], ['opacity', '1']]);
    pass(450);
    assert.equal(a.parentNode, null, 'and is still cleaned up');
    assert.deepEqual(tv.visible().map(text), ['B']);
  });
}

test('a browser with only the prefixed clip-path still gets the wipe', (t) => {
  const pass = clock(t);
  const tv = boot({ unsupported: ['clipPath'] });
  tv.receive(state([slide('A', 'cut'), slide('B', 'wipe-up', 700)]));
  pass(10000);
  assert.deepEqual(prefixed(tv.named('B'), 'webkitClipPath'), ['inset(100% 0 0 0)', SHOWN]);
});

test('with no transforms at all, push, slide, and zoom become fades too', (t) => {
  clock(t);
  const tv = boot({ unsupported: ['transform', 'webkitTransform'] });
  for (const name of ['push-up', 'slide', 'zoom']) assert.equal(tv.Transitions.playable(name), 'fade', name);
  assert.equal(tv.Transitions.playable('wipe-up'), 'wipe-up', 'a wipe does not need them');
  assert.equal(tv.Transitions.playable('cut'), 'cut');
});

test('a video coming in starts straight away, and one going out plays on until it is removed', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state([video('A', 'cut', 700), video('B', 'push-up', 1000)]));
  tv.hidden()[0].children[0].listeners.canplay();
  const oldVideo = tv.visible()[0].children[0];
  assert.equal(oldVideo.plays, 1);
  pass(10000);
  tv.hidden()[0].children[0].listeners.canplay();
  const incoming = tv.visible().find((l) => l.children[0] !== oldVideo);
  const newVideo = incoming.children[0];
  assert.equal(newVideo.plays, 1, 'playing from the first frame of the transition');
  assert.equal(oldVideo.paused, false, 'never frozen under the new slide');
  pass(1099);
  assert.equal(oldVideo.paused, false);
  assert.ok(oldVideo.parentNode.parentNode, 'still on screen');
  pass(1);
  assert.equal(oldVideo.paused, true);
  assert.equal(oldVideo.parentNode.parentNode, null, 'stopped and removed in the same moment');
  assert.equal(newVideo.paused, false);
});

test('a slide replaced in the middle of its own transition is not snapped back', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state([slide('A', 'cut', 700, 5), slide('B', 'fade', 2000, 1), slide('C', 'push-left', 2000, 60)]));
  pass(5000); // B starts fading in
  const b = tv.named('B');
  pass(1000); // C arrives while B is still on its way in
  assert.equal(b.style.transform, T_X('-100%'));
  pass(1100); // B's own timer has fired
  assert.equal(b.style.transform, T_X('-100%'), 'B keeps moving out');
  assert.ok(b.parentNode);
  pass(1000);
  assert.equal(b.parentNode, null);
  assert.deepEqual(tv.visible().map(text), ['C']);
});

test('nothing is left behind when the idle screen takes over mid-transition', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state([slide('A', 'cut'), slide('B', 'zoom', 2000)]));
  pass(10000);
  assert.equal(tv.visible().length, 2);
  tv.receive(state([]));
  assert.equal(tv.idle(), true);
  assert.deepEqual(tv.layers(), [], 'the slide on its way out does not cover the idle screen');
  pass(5000);
  assert.deepEqual(tv.layers(), []);
});

test('an override cuts straight in and takes over right away, even mid-transition', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state([slide('A', 'cut'), slide('B', 'push-up', 2000)]));
  pass(10000);
  const b = tv.named('B');
  const override = { id: 9, slides: [slide('STORM', 'cut')], remainingMs: null };
  tv.receive(state([slide('A', 'cut'), slide('B', 'push-up', 2000)], { override }));
  const storm = tv.named('STORM');
  assert.ok(Number(storm.style.zIndex) > Number(tv.named('A').style.zIndex), 'above anything still leaving');
  assert.equal(b.parentNode, null, 'the slide it replaced is gone at once');
  assert.deepEqual(writes(storm), []);
  pass(2100);
  assert.deepEqual(tv.visible(), [storm]);
});

test('no layers pile up after 50 swaps of every kind, including faster than the transitions', (t) => {
  for (const [duration, label] of [[10, 'normal'], [1, 'each slide shorter than its transition']]) {
    t.mock.timers.reset();
    const pass = clock(t);
    const tv = boot();
    const names = ['cut', ...Object.keys(EXPECTED)];
    tv.receive(state(names.map((n, i) => slide(`S${i}`, n, 2000, duration))));
    let swaps = 0;
    let last = tv.visible().at(-1);
    while (swaps < 50) {
      for (let i = 0; i < duration * 10; i++) pass(100);
      const top = tv.visible().at(-1);
      assert.notEqual(top, last, 'it moved on');
      last = top;
      swaps += 1;
      assert.ok(tv.layers().length <= 5, `${label}: ${tv.layers().length} layers at swap ${swaps}`);
      assert.ok(tv.hidden().length <= 1, 'at most one slide loading ahead');
    }
    // Long enough for every transition to end, but not for the next slide to arrive.
    tv.receive(state([slide('last', 'cut', 700, 600)]));
    pass(2100);
    assert.deepEqual(tv.visible().map(text), ['last'], label);
    assert.equal(tv.layers().length, 1, label);
  }
});

test('the player, the admin, and the service worker all get the file', () => {
  const page = read('index.html');
  assert.ok(page.indexOf('/player/transitions.js') > 0);
  assert.ok(page.indexOf('/player/transitions.js') < page.indexOf('/player/player.js'), 'loaded before the player');
  const admin = fs.readFileSync(path.join(dir, '..', 'admin', 'index.html'), 'utf8');
  assert.ok(admin.indexOf('/player/transitions.js') < admin.indexOf('/admin/app.js'), 'loaded before the admin');
  assert.match(read('sw.js'), /indexOf\('\/player\/'\) === 0/, 'everything under /player/ is kept for offline use');
});
