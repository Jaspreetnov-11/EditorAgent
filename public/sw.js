// 🖥 Lets Chrome / Edge install the editor as a Desktop app (manifest.webmanifest). Nothing is cached: every request
// goes to the editing computer as before, so the app is never out of date.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => {});
