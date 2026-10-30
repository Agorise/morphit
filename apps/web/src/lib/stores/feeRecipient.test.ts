import { describe, expect, it } from 'vitest';
import {
	feeRecipientNote,
	feeRecipientRegisteredOf,
	showFeeRecipientUnregistered
} from './feeRecipient';
import en from '../i18n/locales/en.json';

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

describe('the note on About this instance, before and after 1 November 2026', () => {
	const fill = (t: string, v: Record<string, string>) =>
		t.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? `{${k}}`);
	const render = (registered: boolean | null, feeRecipient: string): string | null => {
		const n = feeRecipientNote(registered, feeRecipient);
		if (n === null) return null;
		return n.kind === 'paid_to_treasury'
			? fill(en.about_this_instance.fee_recipient_unregistered_to_treasury, {
					treasury: n.treasury
				})
			: fill(en.about_this_instance.fee_recipient_unregistered, { account: n.account });
	};

	it('before: names the unregistered account, and says other instances hide its orders', () => {
		const text = render(false, 'zed-fees') ?? '';
		expect(text).toMatch(/fees account @zed-fees is not in/);
		expect(text).toMatch(/hide orders paid in BLURT here/);
	});

	it('after (the indexer advertises the treasury): never names the treasury as this instance’s fees account', () => {
		const text = render(false, 'morphit-fees') ?? '';
		expect(text).not.toMatch(/fees account @morphit-fees/);
		expect(text).not.toMatch(/hide/);
		expect(text).toMatch(/fees paid on this site go to the Morphit treasury \(@morphit-fees\)/);
		expect(text).toMatch(/sudo morphit-ops register/);
	});

	it('no note when registered or unknown', () => {
		expect(render(true, 'morphit-fees')).toBeNull();
		expect(render(null, 'zed-fees')).toBeNull();
	});
});
