import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

// Runs the real slide-render.js against a tiny stand-in for the browser. Real layout is a
// separate check, so tests that need it describe the box's size and how big the text comes out.
const dir = path.join(import.meta.dirname, '..', 'public', 'player');
const scripts = ['schedule.js', 'slide-render.js'].map((f) => new vm.Script(fs.readFileSync(path.join(dir, f), 'utf8'), { filename: f }));

function element(tag) {
  const el = {
    tagName: tag.toUpperCase(), style: {}, children: [], parentNode: null, className: '', textContent: '',
    appendChild(c) { c.parentNode = el; el.children.push(c); return c; },
    removeChild(c) { c.parentNode = null; el.children.splice(el.children.indexOf(c), 1); return c; },
    // Setting this is what parsing user text as markup would look like.
    set innerHTML(v) { throw new Error(`innerHTML was used: ${v}`); },
  };
  return el;
}

const context = vm.createContext({ document: { createElement: element }, Date, Math, parseInt, encodeURIComponent });
for (const s of scripts) s.runInContext(context);
const Slide = context.SignageSlide;

const branding = { primaryColor: '#1f2937', accentColor: '#3b82f6', textColor: '#ffffff', logo: null };
const walk = (el) => [el, ...el.children.flatMap(walk)];
const find = (root, cls) => walk(root).find((e) => e.className === cls || e.className.split?.(' ').includes(cls));
const tag = (root, name) => walk(root).find((e) => e.tagName === name);
const render = (slide, opts, b = branding) => Slide.render({ title: 'Hello', ...slide }, b, opts);

test('a slide with no style keeps the branding look and leaves sizes to the stylesheet', () => {
  const view = render({ body: 'World' });
  assert.equal(view.el.className, 'text-slide');
  assert.equal(view.el.style.background, '#1f2937');
  assert.equal(view.el.style.color, '#ffffff');
  assert.equal(view.el.style.textAlign, undefined);
  assert.equal(find(view.el, 'rule').style.background, '#3b82f6');
  assert.equal(tag(view.el, 'H1').textContent, 'Hello');
  assert.equal(tag(view.el, 'P').textContent, 'World');
  assert.equal(tag(view.el, 'H1').style.fontSize, '');
  assert.equal(tag(view.el, 'P').style.fontSize, '');
  assert.equal(find(view.el, 'slide-image'), undefined);
  assert.equal(find(view.el, 'countdown'), undefined);
});

test('the logo sits bottom left by default, moves when asked, and can be hidden', () => {
  const b = { ...branding, logo: '/media/branding/logo.png' };
  assert.equal(tag(render({}, {}, b).el, 'IMG').className, 'logo logo-bottom-left');
  assert.equal(tag(render({ style: { logo: 'top-right' } }, {}, b).el, 'IMG').className, 'logo logo-top-right');
  assert.equal(tag(render({ style: { logo: 'hidden' } }, {}, b).el, 'IMG'), undefined);
  assert.equal(tag(render({ style: { logo: 'hidden' } }).el, 'IMG'), undefined);
});

test('style fields reach the slide', () => {
  const view = render({
    body: 'B',
    style: { background: { type: 'gradient', from: '#112233', to: '#445566' }, textColor: '#000000', accentColor: '#ff0000', titleSize: 'large', bodySize: 'small', align: 'left' },
  });
  assert.equal(view.el.style.background, 'linear-gradient(to bottom right, #112233, #445566)');
  assert.equal(view.el.style.color, '#000000');
  assert.equal(view.el.style.textAlign, 'left');
  assert.equal(find(view.el, 'rule').style.background, '#ff0000');
  assert.equal(find(view.el, 'rule').style.margin, '0 auto 4vh 0');
  assert.equal(tag(view.el, 'H1').style.fontSize, '9vw');
  assert.equal(tag(view.el, 'P').style.fontSize, '2.6vw');
  assert.equal(render({ style: { background: { type: 'solid', color: '#abcdef' } } }).el.style.background, '#abcdef');
});

test('user text only ever lands in textContent', () => {
  const hostile = '<img src=x onerror=alert(1)><script>alert(2)</script>';
  const view = render({ title: hostile, body: hostile });
  // The stand-in throws if innerHTML is set, so getting here is half the proof.
  assert.equal(tag(view.el, 'H1').textContent, hostile);
  assert.equal(tag(view.el, 'P').textContent, hostile);
  assert.equal(walk(view.el).filter((e) => e.tagName === 'IMG' || e.tagName === 'SCRIPT').length, 0, 'no elements came from the text');
});

test('colors and addresses a server would never send are ignored', () => {
  const view = render({
    style: {
      background: { type: 'solid', color: 'red;background:url(http://evil)' },
      textColor: 'expression(alert(1))',
      accentColor: 'url(javascript:alert(1))',
      imageUrl: 'javascript:alert(1)',
    },
  });
  assert.equal(view.el.style.background, '#1f2937');
  assert.equal(view.el.style.color, '#ffffff');
  assert.equal(find(view.el, 'rule').style.background, '#3b82f6');
  assert.equal(find(view.el, 'slide-image'), undefined);
  assert.equal(render({ style: { imageUrl: '/media/a/b.png") ; x:url("' } }).el.children.some((c) => c.className === 'slide-image'), false);
});

// The image is checked off-page first, so a real run has a probe to fire.
function withProbe() {
  const probes = [];
  const doc = {
    createElement(name) {
      const el = element(name);
      if (name === 'img') probes.push(el);
      return el;
    },
  };
  return { doc, probes };
}

test('a background image shows, dimmed, once it has loaded', () => {
  const { doc, probes } = withProbe();
  const view = render({ style: { background: { type: 'solid', color: '#123456' }, imageUrl: '/media/abc/image.png', dim: 40 } }, { document: doc });
  let ready = false;
  view.whenReady(() => { ready = true; });
  const picture = find(view.el, 'slide-image');
  const dimmer = find(view.el, 'slide-dim');
  assert.equal(picture.style.display, 'none');
  assert.equal(ready, false, 'waits for the picture');
  assert.equal(probes[0].src, '/media/abc/image.png');
  probes[0].onload();
  assert.equal(ready, true);
  assert.equal(picture.style.backgroundImage, 'url("/media/abc/image.png")');
  assert.equal(picture.style.display, '');
  assert.equal(dimmer.style.display, '');
  assert.equal(dimmer.style.opacity, '0.4');
});

test('a missing background image falls back to the color, without the dimming', () => {
  const { doc, probes } = withProbe();
  const view = render({ style: { background: { type: 'solid', color: '#123456' }, imageUrl: '/media/gone/image.png', dim: 80 } }, { document: doc });
  let ready = false;
  view.whenReady(() => { ready = true; });
  probes[0].onerror();
  assert.equal(ready, true, 'the slide still goes up');
  assert.equal(view.el.style.background, '#123456');
  assert.equal(find(view.el, 'slide-image').style.display, 'none');
  assert.equal(find(view.el, 'slide-dim').style.display, 'none');
});

test('a cached copy of the image is used when there is one', () => {
  const { doc, probes } = withProbe();
  const asked = [];
  render({ style: { imageUrl: '/media/abc/image.png' } }, { document: doc, resolve: (url, cb) => { asked.push(url); cb('blob:http://tv.test/1234'); } });
  assert.deepEqual(asked, ['/media/abc/image.png']);
  assert.equal(probes[0].src, 'blob:http://tv.test/1234');
});

// Text whose height grows with its font size, in a box of a given height.
function laidOut(view, { boxHeight, textFor }) {
  const box = find(view.el, 'slide-box');
  const content = find(view.el, 'slide-content');
  const size = (el) => (el?.style.fontSize ? parseFloat(el.style.fontSize) : 0);
  Object.defineProperty(box, 'clientHeight', { get: () => boxHeight, configurable: true });
  Object.defineProperty(box, 'clientWidth', { value: 1000 });
  Object.defineProperty(content, 'scrollWidth', { value: 1000 });
  Object.defineProperty(content, 'offsetHeight', { get: () => textFor(size(tag(view.el, 'H1')), size(tag(view.el, 'P'))) });
  return box;
}

test('text that fits is left at its chosen size', () => {
  const view = render({ body: 'B', style: { titleSize: 'large' } });
  laidOut(view, { boxHeight: 800, textFor: (title, body) => (title + body) * 10 });
  view.fit();
  assert.equal(tag(view.el, 'H1').style.fontSize, '9vw');
  assert.equal(tag(view.el, 'P').style.fontSize, '3.4vw');
});

test('a slide with no style only gets a size once it has to shrink', () => {
  const view = render({ body: 'B' });
  // Sizes left to the stylesheet read as 0 here, so anything set by fitting is obvious.
  laidOut(view, { boxHeight: 800, textFor: (title) => (title === 0 ? 400 : title * 10) });
  view.fit();
  assert.equal(tag(view.el, 'H1').style.fontSize, '');
});

test('text too big for the slide shrinks until it fits, and only as far as it must', () => {
  const view = render({ body: 'A long message', style: { titleSize: 'huge', bodySize: 'huge' } });
  const boxHeight = 500;
  const textFor = (title, body) => (title + body) * 60;
  laidOut(view, { boxHeight, textFor });
  view.fit();
  const title = parseFloat(tag(view.el, 'H1').style.fontSize);
  const body = parseFloat(tag(view.el, 'P').style.fontSize);
  assert.ok(title < 11, `title shrank, to ${title}`);
  assert.ok(textFor(title, body) <= boxHeight, 'it fits');
  assert.ok(textFor(title, body) > boxHeight * 0.95, 'without shrinking much more than it had to');
  assert.equal(find(view.el, 'slide-box').style.justifyContent, '');
});

test('shrinking stops at the smallest readable size, showing the start of what cannot fit', () => {
  const view = render({ body: 'Far too much', style: { titleSize: 'medium' } });
  laidOut(view, { boxHeight: 100, textFor: () => 100000 });
  view.fit();
  assert.equal(parseFloat(tag(view.el, 'H1').style.fontSize), Slide.MIN_TITLE_VW);
  assert.equal(parseFloat(tag(view.el, 'P').style.fontSize), Slide.MIN_BODY_VW);
  assert.equal(find(view.el, 'slide-box').style.justifyContent, 'flex-start');
});

test('sizes never grow past what was chosen, even at the smallest choice', () => {
  const view = render({ style: { titleSize: 'small', bodySize: 'small' }, body: 'B' });
  const seen = [];
  laidOut(view, { boxHeight: 300, textFor: (t, b) => { seen.push(t, b); return (t + b) * 50; } });
  view.fit();
  for (const size of seen) assert.ok(size <= 5, `size ${size} stays within the choice`);
});

test('it fits again when the window changes or a late font makes the text bigger', () => {
  const view = render({ body: 'B', style: {} });
  let height = 800;
  let grow = 1;
  const box = laidOut(view, { boxHeight: 800, textFor: (t, b) => (t + b) * 10 * grow });
  Object.defineProperty(box, 'clientHeight', { get: () => height });
  view.fit();
  assert.equal(tag(view.el, 'H1').style.fontSize, '7vw');
  grow = 20; // the font arrived
  view.tick();
  assert.ok(parseFloat(tag(view.el, 'H1').style.fontSize) < 7);
  grow = 1;
  height = 2000; // a bigger window
  view.tick();
  assert.equal(tag(view.el, 'H1').style.fontSize, '7vw');
});

test('countdowns read naturally', () => {
  assert.equal(Slide.formatCountdown(65000), '01:05');
  assert.equal(Slide.formatCountdown(500), '00:01');
  assert.equal(Slide.formatCountdown(3 * 3600000 + 4000), '3:00:04');
  assert.equal(Slide.formatCountdown(86400000 + 61000), '1 day 00:01:01');
  assert.equal(Slide.formatCountdown(2 * 86400000), '2 days 00:00:00');
  assert.equal(Slide.formatCountdown(0), Slide.ENDED_TEXT);
  assert.equal(Slide.formatCountdown(-5000), Slide.ENDED_TEXT);
});

test('a countdown follows the clock it is given, then shows a plain ended state', () => {
  let now = Date.UTC(2026, 10, 2, 11, 59, 50); // wall milliseconds: 11:59:50 on the host
  const view = render({ style: { countdown: '2026-11-02T12:00' } }, { now: () => now });
  const counter = find(view.el, 'countdown');
  assert.equal(counter.textContent, '00:10');
  now += 4000;
  view.tick();
  assert.equal(counter.textContent, '00:06');
  now += 6000;
  view.tick();
  assert.equal(counter.textContent, Slide.ENDED_TEXT);
  now += 60000;
  view.tick();
  assert.equal(counter.textContent, Slide.ENDED_TEXT);
});

test('a bad countdown is left out rather than showing nonsense', () => {
  assert.equal(find(render({ style: { countdown: 'soon' } }).el, 'countdown'), undefined);
});

test('contrast is the WCAG ratio', () => {
  assert.ok(Math.abs(Slide.contrast('#000000', '#ffffff') - 21) < 0.001);
  assert.equal(Slide.contrast('#123456', '#123456'), 1);
  assert.ok(Math.abs(Slide.contrast('#767676', '#ffffff') - 4.54) < 0.01);
  assert.equal(Slide.contrast('red', '#ffffff'), null);
});

test('low contrast warns, on the color, on either end of a gradient, and over a picture', () => {
  const warn = (style) => Slide.contrastWarning(style, branding);
  assert.equal(warn(null), null, 'the default branding is fine');
  assert.equal(warn({ background: { type: 'solid', color: '#000000' }, textColor: '#ffffff' }), null);
  assert.ok(warn({ background: { type: 'solid', color: '#777777' }, textColor: '#888888' }));
  assert.ok(warn({ background: { type: 'solid', color: '#ffffff' } }), 'white branding text on a white background');
  assert.ok(warn({ background: { type: 'gradient', from: '#000000', to: '#ffffff' }, textColor: '#ffffff' }));
  assert.ok(warn({ imageUrl: '/media/a/b.png', dim: 0, textColor: '#ffffff' }), 'a bright picture, not dimmed');
  assert.equal(warn({ imageUrl: '/media/a/b.png', dim: 60, textColor: '#ffffff' }), null);
  assert.ok(warn({ imageUrl: '/media/a/b.png', dim: 60, textColor: '#000000' }), 'dark text on a darkened picture');
  assert.ok(warn({ imageUrl: '/media/a/b.png', dim: 60, textColor: '#ffffff', background: { type: 'solid', color: '#ffffff' } }), 'the color it would fall back to');
});
