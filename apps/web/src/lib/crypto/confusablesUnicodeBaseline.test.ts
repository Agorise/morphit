/**
 * The web's reserved-name check folds names like the indexer's from the
 * consensus activation time: code points Unicode 15.1 had not assigned are
 * taken out first, so what the form refuses does not depend on the browser's
 * or the server's Unicode version (the indexer side:
 * apps/indexer/test/indexer/confusablesUnicodeBaseline.test.ts).
 */
import { describe, expect, it } from 'vitest';
import { unassignedInUnicodeBaseline } from '@morphit/asset-registry';
import { confusableSkeleton, impersonatesReservedName } from './confusables';

function newerThanBaseline(limit: number): number[] {
	const out: number[] = [];
	const unassignedHere = /\p{Cn}/u;
	for (let cp = 0; cp <= 0x10ffff && out.length < limit; cp++) {
		if (cp >= 0xd800 && cp <= 0xdfff) continue;
		if (unassignedInUnicodeBaseline(cp) && !unassignedHere.test(String.fromCodePoint(cp)))
			out.push(cp);
	}
	return out;
}

describe('web reserved-name skeleton: post-Unicode-15.1 code points removed', () => {
	const fresh = newerThanBaseline(2000);
	it('this runtime knows such code points (else the test proves nothing)', () => {
		expect(fresh.length).toBeGreaterThan(100);
	});
	it('they never change the skeleton', () => {
		for (const cp of fresh) {
			expect(confusableSkeleton(`a${String.fromCodePoint(cp)}b`)).toBe(confusableSkeleton('ab'));
		}
	});
	it('a reserved name with one inside is still refused', () => {
		expect(impersonatesReservedName('morphࢗit-fees')).toBe(true);
		expect(impersonatesReservedName(`morph${String.fromCodePoint(fresh[0]!)}it-fees`)).toBe(true);
	});
});
