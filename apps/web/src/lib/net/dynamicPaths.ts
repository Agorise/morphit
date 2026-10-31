import { withHiddenFloor } from './transportBudget';

/**
 * Morphit — dynamic same-origin endpoint classifier.
 *
 * The service worker serves same-origin GETs CACHE-FIRST so the app
 * runs fully offline (Priority #2 — unstoppability). That is correct
 * for content-addressed, immutable assets (hashed JS/CSS chunks,
 * /static/* icons + fonts) whose bytes never change for a given URL.
 *
 * It is WRONG for the handful of same-origin paths that serve DYNAMIC
 * data — data that changes independently of the build hash. A
 * cache-first hit on those pins the first response forever, so the
 * change is invisible until a hard reload (ctrl+shift+r) bypasses the
 * SW entirely. The classic symptom: an operator edits their instance
 * branding ("morphit.io" → "Morphit NL"), `/v1/instance` returns the
 * new name, but the footer keeps showing the old one because the SW
 * answered from its cache and never hit the network. (The instances
 * page escaped this only because its card rides the `/v1/instances`
 * SSE stream, which is never a cacheable GET.)
 *
 * The dynamic same-origin paths, in the colocated single-host topology
 * where one reverse proxy serves the SPA and proxies the rest to the
 * loopback-bound indexer/relay (docs/RUN-A-MORPHIT-NODE.md §5):
 *
 *   • /v1/*        indexer read API — instance branding, accounts,
 *                  balances, profiles, chain-fee, and the SSE streams.
 *   • /relay/*     relay API — account creation + health. (Writes are
 *                  POST and already excluded as non-GET; health and any
 *                  future GET must still never be cached.)
 *   • /rss/*       per-account + sitewide feeds, served by the indexer.
 *   • /verify.json deployed-version poll AND release-tamper probe.
 *                  Doubly important here: the SW matches with
 *                  `ignoreSearch: true`, which would ALSO defeat the
 *                  poll's `?cb=` cache-buster — so only excluding it
 *                  outright keeps version-update + tamper detection
 *                  honest.
 *   • /canary.txt  warrant canary — a stale copy is a silent security
 *                  signal failure.
 *   • /version.json the deployed build's version alone (v1.21.18) — the
 *                  update check's half-minute poll; cached, it would never
 *                  see a new build.
 *
 * Excluded paths fall through to the network, where each caller's own
 * `cache:` directive (`no-cache` on getInstance, the verify.json
 * cache-buster, `no-store` on balance/history) governs freshness.
 *
 * Pure and dependency-free (no `self`, no `URL` construction) so it
 * unit-tests without a service-worker global and is reused identically
 * by `isCacheable` in src/service-worker.ts.
 *
 * @param pathname  A URL pathname with no query or hash, e.g.
 *                  `/v1/instance` or `/_app/immutable/chunks/x.js`.
 * @returns `true` when the path serves dynamic data that must NEVER be
 *          served from the SW cache; `false` for cacheable assets.
 */
export function isDynamicDataPath(pathname: string): boolean {
	// Indexer / relay / feed namespaces — match the bare form too so a
	// path like `/v1` (no trailing slash) is never mistaken for an asset.
	if (pathname === '/v1' || pathname.startsWith('/v1/')) return true;
	if (pathname === '/relay' || pathname.startsWith('/relay/')) return true;
	if (pathname === '/rss' || pathname.startsWith('/rss/')) return true;
	// Deploy-generated, runtime-fetched single files (not precached).
	if (pathname === '/verify.json') return true;
	// v1.21.18: the build's version alone, read by the update check.
	if (pathname === '/version.json') return true;
	if (pathname === '/canary.txt') return true;
	return false;
}

/**
 * Per-instance branding (docs/BRANDING.md): the served files an operator's
 * `morphit-ops branding apply` may REPLACE in place — same URL, new bytes.
 *
 * They are static assets (precached, offline-capable), so they are NOT dynamic
 * data; but cache-first would pin a visitor to the logo/brand their service
 * worker first saw until the next Morphit release rotates the cache. The
 * service worker therefore serves exactly these paths NETWORK-FIRST
 * ({@link serveBrandFile}): the server's copy whenever it answers, the stored
 * one only offline. (v1.21.8: they were stale-while-revalidate, which showed a
 * visitor who had seen the site before it was branded — or before a re-brand —
 * the old look for a whole page load: vigilante.trading, 2026-10-13.)
 *
 * Keep in sync with the overlay targets in apps/ops-cli/src/lib/branding.ts
 * (a branding-overridable-paths smoke asserts the two lists match).
 */
export const BRAND_OVERRIDABLE_PATHS: readonly string[] = [
	'/brand/brand.json',
	'/brand/theme.css',
	'/brand/site-logo.svg',
	'/brand/site-logo-footer.svg',
	'/favicon.svg',
	'/app-icon.svg',
	'/app-icon-maskable.svg',
	'/app-icon-192.png',
	'/app-icon-512.png',
	'/app-icon-maskable-512.png',
	'/apple-touch-icon.png',
	'/manifest.webmanifest'
];

/** Query parameter asking the service worker for the NETWORK's copy of a
 *  brand file. On a read by the app itself (a fetch() — the Blurt post,
 *  lib/syndication/publish.ts) it means "never the stored copy, even
 *  offline". The pages' own logo URLs carry it too (lib/brand/brandAssets.ts):
 *  for an <img> this worker still falls back to the stored copy offline, but
 *  v1.21.7's worker — still running in a visitor's browser on the first page
 *  after an upgrade — fetched only `?fresh=1` reads from the network, so the
 *  parameter is what keeps that page from showing a logo stored before the
 *  site was branded. */
export const BRAND_FRESH_PARAM = 'fresh';

/**
 * Which response the service worker gives for a brand file (PURE).
 * `fresh` is the network's answer (null when it failed or timed out), `cached`
 * the stored copy.
 *  - The server's good answer, always.
 *  - The server answered with an error (404, 429, 503…, or the worker's own
 *    504 when it gave up waiting): its error — a stored copy may be from
 *    before the site was branded, and a missing logo is better than
 *    Morphit's — except where `keepStoredOnError` (the theme stylesheet:
 *    without it the page shows the default look, so a stored copy can only
 *    do better).
 *  - No answer at all (offline, or the connection dropped): the stored copy.
 * A `?fresh=1` read by the app (the Blurt post deciding which picture to use)
 * NEVER gets the stored copy: it gets the network's answer, or 'offline' (a
 * 503).
 */
export function chooseBrandResponse<R extends { ok: boolean }>(
	fresh: R | null,
	cached: R | undefined,
	wantsFresh: boolean,
	keepStoredOnError = false
): R | 'offline' {
	if (fresh && fresh.ok) return fresh;
	if (fresh && !(keepStoredOnError && cached && !wantsFresh)) return fresh;
	if (cached && !wantsFresh) return cached;
	return 'offline';
}

/**
 * @param pathname  A URL pathname with no query or hash.
 * @returns `true` for a brand asset the operator may replace in place
 *          (including the iOS launch images under /splash/).
 */
export function isBrandOverridablePath(pathname: string): boolean {
	return BRAND_OVERRIDABLE_PATHS.includes(pathname) || pathname.startsWith('/splash/');
}

/**
 * The service worker's answer for a brand file (see BRAND_OVERRIDABLE_PATHS):
 * NETWORK-FIRST. Asks the network and reads the stored copy together; stores a
 * good network answer for offline use and returns it; the stored copy only
 * when the network failed (`network` resolves null on an error or its own
 * timeout), and never for a `?fresh=1` read (chooseBrandResponse). Never
 * throws; 'offline' when there is nothing to answer with.
 *
 * Deliberately no "serve the stored copy if the network is slow" deadline:
 * the stored copy may be from before the site was branded, and a slow answer
 * (Tor, a weak mobile link) is far more common than a server that sends the
 * page but stalls on one small file. With a deadline, a returning visitor on a
 * slow link saw Morphit's logo for a whole page after a re-brand (measured in
 * Chromium with the brand files 3 s late) — exactly what this must never do.
 */
export async function serveBrandFile<R extends { ok: boolean; status: number; clone(): R }>(
	deps: {
		readonly match: () => Promise<R | undefined>;
		readonly network: () => Promise<R | null>;
		readonly store: (fresh: R) => Promise<void>;
	},
	wantsFresh: boolean,
	keepStoredOnError = false
): Promise<R | 'offline'> {
	const [cached, fresh] = await Promise.all([
		deps.match().catch(() => undefined),
		deps.network().catch(() => null)
	]);
	if (fresh !== null && fresh.ok && fresh.status === 200)
		await deps.store(fresh.clone()).catch(() => undefined);
	return chooseBrandResponse(fresh, cached, wantsFresh, keepStoredOnError);
}

/** Brand files whose stored copy beats a server error (see chooseBrandResponse).
 *  Not brand.json: a copy stored before a re-brand carries the old colours. */
function keepsStoredOnError(pathname: string): boolean {
	return pathname === '/brand/theme.css';
}

/**
 * The service worker's whole answer to a request for a brand file
 * (isBrandOverridablePath): network-first through serveBrandFile, stored
 * under the bare path, the fetch bounded by `timeoutMs` (armed until the
 * body is stored, not just the headers); a server that has not answered by
 * then counts as one that answered with an error (a 504), not as one that
 * cannot be reached — the stored copy is for offline. A `?fresh=1` read counts as the
 * app's strict read only when the app made it (fetch(): destination ''); an
 * <img>/<link> carrying it (the pages' logo URLs, see BRAND_FRESH_PARAM) is
 * served like any other brand file. Never throws; a 503 when there is
 * nothing to answer with.
 */
export async function answerBrandRequest(
	req: Request,
	deps: {
		readonly cache: {
			match(r: Request, o?: CacheQueryOptions): Promise<Response | undefined>;
			put(r: Request, res: Response): Promise<void>;
		};
		readonly fetch: (r: Request, init: RequestInit) => Promise<Response>;
		readonly timeoutMs: number;
	}
): Promise<Response> {
	const url = new URL(req.url);
	const wantsFresh = url.searchParams.has(BRAND_FRESH_PARAM) && req.destination === '';
	const key = new Request(url.origin + url.pathname);
	const ac = new AbortController();
	// Raised to the hidden-transport floor on a .onion/.i2p/.loki origin.
	const timer = setTimeout(() => ac.abort(), withHiddenFloor(deps.timeoutMs, url.origin));
	let pick: Response | 'offline';
	try {
		pick = await serveBrandFile<Response>(
			{
				match: () => deps.cache.match(req, { ignoreSearch: true }),
				network: () =>
					deps.fetch(req, { cache: 'no-cache', signal: ac.signal }).catch((err: unknown) => {
						if (!ac.signal.aborted) throw err;
						return new Response('The server did not answer in time.', {
							status: 504,
							headers: { 'Content-Type': 'text/plain; charset=utf-8' }
						});
					}),
				store: (fresh) => deps.cache.put(key, fresh)
			},
			wantsFresh,
			keepsStoredOnError(url.pathname)
		);
	} finally {
		clearTimeout(timer);
	}
	if (pick !== 'offline') return pick;
	return new Response('Offline — resource unavailable.', {
		status: 503,
		headers: { 'Content-Type': 'text/plain; charset=utf-8' }
	});
}

/**
 * A request that asks for the server's current copy: a fetch() made with
 * `cache: 'no-cache'`, `'reload'` or `'no-store'`. The service worker then
 * answers it from the network, never from its own stored copy, so the
 * caller's `cache:` directive means what it says on a cached path too.
 *
 * The build-integrity check asks this way for the files it hashes whose name
 * does not change with their bytes (index.html, the service worker): a copy a
 * worker stored earlier can belong to another release, and showed visitors the
 * red "Build integrity check failed" on a site that served the signed release
 * exactly (vigilante.trading, 2026-10-30).
 */
export function wantsServerCopy(req: { readonly cache: RequestCache }): boolean {
	return req.cache === 'no-cache' || req.cache === 'reload' || req.cache === 'no-store';
}

/**
 * The service worker's answer to a {@link wantsServerCopy} request: the
 * server's copy (stored for offline, unless the caller said no-store); the
 * stored copy only when the server cannot be reached. Never throws; a 503
 * when there is nothing to answer with.
 */
export async function answerServerCopyRequest(
	req: Request,
	deps: {
		readonly cache: {
			match(r: Request, o?: CacheQueryOptions): Promise<Response | undefined>;
			put(r: Request, res: Response): Promise<void>;
		};
		readonly fetch: (r: Request) => Promise<Response>;
	}
): Promise<Response> {
	try {
		const fresh = await deps.fetch(req);
		if (fresh.ok && fresh.status === 200 && req.cache !== 'no-store') {
			await deps.cache.put(req, fresh.clone()).catch(() => {});
		}
		return fresh;
	} catch {
		const stored = await deps.cache.match(req, { ignoreSearch: true }).catch(() => undefined);
		return (
			stored ??
			new Response('Offline — resource unavailable.', {
				status: 503,
				headers: { 'Content-Type': 'text/plain; charset=utf-8' }
			})
		);
	}
}
