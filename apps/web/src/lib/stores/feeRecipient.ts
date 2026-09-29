/**
 * v1.20.0 (G1) — is this instance's fee_recipient accepted by other instances
 * for the 90 % leg of BLURT fees? /v1/instance says `fee_recipient_registered`:
 * `true`, `false` (VERIFIED absent from the operator's on-chain registration)
 * or null/absent (unknown: an older indexer, a failed lookup). Only a verified
 * `false` is ever surfaced — "unknown" must never read as a problem.
 * Pure (no SvelteKit imports) so it is unit-tested directly.
 */

/** The wire value as the instance store keeps it. */
export function feeRecipientRegisteredOf(wire: unknown): boolean | null {
	return typeof wire === 'boolean' ? wire : null;
}

/** Show the "not registered yet" note on About this instance? */
export function showFeeRecipientUnregistered(registered: boolean | null | undefined): boolean {
	return registered === false;
}
