/**
 * (D2/D4 → F): two new relay create-endpoint codes must NOT
 * fall through to 'broadcast_failed' ("the chain rejected…"), which would be
 * false — nothing was rejected. Every key returned must exist in en.json.
 */
import { describe, expect, it } from 'vitest';
import { signupErrorI18nKey } from './signupErrorKey';
import en from '$lib/i18n/locales/en.json';

function resolve(key: string): unknown {
	return key
		.split('.')
		.reduce<unknown>((o, k) => (o as Record<string, unknown> | undefined)?.[k], en);
}

describe('signupErrorI18nKey', () => {
	it('relay_fee_spike (signups paused while the operator reviews the fee)', () => {
		expect(signupErrorI18nKey('relay_fee_spike')).toBe(
			'onboarding.register_name.errors.relay_fee_spike'
		);
	});

	it('broadcast_outcome_unknown (retry with the same name in a minute)', () => {
		expect(signupErrorI18nKey('broadcast_outcome_unknown')).toBe(
			'onboarding.register_name.errors.broadcast_outcome_unknown'
		);
	});

	it('unknown codes still fall back to broadcast_failed', () => {
		expect(signupErrorI18nKey('something_new')).toBe(
			'onboarding.register_name.errors.broadcast_failed'
		);
	});

	it('every mapped key that already shipped exists in en.json', () => {
		for (const code of [
			'already_registered',
			'name_not_allowed',
			'rate_limited',
			'relay_out_of_funds',
			'chain_unavailable',
			'invite_expired',
			'altcha_expired',
			'unreachable',
			'broadcast_failed'
		]) {
			expect(typeof resolve(signupErrorI18nKey(code)), code).toBe('string');
		}
	});
});
