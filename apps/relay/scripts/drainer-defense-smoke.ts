/**
 * RelayQueueDrainer per-row defenses — tsx smoke.
 *
 * Exercises the §F.12 (G1) defensive paths added to the
 * drainer's processRow:
 *   - amount_blurt upper-bound cap (G1.2)
 *   - amount_bp upper-bound cap (G1.2)
 *   - reason field shape validation (G1.7)
 *   - FIFO tie-breaker on (created_at, id) (G1.4)
 *
 * Why a tsx smoke instead of extending drainer.test.ts:
 * vitest isn't available in this environment.  The existing
 * drainer.test.ts is the canonical test file; this smoke
 * provides runtime coverage of the new defenses in the
 * existing tsx-smoke convention so the §F.12 fixes are
 * runtime-verified, not just typecheck-clean.
 *
 * Mocks Database and BlurtClient.  No real Postgres or RPC.
 *
 * Usage (from apps/relay):
 *   tsx scripts/drainer-defense-smoke.ts
 */

import { RelayQueueDrainer } from '../src/queue/drainer.ts';
import type { UnlockedConfig } from '../src/config/index.ts';
import type { Database } from '../src/db/pool.ts';
import type { BlurtClient } from '../src/blurt/client.ts';
import type pg from 'pg';

// This smoke deliberately exercises error paths.  The drainer's
// logger emits on every rejected row — silence it so the smoke's
// pass/fail output stays readable.  Restore on exit.
const _origConsoleError = console.error;
const _origConsoleWarn = console.warn;
console.error = () => undefined;
console.warn = () => undefined;
process.on('exit', () => {
	console.error = _origConsoleError;
	console.warn = _origConsoleWarn;
});

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void | Promise<void>): Promise<void> {
	scenarios++;
	return Promise.resolve()
		.then(fn)
		.then(
			() => {
				console.log(`  ✓ ${name}`);
			},
			(err) => {
				failures++;
				console.log(`  ✗ ${name}`);
				console.log(`      ${err instanceof Error ? err.message : String(err)}`);
			}
		);
}

function assertEqual(actual: unknown, expected: unknown, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label}: expected ${e}, got ${a}`);
	}
}

interface Row {
	id: number;
	recipient: string;
	kind: 'liquid' | 'vesting' | 'delegation';
	amount_blurt: string;
	amount_bp: string | null;
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
		relayActiveKeyWif: '5K' + 'A'.repeat(50),
		relayActiveKeyEnvelope: undefined,
		allowedOrigins: ['https://morphit.io'],
		availabilityRatePerMin: 60,
		createRatePerHour: 5,
		createRatePerDay: 2,
		maxRequestBodyBytes: 64 * 1024,
		databaseUrl: 'postgres://test',
		queuePollIntervalMs: 60_000,
		queueBatchSize: 20,
		queueMaxRetries: 10,
		...overrides
	} as UnlockedConfig;
}

/** Fake DB that hands processRow a queue of rows on the first
 *  SELECT call, then accepts the subsequent UPDATEs and records
 *  them.  After drainOnce returns we can inspect the recorded
 *  queries to assert what processRow did. */
function makeDb(rows: readonly Row[]): {
	db: Database;
	queries: { text: string; params: readonly unknown[] }[];
} {
	const queries: { text: string; params: readonly unknown[] }[] = [];
	let selectReturned = false;

	const fakeClient: pg.PoolClient = {
		query: ((text: string, params: readonly unknown[] = []) => {
			queries.push({ text, params });
			if (text.startsWith('BEGIN') || text.startsWith('COMMIT') || text.startsWith('ROLLBACK')) {
				return Promise.resolve({ rows: [], rowCount: 0 });
			}
			if (text.includes('SAVEPOINT') || text.includes('RELEASE SAVEPOINT')) {
				return Promise.resolve({ rows: [], rowCount: 0 });
			}
			if (text.includes('SELECT id, recipient, kind') && !selectReturned) {
				selectReturned = true;
				return Promise.resolve({ rows: [...rows], rowCount: rows.length });
			}
			if (text.includes('UPDATE relay_pending_transfers')) {
				return Promise.resolve({ rows: [], rowCount: 1 });
			}
			return Promise.resolve({ rows: [], rowCount: 0 });
		}) as pg.PoolClient['query'],
		release: () => undefined
	} as unknown as pg.PoolClient;

	const db: Database = {
		connect: async () => fakeClient,
		query: async () =>
			({
				rows: [],
				rowCount: 0,
				command: 'SELECT',
				oid: 0,
				fields: []
			}) as pg.QueryResult,
		withTx: async () => {
			throw new Error('not used');
		},
		close: async () => undefined
	} as unknown as Database;

	return { db, queries };
}

interface ChainCallLog {
	calls: {
		method: 'transfer' | 'vesting' | 'delegation';
		args: Record<string, unknown>;
	}[];
	failNext?: Error;
}

function makeBlurt(): { blurt: BlurtClient; log: ChainCallLog } {
	const log: ChainCallLog = { calls: [] };
	const recordOrFail = (
		method: 'transfer' | 'vesting' | 'delegation',
		args: Record<string, unknown>
	) => {
		if (log.failNext !== undefined) {
			const err = log.failNext;
			log.failNext = undefined;
			return Promise.reject(err);
		}
		log.calls.push({ method, args });
		return Promise.resolve({ id: 'trx_' + log.calls.length });
	};
	const blurt: BlurtClient = {
		broadcastTransfer: (args: Record<string, unknown>) => recordOrFail('transfer', args),
		broadcastTransferToVesting: (args: Record<string, unknown>) => recordOrFail('vesting', args),
		broadcastDelegation: (args: Record<string, unknown>) => recordOrFail('delegation', args)
	} as unknown as BlurtClient;
	return { blurt, log };
}

function row(overrides: Partial<Row> = {}): Row {
	return {
		id: 1,
		recipient: 'alice',
		kind: 'liquid',
		amount_blurt: '10',
		amount_bp: null,
		reason: 'welcome_bonus_liquid',
		error_count: 0,
		...overrides
	};
}

// ─── G1.2: amount upper-bound caps ─────────────────────────────

await scenario('G1.2: liquid amount within cap broadcasts', async () => {
	const { db, queries } = makeDb([row({ amount_blurt: '10' })]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	const result = await drainer.drainOnce();
	assertEqual(result, { attempted: 1, succeeded: 1, failed: 0 }, 'drain result');
	assertEqual(log.calls.length, 1, 'broadcast count');
	assertEqual(log.calls[0]!.method, 'transfer', 'broadcast method');
});

await scenario('G1.2: liquid amount above 10000 BLURT cap rejected', async () => {
	const { db, queries } = makeDb([row({ amount_blurt: '50000' })]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	const result = await drainer.drainOnce();
	assertEqual(result, { attempted: 1, succeeded: 0, failed: 1 }, 'drain result');
	assertEqual(log.calls.length, 0, 'no broadcast');
	const errUpdate = queries.find((q) => q.text.includes('error_count = error_count + 1'));
	if (!errUpdate) throw new Error('no error_count UPDATE');
	const errMsg = String(errUpdate.params[1] ?? '');
	if (!errMsg.includes('exceeds cap')) {
		throw new Error(`expected "exceeds cap" in error, got: ${errMsg}`);
	}
});

await scenario('G1.2: vesting amount above cap rejected', async () => {
	const { db, queries } = makeDb([
		row({ kind: 'vesting', amount_blurt: '50000', reason: 'welcome_bonus_vesting' })
	]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	await drainer.drainOnce();
	assertEqual(log.calls.length, 0, 'no broadcast');
});

await scenario('G1.2: delegation amount_bp above 10000 BP cap rejected', async () => {
	const { db, queries } = makeDb([
		row({
			kind: 'delegation',
			amount_blurt: '0',
			amount_bp: '50000',
			reason: 'loyalty_milestone_10000'
		})
	]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	await drainer.drainOnce();
	assertEqual(log.calls.length, 0, 'no broadcast');
});

await scenario('G1.2: delegation amount_bp at cap broadcasts', async () => {
	const { db } = makeDb([
		row({
			kind: 'delegation',
			amount_blurt: '0',
			amount_bp: '10000',
			reason: 'loyalty_milestone_10000'
		})
	]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	await drainer.drainOnce();
	assertEqual(log.calls.length, 1, 'one broadcast');
	assertEqual(log.calls[0]!.method, 'delegation', 'method');
});

// ─── G1.7: reason field shape ──────────────────────────────────

await scenario('G1.7: known-good reason broadcasts', async () => {
	const { db } = makeDb([row({ reason: 'welcome_bonus_liquid' })]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	await drainer.drainOnce();
	assertEqual(log.calls.length, 1, 'broadcast count');
});

await scenario('G1.7: dust_refill reason broadcasts', async () => {
	const { db } = makeDb([row({ reason: 'dust_refill', amount_blurt: '1' })]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	await drainer.drainOnce();
	assertEqual(log.calls.length, 1, 'broadcast count');
});

await scenario('G1.7: loyalty_milestone_100 reason broadcasts', async () => {
	const { db } = makeDb([
		row({
			kind: 'delegation',
			amount_blurt: '0',
			amount_bp: '10',
			reason: 'loyalty_milestone_100'
		})
	]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	await drainer.drainOnce();
	assertEqual(log.calls.length, 1, 'broadcast count');
});

await scenario('G1.7: reason with newline rejected', async () => {
	const { db, queries } = makeDb([row({ reason: 'welcome\nbonus' })]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	const result = await drainer.drainOnce();
	assertEqual(result, { attempted: 1, succeeded: 0, failed: 1 }, 'drain result');
	assertEqual(log.calls.length, 0, 'no broadcast');
});

await scenario('G1.7: reason with whitespace rejected', async () => {
	const { db } = makeDb([row({ reason: 'welcome bonus' })]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	await drainer.drainOnce();
	assertEqual(log.calls.length, 0, 'no broadcast');
});

await scenario('G1.7: reason uppercase rejected', async () => {
	const { db } = makeDb([row({ reason: 'WELCOME_BONUS' })]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	await drainer.drainOnce();
	assertEqual(log.calls.length, 0, 'no broadcast');
});

await scenario('G1.7: empty reason rejected', async () => {
	const { db } = makeDb([row({ reason: '' })]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	await drainer.drainOnce();
	assertEqual(log.calls.length, 0, 'no broadcast');
});

await scenario('G1.7: reason >64 chars rejected', async () => {
	const { db } = makeDb([row({ reason: 'a'.repeat(65) })]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	await drainer.drainOnce();
	assertEqual(log.calls.length, 0, 'no broadcast');
});

await scenario('G1.7: reason 64 chars at boundary accepted', async () => {
	const { db } = makeDb([row({ reason: 'a'.repeat(64) })]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	await drainer.drainOnce();
	assertEqual(log.calls.length, 1, 'broadcast count');
});

// ─── G1.4: FIFO tie-breaker (verified via SELECT shape) ────────

await scenario('G1.4: SELECT clause includes ORDER BY created_at ASC, id ASC', async () => {
	const { db, queries } = makeDb([]);
	const { blurt } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	await drainer.drainOnce();
	const select = queries.find((q) => q.text.includes('SELECT id, recipient, kind'));
	if (!select) throw new Error('no SELECT query found');
	if (!select.text.includes('ORDER BY created_at ASC, id ASC')) {
		throw new Error(`expected "ORDER BY created_at ASC, id ASC", got: ${select.text}`);
	}
});

// ─── Recipient regex (already-shipped defense, regression-test) ─

await scenario('recipient regex: malformed recipient rejected', async () => {
	const { db } = makeDb([row({ recipient: 'BAD CAPS' })]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	await drainer.drainOnce();
	assertEqual(log.calls.length, 0, 'no broadcast');
});

await scenario('recipient regex: valid hyphenated recipient broadcasts', async () => {
	const { db } = makeDb([row({ recipient: 'alice-2026' })]);
	const { blurt, log } = makeBlurt();
	const drainer = new RelayQueueDrainer(makeConfig(), db, blurt);
	await drainer.drainOnce();
	assertEqual(log.calls.length, 1, 'broadcast count');
});

// ─── Final report ───────────────────────────────────────────────

console.log();
console.log('────────────────────────────────────────────────────────────');
if (failures > 0) {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
console.log(`✓ all ${scenarios} scenarios passed`);
