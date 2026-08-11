const CACHE_NAME = "quickserve-cashloan-v33";
// Build number, derived so it cannot drift from CACHE_NAME. The page asks for
// this to tell "genuinely stale" from "already running the new build".
const BUILD = CACHE_NAME.replace(/\D+/g, "");
const APP_ASSETS = [
  "./",
  "./index.html",
  "./styles.css?v=33",
  "./import-data.js?v=33",
  "./app.js?v=33",
  "./cloud.js?v=33",
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
  const request = event.request;
  if (request.method !== "GET") return;

  // Leave anything this app does not serve well alone — WhatsApp links and the
  // like. Intercepting a request we cannot improve only lets us break it.
  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;

  event.respondWith(networkFirst(request));
});

async function networkFirst(request) {
  try {
    const response = await fetch(request);
    // Only cache real successes. fetch() resolves for 404s and 5xx too, and
    // caching one would overwrite a good asset with an error page and keep
    // serving it offline.
    if (response.ok && response.type === "basic") {
      const copy = response.clone();
      caches.open(CACHE_NAME).then((cache) => cache.put(request, copy)).catch(() => {});
    }
    return response;
  } catch {
    return cacheFallback(request);
  }
}

async function cacheFallback(request) {
  const cache = await caches.open(CACHE_NAME);

  const exact = await cache.match(request);
  if (exact) return exact;

  // Assets carry a ?v=N cache-buster, and cache.match is exact by default. A
  // page left open across a release then asks for a version the cache does not
  // hold — offline, the same file without the query is far better than nothing.
  const ignoringQuery = await cache.match(request, { ignoreSearch: true });
  if (ignoringQuery) return ignoringQuery;

  // Page loads fall back to the shell. Guard it: an unguarded miss resolves
  // undefined, and respondWith(undefined) fails the navigation outright, so the
  // app would refuse to open at all offline.
  if (request.mode === "navigate") {
    const shell = (await cache.match("./index.html")) || (await cache.match("./"));
    if (shell) return shell;
  }

  // Never Response.error() — it surfaces as an opaque "FetchEvent resulted in a
  // network error response" with no clue what failed. A real response keeps the
  // failure legible and stops the console noise.
  return new Response("Offline, and this file is not in the cache.", {
    status: 503,
    statusText: "Offline",
    headers: { "Content-Type": "text/plain; charset=utf-8" }
  });
}
