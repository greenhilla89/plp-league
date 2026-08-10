// Minimal service worker: enables "install as app". Deliberately does NOT
// cache league data or the app shell aggressively — a prediction game must
// never show stale standings, so everything goes to the network first and
// the browser's normal HTTP cache handles the rest.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", (event) => {
  event.respondWith(fetch(event.request));
});
