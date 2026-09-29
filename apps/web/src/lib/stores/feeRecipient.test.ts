import { describe, expect, it } from 'vitest';
import { feeRecipientRegisteredOf, showFeeRecipientUnregistered } from './feeRecipient';

describe('fee-recipient registration note (G1)', () => {
	it('keeps only a real boolean from /v1/instance', () => {
		expect(feeRecipientRegisteredOf(true)).toBe(true);
		expect(feeRecipientRegisteredOf(false)).toBe(false);
		for (const v of [undefined, null, 'false', 0, 1, {}])
			expect(feeRecipientRegisteredOf(v)).toBeNull();
	});
	it('shows the note only on a VERIFIED false — never when unknown', () => {
		expect(showFeeRecipientUnregistered(false)).toBe(true);
		expect(showFeeRecipientUnregistered(true)).toBe(false);
		expect(showFeeRecipientUnregistered(null)).toBe(false);
		expect(showFeeRecipientUnregistered(undefined)).toBe(false);
		// The wire string "false" is not a verified false.
		expect(showFeeRecipientUnregistered(feeRecipientRegisteredOf('false'))).toBe(false);
	});
});
