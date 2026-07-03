// Minimal service worker: caches the app shell for offline launch and enables
// the PWA share target. Network-first for everything else so saves stay fresh.
const CACHE = "inbox-v1";
const SHELL = [
  "./index.html",
  "./styles.css",
  "./main.js",
  "./app.js",
  "./manifest.webmanifest",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;

  // Only ever handle same-origin requests. Cross-origin API/CDN calls
  // (Jina, Supabase, esm.sh, Puter) must pass straight through — otherwise a
  // network blip would make us serve the cached shell as a bogus 200 and the
  // app would parse its own HTML as the response.
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // App shell / same-origin assets: network-first, fall back to cache.
  // The index.html fallback is reserved for navigations only.
  e.respondWith(
    fetch(request).catch(() =>
      caches.match(request).then(
        (r) => r || (request.mode === "navigate" ? caches.match("./index.html") : Response.error())
      )
    )
  );
});
