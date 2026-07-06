/**
 * Morphit — client-side profile cache + batch fetcher.
 *
 * The orderbook, feedback lists, and profile cross-reference panes
 * all render many usernames at once. Each user MAY have a custom
 * avatar (SVG or data-URI WebP stored in `profiles.json_metadata`).
 * Without batching, each row would need its own HTTP request to
 * fetch that user's profile — a classic N+1 pattern.
 *
 * This module provides `getProfilesBatch(accounts[])` which:
 *   1. Partitions the requested accounts into three buckets —
 *      already-fresh-cached, in-flight (another call is fetching
 *      this account right now), and missing (needs a new fetch).
 *   2. Issues at most ONE HTTP request per call, for the `missing`
 *      bucket only.
 *   3. Shares in-flight promises across callers — if two components
 *      concurrently request overlapping account sets, each account
 *      is fetched once.
 *   4. Returns a Map<account, ProfileResponse | null>. `null` means
 *      the server knows about no profile for that account — the
 *      caller should fall back to the identicon.
 *
 * Cache TTL: 90 seconds. Matches the server's Cache-Control max-age
 * so stale-client-cache and stale-server-cache expire in lockstep.
 * Profile data changes rarely (display name, avatar, nostr URL);
 * 90s latency for a user's update to propagate to other viewers is
 * an acceptable trade for the simplicity of memory-only caching.
 *
 * Max batch size at the server is 100 accounts; we split larger
 * requests across multiple HTTP calls. In practice no UI surface
 * needs > 50 accounts in one shot (orderbook pages max at 50 rows),
 * so the splitting branch is defensive.
 *
 * See docs/BATCH-PROFILES-DESIGN.md for the design decisions behind
 * the server endpoint.
 */

import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$net/config';
import type { BatchProfilesResponse, ProfileResponse } from '@morphit/indexer-client';

/** Cache TTL, matching server Cache-Control max-age. */
const CACHE_TTL_MS = 90_000;

/** cp428 — negative-cache TTL for a null that came from a FETCH FAILURE
 *  (network error / non-200 / timeout / abort), NOT from a genuine
 *  "account has no profile". A transient indexer blip during a profile batch
 *  used to poison EVERY account in that batch with a 90s null — so a card
 *  (e.g. the viewer's own order) fell back to "@account" instead of the
 *  display name for a full minute and a half, even though the profile was
 *  perfectly well indexed. Failures now expire in a few seconds so the next
 *  render/poll re-fetches and the display name reappears, while still being
 *  long enough to prevent a retry storm during a sustained outage. */
const FAILED_FETCH_TTL_MS = 5_000;

/** Server-side batch limit. Larger requests are split into multiple
 *  HTTP calls; the resulting promises are awaited in parallel. */
const MAX_BATCH_SIZE = 100;

/** Request timeout. Matches the default in the main indexer client;
 *  keep it separately configurable here in case batch calls want a
 *  different budget later. */
const REQUEST_TIMEOUT_MS = 8_000;

interface CacheEntry {
	/** The profile data, or `null` if the server returned no row for
	 *  this account (account exists but hasn't broadcast a profile op). */
	readonly value: ProfileResponse | null;
	/** `Date.now()` at the moment this entry was populated. Used for
	 *  TTL expiry checks. */
	readonly fetchedAt: number;
	/** cp428 — true when `value` is a null that came from a FETCH FAILURE
	 *  rather than an authoritative "no such profile". Soft entries expire on
	 *  the short {@link FAILED_FETCH_TTL_MS} so a transient blip doesn't hide
	 *  a real display name for the full {@link CACHE_TTL_MS}. */
	readonly soft?: boolean;
}

/** The cache. Module-scoped so every page, component, and route
 *  shares the same working set. No explicit eviction — profile data
 *  is small (~500 bytes each), and a power-user session touching
 *  1000 distinct accounts costs ~500 KB which is fine for in-memory
 *  storage. If this assumption is wrong, add LRU without breaking
 *  the public API. */
const cache: Map<string, CacheEntry> = new Map();

/** In-flight promise per account. A call that's waiting on a
 *  network response shares its promise with any subsequent call for
 *  the same account; the second caller awaits the first's fetch
 *  rather than firing a duplicate request. Entries are deleted on
 *  both success and failure paths to prevent the map from retaining
 *  resolved promises. */
const inFlight: Map<string, Promise<ProfileResponse | null>> = new Map();

function isFresh(entry: CacheEntry): boolean {
	const ttl = entry.soft ? FAILED_FETCH_TTL_MS : CACHE_TTL_MS;
	return Date.now() - entry.fetchedAt < ttl;
}

/**
 * Fetch a batch of profiles from the indexer. Thin wrapper around
 * the raw HTTP call — no caching or coalescing; those are handled
 * by `getProfilesBatch`. Exposed for tests. Returns null on network
 * error (caller decides whether to retry or give up).
 *
 * The returned object is keyed by account name. Accounts the server
 * knows nothing about are absent from the response — the caller
 * handles that as "no profile."
 */
async function fetchBatch(
	accounts: readonly string[],
	signal?: AbortSignal
): Promise<Record<string, ProfileResponse> | null> {
	if (accounts.length === 0) return {};
	if (accounts.length > MAX_BATCH_SIZE) {
		throw new Error(`fetchBatch called with ${accounts.length} accounts; max is ${MAX_BATCH_SIZE}`);
	}
	const url = new URL('/v1/profiles', resolveOrigin(MORPHIT_INDEXER_ORIGIN));
	url.searchParams.set('accounts', accounts.join(','));

	// Compose a timeout signal with any caller-supplied signal.
	const timeoutCtrl = new AbortController();
	const timeoutId = setTimeout(() => timeoutCtrl.abort(), REQUEST_TIMEOUT_MS);
	const combined = signal ? anySignal([signal, timeoutCtrl.signal]) : timeoutCtrl.signal;

	try {
		const response = await fetch(url.toString(), {
			method: 'GET',
			headers: { accept: 'application/json' },
			signal: combined
		});
		if (!response.ok) {
			// A 400 here likely means the caller sent something malformed.
			// A 5xx is a server problem. Either way the caller can't
			// usefully distinguish; return null and let the UI fall
			// back to identicons.
			return null;
		}
		const body = (await response.json()) as Partial<BatchProfilesResponse>;
		if (!body || typeof body !== 'object' || !body.profiles) {
			return null;
		}
		return body.profiles;
	} catch {
		return null;
	} finally {
		clearTimeout(timeoutId);
	}
}

/** Compose multiple AbortSignals. Aborts when any input aborts.
 *  Duplicate of the helper in indexer/client.ts; kept separate so
 *  this module has no circular imports with the main client. */
function anySignal(signals: readonly AbortSignal[]): AbortSignal {
	const ctrl = new AbortController();
	for (const s of signals) {
		if (s.aborted) {
			ctrl.abort();
			break;
		}
		s.addEventListener('abort', () => ctrl.abort(), { once: true });
	}
	return ctrl.signal;
}

/**
 * Split an array into chunks of at most `size`. Used when a caller
 * requests more than MAX_BATCH_SIZE accounts in a single call;
 * we issue N parallel HTTP requests and merge.
 */
function chunk<T>(items: readonly T[], size: number): T[][] {
	const out: T[][] = [];
	for (let i = 0; i < items.length; i += size) {
		out.push(items.slice(i, i + size));
	}
	return out;
}

/**
 * Fetch profiles for a set of accounts, consulting the cache and
 * deduplicating in-flight requests. Returns a Map — using a Map
 * rather than a plain object because account names come from
 * untrusted sources and using them as object keys risks prototype-
 * pollution shapes (no such attack is present today but Maps are
 * the safer idiom).
 *
 * The returned Map contains an entry for every requested account:
 *   - `ProfileResponse` if the account has a profile
 *   - `null` if the server returned no row (account exists but
 *     never broadcast a morphit_profile_v1 op, or doesn't exist)
 *
 * Call sites MUST check `null` and fall back to the identicon.
 *
 * Duplicate accounts in the input are collapsed. Case is preserved;
 * account names should already be lowercased by the caller (Blurt
 * account names are lowercase by chain convention).
 *
 * On network error, accounts that couldn't be fetched are returned
 * as `null`, same as a genuine "not found." This is intentional —
 * the UI renders identicons either way, and surfacing a distinction
 * between "no profile" and "network error" would clutter every
 * call site.
 */
export async function getProfilesBatch(
	accounts: readonly string[],
	signal?: AbortSignal
): Promise<Map<string, ProfileResponse | null>> {
	// Deduplicate + strip empties. A caller passing ['alice', '',
	// 'alice', 'bob'] gets one lookup per distinct non-empty name.
	const deduped = Array.from(
		new Set(accounts.filter((a) => typeof a === 'string' && a.length > 0))
	);
	if (deduped.length === 0) return new Map();

	const result = new Map<string, ProfileResponse | null>();
	const needsFetch: string[] = [];
	const awaitingInFlight: Array<{ account: string; promise: Promise<ProfileResponse | null> }> = [];

	for (const account of deduped) {
		// 1. Fresh cache hit — return immediately.
		const cached = cache.get(account);
		if (cached && isFresh(cached)) {
			result.set(account, cached.value);
			continue;
		}
		// 2. In-flight request — share the promise.
		const inFlightPromise = inFlight.get(account);
		if (inFlightPromise) {
			awaitingInFlight.push({ account, promise: inFlightPromise });
			continue;
		}
		// 3. Not cached, not in-flight — needs a new fetch.
		needsFetch.push(account);
	}

	// Kick off new fetches for `needsFetch`. Split into MAX_BATCH_SIZE
	// chunks so a huge request becomes several parallel HTTP calls.
	// For each chunk, we build a single batch fetch, and ALSO register
	// per-account in-flight promises so concurrent calls for any
	// account in this chunk can share the result.
	const fetchPromises: Promise<void>[] = [];
	for (const chunkOfAccounts of chunk(needsFetch, MAX_BATCH_SIZE)) {
		// One batch HTTP promise. Resolves to the full record at once.
		const batchPromise = fetchBatch(chunkOfAccounts, signal);

		// Per-account promises derived from the batch promise.
		// Each one extracts its own entry from the batch response.
		// Wrapped in try/finally so the in-flight map is cleaned up
		// even if the batch rejects.
		for (const account of chunkOfAccounts) {
			const perAccountPromise: Promise<ProfileResponse | null> = batchPromise.then((batch) =>
				batch ? (batch[account] ?? null) : null
			);
			inFlight.set(account, perAccountPromise);
		}

		fetchPromises.push(
			batchPromise.then(
				(batch) => {
					// Populate cache + result for every account in this chunk.
					// cp428 — distinguish the two null causes:
					//   • batch is a RECORD (HTTP 200): an account absent from it
					//     is an authoritative "no profile" → cache null for the
					//     full TTL.
					//   • batch is NULL (fetch failed — network/non-200/timeout):
					//     a transient blip, NOT an answer → cache null SOFT so it
					//     expires in seconds and the next render re-fetches,
					//     instead of hiding a real display name for 90s.
					const failed = batch === null;
					for (const account of chunkOfAccounts) {
						const value = batch ? (batch[account] ?? null) : null;
						cache.set(account, { value, fetchedAt: Date.now(), soft: failed });
						result.set(account, value);
						inFlight.delete(account);
					}
				},
				() => {
					// fetchBatch returns null on error rather than
					// throwing, so this branch is defensive — but if
					// something upstream throws we still want to clean
					// up in-flight entries and fall back to null. cp428 —
					// this is a failure, so the null is SOFT (short TTL).
					for (const account of chunkOfAccounts) {
						cache.set(account, { value: null, fetchedAt: Date.now(), soft: true });
						result.set(account, null);
						inFlight.delete(account);
					}
				}
			)
		);
	}

	// Wait for both fresh fetches AND in-flight requests from other callers.
	await Promise.all([
		...fetchPromises,
		...awaitingInFlight.map(async ({ account, promise }) => {
			const value = await promise;
			result.set(account, value);
		})
	]);

	return result;
}

/**
 * Fetch a single profile, using the batch cache. Convenience for
 * call sites that only need one profile but still want to benefit
 * from cross-component sharing.
 *
 * For true one-off reads outside any batching context (e.g. the
 * profile page's initial fetch), call `getProfile` in the main
 * indexer client directly — it hits the single-profile `/:account`
 * endpoint which is slightly cheaper than a one-item batch.
 */
export async function getProfileCached(
	account: string,
	signal?: AbortSignal
): Promise<ProfileResponse | null> {
	const batch = await getProfilesBatch([account], signal);
	return batch.get(account) ?? null;
}

/**
 * Clear the cache. Exposed for tests and for explicit invalidation
 * after a user updates their own profile (so they see their own
 * change immediately rather than waiting up to 90s).
 *
 * When `account` is provided, only that account's entry is removed;
 * otherwise the full cache is cleared.
 */
export function clearProfileCache(account?: string): void {
	if (account === undefined) {
		cache.clear();
		return;
	}
	cache.delete(account);
}

/**
 * Inspect the cache size. Exposed for tests only — production code
 * should never need to know this.
 * @internal
 */
export function _profileCacheSize(): number {
	return cache.size;
}

/**
 * Inspect in-flight count. Exposed for tests only.
 * @internal
 */
export function _profileInFlightCount(): number {
	return inFlight.size;
}
