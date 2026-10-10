import { describe, expect, it } from 'vitest';
import { FAQ_ASSET_OF, faqKeyHidden, visibleFaqEntries } from './assetGate';
import type { FaqEntry } from '$utils/faqIndex';

describe('FAQ asset gate (v1.21.5)', () => {
	it('maps every per-asset entry to its coin, and never BLURT’s', () => {
		expect(FAQ_ASSET_OF.get('what_is_ltc')).toBe('LTC');
		expect(FAQ_ASSET_OF.get('why_usdt_warning')).toBe('USDT');
		expect(FAQ_ASSET_OF.get('which_dai_network')).toBe('DAI');
		expect(FAQ_ASSET_OF.get('what_is_barter')).toBe('BARTER');
		expect(FAQ_ASSET_OF.has('what_is_blurt')).toBe(false);
	});

	it('hides a switched-off coin’s entries and its related chips', () => {
		const e = (key: string, related: string[] = []): FaqEntry =>
			({ key, question: key, answer: key, related }) as unknown as FaqEntry;
		const entries = [
			e('what_is_ltc'),
			e('what_is_usdt', ['why_usdt_warning', 'what_is_ltc']),
			e('why_usdt_warning')
		];
		expect(faqKeyHidden('what_is_ltc', ['ltc'])).toBe(true);
		const out = visibleFaqEntries(entries, ['LTC']);
		expect(out.map((x) => x.key)).toEqual(['what_is_usdt', 'why_usdt_warning']);
		expect(out[0]!.related).toEqual(['why_usdt_warning']);
		expect(visibleFaqEntries(entries, [])).toHaveLength(3);
	});
});
