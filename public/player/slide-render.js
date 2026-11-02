// Draws a text slide. The TV player and the admin's live preview both use this one file, so
// the preview shows what the TV shows. Deliberately ES5 with no build step, like player.js.
// The server reads the allowed values from here through server/slide-style.js.
//
// A slide's style is optional and every field in it is optional. Anything left out follows
// the organization's branding, so a slide with no style looks the way text slides always have.
//   background  { type: 'solid', color } or { type: 'gradient', from, to }, hex colors
//   image       library image id, with imageUrl built by the server
//   dim         0 to 90, how far to darken the background image, in percent
//   textColor, accentColor  hex colors
//   titleSize, bodySize     small, medium, large, huge
//   align       left, center, right
//   logo        bottom-left, bottom-right, top-left, top-right, hidden
//   countdown   'YYYY-MM-DDTHH:MM', on the host computer's wall clock
//   template    the template it started from. Only the designer reads this.
//
// User text only ever reaches the page through textContent.
(function (root, factory) {
  if (typeof module === 'object' && module && module.exports) module.exports = factory(root);
  else root.SignageSlide = factory(root);
})(this, function (root) {
  'use strict';

  var TITLE_VW = { small: 5, medium: 7, large: 9, huge: 11 };
  var BODY_VW = { small: 2.6, medium: 3.4, large: 4.4, huge: 5.6 };
  var COUNTDOWN_VW = 6;
  var OPTIONS = {
    sizes: ['small', 'medium', 'large', 'huge'],
    align: ['left', 'center', 'right'],
    logo: ['bottom-left', 'bottom-right', 'top-left', 'top-right', 'hidden'],
    maxDim: 90
  };

  // Auto-fit only ever shrinks, and never below these, so text stays readable.
  var MIN_SCALE = 0.2;
  var MIN_TITLE_VW = 2.4;
  var MIN_BODY_VW = 1.4;
  var MIN_COUNTDOWN_VW = 2.4;
  var FIT_STEPS = 7;

  var MIN_CONTRAST = 4.5;
  var ENDED_TEXT = 'Time\'s up';

  var HEX = /^#[0-9a-fA-F]{6}$/;
  // Only addresses the server builds, or the cached copy of one.
  var IMAGE_URL = /^(\/media\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+|blob:[A-Za-z0-9:\/.\[\]_-]+)$/;

  function isHex(value) {
    return typeof value === 'string' && HEX.test(value);
  }

  function pick(value, fallback) {
    return isHex(value) ? value : fallback;
  }

  function pad(n) {
    return n < 10 ? '0' + n : String(n);
  }

  // ---------- fonts ----------

  function fontFamily(b) {
    if (b.fontMode === 'google' && b.fontFamily) return '"' + b.fontFamily + '", sans-serif';
    if (b.fontMode === 'upload' && b.fontFile) return 'SignageCustom, sans-serif';
    return '';
  }

  function applyFont(doc, b) {
    var old = doc.getElementById('brand-font');
    if (old) old.parentNode.removeChild(old);
    var el;
    if (b.fontMode === 'google' && b.fontFamily) {
      el = doc.createElement('link');
      el.rel = 'stylesheet';
      el.href = 'https://fonts.googleapis.com/css?family=' + encodeURIComponent(b.fontFamily) + ':400,600,700&display=swap';
    } else if (b.fontMode === 'upload' && b.fontFile) {
      el = doc.createElement('style');
      el.appendChild(doc.createTextNode('@font-face{font-family:SignageCustom;src:url("' + b.fontFile + '");font-display:swap}'));
    }
    if (el) {
      el.id = 'brand-font';
      doc.getElementsByTagName('head')[0].appendChild(el);
    }
  }

  // ---------- contrast ----------

  function luminance(hex) {
    if (!isHex(hex)) return null;
    var total = 0;
    var weights = [0.2126, 0.7152, 0.0722];
    for (var i = 0; i < 3; i++) {
      var c = parseInt(hex.substr(1 + i * 2, 2), 16) / 255;
      total += weights[i] * (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    }
    return total;
  }

  // The WCAG contrast ratio, from 1 to 21, or null if either color can't be read.
  function contrast(a, b) {
    var la = luminance(a);
    var lb = luminance(b);
    if (la === null || lb === null) return null;
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  function grey(fraction) {
    var v = Math.round(255 * fraction).toString(16);
    if (v.length < 2) v = '0' + v;
    return '#' + v + v + v;
  }

  // A plain sentence when the text may be hard to read, otherwise null. It warns and nothing
  // more: nothing here stops a slide from being saved. A picture's colors aren't known, so it
  // is judged by its darkest and brightest possible pixels once dimmed.
  function contrastWarning(style, branding) {
    var s = style || {};
    var b = branding || {};
    var text = pick(s.textColor, b.textColor);
    var i;
    if (s.imageUrl || s.image) {
      var dim = typeof s.dim === 'number' ? s.dim : 0;
      var edges = ['#000000', grey(1 - dim / 100)];
      for (i = 0; i < edges.length; i++) {
        if (contrast(text, edges[i]) !== null && contrast(text, edges[i]) < MIN_CONTRAST) {
          return 'This text may be hard to read over the picture. Try light text and more dimming.';
        }
      }
      // The color still matters: it is what shows if the picture is ever deleted.
    }
    var bg = s.background;
    var colors = [b.primaryColor];
    if (bg && bg.type === 'solid') colors = [bg.color];
    else if (bg && bg.type === 'gradient') colors = [bg.from, bg.to];
    for (i = 0; i < colors.length; i++) {
      if (contrast(text, colors[i]) !== null && contrast(text, colors[i]) < MIN_CONTRAST) {
        return 'These colors are close together, so the text may be hard to read from across a room.';
      }
    }
    return null;
  }

  // ---------- countdown ----------

  // Whole seconds left, rounded up, so it reads 00:01 until the moment it ends.
  function formatCountdown(ms) {
    if (!(ms > 0)) return ENDED_TEXT;
    var total = Math.ceil(ms / 1000);
    var days = Math.floor(total / 86400);
    var hours = Math.floor(total % 86400 / 3600);
    var mins = Math.floor(total % 3600 / 60);
    var secs = total % 60;
    if (days) return days + (days === 1 ? ' day ' : ' days ') + pad(hours) + ':' + pad(mins) + ':' + pad(secs);
    if (hours) return hours + ':' + pad(mins) + ':' + pad(secs);
    return pad(mins) + ':' + pad(secs);
  }

  // ---------- drawing ----------

  function setBackground(el, style, b) {
    var bg = style && style.background;
    if (bg && bg.type === 'gradient' && isHex(bg.from) && isHex(bg.to)) {
      // Older TVs ignore what they can't parse, so each line falls back to the one before.
      el.style.background = bg.from;
      el.style.background = '-webkit-linear-gradient(top left, ' + bg.from + ', ' + bg.to + ')';
      el.style.background = 'linear-gradient(to bottom right, ' + bg.from + ', ' + bg.to + ')';
    } else if (bg && bg.type === 'solid' && isHex(bg.color)) {
      el.style.background = bg.color;
    } else {
      el.style.background = b.primaryColor;
    }
  }

  function div(doc, className) {
    var el = doc.createElement('div');
    el.className = className;
    return el;
  }

  // Returns a view. Attach view.el to the page, then call view.fit(), which needs real layout.
  // Call view.tick() about once a second to keep the countdown and the fit up to date.
  //   opts.now()            the host's wall clock, as wall milliseconds. See schedule.js.
  //   opts.resolve(url, cb) swaps an address for a cached copy.
  //   opts.document         for tests.
  function render(slide, branding, opts) {
    opts = opts || {};
    var doc = opts.document || document;
    var b = branding || {};
    var style = slide.style && typeof slide.style === 'object' ? slide.style : null;
    var s = style || {};

    var el = div(doc, 'text-slide');
    setBackground(el, style, b);
    el.style.color = pick(s.textColor, b.textColor);
    var font = fontFamily(b);
    if (font) el.style.fontFamily = font;
    var alignment = OPTIONS.align.indexOf(s.align) >= 0 ? s.align : null;
    if (alignment) el.style.textAlign = alignment;

    var box = div(doc, 'slide-box');
    var content = div(doc, 'slide-content');
    var rule = div(doc, 'rule');
    rule.style.background = pick(s.accentColor, b.accentColor);
    if (alignment === 'left') rule.style.margin = '0 auto 4vh 0';
    else if (alignment === 'right') rule.style.margin = '0 0 4vh auto';
    content.appendChild(rule);

    var h = doc.createElement('h1');
    h.textContent = slide.title || '';
    content.appendChild(h);

    var p = null;
    if (slide.body) {
      p = doc.createElement('p');
      p.textContent = slide.body;
      content.appendChild(p);
    }

    var Schedule = root && root.SignageSchedule;
    var target = s.countdown && Schedule ? Schedule.parseWall(s.countdown) : null;
    var counter = null;
    if (target !== null) {
      counter = div(doc, 'countdown');
      content.appendChild(counter);
    }
    box.appendChild(content);

    // ----- background image: the color stays underneath in case the picture never arrives -----

    var waiting = [];
    var settled = true;

    function settle() {
      settled = true;
      var callbacks = waiting;
      waiting = [];
      for (var i = 0; i < callbacks.length; i++) callbacks[i]();
    }

    var url = typeof s.imageUrl === 'string' && IMAGE_URL.test(s.imageUrl) ? s.imageUrl : null;
    if (url) {
      settled = false;
      var picture = div(doc, 'slide-image');
      var dimmer = div(doc, 'slide-dim');
      picture.style.display = 'none';
      dimmer.style.display = 'none';
      var dim = typeof s.dim === 'number' && s.dim >= 0 && s.dim <= OPTIONS.maxDim ? s.dim : 0;
      dimmer.style.opacity = String(dim / 100);
      el.appendChild(picture);
      el.appendChild(dimmer);
      var load = function (address) {
        if (!IMAGE_URL.test(address)) return settle();
        var probe = doc.createElement('img');
        probe.onload = function () {
          picture.style.backgroundImage = 'url("' + address + '")';
          picture.style.display = '';
          dimmer.style.display = '';
          settle();
        };
        probe.onerror = settle;
        probe.src = address;
      };
      if (opts.resolve) opts.resolve(url, load);
      else load(url);
    }

    el.appendChild(box);

    var logoPlace = OPTIONS.logo.indexOf(s.logo) >= 0 ? s.logo : 'bottom-left';
    if (b.logo && logoPlace !== 'hidden') {
      var logo = doc.createElement('img');
      logo.className = 'logo logo-' + logoPlace;
      logo.src = b.logo;
      el.appendChild(logo);
    }

    // ----- sizes and auto-fit -----

    var titleVw = TITLE_VW[s.titleSize] || TITLE_VW.medium;
    var bodyVw = BODY_VW[s.bodySize] || BODY_VW.medium;
    var lastWidth = null;
    var lastHeight = null;
    var clipped = false;

    function shrunk(base, scale, floor) {
      return Math.max(base * scale, Math.min(base, floor)) + 'vw';
    }

    // A slide with no style keeps its sizes in player.css until it actually needs shrinking.
    function setSizes(scale) {
      if (!style && scale === 1) {
        h.style.fontSize = '';
        if (p) p.style.fontSize = '';
      } else {
        h.style.fontSize = shrunk(titleVw, scale, MIN_TITLE_VW);
        if (p) p.style.fontSize = shrunk(bodyVw, scale, MIN_BODY_VW);
      }
      if (counter) counter.style.fontSize = shrunk(COUNTDOWN_VW, scale, MIN_COUNTDOWN_VW);
    }

    function fits() {
      return !(content.offsetHeight > box.clientHeight) && !(content.scrollWidth > box.clientWidth);
    }

    function setTopAligned(on) {
      clipped = on;
      box.style.webkitJustifyContent = on ? 'flex-start' : '';
      box.style.justifyContent = on ? 'flex-start' : '';
    }

    function fit() {
      lastWidth = box.clientWidth;
      lastHeight = box.clientHeight;
      setTopAligned(false);
      setSizes(1);
      if (!box.clientHeight || fits()) return;
      setSizes(MIN_SCALE);
      if (!fits()) {
        // Too much to fit at the smallest size. The box clips the rest, so show the start of it.
        setTopAligned(true);
        return;
      }
      var low = MIN_SCALE;
      var high = 1;
      for (var i = 0; i < FIT_STEPS; i++) {
        var middle = (low + high) / 2;
        setSizes(middle);
        if (fits()) low = middle;
        else high = middle;
      }
      setSizes(low);
    }

    function now() {
      if (opts.now) return opts.now();
      return Schedule ? Schedule.parseWall(Schedule.localClock(new Date())) : null;
    }

    function updateCountdown() {
      if (!counter) return;
      var at = now();
      if (at === null) return;
      var label = formatCountdown(target - at);
      if (counter.textContent !== label) counter.textContent = label;
    }

    // A font arriving late, or the window changing size, can undo the last fit.
    function tick() {
      updateCountdown();
      if (box.clientWidth !== lastWidth || box.clientHeight !== lastHeight || (!clipped && !fits())) fit();
    }

    setSizes(1);
    updateCountdown();

    return {
      el: el,
      fit: fit,
      tick: tick,
      // Calls back once any background image has loaded or failed.
      whenReady: function (cb) {
        if (settled) cb();
        else waiting.push(cb);
      }
    };
  }

  return {
    OPTIONS: OPTIONS,
    MIN_CONTRAST: MIN_CONTRAST,
    MIN_TITLE_VW: MIN_TITLE_VW,
    MIN_BODY_VW: MIN_BODY_VW,
    ENDED_TEXT: ENDED_TEXT,
    render: render,
    fontFamily: fontFamily,
    applyFont: applyFont,
    contrast: contrast,
    contrastWarning: contrastWarning,
    formatCountdown: formatCountdown
  };
});
