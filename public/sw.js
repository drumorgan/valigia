// Valigia service worker — Web Push only.
//
// Deliberately NO fetch handler and NO caching: the FTP deploy pipeline
// ships hash-fingerprinted bundles, and a caching SW is exactly how a
// deploy ends up half-applied ("everything gone" bug reports). This
// worker exists solely so the installed PWA can receive push events
// with the app closed — iOS requires an active service worker for
// Web Push on Home Screen web apps (16.4+).

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch (_) {
    data = { body: event.data ? event.data.text() : '' };
  }
  const title = data.title || 'Valigia';
  const options = {
    body: data.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/icon-192.png',
    data: { url: data.url || '/' },
    // Departure timing is perishable — let the OS collapse duplicates.
    tag: data.tag || 'valigia-departure',
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      for (const win of wins) {
        if ('focus' in win) return win.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
