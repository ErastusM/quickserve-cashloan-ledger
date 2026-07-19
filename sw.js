const CACHE_NAME = "quickserve-cashloan-v20";
// Build number, derived so it cannot drift from CACHE_NAME. The page asks for
// this to tell "genuinely stale" from "already running the new build".
const BUILD = CACHE_NAME.replace(/\D+/g, "");
const APP_ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=20",
  "./import-data.js?v=20",
  "./app.js?v=20",
  "./manifest.json",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
  "./favicon-32.png",
  "./brand-logo.svg"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    )
  );
  self.clients.claim();
});

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "version" && event.ports[0]) {
    event.ports[0].postMessage({ version: BUILD });
  }
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  event.respondWith(
    fetch(event.request).then((response) => {
      // Only cache real successes. fetch() resolves for 404s and 5xx too, and
      // caching one would overwrite a good asset with an error page and serve
      // it offline from then on.
      if (response.ok && response.type === "basic") {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy)).catch(() => {});
      }
      return response;
    }).catch(() =>
      caches.match(event.request).then((cached) => {
        if (cached) return cached;
        // Only fall back to the shell for page loads. Returning HTML for a
        // missing image or script just produces a confusing parse error.
        if (event.request.mode === "navigate") return caches.match("./index.html");
        return Response.error();
      })
    )
  );
});
