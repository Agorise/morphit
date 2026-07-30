/**
 * Tests for the signer-extraction and payload-parsing helpers.
 *
 * These are the authorization gates every handler relies on, so
 * each rejection reason gets a test. Happy paths are covered
 * implicitly in handler tests; here we concentrate on the sad
 * paths that are easy to introduce regressions into.
 */

import { describe, expect, it } from 'vitest';
import {
	extractSigner,
	parseJsonPayload,
	resolveSignerPostingPubkey,
	type CustomJsonOp
} from '$blurt/verify';

function makeOp(partial: Partial<CustomJsonOp>): CustomJsonOp {
	return {
		required_auths: [],
		required_posting_auths: [],
		id: 'morphit_profile_v1',
		json: '{}',
		...partial
	};
}

describe('extractSigner', () => {
	it('returns the single posting signer on a well-formed op', () => {
		const op = makeOp({ required_posting_auths: ['alice'] });
		const r = extractSigner(op);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.signer).toBe('alice');
	});

	it('rejects ops with no posting auth', () => {
		const op = makeOp({ required_posting_auths: [] });
		const r = extractSigner(op);
		expect(r).toEqual({ ok: false, reason: 'no_posting_auth' });
	});

	it('rejects ops with multiple posting auths', () => {
		const op = makeOp({ required_posting_auths: ['alice', 'bob'] });
		const r = extractSigner(op);
		expect(r).toEqual({ ok: false, reason: 'multiple_posting_auths' });
	});

	it('rejects ops that use active-level auth', () => {
		const op = makeOp({
			required_auths: ['alice'],
			required_posting_auths: []
		});
		const r = extractSigner(op);
		expect(r).toEqual({ ok: false, reason: 'active_auth_not_allowed' });
	});

	it('rejects ops that present active AND posting (still active-only rejection)', () => {
		// required_auths non-empty trumps; we don't try to "guess" which
		// auth was intended.
		const op = makeOp({
			required_auths: ['alice'],
			required_posting_auths: ['alice']
		});
		const r = extractSigner(op);
		expect(r).toEqual({ ok: false, reason: 'active_auth_not_allowed' });
	});

	it('rejects ops where the required_posting_auths field is not an array', () => {
		// Simulate a malformed op where the field came through as
		// something other than an array.
		const op = {
			required_auths: [],
			required_posting_auths: 'alice' as unknown as readonly string[],
			id: 'morphit_profile_v1',
			json: '{}'
		};
		const r = extractSigner(op as CustomJsonOp);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.reason).toBe('missing_required_auths_field');
	});

	// cp407 — fee-bearing ops (order-create, feature-bid, stranger-fee) are
	// active-level because they carry the fee transfer in the same tx. The
	// dispatcher opts those in via allowActiveAuth=true.
	it('accepts an active-level op when allowActiveAuth is true', () => {
		const op = makeOp({ required_auths: ['alice'], required_posting_auths: [] });
		const r = extractSigner(op, true);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.signer).toBe('alice');
	});

	it('still rejects mixed active+posting even when allowActiveAuth is true', () => {
		const op = makeOp({ required_auths: ['alice'], required_posting_auths: ['alice'] });
		const r = extractSigner(op, true);
		expect(r).toEqual({ ok: false, reason: 'active_auth_not_allowed' });
	});

	it('still rejects multiple active auths even when allowActiveAuth is true', () => {
		const op = makeOp({ required_auths: ['alice', 'bob'], required_posting_auths: [] });
		const r = extractSigner(op, true);
		expect(r).toEqual({ ok: false, reason: 'active_auth_not_allowed' });
	});

	it('allowActiveAuth does not change the posting-auth path', () => {
		const op = makeOp({ required_posting_auths: ['alice'] });
		const r = extractSigner(op, true);
		expect(r.ok).toBe(true);
		if (r.ok) expect(r.signer).toBe('alice');
	});
});

describe('resolveSignerPostingPubkey', () => {
	const singleKeyAccount = {
		name: 'alice',
		posting: {
			weight_threshold: 1,
			account_auths: [] as const,
			key_auths: [['BLT7gHu8mnFa7qETKyxP9vfX3jWLA9SgP1F8vQqKyPs7Cx2pTyyJn', 1]] as const
		},
		active: {
			weight_threshold: 1,
			account_auths: [] as const,
			key_auths: [] as const
		},
		owner: {
			weight_threshold: 1,
			account_auths: [] as const,
			key_auths: [] as const
		},
		memo_key: 'BLT...'
	};

	it('returns the single posting pubkey when it meets the weight threshold', () => {
		const pk = resolveSignerPostingPubkey(singleKeyAccount);
		expect(pk).toBe('BLT7gHu8mnFa7qETKyxP9vfX3jWLA9SgP1F8vQqKyPs7Cx2pTyyJn');
	});

	it('returns null if the account is null', () => {
		expect(resolveSignerPostingPubkey(null)).toBeNull();
	});

	it('returns null if the account is undefined', () => {
		expect(resolveSignerPostingPubkey(undefined)).toBeNull();
	});

	it('returns null for multi-sig posting auths (out of scope for v1)', () => {
		const multisig = {
			...singleKeyAccount,
			posting: {
				...singleKeyAccount.posting,
				key_auths: [
					['BLTaaa', 1],
					['BLTbbb', 1]
				] as const
			}
		};
		expect(resolveSignerPostingPubkey(multisig)).toBeNull();
	});

	it('returns null if the key weight is below the threshold', () => {
		// Weight 1 but threshold 2 — the key alone isn't sufficient.
		const underweight = {
			...singleKeyAccount,
			posting: {
				weight_threshold: 2,
				account_auths: [] as const,
				key_auths: [['BLTsingle', 1]] as const
			}
		};
		expect(resolveSignerPostingPubkey(underweight)).toBeNull();
	});
});

describe('parseJsonPayload', () => {
	it('parses well-formed JSON', () => {
		const op = makeOp({ json: '{"foo":"bar"}' });
		expect(parseJsonPayload(op)).toEqual({ foo: 'bar' });
	});

	it('returns null on malformed JSON', () => {
		const op = makeOp({ json: '{not json}' });
		expect(parseJsonPayload(op)).toBeNull();
	});

	it('returns null on empty string', () => {
		const op = makeOp({ json: '' });
		expect(parseJsonPayload(op)).toBeNull();
	});
});
