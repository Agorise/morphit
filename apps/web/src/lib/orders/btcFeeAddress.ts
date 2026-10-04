/**
 * Morphit — per-order BTC fee addresses, browser side (v1.20.0, MK-H2).
 *
 * Once the chain-pinned release carries the treasury's account xpub
 * (`treasury.btc.xpub`), a BTC listing fee is paid to an address that belongs
 * to that one order: receive address n of the xpub, n numbered by every
 * indexer from chain replay. The user posts the order first, WITHOUT a txid;
 * their indexer then reports `btc_fee: { index, address, … }` on
 * /v1/orders/:account.
 *
 * Trust: the browser does not take the indexer's word for the address. It
 * re-derives address n from the xpub in the release op it verified itself
 * (chain-direct, @morphit key — $stores/release), with the SAME derivation
 * code the indexer runs (@morphit/release-schema btcXpub.ts), and shows the
 * address only if both agree. A lying or buggy indexer can at worst show the
 * wrong index — every candidate address is still the treasury's own.
 *
 * Pure; no I/O.
 */
import {
	deriveBtcFeeAddress,
	parseAccountXpub,
	type ReleaseTreasuryBlock
} from '@morphit/release-schema';
import { buildPaymentUri } from '$lib/chat/payload';

export { btcFeeAddressMode, externalTxidRequired } from './btcFeeMode';

/** The indexer's report on an order's own fee address (/v1/orders/:account). */
export interface IndexerBtcFee {
	readonly index: number;
	readonly address: string;
	readonly sats: number;
	readonly received_sats: number;
	readonly unconfirmed_sats: number;
	/** (V3-10) The treasury key this order was numbered under (the pin in
	 *  force at its block). Absent from pre-V3 indexers. */
	readonly xpub?: string;
}

export type FeeAddressCheck =
	| {
			readonly ok: true;
			readonly address: string;
			/** Amount still to send, in BTC (8 dp, trailing zeros trimmed). */
			readonly amountBtc: string;
			/** Satoshis still to send (0 when enough is confirmed or on its way). */
			readonly remainingSats: number;
			readonly receivedSats: number;
			readonly unconfirmedSats: number;
			/** BIP21 `bitcoin:` URI for the remaining amount (wallet QR). */
			readonly uri: string;
	  }
	| {
			readonly ok: false;
			/** 'unverified_key': the order was numbered under a treasury key that
			 *  is not the current pin and has not (yet) been proved to have been
			 *  pinned by @morphit — prove it (btcFeeKeyHistory) and ask again. */
			readonly reason: 'no_pin' | 'mismatch' | 'bad_data' | 'unverified_key';
	  };

/** Short public id of the pinned treasury BTC key (first 4 bytes of
 *  HASH160 of its public key, hex) — what About-this-instance shows instead of
 *  the whole xpub. Null when no xpub is pinned. */
export function btcFeeKeyId(treasury: ReleaseTreasuryBlock | null): string | null {
	const x = treasury?.btc?.xpub;
	if (typeof x !== 'string') return null;
	const p = parseAccountXpub(x);
	return p.ok ? p.value.keyId : null;
}

/** Satoshis → BTC decimal string, exact (integer arithmetic). */
export function satsToBtc(sats: number): string {
	const s = Math.max(0, Math.trunc(sats));
	const whole = Math.floor(s / 100_000_000);
	const frac = (s % 100_000_000).toString().padStart(8, '0').replace(/0+$/, '');
	return frac.length > 0 ? `${whole}.${frac}` : `${whole}`;
}

function isCount(n: unknown): n is number {
	return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/** Cross-check the indexer's fee address against our own derivation.
 *
 *  Key (V3-10): the order's own key when the indexer names one AND it is the
 *  current chain-verified pin or among `verifiedXpubs` (older keys proved on
 *  chain to have been pinned by @morphit — btcFeeKeyHistory); otherwise the
 *  current pin.
 *
 *  Amount (V3-5): never more than the chain-verified pin — the indexers
 *  accept the lower of the amount quoted at posting and today's pin, so a
 *  larger figure can only be a lying or broken indexer. */
export function checkIndexerFeeAddress(
	treasury: ReleaseTreasuryBlock | null,
	fee: IndexerBtcFee,
	opts: { readonly verifiedXpubs?: ReadonlySet<string> } = {}
): FeeAddressCheck {
	const current = treasury?.btc?.xpub;
	if (typeof current !== 'string' || current.length === 0) return { ok: false, reason: 'no_pin' };
	let xpub = current;
	if (fee.xpub !== undefined) {
		if (typeof fee.xpub !== 'string') return { ok: false, reason: 'bad_data' };
		const named = parseAccountXpub(fee.xpub);
		if (!named.ok) return { ok: false, reason: 'bad_data' };
		const cur = parseAccountXpub(current);
		if (!cur.ok || named.value.xpub !== cur.value.xpub) {
			if (opts.verifiedXpubs?.has(named.value.xpub) !== true)
				return { ok: false, reason: 'unverified_key' };
		}
		xpub = named.value.xpub;
	}
	const pinnedSats = treasury?.btc?.satoshis;
	if (
		!isCount(fee.index) ||
		!isCount(fee.sats) ||
		fee.sats === 0 ||
		!isCount(fee.received_sats) ||
		!isCount(fee.unconfirmed_sats) ||
		typeof fee.address !== 'string'
	) {
		return { ok: false, reason: 'bad_data' };
	}
	let ours: string;
	try {
		ours = deriveBtcFeeAddress(xpub, fee.index);
	} catch {
		return { ok: false, reason: 'bad_data' };
	}
	if (ours !== fee.address) return { ok: false, reason: 'mismatch' };
	const asked =
		typeof pinnedSats === 'number' && Number.isSafeInteger(pinnedSats) && pinnedSats > 0
			? Math.min(fee.sats, pinnedSats)
			: fee.sats;
	const remainingSats = Math.max(0, asked - fee.received_sats - fee.unconfirmed_sats);
	const amountBtc = satsToBtc(remainingSats);
	return {
		ok: true,
		address: ours,
		amountBtc,
		remainingSats,
		receivedSats: fee.received_sats,
		unconfirmedSats: fee.unconfirmed_sats,
		uri: buildPaymentUri({
			method: 'btc',
			address: ours,
			...(remainingSats > 0 ? { amount: amountBtc } : {})
		} as Parameters<typeof buildPaymentUri>[0])
	};
}
