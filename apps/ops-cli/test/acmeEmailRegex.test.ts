/**
 * The certificate e-mail check: `/.+@.+\..+/`
 * backtracks cubically on a long paste of '@' characters, freezing the wizard.
 */
import { describe, expect, it } from 'vitest';
import { validateAcmeEmail } from '../src/init/ansibleVars.ts';

describe('validateAcmeEmail', () => {
	it('answers at once on a long hostile paste', () => {
		const t = Date.now();
		expect(validateAcmeEmail('@'.repeat(2500))).not.toBe(true);
		expect(Date.now() - t).toBeLessThan(200);
	});
	it('still takes ordinary addresses and refuses non-addresses', () => {
		expect(validateAcmeEmail('me@example.org')).toBe(true);
		expect(validateAcmeEmail('a.b+c@mail.example.co.uk')).toBe(true);
		expect(validateAcmeEmail('me@example')).not.toBe(true);
		expect(validateAcmeEmail('me @example.org')).not.toBe(true);
	});
});
