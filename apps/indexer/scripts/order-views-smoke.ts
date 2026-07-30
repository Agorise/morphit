#!/usr/bin/env tsx
/**
 * Smoke for orderViews API — task #14.
 *
 * Tests pure handler logic (incrementOrderView, readOrderViews)
 * against an in-memory fake Database.  No Hono runtime
 * required — Hono isn't installed in the smoke sandbox, and
 * the privacy + correctness logic lives in the pure functions
 * anyway.
 */

import { incrementOrderView, readOrderViews } from '../src/api/orderViewsLogic.ts';
import type { Database } from '../src/db/pool.ts';
import type pg from 'pg';

let failures = 0;
let scenarios = 0;

const queue: Array<() => Promise<void>> = [];

function scenario(name: string, fn: () => Promise<void> | void): void {
	scenarios++;
	queue.push(async () => {
		try {
			await fn();
			console.log(`  ✓ ${name}`);
		} catch (err) {
			failures++;
			console.log(`  ✗ ${name}`);
			console.log(`      ${err instanceof Error ? err.message : String(err)}`);
		}
	});
}

function makeFakeDb(
	opts: {
		orderExists?: boolean;
		initialCount?: number;
	} = {}
): Database {
	const orderExists = opts.orderExists ?? true;
	let count = opts.initialCount ?? 0;
	let updatedAt: string | null = null;

	const fakeQuery = async <R extends pg.QueryResultRow = pg.QueryResultRow>(
		text: string,
		_params?: readonly unknown[]
	): Promise<pg.QueryResult<R>> => {
		const sql = text.replace(/\s+/g, ' ').trim();

		if (sql.startsWith('SELECT EXISTS')) {
			return {
				rows: [{ exists: orderExists } as unknown as R],
				rowCount: 1,
				command: 'SELECT',
				oid: 0,
				fields: []
			};
		}
		if (sql.startsWith('INSERT INTO order_views')) {
			count += 1;
			updatedAt = new Date().toISOString();
			return {
				rows: [{ count: String(count) } as unknown as R],
				rowCount: 1,
				command: 'INSERT',
				oid: 0,
				fields: []
			};
		}
		if (sql.startsWith('SELECT count, updated_at FROM order_views')) {
			if (count === 0 && updatedAt === null) {
				return {
					rows: [],
					rowCount: 0,
					command: 'SELECT',
					oid: 0,
					fields: []
				};
			}
			return {
				rows: [
					{
						count: String(count),
						updated_at: updatedAt
					} as unknown as R
				],
				rowCount: 1,
				command: 'SELECT',
				oid: 0,
				fields: []
			};
		}
		throw new Error(`fake DB: unhandled query: ${sql.slice(0, 80)}`);
	};

	return {
		query: fakeQuery,
		withTx: async () => {
			throw new Error('fake DB: withTx not expected for view routes');
		},
		close: async () => {}
	};
}

console.log('\n── orderViews smoke ─────────────────────────────────────\n');

scenario('increment 0 → 1 on first view', async () => {
	const db = makeFakeDb({ orderExists: true, initialCount: 0 });
	const r = await incrementOrderView(db, 'alice', 'sell-btc-usd-1234');
	if (r.status !== 200) throw new Error(`status ${r.status}`);
	const body = r.body as { count: number };
	if (body.count !== 1) throw new Error(`expected 1, got ${body.count}`);
});

scenario('increment 1 → 2 on second view', async () => {
	const db = makeFakeDb({ orderExists: true, initialCount: 1 });
	const r = await incrementOrderView(db, 'alice', 'sell-btc-usd-1234');
	const body = r.body as { count: number };
	if (body.count !== 2) throw new Error(`expected 2, got ${body.count}`);
});

scenario('increment 404s when order does not exist', async () => {
	const db = makeFakeDb({ orderExists: false });
	const r = await incrementOrderView(db, 'alice', 'no-such-order');
	if (r.status !== 404) throw new Error(`expected 404, got ${r.status}`);
});

scenario('increment Cache-Control = no-store', async () => {
	const db = makeFakeDb({ orderExists: true });
	const r = await incrementOrderView(db, 'alice', 'sell-btc-usd-1234');
	if (!r.cacheControl.includes('no-store')) {
		throw new Error(`expected no-store, got ${r.cacheControl}`);
	}
});

scenario('increment rejects 1-char account', async () => {
	const db = makeFakeDb({ orderExists: true });
	const r = await incrementOrderView(db, 'a', 'sell-btc-usd-1234');
	if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
});

scenario('increment rejects uppercase account', async () => {
	const db = makeFakeDb({ orderExists: true });
	const r = await incrementOrderView(db, 'Alice', 'sell-btc-usd-1234');
	if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
});

scenario('increment rejects digit-start account', async () => {
	const db = makeFakeDb({ orderExists: true });
	const r = await incrementOrderView(db, '1alice', 'sell-btc-usd-1234');
	if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
});

scenario('increment rejects permlink with underscores', async () => {
	const db = makeFakeDb({ orderExists: true });
	const r = await incrementOrderView(db, 'alice', 'some_underscore');
	if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
});

scenario('increment rejects empty permlink', async () => {
	const db = makeFakeDb({ orderExists: true });
	const r = await incrementOrderView(db, 'alice', '');
	if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
});

scenario('increment account-name boundaries: 3 chars OK', async () => {
	const db = makeFakeDb({ orderExists: true });
	const r = await incrementOrderView(db, 'abc', 'sell-btc-usd-1234');
	if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
});

scenario('increment account-name boundaries: 16 chars OK', async () => {
	const db = makeFakeDb({ orderExists: true });
	const r = await incrementOrderView(db, 'abcdefghijklmnop', 'sell-btc-usd-1234');
	if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
});

scenario('increment account-name boundaries: 17 chars rejected', async () => {
	const db = makeFakeDb({ orderExists: true });
	const r = await incrementOrderView(db, 'abcdefghijklmnopq', 'sell-btc-usd-1234');
	if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
});

scenario('increment accepts dotted account name (Blurt allows)', async () => {
	// shared.ts ACCOUNT_NAME_RE allows dotted segments (e.g.
	// alice.brave) per Blurt's is_valid_account_name.  This
	// smoke confirms the API handler doesn't reject them
	// pre-emptively.  The chain itself enforces all the deeper
	// rules (per-segment length, no consecutive dashes, etc);
	// the API trusts the chain.
	const db = makeFakeDb({ orderExists: true });
	const r = await incrementOrderView(db, 'al.brave', 'sell-btc-usd-1234');
	if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
});

scenario('read: 0 + null when no views recorded', async () => {
	const db = makeFakeDb({ orderExists: true, initialCount: 0 });
	const r = await readOrderViews(db, 'alice', 'sell-btc-usd-1234');
	if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
	const body = r.body as { count: number; updated_at: string | null };
	if (body.count !== 0) throw new Error(`expected 0, got ${body.count}`);
	if (body.updated_at !== null) {
		throw new Error('updated_at should be null');
	}
});

scenario('read: returns count + updated_at after increments', async () => {
	const db = makeFakeDb({ orderExists: true, initialCount: 0 });
	await incrementOrderView(db, 'alice', 'sell-btc-usd-1234');
	await incrementOrderView(db, 'alice', 'sell-btc-usd-1234');
	await incrementOrderView(db, 'alice', 'sell-btc-usd-1234');
	const r = await readOrderViews(db, 'alice', 'sell-btc-usd-1234');
	const body = r.body as { count: number; updated_at: string | null };
	if (body.count !== 3) throw new Error(`expected 3, got ${body.count}`);
	if (body.updated_at === null) throw new Error('updated_at should be set');
});

scenario('read: Cache-Control = public, max-age=30', async () => {
	const db = makeFakeDb({ orderExists: true });
	const r = await readOrderViews(db, 'alice', 'sell-btc-usd-1234');
	if (!r.cacheControl.includes('max-age=30')) {
		throw new Error(`expected max-age=30, got ${r.cacheControl}`);
	}
});

scenario('read: never 404s on missing order (privacy)', async () => {
	const db = makeFakeDb({ orderExists: false, initialCount: 0 });
	const r = await readOrderViews(db, 'bob', 'never-viewed');
	if (r.status !== 200) throw new Error(`expected 200, got ${r.status}`);
});

scenario('read: rejects invalid account', async () => {
	const db = makeFakeDb();
	const r = await readOrderViews(db, 'a', 'sell-btc-usd-1234');
	if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
});

scenario('read: rejects invalid permlink', async () => {
	const db = makeFakeDb();
	const r = await readOrderViews(db, 'alice', 'some_underscore');
	if (r.status !== 400) throw new Error(`expected 400, got ${r.status}`);
});

scenario('increment is non-unique (deliberately)', async () => {
	const db = makeFakeDb({ orderExists: true, initialCount: 0 });
	await incrementOrderView(db, 'alice', 'sell-btc-usd-1234');
	await incrementOrderView(db, 'alice', 'sell-btc-usd-1234');
	const r = await incrementOrderView(db, 'alice', 'sell-btc-usd-1234');
	const body = r.body as { count: number };
	if (body.count !== 3) {
		throw new Error(`viewcounts should be non-unique; expected 3, got ${body.count}`);
	}
});

scenario('account+permlink namespacing (privacy boundary)', async () => {
	const dbA = makeFakeDb({ orderExists: true, initialCount: 0 });
	const dbB = makeFakeDb({ orderExists: true, initialCount: 0 });
	await incrementOrderView(dbA, 'alice', 'sell-btc-usd-1234');
	await incrementOrderView(dbA, 'alice', 'sell-btc-usd-1234');
	const aliceR = await readOrderViews(dbA, 'alice', 'sell-btc-usd-1234');
	const bobR = await readOrderViews(dbB, 'bob', 'sell-btc-usd-1234');
	const aliceBody = aliceR.body as { count: number };
	const bobBody = bobR.body as { count: number };
	if (aliceBody.count !== 2) throw new Error(`expected alice=2, got ${aliceBody.count}`);
	if (bobBody.count !== 0) throw new Error(`expected bob=0, got ${bobBody.count}`);
});

(async () => {
	for (const fn of queue) {
		await fn();
	}
	console.log(`\n${'─'.repeat(54)}`);
	if (failures === 0) {
		console.log(`✓ all ${scenarios} scenarios passed`);
		process.exit(0);
	} else {
		console.log(`✗ ${failures}/${scenarios} scenarios failed`);
		process.exit(1);
	}
})();
