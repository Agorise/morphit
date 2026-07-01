/**
 * Morphit — Unicode confusables skeleton table.
 *
 * ─── Why this exists ────────────────────────────────────────────
 *
 * Our display_name validator already blocks the obvious
 * impersonation tricks: leading `@`, bidi overrides, invisible
 * characters. There's one trick left: **visual homographs**.
 *
 * The letter `а` (Cyrillic U+0430) is visually identical to the
 * letter `a` (Latin U+0061) in almost every font. A user could
 * register a display name like `morphit-fеes` where the `е` is
 * Cyrillic U+0435 instead of Latin U+0065. Renders as
 * "morphit-fees" to the eye; is a completely different string
 * byte-for-byte. Bypasses any blocklist that compares strings
 * naively.
 *
 * Fix: compute the visual "skeleton" of the input — map every
 * character to its Latin-alphabet equivalent — then compare
 * skeletons. Unicode's TR39 (Security Mechanisms) defines the
 * formal algorithm. This module implements a hand-curated subset
 * covering the characters most commonly weaponized for Latin-
 * alphabet homograph attacks.
 *
 * ─── Coverage decision ──────────────────────────────────────────
 *
 * The full Unicode confusables table is ~6600 mappings and 30-50
 * KB uncompressed. Most entries are irrelevant for us (Arabic
 * numerals, mathematical alphanumeric symbols, etc). We curate a
 * narrower set: characters that:
 *   (a) might plausibly appear in a user's display_name, and
 *   (b) visually resemble a character in the Latin alphabet,
 *       hyphen, or digit that appears in our reserved names.
 *
 * The result is ~250 mappings covering Cyrillic, Greek, fullwidth
 * Latin, and the common Latin combining forms. A motivated
 * attacker could find an edge-case character we missed; this is
 * defense-in-depth atop the always-rendered identicon, not the
 * sole defense.
 *
 * ─── Maintenance ────────────────────────────────────────────────
 *
 * Unicode publishes table updates, but the core Latin-homograph
 * mappings have been stable for a decade+. New entries are
 * usually for newly-assigned scripts that don't affect Latin
 * attack surface. A yearly glance at
 * https://www.unicode.org/Public/security/latest/confusables.txt
 * for anything in the Latin block is plenty.
 */

/**
 * Morphit — reserved-name impersonation defense.
 *
 * ─── What this module does ──────────────────────────────────────
 *
 * Rejects display_names (and usernames at registration time) that
 * contain a visual-look-alike for any reserved name. Catches:
 *
 *   - Exact reserved-name substrings:         "morphit-fan"
 *   - Cross-script substitution:              "m\u043erphit"
 *     (Cyrillic о for Latin o)
 *   - Fullwidth/small-cap substitution:       "ｍorphit"
 *   - Accented-Latin substitution:            "mórphit"
 *   - Leetspeak digit substitution:           "m0rph1t"
 *     (0 for o, 1 for i)
 *   - Case variation:                          "MORPHIT-FEES"
 *   - Any combination of the above:            "m\u043erph1t-f\u0435es"
 *
 * The impersonation check runs case-INSENSITIVELY, as a substring
 * search. So "Morphit Enthusiast" gets rejected just like "morphit"
 * standalone. The byte-equality escape preserves legitimate
 * operator accounts setting their own canonical name.
 *
 * ─── How it works ───────────────────────────────────────────────
 *
 * For each reserved name, we build a regex where each letter of
 * the name becomes a character class of its visual equivalents.
 * E.g. the reserved name "morphit" compiles to a regex matching
 * any of [mM...][oO0...][rR...]...[iI1...][tT7...] at any
 * position in the input.
 *
 * The equivalence classes are auditable one letter at a time in
 * LETTER_EQUIVS below. Adding coverage for a new confusable is
 * one line.
 *
 * ─── Known limitations (documented, accepted) ───────────────────
 *
 *   - Users legitimately wanting names like "MORPHIT" (all-caps
 *     Latin) or containing digit/letter patterns that happen to
 *     match get a false positive. The false-positive rate is
 *     small; the anti-phishing gain is large.
 *   - A motivated attacker could find a Unicode character we
 *     didn't list. This is defense-in-depth atop the always-
 *     rendered identicon, not the sole defense.
 *   - Digit substitution is one-way (digit → letter only). We
 *     don't try to detect users spelling "morph7" as a shorthand
 *     for "morph-seven" and mistakenly rejecting it — this kind
 *     of collateral is already accepted.
 */

/** Per-letter equivalence classes. Each entry lists every
 *  character that should be treated as visually equivalent to
 *  the key letter when building a reserved-name regex.
 *
 *  Both uppercase and lowercase Latin are included in each
 *  entry because the regex we compile is case-insensitive;
 *  including both makes each entry self-documenting. */
const LETTER_EQUIVS: Record<string, readonly string[]> = {
	a: [
		'a',
		'A',
		// Cyrillic
		'\u0430',
		'\u0410', // а А
		// Greek
		'\u03b1',
		'\u0391', // α Α
		// Fullwidth
		'\uff41',
		'\uff21', // ａ Ａ
		// Small-cap
		'\u1d00',
		// Accented lowercase
		'\u00e0',
		'\u00e1',
		'\u00e2',
		'\u00e3',
		'\u00e4',
		'\u00e5',
		'\u0101',
		'\u0103',
		'\u0105',
		// Accented uppercase
		'\u00c0',
		'\u00c1',
		'\u00c2',
		'\u00c3',
		'\u00c4',
		'\u00c5',
		// Leetspeak
		'4',
		'@'
	],
	b: [
		'b',
		'B',
		'\u0432',
		'\u0412', // Cyrillic в В
		'\u0392', // Greek Β
		'\uff42',
		'\uff22', // fullwidth
		'6' // leet (less common but sometimes used)
	],
	c: [
		'c',
		'C',
		'\u0441',
		'\u0421', // Cyrillic с С
		'\uff43',
		'\uff23',
		'\u1d04',
		'\u00e7',
		'\u0107',
		'\u0109',
		'\u010d',
		'\u00c7',
		'\u0106'
	],
	d: [
		'd',
		'D',
		'\u0501', // Cyrillic ԁ
		'\uff44',
		'\uff24'
	],
	e: [
		'e',
		'E',
		'\u0435',
		'\u0415', // Cyrillic е Е
		'\u03b5',
		'\u0395', // Greek ε Ε
		'\uff45',
		'\uff25',
		'\u1d07',
		'\u00e8',
		'\u00e9',
		'\u00ea',
		'\u00eb',
		'\u0113',
		'\u0117',
		'\u011b',
		'\u00c8',
		'\u00c9',
		'\u00ca',
		'\u00cb',
		'3' // leet
	],
	f: ['f', 'F', '\uff46', '\uff26'],
	g: [
		'g',
		'G',
		'\uff47',
		'\uff27',
		'9' // leet
	],
	h: [
		'h',
		'H',
		'\u04bb', // Cyrillic һ
		'\u0397',
		'\u041d', // Greek Η, Cyrillic Н (both look like H)
		'\uff48',
		'\uff28'
	],
	i: [
		'i',
		'I',
		'\u0456',
		'\u0406', // Cyrillic і І
		'\u03b9',
		'\u0399', // Greek ι Ι
		'\uff49',
		'\uff29',
		'\u026a',
		'\u00ec',
		'\u00ed',
		'\u00ee',
		'\u00ef',
		'\u012b',
		'\u012f',
		'\u0131',
		'\u00cc',
		'\u00cd',
		'\u00ce',
		'\u00cf',
		'1',
		'!',
		'|',
		'l',
		'L' // l/L commonly confused with i in sans-serif
	],
	j: [
		'j',
		'J',
		'\u0458',
		'\u0408', // Cyrillic ј Ј
		'\uff4a',
		'\uff2a'
	],
	k: [
		'k',
		'K',
		'\u043a',
		'\u041a', // Cyrillic к К
		'\u039a', // Greek Κ
		'\uff4b',
		'\uff2b',
		'\u1d0b'
	],
	l: [
		'l',
		'L',
		'\u04cf', // Cyrillic ӏ
		'\uff4c',
		'\uff2c',
		'\u029f',
		'1',
		'I',
		'i',
		'|',
		'!' // leet + sans-serif confusion
	],
	m: [
		'm',
		'M',
		'\u041c', // Cyrillic М
		'\u039c', // Greek Μ
		'\uff4d',
		'\uff2d',
		'\u1d0d'
	],
	n: [
		'n',
		'N',
		'\u03bd',
		'\u039d', // Greek ν Ν
		'\uff4e',
		'\uff2e',
		'\u0274',
		'\u00f1',
		'\u0144',
		'\u0148',
		'\u00d1'
	],
	o: [
		'o',
		'O',
		'\u043e',
		'\u041e', // Cyrillic о О
		'\u03bf',
		'\u039f', // Greek ο Ο
		'\uff4f',
		'\uff2f',
		'\u1d0f',
		'\u00f2',
		'\u00f3',
		'\u00f4',
		'\u00f5',
		'\u00f6',
		'\u00f8',
		'\u014d',
		'\u0151',
		'\u00d2',
		'\u00d3',
		'\u00d4',
		'\u00d5',
		'\u00d6',
		'\u00d8',
		'0' // leet
	],
	p: [
		'p',
		'P',
		'\u0440',
		'\u0420', // Cyrillic р Р
		'\u03c1',
		'\u03a1', // Greek ρ Ρ
		'\uff50',
		'\uff30',
		'\u1d18'
	],
	q: [
		'q',
		'Q',
		'\u049b', // Cyrillic қ (loose)
		'\uff51',
		'\uff31',
		'9' // visual
	],
	r: ['r', 'R', '\uff52', '\uff32', '\u0280'],
	s: [
		's',
		'S',
		'\u0455',
		'\u0405', // Cyrillic ѕ Ѕ
		'\uff53',
		'\uff33',
		'\u015b',
		'\u015d',
		'\u0161',
		'\u015a',
		'\u0160',
		'5',
		'$' // leet
	],
	t: [
		't',
		'T',
		'\u0422', // Cyrillic Т
		'\u03a4', // Greek Τ
		'\uff54',
		'\uff34',
		'\u1d1b',
		'7',
		'+' // leet
	],
	u: [
		'u',
		'U',
		'\u03c5',
		'\u03a5', // Greek υ Υ
		'\u0443',
		'\u0423', // Cyrillic у У
		'\uff55',
		'\uff35',
		'\u1d1c',
		'\u00f9',
		'\u00fa',
		'\u00fb',
		'\u00fc',
		'\u016b',
		'\u016f',
		'\u0171',
		'\u00d9',
		'\u00da',
		'\u00db',
		'\u00dc'
	],
	v: [
		'v',
		'V',
		'\u03bd', // Greek ν
		'\uff56',
		'\uff36'
	],
	w: ['w', 'W', '\uff57', '\uff37'],
	x: [
		'x',
		'X',
		'\u0445',
		'\u0425', // Cyrillic х Х
		'\u03c7',
		'\u03a7', // Greek χ Χ
		'\uff58',
		'\uff38'
	],
	y: [
		'y',
		'Y',
		'\u0443',
		'\u0423', // Cyrillic у У
		'\uff59',
		'\uff39',
		'\u028f',
		'\u00fd',
		'\u00ff',
		'\u0177',
		'\u00dd',
		'\u0178'
	],
	z: [
		'z',
		'Z',
		'\u0396', // Greek Ζ
		'\uff5a',
		'\uff3a',
		'\u017a',
		'\u017c',
		'\u017e',
		'\u0179',
		'\u017b',
		'\u017d',
		'2' // leet
	],
	'-': [
		'-',
		'\u00ad',
		'\u2010',
		'\u2011',
		'\u2012',
		'\u2013',
		'\u2014',
		'\u2212',
		'\uff0d',
		'_' // visually close in many fonts
	]
};

/** Escape a character for inclusion in a regex character class. */
function escForCharClass(ch: string): string {
	// The set of chars needing escape inside [...] is narrower than
	// in general regex. Only `]`, `\`, and `^` (if first) are
	// structurally meaningful. Hyphen needs escape if not first/last.
	// Easiest: backslash-escape everything non-alphanumeric, which
	// is always safe inside a character class.
	if (/[a-zA-Z0-9]/.test(ch)) return ch;
	return '\\' + ch;
}

/** Compile a reserved name (lowercase Latin) into a case-
 *  insensitive regex matching any visually-confusable substring.
 *  Each letter in the name becomes a character class of its
 *  equivalents per LETTER_EQUIVS. */
function compileReservedRegex(name: string): RegExp {
	let pattern = '';
	for (const ch of name) {
		const equivs = LETTER_EQUIVS[ch];
		if (equivs === undefined) {
			// Character not in our equivalence table — match literally.
			// Happens for anything unusual; hyphens and Latin a-z are
			// all covered above, so this branch is defensive.
			pattern += escForCharClass(ch);
			continue;
		}
		pattern += '[' + equivs.map(escForCharClass).join('') + ']';
	}
	// `i` flag is redundant here since LETTER_EQUIVS already
	// includes both cases for Latin — but specifying it explicitly
	// is cheap insurance against a missed case elsewhere.
	return new RegExp(pattern, 'i');
}

/** Reserved names: account handles that no user-chosen display_name
 *  or username may visually impersonate. Each triggers a
 *  case-insensitive substring rejection via a compiled regex.
 *
 *  Stored as lowercase Latin so compileReservedRegex can look up
 *  each character in LETTER_EQUIVS.
 *
 *  **Adding a name:** append the lowercase Latin form to this
 *  array. The regex is rebuilt at module load.
 *  **Removing a name:** also delete the raw entry below and
 *  ensure no tests assert it's reserved. */
const RESERVED_NAMES_RAW: readonly string[] = [
	// Morphit operator accounts
	'morphit',
	'morphit-fees',
	'morphit-relay',
	'morphit-fee',
	'morphit-ops',
	'morphit-admin',
	'morphit-support',
	// Agorise (parent org) and Kencode (principal)
	'agorise',
	'kencode'
];

/** Precompiled regexes. Module-load cost is a few hundred
 *  microseconds; per-call cost is one regex.test() per reserved
 *  name. */
const RESERVED_REGEXES: readonly RegExp[] = RESERVED_NAMES_RAW.map(compileReservedRegex);

/**
 * Check whether an input string contains a visual impersonation
 * of any reserved name.
 *
 * Substring semantics: `impersonatesReservedName("morphit-fan")`
 * returns true because "morphit" appears as a substring. Full-string
 * check is too narrow — attackers prepend or append noise to evade
 * a strict equality check.
 *
 * Byte-equality escape: if the input is byte-identical to any
 * reserved name (the canonical lowercase Latin form), returns
 * false — the legitimate operator account can set its own name.
 *
 * Cost: O(reserved_count × input_length). ~9 regex tests per call
 * on our reserved set; fast enough for per-keystroke validation.
 */
export function impersonatesReservedName(input: string): boolean {
	// Byte-equality escape first — cheapest check.
	for (const raw of RESERVED_NAMES_RAW) {
		if (input === raw) return false;
	}
	// Otherwise, test each reserved-name regex as a substring match.
	for (const re of RESERVED_REGEXES) {
		if (re.test(input)) return true;
	}
	return false;
}

/**
 * Compute the lowercase Latin skeleton of a string. Exposed for
 * tests and for other modules that need a canonical form without
 * the reserved-name check.
 *
 * Note: unlike `impersonatesReservedName`, this function is a
 * weaker primitive — it's the old API kept for compatibility
 * with confusables.test.ts. It does per-character mapping only,
 * no substring semantics. New callers should prefer
 * `impersonatesReservedName` for impersonation logic.
 */
export function skeleton(s: string): string {
	// Build a reverse map at first call: confusable → canonical
	// lowercase Latin (or hyphen). Cached for subsequent calls.
	let reverseMap = SKELETON_REVERSE_MAP;
	if (reverseMap === null) {
		reverseMap = {};
		for (const [canonical, equivs] of Object.entries(LETTER_EQUIVS)) {
			for (const ch of equivs) {
				// Don't overwrite: the first (canonical) mapping wins.
				if (!(ch in reverseMap)) reverseMap[ch] = canonical;
			}
		}
		SKELETON_REVERSE_MAP = reverseMap;
	}

	let out = '';
	for (const ch of s) {
		const mapped = reverseMap[ch];
		out += mapped !== undefined ? mapped : ch;
	}
	return out;
}

let SKELETON_REVERSE_MAP: Record<string, string> | null = null;

/** P6-3 audit fix: mirror of indexer's isReservedTag. */
export function isReservedTag(tag: string): boolean {
	const lower = tag.toLowerCase();
	for (const raw of RESERVED_NAMES_RAW) {
		if (lower === raw) return true;
	}
	return false;
}
