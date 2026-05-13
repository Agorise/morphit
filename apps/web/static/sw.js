/**
 * Morphit service worker.
 *
 * Design: SERVICE-WORKER-CACHING-DESIGN.md (hybrid, approved Q4=b).
 *
 * Strategy:
 *   - cache-first for static assets (fonts, icons, brand)
 *   - bypass SW entirely for API routes and RSS (must stay fresh)
 *   - network-first for everything else (HTML navigations etc.)
 *
 * This file is hand-rolled (~100 lines) rather than using Workbox.
 * Reasons, from the design doc: Workbox adds 50KB gzipped for
 * functionality we don't need, and caching policy this simple doesn't
 * warrant a framework.
 *
 * Cache version is bumped on each release via the CACHE_VERSION
 * constant below. Future enhancement: read from /verify.json at
 * install time and derive the version from the aggregate hash. For
 * now, manual bump on each release is simpler and audit-friendly.
 *
 * Tor Browser at high security level disables service workers — this
 * file just won't be registered. Everything still works, just without
 * the cache benefit.
 */

// Bump this on each release. The activate handler reaps old caches.
const CACHE_VERSION = 'morphit-static-v1';

/**
 * Assets to precache at install time. Hardcoded rather than read from
 * verify.json for v1 — verify.json doesn't exist yet in this repo.
 * When it lands, swap this for a fetch('/verify.json') + filter.
 *
 * We deliberately don't precache HTML pages — the SPA shell is
 * re-fetched via network-first so users always see the latest build.
 */
const PRECACHE = [
	// Brand identity — shown on every page via header
	'/brand/morphit-mark.svg',
	'/brand/morphit-wordmark.svg',

	// Alt-network icons referenced by AltNetworkIcon.svelte via SW
	// fetch (inline SVGs in the component handle the render-path;
	// these cached copies serve the manifest.webmanifest-referenced
	// paths and any direct URL references)
	'/icons/icon-tor.svg',
	'/icons/icon-lokinet.svg',
	'/icons/icon-i2p.svg',
	'/icons/icon-nostr.svg',
	'/icons/icon-blurt.svg',
	'/icons/icon-btc.svg',
	'/icons/icon-xmr.svg',

	// Fonts — runtime-loaded via @font-face in app.css. Precaching
	// these is the biggest single caching win (~100KB+ per font).
	// If the file doesn't exist on the server the install just logs
	// and moves on; no crash.
	'/fonts/nunito-latin-400.woff2',
	'/fonts/nunito-latin-600.woff2',
	'/fonts/nunito-latin-700.woff2',

	// OpenGraph image — used by share previews
	'/og-image.svg'
];

/**
 * Path prefixes the SW should NOT intercept. API and RSS must always
 * be fresh; runtime data in cache would be actively misleading.
 */
const BYPASS_PREFIXES = ['/v1/', '/rss/'];

/**
 * Path prefixes served cache-first. A fetch hits cache first; on
 * miss, we fall through to network and populate the cache.
 */
const CACHE_FIRST_PREFIXES = ['/fonts/', '/icons/', '/brand/'];

// ────────────────────────────────────────────────────────────────
// Install: populate the cache with the precache list. Use
// cache.add() one-by-one (rather than addAll) so a single missing
// asset doesn't fail the entire install — we log and continue.
// ────────────────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE_VERSION);
			// Settle-all pattern: don't let one 404 abort the whole
			// install.
			const results = await Promise.allSettled(PRECACHE.map((url) => cache.add(url)));
			// Silently skip failures — the SW design explicitly
			// tolerates missing assets (e.g. fonts not yet uploaded
			// to a dev deploy).
			for (let i = 0; i < results.length; i++) {
				if (results[i].status === 'rejected') {
					// No console.error — SW console noise spooks
					// users watching DevTools. The fall-through
					// behavior for cache-miss handles it anyway.
				}
			}
			// Deliberately do NOT call skipWaiting() here. The new
			// SW waits until the user clicks "Update now" in the
			// UpdateBanner — that sends us an APPLY_UPDATE message
			// (see the 'message' handler below), which THEN calls
			// skipWaiting() and reloads. This respects the user
			// being in the middle of something.
		})()
	);
});

// ────────────────────────────────────────────────────────────────
// Message: UpdateBanner.svelte sends { type: 'APPLY_UPDATE' } when
// the user clicks "Update now." Skip waiting → browser activates
// this SW → controllerchange fires in UpdateBanner → page reloads.
// ────────────────────────────────────────────────────────────────
self.addEventListener('message', (event) => {
	if (event.data && event.data.type === 'APPLY_UPDATE') {
		self.skipWaiting();
	}
});

// ────────────────────────────────────────────────────────────────
// Activate: reap stale caches from previous versions. Any cache
// whose key doesn't match the current CACHE_VERSION gets deleted,
// freeing storage.
// ────────────────────────────────────────────────────────────────
self.addEventListener('activate', (event) => {
	event.waitUntil(
		(async () => {
			const keys = await caches.keys();
			await Promise.all(
				keys
					.filter((k) => k.startsWith('morphit-static-v') && k !== CACHE_VERSION)
					.map((k) => caches.delete(k))
			);
			// Take control of all open clients so the new SW handles
			// their fetches immediately.
			await self.clients.claim();
		})()
	);
});

// ────────────────────────────────────────────────────────────────
// Fetch: route requests through the right strategy based on path.
// ────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
	const req = event.request;

	// Never intercept non-GET — SW caching of mutations is a bug.
	if (req.method !== 'GET') return;

	const url = new URL(req.url);

	// Cross-origin requests: don't intercept. Morphit is a
	// same-origin PWA; anything cross-origin is either a Blurt RPC
	// call (which needs to go direct) or a third-party resource
	// we don't want to cache.
	if (url.origin !== self.location.origin) return;

	// Bypass SW for API and RSS — always fresh.
	for (const prefix of BYPASS_PREFIXES) {
		if (url.pathname.startsWith(prefix)) return;
	}

	// Cache-first for static assets.
	for (const prefix of CACHE_FIRST_PREFIXES) {
		if (url.pathname.startsWith(prefix)) {
			event.respondWith(cacheFirst(req));
			return;
		}
	}

	// Everything else (HTML navigations, JS/CSS chunks, etc.):
	// network-first, fall back to cache for offline resilience.
	event.respondWith(networkFirst(req));
});

/**
 * Cache-first: check cache; on hit, return cached. On miss, fetch,
 * cache the response, return it. On network error with no cache, the
 * browser's own error handling takes over.
 */
async function cacheFirst(request) {
	const cache = await caches.open(CACHE_VERSION);
	const cached = await cache.match(request);
	if (cached) return cached;
	try {
		const fresh = await fetch(request);
		// Only cache successful responses; don't pollute with 404s.
		if (fresh.ok) {
			// Clone because responses are one-shot streams.
			cache.put(request, fresh.clone());
		}
		return fresh;
	} catch (err) {
		// Offline and no cache entry — re-throw so the browser
		// shows its own offline UX.
		throw err;
	}
}

/**
 * Network-first: try fresh. On success, update cache opportunistically
 * and return. On failure, fall back to cache. If neither works,
 * re-throw.
 */
async function networkFirst(request) {
	const cache = await caches.open(CACHE_VERSION);
	try {
		const fresh = await fetch(request);
		if (fresh.ok) {
			cache.put(request, fresh.clone());
		}
		return fresh;
	} catch (err) {
		const cached = await cache.match(request);
		if (cached) return cached;
		throw err;
	}
}
