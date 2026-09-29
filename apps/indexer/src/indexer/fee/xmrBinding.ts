/**
 * Morphit indexer — which XMR fee rule applies to an order (v1.20.0, MK-H2).
 *
 * Once a valid release pins `treasury.xmr.primary_address`, from the NEXT
 * block on an XMR fee must be paid to the integrated address of that primary
 * address carrying the order's own payment ID. Before that (or on a node that
 * never saw such a release) the fee is an unbound payment to `xmr.address`.
 * Same "pin in force at the op's block" rule as the BTC xpub
 * (btcFeeAddressIndex.btcPinAt): chain data only, so every indexer agrees.
 */
import type pg from 'pg';
import {
	parseXmrPrimaryAddress,
	xmrFeePaymentId,
	xmrPrimaryFromIntegrated
} from '@morphit/release-schema';

export interface XmrBinding {
	readonly primaryAddress: string;
	readonly viewPub: string;
	readonly paymentId: string;
}

/** The pinned primary address in force for an op in `blockNum`, or null. */
export async function xmrPrimaryAt(
	client: pg.PoolClient,
	blockNum: number
): Promise<string | null> {
	const res = await client.query<{ treasury: unknown }>(
		`SELECT treasury FROM releases
		  WHERE valid = true AND treasury IS NOT NULL AND source_block_num < $1
		  ORDER BY source_block_num DESC, id DESC
		  LIMIT 1`,
		[blockNum]
	);
	const t = res.rows[0]?.treasury as { xmr?: { primary_address?: unknown } | null } | undefined;
	const p = t?.xmr?.primary_address;
	if (typeof p !== 'string') return null;
	// Defence in depth: the release handler only stores a parsed address.
	return parseXmrPrimaryAddress(p).ok ? p : null;
}

/** The binding an order must satisfy, from the primary address it was
 *  posted under. Null when the address does not parse (never pinned so). */
export function xmrBindingFor(
	primary: string,
	account: string,
	permlink: string
): XmrBinding | null {
	const p = parseXmrPrimaryAddress(primary);
	if (!p.ok) return null;
	return {
		primaryAddress: p.value.address,
		viewPub: p.value.viewPub,
		paymentId: xmrFeePaymentId(account, permlink)
	};
}

/** The binding of a stored bound row (re-check), from the integrated address
 *  written at intake. Null — never re-checked — unless that address carries
 *  exactly the payment ID of (account, permlink) and the stored one. */
export function xmrBindingOfRow(
	feeAddress: string,
	storedPaymentId: string,
	account: string,
	permlink: string
): XmrBinding | null {
	let primary: string;
	let paymentId: string;
	try {
		({ primary, paymentId } = xmrPrimaryFromIntegrated(feeAddress));
	} catch {
		return null;
	}
	const b = xmrBindingFor(primary, account, permlink);
	if (b === null || b.paymentId !== paymentId || b.paymentId !== storedPaymentId) return null;
	return b;
}
