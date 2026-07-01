/**
 * Morphit indexer — reserved-name impersonation defense.
 *
 * ⚠ DUPLICATE OF apps/web/src/lib/crypto/confusables.ts.
 *   Keep the LETTER_EQUIVS table and RESERVED_NAMES_RAW list
 *   synchronized on both sides. The frontend gives inline errors;
 *   the indexer rejects broadcasts that bypass the client. Both
 *   need identical coverage for a consistent trust story.
 *
 *   The duplication exists because packages/indexer-client is a
 *   types-only package. Extracting a shared runtime package for
 *   this one table isn't worth the build-chain cost at our scale.
 *
 * See the frontend module for full prose documentation.
 */

const LETTER_EQUIVS: Record<string, readonly string[]> = {
	a: [
		'a',
		'A',
		'\u0430',
		'\u0410',
		'\u03b1',
		'\u0391',
		'\uff41',
		'\uff21',
		'\u1d00',
		'\u00e0',
		'\u00e1',
		'\u00e2',
		'\u00e3',
		'\u00e4',
		'\u00e5',
		'\u0101',
		'\u0103',
		'\u0105',
		'\u00c0',
		'\u00c1',
		'\u00c2',
		'\u00c3',
		'\u00c4',
		'\u00c5',
		'4',
		'@'
	],
	b: ['b', 'B', '\u0432', '\u0412', '\u0392', '\uff42', '\uff22', '6'],
	c: [
		'c',
		'C',
		'\u0441',
		'\u0421',
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
	d: ['d', 'D', '\u0501', '\uff44', '\uff24'],
	e: [
		'e',
		'E',
		'\u0435',
		'\u0415',
		'\u03b5',
		'\u0395',
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
		'3'
	],
	f: ['f', 'F', '\uff46', '\uff26'],
	g: ['g', 'G', '\uff47', '\uff27', '9'],
	h: ['h', 'H', '\u04bb', '\u0397', '\u041d', '\uff48', '\uff28'],
	i: [
		'i',
		'I',
		'\u0456',
		'\u0406',
		'\u03b9',
		'\u0399',
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
		'L'
	],
	j: ['j', 'J', '\u0458', '\u0408', '\uff4a', '\uff2a'],
	k: ['k', 'K', '\u043a', '\u041a', '\u039a', '\uff4b', '\uff2b', '\u1d0b'],
	l: ['l', 'L', '\u04cf', '\uff4c', '\uff2c', '\u029f', '1', 'I', 'i', '|', '!'],
	m: ['m', 'M', '\u041c', '\u039c', '\uff4d', '\uff2d', '\u1d0d'],
	n: [
		'n',
		'N',
		'\u03bd',
		'\u039d',
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
		'\u041e',
		'\u03bf',
		'\u039f',
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
		'0'
	],
	p: ['p', 'P', '\u0440', '\u0420', '\u03c1', '\u03a1', '\uff50', '\uff30', '\u1d18'],
	q: ['q', 'Q', '\u049b', '\uff51', '\uff31', '9'],
	r: ['r', 'R', '\uff52', '\uff32', '\u0280'],
	s: [
		's',
		'S',
		'\u0455',
		'\u0405',
		'\uff53',
		'\uff33',
		'\u015b',
		'\u015d',
		'\u0161',
		'\u015a',
		'\u0160',
		'5',
		'$'
	],
	t: ['t', 'T', '\u0422', '\u03a4', '\uff54', '\uff34', '\u1d1b', '7', '+'],
	u: [
		'u',
		'U',
		'\u03c5',
		'\u03a5',
		'\u0443',
		'\u0423',
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
	v: ['v', 'V', '\u03bd', '\uff56', '\uff36'],
	w: ['w', 'W', '\uff57', '\uff37'],
	x: ['x', 'X', '\u0445', '\u0425', '\u03c7', '\u03a7', '\uff58', '\uff38'],
	y: [
		'y',
		'Y',
		'\u0443',
		'\u0423',
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
		'\u0396',
		'\uff5a',
		'\uff3a',
		'\u017a',
		'\u017c',
		'\u017e',
		'\u0179',
		'\u017b',
		'\u017d',
		'2'
	],
	'-': ['-', '\u00ad', '\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2212', '\uff0d', '_']
};

function escForCharClass(ch: string): string {
	if (/[a-zA-Z0-9]/.test(ch)) return ch;
	return '\\' + ch;
}

function compileReservedRegex(name: string): RegExp {
	let pattern = '';
	for (const ch of name) {
		const equivs = LETTER_EQUIVS[ch];
		if (equivs === undefined) {
			pattern += escForCharClass(ch);
			continue;
		}
		pattern += '[' + equivs.map(escForCharClass).join('') + ']';
	}
	return new RegExp(pattern, 'i');
}

const RESERVED_NAMES_RAW: readonly string[] = [
	'morphit',
	'morphit-fees',
	'morphit-relay',
	'morphit-fee',
	'morphit-ops',
	'morphit-admin',
	'morphit-support',
	'agorise',
	'kencode'
];

const RESERVED_REGEXES: readonly RegExp[] = RESERVED_NAMES_RAW.map(compileReservedRegex);

/** Check whether an input string contains a visual impersonation
 *  of any reserved name. Substring semantics + byte-equality escape.
 *  Mirror of the frontend check. */
export function impersonatesReservedName(input: string): boolean {
	for (const raw of RESERVED_NAMES_RAW) {
		if (input === raw) return false;
	}
	for (const re of RESERVED_REGEXES) {
		if (re.test(input)) return true;
	}
	return false;
}

/** P6-3 audit fix: check whether an operator-tag matches a
 *  project-reserved name.  Tag charset is `[a-z0-9._-]+` (ASCII)
 *  so case-insensitive equality against RESERVED_NAMES_RAW is the
 *  full check.  Used by operatorRegister.ts to prevent permanent
 *  squatting of `morphit`, `agorise`, etc. */
export function isReservedTag(tag: string): boolean {
	const lower = tag.toLowerCase();
	for (const raw of RESERVED_NAMES_RAW) {
		if (lower === raw) return true;
	}
	return false;
}
