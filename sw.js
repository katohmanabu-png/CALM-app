// Self-destructing service worker: clears all caches and unregisters itself
self.addEventListener('install', function(event) {
  event.waitUntil(
    caches.keys().then(function(names) {
      return Promise.all(names.map(function(name) { return caches.delete(name); }));
    }).then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(event) {
  event.waitUntil(
    self.registration.unregister().then(function() {
      return self.clients.matchAll({ type: 'window' });
    }).then(function(clients) {
      clients.forEach(function(client) { client.navigate(client.url); });
    })
  );
});
