// Offline-first service worker.
// Hosts like Cloudflare redirect /index.html -> /, and Chrome refuses to show a saved
// redirect, so every response is stored as a plain copy and the page shell lives at './'.
const CACHE = 'notes-%VERSION%';
const SHELL = './';
const FILES = [SHELL, './manifest.webmanifest', './icon-192.png', './icon-512.png', './icon-180.png'];

async function plain(res) {
  if (!res.redirected) return res;
  const body = await res.blob();
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
}
async function store(cache, key, res) {
  if (res && res.ok && res.type === 'basic') await cache.put(key, await plain(res.clone()));
}

self.addEventListener('install', e => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    await Promise.all(FILES.map(async u => store(c, u, await fetch(u, { cache: 'reload' }))));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  const isPage = req.mode === 'navigate';
  e.respondWith((async () => {
    const c = await caches.open(CACHE);
    const key = isPage ? SHELL : req;
    const cached = await c.match(key);
    const fresh = fetch(isPage ? SHELL : req).then(async res => { await store(c, key, res); return res; }).catch(() => null);
    if (cached) { e.waitUntil(fresh); return cached; }       // instant, works offline
    const res = await fresh;
    if (res) return plain(res);
    return new Response('<p style="font:16px sans-serif;padding:40px">Offline and not cached yet. Open Notes once while online.</p>',
      { status: 503, headers: { 'content-type': 'text/html' } });
  })());
});
