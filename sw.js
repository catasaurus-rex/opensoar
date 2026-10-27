// Offline support: app files network-first (so updates arrive), map tiles
// cache-first (so tiles you've seen still load at the field).
const APP = 'opensoar-app-v2';
const TILES = 'opensoar-tiles-v1';
const SHELL = ['./', 'index.html', 'style.css', 'flight.js', 'app.js', 'manifest.webmanifest', 'icon.svg',
  'vendor/leaflet/leaflet.css', 'vendor/leaflet/leaflet.js'];
const MAX_TILES = 3000;

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(APP).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  const isTile = url.hostname.endsWith('tile.opentopomap.org') || url.hostname === 's3.amazonaws.com';
  if (isTile) {
    e.respondWith(caches.open(TILES).then(async (c) => {
      const hit = await c.match(e.request);
      if (hit) return hit;
      const res = await fetch(e.request);
      if (res.ok) {
        c.put(e.request, res.clone());
        c.keys().then((k) => { if (k.length > MAX_TILES) k.slice(0, k.length - MAX_TILES).forEach((r) => c.delete(r)); });
      }
      return res;
    }));
    return;
  }
  e.respondWith(fetch(e.request).then((res) => {
    if (res.ok && url.origin === location.origin) {
      const copy = res.clone(); caches.open(APP).then((c) => c.put(e.request, copy));
    }
    return res;
  }).catch(() => caches.match(e.request)));
});
