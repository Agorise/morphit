/**
 * Unit test — GET /v1/orders/:owner/:permlink/counterparties (cp421).
 *
 * Exercises the HTTP layer with a stubbed Database. The reviewable SQL
 * (the verified-chat conformance LATERAL) is evaluated by Postgres in
 * situ and can't run in CI without a DB, so we stub db.query to return
 * canned rows and verify: the happy-path body shape, that reviewable
 * booleans pass through untouched, that the query binds (owner,
 * permlink, LIMIT), and 400s for a malformed account / permlink.
 */

import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { orderCounterpartiesRoute } from '$api/orderCounterparties';
import type { Database } from '$db/pool';

interface Captured {
	sql: string;
	params: readonly unknown[];
}

/** Mount with a db stub that returns `rows` and records the query. */
function mount(rows: Array<{ peer: string; reviewable: boolean }>, cap?: Captured[]): Hono {
	const db = {
		query: async (sql: string, params: readonly unknown[]) => {
			cap?.push({ sql, params });
			return { rows, rowCount: rows.length };
		}
	};
	const app = new Hono();
	app.route('/v1/orders', orderCounterpartiesRoute(db as unknown as Database));
	return app;
}

type Body = {
	owner: string;
	permlink: string;
	items: Array<{ peer: string; reviewable: boolean }>;
};

describe('GET /v1/orders/:owner/:permlink/counterparties', () => {
	it('returns the reviewable flags for each candidate peer', async () => {
		const cap: Captured[] = [];
		const app = mount(
			[
				{ peer: 'bob', reviewable: true },
				{ peer: 'carol', reviewable: false }
			],
			cap
		);
		const res = await app.request('/v1/orders/alice/buy-btc-usd-2026-07/counterparties');
		expect(res.status).toBe(200);
		const body = (await res.json()) as Body;
		expect(body.owner).toBe('alice');
		expect(body.permlink).toBe('buy-btc-usd-2026-07');
		expect(body.items).toEqual([
			{ peer: 'bob', reviewable: true },
			{ peer: 'carol', reviewable: false }
		]);
		// Query binds owner + permlink + a LIMIT.
		expect(cap).toHaveLength(1);
		expect(cap[0]!.params[0]).toBe('alice');
		expect(cap[0]!.params[1]).toBe('buy-btc-usd-2026-07');
		expect(typeof cap[0]!.params[2]).toBe('number');
	});

	it('binds the default candidate cap when no ?limit is given', async () => {
		const cap: Captured[] = [];
		const app = mount([], cap);
		await app.request('/v1/orders/alice/buy-btc-usd-2026-07/counterparties');
		expect(cap[0]!.params[2]).toBe(50);
	});

	it('honors ?limit for the auto-reply and clamps it to the hard cap', async () => {
		// The settlement auto-reply passes a generous ?limit so it reaches every
		// inquirer on a busy order (not just the default candidate slice).
		const cap: Captured[] = [];
		const app = mount([], cap);
		await app.request('/v1/orders/alice/buy-btc-usd-2026-07/counterparties?limit=200');
		expect(cap[0]!.params[2]).toBe(200);
		// Above the hard cap (500) → clamped, so no caller can force an unbounded
		// scan even on an absurdly popular order.
		const cap2: Captured[] = [];
		const app2 = mount([], cap2);
		await app2.request('/v1/orders/alice/buy-btc-usd-2026-07/counterparties?limit=9999');
		expect(cap2[0]!.params[2]).toBe(500);
	});

	it('400s on a non-numeric or non-positive ?limit', async () => {
		const app = mount([]);
		const base = '/v1/orders/alice/buy-btc-usd-2026-07/counterparties';
		expect((await app.request(`${base}?limit=abc`)).status).toBe(400);
		expect((await app.request(`${base}?limit=0`)).status).toBe(400);
		expect((await app.request(`${base}?limit=-5`)).status).toBe(400);
	});

	it('returns an empty list when nobody is a reviewable counterparty', async () => {
		const app = mount([]);
		const res = await app.request('/v1/orders/alice/buy-btc-usd-2026-07/counterparties');
		expect(res.status).toBe(200);
		const body = (await res.json()) as Body;
		expect(body.items).toEqual([]);
	});

	it('400s on a malformed account name', async () => {
		const app = mount([]);
		const res = await app.request('/v1/orders/-bad-/buy-btc-usd-2026-07/counterparties');
		expect(res.status).toBe(400);
	});

	it('400s on a malformed permlink', async () => {
		const app = mount([]);
		// Upper-case is not allowed by the permlink policy.
		const res = await app.request('/v1/orders/alice/NOT_A_PERMLINK/counterparties');
		expect(res.status).toBe(400);
	});
});
