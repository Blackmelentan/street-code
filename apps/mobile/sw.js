/* Street Code service worker: the app shell works offline; recently viewed data is available offline.
   API responses are cached in their own store so they can be wiped on sign-out. */
const SHELL = 'sc-shell-v1';
const API = 'sc-api-v1';
const FONTS = 'sc-fonts-v1';
const SHELL_FILES = ['/app/', '/app/app.js', '/app/app.css', '/design/design.css', '/design/ui.js', '/design/icons.svg', '/core/index.js', '/core/catalog.js', '/core/constants.js', '/core/service-engine.js', '/core/verdict.js', '/design/brand/mark.svg', '/design/brand/command-mark-glyph.svg', '/design/brand/favicon.svg'];
const CACHEABLE_API = /^\/api\/(vehicles|me\/|drive\/current|public\/catalog)/;

self.addEventListener('install', (e) => { e.waitUntil(caches.open(SHELL).then((c) => Promise.allSettled(SHELL_FILES.map((f) => c.add(f)))).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => ![SHELL, API, FONTS].includes(k)).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('message', (e) => { if (e.data === 'clear-api') caches.delete(API); });

self.addEventListener('fetch', (e) => {
  const req = e.request; const url = new URL(req.url);
  if (req.method !== 'GET') return;
  if (url.hostname === 'fonts.googleapis.com' || url.hostname === 'fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async (c) => (await c.match(req)) || fetch(req).then((r) => { c.put(req, r.clone()); return r; })));
    return;
  }
  if (url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/')) {
    if (!CACHEABLE_API.test(url.pathname)) return;
    e.respondWith(fetch(req).then((r) => { if (r.ok) { const copy = r.clone(); caches.open(API).then((c) => c.put(req, copy)); } return r; })
      .catch(() => caches.open(API).then((c) => c.match(req)).then((r) => r || new Response(JSON.stringify({ error: 'You are offline.' }), { status: 503, headers: { 'content-type': 'application/json' } }))));
    return;
  }
  // static: stale-while-revalidate
  e.respondWith(caches.open(SHELL).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: false });
    const net = fetch(req).then((r) => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => hit || (req.mode === 'navigate' ? c.match('/app/') : Response.error()));
    return hit || net;
  }));
});
