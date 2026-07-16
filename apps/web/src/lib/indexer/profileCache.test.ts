// @vitest-environment jsdom
/**
 * Tests for the profile batch cache.
 *
 * Covers the three things the cache does that are easy to get
 * subtly wrong:
 *   1. TTL expiry — a cached entry past its TTL must refetch
 *   2. In-flight sharing — concurrent callers for the same
 *      account trigger exactly one HTTP fetch
 *   3. Chunk splitting — > 100 accounts fire multiple parallel
 *      HTTP requests instead of one over-limit request
 *
 * We mock globalThis.fetch and assert on call count + arguments.
 * The real network layer is never exercised here; integration
 * tests (session 1 of this feature) cover the server endpoint.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PENDING_TTL_MS } from '$lib/stores/pendingEcho';

import {
	getProfilesBatch,
	getProfileCached,
	clearProfileCache,
	primeProfile,
	_profileCacheSize,
	_profileInFlightCount
} from './profileCache';
import { extractLabelPropsFromProfile } from './profileProps';

/** Build a mock ProfileResponse for testing. Fields match the
 *  shared type shape; values are arbitrary. */
function mockProfile(account: string) {
	return {
		account,
		display_name: `${account} display`,
		json_metadata: {},
		source_block_num: 1,
		updated_at: '2026-04-23T12:00:00.000Z'
	};
}

/** Build a Response mock that fetch returns. The cache expects
 *  body.profiles keyed by account. */
function mockBatchResponse(profiles: Record<string, ReturnType<typeof mockProfile>>) {
	return {
		ok: true,
		status: 200,
		json: async () => ({ profiles })
	} as Response;
}

function mockErrorResponse(status: number) {
	return {
		ok: false,
		status,
		json: async () => ({
			status: 'error',
			code: 'bad_request',
			message: 'mock'
		})
	} as Response;
}

describe('profileCache', () => {
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		clearProfileCache();
		fetchMock = vi.fn();
		globalThis.fetch = fetchMock as unknown as typeof fetch;
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// ─── Basic behaviors ────────────────────────────────────────

	it('returns an empty Map for an empty input', async () => {
		const r = await getProfilesBatch([]);
		expect(r.size).toBe(0);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('strips empties and dedupes the input', async () => {
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ alice: mockProfile('alice') }));
		const r = await getProfilesBatch(['alice', '', 'alice', '']);
		expect(r.size).toBe(1);
		expect(r.get('alice')!.account).toBe('alice');
		// Only one fetch, for one account.
		expect(fetchMock).toHaveBeenCalledTimes(1);
		const url = fetchMock.mock.calls[0]![0] as string;
		expect(url).toContain('accounts=alice');
	});

	it('fetches a single account on cache miss', async () => {
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ alice: mockProfile('alice') }));
		const r = await getProfilesBatch(['alice']);
		expect(r.get('alice')!.display_name).toBe('alice display');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('returns cached value on second call within TTL', async () => {
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ alice: mockProfile('alice') }));
		await getProfilesBatch(['alice']);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// Second call — should hit cache, no new fetch.
		const r = await getProfilesBatch(['alice']);
		expect(r.get('alice')!.account).toBe('alice');
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it('fetches only the missing accounts when some are cached', async () => {
		// Prime the cache with alice.
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ alice: mockProfile('alice') }));
		await getProfilesBatch(['alice']);
		fetchMock.mockClear();

		// Now request alice + bob. alice is cached; only bob should be fetched.
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ bob: mockProfile('bob') }));
		const r = await getProfilesBatch(['alice', 'bob']);
		expect(r.size).toBe(2);
		expect(r.get('alice')!.account).toBe('alice');
		expect(r.get('bob')!.account).toBe('bob');

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const url = fetchMock.mock.calls[0]![0] as string;
		expect(url).toContain('accounts=bob');
		expect(url).not.toContain('alice');
	});

	// ─── Null-value handling ────────────────────────────────────

	it('caches missing accounts as null', async () => {
		// Server returns only bob; alice is absent from the response.
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ bob: mockProfile('bob') }));
		const r = await getProfilesBatch(['alice', 'bob']);
		expect(r.get('alice')).toBeNull();
		expect(r.get('bob')!.account).toBe('bob');

		// Second call for alice should NOT refetch — null is cached too.
		fetchMock.mockClear();
		const r2 = await getProfilesBatch(['alice']);
		expect(r2.get('alice')).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it('handles HTTP errors by caching nulls (not throwing)', async () => {
		fetchMock.mockResolvedValueOnce(mockErrorResponse(500));
		const r = await getProfilesBatch(['alice']);
		expect(r.get('alice')).toBeNull();
	});

	it('handles network errors by caching nulls', async () => {
		fetchMock.mockRejectedValueOnce(new TypeError('network down'));
		const r = await getProfilesBatch(['alice']);
		expect(r.get('alice')).toBeNull();
	});

	it('handles malformed JSON response as nulls', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: async () => ({ not_profiles: 'oops' })
		} as Response);
		const r = await getProfilesBatch(['alice']);
		expect(r.get('alice')).toBeNull();
	});

	// ─── TTL expiry ─────────────────────────────────────────────

	it('refetches after the TTL elapses', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-23T12:00:00Z'));

		fetchMock.mockResolvedValueOnce(mockBatchResponse({ alice: mockProfile('alice') }));
		await getProfilesBatch(['alice']);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// 89 seconds later — still fresh.
		vi.setSystemTime(new Date('2026-04-23T12:01:29Z'));
		await getProfilesBatch(['alice']);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// 91 seconds later — stale, should refetch.
		vi.setSystemTime(new Date('2026-04-23T12:01:31Z'));
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ alice: mockProfile('alice') }));
		await getProfilesBatch(['alice']);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// ─── cp428: fetch-failure nulls self-heal fast (soft TTL) ────
	// A transient blip during a profile batch must NOT hide a real display
	// name for the full 90s — it used to, so a card fell back to "@account"
	// for a minute and a half even though the profile was well indexed.

	it('re-fetches a FAILED-fetch null after the short soft TTL (not 90s)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-23T12:00:00Z'));

		// First fetch fails (network down) → null, but SOFT-cached.
		fetchMock.mockRejectedValueOnce(new TypeError('network down'));
		const r1 = await getProfilesBatch(['alice']);
		expect(r1.get('alice')).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// 3s later — still inside the 5s soft TTL, no refetch yet.
		vi.setSystemTime(new Date('2026-04-23T12:00:03Z'));
		await getProfilesBatch(['alice']);
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// 6s after the failure — past the soft TTL but WELL before 90s.
		// The blip must have cleared: a re-fetch fires and now succeeds.
		vi.setSystemTime(new Date('2026-04-23T12:00:06Z'));
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ alice: mockProfile('alice') }));
		const r2 = await getProfilesBatch(['alice']);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(r2.get('alice')!.display_name).toBe('alice display');
	});

	it('keeps a GENUINE "no profile" null cached the full TTL (no soft expiry)', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-23T12:00:00Z'));

		// HTTP 200, but alice is absent → authoritative "no profile".
		fetchMock.mockResolvedValueOnce(mockBatchResponse({}));
		const r1 = await getProfilesBatch(['alice']);
		expect(r1.get('alice')).toBeNull();
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// 6s later — past the SOFT ttl, but this null is authoritative, so it
		// must stay cached (must NOT be treated as a transient failure).
		vi.setSystemTime(new Date('2026-04-23T12:00:06Z'));
		await getProfilesBatch(['alice']);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	// ─── In-flight deduplication ────────────────────────────────

	it('shares in-flight promise across concurrent calls', async () => {
		// Build a fetch that doesn't resolve until we explicitly let it.
		// Both concurrent calls for 'alice' should share this one
		// promise, producing exactly one fetch.
		let resolveFetch: ((r: Response) => void) | null = null;
		const fetchPromise = new Promise<Response>((r) => {
			resolveFetch = r;
		});
		fetchMock.mockReturnValueOnce(fetchPromise);

		// Fire both concurrently. Critical: call both synchronously
		// without awaiting the first — that's what "concurrent"
		// means here.
		const p1 = getProfilesBatch(['alice']);
		const p2 = getProfilesBatch(['alice']);

		// The in-flight registry should contain exactly one entry for
		// alice at this point — not two.
		expect(_profileInFlightCount()).toBe(1);

		// Resolve the fetch.
		resolveFetch!(mockBatchResponse({ alice: mockProfile('alice') }));
		const [r1, r2] = await Promise.all([p1, p2]);

		// Both calls see the profile. Only one fetch was issued.
		expect(r1.get('alice')!.account).toBe('alice');
		expect(r2.get('alice')!.account).toBe('alice');
		expect(fetchMock).toHaveBeenCalledTimes(1);

		// After resolution, in-flight entry is cleaned up.
		expect(_profileInFlightCount()).toBe(0);
	});

	it('cleans up in-flight entries after a failed fetch', async () => {
		fetchMock.mockRejectedValueOnce(new TypeError('network down'));
		await getProfilesBatch(['alice']);
		// Even though fetch rejected, in-flight map shouldn't leak.
		expect(_profileInFlightCount()).toBe(0);
	});

	it('partitions cached + in-flight + missing correctly', async () => {
		// Prime the cache with alice.
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ alice: mockProfile('alice') }));
		await getProfilesBatch(['alice']);
		fetchMock.mockClear();

		// Start a fetch for bob but don't resolve it yet.
		let resolveBob: ((r: Response) => void) | null = null;
		fetchMock.mockReturnValueOnce(
			new Promise<Response>((r) => {
				resolveBob = r;
			})
		);
		const bobInFlight = getProfilesBatch(['bob']);

		// Now request alice (cached) + bob (in-flight) + carol (missing).
		// Only carol should trigger a new fetch.
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ carol: mockProfile('carol') }));
		const mixedRequest = getProfilesBatch(['alice', 'bob', 'carol']);

		// Resolve bob's fetch.
		resolveBob!(mockBatchResponse({ bob: mockProfile('bob') }));
		await bobInFlight;

		const r = await mixedRequest;
		expect(r.size).toBe(3);
		expect(r.get('alice')!.account).toBe('alice');
		expect(r.get('bob')!.account).toBe('bob');
		expect(r.get('carol')!.account).toBe('carol');

		// Exactly 2 fetches: one for bob (already in-flight from
		// separate call), one for carol (new). alice came from cache.
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	// ─── Chunk splitting ───────────────────────────────────────

	it('splits requests over 100 accounts into multiple fetches', async () => {
		const many = Array.from({ length: 150 }, (_, i) => `user${i.toString().padStart(3, '0')}`);
		fetchMock.mockImplementation(async (url: string) => {
			// Read the `accounts` param from the URL to determine
			// which slice this call is for.
			const parsed = new URL(url);
			const accounts = parsed.searchParams.get('accounts')!.split(',');
			const profiles: Record<string, ReturnType<typeof mockProfile>> = {};
			for (const a of accounts) profiles[a] = mockProfile(a);
			return mockBatchResponse(profiles);
		});

		const r = await getProfilesBatch(many);

		// Two fetches: one for the first 100, one for the remaining 50.
		expect(fetchMock).toHaveBeenCalledTimes(2);
		expect(r.size).toBe(150);

		// Spot-check a few entries.
		expect(r.get('user000')!.account).toBe('user000');
		expect(r.get('user099')!.account).toBe('user099');
		expect(r.get('user149')!.account).toBe('user149');
	});

	// ─── clearProfileCache ─────────────────────────────────────

	it('clearProfileCache() wipes everything', async () => {
		fetchMock.mockResolvedValueOnce(
			mockBatchResponse({
				alice: mockProfile('alice'),
				bob: mockProfile('bob')
			})
		);
		await getProfilesBatch(['alice', 'bob']);
		expect(_profileCacheSize()).toBe(2);

		clearProfileCache();
		expect(_profileCacheSize()).toBe(0);

		// Next call refetches.
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ alice: mockProfile('alice') }));
		await getProfilesBatch(['alice']);
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it('clearProfileCache(account) evicts only that account', async () => {
		fetchMock.mockResolvedValueOnce(
			mockBatchResponse({
				alice: mockProfile('alice'),
				bob: mockProfile('bob')
			})
		);
		await getProfilesBatch(['alice', 'bob']);
		expect(_profileCacheSize()).toBe(2);

		clearProfileCache('alice');
		expect(_profileCacheSize()).toBe(1);

		// alice refetches; bob doesn't.
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ alice: mockProfile('alice') }));
		const r = await getProfilesBatch(['alice', 'bob']);
		expect(r.size).toBe(2);
		expect(fetchMock).toHaveBeenCalledTimes(2);
		// The second fetch was for alice only.
		const secondUrl = fetchMock.mock.calls[1]![0] as string;
		expect(secondUrl).toContain('accounts=alice');
		expect(secondUrl).not.toContain('bob');
	});

	// ─── getProfileCached convenience wrapper ──────────────────

	it('getProfileCached returns the single profile or null', async () => {
		fetchMock.mockResolvedValueOnce(mockBatchResponse({ alice: mockProfile('alice') }));
		const p = await getProfileCached('alice');
		expect(p!.account).toBe('alice');

		// Missing account → null, and the null is cached.
		fetchMock.mockResolvedValueOnce(mockBatchResponse({}));
		const miss = await getProfileCached('nobody');
		expect(miss).toBeNull();

		fetchMock.mockClear();
		const miss2 = await getProfileCached('nobody');
		expect(miss2).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	// ─── cp452: primeProfile optimistic write + prime-hold window ──
	// After the user broadcasts their OWN profile edit, the new value must show
	// INSTANTLY (not after the 90s TTL), and a stale server read during indexer
	// catch-up must not clobber it (t.txt items 2 + 3).

	it('primeProfile makes the edit readable immediately with no fetch, round-tripping through extractLabelPropsFromProfile', async () => {
		primeProfile('alice', {
			displayName: 'Alice New',
			avatarDataUri: 'data:image/webp;base64,AAAA',
			shortBio: 'gm',
			nostrUrl: 'https://njump.me/npub1abc'
		});
		const p = await getProfileCached('alice');
		expect(fetchMock).not.toHaveBeenCalled();
		expect(p).not.toBeNull();
		const props = extractLabelPropsFromProfile(p);
		expect(props.displayName).toBe('Alice New');
		expect(props.avatarDataUri).toBe('data:image/webp;base64,AAAA');
		expect(props.shortBio).toBe('gm');
		expect(props.nostrUrl).toBe('https://njump.me/npub1abc');
	});

	it('a stale server read within the prime-hold window does NOT clobber the prime', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-23T12:00:00Z'));
		primeProfile('alice', { displayName: 'Alice New' });
		// 5s later, still inside the 12s hold window: a reload forces past the
		// cache and the server STILL returns the pre-broadcast name (indexer not
		// caught up). The prime must win, and stay cached.
		vi.setSystemTime(new Date('2026-04-23T12:00:05Z'));
		fetchMock.mockResolvedValueOnce(
			mockBatchResponse({ alice: { ...mockProfile('alice'), display_name: 'Alice OLD' } })
		);
		const r = await getProfilesBatch(['alice'], undefined, { reload: true });
		expect(r.get('alice')!.display_name).toBe('Alice New');
		const cached = await getProfileCached('alice');
		expect(cached!.display_name).toBe('Alice New');
	});

	it('the prime outlasts the indexer\'s irreversibility lag (the whole point)', async () => {
		// v1.7.0 — this test used to assert the OPPOSITE, at 13s, on the premise
		// that "the indexer has caught up". It hasn't and can't: `profiles` is
		// written only by handlers/profile.ts, which runs from the poller's
		// applyBlock, and the poller applies blocks only up to last-irreversible
		// (ADR-0008) — 45-63s behind head. The old 12s hold therefore expired ~40s
		// BEFORE the indexer could possibly know about the edit, and the next fetch
		// reverted the user's own just-saved name. That is exactly the "I saved it
		// but it reverted" flicker the hold exists to prevent, happening reliably.
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-23T12:00:00Z'));
		primeProfile('alice', { displayName: 'Alice New' });

		// 63s: the far end of Blurt's last-irreversible lag. A server read landing
		// here is still, legitimately, stale — the user's own value must survive it.
		vi.setSystemTime(new Date('2026-04-23T12:01:03Z'));
		fetchMock.mockResolvedValueOnce(
			mockBatchResponse({ alice: { ...mockProfile('alice'), display_name: 'Alice STALE' } })
		);
		const held = await getProfilesBatch(['alice'], undefined, { reload: true });
		expect(held.get('alice')!.display_name).toBe('Alice New');
	});

	it('after the prime-hold window elapses, a server read takes over from the prime', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-23T12:00:00Z'));
		primeProfile('alice', { displayName: 'Alice New' });
		// Past the hold: the indexer has had well over the irreversibility lag to
		// catch up, so the authoritative server value wins again. The prime must not
		// pin a stale local value forever — if the broadcast never landed, the user
		// needs to find that out.
		vi.setSystemTime(new Date(Date.now() + PENDING_TTL_MS + 1_000));
		fetchMock.mockResolvedValueOnce(
			mockBatchResponse({ alice: { ...mockProfile('alice'), display_name: 'Alice CONFIRMED' } })
		);
		const r = await getProfilesBatch(['alice'], undefined, { reload: true });
		expect(r.get('alice')!.display_name).toBe('Alice CONFIRMED');
	});

	it('clearProfileCache() also drops prime-hold state so a later server read applies', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-23T12:00:00Z'));
		primeProfile('alice', { displayName: 'Alice New' });
		clearProfileCache();
		// Same instant, but the prime hold was cleared with the cache, so a
		// server read is applied instead of being held off.
		fetchMock.mockResolvedValueOnce(
			mockBatchResponse({ alice: { ...mockProfile('alice'), display_name: 'Alice SERVER' } })
		);
		const r = await getProfilesBatch(['alice']);
		expect(r.get('alice')!.display_name).toBe('Alice SERVER');
	});
});
