/**
 * Chain data must never halt the indexer.
 *
 * Two shapes of on-chain op used to wedge every indexer at one block for good
 * (the poller rolled the block back and fetched it again, forever):
 *
 *   1. Two fee-bearing ops in ONE Blurt transaction that share its trx id —
 *      two `morphit_feature_bid_v1` ops (any instance), or two
 *      `morphit_order_v1` ops tagged to this instance's operator. The second
 *      op's idempotency INSERT hit a UNIQUE(trx_id), the handler caught the
 *      unique violation without a savepoint and returned ok on an aborted
 *      transaction, and the dispatcher's RELEASE SAVEPOINT then failed.
 *   2. A custom_json whose JSON nests a few thousand levels deep (about 6 KB):
 *      the dispatcher's text pre-pass recursed once per level and threw
 *      RangeError outside any per-op isolation.
 *
 * Proven against real Postgres through the real dispatcher (applyBlock) and
 * the real Poller (the cursor moves past the block).
 */
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyBlock } from '../../src/indexer/dispatcher';
import { Poller } from '../../src/indexer/poller';
import { loadConfig } from '../../src/config/index';
import { CONSENSUS_V2_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

type Op = [string, unknown];

const cj = (signer: string, id: string, json: unknown, active = false): Op => [
	'custom_json',
	{
		required_auths: active ? [signer] : [],
		required_posting_auths: active ? [] : [signer],
		id,
		json: typeof json === 'string' ? json : JSON.stringify(json)
	}
];
const xfer = (from: string, to: string, amount: string, memo: string): Op => [
	'transfer',
	{ from, to, amount, memo }
];

/** One block; each element of `trxs` is one transaction (a list of ops). */
function block(trxs: Op[][], ts: string, idPrefix: string): unknown {
	return {
		timestamp: ts,
		transaction_ids: trxs.map((_, i) => `${idPrefix}${i}`.padEnd(40, 'f')),
		transactions: trxs.map((ops) => ({ operations: ops }))
	};
}

const order = (permlink: string, operatorTag?: string): Record<string, unknown> => ({
	permlink,
	side: 'sell',
	asset: 'BTC',
	fiat_currency: 'USD',
	amount_min: 10,
	amount_max: 100,
	price_model: { kind: 'spread', percent: 1 },
	payment_methods: ['cash_in_person'],
	...(operatorTag ? { operator_tag: operatorTag } : {})
});

const deepJson = (depth: number): string => '['.repeat(depth) + ']'.repeat(depth);

async function apply(
	fx: IntegrationFixture,
	n: number,
	b: unknown,
	cfg: Record<string, unknown> = {}
): Promise<void> {
	const c: pg.PoolClient = await fx.pool.connect();
	try {
		await c.query(`SET search_path TO "${fx.schema}"`);
		await c.query('BEGIN');
		await applyBlock(
			c,
			n,
			b as never,
			mockBlurt({ reachableOperatorCount: () => 1 }),
			fakeConfig(cfg as never),
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

async function opsOf(
	fx: IntegrationFixture,
	n: number
): Promise<{ op: number; op_id: string; status: string; reason: string | null }[]> {
	return (
		await fx.db.query<{ op: number; op_id: string; status: string; reason: string | null }>(
			`SELECT op_in_trx AS op, op_id, status, reject_reason AS reason
			   FROM ops WHERE block_num = $1 ORDER BY trx_in_block, op_in_trx`,
			[n]
		)
	).rows;
}

/** The two halting blocks, after a setup block. */
const featureBidBlocks = (): Map<number, unknown> =>
	new Map<number, unknown>([
		[
			101,
			block(
				[
					[
						xfer('mallory', 'morphit-fees', '62.500 BLURT', 'morphit-fee:feat'),
						cj('mallory', 'morphit_order_v1', order('feat'), true)
					]
				],
				'2026-10-01T00:01:00',
				'a'
			)
		],
		[
			102,
			block(
				[
					[
						xfer('mallory', 'morphit-fees', '300.000 BLURT', 'morphit-feature:feat'),
						cj(
							'mallory',
							'morphit_feature_bid_v1',
							{ order_permlink: 'feat', hours_requested: 6 },
							true
						),
						cj(
							'mallory',
							'morphit_feature_bid_v1',
							{ order_permlink: 'feat', hours_requested: 6 },
							true
						)
					]
				],
				'2026-10-01T00:01:03',
				'b'
			)
		]
	]);

const taggedOrderBlocks = (): Map<number, unknown> =>
	new Map<number, unknown>([
		[
			101,
			block(
				[
					[
						cj('victimop', 'morphit_operator_register_v1', {
							v: 1,
							tag: 'victimtag',
							display_name: 'Victim Node'
						})
					]
				],
				'2026-10-01T00:01:00',
				'c'
			)
		],
		[
			102,
			block(
				[
					[
						xfer('mallory', 'morphit-fees', '62.500 BLURT', 'morphit-fee:aaa'),
						xfer('mallory', 'morphit-fees', '62.500 BLURT', 'morphit-fee:bbb'),
						cj('mallory', 'morphit_order_v1', order('aaa', 'victimtag'), true),
						cj('mallory', 'morphit_order_v1', order('bbb', 'victimtag'), true)
					]
				],
				'2026-10-01T00:01:03',
				'd'
			)
		]
	]);

const deepNestBlocks = (): Map<number, unknown> =>
	new Map<number, unknown>([
		[
			101,
			block(
				[[cj('alice', 'morphit_profile_v1', { display_name: 'ok' })]],
				'2026-10-01T00:01:00',
				'e'
			)
		],
		[
			102,
			block(
				[
					[cj('mallory', 'morphit_chat_v1', deepJson(3000))],
					[cj('alice', 'morphit_profile_v1', { display_name: 'still ok' })]
				],
				'2026-10-01T00:01:03',
				'f'
			)
		]
	]);

/** The REAL Poller over a chain that serves `blocks` (head = 102). */
async function pollerAdvancesTo102(
	fx: IntegrationFixture,
	blocks: Map<number, unknown>,
	operatorTag?: string
): Promise<{ indexedBlock: number; cursor: string | undefined }> {
	const chain = mockBlurt({
		reachableOperatorCount: () => 1,
		endpointCount: () => 1,
		healthyEndpointCount: () => 1,
		fastestLatencyMs: () => 1,
		getDynamicGlobalProperties: async () =>
			({ head_block_number: 102, last_irreversible_block_num: 102 }) as never,
		crossCheckChainConsistency: async () =>
			({ consistent: true, reason: 'ok', agreeing: 1, contacted: 1, required: 1 }) as never,
		getBlocks: (async (nums: readonly number[]) => nums.map((n) => blocks.get(n) ?? null)) as never
	});
	const saved = { ...process.env };
	Object.assign(process.env, {
		MORPHIT_INDEXER_DATABASE_URL: 'postgres://unused@localhost/unused',
		MORPHIT_INDEXER_RELAY_ACCOUNT: 'morphit-relay',
		MORPHIT_INDEXER_FEE_RECIPIENT: 'morphit-fees',
		MORPHIT_INDEXER_CHAIN_ID: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
		MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://indexer.example.org',
		MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY:
			'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9',
		MORPHIT_INDEXER_BACKFILL_MODE: 'fifo',
		MORPHIT_INDEXER_BACKFILL_CONCURRENCY: '1',
		// The fee the test blocks pay, so the fee-bearing ops verify and reach
		// the idempotency INSERTs that used to abort the block.
		MORPHIT_INDEXER_FEE_BASE_BLURT: '62.5',
		...(operatorTag ? { MORPHIT_INSTANCE_OPERATOR_TAG: operatorTag } : {})
	});
	const config = (() => {
		try {
			return loadConfig();
		} finally {
			process.env = saved;
		}
	})();
	if (operatorTag) expect(config.instanceOperatorTag).toBe(operatorTag);
	await fx.db.query(
		`INSERT INTO indexer_state (id, last_applied_block, chain_id) VALUES (1, 100, $1)
		 ON CONFLICT (id) DO UPDATE SET last_applied_block = 100`,
		[config.chainId]
	);
	const poller = new Poller(config, fx.db, chain, null, null);
	const p = poller as unknown as { status: { indexedBlock: number }; tick(): Promise<void> };
	p.status = { ...p.status, indexedBlock: 100 };
	for (let i = 0; i < 3 && poller.getStatus().indexedBlock < 102; i++) {
		await p.tick().catch(() => undefined);
	}
	const st = await fx.db.query<{ n: string }>(
		'SELECT last_applied_block::text AS n FROM indexer_state WHERE id = 1'
	);
	return { indexedBlock: poller.getStatus().indexedBlock, cursor: st.rows[0]?.n };
}

describe.skipIf(!INTEGRATION_ENABLED)('two fee-bearing ops in one transaction never halt', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		await fx.db.query(
			'TRUNCATE featured_slot_bids, operator_attribution_events, operators CASCADE'
		);
	});

	it('two feature bids in one transaction: the block applies, one bid is recorded, both ops are logged', async () => {
		const blocks = featureBidBlocks();
		await apply(fx, 101, blocks.get(101));
		await expect(apply(fx, 102, blocks.get(102)), 'the block was rolled back').resolves.toBe(
			undefined
		);
		const ops = await opsOf(fx, 102);
		expect(ops.map((o) => [o.op_id, o.status])).toEqual([
			['morphit_feature_bid_v1', 'applied'],
			['morphit_feature_bid_v1', 'rejected']
		]);
		expect(ops[1]!.reason).toBe('duplicate_feature_bid');
		const bids = await fx.db.query('SELECT bidder FROM featured_slot_bids');
		expect(bids.rowCount, 'exactly one bid row for one paid transfer').toBe(1);
	});

	it('two tagged orders in one transaction: the block applies and both orders are live', async () => {
		const blocks = taggedOrderBlocks();
		const cfg = { instanceOperatorTag: 'victimtag' };
		await apply(fx, 101, blocks.get(101), cfg);
		await expect(apply(fx, 102, blocks.get(102), cfg), 'the block was rolled back').resolves.toBe(
			undefined
		);
		const ops = await opsOf(fx, 102);
		expect(ops.map((o) => [o.op_id, o.status, o.reason])).toEqual([
			['morphit_order_v1', 'applied', null],
			['morphit_order_v1', 'applied', null]
		]);
		const orders = await fx.db.query<{ permlink: string; fee_status: string }>(
			'SELECT permlink, fee_status FROM orders ORDER BY permlink'
		);
		expect(orders.rows).toEqual([
			{ permlink: 'aaa', fee_status: 'verified' },
			{ permlink: 'bbb', fee_status: 'verified' }
		]);
	});

	it('through the real Poller: the cursor passes two feature bids in one transaction', async () => {
		expect(await pollerAdvancesTo102(fx, featureBidBlocks())).toEqual({
			indexedBlock: 102,
			cursor: '102'
		});
		const bids = await fx.db.query('SELECT bidder FROM featured_slot_bids');
		expect(bids.rowCount, 'the bid must verify, or the halting INSERT is never reached').toBe(1);
	});

	it('through the real Poller: the tagged instance passes two tagged orders in one transaction', async () => {
		expect(await pollerAdvancesTo102(fx, taggedOrderBlocks(), 'victimtag')).toEqual({
			indexedBlock: 102,
			cursor: '102'
		});
		const attributed = await fx.db.query('SELECT order_permlink FROM operator_attribution_events');
		expect(
			attributed.rowCount,
			'the orders must verify and attribute, or the halting INSERT is never reached'
		).toBe(2);
	});
});

describe.skipIf(!INTEGRATION_ENABLED)('deeply nested JSON never halts', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx?.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
	});

	it('a 3000-deep custom_json is rejected invalid_text and the rest of the block applies', async () => {
		const blocks = deepNestBlocks();
		await expect(apply(fx, 102, blocks.get(102)), 'the block was rolled back').resolves.toBe(
			undefined
		);
		const ops = await opsOf(fx, 102);
		expect(ops.map((o) => [o.op_id, o.status, o.reason])).toEqual([
			['morphit_chat_v1', 'rejected', 'invalid_text'],
			['morphit_profile_v1', 'applied', null]
		]);
	});

	it('nesting deep inside an otherwise valid object, and in a transfer memo object, never halts', async () => {
		const deepHeader = `{"recipient":"bob","header":${deepJson(2600)}}`;
		// Under the 16 KB raw-JSON cap, so it is parsed and judged for its depth.
		const deepKeyed = '{"a":'.repeat(2500) + '1' + '}'.repeat(2500);
		await expect(
			apply(
				fx,
				103,
				block(
					[
						[cj('mallory', 'morphit_chat_v1', deepHeader)],
						[cj('mallory', 'morphit_profile_v1', deepKeyed)],
						[
							[
								'transfer',
								{ from: 'eve', to: 'bob', amount: '1.000 BLURT', memo: JSON.parse(deepJson(5000)) }
							]
						]
					],
					'2026-10-01T00:02:00',
					'g'
				)
			),
			'the block was rolled back'
		).resolves.toBe(undefined);
		const ops = await opsOf(fx, 103);
		expect(ops.map((o) => [o.op_id, o.status, o.reason])).toEqual([
			['morphit_chat_v1', 'rejected', 'invalid_text'],
			['morphit_profile_v1', 'rejected', 'invalid_text']
		]);
	});

	it('nesting at a legitimate depth is not rejected for its depth', async () => {
		await apply(
			fx,
			104,
			block(
				[
					[
						cj('alice', 'morphit_profile_v1', {
							display_name: 'x',
							extra: JSON.parse(deepJson(32))
						})
					]
				],
				'2026-10-01T00:03:00',
				'h'
			)
		);
		const ops = await opsOf(fx, 104);
		expect(ops[0]!.reason).not.toBe('invalid_text');
	});

	it('from the activation time, more than 64 levels is rejected; 64, or 65 before it, is not', async () => {
		const H = 4000;
		const stamp = (s: number) =>
			new Date(Date.parse(CONSENSUS_V2_ACTIVATION_TIME) + s * 1000).toISOString().slice(0, 19);
		const at = (depth: number): Op =>
			cj('alice', 'morphit_profile_v1', {
				display_name: 'x',
				extra: JSON.parse(deepJson(depth - 1))
			});
		await apply(fx, H, block([[at(65)], [at(64)]], stamp(0), 'i'));
		await apply(fx, H - 1, block([[at(65)]], stamp(-1), 'j'));
		expect((await opsOf(fx, H)).map((o) => o.reason === 'invalid_text')).toEqual([true, false]);
		expect((await opsOf(fx, H - 1)).map((o) => o.reason === 'invalid_text')).toEqual([false]);
	});

	it('through the real Poller: the cursor passes a 3000-deep custom_json', async () => {
		expect(await pollerAdvancesTo102(fx, deepNestBlocks())).toEqual({
			indexedBlock: 102,
			cursor: '102'
		});
	});
});
