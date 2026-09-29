/**
 * v1.20.0 (MK-H2) — which BTC listing-fee flow applies. Dependency-free on
 * purpose: the post page and the order op builder import it without pulling
 * the address-derivation crypto into their bundles (that lives in
 * ./btcFeeAddress.ts, loaded with the pay panel).
 */
import type { ReleaseTreasuryBlock } from '@morphit/release-schema';

/** True when the chain-pinned treasury makes BTC fees per-order-address:
 *  no txid to paste; the order's own address is shown after posting. */
export function btcFeeAddressMode(treasury: ReleaseTreasuryBlock | null): boolean {
	return typeof treasury?.btc?.xpub === 'string' && treasury.btc.xpub.length > 0;
}

/** Must an order with this fee method carry an external txid? XMR always
 *  (the proof names the payment); BTC only while no treasury xpub is pinned —
 *  in per-order-address mode the order is posted first and paid after. */
export function externalTxidRequired(
	feeMethod: 'blurt' | 'waived_first_buy' | 'btc' | 'xmr',
	btcFeeAddressModeOn: boolean | undefined
): boolean {
	if (feeMethod === 'xmr') return true;
	if (feeMethod === 'btc') return btcFeeAddressModeOn !== true;
	return false;
}
