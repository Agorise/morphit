/**
 * v1.21.8 — the Operators page shows, for EVERY operator, how many orders came
 * through its site and what it has earned since inception, the same on every
 * node.
 *
 * Before: /v1/operators read operator_earnings, which only the operator's own
 * indexer filled (gated on its own tag, listing fees only, from the version
 * that added it), so every other operator showed no stats anywhere.
 *
 * Real dispatcher (applyBlock), real handlers, real Postgres, real
 * /v1/operators route; the back-fill re-fetches blocks from a fake chain whose
 * transactions carry their real ids.
 */
import type pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { applyBlock } from '../../src/indexer/dispatcher';
import { operatorsRoute } from '../../src/api/operators';
import { OperatorStatsRefresher, refreshOperatorStats } from '../../src/indexer/operatorStats';
import { Poller } from '../../src/indexer/poller';
import { loadConfig } from '../../src/config/index';
import {
	BACKLOG_INTERVAL_MS,
	FeeLegsBackfill,
	FETCH_FAILURES_PER_BLOCK,
	GIVEN_UP_RETRY_MS
} from '../../src/indexer/feeLegsBackfill';
import { transactionIdOf } from '../../src/blurt/snapshotOpTrust';
import type { BlockTransaction, ChainOperation } from '../../src/blurt/client';
import {
	INTEGRATION_ENABLED,
	setupWithMigrations,
	truncateAll,
	type IntegrationFixture
} from './harness';
import { fakeConfig, mockBlurt } from '../testutils/context';

const T = 'morphit-fees';
const REG = 1_999_900;
const BASE = 2_000_000;
/** beta publishes its first fees account AFTER its orders (legacy grace). */
const BETA_REG = BASE + 50;
const timeOf = (block: number): Date => new Date(Date.UTC(2026, 5, 1) + (block - REG) * 3_000);

type Trx = ChainOperation[];
const cj = (signer: string, id: string, json: unknown, rawJson?: string): ChainOperation => [
	'custom_json',
	{
		required_auths: [signer],
		required_posting_auths: [],
		id,
		json: rawJson ?? JSON.stringify(json)
	}
];
const xfer = (from: string, to: string, amount: string, memo: string): ChainOperation => [
	'transfer',
	{ from, to, amount, memo }
];
const orderPayload = (permlink: string, tag: string) => ({
	permlink,
	side: 'sell',
	asset: 'BTC',
	fiat_currency: 'USD',
	amount_min: 10,
	amount_max: 100,
	price_model: { kind: 'spread', percent: 1 },
	payment_methods: ['cash_in_person'],
	operator_tag: tag
});
/** An order paying `legs` (to, amount), with memo morphit-fee:<permlink>. */
const order = (who: string, permlink: string, tag: string, legs: [string, string][]): Trx => [
	...legs.map(([to, a]) => xfer(who, to, a, `morphit-fee:${permlink}`)),
	cj(who, 'morphit_order_v1', orderPayload(permlink, tag))
];

/** The chain, block by block: the transactions as served, with real ids. */
function buildChain(): Map<
	number,
	{ timestamp: string; transactions: BlockTransaction[]; transaction_ids: string[] }
> {
	const blocks: [number, Trx[]][] = [
		[
			BASE + 1,
			[
				// morphit.io: one 100 % leg to the treasury (its fees account IS it).
				order('carol', 'carol-o', 'morphit.io', [[T, '62.500 BLURT']]),
				// alpha's site: the 90/10 split. alpha earns the 90 %; the 10 %
				// treasury leg credits nobody (not morphit.io).
				order('dave', 'dave-o', 'alpha', [
					['alpha-fees', '56.250 BLURT'],
					[T, '6.250 BLURT']
				]),
				// beta's site, before beta ever published a fees account: stored
				// underpaid here, but the BLURT reached beta-fees.
				order('erin', 'erin-o', 'beta', [
					['beta-fees', '56.250 BLURT'],
					[T, '6.250 BLURT']
				]),
				// gamma left its fees account blank: it resolved to the treasury.
				order('gina', 'gina-o', 'gamma', [[T, '62.500 BLURT']]),
				// epsilon, block BASE+1: its change in this very block is not in
				// force yet (strict as-of-block): eps-1 is.
				order('ivan', 'ivan-o', 'epsilon', [
					['eps-1', '56.250 BLURT'],
					[T, '6.250 BLURT']
				]),
				// …and eps-2, registered in this block, does not count yet.
				order('mia', 'mia-o', 'epsilon', [
					['eps-2', '56.250 BLURT'],
					[T, '6.250 BLURT']
				])
			]
		],
		[
			BASE + 2,
			[
				// Underpaid through alpha: not an order that came through (hidden),
				// but the 9 BLURT did reach alpha-fees, with the treasury's 10 %.
				order('fred', 'fred-o', 'alpha', [
					['alpha-fees', '9.000 BLURT'],
					[T, '1.000 BLURT']
				]),
				// BLURT sent round in a circle (no treasury share): a refused op
				// naming alpha with 1,000,000 BLURT to alpha-fees. Credits nobody —
				// every fee must pay the treasury its 10 %, as every handler checks.
				[
					xfer('sock', 'alpha-fees', '1000000.000 BLURT', 'morphit-fee:x'),
					cj('sock', 'morphit_order_v1', { permlink: 'x', operator_tag: 'alpha' })
				],
				// …and one that pays the treasury slightly less than its 10 %.
				order('sock', 'sock-o', 'alpha', [
					['alpha-fees', '91.000 BLURT'],
					[T, '9.000 BLURT']
				]),
				// alpha's own account posting on its own site: it cannot pay itself,
				// so one 100 % treasury leg — earned by nobody. The order counts.
				order('alpha-fees', 'af-o', 'alpha', [[T, '62.500 BLURT']]),
				// A first-contact fee through alpha.
				[
					xfer('hank', 'alpha-fees', '4.500 BLURT', 'morphit-stranger:zoe'),
					xfer('hank', T, '0.500 BLURT', 'morphit-stranger:zoe'),
					// A decoy: same payer, same recipient, another memo.
					xfer('hank', 'alpha-fees', '999.000 BLURT', 'thanks'),
					// Another account's transfer with the same memo is not hank's fee.
					xfer('zoe-friend', 'alpha-fees', '50.000 BLURT', 'morphit-stranger:zoe'),
					cj('hank', 'morphit_stranger_fee_v1', { recipient: 'zoe', operator_tag: 'alpha' })
				],
				// epsilon, block BASE+2: eps-2 is in force; eps-1 and eps-mid (the
				// account it registered first in that block) no longer count.
				order('judy', 'judy-o', 'epsilon', [
					['eps-2', '56.250 BLURT'],
					[T, '6.250 BLURT']
				]),
				order('kim', 'kim-o', 'epsilon', [
					['eps-1', '27.000 BLURT'],
					[T, '3.000 BLURT']
				]),
				order('liz', 'liz-o', 'epsilon', [
					['eps-mid', '45.000 BLURT'],
					[T, '5.000 BLURT']
				]),
				// A fee paid to an account nobody had registered yet, naming beta.
				order('olga', 'olga-o', 'beta', [
					['omega-fees', '56.250 BLURT'],
					[T, '6.250 BLURT']
				]),
				// A fee naming delta, paid to the account delta shares with alpha:
				// delta's, though alpha registered that account first.
				order('nina', 'nina-o', 'delta', [
					['alpha-fees', '56.250 BLURT'],
					[T, '6.250 BLURT']
				]),
				// Text Postgres cannot store (a NUL) in the memo and the payload: the
				// op is refused, and both sides are recorded as the dispatcher stores
				// them (U+FFFD), live and back-filled alike.
				[
					xfer('nul', 'alpha-fees', '9.000 BLURT', 'morphit-fee:n\u0000l'),
					xfer('nul', T, '1.000 BLURT', 'morphit-fee:n\u0000l'),
					cj('nul', 'morphit_order_v1', null, '{"permlink":"n\\u0000l","operator_tag":"alpha"}')
				],
				// 20 transfers carrying one fee's memo: only the first 16 are kept.
				[
					...Array.from({ length: 20 }, () => xfer('many', T, '1.000 BLURT', 'morphit-fee:many-o')),
					cj('many', 'morphit_order_v1', orderPayload('many-o', 'alpha'))
				],
				// An op the dispatcher rejects before any handler (malformed JSON):
				// recorded with no legs, so the back-fill never re-fetches it.
				[
					xfer('mal', 'alpha-fees', '5.000 BLURT', 'morphit-fee:mal-o'),
					cj('mal', 'morphit_order_v1', null, '{not json')
				]
			]
		],
		[
			BASE + 3,
			[
				// Featured-slot bids name no operator: the featured order's tag (from
				// its order op) stands in, whatever the bid's own payload says.
				[
					xfer('dave', 'alpha-fees', '270.000 BLURT', 'morphit-feature:dave-o'),
					xfer('dave', T, '30.000 BLURT', 'morphit-feature:dave-o'),
					cj('dave', 'morphit_feature_bid_v1', {
						order_permlink: 'dave-o',
						hours_requested: 6,
						operator_tag: 'gamma'
					})
				],
				[
					xfer('carol', T, '300.000 BLURT', 'morphit-feature:carol-o'),
					cj('carol', 'morphit_feature_bid_v1', { order_permlink: 'carol-o', hours_requested: 6 })
				],
				// carol bids again for her morphit.io order, this time through
				// alpha's site (90/10): alpha earns the 90 %, and the 10 % treasury
				// leg is NOT morphit.io's, though the order names morphit.io.
				[
					xfer('carol', 'alpha-fees', '270.000 BLURT', 'morphit-feature:carol-o'),
					xfer('carol', T, '30.000 BLURT', 'morphit-feature:carol-o'),
					cj('carol', 'morphit_feature_bid_v1', { order_permlink: 'carol-o', hours_requested: 6 })
				]
			]
		]
	];
	return chainOf(blocks);
}

/** A chain of these blocks, each transaction with its real id. */
function chainOf(
	blocks: [number, Trx[]][]
): Map<number, { timestamp: string; transactions: BlockTransaction[]; transaction_ids: string[] }> {
	const chain = new Map<
		number,
		{ timestamp: string; transactions: BlockTransaction[]; transaction_ids: string[] }
	>();
	for (const [n, trxs] of blocks) {
		const transactions: BlockTransaction[] = trxs.map((operations, i) => ({
			ref_block_num: (n + i) & 0xffff,
			ref_block_prefix: 4242 + i,
			expiration: timeOf(n + 20)
				.toISOString()
				.slice(0, 19),
			operations,
			signatures: []
		}));
		chain.set(n, {
			timestamp: timeOf(n).toISOString().slice(0, 19),
			transactions,
			transaction_ids: transactions.map((t) => transactionIdOf({ ...t, extensions: [] })!)
		});
	}
	return chain;
}

interface Wire {
	account: string;
	tag: string;
	fee_account: string | null;
	stats?: { cumulative_blurt_earned: number; total_orders_attributed: number };
}

const d = INTEGRATION_ENABLED ? describe : describe.skip;

d("v1.21.8 — every operator's orders and earnings on /v1/operators", () => {
	let fx: IntegrationFixture;

	beforeAll(async () => {
		fx = await setupWithMigrations();
	});
	afterAll(async () => {
		await fx.teardown();
	});
	beforeEach(async () => {
		await truncateAll(fx);
		for (const t of [
			'featured_slot_bids',
			'stranger_fees',
			'operator_fee_recipients',
			'operators',
			'fee_payment_legs',
			'fee_payments'
		])
			await fx.db.query(`DELETE FROM ${t}`).catch(() => undefined);
		// The registrations, as the register handler stores them.
		const ops: [string, string, string | null, number][] = [
			['morphit-relay', 'morphit.io', T, REG],
			['alpha-op', 'alpha', 'alpha-fees', REG],
			// Registered alpha's fees account after alpha did (and sorts before
			// it): credited neither for payments that name alpha nor for ones
			// that name no operator of that account.
			['adelta-op', 'delta', 'alpha-fees', REG + 1],
			['beta-op', 'beta', null, REG],
			['gamma-op', 'gamma', T, REG],
			// Changes fees account in block BASE+1, twice in that block: from
			// BASE+2 on, the later one (eps-2) is in force.
			['epsilon-op', 'epsilon', 'eps-1', REG],
			// Registers, AFTER the payments, an account it never had: claims
			// nothing paid to it before (the grace is only for payments that
			// name the operator).
			['zed-op', 'zed', null, REG + 5]
		];
		for (const [account, tag, fee, block] of ops) {
			await fx.db.query(
				`INSERT INTO operators (account, tag, display_name, registered_at, registered_in_block)
				 VALUES ($1, $2, $3, $4, $5)`,
				[account, tag, `${tag} market`, timeOf(block), block]
			);
			if (fee !== null)
				await fx.db.query(
					`INSERT INTO operator_fee_recipients (account, fee_recipient, effective_block, effective_trx)
					 VALUES ($1, $2, $3, $4)`,
					[account, fee, block, `reg-${account}`]
				);
		}
		await feeReg('epsilon-op', 'eps-mid', BASE + 1, 0, 'reg-eps-mid');
		await feeReg('epsilon-op', 'eps-2', BASE + 1, 1, 'reg-eps-2');
		// alpha moves to another account and back (its current alpha-fees row
		// is newer than delta's); alpha registered alpha-fees FIRST, so a leg to
		// alpha-fees naming neither of them is still alpha's.
		await feeReg('alpha-op', 'alpha-tmp', REG + 2, 0, 'reg-alpha-tmp');
		await feeReg('alpha-op', 'alpha-fees', REG + 3, 0, 'reg-alpha-back');
	});

	/** A registration's fees-account row, as the register handler stores it. */
	const feeReg = (account: string, fee: string, block: number, trx: number, trxId: string) =>
		fx.db.query(
			`INSERT INTO operator_fee_recipients
			   (account, fee_recipient, effective_block, effective_trx, trx_in_block, op_in_trx)
			 VALUES ($1, $2, $3, $4, $5, 0)`,
			[account, fee, block, trxId, trx]
		);

	async function applyChain(
		chain: ReturnType<typeof buildChain>,
		afterBlock?: (n: number) => Promise<void>,
		config = fakeConfig({ feeBaseBlurt: 62.5 })
	): Promise<void> {
		for (const n of [...chain.keys()].sort((a, b) => a - b)) {
			const c: pg.PoolClient = await fx.pool.connect();
			try {
				await c.query(`SET search_path TO "${fx.schema}"`);
				await c.query('BEGIN');
				await applyBlock(
					c,
					n,
					structuredClone(chain.get(n)) as never,
					mockBlurt({ reachableOperatorCount: () => 1 }),
					config,
					{},
					{},
					((a: number) => a) as never
				);
				await c.query('COMMIT');
			} catch (e) {
				await c.query('ROLLBACK').catch(() => undefined);
				throw e;
			} finally {
				c.release();
			}
			await afterBlock?.(n);
		}
		// In the very block of olga's payment: not yet in force there.
		await feeReg('zed-op', 'omega-fees', BASE + 2, 0, 'reg-zed');
		// beta publishes its fees account after its order.
		await fx.db.query(
			`INSERT INTO operator_fee_recipients (account, fee_recipient, effective_block, effective_trx)
			 VALUES ('beta-op', 'beta-fees', $1, 'reg-beta-op')`,
			[BETA_REG]
		);
	}

	async function directory(): Promise<Wire[]> {
		await refreshOperatorStats(fx.db);
		const res = await operatorsRoute(fx.db).request('/');
		expect(res.status).toBe(200);
		return ((await res.json()) as { operators: Wire[] }).operators;
	}
	const summary = (ops: Wire[]) =>
		ops.map((o) => [
			o.tag,
			o.stats?.total_orders_attributed,
			o.stats?.cumulative_blurt_earned,
			o.fee_account
		]);

	const EXPECTED = [
		// Most orders first: dave's and alpha-fees' own (fred's was underpaid;
		// sock's refused or short of the treasury share).
		// Earned: 56.25 (dave) + 9 (fred) + 4.5 (hank) + 270 (dave's bid)
		// + 270 (carol's second bid) + 9 (nul's refused op).
		['alpha', 2, 618.75, 'alpha-fees'],
		// Orders: ivan's (eps-1, before the change) and judy's (eps-2); mia paid
		// an account not yet in force, kim and liz ones no longer in force:
		// underpaid, and not earnings.
		// Earned: 56.25 + 56.25.
		['epsilon', 2, 112.5, 'eps-2'],
		// One order each; morphit.io earned more (62.5 + carol's 300 bid).
		['morphit.io', 1, 362.5, T],
		['gamma', 1, 62.5, T],
		// nina's order names delta: its order and its 56.25.
		['delta', 1, 56.25, 'alpha-fees'],
		// erin's order is underpaid here (beta had no fees account yet), but its
		// 56.25 reached beta-fees: credited once beta registered it.
		['beta', 0, 56.25, 'beta-fees'],
		['zed', 0, 0, 'omega-fees']
	];

	it('every operator has stats, from every kind of fee, sorted by orders then earnings', async () => {
		await applyChain(buildChain());
		expect(summary(await directory())).toEqual(EXPECTED);
	});

	it('every fee op is recorded live — applied, rejected, or refused before any handler', async () => {
		await applyChain(buildChain());
		const r = await fx.db.query<{ n: string; legs: string }>(
			`SELECT (SELECT count(*) FROM fee_payments)::text AS n,
			        (SELECT count(*) FROM fee_payment_legs)::text AS legs`
		);
		const feeOps = await fx.db.query<{ n: string }>(
			`SELECT count(*)::text AS n FROM ops
			  WHERE op_id IN ('morphit_order_v1', 'morphit_stranger_fee_v1', 'morphit_feature_bid_v1')`
		);
		expect(r.rows[0]!.n).toBe(feeOps.rows[0]!.n);
		expect(Number(r.rows[0]!.n)).toBe(22);
		// 1+2+2+1+2+2 (block 1) + 2+1+2+1+2+2+2+2+2+2+2+16 (block 2; the decoy,
		// zoe-friend's transfer, the malformed op's transfer and the 4 beyond 16
		// are not legs) + 2+1+2 (block 3).
		expect(Number(r.rows[0]!.legs)).toBe(51);
		const many = await fx.db.query(`SELECT 1 FROM fee_payment_legs l JOIN fee_payments p
		   USING (block_num, trx_in_block, op_in_trx) WHERE p.payer = 'many'`);
		expect(many.rowCount).toBe(16);
		const stored = await fx.db.query<{ ref: string; memo_legs: string }>(
			`SELECT p.ref, count(l.*)::text AS memo_legs FROM fee_payments p
			   LEFT JOIN fee_payment_legs l USING (block_num, trx_in_block, op_in_trx)
			  WHERE p.payer = 'nul' GROUP BY p.ref`
		);
		expect(stored.rows).toEqual([{ ref: 'n\uFFFDl', memo_legs: '2' }]);
		// A featured-slot bid's own payload names no operator, whatever it says.
		const bidTags = await fx.db.query(
			`SELECT DISTINCT operator_tag FROM fee_payments WHERE kind = 'feature'`
		);
		expect(bidTags.rows).toEqual([{ operator_tag: null }]);
	});

	it('a node upgraded from an older version back-fills the same figures from the chain', async () => {
		const chain = buildChain();
		await applyChain(chain);
		// What an older version left behind: the ops, no recorded payments.
		await fx.db.query('DELETE FROM fee_payment_legs');
		await fx.db.query('DELETE FROM fee_payments');
		const before = await directory();
		expect(before.map((o) => o.stats?.cumulative_blurt_earned)).toEqual([0, 0, 0, 0, 0, 0, 0]);

		const fetched: number[] = [];
		const bf = new FeeLegsBackfill({
			db: fx.db,
			blurt: mockBlurt({
				getBlock: async (n: number) => {
					fetched.push(n);
					return structuredClone(chain.get(n)) as never;
				}
			})
		});
		const s = await bf.runOnce();
		expect(s).toEqual({ recorded: 22, fetchFailures: 0, backlog: false });
		expect(fetched.sort()).toEqual([BASE + 1, BASE + 2, BASE + 3]);
		expect(summary(await directory())).toEqual(EXPECTED);

		// Nothing left: the job ends and fetches nothing more.
		fetched.length = 0;
		await bf.maybeRun();
		await bf.whenIdle();
		expect(bf.finished).toBe(true);
		await bf.maybeRun();
		await bf.whenIdle();
		expect(fetched).toEqual([]);
	});

	it('the back-fill never holds up indexing: maybeRun only starts a pass, one at a time', async () => {
		const chain = buildChain();
		await applyChain(chain);
		await fx.db.query('DELETE FROM fee_payment_legs');
		await fx.db.query('DELETE FROM fee_payments');
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		let fetches = 0;
		let now = 0;
		const bf = new FeeLegsBackfill({
			db: fx.db,
			blurt: mockBlurt({
				getBlock: async (n: number) => {
					fetches++;
					await gate;
					return structuredClone(chain.get(n)) as never;
				}
			}),
			now: () => now
		});
		/** Yield to I/O (the pass's own queries) until `cond` holds. */
		const until = async (cond: () => boolean): Promise<void> => {
			for (let i = 0; i < 100_000 && !cond(); i++) await new Promise((r) => setImmediate(r));
		};
		// Returns while the first block fetch is still out (a slow Tor node):
		// a pass that held the caller would never return here (the gate is shut).
		await bf.maybeRun();
		await until(() => fetches === 1);
		expect(fetches).toBe(1);
		// A second call while the pass is out starts nothing.
		now = 1e9;
		await bf.maybeRun();
		for (let i = 0; i < 1_000; i++) await new Promise((r) => setImmediate(r));
		expect(fetches).toBe(1);
		release();
		await bf.whenIdle();
		expect(fetches).toBe(3);
		const n = await fx.db.query<{ n: string }>(`SELECT count(*)::text AS n FROM fee_payments`);
		expect(n.rows[0]!.n).toBe('22');
	});

	it('an altered transaction is not recorded (the rest of its block is), and its block is given up on', async () => {
		const chain = buildChain();
		await applyChain(chain);
		await fx.db.query('DELETE FROM fee_payment_legs');
		await fx.db.query('DELETE FROM fee_payments');
		// A lying node: block 3's first transaction pays the bid to someone else.
		const lying = structuredClone(chain);
		const b3 = lying.get(BASE + 3)!;
		(b3.transactions[0]!.operations[0]![1] as { to: string }).to = 'thief';
		let now = 0;
		const bf = new FeeLegsBackfill({
			db: fx.db,
			blurt: mockBlurt({ getBlock: async (n: number) => structuredClone(lying.get(n)) as never }),
			now: () => now
		});
		const first = await bf.runOnce();
		expect(first).toEqual({ recorded: 21, fetchFailures: 1, backlog: true });
		for (let i = 1; i < FETCH_FAILURES_PER_BLOCK; i++) await bf.runOnce();
		// Given up on for now: a pass finds nothing to fetch, but the job is not
		// over — the block is tried again later.
		expect(await bf.runOnce()).toEqual({ recorded: 0, fetchFailures: 0, backlog: true });
		now = 1e9;
		await bf.maybeRun();
		await bf.whenIdle();
		expect(bf.finished).toBe(false);
		const thief = await fx.db.query(`SELECT 1 FROM fee_payment_legs WHERE recipient = 'thief'`);
		expect(thief.rowCount).toBe(0);
		const bids = await fx.db.query<{ payer: string }>(
			`SELECT payer FROM fee_payments WHERE block_num = $1 ORDER BY trx_in_block`,
			[BASE + 3]
		);
		// dave's (altered) bid is not recorded; carol's two are.
		expect(bids.rows.map((r) => r.payer)).toEqual(['carol', 'carol']);
	});

	it('a node whose RPC nodes fail for a while still records everything once they answer again', async () => {
		const chain = buildChain();
		await applyChain(chain);
		await fx.db.query('DELETE FROM fee_payment_legs');
		await fx.db.query('DELETE FROM fee_payments');
		let down = true;
		let now = 0;
		const bf = new FeeLegsBackfill({
			db: fx.db,
			blurt: mockBlurt({
				getBlock: async (n: number) => {
					if (down) throw new Error('all RPC nodes unreachable');
					return structuredClone(chain.get(n)) as never;
				}
			}),
			now: () => now
		});
		for (let i = 0; i < FETCH_FAILURES_PER_BLOCK + 2; i++) {
			now += BACKLOG_INTERVAL_MS;
			await bf.maybeRun();
			await bf.whenIdle();
		}
		expect(bf.finished).toBe(false);
		down = false;
		now += GIVEN_UP_RETRY_MS;
		for (let i = 0; i < 3 && !bf.finished; i++) {
			now += BACKLOG_INTERVAL_MS;
			await bf.maybeRun();
			await bf.whenIdle();
		}
		expect(bf.finished).toBe(true);
		expect(summary(await directory())).toEqual(EXPECTED);
	});

	it('after its time aside, a block gets its three tries again', async () => {
		const chain = buildChain();
		await applyChain(chain);
		await fx.db.query('DELETE FROM fee_payment_legs');
		await fx.db.query('DELETE FROM fee_payments');
		let down = true;
		let now = 0;
		const bf = new FeeLegsBackfill({
			db: fx.db,
			blurt: mockBlurt({
				getBlock: async (n: number) => {
					if (down) throw new Error('all RPC nodes unreachable');
					return structuredClone(chain.get(n)) as never;
				}
			}),
			now: () => now
		});
		const pass = async () => {
			now += BACKLOG_INTERVAL_MS;
			await bf.maybeRun();
			await bf.whenIdle();
		};
		for (let i = 0; i < FETCH_FAILURES_PER_BLOCK; i++) await pass();
		// Set aside. Its time aside over, the RPC fails once more — one of its
		// three fresh tries, not the end of them: the next pass, 10 s later,
		// records it.
		now += GIVEN_UP_RETRY_MS;
		await pass();
		expect(bf.finished).toBe(false);
		down = false;
		await pass();
		expect(bf.finished).toBe(true);
		expect(summary(await directory())).toEqual(EXPECTED);
	});

	it('the figures are counted in the background: the indexing loop never waits for a pass', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		const r = new OperatorStatsRefresher({
			db: {
				query: fx.db.query.bind(fx.db) as never,
				withTx: (async (fn: never) => {
					await gate;
					return fx.db.withTx(fn);
				}) as never
			},
			now: () => 0
		});
		let ticks = 0;
		const later = new Promise<'held'>((res) => {
			const spin = () => (++ticks > 200 ? res('held') : setImmediate(spin));
			spin();
		});
		expect(await Promise.race([r.maybeRun().then(() => 'returned' as const), later])).toBe(
			'returned'
		);
		release();
		await r.whenIdle();
		expect(
			(await fx.db.query<{ n: number }>('SELECT count(*)::int AS n FROM operator_stats')).rows[0]?.n
		).toBe(7);
	});

	it('every node shows the same earnings, whatever its own fees account or the assets it lists', async () => {
		const earned = EXPECTED.map((e) => [e[0], e[2]]);
		for (const config of [
			fakeConfig({ feeBaseBlurt: 62.5, feeRecipient: 'beta-fees' }),
			fakeConfig({ feeBaseBlurt: 62.5, disabledAssets: ['BTC'] })
		]) {
			for (const t of [
				'fee_payment_legs',
				'fee_payments',
				'orders',
				'ops',
				'featured_slot_bids',
				'stranger_fees'
			])
				await fx.db.query(`DELETE FROM ${t}`);
			await fx.db.query(
				`DELETE FROM operator_fee_recipients WHERE account IN ('zed-op', 'beta-op')`
			);
			await applyChain(buildChain(), undefined, config);
			const got = (await directory()).map((o) => [o.tag, o.stats?.cumulative_blurt_earned]);
			expect([...got].sort()).toEqual([...earned].sort());
		}
	});

	it("a featured-slot bid is credited by its order's own op, not an earlier malformed one with the same name", async () => {
		await applyChain(
			chainOf([
				// carol's first try names alpha but is no order at all (no side, no
				// asset): refused on every node, whatever it lists.
				[
					BASE + 1,
					[[cj('carol', 'morphit_order_v1', { permlink: 'carol-o', operator_tag: 'alpha' })]]
				],
				// Her real order, through morphit.io (100 % to the treasury).
				[BASE + 2, [order('carol', 'carol-o', 'morphit.io', [[T, '62.500 BLURT']])]],
				// The same order posted again, naming alpha: the order is already
				// there, so this op changes nothing — it is not the order's own op.
				// Then a featured-slot bid for it, through morphit.io.
				[
					BASE + 3,
					[
						[cj('carol', 'morphit_order_v1', orderPayload('carol-o', 'alpha'))],
						[
							xfer('carol', T, '300.000 BLURT', 'morphit-feature:carol-o'),
							cj('carol', 'morphit_feature_bid_v1', {
								order_permlink: 'carol-o',
								hours_requested: 6
							})
						]
					]
				]
			])
		);
		const ops = await directory();
		const of = (tag: string) => ops.find((o) => o.tag === tag)?.stats?.cumulative_blurt_earned;
		expect(of('morphit.io')).toBe(362.5);
		expect(of('alpha')).toBe(0);
	});

	it("BLURT a fees account sends itself is nobody's earnings, even with the treasury's tenth paid", async () => {
		await applyChain(
			chainOf([
				[
					BASE + 1,
					[
						order('alpha-fees', 'self-o', 'alpha', [
							['alpha-fees', '56.250 BLURT'],
							[T, '6.250 BLURT']
						])
					]
				]
			])
		);
		const ops = await directory();
		expect(ops.find((o) => o.tag === 'alpha')?.stats?.cumulative_blurt_earned).toBe(0);
	});

	it('an order whose fee was attested counts as an order that came through the site', async () => {
		await applyChain(buildChain());
		await fx.db.query(
			`UPDATE orders SET fee_status = 'verified_by_attestation' WHERE account = 'gina'`
		);
		const gamma = (await directory()).find((o) => o.tag === 'gamma');
		expect(gamma?.stats?.total_orders_attributed).toBe(1);
	});

	it('the running indexer back-fills and computes the figures by itself (the real Poller loop)', async () => {
		const chain = buildChain();
		await applyChain(chain);
		await fx.db.query('DELETE FROM fee_payment_legs');
		await fx.db.query('DELETE FROM fee_payments');
		await fx.db.query('DELETE FROM operator_stats');
		const head = BASE + 3;
		const blurt = mockBlurt({
			reachableOperatorCount: () => 1,
			endpointCount: () => 1,
			healthyEndpointCount: () => 1,
			fastestLatencyMs: () => 1,
			getDynamicGlobalProperties: async () =>
				({ head_block_number: head, last_irreversible_block_num: head }) as never,
			crossCheckChainConsistency: async () =>
				({ consistent: true, reason: 'ok', agreeing: 1, contacted: 1, required: 1 }) as never,
			getBlock: async (n: number) => structuredClone(chain.get(n)) as never,
			getBlocks: (async (nums: readonly number[]) =>
				nums.map((n) => structuredClone(chain.get(n)) ?? null)) as never
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
			MORPHIT_INDEXER_FEE_BASE_BLURT: '62.5'
		});
		const config = (() => {
			try {
				return loadConfig();
			} finally {
				process.env = saved;
			}
		})();
		await fx.db.query(
			`INSERT INTO indexer_state (id, last_applied_block, chain_id) VALUES (1, $1, $2)
			 ON CONFLICT (id) DO UPDATE SET last_applied_block = $1, chain_id = $2`,
			[head, config.chainId]
		);
		const poller = new Poller(config, fx.db, blurt, null, null);
		const running = poller.run().catch(() => undefined);
		const count = async (sql: string) => Number((await fx.db.query<{ n: string }>(sql)).rows[0]!.n);
		let payments = 0;
		let stats = 0;
		// Waits on the loop's own timers (it sleeps between ticks), so the bound
		// is wall-clock, polled with setImmediate (no fixed sleep in a test).
		const deadline = Date.now() + 45_000;
		for (let i = 0; Date.now() < deadline && (payments < 22 || stats === 0); i++) {
			await new Promise((r) => setImmediate(r));
			if (i % 500 === 0) {
				payments = await count('SELECT count(*)::text AS n FROM fee_payments');
				stats = await count('SELECT count(*)::text AS n FROM operator_stats');
			}
		}
		poller.stop();
		await running;
		expect(payments).toBe(22);
		expect(stats).toBeGreaterThan(0);
	}, 90_000);
});
