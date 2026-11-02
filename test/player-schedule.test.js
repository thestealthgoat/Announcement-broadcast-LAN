import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Runs the real player.js and schedule.js against a tiny stand-in for the browser, with time
// under the test's control. Text slides appear at once; images wait until the test says they
// loaded. This covers the player's choices; real browsers and TVs are a separate check.
const dir = path.join(import.meta.dirname, '..', 'public', 'player');
const scripts = ['schedule.js', 'slide-render.js', 'transitions.js', 'player.js'].map((f) => new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f }));

function element(tag) {
  const el = {
    tagName: tag.toUpperCase(), style: {}, children: [], parentNode: null, className: '', hidden: false, offsetWidth: 0, textContent: '',
    set innerHTML(_) { for (const c of [...el.children]) el.removeChild(c); },
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { c.parentNode = null; el.children.splice(el.children.indexOf(c), 1); return c; },
    setAttribute() {}, removeAttribute() {}, listeners: {},
    addEventListener(type, fn) { (el.listeners[type] ??= []).push(fn); },
    fire(type) { for (const fn of el.listeners[type] ?? []) fn(); },
    play() { el.paused = false; }, pause() { el.paused = true; }, load() {},
  };
  return el;
}

const text = (el) => [el.textContent, el.src ?? '', ...el.children.map(text)].join('');
const image = (el) => (el.tagName === 'IMG' ? el : el.children.map(image).find(Boolean));

function boot(storage = new Map(), { native = '', Hls, indexedDB, XMLHttpRequest } = {}) {
  const head = element('head');
  const videos = [];
  const els = { stage: element('div'), message: element('div'), hint: element('div') };
  const sockets = [];
  class FakeSocket {
    constructor() { this.readyState = 1; this.sent = []; sockets.push(this); }
    send(m) { this.sent.push(JSON.parse(m)); }
    close() { this.readyState = 3; this.onclose?.(); }
  }
  const env = {
    document: {
      cookie: '', documentElement: element('html'), getElementById: (id) => els[id],
      createElement(tag) {
        const el = element(tag);
        if (tag === 'video') {
          el.canPlayType = () => native;
          videos.push(el);
        }
        return el;
      },
      getElementsByTagName: () => [head], addEventListener() {},
    },
    location: { pathname: '/play/main', search: '', host: 'tv.test', protocol: 'http:', reload() {}, replace() {} },
    localStorage: { getItem: (k) => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, v) },
    navigator: {}, screen: { height: 1080 }, innerHeight: 1080, isSecureContext: false, WebSocket: FakeSocket,
    Date, setTimeout, clearTimeout, setInterval, clearInterval,
  };
  if (Hls) env.Hls = Hls;
  if (indexedDB) env.indexedDB = indexedDB;
  if (XMLHttpRequest) env.XMLHttpRequest = XMLHttpRequest;
  env.window = env;
  const context = vm.createContext(env);
  for (const s of scripts) s.runInContext(context);
  const socket = () => sockets[sockets.length - 1];
  const layers = () => els.stage.children.filter((c) => c.className === 'layer');
  const visible = () => layers().filter((l) => l.style.visibility === 'visible');
  return {
    storage,
    env,
    videos,
    scripts: () => head.children.filter((c) => c.tagName === 'SCRIPT'),
    heartbeats: () => socket().sent.filter((m) => m.type === 'hb'),
    receive: (msg) => socket().onmessage({ data: JSON.stringify(msg) }),
    dropNetwork: () => socket().close(),
    // The slide on screen, or null for the idle screen.
    showing() {
      const up = visible();
      assert.ok(up.length <= 1, 'one slide at a time');
      return up.length ? text(up[0]) : null;
    },
    layer: () => visible()[0],
    loading: () => layers().filter((l) => l.style.visibility !== 'visible').map(text),
    loadingLayers: () => layers().filter((l) => l.style.visibility !== 'visible'),
    imageLoaded() { image(layers().find((l) => l.style.visibility !== 'visible')).onload(); },
    idle: () => els.stage.children.some((c) => c.className === 'idle' && c.style.display !== 'none'),
  };
}

const slide = (name, schedule = null, duration = 600) => ({
  key: name, mediaId: name, type: 'text', name, title: name, transition: 'cut', audio: false, duration, schedule,
});
const picture = (name, schedule = null, duration = 600) => ({ ...slide(name, schedule, duration), type: 'image', src: name });
const state = (clock, slides, more = {}) => ({ type: 'state', clock, channel: { id: 1, slug: 'main', name: 'Main' }, slides, override: null, ...more });
const before = (time) => ({ startTime: '00:00', endTime: time }); // on from midnight until this time
const after = (time) => ({ startTime: time, endTime: '23:59' });

function clock(t) {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout', 'setInterval'], now: Date.UTC(2031, 5, 15, 3, 0, 0) }); // the TV's own clock is years out
  return (seconds) => t.mock.timers.tick(seconds * 1000);
}

test('the TV follows the host clock, not its own', (t) => {
  clock(t);
  const tv = boot();
  tv.receive(state('2026-11-02T12:00:00', [slide('off', before('11:00')), slide('on', after('11:00'))]));
  assert.equal(tv.showing(), 'on');
});

test('a countdown runs on the host clock, not the TV\'s, and ends plainly', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state('2026-11-02T11:59:50', [{ ...slide('Kickoff'), style: { countdown: '2026-11-02T12:00' } }]));
  assert.equal(tv.showing(), 'Kickoff00:10');
  pass(4);
  assert.equal(tv.showing(), 'Kickoff00:06');
  pass(10);
  assert.equal(tv.showing(), "Kickoff" + "Time's up");
});

test('a schedule ending mid-slide moves on within about 15 seconds, without waiting out the duration', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state('2026-11-02T11:59:50', [slide('A', before('12:00')), slide('B')]));
  assert.equal(tv.showing(), 'A');
  pass(9);
  assert.equal(tv.showing(), 'A');
  pass(16);
  assert.equal(tv.showing(), 'B');
});

test('a slide playing is left alone when other slides come and go', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state('2026-11-02T11:59:50', [slide('A', null, 60), slide('B', after('12:00')), slide('C', before('12:00'))]));
  assert.equal(tv.showing(), 'A');
  const playing = tv.layer();
  pass(30); // B has started, C has ended
  assert.equal(tv.layer(), playing, 'same slide, not restarted');
  pass(25);
  assert.equal(tv.layer(), playing, 'and it still gets its full time');
  assert.deepEqual(tv.loading(), ['B'], 'the new slide is the next one up, not the ended one');
  pass(5);
  assert.equal(tv.showing(), 'B');
});

test('an unchanged list never triggers a reconcile, so what is loading stays loading', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state('2026-11-02T12:00:00', [slide('A', null, 20), slide('B', after('09:00'))]));
  pass(13); // within the preload lead, so B is loading
  assert.deepEqual(tv.loading(), ['B']);
  const [loading] = tv.loadingLayers();
  pass(4); // a schedule check has passed with nothing changed
  assert.equal(tv.loadingLayers()[0], loading, 'the same load, not a fresh one');
  assert.equal(tv.showing(), 'A');
  pass(4);
  assert.equal(tv.showing(), 'B');
});

test('with nothing on, the idle screen shows; it clears when something starts', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state('2026-11-02T11:59:50', [slide('A', before('12:00'))]));
  assert.equal(tv.showing(), 'A');
  pass(25);
  assert.equal(tv.showing(), null);
  assert.equal(tv.idle(), true);

  tv.receive(state('2026-11-02T12:00:50', [slide('A', after('12:01'))]));
  assert.equal(tv.idle(), true);
  pass(25);
  assert.equal(tv.showing(), 'A');
  assert.equal(tv.idle(), false);
});

test('rotation stays in order as the list changes size', (t) => {
  const pass = clock(t);
  const tv = boot();
  // A leaves while B plays. Going by the old index would pick B again.
  tv.receive(state('2026-11-02T11:59:50', [slide('A', before('12:00'), 10), slide('B', null, 30), slide('C', null, 30)]));
  assert.equal(tv.showing(), 'A');
  pass(10);
  assert.equal(tv.showing(), 'B');
  pass(30);
  assert.equal(tv.showing(), 'C');
  pass(30);
  assert.equal(tv.showing(), 'B', 'A is gone, so C wraps to B');

  // A slide before the current one starts, and the rotation still follows the playlist order.
  const tv2 = boot();
  tv2.receive(state('2026-11-02T11:59:50', [slide('X', after('12:00')), slide('Y', null, 30), slide('Z', null, 30)]));
  assert.equal(tv2.showing(), 'Y');
  pass(30);
  assert.equal(tv2.showing(), 'Z');
  pass(30);
  assert.equal(tv2.showing(), 'X', 'wraps to the newly started first slide');
});

test('when the current slide ends, the next one after it in the playlist takes over', (t) => {
  const pass = clock(t);
  const tv = boot();
  // At noon B ends and E starts ahead of it. B was number 2 of the old list, but number 2 of the new one is A.
  tv.receive(state('2026-11-02T11:59:30', [slide('E', after('12:00')), slide('A', null, 10), slide('B', before('12:00')), slide('C'), slide('D')]));
  assert.equal(tv.showing(), 'A');
  pass(10);
  assert.equal(tv.showing(), 'B');
  pass(25);
  assert.equal(tv.showing(), 'C');
});

// Sets up the moment a schedule check lands while the next slide is still loading: the check
// runs at 30 seconds, which is noon, and A's 5 seconds run out at 29.
function loadingAtNoon(t, slides) {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state('2026-11-02T11:59:30', [slide('Z')]));
  pass(24);
  tv.receive(state('2026-11-02T11:59:54', slides));
  assert.equal(tv.showing(), 'A');
  pass(5);
  assert.equal(tv.showing(), 'A', 'A stays up until the next slide is ready');
  assert.equal(tv.loading()[0], 'P');
  return { tv, pass };
}

test('a slide that ends while it is still loading never appears', (t) => {
  const { tv, pass } = loadingAtNoon(t, [slide('A', null, 5), picture('P', before('12:00')), slide('C')]);
  const late = tv.loadingLayers()[0];
  pass(1);
  assert.equal(tv.showing(), 'C');
  image(late).onload();
  assert.equal(tv.showing(), 'C', 'its late arrival changes nothing');
  assert.deepEqual(tv.loading(), [], 'and it is cleaned up');
});

test('the rotation stays right when the list changes while a slide is loading', (t) => {
  const { tv, pass } = loadingAtNoon(t, [slide('A', null, 5), picture('P', null, 10), slide('C'), slide('X', after('12:00'))]);
  pass(1); // X joins the list while P loads
  assert.equal(tv.showing(), 'A');
  tv.imageLoaded();
  assert.equal(tv.showing(), 'P');
  pass(10);
  assert.equal(tv.showing(), 'C', 'P does not play twice');
});

test('a prepared slide that times out does not leave a hidden layer behind', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state('2026-11-02T12:00:00', [slide('A', null, 20), picture('P')]));
  pass(21);
  assert.deepEqual(tv.loading(), ['P'], 'only the retry is left');
});

test('only active slides are prepared ahead of time', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state('2026-11-02T12:00:00', [slide('A', null, 10), slide('off', before('09:00')), slide('C', null, 10)]));
  pass(5);
  assert.deepEqual(tv.loading(), ['C']);
  pass(5);
  assert.equal(tv.showing(), 'C');
  pass(5);
  assert.deepEqual(tv.loading(), ['A']);
});

test('a slide that stops being on while it is prepared is dropped, not shown', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state('2026-11-02T11:59:50', [slide('A', null, 20), slide('B', before('12:00')), slide('C')]));
  pass(13);
  assert.deepEqual(tv.loading(), ['B']);
  pass(4); // B ended
  assert.deepEqual(tv.loading(), ['C']);
  assert.equal(tv.showing(), 'A');
  pass(4);
  assert.equal(tv.showing(), 'C');
});

test('schedules keep working with the network down', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state('2026-11-02T11:59:50', [slide('A', before('12:00')), slide('B', after('12:00'))]));
  assert.equal(tv.showing(), 'A');
  tv.dropNetwork();
  pass(30);
  assert.equal(tv.showing(), 'B');
});

test('a reload with the server away keeps following the host clock', (t) => {
  const pass = clock(t);
  const first = boot();
  // By date, so the answer can't come out right by accident from the TV's clock, which is in 2031.
  const list = [slide('A', { startDate: '2026-11-02', endDate: '2026-11-02' }), slide('B', { startDate: '2026-11-03', endDate: '2026-11-03' })];
  first.receive(state('2026-11-02T23:59:00', list));
  assert.equal(first.showing(), 'A');
  first.dropNetwork();
  pass(120); // the saved message says 23:59, but it is now past midnight

  const second = boot(first.storage);
  assert.equal(second.showing(), 'B', 'worked out from the saved offset, not the old clock value');
});

test('a TV with no host clock yet uses its own', (t) => {
  clock(t);
  const local = new Date(); // whatever the fake TV clock says, in this machine's zone
  const pad = (n) => String(n).padStart(2, '0');
  const storage = new Map([['signage-last-state:main', JSON.stringify(state(undefined, [
    slide('today', { startDate: `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}` }),
    slide('never', { endDate: '2000-01-01' }),
    slide('plain'),
  ]))]]);
  const tv = boot(storage);
  assert.equal(tv.showing(), 'today');
});

test('pings keep the clock right when the host clock changes', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state('2026-11-02T01:30:00', [slide('A', after('05:00'))]));
  assert.equal(tv.showing(), null);
  tv.receive({ type: 'ping', clock: '2026-11-02T06:00:00' });
  pass(16);
  assert.equal(tv.showing(), 'A');
});

test('overrides ignore schedules, and the schedule applies again when they end', (t) => {
  const pass = clock(t);
  const tv = boot();
  const override = { id: 9, slides: [slide('STORM')], remainingMs: 30000 };
  tv.receive(state('2026-11-02T12:00:00', [slide('A', before('09:00'))], { override }));
  assert.equal(tv.showing(), 'STORM');
  pass(20);
  assert.equal(tv.showing(), 'STORM');
  pass(12);
  assert.equal(tv.showing(), null, 'the only playlist item is off, so idle');
});

test('a slide whose schedule ended does not linger when everything else fails to load', (t) => {
  const pass = clock(t);
  const tv = boot();
  const broken = { ...slide('broken'), type: 'mystery' };
  tv.receive(state('2026-11-02T11:59:50', [slide('A', before('12:00')), broken]));
  assert.equal(tv.showing(), 'A');
  pass(25);
  assert.equal(tv.showing(), null);
  assert.equal(tv.idle(), true);
});

// ---------- a slide's old timer ----------

test('a timer left from the old slide does not drop the slide loading next', (t) => {
  const pass = clock(t);
  const tv = boot();
  // A's schedule ends at noon, seen at the check 15 seconds in, three seconds before its own time is up.
  tv.receive(state('2026-11-02T11:59:50', [slide('A', before('12:00'), 18), picture('B', null, 30), slide('C')]));
  assert.equal(tv.showing(), 'A');
  pass(15);
  assert.deepEqual(tv.loading(), ['B']);
  const [loading] = tv.loadingLayers();
  pass(4); // past the moment A's timer was set for
  assert.deepEqual(tv.loadingLayers(), [loading], 'B is still the one on its way');
  assert.equal(tv.showing(), 'A', 'and A holds the screen, rather than C jumping in');
  tv.imageLoaded();
  assert.equal(tv.showing(), 'B');
  pass(30);
  assert.equal(tv.showing(), 'C', 'B got its full time, so its own timer was set');
});

test('an override pushed near the end of a slide loads only one copy', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state('2026-11-02T12:00:00', [slide('A', null, 20), slide('B')]));
  pass(18);
  tv.receive(state('2026-11-02T12:00:18', [slide('A', null, 20), slide('B')], { override: { id: 9, slides: [picture('STORM')], remainingMs: null } }));
  assert.deepEqual(tv.loading(), ['STORM']);
  const [loading] = tv.loadingLayers();
  pass(3); // past A's end
  assert.deepEqual(tv.loadingLayers(), [loading], 'one copy, the same one');
  tv.imageLoaded();
  assert.equal(tv.showing(), 'STORM');
  assert.deepEqual(tv.loading(), []);
});

test('a video on screen ending does not drop the slide loading next', (t) => {
  const pass = clock(t);
  const tv = boot();
  const video = { ...slide('V', before('12:00'), 40), type: 'video', src: 'http://x/v.mp4' };
  tv.receive(state('2026-11-02T11:59:50', [video, picture('B', null, 30), slide('C')]));
  tv.videos[0].fire('canplay');
  pass(15);
  assert.deepEqual(tv.loading(), ['B']);
  tv.videos[0].fire('ended');
  assert.deepEqual(tv.loading(), ['B']);
  tv.imageLoaded();
  assert.equal(tv.showing(), 'B');
});

test('a state arriving while the next slide loads cannot start the old timer again', (t) => {
  const pass = clock(t);
  const tv = boot();
  const list = [slide('A', null, 3), picture('B', null, 30), slide('C')];
  tv.receive(state('2026-11-02T12:00:00', list));
  pass(3);
  assert.deepEqual(tv.loading(), ['B']);
  const [loading] = tv.loadingLayers();
  tv.receive(state('2026-11-02T12:00:03', list));
  pass(4); // past A's time again, and B's first second-and-a-bit of waiting
  assert.equal(tv.showing(), 'A');
  assert.deepEqual(tv.loadingLayers(), [loading], 'still the same load, with no jump to C');
  tv.imageLoaded();
  assert.equal(tv.showing(), 'B');
});

test('nothing further is preloaded while the next slide is still loading', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state('2026-11-02T12:00:00', [slide('A', null, 5), picture('B', null, 30), picture('C', null, 30)]));
  pass(5);
  assert.deepEqual(tv.loading(), ['B']);
  pass(3);
  assert.deepEqual(tv.loading(), ['B'], 'a one-decoder TV has enough to do');
});

test('a slide that fails to load is skipped, and the one after it gets its full time', (t) => {
  const pass = clock(t);
  const tv = boot();
  tv.receive(state('2026-11-02T11:59:50', [slide('A', before('12:00'), 18), picture('B'), slide('C', null, 20), slide('D')]));
  pass(15);
  assert.deepEqual(tv.loading(), ['B']);
  pass(8); // B's 8 seconds to load run out
  pass(1); // and the skip takes half a second
  assert.equal(tv.showing(), 'C');
  pass(19);
  assert.equal(tv.showing(), 'C');
  pass(2);
  assert.equal(tv.showing(), 'D');
});

// ---------- HLS ----------

function fakeHls({ supported = true, explodes = false } = {}) {
  class Hls {
    static made = [];
    static isSupported() { return supported; }
    constructor(config) {
      if (explodes) throw new Error('no');
      this.config = config;
      Hls.made.push(this);
    }
    on(event, fn) { this.onError = fn; }
    loadSource(src) { this.src = src; }
    attachMedia(video) { this.media = video; }
    recoverMediaError() { this.recovered = (this.recovered ?? 0) + 1; }
    destroy() { this.destroyed = true; }
  }
  Hls.Events = { ERROR: 'hlsError' };
  Hls.ErrorTypes = { MEDIA_ERROR: 'mediaError', NETWORK_ERROR: 'networkError' };
  return Hls;
}

const liveFeed = (name = 'Program') => ({ ...slide(name, null, 60), type: 'hls', src: '/live/feed/index.m3u8' });
const outsideStream = (name = 'Outside') => ({ ...slide(name, null, 60), type: 'hls', src: 'http://10.0.0.5/stream.m3u8' });

test('a live feed uses hls.js even when the browser says it can maybe play HLS itself', (t) => {
  clock(t);
  const Hls = fakeHls();
  const tv = boot(new Map(), { native: 'maybe', Hls });
  tv.receive(state('2026-11-02T12:00:00', [liveFeed()]));
  assert.equal(Hls.made.length, 1);
  assert.equal(Hls.made[0].src, '/live/feed/index.m3u8');
  assert.equal(Hls.made[0].config.liveMaxLatencyDurationCount, 5, 'the low-latency settings');
  assert.equal(tv.videos[0].src, undefined, 'and not the native player too');
});

test('hls.js only loads when a slide needs it', (t) => {
  clock(t);
  const tv = boot(new Map(), { native: 'maybe' });
  tv.receive(state('2026-11-02T12:00:00', [slide('A')]));
  assert.deepEqual(tv.scripts(), []);
  tv.receive(state('2026-11-02T12:00:00', [liveFeed()]));
  assert.equal(tv.scripts().length, 1);
  assert.equal(tv.videos[0].src, undefined, 'nothing plays until it is known whether it loaded');
  tv.env.Hls = fakeHls();
  tv.scripts()[0].onload();
  assert.equal(tv.env.Hls.made.length, 1);
});

test('when hls.js cannot load, a live feed falls back to the native player', (t) => {
  clock(t);
  const tv = boot(new Map(), { native: 'maybe' });
  tv.receive(state('2026-11-02T12:00:00', [liveFeed()]));
  tv.scripts()[0].onerror();
  assert.equal(tv.videos[0].src, '/live/feed/index.m3u8');
  tv.videos[0].fire('canplay');
  assert.ok(tv.layer(), 'it reaches the screen');
});

test('a TV without MSE plays a live feed through the native player', (t) => {
  clock(t);
  const tv = boot(new Map(), { native: 'maybe', Hls: fakeHls({ supported: false }) });
  tv.receive(state('2026-11-02T12:00:00', [liveFeed()]));
  assert.equal(tv.videos[0].src, '/live/feed/index.m3u8');
  assert.equal(tv.env.Hls.made.length, 0);
});

test('hls.js blowing up on an odd browser falls back to the native player', (t) => {
  clock(t);
  const tv = boot(new Map(), { native: 'probably', Hls: fakeHls({ explodes: true }) });
  tv.receive(state('2026-11-02T12:00:00', [liveFeed()]));
  assert.equal(tv.videos[0].src, '/live/feed/index.m3u8');
});

test('a fatal media error gets recovery first, then the native player if it happens before the feed shows', (t) => {
  clock(t);
  const Hls = fakeHls();
  const tv = boot(new Map(), { native: 'maybe', Hls });
  tv.receive(state('2026-11-02T12:00:00', [liveFeed()]));
  const [hls] = Hls.made;
  hls.onError('hlsError', { fatal: true, type: 'mediaError' });
  assert.equal(hls.recovered, 1);
  assert.equal(tv.videos[0].src, undefined);
  hls.onError('hlsError', { fatal: true, type: 'mediaError' });
  assert.equal(hls.destroyed, true);
  assert.equal(tv.videos[0].src, '/live/feed/index.m3u8');
});

test('with no native player, hls.js failing is a failed slide, and the channel moves on', (t) => {
  const pass = clock(t);
  const Hls = fakeHls();
  const tv = boot(new Map(), { Hls });
  tv.receive(state('2026-11-02T12:00:00', [liveFeed(), slide('B')]));
  Hls.made[0].onError('hlsError', { fatal: true, type: 'networkError' });
  pass(1);
  assert.equal(tv.showing(), 'B');
});

test('a TV with neither shows the channel moving on, not a stuck feed', (t) => {
  const pass = clock(t);
  const tv = boot(new Map(), { Hls: fakeHls({ supported: false }) });
  tv.receive(state('2026-11-02T12:00:00', [liveFeed(), slide('B')]));
  pass(1);
  assert.equal(tv.showing(), 'B');
});

test('an outside stream stays on the native player, which needs no CORS from a server we do not run', (t) => {
  clock(t);
  const Hls = fakeHls();
  const tv = boot(new Map(), { native: 'maybe', Hls });
  tv.receive(state('2026-11-02T12:00:00', [outsideStream()]));
  assert.equal(Hls.made.length, 0);
  assert.equal(tv.videos[0].src, 'http://10.0.0.5/stream.m3u8');
  assert.deepEqual(tv.scripts(), []);

  const noNative = boot(new Map(), { Hls: fakeHls() });
  noNative.receive(state('2026-11-02T12:00:00', [outsideStream()]));
  assert.equal(noNative.env.Hls.made.length, 1, 'and uses hls.js where there is no native player');
});

// ---------- media cache ----------

function fakeStorage(putFails) {
  const pending = [];
  const puts = [];
  const named = (name) => Object.assign(new Error(name), { name });
  const db = {
    transaction() {
      const tx = {
        error: null,
        objectStore: () => ({
          put(blob, url) {
            puts.push(url);
            if (putFails === 'clone') throw named('DataCloneError');
            if (putFails === 'quota-thrown') throw named('QuotaExceededError');
            pending.push(() => {
              if (putFails === 'quota' || putFails === 'other') {
                // As a browser does: an error event from the request with no error on the transaction yet, then the abort.
                tx.onerror?.({ target: { error: null } });
                tx.error = named(putFails === 'quota' ? 'QuotaExceededError' : 'UnknownError');
                tx.onabort?.();
              } else if (putFails === 'request') {
                tx.onerror?.({ target: { error: named('ConstraintError') } });
                tx.error = named('ConstraintError');
                tx.onabort?.();
              } else {
                tx.oncomplete?.();
              }
            });
            return {};
          },
          get() {
            const req = { result: undefined };
            pending.push(() => req.onsuccess?.());
            return req;
          },
          openCursor() {
            const req = { result: null };
            pending.push(() => {
              req.onsuccess?.();
              tx.oncomplete?.();
            });
            return req;
          },
        }),
      };
      return tx;
    },
  };
  class XMLHttpRequest {
    open() {}
    send() {
      this.status = 200;
      this.response = { blob: true };
      pending.push(() => this.onload());
    }
  }
  return {
    puts,
    XMLHttpRequest,
    indexedDB: {
      open() {
        const req = { result: db };
        pending.push(() => req.onsuccess?.());
        return req;
      },
    },
    drain() {
      while (pending.length) pending.shift()();
    },
  };
}

const cachedSlides = () => [{ ...slide('A', null, 0), src: '/media/a.jpg' }, { ...slide('B', null, 0), src: '/media/b.jpg' }];

function cacheRun(t, putFails) {
  const pass = clock(t);
  const storage = fakeStorage(putFails);
  const tv = boot(new Map(), { indexedDB: storage.indexedDB, XMLHttpRequest: storage.XMLHttpRequest });
  tv.receive(state('2026-11-02T12:00:00', cachedSlides()));
  storage.drain();
  pass(10);
  return { tv, storage, pass, lastHeartbeat: () => tv.heartbeats().at(-1) };
}

test('a working cache stores every file and is not full', (t) => {
  const { storage, lastHeartbeat } = cacheRun(t);
  assert.deepEqual(storage.puts, ['/media/a.jpg', '/media/b.jpg']);
  assert.equal(lastHeartbeat().cacheFull, false);
});

test('a browser that cannot store blobs does not report full storage, and stops trying', (t) => {
  const { tv, storage, lastHeartbeat, pass } = cacheRun(t, 'clone');
  assert.deepEqual(storage.puts, ['/media/a.jpg'], 'one try is enough');
  assert.equal(lastHeartbeat().cacheFull, false);
  tv.receive(state('2026-11-02T12:00:10', cachedSlides()));
  storage.drain();
  pass(10);
  assert.deepEqual(storage.puts, ['/media/a.jpg'], 'and a new list does not start it again');
  assert.equal(lastHeartbeat().cacheFull, false);
});

test('any other storage error is not reported as full either, even after a request error', (t) => {
  for (const kind of ['other', 'request']) {
    const { storage, lastHeartbeat } = cacheRun(t, kind);
    assert.deepEqual(storage.puts, ['/media/a.jpg'], kind);
    assert.equal(lastHeartbeat().cacheFull, false, kind);
    t.mock.timers.reset();
  }
});

test('really running out of quota is reported as full, however it arrives', (t) => {
  for (const kind of ['quota', 'quota-thrown']) {
    const { storage, lastHeartbeat } = cacheRun(t, kind);
    assert.deepEqual(storage.puts, ['/media/a.jpg'], kind);
    assert.equal(lastHeartbeat().cacheFull, true, kind);
    t.mock.timers.reset();
  }
});
