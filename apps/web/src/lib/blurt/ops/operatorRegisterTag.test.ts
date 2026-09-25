/**
 * The run-a-node form refuses the tags the indexer refuses (v1.18.0 deep-deep,
 * L3 follow-through): a look-alike of a reserved name on a first registration,
 * unless the registering account owns the name. Before, the form checked exact
 * reserved names only, so an operator could broadcast `m0rphit` and the network
 * would silently ignore the registration.
 */
import { describe, it, expect } from 'vitest';
import { validateTag } from './operatorRegister';

describe('run-a-node tag check', () => {
	it.each(['m0rphit', 'rnorphit', 'morphit-io', 'morphit.io'])(
		'refuses %s for an account that does not own the name',
		(tag) => {
			expect(validateTag(tag, 'mallory')).toEqual({ ok: false, reason: 'tag_reserved' });
		}
	);
	it('accepts a tag built on a reserved name for the account that owns it', () => {
		expect(validateTag('morphit.io', 'morphit').ok).toBe(true);
	});
	it('accepts ordinary and deliberately allowed tags', () => {
		for (const t of ['example-node', 'mymorphit', 'morphitlat-relay']) {
			expect(validateTag(t, 'mallory').ok).toBe(true);
		}
	});
});
