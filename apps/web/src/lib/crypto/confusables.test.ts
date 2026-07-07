/**
 * Confusables + reserved-name impersonation tests.
 *
 * Attack coverage verified:
 *   - Cross-script substitution (Cyrillic, Greek, fullwidth)
 *   - Small-cap Latin substitution
 *   - Accented-Latin substitution
 *   - Confusable dashes (en-dash, em-dash, underscore)
 *   - Leetspeak digit substitution (0→o, 1→i/l, 3→e, 4→a, 5→s, 7→t)
 *   - Symbol substitution (@→a, !→i, |→l, +→t, $→s)
 *   - Case variation (MORPHIT, Morphit, morphit — all caught)
 *   - Mixed combinations
 *   - Substring embedding (impersonation as part of a longer name)
 *
 * Negative cases (must NOT trigger):
 *   - Byte-identical legitimate reserved name
 *   - Unrelated names
 *   - Short inputs that can't contain any reserved name
 */

import { describe, it, expect } from 'vitest';
import { skeleton, impersonatesReservedName } from './confusables';
import { validateDisplayName } from './profile';

// ─── skeleton() — weaker per-character primitive ────────────────

describe('skeleton — canonical-form mapping', () => {
	it('is idempotent on lowercase ASCII canonical chars', () => {
		// Pick strings where every character is the canonical
		// representative for its bucket (no chars that map to a
		// different canonical).  Note: 'l' maps to 'i' in this
		// table because in many sans-serif fonts they're visually
		// indistinguishable — which is the WHOLE POINT of the
		// confusables table.  So 'alice' deliberately becomes
		// 'aiice' under skeleton() (catching alice-vs-aiice spoof
		// attempts).  Test below uses chars where every letter is
		// already canonical.
		expect(skeleton('morphit-fees')).toBe('morphit-fees');
		expect(skeleton('bob')).toBe('bob');
		expect(skeleton('agorise')).toBe('agorise');
	});

	it('maps the i/l confusable pair (sans-serif spoof vector)', () => {
		// Documents the i/l mapping that makes alice → aiice — the
		// table treats them as a confusable pair so impersonation
		// detection fires regardless of which spelling the
		// attacker chose.
		expect(skeleton('alice')).toBe('aiice');
	});

	it('maps Cyrillic confusables to canonical Latin', () => {
		expect(skeleton('\u0430')).toBe('a');
		expect(skeleton('\u043e')).toBe('o');
		expect(skeleton('\u0435')).toBe('e');
		expect(skeleton('\u0440')).toBe('p');
		expect(skeleton('\u0441')).toBe('c');
	});

	it('maps Greek confusables to canonical Latin', () => {
		expect(skeleton('\u03b1')).toBe('a');
		expect(skeleton('\u03bf')).toBe('o');
		expect(skeleton('\u03c1')).toBe('p');
	});

	it('maps fullwidth Latin to ASCII', () => {
		expect(skeleton('\uff41')).toBe('a');
		expect(skeleton('\uff4d\uff4f\uff52\uff50\uff48\uff49\uff54')).toBe('morphit');
	});

	it('maps em-dash and en-dash to hyphen', () => {
		expect(skeleton('\u2014')).toBe('-');
		expect(skeleton('\u2013')).toBe('-');
	});

	it('maps leetspeak digits to canonical letters', () => {
		// The reverse map is first-win per iteration order of
		// LETTER_EQUIVS. In our table `i` is defined before `l`,
		// so the digit `1` (which appears in both lists) resolves
		// to `i`. This is an implementation detail of skeleton();
		// impersonatesReservedName doesn't depend on it because it
		// uses regex equivalence classes, not the skeleton function.
		expect(skeleton('0')).toBe('o');
		expect(skeleton('3')).toBe('e');
		expect(skeleton('4')).toBe('a');
		expect(skeleton('5')).toBe('s');
		expect(skeleton('7')).toBe('t');
	});

	it('passes unmapped characters through unchanged', () => {
		expect(skeleton('\u3042\u3044\u3046')).toBe('\u3042\u3044\u3046');
		expect(skeleton('👋')).toBe('👋');
	});
});

// ─── impersonatesReservedName — substring + all substitutions ───

describe('impersonatesReservedName — attack coverage', () => {
	it('catches plain "morphit" substring', () => {
		expect(impersonatesReservedName('morphit-fan')).toBe(true);
		expect(impersonatesReservedName('big morphit user')).toBe(true);
		expect(impersonatesReservedName('amorphit')).toBe(true);
	});

	it('catches Cyrillic substitution in morphit-fees', () => {
		const attack = 'morphit-f\u0435es'; // Cyrillic е
		expect(attack).not.toBe('morphit-fees');
		expect(impersonatesReservedName(attack)).toBe(true);
	});

	it('catches Cyrillic substitution in standalone morphit', () => {
		expect(impersonatesReservedName('m\u043erphit')).toBe(true);
	});

	it('catches Greek substitution', () => {
		expect(impersonatesReservedName('m\u03bfrphit-fees')).toBe(true);
	});

	it('catches fullwidth Latin substitution', () => {
		expect(impersonatesReservedName('\uff4dorphit')).toBe(true);
	});

	it('catches mixed-script substitution', () => {
		expect(impersonatesReservedName('\uff4dorphit-f\u0435es')).toBe(true);
	});

	it('catches em-dash substitution for hyphen', () => {
		expect(impersonatesReservedName('morphit\u2014fees')).toBe(true);
	});

	it('catches underscore substitution for hyphen', () => {
		expect(impersonatesReservedName('morphit_fees')).toBe(true);
	});

	it('catches case variations (MORPHIT, Morphit, MoRpHiT)', () => {
		expect(impersonatesReservedName('MORPHIT-FEES')).toBe(true);
		expect(impersonatesReservedName('Morphit-Fees')).toBe(true);
		expect(impersonatesReservedName('MoRpHiT')).toBe(true);
	});

	it('catches accented-Latin substitution', () => {
		expect(impersonatesReservedName('m\u00f3rphit')).toBe(true);
	});

	it('catches leetspeak digits: m0rph1t', () => {
		expect(impersonatesReservedName('m0rph1t')).toBe(true);
	});

	it('catches mixed leet + letters: morph1t', () => {
		expect(impersonatesReservedName('morph1t')).toBe(true);
	});

	it('catches leetspeak in fees: morphit-f33s', () => {
		expect(impersonatesReservedName('morphit-f33s')).toBe(true);
	});

	it('catches aggressive leet: m0rph!t-f33$', () => {
		expect(impersonatesReservedName('m0rph!t-f33$')).toBe(true);
	});

	it('catches plain "agorise" substring', () => {
		expect(impersonatesReservedName('agorise-fan')).toBe(true);
		expect(impersonatesReservedName('big-agorise-user')).toBe(true);
	});

	it('catches leet in agorise: 4gor1se', () => {
		expect(impersonatesReservedName('4gor1se')).toBe(true);
	});

	it('catches case variations of agorise', () => {
		expect(impersonatesReservedName('AGORISE')).toBe(true);
		expect(impersonatesReservedName('Agorise')).toBe(true);
	});

	it('catches Cyrillic substitution in agorise', () => {
		expect(impersonatesReservedName('\u0430gorise')).toBe(true);
	});

	it('catches plain "kencode" substring', () => {
		expect(impersonatesReservedName('kencode-fan')).toBe(true);
		expect(impersonatesReservedName('the-kencode')).toBe(true);
	});

	it('catches leet in kencode: k3nc0d3', () => {
		expect(impersonatesReservedName('k3nc0d3')).toBe(true);
	});

	it('catches case variations of kencode', () => {
		expect(impersonatesReservedName('KENCODE')).toBe(true);
		expect(impersonatesReservedName('Kencode')).toBe(true);
	});

	it('catches embedded reserved names anywhere in the string', () => {
		expect(impersonatesReservedName('hello morphit world')).toBe(true);
		expect(impersonatesReservedName('look at agorise users')).toBe(true);
		expect(impersonatesReservedName('kencode is cool')).toBe(true);
	});
});

describe('impersonatesReservedName — legitimate uses', () => {
	it('does NOT block byte-identical reserved names (canonical lowercase)', () => {
		expect(impersonatesReservedName('morphit')).toBe(false);
		expect(impersonatesReservedName('morphit-fees')).toBe(false);
		expect(impersonatesReservedName('morphit-relay')).toBe(false);
		expect(impersonatesReservedName('agorise')).toBe(false);
		expect(impersonatesReservedName('kencode')).toBe(false);
	});

	it('does NOT block unrelated names', () => {
		expect(impersonatesReservedName('alice')).toBe(false);
		expect(impersonatesReservedName('Sally Doe')).toBe(false);
		expect(impersonatesReservedName('👋 BTC trader')).toBe(false);
		expect(impersonatesReservedName('Zen Master 42')).toBe(false);
	});

	it('does NOT block short inputs', () => {
		expect(impersonatesReservedName('mor')).toBe(false);
		expect(impersonatesReservedName('m')).toBe(false);
		expect(impersonatesReservedName('ago')).toBe(false);
		expect(impersonatesReservedName('ken')).toBe(false);
	});
});

// ─── Integration: validateDisplayName end-to-end ────────────────

describe('validateDisplayName — confusable impersonation (integration)', () => {
	it('rejects Cyrillic-substituted morphit-fees', () => {
		const bad = validateDisplayName('morphit-f\u0435es');
		expect(bad.ok).toBe(false);
		expect(bad.reasonKey).toContain('impersonation');
	});

	it('rejects leetspeak m0rph1t', () => {
		const bad = validateDisplayName('m0rph1t');
		expect(bad.ok).toBe(false);
		expect(bad.reasonKey).toContain('impersonation');
	});

	it('rejects substring embedding: morphit-enthusiast', () => {
		const bad = validateDisplayName('morphit-enthusiast');
		expect(bad.ok).toBe(false);
		expect(bad.reasonKey).toContain('impersonation');
	});

	it('rejects agorise-related names', () => {
		expect(validateDisplayName('agorise-fan').ok).toBe(false);
		expect(validateDisplayName('4gor1se').ok).toBe(false);
	});

	it('rejects kencode-related names', () => {
		expect(validateDisplayName('k3nc0d3').ok).toBe(false);
		expect(validateDisplayName('kencode-friend').ok).toBe(false);
	});

	it('accepts legitimate operator display name (byte-equal)', () => {
		expect(validateDisplayName('morphit-fees').ok).toBe(true);
		expect(validateDisplayName('agorise').ok).toBe(true);
		expect(validateDisplayName('kencode').ok).toBe(true);
	});

	it('accepts unrelated names', () => {
		expect(validateDisplayName('Alice').ok).toBe(true);
		expect(validateDisplayName('Sally Coffee Shop').ok).toBe(true);
		expect(validateDisplayName('Zen Master').ok).toBe(true);
	});

	it('leading-@ error still takes precedence over impersonation', () => {
		const bad = validateDisplayName('@morphit-fees');
		expect(bad.ok).toBe(false);
		expect(bad.reasonKey).toContain('leading_at');
	});
});
