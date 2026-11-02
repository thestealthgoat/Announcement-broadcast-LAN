// Keeps the player page itself available offline where the browser allows
// service workers (HTTPS or localhost). Media is cached by the player in
// IndexedDB, which also works over plain http on a LAN.
var SHELL = 'signage-shell-v1';

self.addEventListener('install', function (event) {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', function (event) {
  event.waitUntil(self.clients.claim());
});

function isShell(url) {
  return url.origin === self.location.origin &&
    (url.pathname === '/tv' || url.pathname.indexOf('/play/') === 0 || url.pathname.indexOf('/player/') === 0 ||
     url.pathname === '/vendor/hls.min.js');
}

self.addEventListener('fetch', function (event) {
  if (event.request.method !== 'GET') return;
  var url = new URL(event.request.url);
  if (!isShell(url)) return;
  event.respondWith(
    fetch(event.request).then(function (res) {
      if (res.ok) {
        var copy = res.clone();
        caches.open(SHELL).then(function (c) { c.put(event.request, copy); });
      }
      return res;
    }).catch(function () {
      return caches.match(event.request, { ignoreSearch: true });
    })
  );
});
