// TV player. Deliberately ES5 with no build step: older Samsung/LG browsers run this.
(function () {
  'use strict';

  var FADE_MS = 700;
  var READY_TIMEOUT_MS = 8000;
  var PRELOAD_LEAD_S = 8;
  var STALL_S = 15;
  var RETRY_MS = 10000;
  var HLS_RETRY_MS = 3000;
  var MAX_CACHE_FILE = 500 * 1024 * 1024;

  var pathParts = location.pathname.split('/');
  var slug = pathParts[1] === 'play' && pathParts[2] ? decodeURIComponent(pathParts[2]) : null;
  var isPreview = /[?&]preview=1/.test(location.search);

  var stage = document.getElementById('stage');
  var messageEl = document.getElementById('message');
  var hintEl = document.getElementById('hint');

  var ws = null;
  var reconnectDelay = 1000;
  var lastMessageAt = 0;
  var pageVersion = null;

  var state = null;          // last state from the server
  var overrideEndsAt = null; // local clock, so a timed override ends even if the network is down
  var mode = 'playlist';     // 'playlist' or 'o<id>'
  var indexes = {};          // position per mode, so the playlist resumes after an override
  var current = null;        // the shown slide
  var prepared = null;       // the next slide, loading off-screen
  var showToken = 0;
  var endTimer = null;
  var deadline = null;
  var failures = 0;
  var zIndex = 1;
  var idleEl = null;
  var lastProgress = { time: -1, at: 0 };

  // ---------- storage helpers ----------

  function store(key, value) {
    try { localStorage.setItem(key, value); } catch (e) {}
  }

  function load(key) {
    try { return localStorage.getItem(key); } catch (e) { return null; }
  }

  function deviceId() {
    var id = load('signage-device');
    if (!id) {
      var m = document.cookie.match(/signage_device=([A-Za-z0-9-]+)/);
      id = m ? m[1] : null;
    }
    if (!id) {
      id = 'tv-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12);
    }
    store('signage-device', id);
    document.cookie = 'signage_device=' + id + '; path=/; max-age=157680000';
    return id;
  }

  // ---------- media cache (IndexedDB) ----------
  // Whole files are stored as blobs and played from object URLs, so playback
  // survives network drops. Anything uncached simply streams from the server.

  var MediaCache = (function () {
    var dbPromiseCallbacks = null;
    var db = null;
    var objectUrls = {};
    var queue = [];
    var busy = false;
    var full = false;

    function open(cb) {
      if (db) return cb(db);
      if (dbPromiseCallbacks) return dbPromiseCallbacks.push(cb);
      if (isPreview || !window.indexedDB) return cb(null);
      dbPromiseCallbacks = [cb];
      function done(result) {
        db = result;
        var waiting = dbPromiseCallbacks;
        dbPromiseCallbacks = null;
        for (var i = 0; i < waiting.length; i++) waiting[i](result);
        // Stay usable-but-uncached if the database could not open.
        if (!result) open = function (c) { c(null); };
      }
      try {
        var req = indexedDB.open('signage-media', 1);
        req.onupgradeneeded = function () { req.result.createObjectStore('files'); };
        req.onsuccess = function () { done(req.result); };
        req.onerror = function () { done(null); };
      } catch (e) {
        done(null);
      }
    }

    function put(url, blob, cb) {
      open(function (d) {
        if (!d) return cb(false);
        try {
          var tx = d.transaction('files', 'readwrite');
          tx.objectStore('files').put(blob, url);
          tx.oncomplete = function () { cb(true); };
          tx.onerror = tx.onabort = function () { full = true; cb(false); };
        } catch (e) {
          full = true;
          cb(false);
        }
      });
    }

    function getBlob(url, cb) {
      open(function (d) {
        if (!d) return cb(null);
        try {
          var req = d.transaction('files').objectStore('files').get(url);
          req.onsuccess = function () { cb(req.result || null); };
          req.onerror = function () { cb(null); };
        } catch (e) {
          cb(null);
        }
      });
    }

    function resolve(url, cb) {
      if (objectUrls[url]) return cb(objectUrls[url]);
      if (url.indexOf('/media/') !== 0) return cb(url);
      getBlob(url, function (blob) {
        if (blob && window.URL && URL.createObjectURL) {
          objectUrls[url] = URL.createObjectURL(blob);
          cb(objectUrls[url]);
        } else {
          cb(url);
        }
      });
    }

    function pump() {
      if (busy || full || !queue.length) return;
      var url = queue.shift();
      busy = true;
      function next() {
        busy = false;
        pump();
      }
      getBlob(url, function (existing) {
        if (existing) return next();
        var xhr = new XMLHttpRequest();
        xhr.open('GET', url);
        xhr.responseType = 'blob';
        xhr.onload = function () {
          if (xhr.status === 200 && xhr.response) put(url, xhr.response, next);
          else next();
        };
        xhr.onerror = xhr.onabort = xhr.ontimeout = next;
        xhr.send();
      });
    }

    // Keep exactly the files this channel needs: download new ones, drop the rest.
    function sync(wanted) {
      open(function (d) {
        if (!d) return;
        var keep = {};
        var i;
        for (i = 0; i < wanted.length; i++) keep[wanted[i]] = true;
        try {
          var tx = d.transaction('files', 'readwrite');
          var store = tx.objectStore('files');
          var req = store.openCursor();
          var removedAny = false;
          req.onsuccess = function () {
            var cursor = req.result;
            if (!cursor) return;
            if (!keep[cursor.key]) {
              store['delete'](cursor.key);
              removedAny = true;
              if (objectUrls[cursor.key]) {
                URL.revokeObjectURL(objectUrls[cursor.key]);
                delete objectUrls[cursor.key];
              }
            }
            cursor['continue']();
          };
          tx.oncomplete = function () {
            if (removedAny) full = false;
            queue = wanted.slice();
            pump();
          };
        } catch (e) {}
      });
    }

    return { resolve: resolve, sync: sync };
  })();

  function cacheableUrls() {
    if (!state) return [];
    var slides = state.slides.slice();
    if (state.override) slides = slides.concat(state.override.slides);
    var urls = [];
    for (var i = 0; i < slides.length; i++) {
      var s = slides[i];
      if (s.src && s.src.indexOf('/media/') === 0 && (!s.size || s.size <= MAX_CACHE_FILE) && urls.indexOf(s.src) < 0) {
        urls.push(s.src);
      }
    }
    return urls;
  }

  // ---------- branding ----------

  var appliedFont = null;

  function fontFamily(b) {
    if (b.fontMode === 'google' && b.fontFamily) return '"' + b.fontFamily + '", sans-serif';
    if (b.fontMode === 'upload' && b.fontFile) return 'SignageCustom, sans-serif';
    return '';
  }

  function applyBranding(b) {
    if (!b) return;
    messageEl.style.background = b.primaryColor;
    messageEl.style.color = b.textColor;
    var marker = b.fontMode + '|' + b.fontFamily + '|' + b.fontFile;
    if (marker === appliedFont) return;
    appliedFont = marker;
    var old = document.getElementById('brand-font');
    if (old) old.parentNode.removeChild(old);
    var el;
    if (b.fontMode === 'google' && b.fontFamily) {
      el = document.createElement('link');
      el.rel = 'stylesheet';
      el.href = 'https://fonts.googleapis.com/css?family=' + encodeURIComponent(b.fontFamily) + ':400,600,700&display=swap';
    } else if (b.fontMode === 'upload' && b.fontFile) {
      el = document.createElement('style');
      el.appendChild(document.createTextNode('@font-face{font-family:SignageCustom;src:url("' + b.fontFile + '");font-display:swap}'));
    }
    if (el) {
      el.id = 'brand-font';
      document.getElementsByTagName('head')[0].appendChild(el);
    }
  }

  function branding() {
    return (state && state.branding) || { primaryColor: '#1f2937', accentColor: '#3b82f6', textColor: '#ffffff', orgName: '' };
  }

  // ---------- slide elements ----------

  function makeText(slide) {
    var b = branding();
    var root = document.createElement('div');
    root.className = 'text-slide';
    root.style.background = b.primaryColor;
    root.style.color = b.textColor;
    var font = fontFamily(b);
    if (font) root.style.fontFamily = font;
    var rule = document.createElement('div');
    rule.className = 'rule';
    rule.style.background = b.accentColor;
    root.appendChild(rule);
    var h = document.createElement('h1');
    h.textContent = slide.title || '';
    root.appendChild(h);
    if (slide.body) {
      var p = document.createElement('p');
      p.textContent = slide.body;
      root.appendChild(p);
    }
    if (b.logo) {
      var logo = document.createElement('img');
      logo.className = 'logo';
      logo.src = b.logo;
      root.appendChild(logo);
    }
    return root;
  }

  function loadHls(cb) {
    if (window.Hls) return cb();
    var s = document.createElement('script');
    s.src = '/vendor/hls.min.js';
    s.onload = cb;
    s.onerror = cb;
    document.getElementsByTagName('head')[0].appendChild(s);
  }

  function hlsConfig(slide) {
    // A feed from this server has 1-second segments, so it can buffer very little
    // and jump back to the live edge if it falls behind. Others keep gentler settings.
    if (slide.src.indexOf('/live/') === 0) {
      return { liveSyncDurationCount: 2, liveMaxLatencyDurationCount: 5, maxBufferLength: 4, maxMaxBufferLength: 8, backBufferLength: 4 };
    }
    return { liveSyncDurationCount: 2, maxBufferLength: 10, backBufferLength: 10 };
  }

  // Builds a slide in a hidden layer and calls back when it is ready to show (or has failed).
  function build(slide, done) {
    var layer = document.createElement('div');
    layer.className = 'layer';
    stage.appendChild(layer);
    var prep = { slide: slide, layer: layer, el: null, hls: null, disposed: false };
    var finished = false;
    var timer = null;

    function finish(ok) {
      if (finished || prep.disposed) return;
      finished = true;
      clearTimeout(timer);
      done(prep, ok);
    }

    timer = setTimeout(function () {
      // Slow web pages still show; slow media counts as failed.
      finish(slide.type === 'web' || slide.type === 'text');
    }, READY_TIMEOUT_MS);

    if (slide.type === 'text') {
      prep.el = makeText(slide);
      layer.appendChild(prep.el);
      finish(true);
    } else if (slide.type === 'image') {
      var img = document.createElement('img');
      prep.el = img;
      img.onload = function () { finish(true); };
      img.onerror = function () { finish(false); };
      layer.appendChild(img);
      MediaCache.resolve(slide.src, function (url) { if (!prep.disposed) img.src = url; });
    } else if (slide.type === 'web') {
      var frame = document.createElement('iframe');
      prep.el = frame;
      frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
      frame.setAttribute('allow', 'autoplay');
      frame.setAttribute('scrolling', 'no');
      frame.onload = function () { finish(true); };
      frame.src = slide.src;
      layer.appendChild(frame);
    } else if (slide.type === 'video' || slide.type === 'hls') {
      var video = document.createElement('video');
      prep.el = video;
      video.muted = true;
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');
      video.setAttribute('webkit-playsinline', '');
      video.preload = 'auto';
      video.addEventListener('canplay', function () { finish(true); });
      video.addEventListener('error', function () {
        finish(false);
        if (finished && current === prep) failCurrent();
      });
      layer.appendChild(video);
      if (slide.type === 'video') {
        MediaCache.resolve(slide.src, function (url) { if (!prep.disposed) video.src = url; });
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = slide.src;
      } else {
        loadHls(function () {
          if (prep.disposed) return;
          if (!window.Hls || !window.Hls.isSupported()) return finish(false);
          var hls = new window.Hls(hlsConfig(slide));
          prep.hls = hls;
          var triedMediaRecovery = false;
          hls.on(window.Hls.Events.ERROR, function (event, data) {
            if (!data.fatal) return;
            if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR && !triedMediaRecovery) {
              triedMediaRecovery = true;
              hls.recoverMediaError();
              return;
            }
            if (!finished) finish(false);
            else if (current === prep) failCurrent();
            else prep.failed = true; // loading off-screen: show() builds it again
          });
          hls.loadSource(slide.src);
          hls.attachMedia(video);
        });
      }
    } else {
      finish(false);
    }
    return prep;
  }

  function dispose(prep) {
    if (!prep || prep.disposed) return;
    prep.disposed = true;
    if (prep.hls) {
      try { prep.hls.destroy(); } catch (e) {}
    }
    if (prep.el && prep.el.tagName === 'VIDEO') {
      try {
        prep.el.pause();
        prep.el.removeAttribute('src');
        prep.el.load();
      } catch (e) {}
    }
    if (prep.layer.parentNode) prep.layer.parentNode.removeChild(prep.layer);
  }

  function playVideo(prep) {
    var video = prep.el;
    var wantSound = prep.slide.audio && !isPreview;
    video.muted = !wantSound;
    if (wantSound) video.removeAttribute('muted');
    var p = video.play();
    if (p && p['catch']) {
      p['catch'](function () {
        if (prep.disposed || current !== prep) return;
        // TV browsers often block sound without a kiosk setting. Silent beats frozen.
        if (!video.muted) {
          video.muted = true;
          var retry = video.play();
          if (retry && retry['catch']) retry['catch'](function () { if (current === prep) failCurrent(); });
        } else {
          failCurrent();
        }
      });
    }
  }

  // ---------- transitions ----------

  function setStyle(el, prop, value) {
    el.style[prop] = value;
    el.style['webkit' + prop.charAt(0).toUpperCase() + prop.slice(1)] = value;
  }

  function swapIn(prep) {
    var incoming = prep.layer;
    var outgoing = current;
    var transition = prep.slide.transition;
    hideIdle();
    incoming.style.zIndex = String(++zIndex);
    incoming.style.visibility = 'visible';

    if (outgoing && transition !== 'cut') {
      if (transition === 'slide') {
        setStyle(incoming, 'transform', 'translateX(100%)');
      } else {
        incoming.style.opacity = '0';
      }
      void incoming.offsetWidth;
      setStyle(incoming, 'transition', 'all ' + FADE_MS + 'ms ease');
      if (transition === 'slide') {
        setStyle(outgoing.layer, 'transition', 'all ' + FADE_MS + 'ms ease');
        setStyle(outgoing.layer, 'transform', 'translateX(-100%)');
        setStyle(incoming, 'transform', 'translateX(0)');
      } else {
        incoming.style.opacity = '1';
      }
      setTimeout(function () { dispose(outgoing); }, FADE_MS + 100);
    } else if (outgoing) {
      dispose(outgoing);
    }

    current = prep;
    failures = 0;
    if (prep.el && prep.el.tagName === 'VIDEO') {
      prep.el.addEventListener('ended', function () { if (current === prep && deadline === null) advance(); });
      playVideo(prep);
    }
    arm();
    heartbeat();
  }

  // ---------- playback ----------

  function activeList() {
    if (!state) return [];
    return state.override ? state.override.slides : state.slides;
  }

  function arm() {
    clearTimeout(endTimer);
    deadline = null;
    lastProgress = { time: -1, at: Date.now() };
    if (!current) return;
    var d = current.slide.duration;
    if (d) {
      deadline = Date.now() + d * 1000;
      endTimer = setTimeout(advance, d * 1000);
    }
  }

  function nextIndex(list) {
    var i = indexes[mode] || 0;
    return list.length ? (i + 1) % list.length : 0;
  }

  function advance() {
    var list = activeList();
    if (!list.length) return showIdle();
    var i = nextIndex(list);
    var slide = list[i];
    indexes[mode] = i;
    if (current && slide.key === current.slide.key) {
      // Only one slide: leave it up instead of transitioning to itself.
      if (current.el && current.el.tagName === 'VIDEO' && current.slide.type === 'video') {
        try { current.el.currentTime = 0; } catch (e) {}
        playVideo(current);
      }
      arm();
      return;
    }
    show(slide);
  }

  function show(slide) {
    var token = ++showToken;
    var ready = prepared;
    prepared = null;
    if (ready && ready.slide.key === slide.key) {
      if (ready.isReady && !ready.failed) return swapIn(ready);
      if (!ready.failed) {
        ready.onReady = function (ok) {
          if (token !== showToken) return;
          if (ok) swapIn(ready);
          else showFresh(slide, token, true);
        };
        return;
      }
    }
    dispose(ready);
    showFresh(slide, token, true);
  }

  function showFresh(slide, token, mayRetry) {
    build(slide, function (prep, ok) {
      if (token !== showToken) return dispose(prep);
      if (ok) return swapIn(prep);
      dispose(prep);
      // Some TVs decode only one video at a time: free the current one and retry.
      if (mayRetry && current && current.el && current.el.tagName === 'VIDEO' && (slide.type === 'video' || slide.type === 'hls')) {
        clearTimeout(endTimer);
        dispose(current);
        current = null;
        return showFresh(slide, token, false);
      }
      skipBroken();
    });
  }

  function skipBroken() {
    failures += 1;
    var list = activeList();
    clearTimeout(endTimer);
    if (failures >= Math.max(list.length, 1)) {
      // Everything is failing: back off so this doesn't spin, and try again shortly.
      // showIdle clears the timer, so it has to run first or the retry never happens.
      failures = 0;
      if (!current) showIdle();
      endTimer = setTimeout(advance, list.length && list[0].type === 'hls' ? HLS_RETRY_MS : RETRY_MS);
      return;
    }
    endTimer = setTimeout(advance, 500);
  }

  function failCurrent() {
    var dead = current;
    current = null;
    if (dead) dispose(dead);
    skipBroken();
  }

  function prepareNext() {
    if (prepared || !current) return;
    var list = activeList();
    if (list.length < 2) return;
    var slide = list[nextIndex(list)];
    if (slide.key === current.slide.key) return;
    var prep = build(slide, function (p, ok) {
      p.isReady = ok;
      p.failed = !ok;
      if (p.onReady) p.onReady(ok);
    });
    prepared = prep;
  }

  function remainingSeconds() {
    if (!current) return null;
    if (deadline !== null) return (deadline - Date.now()) / 1000;
    var el = current.el;
    if (el && el.tagName === 'VIDEO' && el.duration && isFinite(el.duration)) return el.duration - el.currentTime;
    return null;
  }

  function tick() {
    if (overrideEndsAt && Date.now() >= overrideEndsAt && state && state.override) {
      overrideEndsAt = null;
      state.override = null;
      reconcile();
    }
    var left = remainingSeconds();
    if (left !== null && left <= PRELOAD_LEAD_S) prepareNext();

    // A video or live stream that stops making progress gets skipped.
    var playing = current && (current.slide.type === 'video' || current.slide.type === 'hls') && current.el;
    if (playing && !current.el.paused) {
      var t = current.el.currentTime;
      if (t !== lastProgress.time) {
        lastProgress = { time: t, at: Date.now() };
      } else if (Date.now() - lastProgress.at > STALL_S * 1000) {
        failCurrent();
      }
    } else if (playing && current.el.paused && !current.el.ended) {
      if (Date.now() - lastProgress.at > STALL_S * 1000) failCurrent();
    }
  }

  function showIdle() {
    showToken++;
    clearTimeout(endTimer);
    deadline = null;
    dispose(prepared);
    prepared = null;
    if (current) dispose(current);
    current = null;
    var b = branding();
    if (!idleEl) {
      idleEl = document.createElement('div');
      idleEl.className = 'idle';
      stage.appendChild(idleEl);
    }
    idleEl.innerHTML = '';
    idleEl.style.background = b.primaryColor;
    idleEl.style.color = b.textColor;
    idleEl.style.display = '';
    var font = fontFamily(b);
    idleEl.style.fontFamily = font || '';
    if (b.logo) {
      var img = document.createElement('img');
      img.src = b.logo;
      idleEl.appendChild(img);
    }
    var h = document.createElement('h1');
    h.textContent = b.orgName || '';
    idleEl.appendChild(h);
    heartbeat();
  }

  function hideIdle() {
    if (idleEl) idleEl.style.display = 'none';
  }

  // Applies a new state without interrupting what is playing, unless it must change.
  function reconcile() {
    var list = activeList();
    var newMode = state && state.override ? 'o' + state.override.id : 'playlist';
    var modeChanged = newMode !== mode;
    mode = newMode;

    if (prepared) {
      // The next slide may have moved or gone; rebuild it from the new list.
      dispose(prepared);
      prepared = null;
    }
    if (!list.length) return showIdle();

    var position = -1;
    if (current) {
      for (var i = 0; i < list.length; i++) {
        if (list[i].key === current.slide.key) position = i;
      }
    }
    if (position >= 0 && !modeChanged) {
      indexes[mode] = position;
      if (deadline === null && current.slide.duration) arm();
      return;
    }
    if (modeChanged && mode !== 'playlist') indexes[mode] = 0;
    var start = indexes[mode] || 0;
    if (start >= list.length) start = 0;
    indexes[mode] = start;
    show(list[start]);
  }

  // ---------- server messages ----------

  function showMessage(build) {
    messageEl.innerHTML = '';
    build(messageEl);
    messageEl.hidden = false;
    messageEl.style.display = '';
  }

  function hideMessage() {
    messageEl.hidden = true;
    messageEl.style.display = 'none';
  }

  function textEl(cls, text) {
    var d = document.createElement('div');
    d.className = cls;
    d.textContent = text;
    return d;
  }

  function checkVersion(version) {
    if (!version) return;
    if (pageVersion && pageVersion !== version) location.reload();
    pageVersion = version;
  }

  function onState(msg, fromStorage) {
    state = msg;
    if (!fromStorage) checkVersion(msg.version);
    hideMessage();
    applyBranding(msg.branding);
    overrideEndsAt = msg.override && msg.override.remainingMs !== null && !fromStorage
      ? Date.now() + msg.override.remainingMs : null;
    if (!fromStorage && !isPreview) {
      // Saved so the page can resume if a kiosk reloads it while the server is away.
      var saved = JSON.parse(JSON.stringify(msg));
      saved.override = null;
      store('signage-last-state:' + (slug || ''), JSON.stringify(saved));
      MediaCache.sync(cacheableUrls());
    }
    reconcile();
  }

  function onMessage(ev) {
    lastMessageAt = Date.now();
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'state') {
      onState(msg, false);
    } else if (msg.type === 'pair') {
      checkVersion(msg.version);
      applyBranding(msg.branding);
      showMessage(function (root) {
        if (msg.branding && msg.branding.orgName) root.appendChild(textEl('org', msg.branding.orgName));
        root.appendChild(textEl('label', 'Pair this TV'));
        root.appendChild(textEl('code', msg.code));
        root.appendChild(textEl('label', 'In the admin, go to Screens and enter this code.'));
      });
    } else if (msg.type === 'assign') {
      location.replace('/play/' + encodeURIComponent(msg.slug));
    } else if (msg.type === 'unassign') {
      location.replace('/tv');
    } else if (msg.type === 'error') {
      showMessage(function (root) { root.appendChild(textEl('label', msg.message)); });
    }
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    try {
      ws = new WebSocket(proto + location.host + '/ws/player');
    } catch (e) {
      return setTimeout(connect, reconnectDelay);
    }
    ws.onopen = function () {
      reconnectDelay = 1000;
      lastMessageAt = Date.now();
      ws.send(JSON.stringify({ type: 'hello', deviceId: isPreview ? undefined : deviceId(), slug: slug, preview: isPreview }));
      heartbeat();
    };
    ws.onmessage = onMessage;
    ws.onerror = function () {};
    ws.onclose = function () {
      ws = null;
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    };
  }

  function heartbeat() {
    if (isPreview || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ type: 'hb', item: current ? current.slide.name : null }));
  }

  // ---------- fullscreen ----------

  function goFullscreen() {
    var el = document.documentElement;
    var fn = el.requestFullscreen || el.webkitRequestFullscreen || el.webkitRequestFullScreen;
    if (fn) {
      try {
        var p = fn.call(el);
        if (p && p['catch']) p['catch'](function () {});
      } catch (e) {}
    }
    hintEl.hidden = true;
  }

  function setupFullscreen() {
    if (isPreview) return;
    document.addEventListener('click', goFullscreen);
    document.addEventListener('keydown', goFullscreen);
    var alreadyFull = window.innerHeight >= screen.height - 1;
    if (!alreadyFull && (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)) {
      hintEl.hidden = false;
      setTimeout(function () { hintEl.hidden = true; }, 10000);
    }
  }

  // ---------- start ----------

  if (window.isSecureContext && navigator.serviceWorker && !isPreview) {
    try {
      var reg = navigator.serviceWorker.register('/sw.js');
      if (reg && reg['catch']) reg['catch'](function () {});
    } catch (e) {}
  }

  setupFullscreen();
  if (!isPreview) {
    var savedState = load('signage-last-state:' + (slug || ''));
    if (savedState) {
      try { onState(JSON.parse(savedState), true); } catch (e) {}
    }
  }
  connect();

  setInterval(tick, 1000);
  setInterval(heartbeat, 10000);
  setInterval(function () {
    // A silent socket can look open for a long time after a network drop.
    if (ws && ws.readyState === 1 && Date.now() - lastMessageAt > 40000) ws.close();
  }, 5000);
})();
