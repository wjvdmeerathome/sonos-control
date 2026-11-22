// Minimale service worker: maakt de app installeerbaar. Alles gaat via het netwerk,
// want de app is zonder lokale server toch niet bruikbaar.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
