// Hallway service worker: offline app shell + push notifications.
// Paths are relative to this file so the app works under a sub-path (e.g. GitHub Pages).
const VERSION = 'lah-v20';
const SHELL = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'vendor/supabase.js',
  'vendor/qrcode.js',
  'js/app.js',
  'js/backend.js',
  'js/config.js',
  'js/lib.js',
  'js/icons.js',
  'js/pwa.js',
  'js/store.js',
  'js/branding.js',
  'js/xlsx.js',
  'js/zip.js',
  'js/views/common.js',
  'js/views/roles.js',
  'js/views/auth.js',
  'js/views/absences.js',
  'js/views/staff.js',
  'js/views/admin.js',
  'js/views/account.js',
  'js/views/platform.js',
  'js/views/icon-tool.js',
  'js/views/archive.js',
  'js/views/messages.js',
  'js/views/calendar.js',
  'js/views/alerts.js',
  'js/views/students.js',
  'js/views/turns.js',
  'js/views/maintenance.js',
  'js/views/rooms.js',
  'js/views/panels.js',
  'js/views/guide.js',
  'js/views/access.js',
  'js/nav.js',
  'js/alarm.js',
  'icons/icon-192.png',
  'icons/badge-72.png',
];
const scoped = (path) => new URL(path, self.registration.scope).href;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(VERSION)
      .then((cache) => cache.addAll(SHELL.map(scoped)))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Network first (so updates arrive right away), cache as fallback when offline.
// Only the app's own files are handled; Supabase requests always go to the network.
self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET' || !request.url.startsWith(self.registration.scope)) return;
  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request, { ignoreSearch: request.mode === 'navigate' });
        return cached || (request.mode === 'navigate' ? caches.match(scoped('index.html')) : Response.error());
      }),
  );
});

self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data?.text() };
  }
  const url = scoped(data.url || '');
  const urgent = !!data.urgent;
  // Notices about the same thing (an alert and its "Apareció") replace each other.
  const tag = data.tag || data.url || undefined;
  event.waitUntil(
    Promise.all([
      self.registration.showNotification(data.title || 'Hallway', {
        body: data.body || '',
        // The school's own icon (sent by the server) or the app's.
        icon: typeof data.icon === 'string' && data.icon.startsWith('https://') ? data.icon : scoped('icons/icon-192.png'),
        badge: scoped('icons/badge-72.png'),
        data: { url },
        tag,
        renotify: !!tag,
        // Urgent: stays on screen until touched and vibrates long (Android).
        requireInteraction: urgent,
        vibrate: urgent ? [500, 200, 500, 200, 900, 200, 900] : [200],
      }),
      self.clients
        .matchAll({ type: 'window', includeUncontrolled: true })
        .then((clients) =>
          clients.forEach((c) =>
            c.postMessage({ type: 'push', urgent, title: data.title || '', body: data.body || '', link: data.url || '' }),
          ),
        ),
    ]),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || self.registration.scope;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      const client = clients.find((c) => c.url.startsWith(self.registration.scope));
      if (client) {
        client.postMessage({ type: 'navigate', url });
        return client.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});
