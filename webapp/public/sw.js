// Offline support: the app shell is cache-first, report data network-first
// with the last good copy as fallback. Writes (POST) are never cached; the
// app keeps its own outbox for those.
const VERSION = 'hm-v3.6';
const SHELL = `${VERSION}-shell`;
const DATA = `${VERSION}-data`;
const FONTS = `${VERSION}-fonts`;
const SHELL_FILES = [
  '/', '/index.html', '/app.css', '/app.js', '/api.js', '/swipe.js',
  '/manifest.webmanifest', '/icon-192.png', '/icon-512.png', '/icon-maskable-512.png', '/apple-touch-icon.png',
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
    // /api/me decides whether the user must log in again, and admin data
    // (users, security log) should not linger on the phone: never cache them.
    if (url.pathname === '/api/me' || url.pathname.startsWith('/api/admin/') || url.pathname.startsWith('/api/push/')) return;
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

// Notifications for serious events and for a missing morning report. The
// payload is {title, body, url}; the url must stay inside the app.
// kind "refresh" (an admin's "update everyone") also fetches a new service
// worker if one is deployed and tells open windows to reload.
function safeUrl(url) {
  try {
    const u = new URL(url || '/', self.location.origin);
    return u.origin === self.location.origin ? u.href : self.location.origin + '/';
  } catch { return self.location.origin + '/'; }
}

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  const title = String(data.title || 'Hotmonitor').slice(0, 120);
  const refresh = data.kind === 'refresh';
  event.waitUntil(Promise.all([
    self.registration.showNotification(title, {
      body: String(data.body || '').slice(0, 300),
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      tag: data.tag ? String(data.tag) : undefined,
      data: { url: safeUrl(data.url), refresh },
    }),
    refresh ? announceRefresh() : null,
  ]));
});

async function announceRefresh() {
  try { await self.registration.update(); } catch { /* offline: the app checks again when opened */ }
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const w of wins) w.postMessage({ type: 'hm-refresh' });
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = safeUrl(event.notification.data && event.notification.data.url);
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      if (new URL(w.url).origin === self.location.origin) {
        await w.focus();
        if (event.notification.data && event.notification.data.refresh) {
          w.postMessage({ type: 'hm-refresh' });
          return;
        }
        if ('navigate' in w) { try { await w.navigate(url); } catch { /* cross-state navigation refused */ } }
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
