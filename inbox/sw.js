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
  e.respondWith(
    fetch(request).catch(() => caches.match(request).then((r) => r || caches.match("./index.html")))
  );
});
