// Retires the phone app's offline service worker.
//
// The phone app used to register ./sw.js for the whole site, and browsers keep
// running an installed worker until they fetch a new one from the same
// address. This file replaces it: it installs, clears every cache the app made,
// unregisters itself and reloads any open phone-app tabs, which then land on
// the console. The admin console is never interrupted.
self.addEventListener("install", () => self.skipWaiting());

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((key) => caches.delete(key)));
    await self.registration.unregister();
    const windows = await self.clients.matchAll({ type: "window" });
    windows
      .filter((client) => !new URL(client.url).pathname.includes("/admin/"))
      .forEach((client) => client.navigate(client.url).catch(() => {}));
  })());
});
