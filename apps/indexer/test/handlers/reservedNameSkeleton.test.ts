/**
 * the reserved-name guard compares on a confusable skeleton and
 * has no exemption for the exact reserved string.
 *
 * Before: invisible / default-ignorable characters (ZWNJ, LRM, soft hyphen,
 * CGJ, MVS, variation selectors, tag characters, Hangul filler), math
 * alphanumerics, circled and superscript letters, the Kelvin sign, the long s
 * and Armenian oh all got a reserved name past the homoglyph table, and ANY
 * signer could set exactly `morphit-fees` (the byte-equality escape) — QZ-1,
 * QZ-2. From CONSENSUS_V2_ACTIVATION_TIME all of these are refused; earlier
 * ops keep their verdicts.
 */
import { describe, expect, it } from 'vitest';
import profileHandler from '$indexer/handlers/profile';
import { impersonatesReservedOperatorName } from '$indexer/confusables';
import { CONSENSUS_V2_ACTIVATION_TIME } from '$indexer/consensusActivation';
import { makeCtx } from '../testutils/context';

const db = { query: async () => ({ rows: [], rowCount: 0 }) } as never;
const ACTIVATION = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
const AFTER = new Date(ACTIVATION + 1000);
const BEFORE = new Date(ACTIVATION - 1000);
const IMPERSONATES = 'display_name_impersonates_reserved';

async function verdict(name: string, signer = 'mallory', blockTime = AFTER): Promise<string> {
	const r = await profileHandler(
		makeCtx({ signer, blockTime, payload: { display_name: name } }),
		db
	);
	return r.ok ? 'ok' : r.reason;
}

const CORPUS: Record<string, string> = {
	'ZWNJ inside': 'morph‌it-fees',
	'ZWJ inside': 'morph‍it-fees',
	'LRM inside': 'morph‎it-fees',
	'RLM inside': 'morph‏it-fees',
	'soft hyphen': 'morph­it-fees',
	CGJ: 'morph͏it-fees',
	'Mongolian vowel separator': 'morph᠎it-fees',
	'variation selector 16': 'morph️it-fees',
	'tag character': 'morph\u{E0020}it-fees',
	'Hangul filler': 'morphㅤit',
	'math bold': '\u{1D426}\u{1D428}\u{1D42B}\u{1D429}\u{1D421}\u{1D422}\u{1D42D}',
	'o with dot above': 'mȯrphit',
	'long s': 'morphit-feeſ',
	'Kelvin sign': 'Kencode',
	'Armenian oh': 'mօrphit',
	'superscript h': 'morpʰit',
	'circled m': 'ⓜorphit'
};

describe('reserved names are compared on a confusable skeleton', () => {
	for (const [label, name] of Object.entries(CORPUS)) {
		it(`refuses ${label}`, async () => {
			expect(await verdict(name)).toBe(IMPERSONATES);
		});
	}

	it('a stranger setting EXACTLY a reserved name is refused', async () => {
		expect(await verdict('morphit-fees')).toBe(IMPERSONATES);
		expect(await verdict('kencode')).toBe(IMPERSONATES);
	});

	it('the rightful owner keeps their own name, in any form', async () => {
		expect(await verdict('agorise', 'agorise')).not.toBe(IMPERSONATES);
		expect(await verdict('Agorise Team', 'agorise')).not.toBe(IMPERSONATES);
	});

	it('ordinary names — including a Persian name with ZWNJ — are untouched', async () => {
		expect(await verdict('می‌خواهم')).not.toBe(IMPERSONATES);
		expect(await verdict('Sally 👋')).not.toBe(IMPERSONATES);
	});

	it('operator display names: a bare brand behind invisible characters or math letters is refused', () => {
		const strict = { strict: true };
		expect(impersonatesReservedOperatorName('morph​it', strict)).toBe(true);
		expect(
			impersonatesReservedOperatorName(
				'\u{1D426}\u{1D428}\u{1D42B}\u{1D429}\u{1D421}\u{1D422}\u{1D42D}',
				strict
			)
		).toBe(true);
		expect(impersonatesReservedOperatorName('Morphit Latino', strict)).toBe(false);
	});

	it('before the activation time the old verdicts stand', async () => {
		expect(await verdict('morphit-fees', 'mallory', BEFORE)).not.toBe(IMPERSONATES);
		expect(
			await verdict(
				'\u{1D426}\u{1D428}\u{1D42B}\u{1D429}\u{1D421}\u{1D422}\u{1D42D}',
				'mallory',
				BEFORE
			)
		).not.toBe(IMPERSONATES);
	});
});
