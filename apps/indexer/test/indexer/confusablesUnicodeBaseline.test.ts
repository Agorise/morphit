/**
 * The strict reserved-name check (consensus, from 2026-11-01) must give the
 * same verdict on every Node.js an indexer may run. Its skeleton reads Unicode
 * properties, and a code point assigned after Unicode 15.1 is known to a newer
 * runtime and unknown (Cn) to Node 22.0's: U+0897 is removed as a combining
 * mark on Unicode 16 and kept on 15.1, so "morphࢗit-fees" was refused by
 * one indexer and accepted by another.
 *
 * Emulated here without a second runtime: for EVERY code point this runtime
 * knows and Unicode 15.1 did not, the verdict must be the one a 15.1 runtime
 * reaches — and on 15.1 such a code point has no properties at all, so the
 * only verdict both can share is the one with the code point taken out.
 */
import { describe, expect, it } from 'vitest';
import { unassignedInUnicodeBaseline } from '@morphit/asset-registry';
import { confusableSkeleton, impersonatesReservedName } from '../../src/indexer/confusables';

/** Code points this runtime has assigned that Unicode 15.1 had not. */
function newerThanBaseline(): number[] {
	const out: number[] = [];
	const unassignedHere = /\p{Cn}/u;
	for (let cp = 0; cp <= 0x10ffff; cp++) {
		if (cp >= 0xd800 && cp <= 0xdfff) continue;
		if (unassignedInUnicodeBaseline(cp) && !unassignedHere.test(String.fromCodePoint(cp))) {
			out.push(cp);
		}
	}
	return out;
}

describe('strict reserved-name check: same verdict on every Unicode version', () => {
	const fresh = newerThanBaseline();

	it('this runtime knows code points Unicode 15.1 did not (else the test proves nothing)', () => {
		// Node 22.22 ships Unicode 16.0 (over 5,000 new code points).
		expect(fresh.length).toBeGreaterThan(1000);
	});

	it('a post-15.1 code point inside a reserved name is refused on every runtime', () => {
		const accepted = fresh.filter(
			(cp) => !impersonatesReservedName(`morph${String.fromCodePoint(cp)}it-fees`, { strict: true })
		);
		expect(accepted.map((cp) => cp.toString(16))).toEqual([]);
	});

	it('the skeleton never depends on a post-15.1 code point', () => {
		for (const cp of fresh.slice(0, 2000)) {
			const ch = String.fromCodePoint(cp);
			expect(confusableSkeleton(`a${ch}b`)).toBe(confusableSkeleton('ab'));
		}
	});
});
