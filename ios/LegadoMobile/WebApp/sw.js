// App-shell cache so the UI opens instantly and survives a flaky connection.
// API responses are never cached: they must always be fresh.
const CACHE = 'legado-shell-v1';
const SHELL = [
  '/', '/index.html', '/css/app.css', '/js/app.js',
  '/manifest.webmanifest', '/icons/icon-180.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // never cache the API
  const isApi = /^\/(get|save|delete|cover|image|searchBook|api\/)/.test(url.pathname);
  if (isApi) return;

  e.respondWith(
    caches.match(e.request).then((hit) => {
      if (hit) {
        // stale-while-revalidate for shell assets
        fetch(e.request).then((r) => {
          if (r && r.ok) caches.open(CACHE).then((c) => c.put(e.request, r.clone()));
        }).catch(() => {});
        return hit;
      }
      return fetch(e.request).catch(() => caches.match('/index.html'));
    }),
  );
});
