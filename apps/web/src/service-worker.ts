/**
 * Morphit — service worker
 *
 * ─── Installation goal: total decoupling from the install origin ─────────
 *
 * After the PWA is installed, the running app should never need to contact
 * the origin it was installed from for rendering. Every HTML/JS/CSS/font/
 * image/icon ships in the precache. Data (indexer RPC, payment watcher)
 * goes through an in-app configurable endpoint list — not this service
 * worker. See $lib/net/endpoints (Phase 2).
 *
 * ─── Update policy: pin-on-install, opt-in upgrade ───────────────────────
 *
 * We do NOT stale-while-revalidate JS/CSS. A compromised origin serving
 * malicious scripts must not be able to replace the user's installed
 * bundle silently. Instead:
 *
 *   • On install, we snapshot the entire build manifest into a versioned
 *     cache and serve from that cache exclusively.
 *   • When a new version is detected on the server, the running page is
 *     notified. The user must explicitly accept the upgrade in Settings
 *     (or via a banner). Only then do we swap caches and reload.
 *
 * This protects users whose edge host is compromised and, more
 * prosaically, prevents partial-update breakage.
 *
 * ─── What does hit the network ───────────────────────────────────────────
 *
 *   • Data endpoints (indexer, relay) — but those requests go to origins
 *     the app config lists, not necessarily the install origin.
 *   • Navigations that land on routes prerendered into the cache are
 *     served offline-first.
 *   • Unknown same-origin requests fall through to network. If the network
 *     is unreachable, the cached shell is served for navigations.
 *
 * ─── Phase staging ────────────────────────────────────────────────────────
 *
 *   • Phase 1 (this): aggressive precache + pinned version; messaging
 *     surface (`CHECK_UPDATE`, `APPLY_UPDATE`, `RELEASE_INFO`) is wired
 *     up but there's no dedicated update UI yet.
 *   • Phase 2: endpoint-rotation client uses this SW as a passive cache.
 *   • Phase 5: background-sync for pending signed ops; IPFS fallback for
 *     static assets when origin is unreachable.
 */

/// <reference lib="webworker" />
/// <reference types="@sveltejs/kit" />

import { build, files, prerendered, version } from '$service-worker';

declare const self: ServiceWorkerGlobalScope;

/**
 * Versioned cache key. SvelteKit's `version` is a build-time hash of the
 * output; a new deploy produces a new cache and the old one is purged on
 * activation (after user consent).
 */
const CACHE = `morphit-${version}`;

/**
 * Everything SvelteKit knows about shipping to the browser:
 *
 *   build        → hashed JS/CSS chunks (the app bundle)
 *   files        → /static/* (brand SVGs, icons, fonts, manifest)
 *   prerendered  → HTML for every SSG'd route (/, /faq, /orderbook, etc.)
 *
 * Concatenating these gives us an exhaustive list of every byte the
 * client needs to run fully offline.
 */
const PRECACHE_ASSETS: readonly string[] = [...build, ...files, ...prerendered];

/** Requests we never cache — writes, dynamic data, the SW itself. */
function isCacheable(req: Request): boolean {
	if (req.method !== 'GET') return false;
	const url = new URL(req.url);
	if (url.origin !== self.location.origin) return false;
	// The service worker file itself must not be cached by the service worker.
	if (url.pathname === '/service-worker.js') return false;
	return true;
}

self.addEventListener('install', (event: ExtendableEvent) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			await cache.addAll(PRECACHE_ASSETS);
			// Do NOT skipWaiting() here — the current tab must stay on its
			// pinned version until the user consents to upgrade. The running
			// page controls the swap via the APPLY_UPDATE message below.
		})()
	);
});

self.addEventListener('activate', (event: ExtendableEvent) => {
	event.waitUntil(
		(async () => {
			// Delete every cache not for this version.
			const keys = await caches.keys();
			await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
			await self.clients.claim();
		})()
	);
});

self.addEventListener('fetch', (event: FetchEvent) => {
	const req = event.request;

	// Pass through non-GET, cross-origin, and opt-outs.
	if (!isCacheable(req)) return;

	const url = new URL(req.url);

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);

			// Precached assets (app bundle, static files, prerendered HTML)
			// are served cache-only. They shipped with this version of the
			// SW; the next build will rebuild the cache under a new key.
			// This is what gives us total origin-decoupling after install.
			const precached = await cache.match(req, { ignoreSearch: true });
			if (precached) return precached;

			// Anything else: try network, fall back to cached shell for
			// navigations so the user still sees something coherent.
			try {
				const fresh = await fetch(req);
				return fresh;
			} catch {
				if (req.mode === 'navigate') {
					// Prefer the exact route HTML if we have it; otherwise root.
					const fallback = (await cache.match(url.pathname)) ?? (await cache.match('/'));
					if (fallback) return fallback;
				}
				return new Response('Offline — no cached copy of this resource.', {
					status: 503,
					headers: { 'Content-Type': 'text/plain; charset=utf-8' }
				});
			}
		})()
	);
});

/**
 * Message protocol with the running page.
 *
 *   page → SW: `{ type: 'CHECK_UPDATE' }`
 *     SW replies with `{ type: 'RELEASE_INFO', installed: version }`.
 *   page → SW: `{ type: 'APPLY_UPDATE' }`
 *     SW calls skipWaiting() so the waiting worker (with the new cache)
 *     takes over on the next navigation / reload.
 *
 * The Phase-5 update UI will send APPLY_UPDATE only after the user has
 * clicked "Install new version" in a banner.
 */
self.addEventListener('message', (event: ExtendableMessageEvent) => {
	const data = event.data;
	if (!data || typeof data.type !== 'string') return;

	if (data.type === 'CHECK_UPDATE') {
		event.source?.postMessage({ type: 'RELEASE_INFO', installed: version });
		return;
	}
	if (data.type === 'APPLY_UPDATE') {
		self.skipWaiting();
		return;
	}
});

export {};
