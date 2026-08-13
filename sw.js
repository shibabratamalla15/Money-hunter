/**
 * Money Hunter — Service Worker
 * Caches the static app shell for offline "Add to Home Screen" use.
 * API calls (/v1/*) are always network-first — scan data should never be
 * served stale.
 */

const CACHE_NAME = "money-hunter-v1";
const APP_SHELL = ["/", "/index.html", "/ocr-engine.js", "/manifest.json"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Never cache API traffic — scan submission and trail data must be live.
  if (url.pathname.startsWith("/v1/") || url.pathname === "/healthz") {
    return; // let the browser handle it normally
  }

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
          return response;
        })
        .catch(() => cached); // offline and not cached: fail gracefully
    })
  );
});
