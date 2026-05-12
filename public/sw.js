const CACHE_NAME = 'cctv-monitor-v4';
const STATIC_CACHE = 'cctv-static-v4';
const DYNAMIC_CACHE = 'cctv-dynamic-v4';

const scopePath = new URL(self.registration.scope).pathname.replace(/\/+$/, '') || '';
const withScope = (p) => (scopePath ? `${scopePath}${p}` : p);

const STATIC_ASSETS = [
    withScope('/'),
    withScope('/archive'),
    withScope('/manifest.json'),
    withScope('/icon-72x72.png'),
    withScope('/icon-96x96.png'),
    withScope('/icon-128x128.png'),
    withScope('/icon-144x144.png'),
    withScope('/icon-152x152.png'),
    withScope('/icon-192x192.png'),
    withScope('/icon-384x384.png'),
    withScope('/icon-512x512.png')
];

const NO_CACHE_ROUTES = [withScope('/login'), withScope('/admin'), withScope('/admin/recordings')];

// Install event - cache static assets
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(STATIC_CACHE)
            .then((cache) => {
                console.log('[SW] Caching static assets');
                return cache.addAll(STATIC_ASSETS);
            })
            .catch((err) => console.log('[SW] Cache failed:', err))
    );
    self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== STATIC_CACHE && name !== DYNAMIC_CACHE)
                    .map((name) => caches.delete(name))
            );
        })
    );
    self.clients.claim();
});

// Fetch event - cache strategies
self.addEventListener('fetch', (event) => {
    const { request } = event;
    const url = new URL(request.url);

    // Skip non-GET requests
    if (request.method !== 'GET') return;

    // Never cache authentication pages - always fetch from network
    if (NO_CACHE_ROUTES.includes(url.pathname)) {
        event.respondWith(fetch(request));
        return;
    }

    // 1. HTML and Navigate requests (Document) - Network First
    // This ensures dynamic pages like / and /archive are always up to date when online
    if (request.mode === 'navigate' ||
        request.destination === 'document' ||
        url.pathname === withScope('/') ||
        url.pathname === withScope('/archive')) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    const clone = response.clone();
                    caches.open(DYNAMIC_CACHE).then((cache) => {
                        cache.put(request, clone);
                    });
                    return response;
                })
                .catch(() => caches.match(request))
        );
        return;
    }

    // 2. API calls - network first, cache fallback
    if (url.pathname.startsWith(withScope('/api/'))) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    // Don't cache auth responses
                    if (url.pathname.includes(withScope('/login')) || url.pathname.includes(withScope('/logout'))) {
                        return response;
                    }
                    const clone = response.clone();
                    caches.open(DYNAMIC_CACHE).then((cache) => {
                        cache.put(request, clone);
                    });
                    return response;
                })
                .catch(() => caches.match(request))
        );
        return;
    }

    // 3. Static assets (Images, Scripts, Styles) - Cache First
    if (request.destination === 'image' ||
        request.destination === 'script' ||
        request.destination === 'style') {
        event.respondWith(
            caches.match(request).then((response) => {
                return response || fetch(request).then((fetchResponse) => {
                    return caches.open(DYNAMIC_CACHE).then((cache) => {
                        cache.put(request, fetchResponse.clone());
                        return fetchResponse;
                    });
                });
            })
        );
        return;
    }

    // Default - network first (for anything else), don't cache
    event.respondWith(
        fetch(request)
            .then((response) => response)
            .catch(() => caches.match(request))
    );
});


// Push notification event
self.addEventListener('push', (event) => {
    const data = event.data.json();
    const options = {
        body: data.body || 'New notification from CCTV Monitor',
        icon: '/icon-192x192.png',
        badge: '/icon-72x72.png',
        tag: data.tag || 'cctv-notification',
        requireInteraction: true,
        actions: [
            {
                action: 'view',
                title: 'View Camera'
            },
            {
                action: 'dismiss',
                title: 'Dismiss'
            }
        ],
        data: {
            url: data.url || '/'
        }
    };

    event.waitUntil(
        self.registration.showNotification(data.title || 'CCTV Monitor', options)
    );
});

// Notification click event
self.addEventListener('notificationclick', (event) => {
    event.notification.close();

    const { action, notification } = event;
    const url = notification.data?.url || '/';

    if (action === 'view' || !action) {
        event.waitUntil(
            clients.openWindow(url)
        );
    }
});

// Background sync for offline actions
self.addEventListener('sync', (event) => {
    if (event.tag === 'sync-recordings') {
        event.waitUntil(syncRecordings());
    }
});

async function syncRecordings() {
    // Sync any pending offline actions
    const cache = await caches.open(DYNAMIC_CACHE);
    const requests = await cache.keys();

    for (const request of requests) {
        if (request.url.includes('/api/')) {
            try {
                await fetch(request);
                await cache.delete(request);
            } catch (err) {
                console.log('[SW] Sync failed for:', request.url);
            }
        }
    }
}
