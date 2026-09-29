/**
 * Register-name submit gate (pure, unit-tested in signupSubmitGate.test.ts).
 *
 * Wave 4 (A4, web half):
 *  - A failed attempt must not leave the claim button dead: an 'error' state
 *    is retryable, and editing the name clears the error back to 'ready'.
 *  - After `broadcast_outcome_unknown` the account may have landed with THIS
 *    user's owner key, so the live availability check now says "taken". The
 *    relay answers a same-name retry with success (`note: 'already_created'`)
 *    when the owner key matches, or 409 `already_registered` when it does
 *    not — so that one name stays submittable while it shows "taken".
 */
export type SubmitKind = 'ready' | 'submitting' | 'done' | 'error';
export type AvailabilityKind =
	| 'idle'
	| 'checking'
	| 'available'
	| 'taken'
	| 'rejected'
	| 'unreachable';

export interface SubmitGateInput {
	submitKind: SubmitKind;
	availabilityKind: AvailabilityKind;
	/** normalized (trimmed, lowercased) name */
	name: string;
	/** name whose last attempt ended `broadcast_outcome_unknown`, else null */
	pendingRetryName: string | null;
}

export function canSubmitSignup(i: SubmitGateInput): boolean {
	if (i.name.length < 3) return false;
	if (i.submitKind !== 'ready' && i.submitKind !== 'error') return false;
	if (i.availabilityKind === 'available') return true;
	return (
		i.availabilityKind === 'taken' && i.pendingRetryName !== null && i.name === i.pendingRetryName
	);
}

/** The same-name retry exemption after a failed attempt with `code`. */
export function pendingRetryAfterError(
	code: string,
	name: string,
	prev: string | null
): string | null {
	if (code === 'broadcast_outcome_unknown') return name;
	// The name is definitively someone else's (different owner key).
	if (code === 'already_registered') return null;
	// Transient failure on the retry itself: the retry is still needed.
	return prev;
}

/** Editing the name clears a stale error so the button becomes live again. */
export function submitKindAfterNameEdit(kind: SubmitKind): SubmitKind {
	return kind === 'error' ? 'ready' : kind;
}
