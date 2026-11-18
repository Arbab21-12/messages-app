'use strict';
/* عامل خدمة «رسائلي» — دوره الوحيد: استقبال إشعارات Web Push وعرضها،
 * والتركيز على نافذة التطبيق (أو فتحها) عند الضغط على الإشعار. */
self.addEventListener('install', () => {
  self.skipWaiting();
});
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = {};
  if (event.data) {
    try { data = event.data.json() || {}; }
    catch { try { data = { body: event.data.text() }; } catch { data = {}; } }
  }
  const title = data.title || 'رسائلي';
  const options = {
    body: data.body || '',
    icon: '/icon.svg',
    data: { url: '/' },
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  event.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const win of wins) {
      if ('focus' in win) {
        try { await win.focus(); return; } catch {}
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(url);
  })());
});
