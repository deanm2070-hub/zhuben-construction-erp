// Makes the site installable as a desktop app. It caches nothing: every page and file comes from the network,
// so a new version is never applied behind the user's back (the page asks first, see lib/update.ts).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => { e.respondWith(fetch(e.request)); });
