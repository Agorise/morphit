/**
 * Morphit — dynamic same-origin endpoint classifier (cp324).
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
 * loopback-bound indexer/relay (docs/RUN-A-MORPHIT-NODE.md §8):
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
	if (pathname === '/canary.txt') return true;
	return false;
}
