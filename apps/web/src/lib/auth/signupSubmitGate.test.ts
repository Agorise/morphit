/**
 * Wave 4 (A4, web half): after a failed signup the button must not stay
 * dead, and after `broadcast_outcome_unknown` the user must be able to retry
 * the SAME name even though availability now says "taken" — the account
 * may have landed with this user's own owner key, and the relay answers
 * that retry with success (`note: 'already_created'`).
 */
import { describe, expect, it } from 'vitest';
import {
	canSubmitSignup,
	pendingRetryAfterError,
	submitKindAfterNameEdit
} from './signupSubmitGate';

const base = {
	submitKind: 'ready' as const,
	availabilityKind: 'available' as const,
	name: 'alice',
	pendingRetryName: null
};

describe('canSubmitSignup', () => {
	it('ready + available + >=3 chars submits (unchanged)', () => {
		expect(canSubmitSignup(base)).toBe(true);
	});
	it('never while submitting or done, never under 3 chars', () => {
		expect(canSubmitSignup({ ...base, submitKind: 'submitting' })).toBe(false);
		expect(canSubmitSignup({ ...base, submitKind: 'done' })).toBe(false);
		expect(canSubmitSignup({ ...base, name: 'al' })).toBe(false);
	});
	it('an error state is retryable (the button is not dead after a failure)', () => {
		expect(canSubmitSignup({ ...base, submitKind: 'error' })).toBe(true);
	});
	it('after outcome-unknown, the SAME name can be retried although it now shows taken', () => {
		expect(
			canSubmitSignup({
				...base,
				submitKind: 'error',
				availabilityKind: 'taken',
				pendingRetryName: 'alice'
			})
		).toBe(true);
		expect(canSubmitSignup({ ...base, availabilityKind: 'taken', pendingRetryName: 'alice' })).toBe(
			true
		);
	});
	it('a DIFFERENT taken name stays blocked; taken without a pending retry stays blocked', () => {
		expect(
			canSubmitSignup({
				...base,
				name: 'bob',
				availabilityKind: 'taken',
				pendingRetryName: 'alice'
			})
		).toBe(false);
		expect(canSubmitSignup({ ...base, availabilityKind: 'taken' })).toBe(false);
	});
	it('the retry exemption covers only "taken", not rejected/checking/unreachable', () => {
		for (const k of ['rejected', 'checking', 'unreachable', 'idle'] as const) {
			expect(canSubmitSignup({ ...base, availabilityKind: k, pendingRetryName: 'alice' })).toBe(
				false
			);
		}
	});
});

describe('pendingRetryAfterError', () => {
	it('broadcast_outcome_unknown remembers the name', () => {
		expect(pendingRetryAfterError('broadcast_outcome_unknown', 'alice', null)).toBe('alice');
	});
	it('already_registered (someone else owns it) clears the exemption', () => {
		expect(pendingRetryAfterError('already_registered', 'alice', 'alice')).toBe(null);
	});
	it('a transient failure on the retry keeps it (retry still needed)', () => {
		expect(pendingRetryAfterError('chain_unavailable', 'alice', 'alice')).toBe('alice');
		expect(pendingRetryAfterError('rate_limited', 'alice', 'alice')).toBe('alice');
	});
});

describe('submitKindAfterNameEdit', () => {
	it('editing the name clears an error back to ready', () => {
		expect(submitKindAfterNameEdit('error')).toBe('ready');
	});
	it('does not disturb submitting/done/ready', () => {
		expect(submitKindAfterNameEdit('submitting')).toBe('submitting');
		expect(submitKindAfterNameEdit('done')).toBe('done');
		expect(submitKindAfterNameEdit('ready')).toBe('ready');
	});
});
