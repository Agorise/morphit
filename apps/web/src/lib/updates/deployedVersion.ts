/**
 * Morphit — deployed-version poll helpers.
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

/** v1.21.18 — the build's version alone (`{"morphit_version": "…"}`, a few
 *  bytes; written next to verify.json at build time). The update check asks
 *  it every half minute; verify.json stays the fallback for a server that
 *  does not serve it. */
export const VERSION_JSON_PATH = '/version.json';

/** The cache-busted version.json URL for one poll (same reason as above). */
export function versionJsonPollUrl(now: number = Date.now()): string {
	return `${VERSION_JSON_PATH}?cb=${now}`;
}

/**
 * v1.21.18 review — the update check's poll, one at a time. Over Tor a read
 * may take up to its 45 s budget (and the verify.json fallback another one),
 * longer than the half-minute between polls, and the tab coming back into view
 * or online asks too: polls piled up, each with its own download. A poll asked
 * while one is still running joins it; a new one starts only after it ends,
 * and never less than `minGapMs` after the previous one started.
 */
export function createDeployedVersionPoll(deps: {
	/** The deployed version, or null (not known this time). */
	read(): Promise<string | null>;
	/** What to do with a version read. */
	onVersion(version: string): void | Promise<void>;
	now(): number;
	minGapMs: number;
	/** True once the page is gone: nothing more is asked or reported. */
	cancelled?(): boolean;
}): () => Promise<void> {
	let inflight: Promise<void> | null = null;
	let lastStartAt = -Infinity;
	return () => {
		if (inflight !== null) return inflight;
		if (deps.cancelled?.() === true) return Promise.resolve();
		const now = deps.now();
		if (now - lastStartAt < deps.minGapMs) return Promise.resolve();
		lastStartAt = now;
		const run = (async () => {
			// Cross an await first: a reader that throws at once must not reach
			// `finally` before `inflight` is set (it would stay "running" forever).
			await Promise.resolve();
			try {
				const v = await deps.read();
				if (v === null || deps.cancelled?.() === true) return;
				await deps.onVersion(v);
			} catch {
				// Network / timeout / parse error: stay silent.
			} finally {
				inflight = null;
			}
		})();
		inflight = run;
		return run;
	};
}
