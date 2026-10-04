/**
 * review / order-complete verdicts and the self-trade signals depend on
 * chain data and block time only.
 *
 * Before: the verified-chat bar (reviews, order-complete counterparty) read the
 * `suspicious_reciprocity` table, which an HOURLY wall-clock detector filled,
 * over windows ending at NOW(). Two nodes fed the same blocks reached different
 * permanent verdicts depending on whether their detector had run in between
 * (HO poc5), and a node indexing the same history later never raised the flags
 * at all (IX2 signal_replay).
 *
 * Real dispatcher, real handlers, real Postgres; three nodes see the same
 * blocks — one with the old hourly detector firing (and an operator clearing
 * its row) between them, one without, and one whose blocks are a month old.
 */
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBlock } from '../../src/indexer/dispatcher';
import { detectSuspiciousReciprocityInTx } from '../../src/indexer/signals';
import { INTEGRATION_ENABLED, setupWithMigrations, type IntegrationFixture } from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

type Op = [string, unknown];
const cj = (signer: string, id: string, json: unknown, active = false): Op => [
	'custom_json',
	{
		required_auths: active ? [signer] : [],
		required_posting_auths: active ? [] : [signer],
		id,
		json: JSON.stringify(json)
	}
];
const xfer = (from: string, to: string, amount: string, memo: string): Op => [
	'transfer',
	{ from, to, amount, memo }
];
const block = (trxs: Op[][], ts: Date, p: string): unknown => ({
	timestamp: ts.toISOString().slice(0, 19),
	transaction_ids: trxs.map((_, i) => `${p}${i}`.padEnd(40, 'f')),
	transactions: trxs.map((operations) => ({ operations }))
});
const order = (p: string) => ({
	permlink: p,
	side: 'sell',
	asset: 'BTC',
	fiat_currency: 'USD',
	amount_min: 10,
	amount_max: 100,
	price_model: { kind: 'spread', percent: 1 },
	payment_methods: ['cash_in_person']
});
const paid = (who: string, p: string): Op[] => [
	xfer(who, 'morphit-fees', '62.500 BLURT', `morphit-fee:${p}`),
	cj(who, 'morphit_order_v1', order(p), true)
];
const chat = (from: string, to: string, extra: Record<string, unknown> = {}): Op =>
	cj(from, 'morphit_chat_v1', {
		recipient: to,
		ciphertext: 'AAAA',
		header: { v: 1, client_tag: `${from}-${Math.random()}` },
		...extra
	});
const fb = (from: string, to: string, p?: string): Op =>
	cj(from, 'morphit_feedback_v1', { subject: to, rating: 5, ...(p ? { order_permlink: p } : {}) });

/** The HO poc5 chain, with block times starting at `base`. */
function chain(base: number): [number, unknown][] {
	const ts = (min: number) => new Date(base + min * 60_000);
	return [
		[60, block([paid('bob', 'o1'), paid('bob', 'o2'), paid('bob', 'o3')], ts(0), 'a')],
		[
			61,
			block([[chat('alice', 'bob', { order_permlink: 'o1' })], [chat('bob', 'alice')]], ts(1), 'b')
		],
		[
			62,
			block([[chat('alice', 'bob', { order_permlink: 'o3' })], [chat('bob', 'alice')]], ts(20), 'c')
		],
		[
			63,
			block(
				[
					[fb('alice', 'bob')],
					[fb('alice', 'bob', 'o1')],
					[fb('alice', 'bob', 'o2')],
					[fb('bob', 'alice')],
					[fb('bob', 'alice', 'o1')],
					[fb('bob', 'alice', 'o2')]
				],
				ts(30),
				'd'
			)
		],
		[
			64,
			block(
				[
					[cj('bob', 'morphit_order_complete_v1', { permlink: 'o3', counterparty: 'alice' })],
					[fb('alice', 'bob', 'o3')]
				],
				ts(40),
				'e'
			)
		]
	];
}

async function apply(fx: IntegrationFixture, n: number, b: unknown): Promise<void> {
	const c: pg.PoolClient = await fx.pool.connect();
	try {
		await c.query(`SET search_path TO "${fx.schema}"`);
		await c.query('BEGIN');
		await applyBlock(
			c,
			n,
			b as never,
			mockBlurt({ reachableOperatorCount: () => 1 }),
			fakeConfig({ feeBaseBlurt: 62.5 }),
			{},
			{},
			((a: number) => a) as never
		);
		await c.query('COMMIT');
	} catch (e) {
		await c.query('ROLLBACK').catch(() => {});
		throw e;
	} finally {
		c.release();
	}
}

interface NodeState {
	ops: string[];
	o3: unknown[];
	feedback: number;
	flags: unknown[];
}

async function runNode(
	fx: IntegrationFixture,
	base: number,
	between: 'hourly-detector' | 'operator-clearance' | 'nothing'
): Promise<NodeState> {
	const blocks = chain(base);
	for (const [n, b] of blocks.slice(0, 4)) await apply(fx, n, b);
	if (between === 'hourly-detector') {
		// What the old hourly run did, at this node's wall clock.
		await fx.db.withTx((c) => detectSuspiciousReciprocityInTx(c, { asOf: new Date() }));
	}
	if (between === 'operator-clearance') {
		// An operator clears the pair locally. That is moderation of what this
		// node displays; it may not change any verdict.
		await fx.db.query('DELETE FROM suspicious_reciprocity');
	}
	await apply(fx, 64, blocks[4]![1]);
	const ops = await fx.db.query<{ s: string }>(
		`SELECT op_id || ':' || status || ':' || COALESCE(reject_reason, '') AS s FROM ops
		  WHERE block_num = 64 ORDER BY trx_in_block`
	);
	const o3 = await fx.db.query(
		`SELECT status, completed_counterparty FROM orders WHERE permlink = 'o3'`
	);
	const feedback = await fx.db.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM feedback');
	const flags = await fx.db.query(
		`SELECT account_a, account_b, mutual_review_count FROM suspicious_reciprocity ORDER BY 1, 2`
	);
	return {
		ops: ops.rows.map((r) => r.s),
		o3: o3.rows,
		feedback: feedback.rows[0]!.n,
		flags: flags.rows
	};
}

describe.skipIf(!INTEGRATION_ENABLED)('signals and the verified-chat bar run on chain time', () => {
	let a: IntegrationFixture;
	let b: IntegrationFixture;
	let c: IntegrationFixture;
	let d: IntegrationFixture;
	beforeAll(async () => {
		a = await setupWithMigrations();
		b = await setupWithMigrations();
		c = await setupWithMigrations();
		d = await setupWithMigrations();
	});
	afterAll(async () => {
		for (const fx of [a, b, c, d]) await fx?.teardown();
	});

	it('the same chain gives the same verdicts on every node, whenever and however it is indexed', async () => {
		const recent = Date.now() - 3 * 3_600_000;
		const nodeA = await runNode(a, recent, 'hourly-detector');
		const nodeB = await runNode(b, recent, 'nothing');
		const nodeC = await runNode(c, recent - 30 * 86_400_000, 'nothing');
		const nodeD = await runNode(d, recent, 'operator-clearance');
		for (const other of [nodeA, nodeD]) {
			expect(other.ops).toEqual(nodeB.ops);
			expect(other.o3).toEqual(nodeB.o3);
			expect(other.feedback).toBe(nodeB.feedback);
		}
		// A month-old copy of the chain reaches the same verdicts and raises the
		// same flag (before: a late node never raised it).
		expect(nodeC.ops).toEqual(nodeB.ops);
		expect(nodeC.o3).toEqual(nodeB.o3);
		expect(nodeC.flags).toEqual(nodeB.flags);
		expect(nodeB.flags.length, 'the reciprocity pattern was not flagged at its block').toBe(1);
		// And the verdict is the one the chain dictates: the pair reviewed each
		// other 3× at 5★ with no third party, so the review is refused and the
		// counterparty gets no credit.
		expect(nodeB.ops).toEqual([
			'morphit_order_complete_v1:applied:',
			'morphit_feedback_v1:rejected:no_verified_counterparty'
		]);
		expect(nodeB.o3).toEqual([{ status: 'completed', completed_counterparty: null }]);
	});
});
