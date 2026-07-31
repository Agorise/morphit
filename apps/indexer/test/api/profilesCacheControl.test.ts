/**
 * Unit test — GET /v1/profiles batch Cache-Control (#2).
 *
 * A batch response that OMITS a requested account carries a negative
 * ("no profile") result, which is usually just indexer lag right after a
 * profile broadcast or signup. Caching that for 90s pins it in the browser's
 * HTTP cache, so the fresh profile stays invisible ACROSS PAGE REFRESHES (the
 * client's in-memory cache is cleared by a reload; the browser's disk cache is
 * not) — the display name falls back to "@account" and the avatar to the
 * identicon, and refreshing changes nothing.
 *
 * So: complete batches stay cacheable; partial batches must be `no-store`.
 * The db is stubbed — the SQL itself is covered by the integration test.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { profilesRoute } from '$api/profiles';
import type { Database } from '$db/pool';

interface Row {
	account: string;
	// v1.5.5: nullable — the batch is anchored on `accounts`, so an account
	// with a posting key but no profile op resolves with these NULL.
	display_name: string | null;
	json_metadata: unknown;
	source_block_num: string | null;
	updated_at: Date | null;
	/** v1.5.5: does a `profiles` row exist? The completeness check keys off
	 *  THIS, not row presence — see `profileLessRow` below. */
	has_profile: boolean;
}

/** A row for an account that HAS a profile. */
function row(account: string): Row {
	return {
		account,
		display_name: `${account} display`,
		json_metadata: {},
		source_block_num: '100',
		updated_at: new Date('2026-07-08T00:00:00.000Z'),
		has_profile: true
	};
}

/**
 * v1.5.5 — a row for an account that EXISTS on-chain but has never set a
 * profile. Impossible before the batch was re-anchored on `accounts`: such an
 * account simply returned nothing, which is why its posting key never reached
 * the profile's review cards (t155, Ken: no truncated key under @kentest2).
 *
 * It is the whole reason the completeness check can no longer count rows. This
 * row IS returned, but it is NOT a profile — pinning a batch containing one
 * would hide that user's profile for the full 90s the moment they create it.
 */
function profileLessRow(account: string): Row {
	return {
		account,
		display_name: null,
		json_metadata: null,
		source_block_num: null,
		updated_at: null,
		has_profile: false
	};
}

/** Mount the route with a db stub that returns exactly `rows`. */
function mount(rows: Row[]): Hono {
	const db = {
		query: async () => ({ rows, rowCount: rows.length })
	} as unknown as Database;
	const app = new Hono();
	app.route('/v1/profiles', profilesRoute(db));
	return app;
}

describe('GET /v1/profiles — batch Cache-Control', () => {
	it('caches a COMPLETE batch (every requested account resolved)', async () => {
		const app = mount([row('alice'), row('bob')]);
		const res = await app.request('/v1/profiles?accounts=alice,bob');
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe(
			'public, max-age=90, stale-while-revalidate=60'
		);
		const body = (await res.json()) as { profiles: Record<string, unknown> };
		expect(Object.keys(body.profiles).sort()).toEqual(['alice', 'bob']);
	});

	it('does NOT cache a batch containing a PROFILE-LESS account (v1.5.5)', async () => {
		// The regression this exists for. v1.5.5 re-anchored the batch on
		// `accounts` so a key-only account resolves (t155: the truncated posting
		// key was missing under @kentest2, because the query started at
		// `profiles` and returned NOTHING for anyone who never set one).
		//
		// That silently broke the negative-caching rule: bob now comes back as a
		// ROW, so a `rows.length === accounts.length` completeness test calls
		// this batch complete and pins it for 90 seconds — and bob stays
		// invisible for a minute and a half after creating his first profile.
		// Row presence stopped meaning "has a profile"; only has_profile does.
		const app = mount([row('alice'), profileLessRow('bob')]);
		const res = await app.request('/v1/profiles?accounts=alice,bob');
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('still RETURNS the profile-less account, so its posting key is usable (v1.5.5)', async () => {
		// Not cacheable is not the same as not useful: bob must still come back,
		// key and all — that IS the t155 fix. His profile fields are simply null.
		const app = mount([row('alice'), profileLessRow('bob')]);
		const res = await app.request('/v1/profiles?accounts=alice,bob');
		const body = (await res.json()) as {
			profiles: Record<string, { display_name: string | null; updated_at: string | null }>;
		};
		expect(Object.keys(body.profiles).sort()).toEqual(['alice', 'bob']);
		// And the null-safety half: rowToProfile used to call
		// updated_at.toISOString() / parseInt(source_block_num) unconditionally,
		// which THREW the moment a profile-less row could reach it.
		expect(body.profiles.bob?.display_name).toBeNull();
		expect(body.profiles.bob?.updated_at).toBeNull();
	});

	it('does NOT cache a PARTIAL batch (an account is missing → negative result)', async () => {
		// bob has no profile row yet — e.g. he broadcast it one block ago.
		const app = mount([row('alice')]);
		const res = await app.request('/v1/profiles?accounts=alice,bob');
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
		const body = (await res.json()) as { profiles: Record<string, unknown> };
		expect(Object.keys(body.profiles)).toEqual(['alice']);
	});

	it('does NOT cache a batch where NO account has a profile', async () => {
		const app = mount([]);
		const res = await app.request('/v1/profiles?accounts=alice,bob');
		expect(res.status).toBe(200);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('a single-account batch that resolves stays cacheable', async () => {
		const app = mount([row('alice')]);
		const res = await app.request('/v1/profiles?accounts=alice');
		expect(res.headers.get('Cache-Control')).toBe(
			'public, max-age=90, stale-while-revalidate=60'
		);
	});

	it('duplicate account names are deduped before the completeness check', async () => {
		// 'alice,alice' dedupes to one requested account; one row ⇒ complete.
		const app = mount([row('alice')]);
		const res = await app.request('/v1/profiles?accounts=alice,alice');
		expect(res.headers.get('Cache-Control')).toBe(
			'public, max-age=90, stale-while-revalidate=60'
		);
	});
});

describe('GET /v1/profiles/:account — single lookup', () => {
	it('does NOT let a 404 be heuristically cached', async () => {
		const app = mount([]);
		const res = await app.request('/v1/profiles/bob');
		expect(res.status).toBe(404);
		expect(res.headers.get('Cache-Control')).toBe('no-store');
	});

	it('returns the profile when it exists', async () => {
		const app = mount([row('alice')]);
		const res = await app.request('/v1/profiles/alice');
		expect(res.status).toBe(200);
		const body = (await res.json()) as { account: string };
		expect(body.account).toBe('alice');
	});
});

/**
 * Server-side warm-positive cache (t.txt avatar latency). Ken: profiles "STILL
 * taking up to 7 seconds … the server itself can cache the user avatars and
 * display name text". The endpoint now serves warm POSITIVES from an in-memory
 * cache and DB-queries only the misses, so a hot avatar/name returns without
 * touching Postgres (and stops queueing behind the poller's block writes).
 * Negatives are never cached — a fresh profile must not be hidden.
 */
describe('GET /v1/profiles — server-side warm-positive cache', () => {
	/** Mount with a db stub that RECORDS the accounts of every query. */
	function mountCounting(rowsFor: (accounts: string[]) => Row[]): {
		app: Hono;
		calls: string[][];
	} {
		const calls: string[][] = [];
		const db = {
			query: async (_sql: string, params: unknown[]) => {
				const accounts = (Array.isArray(params) ? (params[0] as string[]) : []) ?? [];
				calls.push(accounts);
				const rows = rowsFor(accounts);
				return { rows, rowCount: rows.length };
			}
		} as unknown as Database;
		const app = new Hono();
		app.route('/v1/profiles', profilesRoute(db));
		return { app, calls };
	}

	it('serves a warm positive from cache WITHOUT re-querying the DB', async () => {
		const { app, calls } = mountCounting((accts) => accts.map(row)); // all positive
		await app.request('/v1/profiles?accounts=alice,bob');
		await app.request('/v1/profiles?accounts=alice,bob');
		// Second request is fully served from cache — no second DB query.
		expect(calls.length).toBe(1);
	});

	it('never caches a profile-less account — re-queries only it next time', async () => {
		const { app, calls } = mountCounting((accts) =>
			accts.map((a) => (a === 'bob' ? profileLessRow(a) : row(a)))
		);
		await app.request('/v1/profiles?accounts=alice,bob');
		await app.request('/v1/profiles?accounts=alice,bob');
		// alice cached after call 1; bob (a negative) is never cached, so call 2
		// must re-query — and for bob ONLY, since alice came from cache.
		expect(calls.length).toBe(2);
		expect(calls[1]).toEqual(['bob']);
	});

	it('a fully cache-served batch is still marked COMPLETE (cacheable)', async () => {
		const { app } = mountCounting((accts) => accts.map(row));
		await app.request('/v1/profiles?accounts=alice,bob'); // warms the cache
		const res = await app.request('/v1/profiles?accounts=alice,bob'); // all from cache
		expect(res.status).toBe(200);
		// Completeness must count the cache-served positives, not just queried rows.
		expect(res.headers.get('Cache-Control')).toBe(
			'public, max-age=90, stale-while-revalidate=60'
		);
		const body = (await res.json()) as { profiles: Record<string, unknown> };
		expect(Object.keys(body.profiles).sort()).toEqual(['alice', 'bob']);
	});
});
