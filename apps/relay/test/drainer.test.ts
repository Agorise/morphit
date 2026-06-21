/**
 * Tests for RelayQueueDrainer. Mocks the Database and BlurtClient
 * entirely — no real Postgres or RPC needed.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';

import { RelayQueueDrainer } from '$queue/drainer';
import type { UnlockedConfig } from '$config';
import type { Database } from '$db/pool';
import type { BlurtClient } from '$blurt/client';
import type pg from 'pg';

interface Row {
	id: number;
	recipient: string;
	kind: 'liquid' | 'vesting';
	amount_blurt: string;
	reason: string;
	error_count: number;
}

function makeConfig(overrides: Partial<UnlockedConfig> = {}): UnlockedConfig {
	return {
		listenHost: '127.0.0.1',
		listenPort: 8080,
		publicOrigin: 'https://relay.morphit.io',
		blurtRpcEndpoints: ['https://rpc.blurt.blog'],
		relayAccount: 'morphit-relay',
		relayActiveKeyWif: '5K' + 'A'.repeat(50), // shape-only
		relayActiveKeyEnvelope: undefined,
		allowedOrigins: ['https://morphit.io'],
		availabilityRatePerMin: 60,
		createRatePerHour: 5,
		createRatePerDay: 2,
		maxRequestBodyBytes: 64 * 1024,
		signupEnabled: true,
		signupDailyCeiling: 50,
		signupCeilingPersistPath: null,
		autoMintEnabled: false,
		autoMintTargetActs: 25,
		autoMintLowWaterActs: 10,
		autoMintIntervalMs: 3_600_000,
		autoMintMaxPerCycle: 25,
		autoMintMinBlurtReserve: 50,
		dataDir: null,
		createSpacingMinutes: 60,
		altchaTriggerCount: 3,
		altchaMaxnumber: 100_000,
		inviteHmacSecret: undefined,
		altchaHmacSecret: undefined,
		highValueNamePolicy: 'off' as const,
		highValueShortNameThreshold: 4,
		sequentialDetectorEnabled: false,
		sequentialWindowMs: 3_600_000,
		sequentialThreshold: 2,
		sequentialMinPrefix: 3,
		trustedProxyIps: '',
		databaseUrl: 'postgres://test',
		queuePollIntervalMs: 60_000,
		queueBatchSize: 20,
		queueMaxRetries: 10,
		verboseHealth: false,
		accountCreationFeeBlurt: 100,
		vapidPublicKey: undefined,
		vapidPrivateKey: undefined,
		vapidSubject: undefined,
		pushEnabled: false,
		pushPollIntervalMs: 30_000,
		pushBatchSize: 50,
		pushMaxAgeSeconds: 3600,
		pushMaxConsecutiveFailures: 5,
		pushRequireSigned: false,
		...overrides
	};
}

/** Build a Database mock that returns the given rows on the SELECT,
 *  and records UPDATE statements for assertion.  The drainer uses
 *  db.connect() for transactional access (BEGIN/SAVEPOINT/COMMIT),
 *  so the mock returns a client object with query() + release() and
 *  silently absorbs the transaction-control statements. */
function makeDb(rows: Row[]): {
	db: Database;
	updates: Array<{ text: string; params: readonly unknown[] }>;
} {
	const updates: Array<{ text: string; params: readonly unknown[] }> = [];
	// Track which transactional statements ran for sanity assertions.
	const txStatements = new Set(['BEGIN', 'COMMIT', 'ROLLBACK']);
	function isTransactionControl(text: string): boolean {
		const trimmed = text.trim().toUpperCase();
		if (txStatements.has(trimmed)) return true;
		return (
			trimmed.startsWith('SAVEPOINT ') ||
			trimmed.startsWith('RELEASE SAVEPOINT ') ||
			trimmed.startsWith('ROLLBACK TO SAVEPOINT ')
		);
	}
	async function fakeQuery<R extends pg.QueryResultRow>(
		text: string,
		params?: readonly unknown[]
	): Promise<pg.QueryResult<R>> {
		if (isTransactionControl(text)) {
			return {
				rows: [] as R[],
				rowCount: 0
			} as unknown as pg.QueryResult<R>;
		}
		if (text.includes('SELECT')) {
			return {
				rows: rows as unknown as R[],
				rowCount: rows.length
			} as unknown as pg.QueryResult<R>;
		}
		// Everything else is an UPDATE.
		updates.push({ text, params: params ?? [] });
		return {
			rows: [] as R[],
			rowCount: 1
		} as unknown as pg.QueryResult<R>;
	}
	const fakeClient = {
		query: fakeQuery,
		release: () => {}
	};
	const db: Database = {
		async withTx() {
			throw new Error('drainer should not use withTx');
		},
		query: fakeQuery,
		async connect() {
			return fakeClient as unknown as pg.PoolClient;
		},
		async close() {}
	};
	return { db, updates };
}

function makeBlurt(overrides: Partial<BlurtClient> = {}): BlurtClient {
	// Cast through unknown — we only use a subset of BlurtClient in
	// the drainer, so a partial mock is fine.
	return {
		broadcastTransfer: vi.fn(async () => ({
			id: 'tx-liquid',
			block_num: 100,
			trx_num: 0,
			expired: false
		})),
		broadcastTransferToVesting: vi.fn(async () => ({
			id: 'tx-vesting',
			block_num: 101,
			trx_num: 0,
			expired: false
		})),
		...overrides
	} as unknown as BlurtClient;
}

describe('RelayQueueDrainer', () => {
	it('empty queue → attempted=0, no broadcasts', async () => {
		const { db } = makeDb([]);
		const blurt = makeBlurt();
		const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
		const result = await drainer.drainOnce();
		expect(result.attempted).toBe(0);
		expect(result.succeeded).toBe(0);
		expect(result.failed).toBe(0);
		expect(blurt.broadcastTransfer).not.toHaveBeenCalled();
	});

	it('single liquid row → broadcastTransfer called + UPDATE marks broadcast', async () => {
		const row: Row = {
			id: 1,
			recipient: 'grandma',
			kind: 'liquid',
			amount_blurt: '10.000',
			reason: 'welcome_bonus_liquid',
			error_count: 0
		};
		const { db, updates } = makeDb([row]);
		const blurt = makeBlurt();
		const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);

		const result = await drainer.drainOnce();
		expect(result.succeeded).toBe(1);
		expect(result.failed).toBe(0);
		expect(blurt.broadcastTransfer).toHaveBeenCalledTimes(1);
		expect(blurt.broadcastTransfer).toHaveBeenCalledWith(
			expect.objectContaining({
				from: 'morphit-relay',
				to: 'grandma',
				amountBlurt: 10
			})
		);
		// Two UPDATEs: phase 1 sets broadcast_attempt_at BEFORE
		// the chain call (closes the N23 residual double-broadcast
		// window), phase 2 sets broadcast_at + broadcast_trx_id
		// after success.  Find the success update by content.
		expect(updates.length).toBeGreaterThanOrEqual(1);
		const successUpdate = updates.find(
			(u) => u.text.includes('broadcast_at') && !u.text.includes('attempt_at = NOW()')
		);
		expect(successUpdate).toBeDefined();
		expect(successUpdate!.params[0]).toBe(1);
		expect(successUpdate!.params[1]).toBe('tx-liquid');
	});

	it('single vesting row → broadcastTransferToVesting called', async () => {
		const row: Row = {
			id: 2,
			recipient: 'grandma',
			kind: 'vesting',
			amount_blurt: '10.000',
			reason: 'welcome_bonus_vesting',
			error_count: 0
		};
		const { db } = makeDb([row]);
		const blurt = makeBlurt();
		const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
		const result = await drainer.drainOnce();
		expect(result.succeeded).toBe(1);
		expect(blurt.broadcastTransferToVesting).toHaveBeenCalledTimes(1);
		expect(blurt.broadcastTransfer).not.toHaveBeenCalled();
	});

	it('broadcast failure → error_count incremented, broadcast_at NOT set', async () => {
		const row: Row = {
			id: 3,
			recipient: 'grandma',
			kind: 'liquid',
			amount_blurt: '10.000',
			reason: 'welcome_bonus_liquid',
			error_count: 2
		};
		const { db, updates } = makeDb([row]);
		const blurt = makeBlurt({
			broadcastTransfer: vi.fn(async () => {
				throw new Error('chain rejected: insufficient balance');
			})
		});
		const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
		const result = await drainer.drainOnce();
		expect(result.succeeded).toBe(0);
		expect(result.failed).toBe(1);
		// Two UPDATEs: phase 1 sets broadcast_attempt_at BEFORE
		// the chain call, phase 2 records the failure (after the
		// chain call threw, the savepoint rolls back phase 1 and
		// the recordFailure path emits the error update).
		expect(updates.length).toBeGreaterThanOrEqual(1);
		const errorUpdate = updates.find((u) => u.text.includes('error_count = error_count + 1'));
		expect(errorUpdate).toBeDefined();
		expect(errorUpdate!.text).toContain('last_error');
		// Error message is truncated to 500 chars; ours is short, so
		// it's intact.
		expect(errorUpdate!.params[1]).toContain('insufficient balance');
	});

	it('poison row does not block subsequent rows', async () => {
		// Row 4 fails, row 5 succeeds. We expect 1 failure + 1
		// success, not "fail and stop".
		const rows: Row[] = [
			{
				id: 4,
				recipient: 'alice',
				kind: 'liquid',
				amount_blurt: '10.000',
				reason: 'x',
				error_count: 0
			},
			{
				id: 5,
				recipient: 'bob',
				kind: 'liquid',
				amount_blurt: '10.000',
				reason: 'y',
				error_count: 0
			}
		];
		const { db, updates } = makeDb(rows);
		let callCount = 0;
		const blurt = makeBlurt({
			broadcastTransfer: vi.fn(async () => {
				callCount++;
				if (callCount === 1) {
					throw new Error('ephemeral failure for row 4');
				}
				return {
					id: 'tx-5',
					block_num: 200,
					trx_num: 0,
					expired: false
				};
			})
		});
		const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
		const result = await drainer.drainOnce();
		expect(result.attempted).toBe(2);
		expect(result.succeeded).toBe(1);
		expect(result.failed).toBe(1);
		expect(callCount).toBe(2);
		// Updates: phase-1 attempt mark for both rows + phase-2
		// success mark for row 5 + error mark for row 4.  The exact
		// total is implementation-dependent; assert presence of one
		// success update and one error update.
		const successUpdate = updates.find(
			(u) =>
				u.text.includes('broadcast_trx_id') ||
				(u.text.includes('broadcast_at = NOW()') && !u.text.includes('attempt_at'))
		);
		const errorUpdate = updates.find((u) => u.text.includes('error_count = error_count + 1'));
		expect(successUpdate).toBeDefined();
		expect(errorUpdate).toBeDefined();
	});

	it('selectPending query includes error_count ceiling + FIFO order', async () => {
		// We can't easily inspect the SQL from the black-box drainer
		// test, but we can check that the query text carries the two
		// invariants our implementation promises.
		const rows: Row[] = [];
		let capturedSelect = '';
		async function fakeQuery<R extends pg.QueryResultRow>(
			text: string
		): Promise<pg.QueryResult<R>> {
			if (text.includes('SELECT')) capturedSelect = text;
			return {
				rows: rows as unknown as R[],
				rowCount: 0
			} as unknown as pg.QueryResult<R>;
		}
		const fakeClient = { query: fakeQuery, release: () => {} };
		const db: Database = {
			async withTx() {
				throw new Error('nope');
			},
			query: fakeQuery,
			async connect() {
				return fakeClient as unknown as pg.PoolClient;
			},
			async close() {}
		};
		const drainer = new RelayQueueDrainer(makeConfig(), db, makeBlurt());
		await drainer.drainOnce();
		expect(capturedSelect).toContain('error_count <');
		expect(capturedSelect).toContain('ORDER BY created_at ASC');
		expect(capturedSelect).toContain('broadcast_at IS NULL');
	});
});
