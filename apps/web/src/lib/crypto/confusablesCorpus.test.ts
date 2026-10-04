/**
 * Look-alike display names a stranger must not be able to set: invisible
 * padding, mathematical letters and combining marks inside a reserved name
 * (the QZ-1 corpus), and the exact reserved name itself (QZ-2).
 */
import { describe, expect, it } from 'vitest';
import { validateDisplayName } from './profile';

const IMPOSTORS: Record<string, string> = {
	'plain, exact': 'morphit-fees',
	'ZWNJ inside': 'morph‌it-fees',
	'ZWJ inside': 'morph‍it-fees',
	'LRM inside': 'morph‎it-fees',
	'RLM inside': 'morph‏it-fees',
	'soft hyphen': 'morph­it-fees',
	CGJ: 'morph͏it-fees',
	MVS: 'morph᠎it-fees',
	VS16: 'morph️it-fees',
	'tag character': 'morph\u{E0020}it-fees',
	'Hangul filler': 'morphㅤit',
	'math bold': '\u{1D426}\u{1D428}\u{1D42B}\u{1D429}\u{1D421}\u{1D422}\u{1D42D}',
	'o + dot above': 'mȯrphit',
	'Cyrillic er': 'morрhit-fees',
	'Armenian oh': 'mօrphit',
	'circled m': 'ⓜorphit'
};

describe('a stranger cannot pass as a reserved account', () => {
	for (const [label, name] of Object.entries(IMPOSTORS)) {
		it(`${label}: ${JSON.stringify(name)} is rejected`, () => {
			expect(validateDisplayName(name, 'mallory').ok).toBe(false);
		});
	}

	it('ordinary names, emoji and a subdivision flag still pass', () => {
		for (const name of [
			'Alice',
			'Sally ❤️ Coffee',
			'Fatemeh',
			'Scot 🏴\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}'
		]) {
			expect(validateDisplayName(name, 'alice').ok).toBe(true);
		}
	});
});
