/**
 * GET /v1/payment-check — the HTTP side (api/paymentCheck.ts): strict input,
 * the response shape, the in-memory cache and its one-round-per-question rule,
 * the instance-wide bounds, the per-client rate limit, and a log that never
 * holds a txid, address or tx key. The explorer side is in
 * test/indexer/fee/paymentLookup.test.ts; here the checker is a stub.
 *
 * Mounted exactly as main.ts mounts it: the security middleware, then the
 * `payment-check` rate-limit tier, then the route.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { keccak_256 } from '@noble/hashes/sha3';
import { moneroBase58Decode, moneroBase58Encode } from '@morphit/release-schema';

import {
	paymentCheckRoute,
	parsePaymentQuery,
	PAYMENT_CHECK_CACHE_MAX,
	PAYMENT_CHECK_FRESH_MS,
	PAYMENT_CHECK_KEEP_MS,
	PAYMENT_CHECK_MAX_IN_FLIGHT,
	PAYMENT_CHECK_MAX_IN_FLIGHT_PER_CLIENT,
	PAYMENT_CHECK_MAX_IN_FLIGHT_SHARED,
	PAYMENT_CHECK_RESERVED_FOR_KNOWN,
	PAYMENT_CHECK_ROUND_MS,
	PAYMENT_CHECK_RATE_PER_MIN,
	PAYMENT_CHECK_ROUNDS_PER_MIN,
	PAYMENT_CHECK_WAIT_MS,
	type PaymentCheckRouteDeps
} from '$api/paymentCheck';
import type { PaymentQuery, PaymentVerdict } from '$indexer/fee/paymentCheck';
import { rateLimit, _resetRateLimitForTest } from '$api/middleware/ratelimit';
import { security } from '$api/middleware/security';
import { setLogSink, type LogRecord } from '$log';

const V = JSON.parse(
	readFileSync(resolve(__dirname, '../fixtures/xmr-rawtx-vectors.json'), 'utf8')
);
const TXID = 'ab'.repeat(32);
const KEY = 'cd'.repeat(32);
const BTC = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const XMR_SUB: string = V.treasury.subaddress;
const XMR_PRIMARY: string = V.treasury.primary;

/** XMR_SUB re-encoded as a TESTNET subaddress (prefix 63), checksum and all. */
const XMR_TESTNET = (() => {
	const raw = moneroBase58Decode(XMR_SUB)!;
	const body = raw.slice(0, raw.length - 4);
	body[0] = 63;
	const full = new Uint8Array(body.length + 4);
	full.set(body, 0);
	full.set(keccak_256(body).slice(0, 4), body.length);
	return moneroBase58Encode(full);
})();

const MINED = '2026-10-26T11:50:00.000Z';
const FOUND: PaymentVerdict = {
	status: 'found',
	amount: '0.00025',
	confirmations: 1,
	txTime: MINED
};
const DEEP: PaymentVerdict = {
	status: 'found',
	amount: '0.00025',
	confirmations: 3,
	txTime: MINED
};
const NOT_FOUND: PaymentVerdict = {
	status: 'not_found',
	amount: null,
	confirmations: null,
	txTime: null
};
const UNAVAILABLE: PaymentVerdict = {
	status: 'unavailable',
	amount: null,
	confirmations: null,
	txTime: null
};

function mount(deps: PaymentCheckRouteDeps): Hono {
	const app = new Hono();
	app.use('*', security);
	const sub = new Hono();
	sub.use('*', rateLimit('payment-check', PAYMENT_CHECK_RATE_PER_MIN));
	sub.route('/', paymentCheckRoute(deps));
	app.route('/v1/payment-check', sub);
	return app;
}
let peer = 0;
/** A request from its own public client address unless one is given. */
function get(app: Hono, qs: string, client = `198.51.100.${(peer++ % 250) + 1}`) {
	return app.request(
		`/v1/payment-check?${qs}`,
		{},
		{ incoming: { socket: { remoteAddress: client } } }
	);
}
const btcQs = (txid = TXID, address = BTC) => `asset=btc&txid=${txid}&address=${address}`;
const xmrQs = (address = XMR_SUB, key = KEY) =>
	`asset=xmr&txid=${TXID}&address=${address}&tx_key=${key}`;

/** A checker stub that records its calls and answers `verdict`. */
function stub(verdict: PaymentVerdict | (() => Promise<PaymentVerdict>) = FOUND) {
	const calls: PaymentQuery[] = [];
	const check = async (q: PaymentQuery) => {
		calls.push(q);
		return typeof verdict === 'function' ? verdict() : verdict;
	};
	return { calls, check };
}
function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

beforeEach(() => _resetRateLimitForTest());

describe('input', () => {
	const bad: [string, string][] = [
		['no asset', `txid=${TXID}&address=${BTC}`],
		['asset in capitals', `asset=BTC&txid=${TXID}&address=${BTC}`],
		['another asset', `asset=eth&txid=${TXID}&address=${BTC}`],
		['txid 63 hex', btcQs('a'.repeat(63))],
		['txid 65 hex', btcQs('a'.repeat(65))],
		['txid not hex', btcQs('z'.repeat(64))],
		['no address', `asset=btc&txid=${TXID}`],
		['BTC address with a bad checksum', btcQs(TXID, `${BTC.slice(0, -1)}e`)],
		['an XMR address for btc', btcQs(TXID, XMR_SUB)],
		['a tx_key for btc', `${btcQs()}&tx_key=${KEY}`],
		['xmr without tx_key', `asset=xmr&txid=${TXID}&address=${XMR_SUB}`],
		['tx_key 63 hex', xmrQs(XMR_SUB, KEY.slice(1))],
		['tx_key not hex', xmrQs(XMR_SUB, 'z'.repeat(64))],
		['tx_key not a whole number of keys', xmrQs(XMR_SUB, KEY + KEY.slice(32))],
		['tx_key of 18 keys', xmrQs(XMR_SUB, KEY.repeat(18))],
		['tx_key with a space inside', xmrQs(XMR_SUB, `${KEY}%20${KEY}`)],
		['a BTC address for xmr', xmrQs(BTC)],
		['a testnet XMR address', xmrQs(XMR_TESTNET)],
		[
			'an XMR address with a bad checksum',
			xmrQs(`${XMR_SUB.slice(0, -1)}${XMR_SUB.endsWith('A') ? 'B' : 'A'}`)
		],
		['an XMR address padded with a space', xmrQs(`${XMR_SUB}%20`)],
		['an over-long address', btcQs(TXID, 'b'.repeat(129))],
		['an unknown parameter', `${btcQs()}&callback=x`],
		['a parameter twice', `${btcQs()}&txid=${TXID}`]
	];
	it.each(bad)('%s → 400, the input not repeated, nobody asked', async (_name, qs) => {
		const s = stub();
		const res = await get(mount({ check: s.check }), qs);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { status: string; code: string; message: string };
		expect(body.status).toBe('error');
		expect(body.code).toBe('bad_request');
		for (const v of [TXID, BTC, XMR_SUB, XMR_TESTNET, KEY, 'callback']) {
			expect(body.message.includes(v)).toBe(false);
		}
		expect(s.calls).toHaveLength(0);
	});

	it('the test XMR addresses parse (and only the testnet one is refused for its network)', () => {
		expect(
			parsePaymentQuery({ asset: ['xmr'], txid: [TXID], address: [XMR_SUB], tx_key: [KEY] })
		).not.toBeNull();
		expect(
			parsePaymentQuery({ asset: ['xmr'], txid: [TXID], address: [XMR_PRIMARY], tx_key: [KEY] })
		).not.toBeNull();
		expect(XMR_TESTNET).not.toBe(XMR_SUB);
		expect(XMR_TESTNET).toHaveLength(XMR_SUB.length);
	});

	it('tx_key: 17 keys (16 outputs to subaddresses) is the most, 18 is refused', () => {
		const q = (n: number) =>
			parsePaymentQuery({
				asset: ['xmr'],
				txid: [TXID],
				address: [XMR_SUB],
				tx_key: ['ab'.repeat(32 * n)]
			});
		expect(q(17)).not.toBeNull();
		expect(q(18)).toBeNull();
	});

	it('tx_key: the main key plus one per output (at most 16), trimmed and lowercased', () => {
		for (const n of [1, 2, 3, 16, 17]) {
			const key = 'Ab'.repeat(32 * n);
			expect(
				parsePaymentQuery({
					asset: ['xmr'],
					txid: [TXID],
					address: [XMR_SUB],
					tx_key: [` ${key}\n`]
				})?.txKey
			).toBe(key.toLowerCase());
		}
	});

	it('normalises: lowercase hex, lowercase bech32 (BIP173 allows all-capitals)', () => {
		expect(
			parsePaymentQuery({
				asset: ['btc'],
				txid: [TXID.toUpperCase()],
				address: [BTC.toUpperCase()]
			})
		).toEqual({ asset: 'btc', txid: TXID, address: BTC, txKey: null });
		expect(
			parsePaymentQuery({
				asset: ['xmr'],
				txid: [TXID],
				address: [XMR_SUB],
				tx_key: [KEY.toUpperCase()]
			})
		).toEqual({ asset: 'xmr', txid: TXID, address: XMR_SUB, txKey: KEY });
		// Base58 is case-sensitive: kept as given.
		const p2pkh = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa';
		expect(parsePaymentQuery({ asset: ['btc'], txid: [TXID], address: [p2pkh] })?.address).toBe(
			p2pkh
		);
	});
});

describe('the answer', () => {
	it('found: the documented shape, no-store', async () => {
		const s = stub(FOUND);
		const res = await get(
			mount({ check: s.check, clock: () => Date.UTC(2026, 9, 26, 12) }),
			btcQs(TXID.toUpperCase())
		);
		expect(res.status).toBe(200);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.json()).toEqual({
			asset: 'btc',
			txid: TXID,
			status: 'found',
			amount: '0.00025',
			confirmations: 1,
			tx_time: MINED,
			required_confirmations: 3,
			checked_at: '2026-10-26T12:00:00.000Z'
		});
		expect(s.calls).toEqual([{ asset: 'btc', txid: TXID, address: BTC, txKey: null }]);
	});
	it('found in the mempool: tx_time null', async () => {
		const res = await get(
			mount({ check: stub({ ...FOUND, confirmations: 0, txTime: null }).check }),
			btcQs()
		);
		expect(await res.json()).toMatchObject({ status: 'found', confirmations: 0, tx_time: null });
	});
	it('not_found / unavailable: amount, confirmations and tx_time null', async () => {
		for (const v of [NOT_FOUND, UNAVAILABLE]) {
			const res = await get(mount({ check: stub(v).check }), xmrQs());
			const body = (await res.json()) as Record<string, unknown>;
			expect(body).toMatchObject({
				asset: 'xmr',
				status: v.status,
				amount: null,
				confirmations: null,
				tx_time: null
			});
		}
	});
	it('a 400 is no-store too (its URL may carry a key)', async () => {
		const res = await get(mount({ check: stub().check }), 'asset=xmr');
		expect(res.headers.get('cache-control')).toBe('no-store');
	});
	it('a checker that throws: unavailable', async () => {
		const res = await get(
			mount({
				check: async () => {
					throw new Error('boom');
				}
			}),
			btcQs()
		);
		expect(((await res.json()) as { status: string }).status).toBe('unavailable');
	});
});

describe('the cache', () => {
	it('a fresh answer is reused; the explorers are asked again once it is stale', async () => {
		let now = 1_000_000;
		const s = stub(FOUND);
		const app = mount({ check: s.check, clock: () => now });
		await get(app, btcQs());
		await get(app, btcQs());
		expect(s.calls).toHaveLength(1);
		now += PAYMENT_CHECK_FRESH_MS.confirming - 1;
		await get(app, btcQs());
		expect(s.calls).toHaveLength(1);
		now += 1;
		await get(app, btcQs());
		expect(s.calls).toHaveLength(2);
	});
	it('the key is the whole query: another address or key is another question', async () => {
		const s = stub(FOUND);
		const app = mount({ check: s.check });
		await get(app, xmrQs());
		await get(app, xmrQs(XMR_PRIMARY));
		await get(app, xmrQs(XMR_SUB, 'ef'.repeat(32)));
		expect(s.calls).toHaveLength(3);
	});
	it('a confirmed answer is kept longer than one still confirming', async () => {
		let now = 1_000_000;
		const s = stub(DEEP);
		const app = mount({ check: s.check, clock: () => now });
		await get(app, btcQs());
		now += PAYMENT_CHECK_FRESH_MS.confirming + 1;
		await get(app, btcQs());
		expect(s.calls).toHaveLength(1);
		expect(PAYMENT_CHECK_FRESH_MS.confirmed).toBeGreaterThan(PAYMENT_CHECK_FRESH_MS.confirming);
	});
	it('a stale answer is served at once while it is re-checked, with its own checked_at', async () => {
		let now = 1_000_000;
		let verdict: PaymentVerdict = FOUND;
		const gate = deferred<void>();
		let gated = false;
		const s = stub(async () => {
			if (gated) await gate.promise;
			return verdict;
		});
		const app = mount({ check: s.check, clock: () => now });
		await get(app, btcQs());
		now += PAYMENT_CHECK_FRESH_MS.confirming + 5;
		gated = true;
		verdict = DEEP;
		const stale = (await (await get(app, btcQs())).json()) as Record<string, unknown>;
		expect(stale.confirmations).toBe(1);
		expect(stale.checked_at).toBe(new Date(1_000_000).toISOString());
		expect(s.calls).toHaveLength(2);
		gate.resolve();
		await new Promise((r) => setTimeout(r, 0));
		const fresh = (await (await get(app, btcQs())).json()) as Record<string, unknown>;
		expect(fresh.confirmations).toBe(3);
		expect(s.calls).toHaveLength(2);
	});
	it('a re-check with no answer keeps the last verdict, until KEEP_MS', async () => {
		let now = 1_000_000;
		let verdict: PaymentVerdict = FOUND;
		const s = stub(async () => verdict);
		const app = mount({ check: s.check, clock: () => now, waitMs: 50 });
		await get(app, btcQs());
		verdict = UNAVAILABLE;
		now += PAYMENT_CHECK_FRESH_MS.confirming + 1;
		await get(app, btcQs()); // stale served, re-check gets no answer
		await new Promise((r) => setTimeout(r, 0));
		const kept = (await (await get(app, btcQs())).json()) as Record<string, unknown>;
		expect(kept.status).toBe('found');
		expect(kept.checked_at).toBe(new Date(1_000_000).toISOString());
		now = 1_000_000 + PAYMENT_CHECK_KEEP_MS + 1;
		const later = (await (await get(app, btcQs())).json()) as Record<string, unknown>;
		expect(later.status).toBe('unavailable');
		// …and the verdict that old is gone, not kept for the next poll either.
		const next = (await (await get(app, btcQs())).json()) as Record<string, unknown>;
		expect(next.status).toBe('unavailable');
	});
	it('a new verdict replaces the old one (a dropped BTC transaction shows as not_found)', async () => {
		let now = 1_000_000;
		let verdict: PaymentVerdict = FOUND;
		const app = mount({ check: stub(async () => verdict).check, clock: () => now });
		await get(app, btcQs());
		verdict = NOT_FOUND;
		now += PAYMENT_CHECK_FRESH_MS.confirming + 1;
		await get(app, btcQs());
		await new Promise((r) => setTimeout(r, 0));
		expect(((await (await get(app, btcQs())).json()) as { status: string }).status).toBe(
			'not_found'
		);
	});
	it('holds at most PAYMENT_CHECK_CACHE_MAX answers, dropping the oldest', async () => {
		let now = 1_000_000;
		const s = stub(DEEP);
		const app = mount({ check: s.check, clock: () => now });
		const txid = (i: number) => i.toString(16).padStart(64, '0');
		for (let i = 0; i <= PAYMENT_CHECK_CACHE_MAX; i++) {
			if (i % PAYMENT_CHECK_ROUNDS_PER_MIN === 0) now += 60_000;
			await get(app, btcQs(txid(i)));
		}
		expect(s.calls).toHaveLength(PAYMENT_CHECK_CACHE_MAX + 1);
		now += 60_000;
		await get(app, btcQs(txid(PAYMENT_CHECK_CACHE_MAX))); // newest: still cached
		expect(s.calls).toHaveLength(PAYMENT_CHECK_CACHE_MAX + 1);
		// Oldest: dropped, so asked afresh and answered as of now — not served
		// stale from the cache (it is still within KEEP_MS, which would).
		const oldest = (await (await get(app, btcQs(txid(0)))).json()) as { checked_at: string };
		expect(s.calls).toHaveLength(PAYMENT_CHECK_CACHE_MAX + 2);
		expect(oldest.checked_at).toBe(new Date(now).toISOString());
		expect(now - 1_000_000).toBeLessThan(PAYMENT_CHECK_KEEP_MS);
	});
});

describe('one round per question, and the instance-wide bounds', () => {
	it('concurrent requests for one question share one explorer round', async () => {
		const gate = deferred<PaymentVerdict>();
		const s = stub(() => gate.promise);
		const app = mount({ check: s.check });
		const pending = [get(app, btcQs()), get(app, btcQs()), get(app, btcQs())];
		await new Promise((r) => setTimeout(r, 0));
		gate.resolve(FOUND);
		const bodies = await Promise.all(pending.map(async (p) => (await p).json()));
		expect(s.calls).toHaveLength(1);
		for (const b of bodies) expect((b as { status: string }).status).toBe('found');
	});
	it('a round slower than the wait: unavailable now, the answer on the next poll', async () => {
		const gate = deferred<PaymentVerdict>();
		const s = stub(() => gate.promise);
		const app = mount({ check: s.check, waitMs: 20 });
		const first = (await (await get(app, btcQs())).json()) as Record<string, unknown>;
		expect(first.status).toBe('unavailable');
		gate.resolve(FOUND);
		await new Promise((r) => setTimeout(r, 0));
		const next = (await (await get(app, btcQs())).json()) as Record<string, unknown>;
		expect(next.status).toBe('found');
		expect(s.calls).toHaveLength(1);
	});
	it(`at most ${PAYMENT_CHECK_MAX_IN_FLIGHT} rounds at once: past it, unavailable without asking`, async () => {
		const gate = deferred<PaymentVerdict>();
		const s = stub(() => gate.promise);
		const app = mount({ check: s.check, waitMs: 5 });
		const txid = (i: number) => i.toString(16).padStart(64, '0');
		for (let i = 0; i < PAYMENT_CHECK_MAX_IN_FLIGHT; i++) await get(app, btcQs(txid(i)));
		expect(s.calls).toHaveLength(PAYMENT_CHECK_MAX_IN_FLIGHT);
		const over = (await (await get(app, btcQs(txid(99)))).json()) as { status: string };
		expect(over.status).toBe('unavailable');
		expect(s.calls).toHaveLength(PAYMENT_CHECK_MAX_IN_FLIGHT);
		gate.resolve(FOUND);
		await new Promise((r) => setTimeout(r, 0));
		await get(app, btcQs(txid(99)));
		expect(s.calls).toHaveLength(PAYMENT_CHECK_MAX_IN_FLIGHT + 1);
	});
	it(`at most ${PAYMENT_CHECK_ROUNDS_PER_MIN} rounds started a minute`, async () => {
		let now = 1_000_000;
		const s = stub(DEEP);
		const app = mount({ check: s.check, clock: () => now });
		const txid = (i: number) => i.toString(16).padStart(64, '0');
		for (let i = 0; i < PAYMENT_CHECK_ROUNDS_PER_MIN; i++) await get(app, btcQs(txid(i)));
		const over = (await (await get(app, btcQs(txid(9_999)))).json()) as { status: string };
		expect(over.status).toBe('unavailable');
		expect(s.calls).toHaveLength(PAYMENT_CHECK_ROUNDS_PER_MIN);
		// Known answers still cost nothing and are still served.
		expect(((await (await get(app, btcQs(txid(0)))).json()) as { status: string }).status).toBe(
			'found'
		);
		now += 60_000;
		await get(app, btcQs(txid(9_999)));
		expect(s.calls).toHaveLength(PAYMENT_CHECK_ROUNDS_PER_MIN + 1);
	});
});

describe('one client cannot hold every round (v1.21.17)', () => {
	const txid = (i: number) => i.toString(16).padStart(64, '0');
	it(`one client: at most ${PAYMENT_CHECK_MAX_IN_FLIGHT_PER_CLIENT} rounds of its own; others still asked`, async () => {
		const gate = deferred<PaymentVerdict>();
		const s = stub(() => gate.promise);
		const app = mount({ check: s.check, waitMs: 5 });
		const attacker = '203.0.113.7';
		for (let i = 0; i < 6; i++) await get(app, btcQs(txid(i)), attacker);
		expect(s.calls).toHaveLength(PAYMENT_CHECK_MAX_IN_FLIGHT_PER_CLIENT);
		await get(app, btcQs(txid(500)), '203.0.113.8');
		expect(s.calls).toHaveLength(PAYMENT_CHECK_MAX_IN_FLIGHT_PER_CLIENT + 1);
		gate.resolve(FOUND);
	});
	it(`the key for every Tor/I2P visitor: at most ${PAYMENT_CHECK_MAX_IN_FLIGHT_SHARED}`, async () => {
		const gate = deferred<PaymentVerdict>();
		const s = stub(() => gate.promise);
		const app = mount({
			check: s.check,
			waitMs: 5,
			clientOf: () => ({ key: 'tor', shared: true })
		});
		for (let i = 0; i < 8; i++) await get(app, btcQs(txid(i)));
		expect(s.calls).toHaveLength(PAYMENT_CHECK_MAX_IN_FLIGHT_SHARED);
		gate.resolve(FOUND);
	});
	it(`a question asked before gets one of ${PAYMENT_CHECK_RESERVED_FOR_KNOWN} kept rounds when the new ones are full`, async () => {
		let now = 1_000_000;
		const gates: ReturnType<typeof deferred<PaymentVerdict>>[] = [];
		const s = stub(() => {
			const g = deferred<PaymentVerdict>();
			gates.push(g);
			return g.promise;
		});
		const app = mount({ check: s.check, waitMs: 5, clock: () => now });
		// A seller's question, answered (not found yet) and gone stale.
		const first = get(app, btcQs(txid(9_000)));
		await new Promise((r) => setTimeout(r, 0));
		gates[0]!.resolve(NOT_FOUND);
		await first;
		now += 10 * 60_000;
		// Strangers fill every round for new questions.
		for (let i = 0; i < PAYMENT_CHECK_MAX_IN_FLIGHT; i++) await get(app, btcQs(txid(i)));
		const before = s.calls.length;
		await get(app, btcQs(txid(77_777)));
		expect(s.calls).toHaveLength(before);
		// The seller's next poll is still asked.
		await get(app, btcQs(txid(9_000)));
		expect(s.calls).toHaveLength(before + 1);
		for (const g of gates) g.resolve(FOUND);
	});
	it('a round is stopped at its deadline, and its slot is free again', async () => {
		let stopped: AbortSignal | undefined;
		const s = {
			calls: 0,
			check: (_q: PaymentQuery, signal?: AbortSignal) =>
				new Promise<PaymentVerdict>((resolve) => {
					s.calls++;
					stopped = signal;
					signal?.addEventListener('abort', () => resolve(UNAVAILABLE));
				})
		};
		const app = mount({ check: s.check, waitMs: 5, roundMs: 30 });
		const who = '203.0.113.9';
		await get(app, btcQs(txid(1)), who);
		await get(app, btcQs(txid(2)), who);
		await get(app, btcQs(txid(3)), who);
		expect(s.calls).toBe(PAYMENT_CHECK_MAX_IN_FLIGHT_PER_CLIENT);
		// The 30 ms round deadline fires on its own (no fake clock: the route's
		// own timer is what is under test).
		await vi.waitFor(() => expect(stopped?.aborted).toBe(true), { timeout: 2_000, interval: 5 });
		await get(app, btcQs(txid(3)), who);
		expect(s.calls).toBe(PAYMENT_CHECK_MAX_IN_FLIGHT_PER_CLIENT + 1);
	});
});

describe('the per-client rate limit (its own tier)', () => {
	it(`${PAYMENT_CHECK_RATE_PER_MIN} a minute per client, then 429 with Retry-After; others unaffected`, async () => {
		const app = mount({ check: stub(FOUND).check });
		const client = '203.0.113.9';
		for (let i = 0; i < PAYMENT_CHECK_RATE_PER_MIN; i++) {
			expect((await get(app, btcQs(), client)).status).toBe(200);
		}
		const limited = await get(app, btcQs(), client);
		expect(limited.status).toBe(429);
		expect(limited.headers.get('retry-after')).not.toBeNull();
		expect((await get(app, btcQs(), '203.0.113.10')).status).toBe(200);
	});
	it('does not share a bucket with the list tier', async () => {
		const app = mount({ check: stub(FOUND).check });
		const listApp = new Hono();
		listApp.get('/x', rateLimit('list', 1), (c) => c.json({}));
		const client = '203.0.113.11';
		const env = { incoming: { socket: { remoteAddress: client } } };
		// A seller's polling spends nothing of their `list` allowance…
		expect((await get(app, btcQs(), client)).status).toBe(200);
		expect((await listApp.request('/x', {}, env)).status).toBe(200);
		// …and the other way round.
		expect((await listApp.request('/x', {}, env)).status).toBe(429);
		expect((await get(app, btcQs(), client)).status).toBe(200);
	});
	it('main.ts mounts the route behind this tier', () => {
		const main = readFileSync(resolve(__dirname, '../../src/main.ts'), 'utf8');
		expect(main).toMatch(
			/paymentCheckApp\.use\('\*', rateLimit\('payment-check', PAYMENT_CHECK_RATE_PER_MIN\)\);/
		);
		expect(main).toMatch(/app\.route\('\/v1\/payment-check', paymentCheckApp\);/);
	});
});

describe('docs/API.md says what the code does', () => {
	const api = readFileSync(resolve(__dirname, '../../../../docs/API.md'), 'utf8');
	const section = api.slice(api.indexOf('#### `GET /v1/payment-check`'));
	it('documents the route, its tier and its limits', () => {
		expect(api).toContain(`| \`payment-check\` | ${PAYMENT_CHECK_RATE_PER_MIN} req/min |`);
		expect(section).toContain('Tier: `payment-check`');
		expect(section).toContain(`at most ${PAYMENT_CHECK_WAIT_MS / 1000} s`);
		expect(section).toContain(`At most ${PAYMENT_CHECK_MAX_IN_FLIGHT} explorer rounds`);
		expect(section).toContain(
			`plus ${PAYMENT_CHECK_RESERVED_FOR_KNOWN}\nmore kept for questions asked before`
		);
		expect(section).toContain(`at most ${PAYMENT_CHECK_MAX_IN_FLIGHT_PER_CLIENT} rounds`);
		expect(section).toContain(`(${PAYMENT_CHECK_MAX_IN_FLIGHT_SHARED} for the one key`);
		expect(section).toContain(`stopped after ${PAYMENT_CHECK_ROUND_MS / 1000} s`);
		expect(section).toContain(`${PAYMENT_CHECK_ROUNDS_PER_MIN} start per minute`);
		expect(section).toContain(
			`reused for ${PAYMENT_CHECK_FRESH_MS.confirming / 1000} s while confirming (${PAYMENT_CHECK_FRESH_MS.confirmed / 60_000} min`
		);
		expect(section).toContain(`${PAYMENT_CHECK_FRESH_MS.notFound / 1000} s for \`not_found\``);
		expect(section).toContain(`${PAYMENT_CHECK_FRESH_MS.unavailable / 1000} s for \`unavailable\``);
		expect(section).toContain(`for up to ${PAYMENT_CHECK_KEEP_MS / 60_000} min`);
	});
	it('documents tx_time, the own-spend rule and the per-operator quorum', () => {
		const route = section.slice(0, section.indexOf('\n---\n'));
		expect(route).toContain('"tx_time":');
		expect(route).toContain('- `tx_time`:');
		expect(route).toContain('spends from `address`');
		expect(route).toContain('counted in distinct explorer operators');
	});
});

describe('the log', () => {
	let restore: (() => void) | null = null;
	afterEach(() => {
		restore?.();
		restore = null;
	});
	it('holds no txid, address or key — not even from an error that quotes them', async () => {
		const records: LogRecord[] = [];
		restore = setLogSink((r) => records.push(r));
		const app = mount({
			check: async (q) => {
				throw new Error(`explorer said no for ${q.txid} ${q.address} ${q.txKey}`);
			}
		});
		await get(app, xmrQs());
		await get(app, btcQs());
		await get(app, `${btcQs()}&tx_key=${KEY}`);
		await get(app, xmrQs(XMR_TESTNET));
		expect(records.length).toBeGreaterThan(0);
		const text = JSON.stringify(records);
		for (const v of [TXID, KEY, BTC, XMR_SUB, XMR_TESTNET, '198.51.100.']) {
			expect(text.includes(v)).toBe(false);
		}
	});
});
