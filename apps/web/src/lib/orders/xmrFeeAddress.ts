/**
 * v1.20.0 (MK-H2) — the order-bound XMR fee address, browser side.
 *
 * Once the release op pins the treasury's main address, the fee for one
 * listing is paid to the INTEGRATED address of that main address carrying
 * the listing's payment ID, Keccak("morphit-fee-v1|account/permlink")[0..8].
 * Every indexer decrypts the payment ID with the tx key the payer puts in the
 * order op and accepts the payment only for that listing — so a txid + key
 * copied from someone's order pays for nothing.
 *
 * The main address comes from the release op this browser verified itself
 * ($stores/release); the address is computed here with the same code the
 * indexer uses (@morphit/release-schema xmrAddress.ts). Pure; no I/O.
 */
import {
	parseXmrPrimaryAddress,
	xmrFeePaymentId,
	xmrIntegratedAddress,
	type ReleaseTreasuryBlock
} from '@morphit/release-schema';
import { xmrBoundPrimary } from './xmrFeeMode';

/** Where this listing's XMR fee must go, or null when fees are not bound
 *  (no pinned main address) or the pinned value is unusable. */
export function xmrBoundPayTo(
	treasury: ReleaseTreasuryBlock | null,
	account: string,
	permlink: string
): { readonly address: string; readonly paymentId: string } | null {
	const primary = xmrBoundPrimary(treasury);
	if (primary === null) return null;
	const p = parseXmrPrimaryAddress(primary);
	if (!p.ok) return null;
	const paymentId = xmrFeePaymentId(account, permlink);
	return { address: xmrIntegratedAddress(p.value.address, paymentId), paymentId };
}
