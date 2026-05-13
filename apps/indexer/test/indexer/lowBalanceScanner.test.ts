/**
 * Tests for LowBalanceScanner. Mocks the Database + BlurtClient
 * fully — no network, no Postgres.
 *
 * Fixture shape differs from WitnessFeePoller's:
 * - scanOnce does both db.query (candidate select) and db.withTx
 *   (queue insert). The fixture handles both paths.
 * - The BlurtClient mock must return a ReadonlyMap<string,
 *   ChainAccount> for getAccounts.
 */

import { describe, expect, it, vi } from 'vitest';
import type { Database } from '$db/pool';
import type { BlurtClient, ChainAccount } from '$blurt/client';
import type pg from 'pg';

import { LowBalanceScanner } from '$indexer/lowBalanceScanner';
import { makeMockClient } from '../testutils/mockClient';

function defaultConfig() {
	return {
		intervalMs: 60_000,
		thresholdBlurt: 0.5,
		activityWindowDays: 7,
		refillCooldownDays: 3,
		refillAmountBlurt: 1,
		maxBatch: 50
	};
}

/** Build a ChainAccount stub with only the fields the scanner
 *  actually reads (name + balance). */
function acc(name: string, balance: string): ChainAccount {
	return {
		name,
		balance,
		posting: { weight_threshold: 1, account_auths: [], key_auths: [] },
		active: { weight_threshold: 1, account_auths: [], key_auths: [] },
		owner: { weight_threshold: 1, account_auths: [], key_auths: [] },
		memo_key: 'BLT1'
	};
}

interface Fixture {
	db: Database;
	blurt: BlurtClient;
	scanner: LowBalanceScanner;
	/** Queries recorded via db.query (candidate SELECT). */
	directQueries: { text: string; params: readonly unknown[] }[];
	/** Queries recorded via db.withTx (INSERT into queue). */
	txClient: ReturnType<typeof makeMockClient>;
	/** getAccounts spy so tests can assert RPC arguments + count. */
	getAccountsSpy: ReturnType<typeof vi.fn>;
}

function makeFixture(opts: {
	candidates: string[];
	balances: ReadonlyMap<string, ChainAccount>;
	getAccountsThrows?: Error;
	insertExpectations?: number; // number of INSERTs expected
}): Fixture {
	const directQueries: { text: string; params: readonly unknown[] }[] = [];
	const txClient = makeMockClient(
		Array.from({ length: opts.insertExpectations ?? opts.candidates.length }, () => ({
			match: 'INSERT INTO relay_pending_transfers',
			rowCount: 1
		}))
	);

	const db: Database = {
		async withTx<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
			return fn(txClient.client);
		},
		async query<R extends pg.QueryResultRow>(
			text: string,
			params?: readonly unknown[]
		): Promise<pg.QueryResult<R>> {
			directQueries.push({ text, params: params ?? [] });
			// Candidate SELECT.
			const rows = opts.candidates.map((name) => ({ name }));
			return {
				rows: rows as unknown as R[],
				rowCount: rows.length
			} as unknown as pg.QueryResult<R>;
		},
		async close() {}
	};

	const getAccountsSpy = vi.fn(async () => {
		if (opts.getAccountsThrows) throw opts.getAccountsThrows;
		return opts.balances;
	});
	const blurt = {
		getAccounts: getAccountsSpy
	} as unknown as BlurtClient;

	const scanner = new LowBalanceScanner(
		db,
		blurt,
		'morphit-relay',
		defaultConfig(),
		'morphit' // Part 111: matches operator_tag on test orders
	);
	return { db, blurt, scanner, directQueries, txClient, getAccountsSpy };
}

describe('LowBalanceScanner.scanOnce', () => {
	it('no candidates → zero-everything result, no RPC call', async () => {
		const fx = makeFixture({ candidates: [], balances: new Map() });
		const result = await fx.scanner.scanOnce();
		expect(result).toEqual({
			candidatesChecked: 0,
			refillsQueued: 0,
			rpcErrors: 0
		});
		expect(fx.getAccountsSpy).not.toHaveBeenCalled();
	});

	it('candidate below threshold → refill queued', async () => {
		const fx = makeFixture({
			candidates: ['alice'],
			balances: new Map([['alice', acc('alice', '0.200 BLURT')]])
		});

		const result = await fx.scanner.scanOnce();

		expect(result.candidatesChecked).toBe(1);
		expect(result.refillsQueued).toBe(1);
		expect(result.rpcErrors).toBe(0);
		// One INSERT into relay_pending_transfers with the right
		// recipient + reason.
		expect(fx.txClient.queries).toHaveLength(1);
		const q = fx.txClient.queries[0]!;
		expect(q.text).toContain('INSERT INTO relay_pending_transfers');
		expect(q.params[0]).toBe('alice');
		expect(q.params[1]).toBe(1); // refillAmountBlurt default
	});

	it('candidate above threshold → no refill queued', async () => {
		const fx = makeFixture({
			candidates: ['bob'],
			balances: new Map([['bob', acc('bob', '5.000 BLURT')]]),
			insertExpectations: 0
		});
		const result = await fx.scanner.scanOnce();
		expect(result.refillsQueued).toBe(0);
		expect(fx.txClient.queries).toHaveLength(0);
	});

	it('mixed batch → only below-threshold get queued', async () => {
		const fx = makeFixture({
			candidates: ['poor', 'rich', 'empty'],
			balances: new Map([
				['poor', acc('poor', '0.100 BLURT')],
				['rich', acc('rich', '10.000 BLURT')],
				['empty', acc('empty', '0.000 BLURT')]
			]),
			insertExpectations: 2
		});
		const result = await fx.scanner.scanOnce();
		expect(result.candidatesChecked).toBe(3);
		expect(result.refillsQueued).toBe(2);
		expect(fx.txClient.queries).toHaveLength(2);
		const recipients = fx.txClient.queries.map((q) => q.params[0]);
		expect(recipients).toContain('poor');
		expect(recipients).toContain('empty');
		expect(recipients).not.toContain('rich');
	});

	it('getAccounts RPC error → rpcErrors counter incremented, no refills', async () => {
		const fx = makeFixture({
			candidates: ['alice'],
			balances: new Map(),
			getAccountsThrows: new Error('connection reset'),
			insertExpectations: 0
		});
		const result = await fx.scanner.scanOnce();
		expect(result.candidatesChecked).toBe(1);
		expect(result.refillsQueued).toBe(0);
		expect(result.rpcErrors).toBe(1);
		expect(fx.txClient.queries).toHaveLength(0);
	});

	it('missing-from-chain account → silently skipped', async () => {
		// Candidate exists in our DB but isn't in the chain's
		// getAccounts response (deleted or never-created). We
		// should NOT queue a refill and NOT increment rpcErrors.
		const fx = makeFixture({
			candidates: ['ghost'],
			balances: new Map(), // empty RPC response
			insertExpectations: 0
		});
		const result = await fx.scanner.scanOnce();
		expect(result.candidatesChecked).toBe(1);
		expect(result.refillsQueued).toBe(0);
		expect(result.rpcErrors).toBe(0);
	});

	it('unparseable balance → warned, skipped, does not crash', async () => {
		// Structured logger writes to process.stderr — spy there.
		const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
		try {
			const fx = makeFixture({
				candidates: ['broken', 'ok'],
				balances: new Map([
					['broken', acc('broken', 'totally not a balance')],
					['ok', acc('ok', '0.100 BLURT')]
				]),
				insertExpectations: 1
			});
			const result = await fx.scanner.scanOnce();
			// 'broken' skipped, 'ok' got queued.
			expect(result.refillsQueued).toBe(1);
			expect(fx.txClient.queries).toHaveLength(1);
			expect(fx.txClient.queries[0]!.params[0]).toBe('ok');
			expect(stderrSpy).toHaveBeenCalled();
		} finally {
			stderrSpy.mockRestore();
		}
	});

	it('candidate SELECT uses correct relay_account filter + activity + cooldown filters', async () => {
		const fx = makeFixture({
			candidates: [],
			balances: new Map()
		});
		await fx.scanner.scanOnce();
		expect(fx.directQueries).toHaveLength(1);
		const q = fx.directQueries[0]!;
		// The query should:
		// - exclude relay account (first param)
		// - check accounts table joined against orders table
		//   (Part 111 — orders.operator_tag gates by THIS instance)
		// - check relay_pending_transfers table (cooldown)
		// - filter by our operator tag (Part 111)
		expect(q.text).toContain('a.name <> $1');
		expect(q.text).toContain('FROM orders');
		expect(q.text).toContain('operator_tag');
		expect(q.text).toContain('relay_pending_transfers');
		expect(q.params[0]).toBe('morphit-relay');
		expect(q.params[4]).toBe('morphit'); // instanceOperatorTag
	});
});

describe('LowBalanceScanner.maybeScan throttle', () => {
	it('first call scans; second immediate call no-ops', async () => {
		const fx = makeFixture({
			candidates: [],
			balances: new Map()
		});
		await fx.scanner.maybeScan();
		const queriesAfterFirst = fx.directQueries.length;
		expect(queriesAfterFirst).toBeGreaterThan(0);

		// Second call inside the throttle window should be a no-op.
		await fx.scanner.maybeScan();
		expect(fx.directQueries.length).toBe(queriesAfterFirst);
	});
});
