// Service worker de Angelo: guarda la app y la IA para que abra rápido y funcione sin internet.
const VERSION = 'angelo-v5';
const SHELL = [
  './', './index.html', './styles.css', './manifest.json',
  './js/app.js', './js/vision.js', './js/cutout.js', './js/tracker.js', './js/geometry.js',
  './vendor/mediapipe/vision_bundle.mjs',
  './icons/icon-192.png', './icons/icon-512.png', './icons/apple-touch-icon.png', './icons/favicon-32.png',
];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const isHeavy = url.pathname.includes('/models/') || url.pathname.includes('/vendor/');
  if (isHeavy) {
    // Modelos y WASM: primero caché (son grandes y no cambian).
    e.respondWith(caches.open(VERSION).then(async (c) => {
      const hit = await c.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res.ok && res.status === 200) c.put(req, res.clone());
      return res;
    }));
    return;
  }
  // App: primero red (para recibir actualizaciones), si no hay internet usa caché.
  e.respondWith(fetch(req).then((res) => {
    if (res.ok && res.status === 200) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
    return res;
  }).catch(() => caches.match(req).then((r) => r || caches.match('./index.html'))));
});
