/**
 * Live check of a BTC or XMR (v1.21.17), HIVE or STEEM (v1.24.0) payment
 * recorded in a trade chat.
 *
 * The buyer records "I paid" with the payment's txid (and, for Monero, its tx
 * key). The seller must see — before he sends his side — that the payment
 * really reached the address he shared, with the amount he asked, and how far
 * it has confirmed: 0/3, 1/3, 2/3, confirmed. The browser asks ITS OWN
 * instance (`/v1/payment-check`), which asks block explorers the way the
 * listing-fee checks do (only over Tor/I2P on a hidden-only instance); the
 * browser never talks to an explorer itself.
 *
 * One watcher per payment (asset, txid, address, key or memo), shared by every
 * subscriber (the receipt card and the chat's buttons), polling until
 * confirmed (sooner at first and while confirming; every 6 s for HIVE / STEEM)
 * and stopping when nobody watches.
 *
 * HIVE / STEEM (v1.24.0): the account is the same in every trade, so the ask's
 * memo goes along and only a transfer carrying it counts; an ask without one
 * binds nothing, and a payment seen there is the receiver's own call.
 */
import { readable, type Readable } from 'svelte/store';
import { getPaymentCheck } from '$lib/indexer/client';
import type { PaymentCheckVerdict } from './cryptoLegs';

/** How often an unconfirmed payment is checked again. Bitcoin blocks come
 *  every ~10 minutes and Monero's every ~2: once a minute shows each new
 *  confirmation promptly without leaning on the explorers. */
export const PAYMENT_CHECK_INTERVAL_MS = 60_000;
/** …but while it has not been seen yet, and for the first minutes, sooner:
 *  the instance answers within a few seconds and keeps asking slow (Tor/I2P)
 *  explorers in the background, so the next question usually has the answer. */
export const PAYMENT_CHECK_FIRST_INTERVAL_MS = 15_000;
export const PAYMENT_CHECK_FIRST_PERIOD_MS = 5 * 60_000;
/** …and while a payment that was seen is still confirming (v1.23.4): once a
 *  minute left the chat at 0/3 for about a minute after both wallets showed
 *  1/3 (owner, a live BTC trade). The instance reuses a confirming answer for
 *  15 s, so this asks the explorers no more often than that. */
export const PAYMENT_CHECK_CONFIRMING_INTERVAL_MS = 15_000;
/** …for this long after it was first seen at 0 confirmations (independent
 *  review: a low-fee payment can sit unconfirmed for hours — not every 15 s
 *  all that while); from its first confirmation on, until confirmed. */
export const PAYMENT_CHECK_CONFIRMING_FAST_FOR_MS = 30 * 60_000;
/** How long "cannot be checked right now" must last before the seller is
 *  told so (and may confirm from his own wallet). A hidden-network explorer
 *  may take a minute or two to answer at all. */
export const PAYMENT_CHECK_UNAVAILABLE_FOR_MS = 3 * 60_000;
/** How long "the explorers do not know this transaction" must last before
 *  the seller may confirm it from his wallet instead: a fresh payment takes a
 *  little while to reach every explorer, but a wrong Monero tx key (which
 *  explorers report as "not found") would otherwise keep him waiting forever. */
export const PAYMENT_CHECK_NOT_FOUND_FOR_MS = 5 * 60_000;
/** (v1.24.0) HIVE and STEEM make a block every 3 seconds: their payments are
 *  asked about sooner (the instance reuses such an answer for 5-6 s), and a
 *  transaction id the nodes still do not know after this long lets the seller
 *  settle it from his wallet, as for BLURT (blurtLegCheck.ts). */
export const PAYMENT_CHECK_3S_CHAIN_INTERVAL_MS = 6_000;
export const PAYMENT_CHECK_3S_CHAIN_NOT_FOUND_FOR_MS = 3 * 60_000;

/** The coins whose payment this instance can be asked about. PURE. */
export function isCheckedPaymentAsset(m: string): m is PaymentCheckInput['asset'] {
	return m === 'btc' || m === 'xmr' || m === 'hive' || m === 'steem';
}

/** Coins with 3-second blocks and an account for an address. */
function threeSecondChain(asset: PaymentCheckInput['asset']): boolean {
	return asset === 'hive' || asset === 'steem';
}

/** A payment whose block is this much older than the address it is said to
 *  pay was not made for this trade (someone else's earlier payment to a
 *  reused address). Block times may run up to ~2 h off. */
export const PAYMENT_CHECK_TIME_SLACK_MS = 2 * 60 * 60 * 1000;

export interface PaymentCheckInput {
	readonly asset: 'btc' | 'xmr' | 'hive' | 'steem';
	readonly txid: string;
	/** The address the receiver shared for this payment (HIVE / STEEM: the
	 *  account name). */
	readonly address: string;
	/** Monero only. Without it a Monero payment cannot be checked. */
	readonly txKey?: string;
	/** (v1.24.0) HIVE / STEEM only: the memo the receiver's ask carries. The
	 *  account is the same in every trade, so only a transfer with this memo
	 *  is this trade's payment; without one, any payment into the account
	 *  would match, and a seen payment is the receiver's own call. */
	readonly memo?: string;
	/** What the receiver asked for, in coin units (decimal string), if he did. */
	readonly asked?: string;
	/** When the address was shared (ms). A payment in a block older than this
	 *  (less the slack) is not a payment for this trade. */
	readonly sharedAtMs?: number;
}

export type PaymentCheckState =
	| { readonly phase: 'checking' }
	/** A Monero payment recorded without its tx key. */
	| { readonly phase: 'no_key' }
	/** The explorers could not be asked (or disagreed). `long`: several
	 *  answers in a row said so. */
	| { readonly phase: 'unavailable'; readonly long?: boolean }
	/** The explorers do not know this txid (yet). `long`: for several minutes. */
	| { readonly phase: 'not_found'; readonly long?: boolean }
	| {
			readonly phase: 'seen';
			/** Paid to the shared address by this transaction, in coin units. */
			readonly amount: string;
			readonly confirmations: number;
			readonly required: number;
			/** Less than asked — or nothing at all to this address. */
			readonly short: boolean;
			/** In a block older than the address share: not this trade's. */
			readonly old?: boolean;
			/** No amount was asked, so "enough" is the seller's call. */
			readonly unasked?: boolean;
			/** Mined, but no explorer gave its block time yet: it cannot be
			 *  dated against the address share, so it is not taken as seen. */
			readonly undated?: boolean;
			/** The explorers' times for it cannot both be true (v1.21.17):
			 *  it cannot be dated, so it cannot be checked here — the seller's
			 *  own call, never "old" on one explorer's word. */
			readonly disputed?: boolean;
			/** (v1.24.0) A HIVE / STEEM transfer reached the account, but none
			 *  in this transaction carries the ask's memo: not this trade's. */
			readonly wrongMemo?: boolean;
			/** (v1.24.0) A HIVE / STEEM ask without a memo: nothing ties a
			 *  payment into the account to this trade, so seen is the
			 *  receiver's own call (as `unasked`). */
			readonly unbound?: boolean;
			/** (v1.24.0) A HIVE / STEEM payment not yet `required` deep — the
			 *  instance counts that depth only from an irreversible block: it shows
			 *  arriving, but releases nothing until a fork can no longer drop it
			 *  (as a BLURT payment, blurtLegCheck.ts). */
			readonly pending?: boolean;
			/** (v1.23.2) When the explorers were last asked (ms). The instance
			 *  serves its last answer while re-checks get none, so a count can be
			 *  older than it looks; the receipt says so (confirmationLine). */
			readonly checkedAtMs?: number;
	  };

/** Is `amount` less than `asked`? Decimal strings compared exactly (no
 *  floating point: 0.1 + 0.2 must not decide whether someone was paid). */
export function isLess(amount: string, asked: string): boolean {
	const norm = (s: string): [bigint, number] => {
		const [i = '0', f = ''] = s.trim().split('.');
		return [BigInt((i || '0') + f), f.length];
	};
	const [a, ad] = norm(amount);
	const [b, bd] = norm(asked);
	const scale = Math.max(ad, bd);
	return a * 10n ** BigInt(scale - ad) < b * 10n ** BigInt(scale - bd);
}

/** The verdict the chat's buttons go by (see cryptoLegs.twoLegButtons).
 *  Only a payment seen in full, to the shared address, after it was shared,
 *  is 'seen'. "Cannot be checked" is never taken as paid: the seller is
 *  told, and only HE can say he sees it in his own wallet. */
export function verdictOf(s: PaymentCheckState): PaymentCheckVerdict {
	switch (s.phase) {
		case 'seen':
			if (s.old) return 'old';
			if (s.short) return 'mismatch';
			if (s.disputed) return 'unverifiable';
			if (s.undated || s.pending) return 'checking';
			return s.unasked || s.unbound ? 'unasked' : 'seen';
		case 'no_key':
			return 'unverifiable';
		case 'unavailable':
		case 'not_found':
			return s.long ? 'unverifiable' : 'checking';
		default:
			return 'checking';
	}
}

/** One question to the instance, turned into a state. */
export async function checkOnce(
	input: PaymentCheckInput,
	signal?: AbortSignal
): Promise<PaymentCheckState> {
	if (input.asset === 'xmr' && !input.txKey) return { phase: 'no_key' };
	const r = await getPaymentCheck(
		{
			asset: input.asset,
			txid: input.txid,
			address: input.address,
			txKey: input.txKey,
			...(input.memo !== undefined ? { memo: input.memo } : {})
		},
		signal
	);
	if (!r.ok) return { phase: 'unavailable' };
	const d = r.data;
	if (d.status === 'not_found') return { phase: 'not_found' };
	if (d.status !== 'found' || d.amount === null || d.confirmations === null) {
		return { phase: 'unavailable' };
	}
	const nothing = !/[1-9]/.test(d.amount);
	const txMs = d.tx_time ? Date.parse(d.tx_time) : NaN;
	const old =
		input.sharedAtMs !== undefined &&
		Number.isFinite(txMs) &&
		txMs < input.sharedAtMs - PAYMENT_CHECK_TIME_SLACK_MS;
	// Mined (some explorer has it in a block) yet undated: an old payment must
	// not pass while its date is unknown. At 0 confirmations with no time it
	// is in the mempool for every agreeing explorer: new, not old.
	const disputed = d.tx_time_disputed === true;
	// How old the answer is, as the instance measured it (v1.23.2 review): this
	// device's clock is used only for the time since it arrived, so a device
	// clock that is off never makes a fresh answer look old. An instance that
	// does not say (older than v1.23.2): no age claimed.
	const ageS = d.age_seconds;
	const checkedAtMs =
		typeof ageS === 'number' && Number.isFinite(ageS) && ageS >= 0 ? Date.now() - ageS * 1000 : NaN;
	const undated =
		input.sharedAtMs !== undefined && d.confirmations > 0 && !Number.isFinite(txMs) && !disputed;
	const pending = threeSecondChain(input.asset) && d.confirmations < d.required_confirmations;
	const wrongMemo = nothing && d.memo_mismatch === true;
	const unbound = threeSecondChain(input.asset) && input.memo === undefined;
	return {
		phase: 'seen',
		amount: d.amount,
		confirmations: d.confirmations,
		required: d.required_confirmations,
		short: nothing || (input.asked !== undefined && isLess(d.amount, input.asked)),
		...(old ? { old: true } : {}),
		...(undated ? { undated: true } : {}),
		...(pending ? { pending: true } : {}),
		...(wrongMemo ? { wrongMemo: true } : {}),
		...(unbound ? { unbound: true } : {}),
		...(disputed ? { disputed: true } : {}),
		...(input.asked === undefined ? { unasked: true } : {}),
		...(Number.isFinite(checkedAtMs) ? { checkedAtMs } : {})
	};
}

/** (v1.23.2) Past this age an answer is called old on the receipt. */
export const PAYMENT_CHECK_STALE_AFTER_MS = 2 * 60_000;

/** (v1.23.2) What the receipt says about depth: the REAL number of
 *  confirmations, also once enough ("✓ … · 4 confirmations" — it used to jump
 *  from "0/3" to a bare "confirmed"), and how many minutes old the answer is
 *  when the explorers have not answered for a while (null: fresh, or no time
 *  known), so a stale "0/3" does not pass for a live one. */
export function confirmationLine(
	c: { readonly confirmations: number; readonly required: number; readonly checkedAtMs?: number },
	nowMs: number
): { confirmed: boolean; n: number; required: number; staleMinutes: number | null } {
	const age = c.checkedAtMs === undefined ? NaN : nowMs - c.checkedAtMs;
	const confirmed = c.confirmations >= c.required;
	return {
		confirmed,
		n: c.confirmations,
		required: c.required,
		// Not for a confirmed answer (review): the instance keeps one for
		// minutes on purpose, and the page stops asking — it is not stale.
		staleMinutes:
			!confirmed && Number.isFinite(age) && age >= PAYMENT_CHECK_STALE_AFTER_MS
				? Math.floor(age / 60_000)
				: null
	};
}

const watchers = new Map<string, Readable<PaymentCheckState>>();

function keyOf(i: PaymentCheckInput): string {
	return [
		i.asset,
		i.txid,
		i.address,
		i.txKey ?? '',
		i.memo ?? '',
		i.asked ?? '',
		i.sharedAtMs ?? ''
	].join('\u0000');
}

/** Watch one payment: checks at once, then again until it is confirmed (see
 *  the intervals above); stops while nobody subscribes. */
export function watchPaymentCheck(input: PaymentCheckInput): Readable<PaymentCheckState> {
	const key = keyOf(input);
	let w = watchers.get(key);
	if (w) return w;
	let last: PaymentCheckState = { phase: 'checking' };
	w = readable<PaymentCheckState>(last, (set) => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		const ctl = new AbortController();
		const startedAt = Date.now();
		/** When it was first seen (any depth), or null. */
		let seenSince: number | null = null;
		/** Since when the answer has been this same "not yet" (unavailable or
		 *  not_found), or null. */
		let notYetSince: { phase: 'unavailable' | 'not_found'; at: number } | null = null;
		const tick = async (): Promise<void> => {
			let next: PaymentCheckState;
			try {
				next = await checkOnce(input, ctl.signal);
			} catch {
				next = { phase: 'unavailable' };
			}
			if (stopped) return;
			const now = Date.now();
			if (next.phase === 'unavailable' || next.phase === 'not_found') {
				if (notYetSince === null || notYetSince.phase !== next.phase) {
					notYetSince = { phase: next.phase, at: now };
				}
				const lasting =
					now - notYetSince.at >=
					(next.phase === 'unavailable'
						? PAYMENT_CHECK_UNAVAILABLE_FOR_MS
						: threeSecondChain(input.asset)
							? PAYMENT_CHECK_3S_CHAIN_NOT_FOUND_FOR_MS
							: PAYMENT_CHECK_NOT_FOUND_FOR_MS);
				if (lasting) next = { phase: next.phase, long: true };
			} else {
				notYetSince = null;
			}
			// A passing outage must not undo a payment already seen.
			if (!(next.phase === 'unavailable' && last.phase === 'seen')) last = next;
			set(last);
			const done =
				last.phase === 'no_key' ||
				(last.phase === 'seen' &&
					last.confirmations >= last.required &&
					!last.undated &&
					!last.disputed);
			if (!done) {
				const early = last.phase !== 'seen' && now - startedAt < PAYMENT_CHECK_FIRST_PERIOD_MS;
				if (last.phase === 'seen' && seenSince === null) seenSince = now;
				const confirming =
					last.phase === 'seen' &&
					last.confirmations < last.required &&
					(last.confirmations > 0 ||
						(seenSince !== null && now - seenSince < PAYMENT_CHECK_CONFIRMING_FAST_FOR_MS));
				const fast = threeSecondChain(input.asset) && (early || confirming);
				timer = setTimeout(
					() => void tick(),
					fast
						? PAYMENT_CHECK_3S_CHAIN_INTERVAL_MS
						: early
							? PAYMENT_CHECK_FIRST_INTERVAL_MS
							: confirming
								? PAYMENT_CHECK_CONFIRMING_INTERVAL_MS
								: PAYMENT_CHECK_INTERVAL_MS
				);
			}
		};
		set(last);
		void tick();
		return () => {
			stopped = true;
			ctl.abort();
			if (timer !== null) clearTimeout(timer);
		};
	});
	watchers.set(key, w);
	return w;
}
