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
	display_name: string;
	json_metadata: unknown;
	source_block_num: string;
	updated_at: Date;
}

function row(account: string): Row {
	return {
		account,
		display_name: `${account} display`,
		json_metadata: {},
		source_block_num: '100',
		updated_at: new Date('2026-07-08T00:00:00.000Z')
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
