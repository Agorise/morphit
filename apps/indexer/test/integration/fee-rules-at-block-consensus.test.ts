/**
 * Fee verdicts are judged by the federation's numbers as of the op's block (from
 * the consensus activation time).
 *
 * Before: three inputs were this node's own —
 *   - MORPHIT_INDEXER_FEE_TOLERANCE (an operator may set it up to 0.5): the
 *     stranger-fee and feature-bid bands, and max(it, 15 %) for listing fees;
 *   - the BLURT listing-fee base the poller holds NOW (the newest release this
 *     node has seen), so a node rebuilding or catching up after a re-pin judged
 *     old orders by the new base, and this node's env base when nothing is pinned;
 *   - the BTC / XMR amount the poller holds now, at intake and in the re-check.
 * Two nodes fed the same blocks could store different fee_status values.
 *
 * Now (fee/feeRulesAtBlock.ts): from CONSENSUS_V2_ACTIVATION_TIME, by the op's
 * BLOCK time, the tolerance is the shipped default (0.001), the base and amounts
 * are the ones pinned in force at the op's block (base 125 when none), and the
 * re-derivation jobs use the same rule. Before that time every node keeps
 * exactly its old verdicts.
 *
 * Real handlers and jobs, real Postgres. "Nodes" are the same chain rows judged
 * with different local settings / live pins. Skips without TEST_DATABASE_URL.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import orderHandler from '../../src/indexer/handlers/order';
import strangerFeeHandler from '../../src/indexer/handlers/strangerFee';
import featureBidHandler from '../../src/indexer/handlers/featureBid';
import type { Handler, OpContext } from '../../src/indexer/handler-contract';
import type { BlockHeader, BlockTransaction, ChainOperation } from '../../src/blurt/client';
import type { Config } from '../../src/config';
import type { FeeVerifier, FeeClaim } from '../../src/indexer/fee/verifier';
import { transactionIdOf } from '../../src/blurt/snapshotOpTrust';
import { BlurtFeeReverifier } from '../../src/indexer/blurtFeeReverify';
import { reconcileOperatorRegistrations } from '../../src/indexer/reconcileRegistrations';
import { recheckExternalFees, recheckFeeAddresses } from '../../src/indexer/fee/externalFeeRecheck';
import { CONSENSUS_V2_ACTIVATION_TIME } from '../../src/indexer/consensusActivation';
import { setLocalOrderHiding } from '../../src/api/localHiding';
import { orderbookRoute } from '../../src/api/orderbook';
import { orderByPermlinkRoute, ordersByAccountRoute } from '../../src/api/orders';
import { eligibleFeaturedBidsSql } from '../../src/api/featuredVisibility';
import type { Poller } from '../../src/indexer/poller';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { fakeConfig, makeCtx, mockBlurt, unusedBlurt } from '../testutils/context';

const ACT = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
/** The block stamped at the activation time; 3 s per block. */
const B_ACT = 50_000;
const timeOf = (block: number): Date => new Date(ACT + (block - B_ACT) * 3_000);
/** An order block before / after the activation time. */
const PRE = B_ACT - 1_000;
const POST = B_ACT + 1_000;
/** The first pin, long before; the re-pin, after both order blocks. */
const PIN_1 = 10_000;
const RE_PIN = B_ACT + 5_000;

/** Node settings that must not matter from the activation time. */
interface Node {
	readonly name: string;
	readonly config: Partial<Config>;
	/** The BLURT base the poller holds when it applies the block. */
	readonly liveBase?: number;
}
const NODES: readonly Node[] = [
	{ name: 'default node, before the re-pin', config: {}, liveBase: 125 },
	{
		name: 'wide band, rebuilt after the re-pin',
		config: { feeTolerance: 0.5, feeBaseBlurt: 60 },
		liveBase: 200
	},
	{ name: 'no live pin, high env base', config: { feeTolerance: 0.3, feeBaseBlurt: 300 } },
	{ name: 'no live pin, low env base', config: { feeBaseBlurt: 60 } }
];

const d = INTEGRATION_ENABLED ? describe : describe.skip;

async function pin(
	fx: IntegrationFixture,
	block: number,
	treasury: Record<string, unknown>
): Promise<void> {
	await fx.db.query(
		`INSERT INTO releases (version, hash_manifest, endpoints, signature, source_block_num,
		                       source_trx_id, signer, valid, created_at, treasury)
		 VALUES ('1.22.0', '{}'::jsonb, '{}'::jsonb, '', $1, $2, 'morphit', true, $3, $4::jsonb)`,
		[block, `rel-${block}-${Math.random()}`, timeOf(block), JSON.stringify(treasury)]
	);
}

const BTC_ADDR = 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk';
const treasury = (blurtBase: number, sats: number) => ({
	btc: { address: BTC_ADDR, satoshis: sats },
	xmr: null,
	blurt: { base: blurtBase }
});
/** The chain's pins: base 125 / 400 sats in force for both order blocks, then
 *  a re-pin to base 200 / 300 sats after them. */
async function seedPins(fx: IntegrationFixture): Promise<void> {
	await pin(fx, PIN_1, treasury(125, 400));
	await pin(fx, RE_PIN, treasury(200, 300));
}

/** Run `handler` as the dispatcher would, read what it left, roll it back. */
async function judge<T>(
	fx: IntegrationFixture,
	handler: Handler,
	ctx: OpContext,
	read: (c: import('pg').PoolClient) => Promise<T>
): Promise<{ ok: boolean; reason?: string; seen: T | null }> {
	const c = await fx.pool.connect();
	try {
		await c.query(`SET search_path TO "${fx.schema}"`);
		await c.query('BEGIN');
		const r = await handler(ctx, c);
		const seen = r.ok ? await read(c) : null;
		await c.query('ROLLBACK');
		return { ...r, seen };
	} finally {
		c.release();
	}
}

const transfer = (from: string, to: string, blurt: number, memo: string): ChainOperation => [
	'transfer',
	{ from, to, amount: `${blurt.toFixed(3)} BLURT`, memo }
];

const blurtOrder = (permlink: string, extra: Record<string, unknown> = {}) => ({
	permlink,
	side: 'sell',
	asset: 'BLURT',
	fiat_currency: 'USD',
	amount_min: 10,
	amount_max: 100,
	price_model: { kind: 'spread', percent: 1 },
	payment_methods: ['cash'],
	...extra
});

d('fee verdicts use the federation’s numbers as of the block', () => {
	let fx: IntegrationFixture;
	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		await fx.db.query('DELETE FROM stranger_fees');
		await fx.db.query('DELETE FROM featured_slot_bids');
	});

	/** fee_status of a BLURT order paying `paid` (one leg, to the canonical
	 *  treasury, unless `opts.legs`) at `block`, as `node` stores it — or the
	 *  handler's refusal. */
	async function listingFee(
		node: Node,
		block: number,
		paid: number,
		opts: { legs?: ChainOperation[]; payload?: Record<string, unknown> } = {}
	): Promise<string | undefined> {
		const r = await judge(
			fx,
			orderHandler,
			makeCtx({
				signer: 'alice',
				blockNum: block,
				blockTime: timeOf(block),
				payload: opts.payload ?? blurtOrder('p1'),
				siblingOps: opts.legs ?? [transfer('alice', 'morphit-fees', paid, 'morphit-fee:p1')],
				config: fakeConfig({ feeRecipient: 'morphit-fees', ...node.config }),
				feeAmounts: node.liveBase === undefined ? {} : { blurtBase: node.liveBase }
			}),
			async (c) =>
				(
					await c.query<{ fee_status: string }>(
						`SELECT fee_status FROM orders WHERE account = 'alice' AND permlink = 'p1'`
					)
				).rows[0]?.fee_status
		);
		return r.ok ? (r.seen ?? undefined) : r.reason;
	}

	it('from the activation time every node stores the same listing-fee verdict: the pin at the block, the federation band', async () => {
		await seedPins(fx);
		// Floor: 125 (pinned at the block) × (1 − 15 %) = 106.25 BLURT.
		for (const node of NODES) {
			expect([node.name, await listingFee(node, POST, 100)]).toEqual([node.name, 'underpaid']);
			expect([node.name, await listingFee(node, POST, 110)]).toEqual([node.name, 'verified']);
		}
	});

	it('before the activation time each node keeps its old listing-fee verdict', async () => {
		await seedPins(fx);
		// The live pin (or env base) × (1 − max(node tolerance, 15 %)), as before.
		const old = await Promise.all(
			NODES.map(async (n) => [n.name, await listingFee(n, PRE, 100), await listingFee(n, PRE, 110)])
		);
		expect(old).toEqual([
			[NODES[0]!.name, 'underpaid', 'verified'], // 125 × 0.85 = 106.25
			[NODES[1]!.name, 'verified', 'verified'], // 200 × 0.5 = 100
			[NODES[2]!.name, 'underpaid', 'underpaid'], // 300 × 0.7 = 210
			[NODES[3]!.name, 'verified', 'verified'] // 60 × 0.85 = 51
		]);
	});

	it('a release in the order’s own block is not yet in force', async () => {
		await seedPins(fx);
		// A re-pin to 90 in the same block: 90 × 0.85 = 76.5 would pass 100.
		await pin(fx, POST, treasury(90, 400));
		for (const node of NODES) {
			expect([node.name, await listingFee(node, POST, 100)]).toEqual([node.name, 'underpaid']);
		}
	});

	it('with no BLURT base pinned, every node uses the shipped default 125, not its env base', async () => {
		// A pin with no BLURT block (BTC only) pins no base.
		await pin(fx, PIN_1, { btc: { address: BTC_ADDR, satoshis: 400 }, xmr: null });
		for (const node of NODES) {
			expect([node.name, await listingFee(node, POST, 100)]).toEqual([node.name, 'underpaid']);
			expect([node.name, await listingFee(node, POST, 110)]).toEqual([node.name, 'verified']);
		}
	});

	/** A stranger fee of `paid` BLURT (quoted as paid) at `block`, by tolerance. */
	async function strangerFee(
		feeTolerance: number,
		block: number,
		paid: number,
		opts: { legs?: ChainOperation[]; own?: string } = {}
	) {
		const r = await judge(
			fx,
			strangerFeeHandler,
			makeCtx({
				signer: 'sam',
				blockNum: block,
				blockTime: timeOf(block),
				trxId: `sf${block}${paid}`.padEnd(40, '0'),
				payload: { v: 1, recipient: 'rita', amount_blurt: paid },
				siblingOps: opts.legs ?? [transfer('sam', 'morphit-fees', paid, 'morphit-stranger:rita')],
				config: fakeConfig({ feeRecipient: opts.own ?? 'morphit-fees', feeTolerance })
			}),
			async (c) =>
				(await c.query(`SELECT 1 FROM stranger_fees WHERE sender = 'sam'`)).rowCount === 1
		);
		return r.ok ? 'applied' : r.reason;
	}

	it('stranger fees: the band is the federation’s from the activation time, the node’s before', async () => {
		// The first-contact price is 5 BLURT; 4.5 is 10 % short.
		for (const t of [0.001, 0.2, 0.5]) {
			expect([t, await strangerFee(t, POST, 4.5)]).toEqual([t, 'amount_blurt_below_current_quote']);
			expect([t, await strangerFee(t, POST, 5)]).toEqual([t, 'applied']);
		}
		expect(await strangerFee(0.001, PRE, 4.5)).toBe('amount_blurt_below_current_quote');
		expect(await strangerFee(0.2, PRE, 4.5)).toBe('applied');
	});

	/** A 6-hour feature bid (50 BLURT/hour → 300) paying `paid` at `block`. */
	async function featureBid(
		feeTolerance: number,
		block: number,
		paid: number,
		opts: { price?: number; legs?: ChainOperation[]; own?: string } = {}
	) {
		await fx.db.query(`DELETE FROM orders`);
		await fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                     status, created_at, updated_at, fee_status, fee_method)
			 VALUES ('bea', 'o1', 'sell', 'BLURT', 'USD', '{"kind":"spread","percent":0}'::jsonb, ARRAY['cash'],
			         'live', $1, $1, 'verified', 'blurt')`,
			[timeOf(block - 10)]
		);
		const r = await judge(
			fx,
			featureBidHandler,
			makeCtx({
				signer: 'bea',
				blockNum: block,
				blockTime: timeOf(block),
				trxId: `fb${block}${paid}`.padEnd(40, '0'),
				payload: { order_permlink: 'o1', hours_requested: 6 },
				siblingOps: opts.legs ?? [transfer('bea', 'morphit-fees', paid, 'morphit-feature:o1')],
				config: fakeConfig({
					feeRecipient: opts.own ?? 'morphit-fees',
					featureFeeBlurtPerHour: opts.price ?? 50,
					feeTolerance
				})
			}),
			async (c) =>
				(await c.query(`SELECT 1 FROM featured_slot_bids WHERE bidder = 'bea'`)).rowCount === 1
		);
		return r.ok ? 'applied' : r.reason;
	}

	it('feature bids: the band is the federation’s from the activation time, the node’s before', async () => {
		for (const t of [0.001, 0.5]) {
			expect([t, await featureBid(t, POST, 200)]).toEqual([t, 'fee_underpaid']);
			expect([t, await featureBid(t, POST, 300)]).toEqual([t, 'applied']);
		}
		expect(await featureBid(0.001, PRE, 200)).toBe('fee_underpaid');
		expect(await featureBid(0.5, PRE, 200)).toBe('applied');
	});

	it('feature bids: from the activation time one federation price (50 BLURT/hour), the node’s before', async () => {
		// 6 hours: 300 BLURT at the federation price, whatever the node charges.
		for (const price of [10, 50, 80]) {
			expect([price, await featureBid(0.001, POST, 300, { price })]).toEqual([price, 'applied']);
			expect([price, await featureBid(0.001, POST, 290, { price })]).toEqual([
				price,
				'fee_underpaid'
			]);
		}
		expect(await featureBid(0.001, PRE, 300, { price: 80 })).toBe('fee_underpaid');
		expect(await featureBid(0.001, PRE, 60, { price: 10 })).toBe('applied');
	});

	/** Operators' fees accounts on chain: opa's `a-fees` long before both
	 *  order blocks; then, AFTER the post-activation block, opa re-registers
	 *  `a-fees2` and opb registers `b-fees`. Nobody registered `zed-fees`. */
	async function seedFeeAccounts(): Promise<void> {
		await fx.db.query('DELETE FROM operator_fee_recipients');
		for (const [account, recipient, block] of [
			['opa', 'a-fees', PIN_1 + 10],
			['opa', 'a-fees2', POST + 50],
			['opb', 'b-fees', POST + 100]
		] as const) {
			await fx.db.query(
				`INSERT INTO operator_fee_recipients (account, fee_recipient, effective_block, effective_trx)
				 VALUES ($1, $2, $3, $4)`,
				[account, recipient, block, `${account}-${block}`]
			);
		}
	}
	/** The 90 / 10 legs of `total` BLURT, the 90 % to `owner`. */
	const split = (from: string, owner: string, total: number, memo: string): ChainOperation[] => [
		transfer(from, owner, total * 0.9, memo),
		transfer(from, 'morphit-fees', total * 0.1, memo)
	];

	it('listing fee payee: from the activation time any operator’s account registered before the block, on every node; never a node’s own unregistered one', async () => {
		await seedPins(fx);
		await seedFeeAccounts();
		const nodes: Node[] = [
			{ name: 'canonical node', config: {} },
			{ name: 'node whose own account is zed-fees', config: { feeRecipient: 'zed-fees' } },
			{ name: 'node whose own account is a-fees', config: { feeRecipient: 'a-fees' } }
		];
		const verdicts = async (block: number, owner: string) =>
			Promise.all(
				nodes.map((n) =>
					listingFee(n, block, 130, { legs: split('alice', owner, 130, 'morphit-fee:p1') })
				)
			);
		// No operator_tag on the order: the payee set is not the tag's any more.
		expect(await verdicts(POST, 'a-fees')).toEqual(['verified', 'verified', 'verified']);
		// Registered only after the block (b-fees, and opa's new a-fees2).
		expect(await verdicts(POST, 'b-fees')).toEqual(['underpaid', 'underpaid', 'underpaid']);
		expect(await verdicts(POST, 'a-fees2')).toEqual(['underpaid', 'underpaid', 'underpaid']);
		// A node's own, never-registered account counts nowhere, not even there.
		expect(await verdicts(POST, 'zed-fees')).toEqual(['underpaid', 'underpaid', 'underpaid']);
		// Before: each node's own account counted there (and an untagged order
		// paid to a registered account only on that account's own node).
		expect(await verdicts(PRE, 'zed-fees')).toEqual(['underpaid', 'verified', 'underpaid']);
		expect(await verdicts(PRE, 'a-fees')).toEqual(['underpaid', 'underpaid', 'verified']);
	});

	it('stranger fee payee: the same chain-derived set from the activation time', async () => {
		await seedFeeAccounts();
		const fee = (block: number, owner: string, own: string) =>
			strangerFee(0.001, block, 5, { own, legs: split('sam', owner, 5, 'morphit-stranger:rita') });
		for (const own of ['morphit-fees', 'zed-fees']) {
			expect([own, await fee(POST, 'a-fees', own)]).toEqual([own, 'applied']);
			expect([own, await fee(POST, 'zed-fees', own)]).toEqual([own, 'fee_underpaid']);
			expect([own, await fee(POST, 'b-fees', own)]).toEqual([own, 'fee_underpaid']);
		}
		expect(await fee(PRE, 'zed-fees', 'zed-fees')).toBe('applied');
		expect(await fee(PRE, 'zed-fees', 'morphit-fees')).toBe('fee_underpaid');
	});

	it('feature bid payee: the same chain-derived set from the activation time, the node’s own before', async () => {
		await seedFeeAccounts();
		const bid = (block: number, owner: string, own: string) =>
			featureBid(0.001, block, 300, { own, legs: split('bea', owner, 300, 'morphit-feature:o1') });
		for (const own of ['morphit-fees', 'a-fees', 'zed-fees']) {
			expect([own, await bid(POST, 'a-fees', own)]).toEqual([own, 'applied']);
			expect([own, await bid(POST, 'zed-fees', own)]).toEqual([own, 'fee_underpaid']);
		}
		expect(await bid(PRE, 'a-fees', 'a-fees')).toBe('applied');
		expect(await bid(PRE, 'a-fees', 'morphit-fees')).toBe('fee_underpaid');
	});

	it('disabled assets / payment methods: from the activation time the order is stored on every node', async () => {
		await seedPins(fx);
		const switchedOff: Node = {
			name: 'node that switched off DOGE and cash',
			config: { disabledAssets: ['DOGE'], disabledPaymentMethods: ['cash'] }
		};
		const plain: Node = { name: 'plain node', config: {} };
		const doge = { payload: blurtOrder('p1', { asset: 'DOGE' }) };
		for (const node of [switchedOff, plain]) {
			expect([node.name, await listingFee(node, POST, 130, doge)]).toEqual([node.name, 'verified']);
			expect([node.name, await listingFee(node, POST, 130)]).toEqual([node.name, 'verified']);
		}
		// Before: refused on the node that switched them off, as it always was.
		expect(await listingFee(switchedOff, PRE, 130, doge)).toBe('asset_disabled_on_instance');
		expect(await listingFee(switchedOff, PRE, 130)).toBe('payment_methods_all_disabled');
		expect(await listingFee(plain, PRE, 130, doge)).toBe('verified');
	});

	/** The amounts a stub verifier was asked for. */
	function askingVerifier(asked: (number | bigint)[]): FeeVerifier {
		return {
			name: 'stub',
			verify: async (claim: FeeClaim) => {
				asked.push(claim.expectedAmount);
				return { kind: 'pending_external', reason: 'stub' };
			},
			checkAddressPayment: async (_address: string, expectedSats: number) => {
				asked.push(expectedSats);
				return { kind: 'not_yet', confirmedSats: 0, unconfirmedSats: 0 };
			}
		} as unknown as FeeVerifier;
	}

	/** A BTC txid order at `block`, through the order handler, on a node that
	 *  checks BTC (`verifier`) or not, holding `liveSats` now. */
	async function btcIntake(block: number, liveSats: number | undefined, verifier = true) {
		const r = await judge(
			fx,
			orderHandler,
			makeCtx({
				signer: 'bob',
				blockNum: block,
				blockTime: timeOf(block),
				payload: blurtOrder('b1', {
					asset: 'BTC',
					amount_min: 100,
					amount_max: 1000,
					fee_method: 'btc',
					external_tx_id: 'de'.repeat(32)
				}),
				config: fakeConfig({ feeRecipient: 'morphit-fees' }),
				feeVerifiers: verifier ? { btc: askingVerifier([]) } : {},
				feeAmounts: liveSats === undefined ? {} : { btcSatoshis: liveSats }
			}),
			async (c) =>
				(
					await c.query<{ fee_status: string }>(
						`SELECT fee_status FROM orders WHERE account = 'bob' AND permlink = 'b1'`
					)
				).rows[0]?.fee_status
		);
		return r.ok ? r.seen : r.reason;
	}

	it('BTC intake: from the activation time accepted on every node, by the pin at the block, whether or not the node checks BTC', async () => {
		await pin(fx, PIN_1, treasury(125, 400));
		for (const [live, verifier] of [
			[undefined, false],
			[undefined, true],
			[300, false],
			[300, true]
		] as const) {
			expect([live, verifier, await btcIntake(POST, live, verifier)]).toEqual([
				live,
				verifier,
				'pending_external'
			]);
		}
		// Before: this node's verifier and current amount decide, as they always did.
		expect(await btcIntake(PRE, 300, false)).toBe('fee_method_not_configured_btc');
		expect(await btcIntake(PRE, undefined, true)).toBe('fee_amount_not_configured_btc');
		expect(await btcIntake(PRE, 300, true)).toBe('pending_external');
	});

	it('BTC intake: with no BTC amount pinned at the block, refused on every node alike', async () => {
		// Pinned only after the order's block (and a BLURT-only pin before it).
		await pin(fx, PIN_1, { btc: null, xmr: null, blurt: { base: 125 } });
		await pin(fx, RE_PIN, treasury(200, 300));
		for (const [live, verifier] of [
			[undefined, false],
			[300, true]
		] as const) {
			expect(await btcIntake(POST, live, verifier)).toBe('fee_amount_not_pinned_btc');
		}
		// Before: a node with a verifier and a current amount took it.
		expect(await btcIntake(PRE, 300, true)).toBe('pending_external');
	});

	/** A pending BTC txid order posted at `block`. */
	async function pendingBtc(permlink: string, block: number): Promise<void> {
		await fx.db.query(
			`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
			                     status, created_at, updated_at, fee_status, fee_method, external_tx_id)
			 VALUES ('bob', $1, 'sell', 'BTC', 'USD', '{"kind":"spread","percent":0}'::jsonb, ARRAY['cash'],
			         'live', $2, $2, 'pending_external', 'btc', $3)`,
			[permlink, timeOf(block), permlink.padEnd(64, '0')]
		);
	}

	/** The amount the re-check asks the explorers for, for the one order. */
	async function recheckAsks(liveSats: number): Promise<(number | bigint)[]> {
		await fx.db.query(`UPDATE orders SET fee_rechecked_at = NULL`);
		const asked: (number | bigint)[] = [];
		await recheckExternalFees({
			db: fx.db,
			verifiers: { btc: askingVerifier(asked) },
			amounts: { btcSatoshis: liveSats },
			now: new Date(ACT + 3 * 86_400_000),
			freshOnly: true
		});
		return asked;
	}

	it('BTC re-check: from the activation time it asks for the pin at the order’s block, on every node', async () => {
		await seedPins(fx);
		await pendingBtc('post1', POST);
		// Nodes holding 300 (saw the re-pin) or 500 (some other later pin)
		// both ask 400, the amount in force when the order was posted.
		expect(await recheckAsks(300)).toEqual([400]);
		expect(await recheckAsks(500)).toEqual([400]);
	});

	it('BTC re-check: before the activation time it still asks the lower of today’s pin and the pin at posting', async () => {
		await seedPins(fx);
		await pendingBtc('pre1', PRE);
		expect(await recheckAsks(300)).toEqual([300]);
		expect(await recheckAsks(500)).toEqual([400]);
	});

	it('BTC re-check: never a later pin — with none at the order’s block nothing is asked', async () => {
		await pin(fx, RE_PIN, treasury(200, 300));
		await pendingBtc('post2', POST);
		expect(await recheckAsks(300)).toEqual([]);
	});

	it('BTC re-check: a release in the order’s own block is not yet in force', async () => {
		await seedPins(fx);
		await pin(fx, POST, treasury(125, 350));
		await pendingBtc('post3', POST);
		expect(await recheckAsks(300)).toEqual([400]);
	});

	it('a node that does not check BTC leaves the order pending: no explorer asked, never on its book', async () => {
		await seedPins(fx);
		await pendingBtc('post4', POST);
		const r = await recheckExternalFees({
			db: fx.db,
			verifiers: {},
			amounts: {},
			now: new Date(ACT + 3 * 86_400_000)
		});
		expect(r).toEqual({ checked: 0, changed: 0 });
		const row = await fx.db.query<{ fee_status: string; fee_rechecked_at: Date | null }>(
			`SELECT fee_status, fee_rechecked_at FROM orders WHERE permlink = 'post4'`
		);
		expect(row.rows).toEqual([{ fee_status: 'pending_external', fee_rechecked_at: null }]);
	});

	it('BTC per-order address: from the activation time the amount quoted at posting, not today’s pin', async () => {
		for (const [permlink, block] of [
			['a-post', POST],
			['a-pre', PRE]
		] as const) {
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status, fee_method,
				                     btc_fee_xpub, btc_fee_index, btc_fee_address, btc_fee_sats)
				 VALUES ('bob', $1, 'sell', 'BTC', 'USD', '{"kind":"spread","percent":0}'::jsonb, ARRAY['cash'],
				         'live', $2, $2, 'awaiting_payment', 'btc', 'xpub-x', $3, $4, 400)`,
				[permlink, timeOf(block), block === POST ? 0 : 1, `bc1q${permlink}`]
			);
		}
		const asked: (number | bigint)[] = [];
		await recheckFeeAddresses({
			db: fx.db,
			verifiers: { btc: askingVerifier(asked) },
			amounts: { btcSatoshis: 300 },
			now: new Date(ACT + 3 * 86_400_000)
		});
		// Rows are checked newest first: the post-activation one asks 400, the
		// older one the lower of 400 and today's 300, as before.
		expect(asked).toEqual([400, 300]);
	});
});

/**
 * Intake equals re-derivation. The BLURT re-verifier re-judges an order this
 * node stored `underpaid` before it knew the operator's fees account (G1); it
 * must reach the verdict a node that knew the account reached at intake —
 * whatever each node's tolerance and live pin.
 */
d('the BLURT re-verifier reaches the intake verdict', () => {
	let knew: IntegrationFixture;
	let late: IntegrationFixture;
	let chain: Map<number, BlockHeader>;
	const REG = PIN_1 + 100;

	beforeAll(async () => {
		knew = await setupWithMigrations();
		late = await setupWithMigrations();
	});
	afterAll(async () => {
		await knew.teardown();
		await late.teardown();
	});
	beforeEach(async () => {
		chain = new Map();
		for (const fx of [knew, late]) {
			await truncateAll(fx);
			for (const t of ['operators', 'operator_fee_recipients', 'fee_reverify_done']) {
				await fx.db.query(`DELETE FROM ${t}`);
			}
			await seedPins(fx);
			// Operator B (tag b-node) registered its fees account b-fees.
			await fx.db.query(
				`INSERT INTO operators (account, tag, display_name, registered_in_block, last_action_block_num)
				 VALUES ('bop', 'b-node', 'B', $1, $1)`,
				[REG - 50]
			);
			await fx.db.query(
				`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
				 VALUES ($1, 0, 0, $2, 'bbbb000000000000000000000000000000000001', 'bop', 'morphit_operator_register_v1',
				         '{"v":1,"tag":"b-node","display_name":"B","fee_recipient":"b-fees"}'::jsonb, 'applied')`,
				[REG, timeOf(REG)]
			);
		}
	});

	const reconcile = (fx: IntegrationFixture, config: Config) =>
		reconcileOperatorRegistrations({
			db: fx.db,
			blurt: unusedBlurt(),
			config,
			feeVerifiers: {},
			feeAmounts: {},
			fiatToUsd: (a) => a
		});

	/** Index alice's order at `block` paying `total` through B (90/10) on `fx`. */
	async function indexOrder(
		fx: IntegrationFixture,
		block: number,
		permlink: string,
		total: number,
		config: Config,
		liveBase: number,
		tag = 'b-node',
		owner = 'b-fees'
	): Promise<void> {
		const payload = blurtOrder(permlink, { operator_tag: tag });
		const memo = `morphit-fee:${permlink}`;
		const operations: ChainOperation[] = [
			[
				'custom_json',
				{
					required_auths: ['alice'],
					required_posting_auths: [],
					id: 'morphit_order_v1',
					json: JSON.stringify(payload)
				}
			],
			transfer('alice', owner, total * 0.9, memo),
			transfer('alice', 'morphit-fees', total * 0.1, memo)
		];
		const trx: BlockTransaction = {
			ref_block_num: block & 0xffff,
			ref_block_prefix: 12345,
			expiration: timeOf(block + 20)
				.toISOString()
				.slice(0, 19),
			operations,
			signatures: []
		};
		const trxId = transactionIdOf({ ...trx, extensions: [] })!;
		chain.set(block, {
			timestamp: timeOf(block).toISOString().slice(0, 19),
			transactions: [trx],
			transaction_ids: [trxId]
		});
		await fx.db.withTx(async (c) => {
			const r = await orderHandler(
				makeCtx({
					signer: 'alice',
					blockNum: block,
					trxInBlock: 0,
					opInTrx: 0,
					trxId,
					blockTime: timeOf(block),
					payload,
					siblingOps: operations,
					config,
					feeAmounts: { blurtBase: liveBase }
				}),
				c
			);
			expect(r.ok).toBe(true);
			await c.query(
				`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
				 VALUES ($1, 0, 0, $2, $3, 'alice', 'morphit_order_v1', $4::jsonb, 'applied')`,
				[block, timeOf(block), trxId, JSON.stringify(payload)]
			);
		});
	}

	const feeStatus = async (fx: IntegrationFixture, permlink: string) =>
		(
			await fx.db.query<{ fee_status: string }>(
				`SELECT fee_status FROM orders WHERE account = 'alice' AND permlink = $1`,
				[permlink]
			)
		).rows[0]?.fee_status;

	it('from the activation time: same verdict at intake (node that knew) and on re-check (node that learnt late)', async () => {
		// The node that knew B's account indexed the blocks after the re-pin
		// (its live base is 200) with the default band.
		const knewCfg = fakeConfig({ feeRecipient: 'morphit-fees' });
		await reconcile(knew, knewCfg);
		// The late node runs a wide band and a low env base.
		const lateCfg = fakeConfig({
			feeRecipient: 'morphit-fees',
			feeTolerance: 0.5,
			feeBaseBlurt: 60
		});
		const cases: [string, number, number][] = [
			['short', POST, 100], // under 125 × 0.85 = 106.25
			['paid', POST + 1, 110]
		];
		for (const [permlink, block, total] of cases) {
			await indexOrder(knew, block, permlink, total, knewCfg, 200);
			await indexOrder(late, block, permlink, total, lateCfg, 200);
			// Not knowing b-fees, the late node saw only the 10 % leg.
			expect(await feeStatus(late, permlink)).toBe('underpaid');
		}
		await reconcile(late, lateCfg);
		const rv = new BlurtFeeReverifier({
			db: late.db,
			blurt: mockBlurt({ getBlock: async (n: number) => chain.get(n) ?? null }),
			config: lateCfg
		});
		const s = await rv.runOnce();
		expect(s.orders.checked).toBe(2);
		const verdicts = async (fx: IntegrationFixture) =>
			Promise.all(cases.map(async ([p]) => [p, await feeStatus(fx, p)]));
		expect(await verdicts(knew)).toEqual([
			['short', 'underpaid'],
			['paid', 'verified']
		]);
		expect(await verdicts(late)).toEqual(await verdicts(knew));
	});

	it('from the activation time no legacy grace: an account registered after the order does not pay for it on re-check either', async () => {
		// Operator C registers its fees account c-fees only AFTER alice's order.
		const cfg = fakeConfig({ feeRecipient: 'morphit-fees' });
		await late.db.query(
			`INSERT INTO operators (account, tag, display_name, registered_in_block, last_action_block_num)
			 VALUES ('cop', 'c-node', 'C', $1, $1)`,
			[POST + 500]
		);
		await indexOrder(late, POST + 10, 'via-c', 130, cfg, 125, 'c-node', 'c-fees');
		await indexOrder(late, PRE + 10, 'old-via-c', 130, cfg, 125, 'c-node', 'c-fees');
		await late.db.query(
			`INSERT INTO ops (block_num, trx_in_block, op_in_trx, block_time, trx_id, signer, op_id, payload, status)
			 VALUES ($1, 0, 0, $2, 'cccc000000000000000000000000000000000001', 'cop', 'morphit_operator_register_v1',
			         '{"v":1,"tag":"c-node","display_name":"C","fee_recipient":"c-fees"}'::jsonb, 'applied')`,
			[POST + 500, timeOf(POST + 500)]
		);
		await reconcile(late, cfg);
		const rv = new BlurtFeeReverifier({
			db: late.db,
			blurt: mockBlurt({ getBlock: async (n: number) => chain.get(n) ?? null }),
			config: cfg
		});
		await rv.runOnce();
		// Intake could not know c-fees, so the re-check must not use it…
		expect(await feeStatus(late, 'via-c')).toBe('underpaid');
		// …while an order before the activation time keeps the v1.20 grace.
		expect(await feeStatus(late, 'old-via-c')).toBe('verified');
	});
});

/**
 * From the activation time an order of an asset / payment methods an instance
 * switched off is stored there too; the instance hides it from what it shows
 * (api/localHiding.ts), as before when the row did not exist.
 */
d('an instance hides the orders it switched off from its own listings', () => {
	let fx: IntegrationFixture;
	const poller = { getStatus: () => ({ indexedBlock: 1 }) } as unknown as Poller;
	beforeAll(async () => {
		fx = await setupWithMigrations();
		const at = timeOf(POST);
		for (const [account, asset, methods] of [
			['alice', 'DOGE', ['cash_in_person']],
			['bob', 'BTC', ['paypal']],
			['carol', 'BTC', ['paypal', 'cash_in_person']]
		] as const) {
			await fx.db.query(
				`INSERT INTO orders (account, permlink, side, asset, fiat_currency, price_model, payment_methods,
				                     status, created_at, updated_at, fee_status, fee_method)
				 VALUES ($1, 'o1', 'sell', $2, 'USD', '{"kind":"spread","percent":0}'::jsonb, $3,
				         'live', $4, $4, 'verified', 'blurt')`,
				[account, asset, methods, at]
			);
			await fx.db.query(
				`INSERT INTO featured_slot_bids (bidder, order_permlink, hours_requested, blurt_paid, blurt_per_hour,
				                                 effective_at, expires_at, trx_id, block_num, block_time_at)
				 VALUES ($1, 'o1', 6, 300, 50, NOW() - INTERVAL '1 hour', NOW() + INTERVAL '5 hours', $2, 1, NOW())`,
				[account, `bid-${account}`.padEnd(40, '0')]
			);
		}
	});
	afterAll(async () => {
		setLocalOrderHiding({ disabledAssets: [], disabledPaymentMethods: [] });
		await fx.teardown();
	});

	async function shown(): Promise<Record<string, string[]>> {
		const book = (await (await orderbookRoute(fx.db, poller, 'morphit').request('/')).json()) as {
			items: { account: string }[];
		};
		const featured = await fx.db.query<{ bidder: string }>(
			`SELECT bidder FROM (${eligibleFeaturedBidsSql('$1')}) b ORDER BY bidder`,
			['morphit']
		);
		const pages: string[] = [];
		const lists: string[] = [];
		for (const a of ['alice', 'bob', 'carol']) {
			const one = await orderByPermlinkRoute(fx.db, 'morphit').request(`/${a}/o1`);
			if (one.status === 200) pages.push(a);
			const list = (await (
				await ordersByAccountRoute(fx.db, 'morphit').request(`/${a}`)
			).json()) as {
				items: unknown[];
			};
			if (list.items.length > 0) lists.push(a);
		}
		return {
			orderbook: book.items.map((i) => i.account).sort(),
			featured: featured.rows.map((r) => r.bidder),
			pages,
			lists
		};
	}

	it('hides an asset it switched off, and an order whose every method it switched off', async () => {
		setLocalOrderHiding({ disabledAssets: ['doge'], disabledPaymentMethods: ['PayPal'] });
		const only = ['carol'];
		expect(await shown()).toEqual({ orderbook: only, featured: only, pages: only, lists: only });
	});

	it('shows everything when it switched nothing off', async () => {
		setLocalOrderHiding({ disabledAssets: [], disabledPaymentMethods: [] });
		const all = ['alice', 'bob', 'carol'];
		expect(await shown()).toEqual({ orderbook: all, featured: all, pages: all, lists: all });
	});
});
