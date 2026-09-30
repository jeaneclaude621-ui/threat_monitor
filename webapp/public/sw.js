// Offline support: the app shell is cache-first, report data network-first
// with the last good copy as fallback. Writes (POST) are never cached; the
// app keeps its own outbox for those.
const VERSION = 'hm-v1';
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
const FONTS = `${VERSION}-fonts`;
const SHELL_FILES = [
  '/', '/index.html', '/app.css', '/app.js', '/api.js', '/swipe.js',
  '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL).then((c) => c.addAll(SHELL_FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

function offline() {
  return new Response(JSON.stringify({ error: 'offline' }), {
    status: 503, headers: { 'Content-Type': 'application/json' },
  });
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === 'https://fonts.googleapis.com' || url.origin === 'https://fonts.gstatic.com') {
    event.respondWith(caches.open(FONTS).then(async (cache) => {
      const hit = await cache.match(req);
      const fresh = fetch(req).then((res) => { if (res.ok) cache.put(req, res.clone()); return res; }).catch(() => hit);
      return hit || fresh;
    }));
    return;
  }
  if (url.origin !== self.location.origin) return;

  if (url.pathname.startsWith('/api/')) {
    // /api/me decides whether the user must log in again: never answer it from cache.
    if (url.pathname === '/api/me') return;
    event.respondWith((async () => {
      const cache = await caches.open(DATA);
      try {
        const res = await fetch(req);
        const type = res.headers.get('content-type') || '';
        if (res.ok && type.includes('application/json')) cache.put(req, res.clone());
        return res;
      } catch {
        return (await cache.match(req)) || offline();
      }
    })());
    return;
  }

  // Page loads go to the network first: an expired Access session must be
  // able to redirect to its login page. The cached shell is the offline copy.
  if (req.mode === 'navigate') {
    event.respondWith(fetch(req).catch(async () => (await caches.match('/index.html')) || offline()));
    return;
  }

  // Scripts, styles, icons: cache first, refresh in the background.
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const key = req;
    const hit = await cache.match(key);
    const fresh = fetch(req).then((res) => {
      if (res.ok && res.type === 'basic') cache.put(key, res.clone());
      return res;
    }).catch(() => hit);
    return hit || fresh;
  })());
});
