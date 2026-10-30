/**
 * v1.20.0 (G1) — is this instance's fee_recipient accepted by other instances
 * for the 90 % leg of BLURT fees? /v1/instance says `fee_recipient_registered`:
 * `true`, `false` (VERIFIED absent from the operator's on-chain registration)
 * or null/absent (unknown: an older indexer, a failed lookup). Only a verified
 * `false` is ever surfaced — "unknown" must never read as a problem.
 * Pure (no SvelteKit imports) so it is unit-tested directly.
 */

import { FEE_RECIPIENT } from '../orders/fee';

/** The wire value as the instance store keeps it. */
export function feeRecipientRegisteredOf(wire: unknown): boolean | null {
	return typeof wire === 'boolean' ? wire : null;
}

/** Show the "not registered yet" note on About this instance? */
export function showFeeRecipientUnregistered(registered: boolean | null | undefined): boolean {
	return registered === false;
}

/**
 * Which "not registered yet" note About this instance shows, or null for none.
 *
 * `registered` is about the CONFIGURED fees account. From 1 November 2026 (by
 * block time) the indexer then advertises the canonical treasury as
 * `fee_recipient` instead (apps/indexer/src/api/instance.ts
 * advertisedFeeRecipient): the site's users pay their fees whole to the
 * treasury, and naming `fee_recipient` as "this instance's fees account" would
 * name the treasury. A verified `false` never comes with the treasury as the
 * configured account (the treasury needs no registration), so the treasury
 * here means the indexer applies that rule. Before then, `fee_recipient` is
 * the configured account and other instances hide its BLURT-paid orders.
 */
export type FeeRecipientNote =
	| { readonly kind: 'hidden_elsewhere'; readonly account: string }
	| { readonly kind: 'paid_to_treasury'; readonly treasury: string };

export function feeRecipientNote(
	registered: boolean | null | undefined,
	feeRecipient: string,
	treasury: string = FEE_RECIPIENT
): FeeRecipientNote | null {
	if (!showFeeRecipientUnregistered(registered)) return null;
	return feeRecipient === treasury
		? { kind: 'paid_to_treasury', treasury }
		: { kind: 'hidden_elsewhere', account: feeRecipient };
}
