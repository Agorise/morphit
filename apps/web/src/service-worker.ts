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
 * ─── Update policy: auto-activate + network-first navigation ──────────────
 *
 * **SECURITY CHANGE (was: pin-on-install, opt-in upgrade).** The previous
 * model snapshotted the build into a versioned cache and served the app
 * CACHE-ONLY, refusing to upgrade until the user consented — the goal was
 * that a compromised origin could not silently replace the installed
 * bundle. In practice that model black-paged real users: on mobile, Cache
 * Storage gets partially evicted under storage pressure, so after a deploy
 * the surviving cached shell referenced hashed chunks the origin had
 * already rotated away. The cache-only chunk then 404'd on the network
 * fallback, the dynamic import threw, nothing hydrated — and because the
 * app never booted, the in-app "update available" / "reload" banners could
 * not render to rescue the user. (Reproduces as: blank page in a normal
 * tab, fine in a private window which has no service worker.)
 *
 * The model here — consent-gated AND eviction-safe, so no trade-off is needed:
 *   • install precaches best-effort but does NOT skipWaiting(): while a
 *     controller already exists, a freshly installed worker SITS IN "waiting"
 *     so the in-app UpdateBanner can offer "Load it now / Later" and the user
 *     upgrades on their own schedule — never mid-form, never mid-read.
 *     skipWaiting() fires only from the APPLY_UPDATE message (user consent).
 *   • navigations are network-first (fresh shell ⇒ its chunk names always
 *     exist on the origin), cached shell only as the OFFLINE fallback — THIS
 *     is the stuck-tab rescue: a full load always boots from a fresh shell,
 *     so a waiting (un-consented) worker can never strand anyone.
 *   • hashed/immutable assets stay cache-first and self-heal on eviction.
 *   • activate purges old caches and claims clients (after a consented
 *     skipWaiting, or on first install where there is no prior worker).
 *
 * No consent is given up: the origin cannot silently swap a user's running
 * bundle — an upgrade waits for the "Load it now" click (or a cold start, once
 * every tab on the old worker is closed). The backstop against a hostile
 * operator remains the chain-signed release manifest + the running-bundle
 * SHA-256 check (TamperAlertBanner / $stores/release) — defence-in-depth
 * inside the app, not a hard guarantee against a malicious bundle.
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
import { sanitizeClickPath } from '$lib/notifications/sanitizeClickPath';
import { isDynamicDataPath } from '$lib/net/dynamicPaths';

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
	// Dynamic same-origin data (indexer/relay API, feeds, verify.json,
	// canary) must NEVER be cache-first — a hit would pin stale bytes
	// (e.g. an operator's updated /v1/instance branding) until a hard
	// reload. These fall through to the network, where each caller's
	// own `cache:` directive governs freshness. See $lib/net/dynamicPaths.
	if (isDynamicDataPath(url.pathname)) return false;
	return true;
}

self.addEventListener('install', (event: ExtendableEvent) => {
	event.waitUntil(
		(async () => {
			const cache = await caches.open(CACHE);
			// Best-effort precache: cache assets INDIVIDUALLY and tolerate
			// per-asset failures. `cache.addAll()` is atomic — a single 404
			// (e.g. a manifest entry that didn't deploy) rejects the whole
			// batch, the install fails, and users stay pinned to an older
			// worker. allSettled lets the rest of the bundle precache.
			await Promise.allSettled(PRECACHE_ASSETS.map((a) => cache.add(a)));
			// DO NOT skipWaiting() here. While a controller already exists, a
			// freshly installed worker must SIT IN "waiting" so the in-app
			// UpdateBanner can surface "Load it now / Later" and the user
			// upgrades on THEIR schedule — never auto-reloading them mid-form
			// or mid-read. skipWaiting() runs only from the APPLY_UPDATE message
			// handler below, i.e. after the user clicks "Load it now".
			//
			// This does NOT reintroduce the stale-shell black page that a
			// previous build added skipWaiting() to dodge — that rescue comes
			// from NETWORK-FIRST navigation (see the fetch handler), which
			// always refetches the shell from the origin on a full load, so its
			// hashed chunks can never point at rotated-away files. A waiting
			// worker also activates on its own once every tab on the old worker
			// is closed, so choosing "Later" still lands the update on the next
			// cold start.
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

/**
 * A top-level navigation request has redirect mode "manual" — the
 * browser, not the SW, is meant to follow any redirect. Returning a
 * *followed* redirect response (`redirected === true`) for such a
 * request is a hard network error ("a redirected response was used for
 * a request whose redirect mode is not 'follow'") and the page fails
 * with ERR_FAILED. That can happen when a prerendered route got cached
 * during a deploy window in which the server briefly 301'd it (e.g. a
 * trailing-slash redirect). Rebuild any redirected response as a plain,
 * non-redirected one so the navigation still resolves. `opaqueredirect`
 * responses have `redirected === false`, so they pass through untouched
 * and the browser follows them normally.
 */
function cleanRedirect(res: Response): Response {
	if (!res.redirected) return res;
	return new Response(res.body, {
		status: res.status,
		statusText: res.statusText,
		headers: res.headers
	});
}

self.addEventListener('fetch', (event: FetchEvent) => {
	const req = event.request;

	// Pass through non-GET, cross-origin, and opt-outs.
	if (!isCacheable(req)) return;

	const url = new URL(req.url);

	event.respondWith(
		(async () => {
			const cache = await caches.open(CACHE);

			// ── Navigations (the HTML document) → NETWORK-FIRST ──────────
			// Always try the server first so the shell matches the deployed
			// version; its hashed chunks then resolve from cache (below) or
			// from the network on a miss. This is what prevents the
			// stale-shell / dead-chunk black page: after a deploy, a cached
			// old shell would reference chunk hashes the server has rotated
			// away — fetching the shell fresh guarantees the chunk names it
			// asks for actually exist on the origin. Offline (network throws):
			// fall back to the cached shell — exact route HTML first, then the
			// root — so the user still sees the app, never a browser error.
			if (req.mode === 'navigate') {
				try {
					// cache:'reload' forces the shell to come from the ORIGIN,
					// bypassing the browser HTTP cache, on every full navigation.
					// Network-first alone wasn't enough: a reload right after a
					// deploy could be answered from a stale HTTP-cached index.html,
					// which both reports the OLD version AND references chunk hashes
					// the origin has rotated away — so the update UI re-detected the
					// mismatch and re-offered ("Load it now twice" on mobile). This
					// is catch-protected: if the forced fetch throws (offline), we
					// still fall back to the cached shell below, never a browser
					// error. Hashed chunks stay cache-first (immutable).
					return cleanRedirect(await fetch(req, { cache: 'reload' }));
				} catch {
					const cached =
						(await cache.match(req, { ignoreSearch: true })) ??
						(await cache.match(url.pathname)) ??
						(await cache.match('/'));
					if (cached) return cleanRedirect(cached);
					return new Response('Offline — no cached copy of this page.', {
						status: 503,
						headers: { 'Content-Type': 'text/plain; charset=utf-8' }
					});
				}
			}

			// ── Everything else (hashed JS/CSS, /static/*) → CACHE-FIRST ──
			// These are content-addressed / immutable, so a cache hit is
			// always correct and fast. On a miss (first sight, or the entry
			// was evicted under storage pressure) fetch from the network and
			// repopulate the cache, so the precache SELF-HEALS after eviction
			// instead of leaving a hole that 404s.
			const hit = await cache.match(req, { ignoreSearch: true });
			if (hit) return hit;
			try {
				const fresh = await fetch(req);
				if (fresh.ok && fresh.status === 200) {
					event.waitUntil(cache.put(req, fresh.clone()).catch(() => {}));
				}
				return fresh;
			} catch {
				return new Response('Offline — resource unavailable.', {
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

// ─── Web Push (Part 122 cp13) ───────────────────────────────────
//
// `push` fires when the operator's relay delivers an encrypted
// payload via the browser's push service.  The web-push library
// on the relay side encrypts payloads per RFC 8291; the browser
// decrypts before raising this event, so we receive plaintext
// `event.data`.
//
// Payload shape (relay's PushSender):
//   {
//     title:      string,
//     body:       string,
//     category:   'order' | 'chat' | 'feedback',
//     clickPath:  string | null,   // path within instance origin
//     eventId:    string,           // queue-row id, dedup key
//     eventAt:    string            // ISO timestamp
//   }
//
// We never log payload content (privacy-preserving) and we never
// raise a notification for malformed payloads — silently dropping
// is safer than guessing wrong.
/** v1.5.0 — true when a tab's URL is the SAME chat thread a chat push
 *  targets: same locale-prefixed /chat/[peer] path AND same ?order. Used
 *  to suppress a redundant OS notification while the user is actively
 *  viewing that exact conversation (focused tab). */
function chatTargetMatches(clientUrl: string, clickPath: string): boolean {
	try {
		const client = new URL(clientUrl);
		const target = new URL(clickPath, client.origin);
		return (
			client.pathname === target.pathname &&
			(client.searchParams.get('order') ?? '') === (target.searchParams.get('order') ?? '')
		);
	} catch {
		return false;
	}
}

/** v1.5.0 — extract the (peer, order) a chat push targets from its
 *  clickPath (/[lang]/chat/[peer]?order=[permlink]), so the badge-poke can
 *  tell tabs WHICH archived thread just woke and un-archive it immediately —
 *  without waiting ~irreversibility for the durable indexer to surface the
 *  message. Stays on-device (postMessage to same-origin tabs only). */
function chatThreadFromClickPath(clickPath: string): { peer: string; order: string } | null {
	try {
		const u = new URL(clickPath, self.location.origin);
		const parts = u.pathname.split('/').filter(Boolean);
		const chatIdx = parts.indexOf('chat');
		const peer = chatIdx >= 0 ? parts[chatIdx + 1] : undefined;
		if (!peer) return null;
		return { peer, order: u.searchParams.get('order') ?? '' };
	} catch {
		return null;
	}
}

self.addEventListener('push', (event: PushEvent) => {
	let payload: {
		title?: unknown;
		body?: unknown;
		category?: unknown;
		clickPath?: unknown;
		eventId?: unknown;
	};
	try {
		const text = event.data?.text();
		if (!text) return;
		payload = JSON.parse(text);
	} catch {
		// Malformed payload — drop silently.  Never log content.
		return;
	}

	const title = typeof payload.title === 'string' ? payload.title : 'Morphit';
	const body = typeof payload.body === 'string' ? payload.body : '';
	const category =
		payload.category === 'order' ||
		payload.category === 'chat' ||
		payload.category === 'feedback'
			? payload.category
			: 'order';
	const clickPath =
		typeof payload.clickPath === 'string' ? payload.clickPath : '/';
	const tag =
		typeof payload.eventId === 'string'
			? `morphit-${category}-${payload.eventId}`
			: `morphit-${category}`;

	event.waitUntil(
		(async () => {
			// v1.5.0 — suppress a redundant OS notification when a FOCUSED tab is
			// already on this exact chat thread (same /chat/peer?order). Order and
			// feedback categories always notify. The fastchat badge poke below is
			// unchanged, so in-page badges still update — no regression.
			let activelyViewing = false;
			if (category === 'chat') {
				try {
					const focusedTabs = await self.clients.matchAll({
						type: 'window',
						includeUncontrolled: true
					});
					activelyViewing = focusedTabs.some(
						(c) => c.focused && chatTargetMatches(c.url, clickPath)
					);
				} catch {
					// matchAll unavailable — default to showing the notification.
				}
			}
			if (!activelyViewing) {
				await self.registration.showNotification(title, {
					body,
					tag, // dedup key — same eventId across devices doesn't double-notify
					data: { clickPath, category },
					// `requireInteraction: false` so notifications auto-dismiss
					// after the OS-default window; "loud about orders, silent
					// about chat noise" is governed at the relay side by the
					// per-category enqueue, not by SW config.
					requireInteraction: false
				});
			}

			// cp471 — fast badge. The SW is NOT throttled, so on every push we
			// poke every open Morphit tab to repaint its in-page unread badges
			// (favicon + avatar dots) immediately, even a backgrounded tab whose
			// own EventSource/poll the browser has throttled. This is the
			// Element-style "badge an inactive tab" behaviour. Metadata only
			// (the category), never the notification content.
			try {
				const tabs = await self.clients.matchAll({
					type: 'window',
					includeUncontrolled: true
				});
				// v1.7.5 — parse for BOTH chat-ish categories, not just 'chat'.
				//
				// This was the other half of Ken's ~1-minute dark badge, and the two
				// halves were a perfect inversion: the server sets category='order'
				// for an order-scoped message — and THAT is the clickPath that
				// carries the peer — while category='chat' went with `/en/chat`,
				// which carried none. So the branch that had the peer was never
				// parsed, and the branch that was parsed had no peer. Every chat push
				// therefore reached the page with no thread, the page's
				// `if (data.peer)` guard dropped it, and the whole v1.5.5/cp474 fast
				// badge + archived-resurrect path was dead code in production.
				//
				// Both categories name a chat thread; only the ?order scope differs.
				const chatThread =
					category === 'chat' || category === 'order'
						? chatThreadFromClickPath(clickPath)
						: null;
				for (const client of tabs) {
					client.postMessage({
						type: 'CHAT_PUSH',
						category,
						...(chatThread ? { peer: chatThread.peer, order: chatThread.order } : {})
					});
				}
			} catch {
				// Best-effort; the notification already showed.
			}

			// cp471 — OS app-badge for an installed PWA (dock / taskbar / home
			// screen). A focused page sets the precise count itself; setting a
			// generic badge here keeps it prompt while backgrounded. Guarded —
			// the Badging API is not in every browser's service worker scope.
			try {
				const nav = self.navigator as unknown as {
					setAppBadge?: () => Promise<void>;
				};
				if (typeof nav.setAppBadge === 'function') {
					await nav.setAppBadge();
				}
			} catch {
				// Badging unsupported — ignore.
			}
		})()
	);
});

// Open or focus a Morphit tab at the notification's clickPath.
self.addEventListener('notificationclick', (event: NotificationEvent) => {
	event.notification.close();

	const data = event.notification.data as
		| { clickPath?: unknown }
		| undefined;

	// SECURITY (cp81-D22b): clickPath comes from the push payload,
	// which the operator's relay generates.  A malicious or
	// compromised operator could craft `clickPath: '//evil.com/'`
	// (protocol-relative URL) — `new URL(path, origin)` would then
	// resolve to a cross-origin URL, and `clients.openWindow()`
	// would open the user's browser at the attacker URL.
	// Same risk with `javascript:` schemes, `data:` URLs, etc.
	//
	// The sanitizer below resolves the input and rejects anything
	// not resolving to our own http(s) origin, falling back to '/'.
	// `WindowClient.navigate()` already enforces same-origin per
	// spec, but `clients.openWindow()` does not uniformly across
	// browsers — Chrome will open cross-origin tabs.  This defense
	// closes the operator-phishing primitive.
	//
	// Sanitizer is extracted to $lib/notifications/sanitizeClickPath
	// so the validation logic can be unit-tested.
	const safePath = sanitizeClickPath(data?.clickPath, self.location.origin);
	const targetUrl = new URL(safePath, self.location.origin).toString();

	event.waitUntil(
		(async () => {
			const clientList = await self.clients.matchAll({
				type: 'window',
				includeUncontrolled: true
			});
			// Prefer an already-open Morphit tab.  Focus it and
			// navigate it to the target URL.
			for (const client of clientList) {
				const url = new URL(client.url);
				if (url.origin === self.location.origin) {
					await (client as WindowClient).focus();
					await (client as WindowClient).navigate(targetUrl);
					return;
				}
			}
			// No open tab — open a new one.
			await self.clients.openWindow(targetUrl);
		})()
	);
});

export {};
