/**
 * The BLURT leg of a crypto-for-crypto trade, checked from the thread itself
 * (v1.21.17).
 *
 * The one-leg trade record (tradeStatus) holds ONE address and ONE expected
 * amount per order, engaged with ONE peer, kept in memory. A two-leg trade
 * broke it every way: the other side's address for the other coin replaced
 * the seller's BLURT ask; a payload from the payer could rewrite the ask he
 * was checked against; after a reload, a lock or with a second buyer on the
 * same order the payment was never verified at all, and the seller waited
 * forever. So the BLURT payment is checked here against the seller's OWN ask
 * in this thread — the account he named, the amount and memo he asked — and
 * the payer of this thread, straight against the chain, like a BTC/XMR
 * payment is against the explorers.
 */
import { readable, type Readable } from 'svelte/store';
import { verifyBlurtTransfer, type VerifyResult } from './blurtVerify';
import type { PaymentCheckVerdict } from './cryptoLegs';

export interface BlurtLegInput {
	readonly txid: string;
	/** Who pays (the asset receiver). */
	readonly payer: string;
	/** The account the seller asked to be paid at. */
	readonly payee: string;
	/** What he asked, in BLURT (absent: he asked no amount). */
	readonly asked?: number;
	/** The memo he asked for ('' = any). */
	readonly memo: string;
}

export type BlurtLegState =
	| { readonly phase: 'checking' }
	| { readonly phase: 'seen'; readonly unasked: boolean }
	| { readonly phase: 'mismatch' }
	/** Not on chain (yet) / the node could not be asked; `long` once lasting. */
	| { readonly phase: 'not_found' | 'unavailable'; readonly long: boolean };

/** How often a BLURT payment not on chain yet is looked up again. Blurt
 *  makes a block every 3 seconds. */
export const BLURT_LEG_INTERVAL_MS = 10_000;
/** How long "not on chain" / "cannot ask" lasts before the seller may
 *  settle it from his own wallet. */
export const BLURT_LEG_LONG_MS = 3 * 60_000;
/** BLURT's smallest unit, as the verifier's tolerance. */
const MILLI = 0.001;

/** When the chain's answer is "the amount differs" and the transfer may be
 *  paid in full or more (or no amount was asked): the amount to look again
 *  with, so the OTHER fields (payer, account, memo) are checked too — the
 *  verifier names only the first field that differs, so an old transfer
 *  with another memo would otherwise read as "paid more". Null otherwise. */
export function recheckAmount(r: VerifyResult, input: BlurtLegInput): number | null {
	if (r.kind !== 'mismatch' || r.field !== 'amount' || r.received === undefined) return null;
	const got = Number(r.received);
	if (!Number.isFinite(got) || got <= 0) return null;
	if (input.asked !== undefined && got + MILLI / 2 < input.asked) return null;
	return got;
}

/** One answer of the chain, as a state. An "amount differs" answer is a
 *  mismatch here: paid in full or more is decided by looking again with the
 *  amount received (recheckAmount), which checks every other field. With
 *  no memo asked, nothing ties a transfer to THIS ask (an earlier one from
 *  the same payer passes): seen, but the seller's call. */
export function blurtLegStateOf(r: VerifyResult, input: BlurtLegInput): BlurtLegState {
	const unasked = input.asked === undefined || input.memo === '';
	switch (r.kind) {
		case 'verified':
			return { phase: 'seen', unasked };
		case 'mismatch':
			return { phase: 'mismatch' };
		case 'wrong_op':
			return { phase: 'mismatch' };
		case 'not_found':
			return { phase: 'not_found', long: false };
		default:
			return { phase: 'unavailable', long: false };
	}
}

export function blurtLegVerdict(s: BlurtLegState): PaymentCheckVerdict {
	switch (s.phase) {
		case 'seen':
			return s.unasked ? 'unasked' : 'seen';
		case 'mismatch':
			return 'mismatch';
		case 'not_found':
		case 'unavailable':
			return s.long ? 'unverifiable' : 'checking';
		default:
			return 'checking';
	}
}

const watchers = new Map<string, Readable<BlurtLegState>>();

/** Watch one BLURT payment until the chain says what it is. */
export function watchBlurtLeg(input: BlurtLegInput): Readable<BlurtLegState> {
	const key = [input.txid, input.payer, input.payee, input.asked ?? '', input.memo].join('\u0000');
	const existing = watchers.get(key);
	if (existing) return existing;
	const w = readable<BlurtLegState>({ phase: 'checking' }, (set) => {
		let stopped = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let since: number | null = null;
		const tick = async (): Promise<void> => {
			const ask = (amountBlurt: number): Promise<VerifyResult> =>
				verifyBlurtTransfer(input.txid, {
					recipient: input.payee,
					sender: input.payer,
					amountBlurt,
					memo: input.memo
				});
			let r: VerifyResult;
			try {
				// With no amount asked, any amount is looked at (and reported).
				r = await ask(input.asked ?? MILLI);
				const again = recheckAmount(r, input);
				if (again !== null) r = await ask(again);
			} catch (err) {
				r = { kind: 'rpc_error', message: String(err) };
			}
			if (stopped) return;
			let st = blurtLegStateOf(r, input);
			if (st.phase === 'not_found' || st.phase === 'unavailable') {
				const now = Date.now();
				since ??= now;
				st = { phase: st.phase, long: now - since >= BLURT_LEG_LONG_MS };
				timer = setTimeout(() => void tick(), BLURT_LEG_INTERVAL_MS);
			} else {
				since = null;
			}
			set(st);
		};
		void tick();
		return () => {
			stopped = true;
			if (timer !== null) clearTimeout(timer);
		};
	});
	watchers.set(key, w);
	return w;
}
