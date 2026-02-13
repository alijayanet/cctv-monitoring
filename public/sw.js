const CACHE_NAME = 'cctv-monitor-v2';
const STATIC_CACHE = 'cctv-static-v2';
const DYNAMIC_CACHE = 'cctv-dynamic-v2';

const STATIC_ASSETS = [
    '/',
    '/archive',
    '/manifest.json',
    '/icon-72x72.png',
    '/icon-96x96.png',
    '/icon-128x128.png',
    '/icon-144x144.png',
    '/icon-192x192.png',
    '/icon-512x512.png'
];

// Routes that should never be cached (authentication pages)
const NO_CACHE_ROUTES = ['/login', '/admin', '/admin/recordings'];

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

    // API calls - network first, cache fallback (but don't cache auth-related APIs)
    if (url.pathname.startsWith('/api/')) {
        event.respondWith(
            fetch(request)
                .then((response) => {
                    // Don't cache auth responses
                    if (url.pathname.includes('/login') || url.pathname.includes('/logout')) {
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

    // Static assets - cache first
    if (STATIC_ASSETS.includes(url.pathname) || 
        request.destination === 'image' || 
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

    // Default - network first (for HTML pages), don't cache
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
