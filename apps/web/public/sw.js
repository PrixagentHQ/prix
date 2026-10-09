// The service worker of Prix. It does one thing: when a push arrives it shows one fixed
// notification, and a click on it opens /following. A push carries no data, so nothing about a
// person or an agent is ever read here. It caches nothing and intercepts no request.

self.addEventListener('push', (event) => {
  event.waitUntil(
    self.registration.showNotification('Prix', {
      body: 'An agent you follow has a new decision. It is a record of a paper-trading simulation.',
      tag: 'prix-note',
    }),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const open = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const here = open.find((client) => new URL(client.url).pathname === '/following');
      if (here) {
        await here.focus();
        return;
      }
      await self.clients.openWindow('/following');
    })(),
  );
});
