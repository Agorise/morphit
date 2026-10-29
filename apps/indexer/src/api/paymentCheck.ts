/**
 * Morphit indexer — GET /v1/payment-check: has a trade's BTC / XMR payment
 * reached the seller's address, with how much, and how deep?
 *
 *   GET /v1/payment-check?asset=btc|xmr&txid=<64 hex>&address=<addr>
 *                        [&tx_key=<64×n hex, n = 1..17>, XMR only and required]
 *
 * `tx_key` is what the wallet shows for the sent transaction: the main key,
 * or — when the transaction has additional keys (a subaddress among several
 * destinations) — the main key followed by one key per output.
 *
 * 200 { asset, txid, status: 'found' | 'not_found' | 'unavailable',
 *       amount: string | null, confirmations: number | null,
 *       tx_time: ISO | null, [tx_time_disputed: true,]
 *       required_confirmations: 3, checked_at: ISO }
 *   `amount`: coin units, a decimal string — what this transaction pays to
 *   `address` ("0" when it pays nothing there: a wrong address, an XMR key
 *   that proves nothing, or a BTC transaction that spends from `address` —
 *   its owner's own spend, whose change is no payment). `confirmations`: 0 =
 *   in the mempool; a lower bound (fee/paymentCheck.ts). Both null unless
 *   `found`. `tx_time`: the time of the block holding the transaction, the
 *   earliest the agreeing explorers give when their times agree; null when
 *   none of them puts it in a block with a time, and unless `found` — a client
 *   binding the payment to a time treats null as "not known yet" — and null
 *   with `tx_time_disputed: true` when their times cannot both be true
 *   (paymentTimeOf: one explorer's made-up time must not date a payment).
 *   `checked_at`: when
 *   the explorers gave this answer — it can be older than the request (below).
 * 400 malformed or unexpected parameters; the message never repeats them.
 * 429 the `payment-check` rate-limit tier (main.ts).
 *
 * Read-only and display-only: the seller's screen polls this while the buyer's
 * payment confirms. The explorers are asked in the background
 * (fee/paymentCheck.ts — over Tor / I2P first, where an answer can take tens of
 * seconds), and a request waits at most PAYMENT_CHECK_WAIT_MS for a first
 * answer, inside the web app's 8 s budget for a clearnet indexer call; past it
 * the answer is `unavailable` and the next poll gets the result. One question
 * is asked once at a time (later requests join it), its answer is reused while
 * fresh (FRESH_MS), and a stale answer is served while it is re-checked — so a
 * seller watching 1/3 does not see `unavailable` between polls. A re-check
 * that gets no answer keeps the last verdict for up to KEEP_MS (its
 * `checked_at` shows its age) rather than replacing it.
 *
 * Abuse: per client, the `payment-check` tier (PAYMENT_CHECK_RATE_PER_MIN)
 * and at most PAYMENT_CHECK_MAX_IN_FLIGHT_PER_CLIENT explorer rounds of its
 * own at once (PAYMENT_CHECK_MAX_IN_FLIGHT_SHARED for a key that stands for
 * every Tor/I2P visitor); instance-wide, at most PAYMENT_CHECK_MAX_IN_FLIGHT
 * rounds for new questions plus PAYMENT_CHECK_RESERVED_FOR_KNOWN more for
 * questions already asked before (a seller's next poll), and
 * PAYMENT_CHECK_ROUNDS_PER_MIN started per minute — past any of these, a new
 * question is `unavailable` without asking anyone. Every round ends within
 * PAYMENT_CHECK_ROUND_MS (its explorers are stopped). So one client sending
 * random questions cannot hold every round and leave honest sellers with
 * "cannot be checked" (v1.21.17). Answers already known are served
 * from memory and cost no explorer request.
 *
 * Privacy: nothing about a request is logged or stored in the database. The
 * cache lives in memory only and is keyed by a SHA-256 of the query, so it
 * holds no txid, address or tx key as a key; the answer itself is
 * `Cache-Control: no-store` (its URL carries the tx key).
 */
import { createHash } from 'node:crypto';
import { Hono, type Context } from 'hono';

import { errorBody } from '$api/shared';
import {
	PAYMENT_REQUIRED_CONFIRMATIONS,
	type PaymentQuery,
	type PaymentVerdict
} from '$indexer/fee/paymentCheck';
import { isBtcMainnetAddress, parseXmrAddress } from '@morphit/release-schema';
import type { PaymentCheckResponse } from '@morphit/indexer-client';
import { XMR_TX_KEYS } from '$indexer/fee/xmrRawTx';
import { requestClient } from '$api/middleware/ratelimit';
import { logger } from '$log';

const log = logger('payment-check');

/** Requests per minute per client (the `payment-check` rate-limit tier). A
 *  seller polls one payment every few seconds at most; a Tor/I2P visitor
 *  shares a key and gets SHARED_KEY_MULTIPLIER times this (ratelimit.ts). */
export const PAYMENT_CHECK_RATE_PER_MIN = 30;
/** Longest a request waits for a first answer from the explorers. */
export const PAYMENT_CHECK_WAIT_MS = 5_000;
/** How long an answer is reused before the explorers are asked again. */
export const PAYMENT_CHECK_FRESH_MS = {
	/** Found, fewer than PAYMENT_REQUIRED_CONFIRMATIONS deep: the depth moves. */
	confirming: 30_000,
	/** Found and confirmed: only a reorg changes it. */
	confirmed: 10 * 60_000,
	/** Not seen yet: it may appear any moment. */
	notFound: 30_000,
	/** No answer: do not hammer explorers that are down. */
	unavailable: 15_000
} as const;
/** How long a verdict is still served (with its own checked_at) while
 *  re-checks get no answer. Past it the question is asked afresh. */
export const PAYMENT_CHECK_KEEP_MS = 30 * 60_000;
/** Explorer rounds for NEW questions running at once, instance-wide. */
export const PAYMENT_CHECK_MAX_IN_FLIGHT = 8;
/** More rounds, only for questions this instance was asked before. */
export const PAYMENT_CHECK_RESERVED_FOR_KNOWN = 4;
/** Rounds one client may have running at once. */
export const PAYMENT_CHECK_MAX_IN_FLIGHT_PER_CLIENT = 2;
/** …and one key standing for every Tor/I2P visitor (requestClient shared). */
export const PAYMENT_CHECK_MAX_IN_FLIGHT_SHARED = 4;
/** Longest one round may run: its explorers are stopped then. A Tor round
 *  answers in tens of seconds; the browser polls again anyway. */
export const PAYMENT_CHECK_ROUND_MS = 90_000;
/** Explorer rounds started per minute, instance-wide. */
export const PAYMENT_CHECK_ROUNDS_PER_MIN = 120;
/** Answers kept; the oldest goes first. */
export const PAYMENT_CHECK_CACHE_MAX = 2_000;

const HEX64 = /^[0-9a-f]{64}$/i;
const PARAMS: ReadonlySet<string> = new Set(['asset', 'txid', 'address', 'tx_key']);

/** The query, validated and normalised (lowercase hex, lowercase bech32), or
 *  null. Every parameter at most once; nothing else allowed. PURE. */
export function parsePaymentQuery(
	query: Readonly<Record<string, readonly string[]>>
): PaymentQuery | null {
	for (const [k, v] of Object.entries(query)) {
		if (!PARAMS.has(k) || v.length !== 1) return null;
	}
	const one = (k: string): string | null => query[k]?.[0] ?? null;
	const asset = one('asset');
	const txid = one('txid');
	const address = one('address');
	// Trimmed: a key pasted from a wallet often carries a stray space or newline.
	const txKey = one('tx_key')?.trim() ?? null;
	if (asset !== 'btc' && asset !== 'xmr') return null;
	if (txid === null || !HEX64.test(txid)) return null;
	if (address === null) return null;
	if (asset === 'btc') {
		if (txKey !== null || !isBtcMainnetAddress(address)) return null;
		// Explorers write bech32 in lowercase; BIP173 allows all-uppercase.
		const a = /^bc1/i.test(address) ? address.toLowerCase() : address;
		return { asset, txid: txid.toLowerCase(), address: a, txKey: null };
	}
	if (txKey === null || !XMR_TX_KEYS.test(txKey)) return null;
	const parsed = parseXmrAddress(address);
	// parseXmrAddress trims; a padded address is not the address.
	if (!parsed.ok || parsed.value.net !== 'mainnet' || address.trim() !== address) return null;
	return { asset, txid: txid.toLowerCase(), address, txKey: txKey.toLowerCase() };
}

export interface PaymentCheckRouteDeps {
	/** fee/paymentCheck.ts PaymentChecker.check; `signal` ends the round. */
	readonly check: (q: PaymentQuery, signal?: AbortSignal) => Promise<PaymentVerdict>;
	readonly clock?: () => number;
	/** Test seam: PAYMENT_CHECK_WAIT_MS by default. */
	readonly waitMs?: number;
	/** Test seam: PAYMENT_CHECK_ROUND_MS by default. */
	readonly roundMs?: number;
	/** Test seam: who is asking (requestClient by default). */
	readonly clientOf?: (c: Context) => { readonly key: string; readonly shared: boolean };
}

interface Entry {
	verdict: PaymentVerdict;
	checkedAt: number;
	freshUntil: number;
}

const UNAVAILABLE: PaymentVerdict = {
	status: 'unavailable',
	amount: null,
	confirmations: null,
	txTime: null
};

function freshFor(v: PaymentVerdict): number {
	if (v.status === 'found') {
		return v.confirmations >= PAYMENT_REQUIRED_CONFIRMATIONS
			? PAYMENT_CHECK_FRESH_MS.confirmed
			: PAYMENT_CHECK_FRESH_MS.confirming;
	}
	return v.status === 'not_found'
		? PAYMENT_CHECK_FRESH_MS.notFound
		: PAYMENT_CHECK_FRESH_MS.unavailable;
}

export function paymentCheckRoute(deps: PaymentCheckRouteDeps): Hono {
	const app = new Hono();
	const clock = deps.clock ?? (() => Date.now());
	const waitMs = deps.waitMs ?? PAYMENT_CHECK_WAIT_MS;
	const roundMs = deps.roundMs ?? PAYMENT_CHECK_ROUND_MS;
	const clientOf = deps.clientOf ?? requestClient;
	const cache = new Map<string, Entry>();
	const inFlight = new Map<string, Promise<void>>();
	/** Rounds running per client key; rounds for questions asked before. */
	const perClient = new Map<string, number>();
	/** Questions asked before (SHA-256 keys), bounded like the cache. */
	const askedBefore = new Set<string>();
	let knownRounds = 0;
	let windowStart = 0;
	let rounds = 0;

	const keyOf = (q: PaymentQuery): string =>
		createHash('sha256')
			.update(`${q.asset}|${q.txid}|${q.address}|${q.txKey ?? ''}`)
			.digest('hex');

	const store = (key: string, v: PaymentVerdict): void => {
		const now = clock();
		const prev = cache.get(key);
		if (
			v.status === 'unavailable' &&
			prev !== undefined &&
			prev.verdict.status !== 'unavailable' &&
			now - prev.checkedAt < PAYMENT_CHECK_KEEP_MS
		) {
			// No answer this time: keep the last verdict, and try again soon.
			prev.freshUntil = now + PAYMENT_CHECK_FRESH_MS.unavailable;
			return;
		}
		cache.delete(key);
		while (cache.size >= PAYMENT_CHECK_CACHE_MAX) {
			const oldest = cache.keys().next();
			if (oldest.done === true) break;
			cache.delete(oldest.value);
		}
		cache.set(key, { verdict: v, checkedAt: now, freshUntil: now + freshFor(v) });
	};

	/** The round for `key`: the one running, a new one, or null when the
	 *  bounds say no (see the header: per client, new vs known, per minute). */
	const start = (
		key: string,
		q: PaymentQuery,
		client: { readonly key: string; readonly shared: boolean }
	): Promise<void> | null => {
		const running = inFlight.get(key);
		if (running !== undefined) return running;
		const known = askedBefore.has(key);
		const newRounds = inFlight.size - knownRounds;
		if (
			known
				? knownRounds >= PAYMENT_CHECK_RESERVED_FOR_KNOWN &&
					newRounds >= PAYMENT_CHECK_MAX_IN_FLIGHT
				: newRounds >= PAYMENT_CHECK_MAX_IN_FLIGHT
		) {
			return null;
		}
		const mine = perClient.get(client.key) ?? 0;
		const cap = client.shared
			? PAYMENT_CHECK_MAX_IN_FLIGHT_SHARED
			: PAYMENT_CHECK_MAX_IN_FLIGHT_PER_CLIENT;
		if (mine >= cap) return null;
		const now = clock();
		if (now - windowStart >= 60_000) {
			windowStart = now;
			rounds = 0;
		}
		if (rounds >= PAYMENT_CHECK_ROUNDS_PER_MIN) return null;
		rounds++;
		// A known question takes a reserved slot when the new ones are full.
		const usesReserved = known && newRounds >= PAYMENT_CHECK_MAX_IN_FLIGHT;
		if (usesReserved) knownRounds++;
		perClient.set(client.key, mine + 1);
		askedBefore.delete(key);
		askedBefore.add(key);
		while (askedBefore.size > PAYMENT_CHECK_CACHE_MAX) {
			const oldest = askedBefore.values().next();
			if (oldest.done === true) break;
			askedBefore.delete(oldest.value);
		}
		const deadline = new AbortController();
		const timer = setTimeout(() => deadline.abort(), roundMs);
		const round = (async () => {
			let v: PaymentVerdict;
			try {
				v = await deps.check(q, deadline.signal);
			} catch (err) {
				// The error's name only: its message could quote the query.
				log.warn('payment_check_failed', { error: err instanceof Error ? err.name : typeof err });
				v = UNAVAILABLE;
			}
			store(key, v);
		})().finally(() => {
			clearTimeout(timer);
			inFlight.delete(key);
			if (usesReserved) knownRounds--;
			const left = (perClient.get(client.key) ?? 1) - 1;
			if (left <= 0) perClient.delete(client.key);
			else perClient.set(client.key, left);
		});
		inFlight.set(key, round);
		return round;
	};

	const answer = (c: Context, q: PaymentQuery, v: PaymentVerdict, checkedAt: number) => {
		c.header('cache-control', 'no-store');
		const common = {
			asset: q.asset,
			txid: q.txid,
			required_confirmations: PAYMENT_REQUIRED_CONFIRMATIONS,
			checked_at: new Date(checkedAt).toISOString()
		};
		// Typed against the client package, so the two cannot drift apart.
		const body: PaymentCheckResponse =
			v.status === 'found'
				? {
						...common,
						status: 'found',
						amount: v.amount,
						confirmations: v.confirmations,
						tx_time: v.txTime,
						...(v.txTimeDisputed === true ? { tx_time_disputed: true as const } : {})
					}
				: { ...common, status: v.status, amount: null, confirmations: null, tx_time: null };
		return c.json(body);
	};

	app.get('/', async (c) => {
		const q = parsePaymentQuery(c.req.queries());
		if (q === null) {
			c.header('cache-control', 'no-store');
			return c.json(
				errorBody(
					'bad_request',
					'expected asset=btc|xmr, txid (64 hex), a mainnet address for the asset, and for xmr only tx_key (64 hex per key)'
				),
				400
			);
		}
		const key = keyOf(q);
		const now = clock();
		const known = cache.get(key);
		if (known !== undefined && now < known.freshUntil) {
			return answer(c, q, known.verdict, known.checkedAt);
		}
		const round = start(key, q, clientOf(c));
		// Stale but recent: serve it while the re-check runs.
		if (known !== undefined && now - known.checkedAt < PAYMENT_CHECK_KEEP_MS) {
			return answer(c, q, known.verdict, known.checkedAt);
		}
		if (round === null) return answer(c, q, UNAVAILABLE, now);
		let timer: ReturnType<typeof setTimeout> | undefined;
		await Promise.race([
			round,
			new Promise<void>((resolve) => {
				timer = setTimeout(resolve, waitMs);
			})
		]);
		clearTimeout(timer);
		const got = cache.get(key);
		if (got !== undefined && got.checkedAt >= now) return answer(c, q, got.verdict, got.checkedAt);
		return answer(c, q, UNAVAILABLE, now);
	});

	return app;
}
