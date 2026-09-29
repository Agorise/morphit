/**
 * v1.20.0 — which XMR listing-fee flow applies, and the tx key check.
 * Dependency-free on purpose (the post page imports it; the address maths
 * lives in ./xmrFeeAddress.ts, loaded with the fee panel).
 *
 * M-X1: an XMR fee is proven with the payment's transaction key — 64 hex
 * characters every Monero wallet shows for a sent payment — not with a
 * "payment proof" string (the explorers indexers use cannot check those).
 *
 * MK-H2: once the chain-pinned release carries the treasury's MAIN address
 * (`treasury.xmr.primary_address`), the fee is paid to an address made for
 * this one listing, so the listing's name (permlink) is chosen BEFORE paying.
 */
import type { ReleaseTreasuryBlock } from '@morphit/release-schema';

/** The pinned treasury main address when XMR fees are order-bound, else null.
 *  (releaseValidate has already checked it is a mainnet `4…` address.) */
export function xmrBoundPrimary(treasury: ReleaseTreasuryBlock | null): string | null {
	const p = treasury?.xmr?.primary_address;
	return typeof p === 'string' && p.length > 0 ? p : null;
}

export type XmrTxKeyCheck = 'empty' | 'ok' | 'several' | 'malformed';

/** 'several': the wallet printed its main key followed by extra keys (it
 *  does that when one payment went to several addresses) — the fee must be
 *  sent in a payment of its own. */
export function checkXmrTxKey(raw: string): XmrTxKeyCheck {
	const s = raw.trim();
	if (s.length === 0) return 'empty';
	if (/^[0-9a-fA-F]{64}$/.test(s)) return 'ok';
	if (/^(?:[0-9a-fA-F]{64}){2,}$/.test(s)) return 'several';
	return 'malformed';
}
