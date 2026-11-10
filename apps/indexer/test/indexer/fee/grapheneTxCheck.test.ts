/**
 * v1.24.0 — a trade's HIVE / STEEM payment, looked up by transaction id on
 * that chain's API nodes (fee/grapheneTxCheck.ts), and its way through
 * PaymentChecker and GET /v1/payment-check.
 *
 * The answers below have the shapes the nodes give: HAfAH's
 * `/transactions/<id>` (its openapi example and its tavern patterns: a
 * `transfer_operation` with a NAI amount; "Unknown Transaction" in an HTTP 400
 * body), `/headblock` (a bare number) and `/sync-status`; Steem's condenser
 * JSON-RPC (legacy `['transfer', {…}]` operations, "1.000 STEEM" amounts,
 * `head_block_number` / `last_irreversible_block_num`, a header `timestamp`).
 */
import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';

import { GrapheneTxChecker, paidTo } from '$indexer/fee/grapheneTxCheck';
import { buildPaymentChecker, PaymentChecker } from '$indexer/fee/paymentCheck';
import {
	parsePaymentQuery,
	paymentCheckRoute,
	PAYMENT_CHECK_FRESH_MS,
	PAYMENT_CHECK_FRESH_MS_3S_CHAINS
} from '$api/paymentCheck';
import type { PaymentVerdict } from '$indexer/fee/paymentCheck';

const TXID = '954f6de36e6715d128fa8eb5a053fc254b05ded0';
const BLOCK = 4_023_233;
const HIVE_A = 'https://api.hive.blog/hafah-api';
const HIVE_B = 'https://api.openhive.network/hafah-api';
const STEEM_A = 'https://api.steemit.com';
const STEEM_B = 'https://api.justyy.com';

const hiveAmount = (units: string, nai = '@@000000021') => ({ amount: units, precision: 3, nai });
const hiveTransfer = (from: string, to: string, amount: unknown, memo = '') => ({
	type: 'transfer_operation',
	value: { from, to, amount, memo }
});
function hafahTx(operations: unknown[], txid = TXID, block = BLOCK) {
	return {
		transaction_json: {
			ref_block_num: 25532,
			ref_block_prefix: 3338687976,
			extensions: [],
			expiration: '2016-08-12T17:23:48',
			operations,
			signatures: ['20'.repeat(65)]
		},
		transaction_id: txid,
		block_num: block,
		transaction_num: 0,
		timestamp: '2016-08-12T17:23:39'
	};
}

type Route = (url: string, init: RequestInit) => Response | Promise<Response>;
const json = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fetch that answers per node, and records what was asked. */
function nodes(routes: Record<string, Route>) {
	const asked: string[] = [];
	const f = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = String(input);
		asked.push(url);
		const base = Object.keys(routes).find((b) => url.startsWith(b));
		if (base === undefined) throw new TypeError('fetch failed');
		return routes[base]!(url, init ?? {});
	}) as typeof fetch;
	return { f, asked };
}

/** A HAfAH node with this transaction (or none), head and irreversible block. */
function hafah(tx: unknown | null, head: number, irreversible: number): Route {
	return (url) => {
		if (url.endsWith('/headblock')) return json(head);
		if (url.endsWith('/sync-status')) {
			return json({ last_block_num: irreversible, last_block_time: '2016-08-12T17:23:39' });
		}
		if (url.includes('/transactions/')) {
			return tx === null
				? json(
						{
							code: 'P0001',
							details: null,
							hint: null,
							message: `Assert Exception:false: Unknown Transaction ${TXID}`
						},
						400
					)
				: json(tx);
		}
		return json({ message: 'not here' }, 404);
	};
}

function hive(urls: readonly string[], f: typeof fetch) {
	return new GrapheneTxChecker(
		{ chain: 'hive', urls, minAgree: 2, requiredConfirmations: 3, requestTimeoutMs: 2_000 },
		f
	);
}
function steem(urls: readonly string[], f: typeof fetch) {
	return new GrapheneTxChecker(
		{ chain: 'steem', urls, minAgree: 2, requiredConfirmations: 3, requestTimeoutMs: 2_000 },
		f
	);
}

/** A Steem JSON-RPC node. `tx`: the legacy transaction, or an error message. */
function condenser(tx: unknown | string, head: number, irreversible: number): Route {
	return async (_url, init) => {
		const req = JSON.parse(String(init.body)) as { method: string; params: unknown[]; id: number };
		const reply = (result: unknown) => json({ jsonrpc: '2.0', result, id: req.id });
		switch (req.method) {
			case 'condenser_api.get_transaction':
				return typeof tx === 'string'
					? json({ jsonrpc: '2.0', error: { code: -32000, message: tx, data: {} }, id: req.id })
					: reply(tx);
			case 'condenser_api.get_dynamic_global_properties':
				return reply({
					head_block_number: head,
					last_irreversible_block_num: irreversible,
					time: '2025-11-01T03:26:39'
				});
			case 'condenser_api.get_block_header':
				return reply({
					previous: '05fcedaf' + '0'.repeat(32),
					timestamp: '2025-11-01T03:26:39',
					witness: 'xpilar.witness',
					transaction_merkle_root: '0'.repeat(40),
					extensions: []
				});
			default:
				return json({ jsonrpc: '2.0', error: { code: -32601, message: 'no' }, id: req.id });
		}
	};
}
const steemTx = (operations: unknown[], txid = TXID, block = 100_462_000) => ({
	ref_block_num: 60847,
	ref_block_prefix: 1,
	expiration: '2025-11-01T03:36:33',
	operations,
	extensions: [],
	signatures: [],
	transaction_id: txid,
	block_num: block,
	transaction_num: 0
});

describe('paidTo — only the coin itself, to the account, from someone else', () => {
	it('Hive: HIVE counts; HBD, a power-up, a transfer to itself or to another account do not', () => {
		const ops = [
			hiveTransfer('bob', 'alice', hiveAmount('1234')),
			hiveTransfer('bob', 'alice', hiveAmount('5000', '@@000000013')),
			{
				type: 'transfer_to_vesting_operation',
				value: { from: 'bob', to: 'alice', amount: hiveAmount('9000') }
			},
			hiveTransfer('alice', 'alice', hiveAmount('7000')),
			hiveTransfer('bob', 'carol', hiveAmount('8000')),
			hiveTransfer('dan', 'alice', hiveAmount('1'))
		];
		expect(paidTo('hive', ops, 'alice')).toEqual({ units: 1235n, otherMemo: false });
	});
	it('Steem: STEEM counts; SBD does not', () => {
		const ops = [
			['transfer', { from: 'bob', to: 'alice', amount: '2.500 STEEM', memo: '' }],
			['transfer', { from: 'bob', to: 'alice', amount: '9.000 SBD', memo: '' }],
			['vote', { voter: 'alice', author: 'bob', permlink: 'p', weight: 1 }]
		];
		expect(paidTo('steem', ops, 'alice')).toEqual({ units: 2500n, otherMemo: false });
	});
	it('an unreadable transfer to the account makes the answer count for nothing, not for 0', () => {
		expect(
			paidTo(
				'hive',
				[hiveTransfer('bob', 'alice', { amount: '1.5', precision: 3, nai: '@@000000021' })],
				'alice'
			)
		).toBeNull();
		expect(
			paidTo('hive', [hiveTransfer('bob', 'alice', hiveAmount('1000').amount)], 'alice')
		).toBeNull();
		expect(
			paidTo('steem', [['transfer', { from: 'bob', to: 'alice', amount: '2.5 STEEM' }]], 'alice')
		).toBeNull();
		expect(
			paidTo('steem', [['transfer', { from: 'bob', to: 'alice', amount: 2.5 }]], 'alice')
		).toBeNull();
	});
});

describe('Hive, over HAfAH', () => {
	it('two operators agree: found, its block time, and the depth it has', async () => {
		const tx = hafahTx([hiveTransfer('bob', 'alice', hiveAmount('1234'))]);
		const { f } = nodes({
			[HIVE_A]: hafah(tx, BLOCK + 9, BLOCK + 8),
			[HIVE_B]: hafah(tx, BLOCK + 10, BLOCK + 9)
		});
		const r = await hive([HIVE_A, HIVE_B], f).lookupPayment(TXID, 'alice');
		expect(r).toEqual({
			kind: 'found',
			amount: 1234n,
			// The lower of the two depths (head + 1 - block).
			confirmations: 10,
			blockTime: Date.parse('2016-08-12T17:23:39Z') / 1000
		});
	});

	it('its block not irreversible yet: never counted as deep enough', async () => {
		const tx = hafahTx([hiveTransfer('bob', 'alice', hiveAmount('1234'))]);
		const { f } = nodes({
			[HIVE_A]: hafah(tx, BLOCK + 40, BLOCK - 1),
			[HIVE_B]: hafah(tx, BLOCK + 40, BLOCK - 1)
		});
		const r = await hive([HIVE_A, HIVE_B], f).lookupPayment(TXID, 'alice');
		expect(r).toMatchObject({ kind: 'found', confirmations: 2 });
	});

	it('both say "Unknown Transaction": not found; one says so, one has it: no answer', async () => {
		const none = nodes({
			[HIVE_A]: hafah(null, BLOCK, BLOCK),
			[HIVE_B]: hafah(null, BLOCK, BLOCK)
		});
		expect(await hive([HIVE_A, HIVE_B], none.f).lookupPayment(TXID, 'alice')).toEqual({
			kind: 'not_found'
		});
		const tx = hafahTx([hiveTransfer('bob', 'alice', hiveAmount('1234'))]);
		const split = nodes({ [HIVE_A]: hafah(tx, BLOCK, BLOCK), [HIVE_B]: hafah(null, BLOCK, BLOCK) });
		expect(await hive([HIVE_A, HIVE_B], split.f).lookupPayment(TXID, 'alice')).toEqual({
			kind: 'no_answer'
		});
	});

	it('any other 400 or 404 is no "not found" (a proxy page says nothing about the transaction)', async () => {
		const page: Route = (url) =>
			url.includes('/transactions/')
				? new Response('<html>Bad Request</html>', { status: 400 })
				: hafah(null, BLOCK, BLOCK)(url, {});
		const { f } = nodes({ [HIVE_A]: page, [HIVE_B]: page });
		expect(await hive([HIVE_A, HIVE_B], f).lookupPayment(TXID, 'alice')).toEqual({
			kind: 'no_answer'
		});
	});

	it('a node answering about another transaction, or the two disagreeing on the amount: no answer', async () => {
		const ok = hafahTx([hiveTransfer('bob', 'alice', hiveAmount('1234'))]);
		const other = hafahTx([hiveTransfer('bob', 'alice', hiveAmount('1234'))], 'f'.repeat(40));
		const more = hafahTx([hiveTransfer('bob', 'alice', hiveAmount('99999'))]);
		for (const b of [other, more]) {
			const { f } = nodes({
				[HIVE_A]: hafah(ok, BLOCK + 5, BLOCK + 5),
				[HIVE_B]: hafah(b, BLOCK + 5, BLOCK + 5)
			});
			expect(await hive([HIVE_A, HIVE_B], f).lookupPayment(TXID, 'alice')).toEqual({
				kind: 'no_answer'
			});
		}
	});

	it('two addresses of one operator are one answer', async () => {
		const tx = hafahTx([hiveTransfer('bob', 'alice', hiveAmount('1234'))]);
		const a2 = 'https://api2.hive.blog/hafah-api';
		const { f } = nodes({
			[HIVE_A]: hafah(tx, BLOCK + 5, BLOCK + 5),
			[a2]: hafah(tx, BLOCK + 5, BLOCK + 5)
		});
		expect(await hive([HIVE_A, a2], f).lookupPayment(TXID, 'alice')).toEqual({ kind: 'no_answer' });
	});

	it('a malformed txid or account is never sent anywhere', async () => {
		const { f, asked } = nodes({});
		const c = hive([HIVE_A, HIVE_B], f);
		expect(await c.lookupPayment('ab'.repeat(32), 'alice')).toEqual({ kind: 'no_answer' });
		expect(await c.lookupPayment(TXID, 'Alice')).toEqual({ kind: 'no_answer' });
		expect(asked).toEqual([]);
	});
});

describe('Steem, over condenser JSON-RPC', () => {
	it('found by two operators, SBD left out, depth only from an irreversible block', async () => {
		const tx = steemTx([
			['transfer', { from: 'bob', to: 'alice', amount: '2.500 STEEM', memo: 'x' }],
			['transfer', { from: 'bob', to: 'alice', amount: '9.000 SBD', memo: 'x' }]
		]);
		const { f, asked } = nodes({
			[STEEM_A]: condenser(tx, 100_462_030, 100_462_010),
			[STEEM_B]: condenser(tx, 100_462_031, 100_462_011)
		});
		const r = await steem([STEEM_A, STEEM_B], f).lookupPayment(TXID, 'alice');
		expect(r).toEqual({
			kind: 'found',
			amount: 2500n,
			confirmations: 31,
			blockTime: Date.parse('2025-11-01T03:26:39Z') / 1000
		});
		expect(asked.every((u) => u === STEEM_A || u === STEEM_B)).toBe(true);
		const fresh = nodes({
			[STEEM_A]: condenser(tx, 100_462_005, 100_461_990),
			[STEEM_B]: condenser(tx, 100_462_005, 100_461_990)
		});
		expect(await steem([STEEM_A, STEEM_B], fresh.f).lookupPayment(TXID, 'alice')).toMatchObject({
			confirmations: 2
		});
	});

	it('"Unknown Transaction" is not found; a node without the transaction index is no answer', async () => {
		const unknown = `Assert Exception:false: Unknown Transaction ${TXID}`;
		const none = nodes({
			[STEEM_A]: condenser(unknown, 1, 1),
			[STEEM_B]: condenser(unknown, 1, 1)
		});
		expect(await steem([STEEM_A, STEEM_B], none.f).lookupPayment(TXID, 'alice')).toEqual({
			kind: 'not_found'
		});
		const off =
			"Assert Exception:false: This node's operator has disabled operation indexing by transaction_id";
		const noIndex = nodes({ [STEEM_A]: condenser(off, 1, 1), [STEEM_B]: condenser(off, 1, 1) });
		expect(await steem([STEEM_A, STEEM_B], noIndex.f).lookupPayment(TXID, 'alice')).toEqual({
			kind: 'no_answer'
		});
	});
});

describe('through PaymentChecker and the route', () => {
	it('amounts in coin units; a zero-clearnet node asks no HIVE / STEEM node at all', async () => {
		const tx = hafahTx([hiveTransfer('bob', 'alice', hiveAmount('1234'))]);
		const { f, asked } = nodes({
			[HIVE_A]: hafah(tx, BLOCK + 5, BLOCK + 5),
			[HIVE_B]: hafah(tx, BLOCK + 5, BLOCK + 5)
		});
		const base = {
			hiddenRpcEndpoints: [],
			btcExplorerUrls: [],
			xmrExplorerUrls: [],
			btcMinSuccessfulResponses: 2,
			xmrMinSuccessfulResponses: 2,
			hivePaymentNodes: [HIVE_A, HIVE_B],
			steemPaymentNodes: [STEEM_A, STEEM_B]
		};
		const on = buildPaymentChecker({ ...base, blurtRpcEndpoints: ['https://rpc.example.org'] }, f);
		expect(
			await on.check({ asset: 'hive', txid: TXID, address: 'alice', txKey: null })
		).toMatchObject({
			status: 'found',
			amount: '1.234',
			confirmations: 6
		});
		asked.length = 0;
		const hiddenOnly = buildPaymentChecker(
			{ ...base, blurtRpcEndpoints: [], hiddenRpcEndpoints: ['http://x.onion'] },
			f
		);
		expect(
			await hiddenOnly.check({ asset: 'steem', txid: TXID, address: 'alice', txKey: null })
		).toMatchObject({ status: 'unavailable' });
		expect(asked).toEqual([]);
	});

	it('the query: 40 hex and an account name, never a tx key', () => {
		const q = (o: Record<string, string>) =>
			parsePaymentQuery(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [v]])));
		expect(q({ asset: 'hive', txid: TXID.toUpperCase(), address: 'alice.trade' })).toEqual({
			asset: 'hive',
			txid: TXID,
			address: 'alice.trade',
			txKey: null,
			memo: null
		});
		expect(q({ asset: 'steem', txid: TXID, address: 'bob-1' })).not.toBeNull();
		expect(q({ asset: 'hive', txid: 'ab'.repeat(32), address: 'alice' })).toBeNull();
		expect(q({ asset: 'hive', txid: TXID, address: 'Alice' })).toBeNull();
		expect(q({ asset: 'hive', txid: TXID, address: 'al' })).toBeNull();
		expect(q({ asset: 'steem', txid: TXID, address: 'alice', tx_key: 'cd'.repeat(32) })).toBeNull();
		expect(q({ asset: 'bts', txid: TXID, address: 'alice' })).toBeNull();
	});

	it('a confirming HIVE answer is reused for seconds, not the 15 s a BTC one is', async () => {
		let now = 1_000_000;
		let calls = 0;
		const verdict: PaymentVerdict = {
			status: 'found',
			amount: '1',
			confirmations: 1,
			txTime: null
		};
		const app = new Hono().route(
			'/',
			paymentCheckRoute({
				check: async () => {
					calls++;
					return verdict;
				},
				clock: () => now,
				staleWaitMs: 0,
				clientOf: () => ({ key: 'k', shared: false })
			})
		);
		const ask = () => app.request(`/?asset=hive&txid=${TXID}&address=alice`);
		await ask();
		expect(calls).toBe(1);
		now += PAYMENT_CHECK_FRESH_MS_3S_CHAINS.confirming - 1;
		await ask();
		expect(calls).toBe(1);
		now += 2;
		await ask();
		expect(calls).toBe(2);
		expect(PAYMENT_CHECK_FRESH_MS_3S_CHAINS.confirming).toBeLessThan(
			PAYMENT_CHECK_FRESH_MS.confirming
		);
	});

	it('PaymentChecker without HIVE / STEEM tiers: unavailable', async () => {
		const c = new PaymentChecker({ btc: [], xmr: [] });
		expect(
			await c.check({ asset: 'hive', txid: TXID, address: 'alice', txKey: null })
		).toMatchObject({
			status: 'unavailable'
		});
	});
});

describe('v1.24.0 review: the memo ties the payment to the trade', () => {
	const MEMO = 'k3m9qz2a';
	it('only transfers with the ask memo count; one without it is reported, not paid', () => {
		const ops = [
			hiveTransfer('bob', 'alice', hiveAmount('1000'), MEMO),
			hiveTransfer('eve', 'alice', hiveAmount('9000'), 'other'),
			hiveTransfer('dan', 'alice', hiveAmount('5000'), '#encrypted')
		];
		expect(paidTo('hive', ops, 'alice', MEMO)).toEqual({ units: 1000n, otherMemo: true });
		expect(paidTo('hive', ops.slice(1), 'alice', MEMO)).toEqual({ units: 0n, otherMemo: true });
		expect(paidTo('hive', ops.slice(0, 1), 'alice', MEMO)).toEqual({
			units: 1000n,
			otherMemo: false
		});
		const steemOps = [
			['transfer', { from: 'bob', to: 'alice', amount: '2.500 STEEM', memo: ` ${MEMO} ` }]
		];
		expect(paidTo('steem', steemOps, 'alice', MEMO)).toEqual({ units: 2500n, otherMemo: false });
	});
	it("someone else's payment into the account, cited by txid, pays 0 to this trade", async () => {
		const tx = hafahTx([hiveTransfer('exchange', 'alice', hiveAmount('100037'), 'deposit-77')]);
		const { f } = nodes({
			[HIVE_A]: hafah(tx, BLOCK + 9, BLOCK + 9),
			[HIVE_B]: hafah(tx, BLOCK + 9, BLOCK + 9)
		});
		expect(await hive([HIVE_A, HIVE_B], f).lookupPayment(TXID, 'alice', MEMO)).toMatchObject({
			kind: 'found',
			amount: 0n,
			otherMemo: true
		});
	});
	it('the route takes the memo for HIVE / STEEM only, and keys its cache by it', () => {
		const q = (o: Record<string, string>) =>
			parsePaymentQuery(Object.fromEntries(Object.entries(o).map(([k, v]) => [k, [v]])));
		expect(q({ asset: 'hive', txid: TXID, address: 'alice', memo: MEMO })).toMatchObject({
			memo: MEMO
		});
		expect(q({ asset: 'hive', txid: TXID, address: 'alice', memo: 'Bad Memo' })).toBeNull();
		expect(q({ asset: 'hive', txid: TXID, address: 'alice', memo: 'abc' })).toBeNull();
		expect(
			q({
				asset: 'btc',
				txid: 'ab'.repeat(32),
				address: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
				memo: MEMO
			})
		).toBeNull();
	});
	it('memo_mismatch reaches the answer', async () => {
		const verdict: PaymentVerdict = {
			status: 'found',
			amount: '0',
			confirmations: 3,
			txTime: '2026-11-09T00:00:00.000Z',
			memoMismatch: true
		};
		const app = new Hono().route(
			'/',
			paymentCheckRoute({
				check: async () => verdict,
				clientOf: () => ({ key: 'k', shared: false })
			})
		);
		const r = await app.request(`/?asset=steem&txid=${TXID}&address=alice&memo=${MEMO}`);
		expect(await r.json()).toMatchObject({ status: 'found', amount: '0', memo_mismatch: true });
	});
	it('Hive / Steem names follow the chains rule: parts of 3 or more', () => {
		const q = (address: string) =>
			parsePaymentQuery({ asset: ['hive'], txid: [TXID], address: [address] });
		expect(q('alice.trade')).not.toBeNull();
		for (const bad of ['a.b', 'ab.cd', 'abc.1de', 'a..bc', 'abc-']) expect(q(bad)).toBeNull();
	});
});

describe('v1.24.0 review: nodes that fail, stall or lag', () => {
	const HIVE_C = 'https://techcoderx.com/hafah-api';
	const tx = hafahTx([hiveTransfer('bob', 'alice', hiveAmount('1234'))]);
	it('a dead node and a 429 node are cooled by the pool; the third operator answers', async () => {
		const { f } = nodes({
			[HIVE_A]: () => {
				throw new TypeError('fetch failed');
			},
			[HIVE_B]: () => new Response('slow down', { status: 429 }),
			[HIVE_C]: hafah(tx, BLOCK + 5, BLOCK + 5)
		});
		const c = hive([HIVE_A, HIVE_B, HIVE_C], f);
		// Two of three cannot answer: no quorum of two — never a verdict on one.
		expect(await c.lookupPayment(TXID, 'alice')).toEqual({ kind: 'no_answer' });
		const pool = (c as unknown as { pool: { endpoints: { url: string; cooldownUntil: number }[] } })
			.pool;
		const cooled = pool.endpoints.filter((e) => e.cooldownUntil > Date.now()).map((e) => e.url);
		expect(cooled.sort()).toEqual([HIVE_A, HIVE_B].sort());
	});
	it('a node that sends its answer slower than the timeout is cut off in time', async () => {
		const stall: Route = () =>
			new Response(
				new ReadableStream({
					start(ctl) {
						const t = setInterval(() => ctl.enqueue(new TextEncoder().encode(' ')), 50);
						setTimeout(() => clearInterval(t), 10_000);
					}
				}),
				{ status: 200 }
			);
		const { f } = nodes({ [HIVE_A]: stall, [HIVE_B]: stall });
		const c = new GrapheneTxChecker(
			{
				chain: 'hive',
				urls: [HIVE_A, HIVE_B],
				minAgree: 2,
				requiredConfirmations: 3,
				requestTimeoutMs: 300
			},
			f
		);
		const t0 = Date.now();
		expect(await c.lookupPayment(TXID, 'alice')).toEqual({ kind: 'no_answer' });
		expect(Date.now() - t0).toBeLessThan(3_000);
	});
	it('two "not found" end the round: the other nodes are not asked, nor any head block', async () => {
		const urls = [
			HIVE_A,
			HIVE_B,
			HIVE_C,
			'https://rpc.mahdiyari.info/hafah-api',
			'https://hiveapi.actifit.io/hafah-api'
		];
		const { f, asked } = nodes(Object.fromEntries(urls.map((u) => [u, hafah(null, BLOCK, BLOCK)])));
		expect(await hive(urls, f).lookupPayment(TXID, 'alice')).toEqual({ kind: 'not_found' });
		expect(asked.every((u) => u.includes('/transactions/'))).toBe(true);
		expect(asked.length).toBeLessThanOrEqual(3);
	});
	it('a lagging node that does not know it yet does not stop two that do', async () => {
		const { f } = nodes({
			[HIVE_A]: hafah(null, BLOCK - 50, BLOCK - 60),
			[HIVE_B]: hafah(tx, BLOCK + 5, BLOCK + 5),
			[HIVE_C]: hafah(tx, BLOCK + 6, BLOCK + 5)
		});
		expect(await hive([HIVE_A, HIVE_B, HIVE_C], f).lookupPayment(TXID, 'alice')).toMatchObject({
			kind: 'found',
			amount: 1234n,
			confirmations: 6
		});
	});
	it('a redirect is not followed and counts as no answer', async () => {
		const moved: Route = () =>
			new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/' } });
		const { f, asked } = nodes({ [HIVE_A]: moved, [HIVE_B]: moved });
		expect(await hive([HIVE_A, HIVE_B], f).lookupPayment(TXID, 'alice')).toEqual({
			kind: 'no_answer'
		});
		expect(asked.some((u) => u.includes('127.0.0.1'))).toBe(false);
	});
	it('Steem: a failing block header or a malformed block number is no answer', async () => {
		const tx2 = steemTx([
			['transfer', { from: 'bob', to: 'alice', amount: '2.500 STEEM', memo: '' }]
		]);
		const noHeader: Route = async (url, init) => {
			const req = JSON.parse(String(init.body)) as { method: string };
			if (req.method === 'condenser_api.get_block_header')
				return json({ jsonrpc: '2.0', error: { code: -1, message: 'x' }, id: 1 });
			return condenser(tx2, 100_462_030, 100_462_010)(url, init);
		};
		const { f } = nodes({ [STEEM_A]: noHeader, [STEEM_B]: noHeader });
		expect(await steem([STEEM_A, STEEM_B], f).lookupPayment(TXID, 'alice')).toEqual({
			kind: 'no_answer'
		});
		const bad = nodes({
			[STEEM_A]: condenser({ ...tx2, block_num: 'x' }, 1, 1),
			[STEEM_B]: condenser({ ...tx2, block_num: 'x' }, 1, 1)
		});
		expect(await steem([STEEM_A, STEEM_B], bad.f).lookupPayment(TXID, 'alice')).toEqual({
			kind: 'no_answer'
		});
	});
	it('two nodes whose block times cannot both be true: no time, disputed', async () => {
		const later = { ...tx, timestamp: '2016-08-13T17:23:39' };
		const { f } = nodes({
			[HIVE_A]: hafah(tx, BLOCK + 5, BLOCK + 5),
			[HIVE_B]: hafah(later, BLOCK + 5, BLOCK + 5)
		});
		expect(await hive([HIVE_A, HIVE_B], f).lookupPayment(TXID, 'alice')).toMatchObject({
			kind: 'found',
			blockTime: null,
			timeDisputed: true
		});
	});
});
