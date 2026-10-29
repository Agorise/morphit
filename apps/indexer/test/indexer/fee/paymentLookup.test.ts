/**
 * The trade payment check's explorer side (fee/paymentCheck.ts and the
 * verifiers' lookupPayment): how much a txid pays to an address, how deep it
 * is, and when the explorers' word is a verdict at all.
 *
 * All HTTP is stubbed. Esplora answers have the shape of Blockstream's and
 * mempool's `/tx/:txid` and `/blocks/tip/height`; the XMR transactions are
 * the PyPI-`monero`-built vectors of xmrRawTx.test.ts, served as monerod's
 * `/get_transactions` answer (see xmrNodeSource.test.ts), so the amounts are
 * really proven with the tx key, not taken from the stub.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildPaymentChecker, formatCoinAmount, PaymentChecker } from '$indexer/fee/paymentCheck';
import { BitcoinExplorerFeeVerifier } from '$indexer/fee/bitcoinExplorerVerifier';
import { MoneroProofFeeVerifier } from '$indexer/fee/moneroProofVerifier';
import type { PaymentQuery } from '$indexer/fee/paymentCheck';
import { setLogSink, type LogRecord } from '$log';
import { isBtcMainnetAddress } from '@morphit/release-schema';

const V = JSON.parse(
	readFileSync(resolve(__dirname, '../../fixtures/xmr-rawtx-vectors.json'), 'utf8')
);
const byName = (n: string) => V.vectors.find((v: { name: string }) => v.name === n);
const SUB = byName('subaddress+change');
const OTHER_VECTOR = byName('two-outputs-same-primary+change');
/** A transaction with additional tx keys (a subaddress among several
 *  destinations): `tx_key_full` is what the wallet shows. */
const ADD = byName('additional-keys');
const ADD_AMOUNT = BigInt(Object.values(ADD.pyscan as Record<string, [string, string]>)[0]![1]);

const TXID = 'ab'.repeat(32);
const ADDR = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const OTHER_ADDR = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
const E1 = 'https://esplora-one.example/api';
const E2 = 'https://esplora-two.example/api';
const ONION1 = `http://${'a'.repeat(56)}.onion/api`;
const ONION2 = `http://${'b'.repeat(56)}.onion/api`;
const X1 = 'https://xmr-one.example';
const X2 = 'https://xmr-two.example';
const N1 = 'node+https://node-one.example:18089';
const N2 = 'node+https://node-two.example';

type Reply = { status?: number; json?: unknown; text?: string } | 'throw';
type Route = (url: string, init?: RequestInit) => Reply | undefined;

function fetcher(...routes: Route[]) {
	const calls: { url: string; init?: RequestInit }[] = [];
	const f = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
		const url = String(input);
		calls.push({ url, ...(init !== undefined ? { init } : {}) });
		let r: Reply | undefined;
		for (const route of routes) {
			r = route(url, init);
			if (r !== undefined) break;
		}
		// The URL in the message on purpose: a fetch error can quote it, and the
		// privacy test below must see that it still never reaches the log.
		if (r === undefined || r === 'throw') throw new TypeError(`fetch failed: ${url}`);
		return new Response(r.text ?? JSON.stringify(r.json), { status: r.status ?? 200 });
	}) as typeof fetch;
	return { f, calls };
}

interface Out {
	value: unknown;
	scriptpubkey_address?: string;
}
/** Someone else's address, the default input's owner. */
const SENDER = '1BoatSLRHtKNngkdXEeobR76b53LETtpyT';
/** An Esplora input spending `from` (its prevout, as Esplora gives it). */
const input = (from: string, value = 2_000_000) => ({
	txid: 'ee'.repeat(32),
	vout: 0,
	is_coinbase: false,
	prevout: { scriptpubkey_address: from, value }
});
const tx = (
	vout: Out[],
	status: { confirmed: boolean; block_height?: number; block_time?: number },
	txid = TXID,
	vin: unknown = [input(SENDER)]
) => ({ txid, vin, vout, status });
const MEMPOOL = { confirmed: false };
/** The block time the stub explorers give for height `h` (unix seconds). */
const timeAt = (h: number) => 1_790_000_000 + (h - 800_000) * 600;
const iso = (t: number) => new Date(t * 1000).toISOString();

// The clock stands ten minutes after the stubs' top block (XT = timeAt(800_000)):
// a payment's time is judged against "now" (paymentTimeOf), so the stubs'
// blocks are recent, as a payment being checked is.
beforeAll(() => {
	vi.useFakeTimers({ toFake: ['Date'], shouldAdvanceTime: true });
	vi.setSystemTime((timeAt(800_000) + 600) * 1000);
});
afterAll(() => {
	vi.useRealTimers();
});
const at = (h: number, blockTime: number | undefined = timeAt(h)) => ({
	confirmed: true,
	block_height: h,
	...(blockTime === undefined ? {} : { block_time: blockTime })
});
const PAYS = [
	{ value: 25_000, scriptpubkey_address: ADDR },
	{ value: 1_000_000, scriptpubkey_address: OTHER_ADDR }
];

/** An Esplora explorer at `base`: its /tx answer and its tip height. */
function esplora(base: string, txReply: Reply, tip: Reply | number = { status: 500 }): Route {
	return (url) => {
		if (url === `${base}/tx/${TXID}`) return txReply;
		if (url === `${base}/blocks/tip/height`)
			return typeof tip === 'number' ? { text: String(tip) } : tip;
		return undefined;
	};
}
const ok = (body: unknown): Reply => ({ json: body });

const baseConfig = {
	blurtRpcEndpoints: ['https://rpc.example'],
	hiddenRpcEndpoints: [] as string[],
	btcExplorerUrls: [E1, E2],
	xmrExplorerUrls: [X1, X2],
	btcMinSuccessfulResponses: 2,
	xmrMinSuccessfulResponses: 2
};
const btcQ: PaymentQuery = { asset: 'btc', txid: TXID, address: ADDR, txKey: null };
const checkBtc = (f: typeof fetch, o: Partial<typeof baseConfig> = {}) =>
	buildPaymentChecker({ ...baseConfig, ...o }, f).check(btcQ);
const found = (amount: string, confirmations: number, txTime: string | null = null) => ({
	status: 'found',
	amount,
	confirmations,
	txTime
});

describe('formatCoinAmount', () => {
	it('writes smallest units as coin units without trailing zeros', () => {
		expect(formatCoinAmount(0n, 8)).toBe('0');
		expect(formatCoinAmount(25_000n, 8)).toBe('0.00025');
		expect(formatCoinAmount(100_000_000n, 8)).toBe('1');
		expect(formatCoinAmount(2_100_000_000_000_000n, 8)).toBe('21000000');
		expect(formatCoinAmount(781_250_000n, 12)).toBe('0.00078125');
		expect(formatCoinAmount(1n, 12)).toBe('0.000000000001');
	});
});

describe('BTC — amounts and depth', () => {
	it('the test addresses are real mainnet addresses', () => {
		expect(isBtcMainnetAddress(ADDR)).toBe(true);
		expect(isBtcMainnetAddress(OTHER_ADDR)).toBe(true);
		expect(isBtcMainnetAddress(SENDER)).toBe(true);
	});
	it('in the mempool, two explorers agree: found, the amount to THIS address, 0 confirmations, no time', async () => {
		const { f } = fetcher(esplora(E1, ok(tx(PAYS, MEMPOOL))), esplora(E2, ok(tx(PAYS, MEMPOOL))));
		expect(await checkBtc(f)).toEqual(found('0.00025', 0));
	});
	it('outputs to the address are summed', async () => {
		const two = [...PAYS, { value: 5_000, scriptpubkey_address: ADDR }];
		const { f } = fetcher(esplora(E1, ok(tx(two, MEMPOOL))), esplora(E2, ok(tx(two, MEMPOOL))));
		expect(await checkBtc(f)).toEqual(found('0.0003', 0));
	});
	it('a transaction that pays another address: found, amount 0', async () => {
		const elsewhere = [{ value: 25_000, scriptpubkey_address: OTHER_ADDR }];
		const { f } = fetcher(
			esplora(E1, ok(tx(elsewhere, at(800_000))), 800_000),
			esplora(E2, ok(tx(elsewhere, at(800_000))), 800_000)
		);
		expect(await checkBtc(f)).toEqual(found('0', 1, iso(timeAt(800_000))));
	});
	it('N confirmations from the block height and the tip (the block itself counts)', async () => {
		for (const [tip, want] of [
			[800_000, 1],
			[800_001, 2],
			[800_002, 3],
			[800_009, 10]
		] as const) {
			const { f } = fetcher(
				esplora(E1, ok(tx(PAYS, at(800_000))), tip),
				esplora(E2, ok(tx(PAYS, at(800_000))), tip)
			);
			expect(await checkBtc(f)).toEqual(found('0.00025', want, iso(timeAt(800_000))));
		}
	});
	it('explorers on different heights: the higher block counts (fewer confirmations)', async () => {
		const { f } = fetcher(
			esplora(E1, ok(tx(PAYS, at(800_000))), 800_002),
			esplora(E2, ok(tx(PAYS, at(800_001))), 800_002)
		);
		expect((await checkBtc(f)).confirmations).toBe(2);
	});
	it('one explorer still sees it in the mempool: 0, with the block time the other gives', async () => {
		// The time is what dates the payment against the address share: one
		// explorer calling a mined transaction unconfirmed must not hide it.
		const { f } = fetcher(
			esplora(E1, ok(tx(PAYS, at(800_000))), 800_005),
			esplora(E2, ok(tx(PAYS, MEMPOOL)), 800_005)
		);
		expect(await checkBtc(f)).toEqual(found('0.00025', 0, iso(timeAt(800_000))));
	});
	it('in the mempool for every agreeing explorer: 0, and no time', async () => {
		const { f } = fetcher(
			esplora(E1, ok(tx(PAYS, MEMPOOL)), 800_005),
			esplora(E2, ok(tx(PAYS, MEMPOOL)), 800_005)
		);
		expect(await checkBtc(f)).toEqual(found('0.00025', 0));
	});
	it('confirmed but no tip from anyone: 1, all that "confirmed" proves', async () => {
		const { f } = fetcher(
			esplora(E1, ok(tx(PAYS, at(800_000)))),
			esplora(E2, ok(tx(PAYS, at(800_000))))
		);
		expect(await checkBtc(f)).toEqual(found('0.00025', 1, iso(timeAt(800_000))));
	});
	it('the LOWEST tip of the agreeing explorers counts, whichever answers first', async () => {
		for (const [t1, t2] of [
			[800_009, 800_002],
			[800_002, 800_009]
		] as const) {
			const { f } = fetcher(
				esplora(E1, ok(tx(PAYS, at(800_000))), t1),
				esplora(E2, ok(tx(PAYS, at(800_000))), t2)
			);
			expect((await checkBtc(f)).confirmations).toBe(3);
		}
	});
	it('an agreeing explorer that gives no tip: 1 — the others alone do not set the depth', async () => {
		for (const [t1, t2] of [
			[{ status: 500 } as Reply, 800_009],
			[800_009, { status: 429 } as Reply]
		] as const) {
			const { f } = fetcher(
				esplora(E1, ok(tx(PAYS, at(800_000))), t1),
				esplora(E2, ok(tx(PAYS, at(800_000))), t2)
			);
			expect((await checkBtc(f)).confirmations).toBe(1);
		}
	});
	it('a tip behind the block (a lagging explorer) still counts the block itself: 1', async () => {
		const { f } = fetcher(
			esplora(E1, ok(tx(PAYS, at(800_000))), 799_990),
			esplora(E2, ok(tx(PAYS, at(800_000))), 799_990)
		);
		expect((await checkBtc(f)).confirmations).toBe(1);
	});
	it('confirmed without a block height (or time): 1, and the time the other gives', async () => {
		const { f } = fetcher(
			esplora(E1, ok(tx(PAYS, { confirmed: true })), 800_005),
			esplora(E2, ok(tx(PAYS, at(800_000))), 800_005)
		);
		expect(await checkBtc(f)).toEqual(found('0.00025', 1, iso(timeAt(800_000))));
	});
	it('a fractional or negative "satoshi" value is not an amount', async () => {
		const odd = [
			{ value: 1.5, scriptpubkey_address: ADDR },
			{ value: -7, scriptpubkey_address: ADDR },
			{ value: '9', scriptpubkey_address: ADDR },
			null as unknown as Out,
			{ value: 25_000, scriptpubkey_address: ADDR }
		];
		const { f } = fetcher(esplora(E1, ok(tx(odd, MEMPOOL))), esplora(E2, ok(tx(odd, MEMPOOL))));
		expect(await checkBtc(f)).toEqual(found('0.00025', 0));
	});
});

describe('BTC — the block time (tx_time)', () => {
	it('the EARLIEST block time the agreeing explorers give', async () => {
		for (const [a, b] of [
			[timeAt(800_000), timeAt(800_000) + 3_600],
			[timeAt(800_000) + 3_600, timeAt(800_000)]
		] as const) {
			const { f } = fetcher(
				esplora(E1, ok(tx(PAYS, at(800_000, a))), 800_002),
				esplora(E2, ok(tx(PAYS, at(800_000, b))), 800_002)
			);
			expect(await checkBtc(f)).toEqual(found('0.00025', 3, iso(timeAt(800_000))));
		}
	});
	it("in the mempool an explorer's time is no block time, even if it sends one", async () => {
		const { f } = fetcher(
			esplora(E1, ok(tx(PAYS, { confirmed: false, block_time: timeAt(800_000) }))),
			esplora(E2, ok(tx(PAYS, { confirmed: false, block_time: timeAt(800_000) })))
		);
		expect(await checkBtc(f)).toEqual(found('0.00025', 0));
	});
	it('an agreeing explorer without a (valid) block time: the time the other gives', async () => {
		for (const bad of [undefined, 0, -5, 1.5, 1e300]) {
			const { f } = fetcher(
				esplora(E1, ok(tx(PAYS, at(800_000))), 800_002),
				esplora(E2, ok(tx(PAYS, { ...at(800_000, undefined), block_time: bad })), 800_002)
			);
			expect(await checkBtc(f)).toEqual(found('0.00025', 3, iso(timeAt(800_000))));
		}
		// None gives a valid one: no time.
		const none = fetcher(
			esplora(E1, ok(tx(PAYS, { ...at(800_000, undefined), block_time: 1.5 })), 800_002),
			esplora(E2, ok(tx(PAYS, { ...at(800_000, undefined), block_time: -5 })), 800_002)
		);
		expect(await checkBtc(none.f)).toEqual(found('0.00025', 3));
	});
	it('a time from an explorer outside the agreeing quorum is not used', async () => {
		const E3 = 'https://esplora-three.example/api';
		const less = [{ value: 20_000, scriptpubkey_address: ADDR }];
		const { f } = fetcher(
			esplora(E3, ok(tx(less, at(800_000, timeAt(799_000)))), 800_002),
			esplora(E1, ok(tx(PAYS, at(800_000))), 800_002),
			esplora(E2, ok(tx(PAYS, at(800_000))), 800_002)
		);
		const r = await checkBtc(f, { btcExplorerUrls: [E3, E1, E2] });
		expect(r).toEqual(found('0.00025', 3, iso(timeAt(800_000))));
	});
});

describe('the block time when explorers disagree about it (v1.21.17)', () => {
	const disputed = (amount: string, confirmations: number) => ({
		...found(amount, confirmations),
		txTimeDisputed: true
	});
	it('BTC: one explorer copying the amount but claiming 1970 cannot make it "old" — disputed, no time', async () => {
		for (const lie of [1, timeAt(800_000) - 3 * 3600]) {
			const { f } = fetcher(
				esplora(E1, ok(tx(PAYS, at(800_000))), 800_002),
				esplora(E2, ok(tx(PAYS, at(800_000, lie))), 800_002)
			);
			expect(await checkBtc(f)).toEqual(disputed('0.00025', 3));
		}
	});
	it('BTC: an hours-old block time next to an explorer that still has it in its mempool is disputed', async () => {
		const { f } = fetcher(
			esplora(E1, ok(tx(PAYS, at(800_000, timeAt(800_000) - 5 * 3600))), 800_005),
			esplora(E2, ok(tx(PAYS, MEMPOOL)), 800_005)
		);
		expect(await checkBtc(f)).toEqual(disputed('0.00025', 0));
	});
	it('BTC: times within the slack agree — the earliest is given', async () => {
		const { f } = fetcher(
			esplora(E1, ok(tx(PAYS, at(800_000))), 800_002),
			esplora(E2, ok(tx(PAYS, at(800_000, timeAt(800_000) - 90 * 60))), 800_002)
		);
		expect(await checkBtc(f)).toEqual(found('0.00025', 3, iso(timeAt(800_000) - 90 * 60)));
	});
	it('XMR: a source claiming an ancient block time against the others is disputed, not "old"', async () => {
		const { f } = fetcher(
			txprove(X1, { confirmations: 5, timestamp: 1 }),
			node(N1, SUB, { confirmations: 5 })
		);
		expect(await checkXmr(f, [X1, N1])).toEqual(disputed('0.00078125', 5));
	});
});

describe('BTC — a transaction that spends from the address is no payment to it', () => {
	const change = [
		{ value: 900_000, scriptpubkey_address: OTHER_ADDR },
		{ value: 25_000, scriptpubkey_address: ADDR }
	];
	it("the owner's own spend (change back to the address): amount 0", async () => {
		const own = tx(change, at(800_000), TXID, [input(SENDER), input(ADDR)]);
		const { f } = fetcher(esplora(E1, ok(own), 800_002), esplora(E2, ok(own), 800_002));
		expect(await checkBtc(f)).toEqual(found('0', 3, iso(timeAt(800_000))));
	});
	it('the same outputs from someone else: the amount counts', async () => {
		const paid = tx(change, at(800_000));
		const { f } = fetcher(esplora(E1, ok(paid), 800_002), esplora(E2, ok(paid), 800_002));
		expect((await checkBtc(f)).amount).toBe('0.00025');
	});
	it('a coinbase input (prevout null) is from nobody', async () => {
		const coinbase = tx(change, at(800_000), TXID, [
			{ txid: '00'.repeat(32), vout: 4294967295, is_coinbase: true, prevout: null }
		]);
		const { f } = fetcher(esplora(E1, ok(coinbase), 800_002), esplora(E2, ok(coinbase), 800_002));
		expect((await checkBtc(f)).amount).toBe('0.00025');
	});
	it('inputs that cannot be read (no vin, or an input without its prevout): no answer', async () => {
		const noVin: Record<string, unknown> = tx(change, at(800_000));
		delete noVin.vin;
		for (const vin of ['none', 'x', [null], [{ txid: 'ee'.repeat(32), vout: 0 }]]) {
			const odd = vin === 'none' ? noVin : tx(change, at(800_000), TXID, vin);
			const { f } = fetcher(esplora(E1, ok(odd), 800_002), esplora(E2, ok(odd), 800_002));
			expect((await checkBtc(f)).status).toBe('unavailable');
		}
	});
	it('one explorer hiding the own-spend input does not make the change a payment', async () => {
		const own = tx(change, at(800_000), TXID, [input(SENDER), input(ADDR)]);
		const hidden = tx(change, at(800_000));
		const { f } = fetcher(esplora(E1, ok(hidden), 800_002), esplora(E2, ok(own), 800_002));
		expect((await checkBtc(f)).status).toBe('unavailable');
	});
});

describe('BTC — when the explorers give no verdict', () => {
	const NOT_FOUND: Reply = { status: 404, text: 'Transaction not found' };
	const NOT_FOUND_JSON: Reply = {
		status: 404,
		json: { error: 'No such mempool or blockchain transaction' }
	};
	const CAPTCHA: Reply = {
		status: 404,
		text: '<html><body>Please complete the captcha</body></html>'
	};
	const UNAVAILABLE = { status: 'unavailable', amount: null, confirmations: null, txTime: null };

	it('both say "Transaction not found" (text or JSON): not_found', async () => {
		const { f } = fetcher(esplora(E1, NOT_FOUND), esplora(E2, NOT_FOUND_JSON));
		expect(await checkBtc(f)).toEqual({
			status: 'not_found',
			amount: null,
			confirmations: null,
			txTime: null
		});
	});
	it('a captcha / HTML 404 is not "not found": unavailable', async () => {
		const { f } = fetcher(esplora(E1, CAPTCHA), esplora(E2, CAPTCHA));
		expect(await checkBtc(f)).toEqual(UNAVAILABLE);
	});
	it('one "not found" and one captcha: short of the quorum, unavailable', async () => {
		const { f } = fetcher(esplora(E1, NOT_FOUND), esplora(E2, CAPTCHA));
		expect(await checkBtc(f)).toEqual(UNAVAILABLE);
	});
	it('two say not found but a third finds it: unavailable, not not_found', async () => {
		const E3 = 'https://esplora-three.example/api';
		const { f } = fetcher(
			esplora(E1, NOT_FOUND),
			esplora(E2, NOT_FOUND),
			esplora(E3, ok(tx(PAYS, MEMPOOL)))
		);
		// The finder answers first, so its answer is in before the two "not found".
		const slowFirst: typeof fetch = async (u, i) => {
			if (!String(u).startsWith(E3)) await new Promise((r) => setTimeout(r, 5));
			return f(u, i);
		};
		expect(await checkBtc(slowFirst, { btcExplorerUrls: [E3, E1, E2] })).toEqual(UNAVAILABLE);
	});
	it('one finds it, one says not found: unavailable', async () => {
		const { f } = fetcher(esplora(E1, ok(tx(PAYS, MEMPOOL))), esplora(E2, NOT_FOUND));
		expect(await checkBtc(f)).toEqual(UNAVAILABLE);
	});
	it('they disagree on the amount: unavailable', async () => {
		const less = [{ value: 20_000, scriptpubkey_address: ADDR }];
		const { f } = fetcher(esplora(E1, ok(tx(PAYS, MEMPOOL))), esplora(E2, ok(tx(less, MEMPOOL))));
		expect(await checkBtc(f)).toEqual(UNAVAILABLE);
	});
	it('one explorer alone (the other down) is not a quorum: unavailable', async () => {
		const { f } = fetcher(esplora(E1, ok(tx(PAYS, MEMPOOL))), esplora(E2, 'throw'));
		expect(await checkBtc(f)).toEqual(UNAVAILABLE);
	});
	it('all down, 5xx or rate-limited: unavailable', async () => {
		for (const r of ['throw', { status: 502, text: 'bad gateway' }, { status: 429 }] as Reply[]) {
			const { f } = fetcher(esplora(E1, r), esplora(E2, r));
			expect(await checkBtc(f)).toEqual(UNAVAILABLE);
		}
	});
	it('one "not found" and one rate-limited / down: unavailable, never not_found', async () => {
		for (const r of [
			'throw',
			{ status: 503 },
			{ status: 429, text: 'Too Many Requests' }
		] as Reply[]) {
			const { f } = fetcher(esplora(E1, NOT_FOUND), esplora(E2, r));
			expect(await checkBtc(f)).toEqual(UNAVAILABLE);
		}
	});
	it('one finds it, the other is rate-limited: unavailable, never found', async () => {
		const { f } = fetcher(esplora(E1, ok(tx(PAYS, MEMPOOL))), esplora(E2, { status: 429 }));
		expect(await checkBtc(f)).toEqual(UNAVAILABLE);
	});
	it('explorers that do not answer in time: unavailable', async () => {
		const hang = (async (_u: Parameters<typeof fetch>[0], init?: RequestInit) =>
			new Promise<Response>((_res, rej) => {
				init?.signal?.addEventListener('abort', () =>
					rej(new DOMException('aborted', 'AbortError'))
				);
			})) as typeof fetch;
		const v = new BitcoinExplorerFeeVerifier(
			{
				feeAddress: '',
				explorerUrls: [E1, E2],
				minConfirmations: 1,
				requestTimeoutMs: 30,
				minSuccessfulResponses: 2,
				privateLookups: true
			},
			hang
		);
		expect(await v.lookupPayment(TXID, ADDR)).toEqual({ kind: 'no_answer' });
	});
	it('explorers in their rate-limit cooldown are not asked: unavailable', async () => {
		const { f, calls } = fetcher(esplora(E1, { status: 429 }), esplora(E2, { status: 429 }));
		const checker = buildPaymentChecker(baseConfig, f);
		expect(await checker.check(btcQ)).toEqual(UNAVAILABLE);
		const asked = calls.length;
		expect(await checker.check(btcQ)).toEqual(UNAVAILABLE);
		expect(calls.length).toBe(asked);
	});
	it('an answer about another txid does not count', async () => {
		const swapped = tx(PAYS, MEMPOOL, 'cd'.repeat(32));
		const { f } = fetcher(esplora(E1, ok(swapped)), esplora(E2, ok(swapped)));
		expect(await checkBtc(f)).toEqual(UNAVAILABLE);
	});
	it('no explorer configured: unavailable, nothing fetched', async () => {
		const { f, calls } = fetcher();
		expect(await checkBtc(f, { btcExplorerUrls: [] })).toEqual(UNAVAILABLE);
		expect(calls).toHaveLength(0);
	});
});

describe('BTC — tiers and transport', () => {
	const pays = ok(tx(PAYS, MEMPOOL));
	const urls = [ONION1, ONION2, E1, E2];

	it('the onion explorers answer: no clearnet explorer is asked', async () => {
		const { f, calls } = fetcher(
			esplora(ONION1, pays),
			esplora(ONION2, pays),
			esplora(E1, pays),
			esplora(E2, pays)
		);
		expect((await checkBtc(f, { btcExplorerUrls: urls })).status).toBe('found');
		expect(calls.every((c) => c.url.includes('.onion/'))).toBe(true);
	});
	it('the onion explorers cannot answer: the clearnet tier is asked', async () => {
		const { f, calls } = fetcher(
			esplora(ONION1, 'throw'),
			esplora(ONION2, 'throw'),
			esplora(E1, pays),
			esplora(E2, pays)
		);
		expect((await checkBtc(f, { btcExplorerUrls: urls })).status).toBe('found');
		expect(calls.some((c) => c.url.startsWith(E1))).toBe(true);
	});
	it('a zero-clearnet node never asks a clearnet explorer, even when the onions fail', async () => {
		const { f, calls } = fetcher(
			esplora(ONION1, 'throw'),
			esplora(ONION2, 'throw'),
			esplora(E1, pays),
			esplora(E2, pays)
		);
		const r = await checkBtc(f, {
			btcExplorerUrls: urls,
			blurtRpcEndpoints: [],
			hiddenRpcEndpoints: [`http://${'c'.repeat(56)}.onion`]
		});
		expect(r.status).toBe('unavailable');
		expect(calls.length).toBeGreaterThan(0);
		expect(calls.every((c) => c.url.includes('.onion/'))).toBe(true);
	});
	it('a "not found" verdict from the onion tier stands', async () => {
		const nf: Reply = { status: 404, text: 'Transaction not found' };
		const { f, calls } = fetcher(
			esplora(ONION1, nf),
			esplora(ONION2, nf),
			esplora(E1, pays),
			esplora(E2, pays)
		);
		expect((await checkBtc(f, { btcExplorerUrls: urls })).status).toBe('not_found');
		expect(calls.every((c) => c.url.includes('.onion/'))).toBe(true);
	});
	it('no redirect is followed and the agent names no runtime', async () => {
		const { f, calls } = fetcher(esplora(E1, pays), esplora(E2, pays));
		await checkBtc(f);
		for (const c of calls) {
			expect(c.init?.redirect).toBe('manual');
			expect((c.init?.headers as Record<string, string>)['user-agent']).toBe(
				'morphit-indexer/fee-verify'
			);
		}
	});
});

/** The time of the top block in the XMR stubs (unix seconds). */
const XT = 1_790_000_000;
/** monerod at `spec` holding vector `v` (see xmrNodeSource.test.ts). */
function node(
	spec: string,
	v: { tx: Record<string, unknown>; txid: string },
	o: { confirmations?: number; inPool?: boolean; missed?: boolean; blockTimestamp?: unknown } = {}
): Route {
	const base = spec.slice('node+'.length);
	return (url) => {
		if (url !== `${base}/get_transactions`) return undefined;
		if (o.missed) return { json: { status: 'OK', untrusted: false, missed_tx: [v.txid] } };
		const entry: Record<string, unknown> = {
			tx_hash: v.txid,
			as_json: JSON.stringify(v.tx),
			in_pool: o.inPool === true
		};
		if (o.inPool !== true) {
			entry.confirmations = o.confirmations ?? 5;
			// monerod: the block's time, two minutes a block.
			entry.block_timestamp =
				'blockTimestamp' in o ? o.blockTimestamp : XT - ((entry.confirmations as number) - 1) * 120;
		} else {
			entry.received_timestamp = XT + 60;
		}
		return { json: { status: 'OK', untrusted: false, txs: [entry] } };
	};
}
/** An onion-monero-blockchain-explorer at `base` serving `v`'s raw transaction
 *  (`/api/rawtransaction`) and its page (`/api/transaction`: depth, timestamp).
 *  A trade payment's key is never sent to it (v1.21.17): its `/api/outputs`
 *  tx-key proof would throw here. `confirmations: undefined` leaves the depth
 *  out; `timestamp: undefined` the time. */
function txprove(
	base: string,
	o: {
		raw?: Reply;
		confirmations?: unknown;
		timestamp?: unknown;
		v?: { tx: Record<string, unknown>; txid: string };
	} = {}
): Route {
	const v = o.v ?? SUB;
	return (url) => {
		if (url === `${base}/api/rawtransaction/${v.txid}`)
			return o.raw ?? { json: { status: 'success', data: v.tx } };
		if (url === `${base}/api/transaction/${v.txid}`) {
			const confirmations = 'confirmations' in o ? o.confirmations : 5;
			const timestamp = 'timestamp' in o ? o.timestamp : XT - 4 * 120;
			return {
				json: {
					status: 'success',
					data: {
						tx_hash: v.txid,
						...(confirmations === undefined ? {} : { confirmations }),
						...(timestamp === undefined ? {} : { timestamp })
					}
				}
			};
		}
		if (url.startsWith(`${base}/api/outputs?`)) return 'throw';
		return undefined;
	};
}
const xmrQ = (o: Partial<PaymentQuery> = {}): PaymentQuery => ({
	asset: 'xmr',
	txid: SUB.txid,
	address: V.treasury.subaddress,
	txKey: SUB.tx_key,
	...o
});
const checkXmr = (f: typeof fetch, urls: string[], q: PaymentQuery = xmrQ()) =>
	buildPaymentChecker({ ...baseConfig, xmrExplorerUrls: urls }, f).check(q);

describe('XMR — the tx key proves the payment', () => {
	it('two nodes serve the transaction; the key proves 0.00078125 XMR to the subaddress', async () => {
		const { f, calls } = fetcher(node(N1, SUB), node(N2, SUB, { confirmations: 2 }));
		expect(await checkXmr(f, [N1, N2])).toEqual(found('0.00078125', 2, iso(XT - 4 * 120)));
		// A node is sent the txid only, never the key.
		expect(JSON.stringify(calls).includes(SUB.tx_key)).toBe(false);
	});
	it('in the pool: 0 confirmations (a block time only from a source that has it mined)', async () => {
		const { f } = fetcher(node(N1, SUB, { inPool: true }), node(N2, SUB));
		expect(await checkXmr(f, [N1, N2])).toEqual(found('0.00078125', 0, iso(XT - 4 * 120)));
		// In the pool for both: the receive time is no block time.
		const pool = fetcher(node(N1, SUB, { inPool: true }), node(N2, SUB, { inPool: true }));
		expect(await checkXmr(pool.f, [N1, N2])).toEqual(found('0.00078125', 0));
	});
	it("another transaction's key proves nothing: found, amount 0", async () => {
		const { f } = fetcher(node(N1, SUB), node(N2, SUB));
		expect(await checkXmr(f, [N1, N2], xmrQ({ txKey: OTHER_VECTOR.tx_key }))).toEqual(
			found('0', 5, iso(XT - 4 * 120))
		);
	});
	it('txprove explorers: the raw transaction is proven HERE — the key and the address are never sent (v1.21.17)', async () => {
		const { f, calls } = fetcher(
			txprove(X1, { confirmations: 1, timestamp: XT }),
			txprove(X2, { confirmations: 1, timestamp: XT })
		);
		expect(await checkXmr(f, [X1, X2])).toEqual(found('0.00078125', 1, iso(XT)));
		expect(calls.some((c) => c.url.includes('/api/outputs'))).toBe(false);
		const sent = JSON.stringify(calls);
		expect(sent.includes(SUB.tx_key)).toBe(false);
		expect(sent.includes(V.treasury.subaddress)).toBe(false);
	});
	it('txprove "Cant find tx hash" from both, or nodes that missed it: not_found', async () => {
		const fail: Reply = { json: { status: 'fail', data: { title: 'Cant find tx hash' } } };
		expect(
			(await checkXmr(fetcher(txprove(X1, { raw: fail }), txprove(X2, { raw: fail })).f, [X1, X2]))
				.status
		).toBe('not_found');
		expect(
			(
				await checkXmr(
					fetcher(node(N1, SUB, { missed: true }), node(N2, SUB, { missed: true })).f,
					[N1, N2]
				)
			).status
		).toBe('not_found');
	});
	it('a 404 page in front of the explorer is not "not found": unavailable', async () => {
		const page: Reply = { status: 404, text: '<html>Not Found</html>' };
		expect(
			(await checkXmr(fetcher(txprove(X1, { raw: page }), txprove(X2, { raw: page })).f, [X1, X2]))
				.status
		).toBe('unavailable');
	});
	it('one "Cant find tx hash" and one 404 page: short of the quorum, unavailable', async () => {
		const fail: Reply = { json: { status: 'fail', data: { title: 'Cant find tx hash' } } };
		const page: Reply = { status: 404, text: '<html>Not Found</html>' };
		expect(
			(await checkXmr(fetcher(txprove(X1, { raw: fail }), txprove(X2, { raw: page })).f, [X1, X2]))
				.status
		).toBe('unavailable');
	});
	it('no source says how deep (or says nonsense): no answer yet, never a depth', async () => {
		const { f } = fetcher(
			txprove(X1, { confirmations: undefined }),
			txprove(X2, { confirmations: -1 })
		);
		expect((await checkXmr(f, [X1, X2])).status).toBe('unavailable');
	});
	it('one source alone is not a quorum: unavailable', async () => {
		const { f } = fetcher(node(N1, SUB), (u) =>
			u.startsWith('https://node-two') ? 'throw' : undefined
		);
		expect((await checkXmr(f, [N1, N2])).status).toBe('unavailable');
	});
	it('no tx key: unavailable, nothing fetched', async () => {
		const { f, calls } = fetcher(node(N1, SUB), node(N2, SUB));
		expect((await checkXmr(f, [N1, N2], xmrQ({ txKey: null }))).status).toBe('unavailable');
		expect(calls).toHaveLength(0);
	});
});

describe('XMR — depth and block time across sources', () => {
	const RAW = 'raw-tx+https://moneroblocks.info';
	/** moneroblocks.info serving SUB, mined at height 100 (depth `depth`). */
	const moneroblocks =
		(o: { depth?: number; timestamp?: unknown } = {}): Route =>
		(url) => {
			if (url === `https://moneroblocks.info/api/get_transaction_data/${SUB.txid}`)
				return { json: { status: 'OK', transaction_data: SUB.tx } };
			if (url === `https://moneroblocks.info/tx/${SUB.txid}`)
				return { text: '<html>Confirmations <a href="/block/100">100</a></html>' };
			if (url === 'https://moneroblocks.info/api/get_block_data/100')
				return {
					json: {
						status: 'OK',
						block_data: {
							result: {
								block_header: {
									height: 100,
									depth: o.depth ?? 4,
									...('timestamp' in o ? { timestamp: o.timestamp } : { timestamp: XT - 4 * 120 })
								},
								tx_hashes: [SUB.txid]
							}
						}
					}
				};
			return undefined;
		};
	it('txprove in the pool: tx_timestamp is the receive time, not a block time — none', async () => {
		const p = { confirmations: 0, timestamp: XT + 60 };
		const { f } = fetcher(txprove(X1, p), txprove(X2, p));
		expect(await checkXmr(f, [X1, X2])).toEqual(found('0.00078125', 0));
	});
	it('the earliest block time any agreeing source gives; none when none does', async () => {
		const { f } = fetcher(
			txprove(X1, { confirmations: 3, timestamp: XT - 2 * 120 }),
			node(N1, SUB, { confirmations: 3, blockTimestamp: XT - 2 * 120 + 7 })
		);
		expect(await checkXmr(f, [X1, N1])).toEqual(found('0.00078125', 3, iso(XT - 2 * 120)));
		// An explorer older than 2020-08 gives none: the node's time stands.
		const old = fetcher(
			txprove(X1, { confirmations: 3, timestamp: undefined }),
			node(N1, SUB, { confirmations: 3 })
		);
		expect(await checkXmr(old.f, [X1, N1])).toEqual(found('0.00078125', 3, iso(XT - 2 * 120)));
		const bad = fetcher(
			txprove(X1, { confirmations: 3, timestamp: XT }),
			node(N1, SUB, { confirmations: 3, blockTimestamp: 'yesterday' })
		);
		expect(await checkXmr(bad.f, [X1, N1])).toEqual(found('0.00078125', 3, iso(XT)));
		const neither = fetcher(
			txprove(X1, { confirmations: 3, timestamp: undefined }),
			node(N1, SUB, { confirmations: 3, blockTimestamp: 'yesterday' })
		);
		expect(await checkXmr(neither.f, [X1, N1])).toEqual(found('0.00078125', 3));
	});
	it("a raw-tx explorer: the block header's timestamp", async () => {
		const { f } = fetcher(moneroblocks({ depth: 4, timestamp: XT - 4 * 120 - 30 }), node(N1, SUB));
		expect(await checkXmr(f, [RAW, N1])).toEqual(found('0.00078125', 5, iso(XT - 4 * 120 - 30)));
		const none = fetcher(moneroblocks({ depth: 4, timestamp: undefined }), node(N1, SUB));
		expect(await checkXmr(none.f, [RAW, N1])).toEqual(found('0.00078125', 5, iso(XT - 4 * 120)));
	});
	it('a source that cannot tell the depth earns no agreement: another is asked (v1.21.17)', async () => {
		// Never "0 confirmations, no block time" (that would let an old payment
		// pass as a fresh one) — and one such source must not block every
		// answer either: it simply does not count.
		const alone = fetcher(
			txprove(X1, { confirmations: undefined }),
			node(N1, SUB, { confirmations: 9 })
		);
		expect((await checkXmr(alone.f, [X1, N1])).status).toBe('unavailable');
		const { f } = fetcher(
			txprove(X1, { confirmations: undefined }),
			node(N1, SUB, { confirmations: 9 }),
			node(N2, SUB, { confirmations: 5 })
		);
		expect(await checkXmr(f, [X1, N1, N2])).toEqual(found('0.00078125', 5, iso(XT - 8 * 120)));
	});
	it('rate-limited, failing or busy sources: unavailable, never found or not_found', async () => {
		const fail: Reply = { json: { status: 'fail', data: { title: 'Cant find tx hash' } } };
		const busy: Route = (u) =>
			u.startsWith('https://node-two.example') ? { json: { status: 'BUSY' } } : undefined;
		const untrusted: Route = (u) =>
			u.startsWith('https://node-two.example')
				? { json: { status: 'OK', untrusted: true, missed_tx: [SUB.txid] } }
				: undefined;
		const r429: Route = (u) =>
			u.startsWith('https://node-two.example') ? { status: 429 } : undefined;
		for (const [routes, urls] of [
			[
				[txprove(X1, { raw: { status: 429 } }), txprove(X2, { raw: { status: 429 } })],
				[X1, X2]
			],
			[
				[txprove(X1, { raw: fail }), txprove(X2, { raw: { status: 429 } })],
				[X1, X2]
			],
			[
				[txprove(X1, { raw: fail }), txprove(X2, { raw: { status: 503 } })],
				[X1, X2]
			],
			[
				[node(N1, SUB, { missed: true }), r429],
				[N1, N2]
			],
			[
				[node(N1, SUB, { missed: true }), busy],
				[N1, N2]
			],
			[
				[node(N1, SUB, { missed: true }), untrusted],
				[N1, N2]
			],
			[
				[node(N1, SUB), r429],
				[N1, N2]
			]
		] as [Route[], string[]][]) {
			const r = await checkXmr(fetcher(...routes).f, urls);
			expect(r.status).toBe('unavailable');
		}
	});
	it('sources that do not answer in time: unavailable', async () => {
		const hang = (async (_u: Parameters<typeof fetch>[0], init?: RequestInit) =>
			new Promise<Response>((_res, rej) => {
				init?.signal?.addEventListener('abort', () =>
					rej(new DOMException('aborted', 'AbortError'))
				);
			})) as typeof fetch;
		const v = new MoneroProofFeeVerifier(
			{
				feeAddress: '',
				explorerUrls: [X1, N1],
				minConfirmations: 1,
				requestTimeoutMs: 30,
				minSuccessfulResponses: 2,
				privateLookups: true
			},
			hang
		);
		expect(await v.lookupPayment(SUB.txid, V.treasury.subaddress, SUB.tx_key)).toEqual({
			kind: 'no_answer'
		});
	});
});

describe('XMR — a tx key with additional keys (subaddress among several destinations)', () => {
	/** An onion-monero-blockchain-explorer serving the raw tx and its page. */
	function explorer(
		base: string,
		o: { raw?: Reply; confirmations?: unknown; timestamp?: unknown } = {}
	): Route {
		return (url) => {
			if (url === `${base}/api/rawtransaction/${ADD.txid}`)
				return o.raw ?? { json: { status: 'success', data: ADD.tx } };
			if (url === `${base}/api/transaction/${ADD.txid}`)
				return {
					json: {
						status: 'success',
						data: {
							tx_hash: ADD.txid,
							...(o.confirmations === undefined ? {} : { confirmations: o.confirmations }),
							timestamp: 'timestamp' in o ? o.timestamp : XT - 4 * 120
						}
					}
				};
			if (url.startsWith(`${base}/api/outputs?`)) return 'throw';
			return undefined;
		};
	}
	const q = (txKey: string): PaymentQuery => ({
		asset: 'xmr',
		txid: ADD.txid,
		address: ADD.dest,
		txKey
	});
	const amount = formatCoinAmount(ADD_AMOUNT, 12);

	it('the vector: the full key is main + one per output, paying the subaddress', () => {
		expect(ADD.dest).toBe(V.treasury.subaddress);
		expect(ADD.tx_key_full).toHaveLength(64 * (1 + ADD.tx.vout.length));
		expect(ADD_AMOUNT).toBeGreaterThan(0n);
	});
	it('nodes: the full key proves the payment; the main key alone proves nothing', async () => {
		const { f } = fetcher(node(N1, ADD, { confirmations: 3 }), node(N2, ADD, { confirmations: 4 }));
		expect(await checkXmr(f, [N1, N2], q(ADD.tx_key_full))).toEqual(
			found(amount, 3, iso(XT - 3 * 120))
		);
		expect(await checkXmr(f, [N1, N2], q(ADD.tx_key))).toEqual(found('0', 3, iso(XT - 3 * 120)));
	});
	it('txprove explorers: the raw transaction is checked here; /api/outputs is never asked, the key never sent', async () => {
		const { f, calls } = fetcher(
			explorer(X1, { confirmations: 2 }),
			explorer(X2, { confirmations: 5 })
		);
		expect(await checkXmr(f, [X1, X2], q(ADD.tx_key_full))).toEqual(
			found(amount, 2, iso(XT - 4 * 120))
		);
		expect(calls.some((c) => c.url.includes('/api/outputs'))).toBe(false);
		const sent = JSON.stringify(calls);
		for (let k = 0; k < ADD.tx_key_full.length; k += 64) {
			expect(sent.includes(ADD.tx_key_full.slice(k, k + 64))).toBe(false);
		}
	});
	it("a depth given for another transaction is not this one's: no answer yet", async () => {
		const wrongPage: Route = (url) =>
			url.endsWith(`/api/transaction/${ADD.txid}`)
				? { json: { status: 'success', data: { tx_hash: SUB.txid, confirmations: 9 } } }
				: undefined;
		const { f } = fetcher(wrongPage, explorer(X1), explorer(X2));
		expect((await checkXmr(f, [X1, X2], q(ADD.tx_key_full))).status).toBe('unavailable');
	});
	it('the explorer cannot say how deep: no answer yet', async () => {
		const { f } = fetcher(explorer(X1), explorer(X2, { confirmations: 'many' }));
		expect((await checkXmr(f, [X1, X2], q(ADD.tx_key_full))).status).toBe('unavailable');
	});
	it('json_transaction without a (valid) timestamp: the depth stands, no time', async () => {
		const { f } = fetcher(
			explorer(X1, { confirmations: 2, timestamp: undefined }),
			explorer(X2, { confirmations: 5, timestamp: -1 })
		);
		expect(await checkXmr(f, [X1, X2], q(ADD.tx_key_full))).toEqual(found(amount, 2));
	});
	it('json_transaction in the pool: its timestamp is the receive time — no time', async () => {
		const { f } = fetcher(
			explorer(X1, { confirmations: 0, timestamp: XT }),
			explorer(X2, { confirmations: 0, timestamp: XT })
		);
		expect(await checkXmr(f, [X1, X2], q(ADD.tx_key_full))).toEqual(found(amount, 0));
	});
	it('"Cant find tx hash" from both: not_found', async () => {
		const fail: Reply = { json: { status: 'fail', data: { title: 'Cant find tx hash' } } };
		const { f } = fetcher(explorer(X1, { raw: fail }), explorer(X2, { raw: fail }));
		expect((await checkXmr(f, [X1, X2], q(ADD.tx_key_full))).status).toBe('not_found');
	});
	it('an explorer serving another transaction under this txid is no answer', async () => {
		const other: Reply = { json: { status: 'success', data: SUB.tx } };
		const { f } = fetcher(explorer(X1, { raw: other }), explorer(X2, { raw: other }));
		expect((await checkXmr(f, [X1, X2], q(ADD.tx_key_full))).status).toBe('unavailable');
	});
	it('an explorer error answer is no answer, not "not found"', async () => {
		const err: Reply = {
			json: { status: 'error', message: 'Faild parsing raw tx data into json' }
		};
		const { f } = fetcher(explorer(X1, { raw: err }), explorer(X2, { raw: err }));
		expect((await checkXmr(f, [X1, X2], q(ADD.tx_key_full))).status).toBe('unavailable');
	});
	it('a one-key payment is proven here too: /api/outputs is never asked, the key never sent (v1.21.17)', async () => {
		const { f, calls } = fetcher(
			txprove(X1, { confirmations: 1 }),
			txprove(X2, { confirmations: 1 })
		);
		expect((await checkXmr(f, [X1, X2])).status).toBe('found');
		expect(calls.some((c) => c.url.includes('/api/outputs'))).toBe(false);
		expect(JSON.stringify(calls).includes(SUB.tx_key)).toBe(false);
	});
});

describe('the checker itself', () => {
	it('a tier that throws is no verdict: the next tier is asked', async () => {
		const checker = new PaymentChecker({
			btc: [
				{
					lookupPayment: async () => {
						throw new Error('bug');
					}
				},
				{
					lookupPayment: async () => ({
						kind: 'found',
						amount: 25_000n,
						confirmations: 2,
						blockTime: timeAt(800_000)
					})
				}
			],
			xmr: []
		});
		expect(await checker.check(btcQ)).toEqual(found('0.00025', 2, iso(timeAt(800_000))));
	});
	it('the round deadline: the signal reaches the explorers, and no further tier is asked', async () => {
		const seen: (AbortSignal | undefined)[] = [];
		const ctl = new AbortController();
		const checker = new PaymentChecker({
			btc: [
				{
					lookupPayment: async (_t, _a, signal) => {
						seen.push(signal);
						ctl.abort();
						return { kind: 'no_answer' };
					}
				},
				{
					lookupPayment: async () => {
						seen.push(undefined);
						return { kind: 'found', amount: 1n, confirmations: 1, blockTime: null };
					}
				}
			],
			xmr: []
		});
		expect((await checker.check(btcQ, ctl.signal)).status).toBe('unavailable');
		expect(seen).toEqual([ctl.signal]);
	});
	it('the verifiers stop asking when the round is out of time (BTC and XMR)', async () => {
		const cfg = (explorerUrls: string[]) => ({
			feeAddress: '',
			explorerUrls,
			minConfirmations: 1,
			requestTimeoutMs: 1_000,
			minSuccessfulResponses: 2
		});
		const over = new AbortController();
		over.abort();
		const b = fetcher(
			esplora(E1, ok(tx(PAYS, at(800_000))), 800_002),
			esplora(E2, ok(tx(PAYS, at(800_000))), 800_002)
		);
		expect(
			await new BitcoinExplorerFeeVerifier(cfg([E1, E2]), b.f).lookupPayment(
				TXID,
				ADDR,
				over.signal
			)
		).toEqual({ kind: 'no_answer' });
		expect(b.calls).toHaveLength(0);
		const x = fetcher(node(N1, SUB), node(N2, SUB));
		expect(
			await new MoneroProofFeeVerifier(cfg([N1, N2]), x.f).lookupPayment(
				SUB.txid,
				V.treasury.subaddress,
				SUB.tx_key,
				over.signal
			)
		).toEqual({ kind: 'no_answer' });
		expect(x.calls).toHaveLength(0);
	});
	it('a lookup at depth 0 passes on the block time it carries (one explorer behind)', async () => {
		const checker = new PaymentChecker({
			btc: [
				{
					lookupPayment: async () => ({
						kind: 'found',
						amount: 25_000n,
						confirmations: 0,
						blockTime: timeAt(800_000)
					})
				}
			],
			xmr: []
		});
		expect(await checker.check(btcQ)).toEqual(found('0.00025', 0, iso(timeAt(800_000))));
	});
	it('lookupPayment gives no block time while every source has it in the pool (BTC and XMR)', async () => {
		const cfg = (explorerUrls: string[]) => ({
			feeAddress: '',
			explorerUrls,
			minConfirmations: 1,
			requestTimeoutMs: 1_000,
			minSuccessfulResponses: 2
		});
		const mempoolWithTime = ok(tx(PAYS, { confirmed: false, block_time: timeAt(800_000) }));
		const btc = new BitcoinExplorerFeeVerifier(
			cfg([E1, E2]),
			fetcher(esplora(E1, mempoolWithTime), esplora(E2, mempoolWithTime)).f
		);
		expect(await btc.lookupPayment(TXID, ADDR)).toEqual({
			kind: 'found',
			amount: 25_000n,
			confirmations: 0,
			blockTime: null
		});
		// In the pool: json_transaction's timestamp is the receive time.
		const pool = { confirmations: 0, timestamp: XT + 60 };
		const xmr = new MoneroProofFeeVerifier(
			cfg([X1, X2]),
			fetcher(txprove(X1, pool), txprove(X2, pool)).f
		);
		expect(await xmr.lookupPayment(SUB.txid, V.treasury.subaddress, SUB.tx_key)).toEqual({
			kind: 'found',
			amount: 781_250_000n,
			confirmations: 0,
			blockTime: null
		});
	});
	it('lookupPayment refuses a malformed txid or key before asking anyone', async () => {
		const { f, calls } = fetcher(esplora(E1, ok(tx(PAYS, MEMPOOL))), node(N1, SUB));
		const btc = new BitcoinExplorerFeeVerifier(
			{
				feeAddress: '',
				explorerUrls: [E1],
				minConfirmations: 1,
				requestTimeoutMs: 1_000,
				minSuccessfulResponses: 1
			},
			f
		);
		expect(await btc.lookupPayment(`${TXID.slice(1)}z`, ADDR)).toEqual({ kind: 'no_answer' });
		const xmr = new MoneroProofFeeVerifier(
			{
				feeAddress: '',
				explorerUrls: [N1],
				minConfirmations: 1,
				requestTimeoutMs: 1_000,
				minSuccessfulResponses: 1
			},
			f
		);
		expect(await xmr.lookupPayment(SUB.txid, V.treasury.subaddress, 'zz')).toEqual({
			kind: 'no_answer'
		});
		expect(await xmr.lookupPayment('zz', V.treasury.subaddress, SUB.tx_key)).toEqual({
			kind: 'no_answer'
		});
		expect(calls).toHaveLength(0);
	});
});

describe('nothing about the payment reaches the log', () => {
	let restore: (() => void) | null = null;
	afterEach(() => {
		restore?.();
		restore = null;
	});

	it('every BTC and XMR failure path logs the explorer, never the txid, address or key', async () => {
		const records: LogRecord[] = [];
		restore = setLogSink((r) => records.push(r));
		const btcReplies: Reply[] = [
			{ status: 404, text: 'Transaction not found' },
			{ status: 404, text: '<html>captcha</html>' },
			{ status: 503, text: 'down' },
			{ status: 429 },
			{ text: 'not json' },
			{ json: { nope: true } },
			ok(tx(PAYS, MEMPOOL, 'cd'.repeat(32))),
			'throw'
		];
		for (const r of btcReplies) {
			await checkBtc(fetcher(esplora(E1, r), esplora(E2, r)).f);
		}
		const xmrReplies: Reply[] = [
			{ status: 404, text: '<html>Not Found</html>' },
			{ status: 503 },
			{ status: 429 },
			{ text: 'not json' },
			{ json: { weird: 1 } },
			{ json: { status: 'error', data: { title: 'bad proof' } } },
			{ json: { status: 'success', data: { ...SUB.tx, version: 9 } } },
			'throw'
		];
		for (const r of xmrReplies) {
			await checkXmr(fetcher(txprove(X1, { raw: r }), txprove(X2, { raw: r })).f, [X1, X2]);
		}
		expect(records.length).toBeGreaterThan(10);
		const text = JSON.stringify(records).toLowerCase();
		for (const secret of [
			TXID,
			ADDR,
			SUB.txid,
			SUB.tx_key,
			V.treasury.subaddress,
			'cd'.repeat(32)
		]) {
			expect(text.includes(String(secret).toLowerCase())).toBe(false);
		}
		expect(text).toContain('esplora-one.example');
		expect(text).toContain('xmr-one.example');
	});
});
