// Admin portal background worker: shows a notification for every new
// application and opens that application when the notification is tapped.
// It does nothing else (no caching), so the portal always loads fresh.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let m = {};
  try { m = event.data ? event.data.json() : {}; } catch (e) { m = { body: event.data ? event.data.text() : "" }; }
  event.waitUntil(self.registration.showNotification(m.title || "QuickServe", {
    body: m.body || "",
    tag: m.tag || undefined,
    renotify: Boolean(m.tag),
    icon: "/icon-192.png",
    badge: "/icon-192.png",
    data: { url: m.url || "/" }
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL((event.notification.data && event.notification.data.url) || "/", self.location.origin).href;
  event.waitUntil(self.clients.openWindow(url));
});
