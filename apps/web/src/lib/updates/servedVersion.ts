/**
 * v1.20.3 — ONE read of the served build's version (/verify.json) for both of
 * its readers on page load:
 *
 *   - the release check ($stores/release): is the operator serving the
 *     announced build? (gates the byte-for-byte integrity check);
 *   - the update check (UpdateBanner): is a newer build deployed than the one
 *     this tab runs?
 *
 * verify.json carries the whole file-hash manifest (~80 KB on the wire), and
 * each reader used to download it separately within seconds of each other.
 * Concurrent reads now share one download, and a read within `maxAgeMs` of the
 * last successful one reuses its answer. The periodic update poll passes 0 and
 * always asks afresh. The URL is cache-busted and fetched with no-store, so no
 * proxy or browser cache can answer it stale (see ./deployedVersion.ts).
 * Same-origin: the operator already serves the page.
 */
import { fetchWithTimeout } from '$net/fetchWithTimeout';
import { withHiddenFloor } from '$net/transportBudget';
import { parseDeployedVersion, verifyJsonPollUrl } from './deployedVersion';

export interface ServedVersionDeps {
	fetchVerifyJson(): Promise<Response>;
	now(): number;
}

/** Default reuse window for reads on page load. */
export const SERVED_VERSION_REUSE_MS = 60_000;

export function createServedVersionReader(
	deps: ServedVersionDeps
): (opts?: { maxAgeMs?: number }) => Promise<string | null> {
	let inflight: Promise<string | null> | null = null;
	let last: { at: number; version: string } | null = null;
	return (opts = {}) => {
		const maxAge = opts.maxAgeMs ?? SERVED_VERSION_REUSE_MS;
		if (inflight !== null) return inflight;
		if (last !== null && maxAge > 0 && deps.now() - last.at < maxAge) {
			return Promise.resolve(last.version);
		}
		inflight = (async () => {
			// Always cross an await before the body runs: a fetcher that throws
			// synchronously would otherwise reach `finally` before `inflight` is
			// assigned, leaving a settled promise cached as "in flight" forever.
			await Promise.resolve();
			try {
				const res = await deps.fetchVerifyJson();
				if (!res.ok) return null;
				const v = parseDeployedVersion(await res.text());
				if (v !== null) last = { at: deps.now(), version: v };
				return v;
			} catch {
				return null;
			} finally {
				inflight = null;
			}
		})();
		return inflight;
	};
}

/** The app-wide reader. */
export const readServedVersion = createServedVersionReader({
	fetchVerifyJson: () =>
		fetchWithTimeout(
			verifyJsonPollUrl(),
			{ cache: 'no-store', credentials: 'same-origin' },
			withHiddenFloor(10_000)
		),
	now: () => Date.now()
});
