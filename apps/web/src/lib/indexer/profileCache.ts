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
import { PENDING_TTL_MS } from '$lib/stores/pendingEcho';
import { idbGetProfiles, idbPutProfiles, idbDeleteProfile } from '$lib/indexer/profilePersist';
import type { PersistedProfile } from '$lib/indexer/profilePersist';
import type { BatchProfilesResponse, ProfileResponse } from '@morphit/indexer-client';

/** Cache TTL, matching server Cache-Control max-age. */
const CACHE_TTL_MS = 90_000;

/** Persistent (IndexedDB) TTL — how long a profile written to disk stays
 *  servable WITHOUT a network round-trip. Far longer than the 90s memory TTL:
 *  the whole point of the disk layer is that revisiting an account tomorrow is
 *  instant (Ken: "cache all avatars … the moment they need to be loaded", "it
 *  needs to be instantaneous"), so a resolved avatar/name renders from disk for
 *  up to a week. It never goes STALE-invisible in the process — a disk hit
 *  older than CACHE_TTL_MS is served immediately AND revalidated against the
 *  indexer in the background (stale-while-revalidate), so a changed avatar
 *  catches up within one more view while the user waits for nothing. */
const PERSIST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

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

/** cp452 — accounts the LOCAL user just wrote via their OWN confirmed
 *  broadcast, and when. A server fetch that resolves within
 *  {@link PRIME_HOLD_MS} of a prime must NOT overwrite that account's cache
 *  entry, or an in-flight or immediately-following fetch clobbers the user's own
 *  new display name / avatar with the still-stale server read — the "I saved it
 *  but it reverted for a few seconds" flicker (t.txt items 2 + 3).
 *
 *  v1.7.0 — this window was **12 seconds**, with a comment claiming the indexer
 *  "needs ~1-2 blocks" and that 12s "comfortably covers indexer catch-up". It
 *  doesn't, and couldn't: `profiles` is written only by handlers/profile.ts,
 *  which runs from the poller's `applyBlock` — and the poller applies blocks only
 *  up to last-irreversible (ADR-0008), which trails head by **45-63 seconds**.
 *  So the hold expired roughly 40 seconds before the indexer could possibly know
 *  about the edit, and the next fetch reverted it. The exact flicker this
 *  constant exists to prevent, reliably.
 *
 *  Same root error as the order-detail retry (24s), the order-visible poll (40s),
 *  and `setSelfAvatar`'s "1–2 blocks" note: all reasoned about BLOCK time when
 *  the real wait is IRREVERSIBILITY. See ADR-0051.
 *
 *  Now shares `PENDING_TTL_MS` with the optimistic echo stores, because it is the
 *  same question with the same answer — "how long until the indexer can be
 *  trusted to know about my own op?" — and that is a fact about the CHAIN, not
 *  about profiles. Two hand-tuned copies is how one gets fixed and the other
 *  doesn't. */
const primedAt: Map<string, number> = new Map();
const PRIME_HOLD_MS = PENDING_TTL_MS;

function isPrimeHeld(account: string): boolean {
	const t = primedAt.get(account);
	return t !== undefined && Date.now() - t < PRIME_HOLD_MS;
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
	signal?: AbortSignal,
	reload = false
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
			// #2 — `reload` skips the browser's HTTP cache entirely (and
			// refreshes it). Used right after the user broadcasts their own
			// profile: the batch endpoint's `max-age=90` means the browser
			// would otherwise keep replaying the PRE-broadcast response, so
			// busting only our in-memory cache wasn't enough to show the user
			// their own new display name / avatar.
			...(reload ? { cache: 'reload' as RequestCache } : {}),
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
	signal?: AbortSignal,
	opts?: { reload?: boolean }
): Promise<Map<string, ProfileResponse | null>> {
	// Deduplicate + strip empties. A caller passing ['alice', '',
	// 'alice', 'bob'] gets one lookup per distinct non-empty name.
	const deduped = Array.from(
		new Set(accounts.filter((a) => typeof a === 'string' && a.length > 0))
	);
	if (deduped.length === 0) return new Map();

	const result = new Map<string, ProfileResponse | null>();
	let needsFetch: string[] = [];
	const awaitingInFlight: Array<{ account: string; promise: Promise<ProfileResponse | null> }> = [];

	for (const account of deduped) {
		// #2 — a reload request must not be answered from any cached or
		// in-flight value; the whole point is to go past every cache layer.
		if (opts?.reload) {
			needsFetch.push(account);
			continue;
		}
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

	// Resolve everything the memory cache missed. To preserve the in-flight
	// dedup guarantee (a concurrent call for the same account must SHARE this
	// work rather than fire its own fetch), the per-account in-flight promises
	// are registered SYNCHRONOUSLY below — so the disk read AND the network
	// fetch both live inside a single shared `resolution` promise created
	// without an intervening await.
	//
	// `resolution` reads the persistent (IndexedDB) cache FIRST (unless reload),
	// then hits the network only for what disk missed. A disk hit renders the
	// avatar/name in a few ms — no skeleton, no ~7s wait — which is the whole
	// point of persisting across reloads; idbGetProfiles never throws and
	// returns empty when persistence is unavailable, so this degrades cleanly to
	// the old memory+network path.
	//   • fresh disk hit (< PERSIST_TTL_MS) → served, no network.
	//   • disk hit older than the 90s memory TTL → served NOW, and queued for a
	//     background revalidation so a changed profile catches up next view.
	//   • miss → fetched from the network, chunked at MAX_BATCH_SIZE.
	const staleRevalidate: string[] = [];
	const fetchPromises: Promise<void>[] = [];
	if (needsFetch.length > 0) {
		const toResolve = needsFetch;

		interface Resolved {
			readonly value: ProfileResponse | null;
			/** disk hit → already on disk, don't re-persist it. */
			readonly fromDisk: boolean;
			/** null came from a fetch FAILURE, not an authoritative "no profile". */
			readonly failed: boolean;
		}

		// Created synchronously (the first await is INSIDE the IIFE), so the
		// in-flight registration loop just below runs before any suspension.
		const resolution: Promise<Map<string, Resolved>> = (async () => {
			const resolved = new Map<string, Resolved>();
			let networkNeeded = toResolve;

			if (!opts?.reload) {
				const persisted = await idbGetProfiles(toResolve);
				if (persisted.size > 0) {
					const miss: string[] = [];
					const now = Date.now();
					for (const account of toResolve) {
						const rec = persisted.get(account);
						// A prime may have landed while we awaited disk — never let a
						// disk value clobber the user's own just-broadcast profile.
						if (rec && !isPrimeHeld(account) && now - rec.fetchedAt < PERSIST_TTL_MS) {
							resolved.set(account, { value: rec.profile, fromDisk: true, failed: false });
							if (now - rec.fetchedAt >= CACHE_TTL_MS) staleRevalidate.push(account);
						} else {
							miss.push(account);
						}
					}
					networkNeeded = miss;
				}
			}

			// Network for whatever disk didn't answer, chunked so a huge request
			// becomes several parallel HTTP calls.
			await Promise.all(
				chunk(networkNeeded, MAX_BATCH_SIZE).map(async (chunkOfAccounts) => {
					const batch = await fetchBatch(chunkOfAccounts, signal, opts?.reload === true);
					const failed = batch === null;
					for (const account of chunkOfAccounts) {
						const value = batch ? (batch[account] ?? null) : null;
						resolved.set(account, { value, fromDisk: false, failed });
					}
				})
			);
			return resolved;
		})();

		// Register per-account in-flight promises derived from the shared
		// resolution — SYNCHRONOUSLY, before it suspends — so a concurrent call
		// for any of these accounts shares this work instead of duplicating it.
		for (const account of toResolve) {
			const perAccountPromise: Promise<ProfileResponse | null> = resolution.then(
				(m) => m.get(account)?.value ?? null
			);
			inFlight.set(account, perAccountPromise);
		}

		// Apply results to the memory cache + this call's result map, persist
		// network positives, and clean up the in-flight map. A prime-held account
		// keeps its own just-broadcast value (cp452).
		fetchPromises.push(
			resolution.then(
				(resolved) => {
					const toPersist: PersistedProfile[] = [];
					const now = Date.now();
					for (const account of toResolve) {
						const entry = resolved.get(account);
						const value = entry ? entry.value : null;
						const failed = entry ? entry.failed : true;
						const fromDisk = entry ? entry.fromDisk : false;
						if (isPrimeHeld(account)) {
							result.set(account, cache.get(account)?.value ?? value);
						} else {
							// A disk hit is treated as fresh in memory (fetchedAt now) so
							// the session doesn't re-read disk every call; its background
							// revalidation, if it was stale, refreshes the real data.
							// cp428 — a failure-null is SOFT (short TTL); a real "no
							// profile" and a real profile are hard.
							cache.set(account, { value, fetchedAt: now, soft: failed });
							result.set(account, value);
							// Write-through to disk — ONLY a POSITIVE, authoritative
							// profile fetched from the NETWORK (disk hits are already on
							// disk). Never persist a failure-null or a "no profile yet"
							// negative: pinning an absence would hide a just-created
							// profile across reloads, the trap the endpoint's
							// no-store-on-partial and the soft-null policy both avoid.
							if (!failed && value !== null && !fromDisk) {
								toPersist.push({ account, profile: value, fetchedAt: now });
							}
						}
						inFlight.delete(account);
					}
					if (toPersist.length > 0) void idbPutProfiles(toPersist);
				},
				() => {
					// fetchBatch resolves null on error rather than throwing, so this
					// is defensive — clean up in-flight and fall back to soft null.
					for (const account of toResolve) {
						if (isPrimeHeld(account)) {
							result.set(account, cache.get(account)?.value ?? null);
						} else {
							cache.set(account, { value: null, fetchedAt: Date.now(), soft: true });
							result.set(account, null);
						}
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

	// Stale-while-revalidate: any disk hit that was older than the 90s memory
	// TTL was already served above (instantly); now refresh it against the
	// indexer in the background so a changed avatar/name catches up by the next
	// view. `reload: true` forces a network read that SKIPS the disk
	// read-through (so this can't recurse) and, on success, rewrites both the
	// memory cache and disk via the write-through. Deduped by the in-flight map;
	// fire-and-forget — the caller already has its answer.
	if (staleRevalidate.length > 0) {
		void getProfilesBatch(staleRevalidate, undefined, { reload: true });
	}

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

/** Result of {@link getProfileCachedDetailed}. */
export interface ProfileFetchResult {
	/** The profile, or null (no profile OR fetch failed — see `failed`). */
	readonly profile: ProfileResponse | null;
	/** #2 — true when `profile` is null because the fetch FAILED (network /
	 *  non-200 / timeout / abort), NOT because the account authoritatively has
	 *  no profile. `getProfileCached` collapses both into a bare null, so a
	 *  transient indexer blip is indistinguishable from "no profile" — which
	 *  caused the self-avatar store to CLEAR a perfectly good avatar to the
	 *  identicon on any hiccup. Callers that render a cached/prior value use
	 *  this flag to hold that value through a blip instead of blanking it. */
	readonly failed: boolean;
}

/**
 * Like {@link getProfileCached}, but distinguishes a failed fetch from an
 * authoritative "no profile" via the {@link ProfileFetchResult.failed} flag.
 * The distinction comes from the cache entry's soft-null marker (cp428): a
 * soft null was a fetch failure, a hard null is authoritative.
 */
export async function getProfileCachedDetailed(
	account: string,
	signal?: AbortSignal,
	opts?: { reload?: boolean }
): Promise<ProfileFetchResult> {
	const batch = await getProfilesBatch([account], signal, opts);
	const profile = batch.get(account) ?? null;
	// After the batch resolves there's always a cache entry for `account`;
	// a null whose entry is `soft` came from a failure, not an answer.
	const failed = profile === null && cache.get(account)?.soft === true;
	return { profile, failed };
}

/**
 * Clear the cache. Exposed for tests and for explicit invalidation
 * after a user updates their own profile (so they see their own
 * change immediately rather than waiting up to 90s).
 *
 * When `account` is provided, only that account's entry is removed;
 * otherwise the full cache is cleared.
 */
/** Did this account's last read come back as a TRANSIENT FAILURE rather than an
 *  authoritative "no profile"?
 *
 *  v1.8.12 (Ken) — cp428 already drew this distinction internally: a failed
 *  fetch is cached SOFT (5s) while a real absence is cached for the full 90s,
 *  on the reasoning that the short entry would "expire in seconds and the next
 *  render re-fetches". The reasoning was right; the trigger was missing.
 *  `hydrateProfiles` runs once per page load and once per loadMore, so on a
 *  settled orderbook NOTHING asks again — the soft entry expired into silence
 *  and the row kept its identicon until the user navigated or refreshed. Ken:
 *  "i should never have to refresh the page to see the truth."
 *
 *  Exposing the distinction (rather than retrying in here) is deliberate. Two
 *  previous attempts put the retry inside this module and both failed: one
 *  blocked first render and broke the tested fail-fast contract, the other
 *  needed a notification channel to reach the UI at all, because updating the
 *  cache does not re-render anything. The CALLER already owns reactive state —
 *  writing to it is what refreshes the view — so the caller retries and this
 *  module just answers the one question it alone can answer: was that a real
 *  answer, or a blip? */
export function isSoftMiss(account: string): boolean {
	return cache.get(account)?.soft === true;
}

export function clearProfileCache(account?: string): void {
	if (account === undefined) {
		cache.clear();
		primedAt.clear();
		return;
	}
	cache.delete(account);
	primedAt.delete(account);
	// Targeted clear is used to invalidate after the user updates their own
	// profile — evict the on-disk copy too so it isn't served stale next view.
	void idbDeleteProfile(account);
}

/**
 * cp452 — optimistically write the LOCAL user's OWN profile into the shared
 * cache right after a CONFIRMED broadcast (block_num returned), so the
 * orderbook and every IdentityLabel that reads this cache show the new display
 * name / avatar / bio INSTANTLY instead of waiting on the 90s TTL + indexer
 * catch-up (t.txt items 2 + 3). This is the shared-cache twin of
 * stores/selfProfile.setSelfAvatar, which covers only the avatar-menu store.
 *
 * Gated by the caller on a CONFIRMED broadcast, so the value is already on
 * chain and the indexer reconciles within a block or two; until then a
 * concurrent/subsequent server fetch cannot clobber it (see {@link isPrimeHeld}
 * / {@link PRIME_HOLD_MS}). Pass the COMPLETE current profile — any omitted
 * field renders as cleared, not "unchanged".
 *
 * The json_metadata keys written here are exactly the ones
 * extractLabelPropsFromProfile reads back (avatar_svg, avatar_data_uri,
 * short_bio, nostr_url, streaming_url) plus the top-level display_name, so a
 * primed entry round-trips to the props passed in; the profile-freshness smoke
 * pins that contract.
 */
export function primeProfile(
	account: string,
	props: {
		displayName?: string | null;
		avatarSvg?: string | null;
		avatarDataUri?: string | null;
		shortBio?: string | null;
		nostrUrl?: string | null;
		streamingUrl?: string | null;
		websiteUrl?: string | null;
	}
): void {
	if (typeof account !== 'string' || account.length === 0) return;
	const jsonMetadata: Record<string, unknown> = {};
	if (props.avatarSvg) jsonMetadata.avatar_svg = props.avatarSvg;
	if (props.avatarDataUri) jsonMetadata.avatar_data_uri = props.avatarDataUri;
	if (props.shortBio) jsonMetadata.short_bio = props.shortBio;
	if (props.nostrUrl) jsonMetadata.nostr_url = props.nostrUrl;
	if (props.streamingUrl) jsonMetadata.streaming_url = props.streamingUrl;
	if (props.websiteUrl) jsonMetadata.website_url = props.websiteUrl;
	const profile: ProfileResponse = {
		account,
		display_name: props.displayName ?? '',
		json_metadata: jsonMetadata,
		source_block_num: 0,
		updated_at: new Date().toISOString()
	};
	const now = Date.now();
	primedAt.set(account, now);
	cache.set(account, { value: profile, fetchedAt: now, soft: false });
	// Drop any in-flight fetch so a NEW caller re-reads the primed cache entry
	// rather than sharing a pending pre-broadcast fetch's result.
	inFlight.delete(account);
	// Invalidate the on-disk copy: it still holds the PRE-edit profile, and once
	// the prime's memory entry ages out a disk read would serve the old avatar
	// again. Deleting forces the next miss to re-fetch the freshly-indexed row
	// (and re-persist it). Best-effort; never throws.
	void idbDeleteProfile(account);
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
