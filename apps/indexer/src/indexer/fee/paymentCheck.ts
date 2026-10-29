/**
 * Morphit indexer — has a trade's BTC / XMR payment reached the seller's
 * address? (GET /v1/payment-check, api/paymentCheck.ts)
 *
 * In a crypto-for-crypto trade the seller shares a BTC or XMR address in the
 * chat, the buyer pays it and records the txid (for XMR also the tx key). The
 * seller's screen asks this node, which asks the block explorers, never the
 * browser: a browser only ever talks to its own instance.
 *
 * The explorers, the transport and the trust rules are the listing-fee
 * verifiers' own (bitcoinExplorerVerifier.ts lookupPayment,
 * moneroProofVerifier.ts lookupPayment), in the same tiers
 * (externalFeeVerifiers.ts): the explorers that need no clearnet first, over
 * Tor / I2P on a fresh circuit per request (indexer/sourceFetch.ts), and the
 * clearnet ones only where clearnet is allowed and only when the first tier
 * could not answer. A zero-clearnet node never asks a clearnet explorer.
 *
 * Agreement: the configured quorum (MORPHIT_INDEXER_{BTC,XMR}_MIN_SUCCESSFUL_
 * RESPONSES, default 2), counted in distinct OPERATORS (feeSources.ts
 * explorerOperatorOf: one operator's onion, I2P and clearnet addresses are one
 * answer) and lowered to a tier's size in URLs exactly as for the fee. It is
 * display-only, but the seller releases BLURT on it: with one explorer's word
 * enough, that explorer (or whoever sits between it and us) could show a
 * payment that was never made. So, as for a fee, one answer short of the
 * quorum is no answer (`unavailable`) — unless the operator configured fewer
 * explorers than the quorum, which the fee path accepts too. Lowering by URLs,
 * never by operators, is what keeps a tier of one operator's two addresses
 * from deciding alone: its quorum stays 2 and two operators never answer, so
 * it is `unavailable`, never a verdict.
 *
 * Binding a payment to its time: `txTime` is the time of the block holding the
 * transaction (verifier.ts paymentTimeOf: the earliest the agreeing explorers
 * that put it in a block give, when their times agree; null when all of them
 * have it in the mempool, and null with `txTimeDisputed` when their times
 * cannot both be true). It is reported even at 0 confirmations (one explorer
 * may not have seen the block yet). The seller's screen refuses a payment mined
 * before the address was shared — an old payment to a reused address is not
 * this trade's. A BTC transaction that spends from the address is its owner's
 * own spend (its change is no payment) and pays 0 here.
 *
 * Privacy: the verifiers are built with `privateLookups`, so their warnings
 * name the explorer and status only; this module logs nothing. A trade's txid,
 * address and tx key are not public the way a listing fee's are.
 */
import { getAsset } from '@morphit/asset-registry';
import { BitcoinExplorerFeeVerifier } from './bitcoinExplorerVerifier';
import { MoneroProofFeeVerifier } from './moneroProofVerifier';
import { explorerAvailability } from './externalFeeAvailability';
import { anyHidden, feeVerifierTiers } from './externalFeeVerifiers';
import type { PaymentLookupResult } from './verifier';
import { SOURCE_HIDDEN_REQUEST_TIMEOUT_MS } from '$indexer/sourceFetch';

/** Confirmations after which the seller's screen calls a payment confirmed. */
export const PAYMENT_REQUIRED_CONFIRMATIONS = 3;

export type PaymentAsset = 'btc' | 'xmr';

/** A validated query (api/paymentCheck.ts validates). `txKey` is XMR only. */
export interface PaymentQuery {
	readonly asset: PaymentAsset;
	readonly txid: string;
	readonly address: string;
	readonly txKey: string | null;
}

/** What the explorers say, amounts in coin units (a decimal string),
 *  `txTime` an ISO time (see the header). */
export type PaymentVerdict =
	| {
			readonly status: 'found';
			readonly amount: string;
			readonly confirmations: number;
			readonly txTime: string | null;
			/** The explorers' times disagree (paymentTimeOf): no time. */
			readonly txTimeDisputed?: true;
	  }
	| {
			readonly status: 'not_found' | 'unavailable';
			readonly amount: null;
			readonly confirmations: null;
			readonly txTime: null;
	  };

/** One tier: a verifier over that tier's explorers. */
interface BtcTier {
	lookupPayment(txid: string, address: string, signal?: AbortSignal): Promise<PaymentLookupResult>;
}
interface XmrTier {
	lookupPayment(
		txid: string,
		address: string,
		txKey: string,
		signal?: AbortSignal
	): Promise<PaymentLookupResult>;
}

/** `units` of the smallest unit as a decimal string in coin units, without
 *  trailing zeros: 2_500n sats → "0.000025", 0n → "0". PURE. */
export function formatCoinAmount(units: bigint, decimals: number): string {
	if (units < 0n) throw new Error('formatCoinAmount: negative amount');
	const s = units.toString().padStart(decimals + 1, '0');
	const whole = s.slice(0, s.length - decimals);
	const frac = s.slice(s.length - decimals).replace(/0+$/, '');
	return frac.length === 0 ? whole : `${whole}.${frac}`;
}

export class PaymentChecker {
	constructor(
		private readonly tiers: { readonly btc: readonly BtcTier[]; readonly xmr: readonly XmrTier[] }
	) {}

	/** Ask tier after tier until one gives a verdict (`found` / `not_found`).
	 *  No tier at all (no usable explorer for the asset) → `unavailable`. */
	async check(q: PaymentQuery, signal?: AbortSignal): Promise<PaymentVerdict> {
		const decimals = getAsset(q.asset === 'btc' ? 'BTC' : 'XMR').decimals;
		const asked: readonly (() => Promise<PaymentLookupResult>)[] =
			q.asset === 'btc'
				? this.tiers.btc.map((t) => () => t.lookupPayment(q.txid, q.address, signal))
				: // No key: lookupPayment refuses it before asking anyone.
					this.tiers.xmr.map(
						(t) => () => t.lookupPayment(q.txid, q.address, q.txKey ?? '', signal)
					);
		for (const ask of asked) {
			// Out of time (the route's round deadline): no further tier.
			if (signal?.aborted === true) break;
			let r: PaymentLookupResult;
			try {
				r = await ask();
			} catch {
				// A verifier does not throw on an explorer's answer; a bug here
				// must still not become a verdict.
				continue;
			}
			if (r.kind === 'found') {
				return {
					status: 'found',
					amount: formatCoinAmount(r.amount, decimals),
					confirmations: r.confirmations,
					txTime: r.blockTime !== null ? new Date(r.blockTime * 1000).toISOString() : null,
					...(r.timeDisputed === true ? { txTimeDisputed: true as const } : {})
				};
			}
			if (r.kind === 'not_found') {
				return { status: 'not_found', amount: null, confirmations: null, txTime: null };
			}
		}
		return { status: 'unavailable', amount: null, confirmations: null, txTime: null };
	}
}

interface PaymentCheckConfig {
	readonly blurtRpcEndpoints: readonly unknown[];
	readonly hiddenRpcEndpoints: readonly unknown[];
	readonly btcExplorerUrls: readonly string[];
	readonly xmrExplorerUrls: readonly string[];
	readonly btcMinSuccessfulResponses: number;
	readonly xmrMinSuccessfulResponses: number;
}

/** The checker a node runs: the fee path's explorer tiers, quorum and
 *  timeouts, with `fetchImpl` = indexer/sourceFetch.ts's makeSourceFetch. The
 *  verifiers live as long as the process, so their explorer health (latency,
 *  cooldown) carries over from one check to the next. */
export function buildPaymentChecker(
	config: PaymentCheckConfig,
	fetchImpl: typeof fetch
): PaymentChecker {
	const tiersFor = (method: PaymentAsset, quorum: number): (readonly string[])[] => {
		const a = explorerAvailability(config, method);
		return a.off === null ? feeVerifierTiers(a, quorum) : [];
	};
	const btc = tiersFor('btc', config.btcMinSuccessfulResponses).map(
		(urls) =>
			new BitcoinExplorerFeeVerifier(
				{
					// Unused by lookupPayment, which takes the address per call.
					feeAddress: '',
					explorerUrls: urls,
					minConfirmations: 1,
					requestTimeoutMs: anyHidden(urls) ? SOURCE_HIDDEN_REQUEST_TIMEOUT_MS : 5_000,
					minSuccessfulResponses: Math.min(config.btcMinSuccessfulResponses, urls.length),
					privateLookups: true
				},
				fetchImpl
			)
	);
	const xmr = tiersFor('xmr', config.xmrMinSuccessfulResponses).map(
		(urls) =>
			new MoneroProofFeeVerifier(
				{
					feeAddress: '',
					explorerUrls: urls,
					minConfirmations: 1,
					requestTimeoutMs: anyHidden(urls) ? SOURCE_HIDDEN_REQUEST_TIMEOUT_MS : 10_000,
					minSuccessfulResponses: Math.min(config.xmrMinSuccessfulResponses, urls.length),
					privateLookups: true
				},
				fetchImpl
			)
	);
	return new PaymentChecker({ btc, xmr });
}
