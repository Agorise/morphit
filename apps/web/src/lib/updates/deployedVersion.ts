/**
 * Morphit — deployed-version poll helpers (cp294).
 *
 * Why this exists. The "update available" snackbar (UpdateBanner.svelte)
 * is driven by the service-worker update lifecycle: the browser refetches
 * /service-worker.js, sees byte-different bytes, installs a new worker into
 * "waiting", and the banner offers "Load it now". svelte.config.js already
 * sets `updateViaCache: 'none'` so the BROWSER never serves the SW script
 * from its own HTTP cache — but that does NOT stop an upstream reverse proxy
 * (e.g. BunkerWeb) from serving /service-worker.js stale from ITS edge cache.
 * When that happens the browser receives old SW bytes, never sees a new
 * worker, and the snackbar never appears after a deploy (observed on both
 * mobile and PC). The operator-side fix is `Cache-Control: no-cache` on
 * /service-worker.js (see docs/OPERATIONS.md §"Caching the update surface").
 *
 * This module is the belt-and-suspenders that makes the snackbar appear
 * REGARDLESS of proxy caching: poll the deployed bundle's own version from
 * /verify.json (cache-busted, so a proxy can't answer from cache) and
 * compare it to the version baked into the running bundle. A mismatch means
 * a different bundle is deployed than the one running — i.e. an update is
 * available — independent of whether the SW byte-diff was detected.
 *
 * Both functions are pure so the decision logic is unit-tested without a
 * browser, a service worker, or a network (see deployedVersion.test.ts).
 */

/** verify.json query key for the cache-buster — exported so the smoke can
 *  assert the poll actually cache-busts (a non-busted URL is exactly what a
 *  caching proxy would answer stale). */
export const VERIFY_JSON_PATH = '/verify.json';

/**
 * Parse the deployed bundle version (`morphit_version`) out of a verify.json
 * body. Returns null for anything that isn't the expected shape — a missing
 * field, a non-string, an empty string, or unparseable text — so a garbled
 * or gated (e.g. an HTML 401 page) response can never be mistaken for a
 * version string.
 */
export function parseDeployedVersion(verifyJsonText: string): string | null {
	let obj: { morphit_version?: unknown };
	try {
		obj = JSON.parse(verifyJsonText) as { morphit_version?: unknown };
	} catch {
		return null;
	}
	if (typeof obj.morphit_version !== 'string') return null;
	const v = obj.morphit_version.trim();
	return v.length > 0 ? v : null;
}

/**
 * Decide whether to OFFER an update based on the deployed vs running version.
 *
 * Conservative by construction — returns true ONLY with positive evidence of
 * a genuinely different deployed bundle:
 *   - deployedVersion === null (fetch failed / gated / unparseable) → false
 *     (never nag without evidence — same philosophy as $stores/release).
 *   - runningVersion empty (the '0.0.0' sentinel when the build define is
 *     somehow absent) → false (can't trust the comparison).
 *   - equal versions → false (we're already running what's deployed).
 *   - any other difference → true.
 *
 * Note this is a plain inequality, not "strictly newer": a rollback to an
 * older build is also a deploy the user should pick up, and parsing/ordering
 * arbitrary semver-ish tags ('1.0.0-beta.22' vs '1.0.0-beta.9') is exactly
 * the kind of fragile comparison that quietly breaks — any difference means
 * the served bundle is not the running one, which is all we need to know.
 */
export function deployedVersionDiffers(
	deployedVersion: string | null,
	runningVersion: string
): boolean {
	if (deployedVersion === null) return false;
	if (runningVersion.length === 0) return false;
	return deployedVersion !== runningVersion;
}

/**
 * Build the cache-busted verify.json URL for one poll. The unique `cb`
 * query param defeats an upstream proxy's URL-keyed edge cache so each poll
 * reaches the origin and reads the truly-deployed version — the whole point
 * of the fallback. (Pair with a server-side `Cache-Control: no-cache`, but
 * the cache-buster means the poll is correct even if the operator hasn't set
 * that header yet.)
 */
export function verifyJsonPollUrl(now: number = Date.now()): string {
	return `${VERIFY_JSON_PATH}?cb=${now}`;
}
