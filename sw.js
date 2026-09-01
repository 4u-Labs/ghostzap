// ============================================================
// sw.js — GhostZap Service Worker v4
// Estratégia: Network First para APIs e PHP, Cache First para assets
// ============================================================

const CACHE_NAME  = 'ghostzap-v11';
const STATIC_URLS = [
    './css/style.css',
    './js/crypto.js',
    './js/storage.js',
    './js/media.js',
    './js/i18n.js',
    './js/chat.js',
    './js/applock.js',
    './lang/pt.json',
    './lang/en.json',
    './lang/es.json',
    './lang/zh.json',
];

// Instalar e cachear assets estáticos
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_URLS))
    );
    self.skipWaiting();
});

// Ativar e limpar caches antigos
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        )
    );
    self.clients.claim();
});

// Estratégia de fetch
self.addEventListener('fetch', (event) => {
    // Ignorar requisições não-GET (POST, PUT, DELETE)
    if (event.request.method !== 'GET') {
        return;
    }

    const url = new URL(event.request.url);
    const path = url.pathname;

    // NUNCA cachear: APIs, PHP, diretórios, Service Worker e chrome-extension
    if (
        path.includes('/api/')       ||
        path.endsWith('.php')        ||
        path.endsWith('sw.js')       ||
        path.endsWith('/')           ||
        !path.includes('.')          || // URLs de rotas/diretórios sem extensão
        url.protocol === 'chrome-extension:'
    ) {
        return; // Deixa o navegador fazer a requisição de rede normal nativamente
    }

    // Assets estáticos (JS, CSS, imagens) — Cache First + atualização em background
    event.respondWith(
        caches.match(event.request).then(cached => {
            const networkFetch = fetch(event.request).then(response => {
                // Cacheia apenas respostas básicas válidas (não CORS, não opacas)
                if (response && response.status === 200 && response.type === 'basic') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                }
                return response;
            }).catch(() => cached); // Offline: usa o cache

            return cached || networkFetch;
        })
    );
});
