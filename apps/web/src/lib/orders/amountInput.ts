/**
 * Locale-aware parsing of a user-TYPED amount.
 *
 * WHY THIS EXISTS
 *
 * Every amount field used to accept only "digits and one dot". Most of the
 * world writes decimals with a comma (de/es/fr/it/pl/ru), iOS decimal keypads in
 * those regions only offer ",", Persian keyboards type ۰–۹ and "٫", and CJK IMEs
 * can produce full-width digits. The old sanitizers silently DROPPED what they
 * did not know — "12,50" became "1250" (100× the money) and "۱۲" became "" —
 * or rejected a perfectly normal "12,5" with "Enter a positive number".
 *
 * This module turns what the user typed into ONE canonical ASCII decimal
 * string ("1234.5") or a clear refusal. It never guesses:
 *
 *   - Native digits (Persian ۰–۹, Arabic-Indic ٠–٩, full-width ０–９) and the
 *     Arabic decimal/thousands marks (٫ ٬), full-width ．，, and spaces used as
 *     thousands separators (incl. NBSP / narrow NBSP) are normalised.
 *   - A separator that is the ACTIVE LOCALE's decimal mark is the decimal.
 *   - Both "." and "," present: the LAST one is the decimal, the other must be
 *     well-formed thousands grouping (groups of exactly 3).
 *   - A single occurrence of the locale's THOUSANDS mark followed by exactly
 *     three digits ("1,234" in en, "1.234" in de) is AMBIGUOUS — a thousands
 *     group in one convention, a decimal in the other — and is refused with a
 *     message rather than silently read either way. Any other single use of
 *     the non-decimal mark ("12,5" in en, "12.5" in de) cannot be grouping and
 *     is read as the decimal.
 *   - Repeated occurrences of one mark are grouping and must be groups of 3.
 *
 * Pure + total; unit-tested in amountInput.test.ts.
 */

/** The decimal mark each supported locale writes. fa's native mark is "٫",
 *  which is normalised to "." before parsing, so fa counts as ".". */
const COMMA_DECIMAL_LOCALES = new Set(['de', 'es', 'fr', 'it', 'pl', 'ru']);

export function localeDecimalSeparator(locale: string | null | undefined): '.' | ',' {
	const base = (locale ?? 'en').toLowerCase().split('-')[0] ?? 'en';
	return COMMA_DECIMAL_LOCALES.has(base) ? ',' : '.';
}

export type AmountParse =
	| { readonly ok: true; readonly value: string; readonly number: number }
	| {
			readonly ok: false;
			readonly reason: 'empty' | 'invalid' | 'ambiguous';
			/** For 'ambiguous': the two readings (thousands, decimal), written
			 *  with the active locale's decimal mark. */
			readonly readings?: readonly [string, string];
	  };

/** Map native-script digits and marks to ASCII; drop whitespace. */
function normalizeScript(raw: string): string {
	let out = '';
	for (const ch of raw) {
		const c = ch.codePointAt(0)!;
		if (c >= 0x06f0 && c <= 0x06f9)
			out += String(c - 0x06f0); // Persian
		else if (c >= 0x0660 && c <= 0x0669)
			out += String(c - 0x0660); // Arabic-Indic
		else if (c >= 0xff10 && c <= 0xff19)
			out += String(c - 0xff10); // full-width
		else if (ch === '٫' || ch === '．')
			out += '.'; // ٫ ．
		else if (ch === '٬' || ch === '，' || ch === '،')
			out += ','; // ٬ ， ،
		else if (ch === '－' || ch === '−')
			out += '-'; // full-width minus, minus sign
		else if (/\s/u.test(ch) || ch === ' ' || ch === ' ' || ch === "'" || ch === '’') {
			// thousands spaces (fr/pl/ru), Swiss apostrophe — grouping only
			out += ' ';
		} else out += ch;
	}
	return out;
}

/**
 * Parse a typed amount. `signed` allows one leading "-" (the spread field).
 */
export function parseAmountInput(
	raw: string,
	locale: string | null | undefined,
	opts: { readonly signed?: boolean } = {}
): AmountParse {
	let s = normalizeScript(raw).trim();
	if (s === '') return { ok: false, reason: 'empty' };
	let sign = '';
	if (opts.signed && s.startsWith('-')) {
		sign = '-';
		s = s.slice(1).trim();
	}
	// Space grouping: "1 234 567,5" — spaces only between digit groups of 3.
	if (s.includes(' ')) {
		if (!/^\d{1,3}( \d{3})+([.,]\d+)?$/.test(s)) return { ok: false, reason: 'invalid' };
		s = s.replace(/ /g, '');
	}
	if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) return { ok: false, reason: 'invalid' };

	const dec = localeDecimalSeparator(locale);
	const other = dec === '.' ? ',' : '.';
	const dots = (s.match(/\./g) ?? []).length;
	const commas = (s.match(/,/g) ?? []).length;

	let intPart: string;
	let fracPart = '';
	const grouped = (int: string, sep: string): string | null => {
		if (!int.includes(sep)) return /^\d+$/.test(int) ? int : null;
		const parts = int.split(sep);
		if (!/^\d{1,3}$/.test(parts[0]!)) return null;
		for (const p of parts.slice(1)) if (!/^\d{3}$/.test(p)) return null;
		return parts.join('');
	};

	if (dots > 0 && commas > 0) {
		// Both marks: the last one is the decimal, the other is grouping.
		const lastDot = s.lastIndexOf('.');
		const lastComma = s.lastIndexOf(',');
		const decMark = lastDot > lastComma ? '.' : ',';
		const groupMark = decMark === '.' ? ',' : '.';
		const i = s.lastIndexOf(decMark);
		if (s.indexOf(decMark) !== i) return { ok: false, reason: 'invalid' };
		const int = grouped(s.slice(0, i), groupMark);
		const frac = s.slice(i + 1);
		if (int === null || !/^\d+$/.test(frac)) return { ok: false, reason: 'invalid' };
		intPart = int;
		fracPart = frac;
	} else if (dots + commas === 0) {
		intPart = s;
	} else {
		const mark = dots > 0 ? '.' : ',';
		const count = dots + commas;
		if (count > 1) {
			// Repeated → grouping only.
			const int = grouped(s, mark);
			if (int === null) return { ok: false, reason: 'invalid' };
			intPart = int;
		} else {
			const i = s.indexOf(mark);
			const left = s.slice(0, i);
			const right = s.slice(i + 1);
			if (!/^\d*$/.test(left) || !/^\d+$/.test(right)) return { ok: false, reason: 'invalid' };
			if (mark === dec) {
				intPart = left === '' ? '0' : left;
				fracPart = right;
			} else if (mark === other && right.length === 3 && left !== '' && left !== '0') {
				// "1,234" (en) / "1.234" (de): thousands in one convention,
				// a decimal in the other. Refuse — never guess with money.
				// Readings are written in the user's own convention so the
				// message is unambiguous to them: en "1234" / "1.234",
				// de "1234" / "1,234".
				return {
					ok: false,
					reason: 'ambiguous',
					readings: [canon(sign, left + right, ''), canon(sign, left, right).replace('.', dec)]
				};
			} else {
				// The non-decimal mark cannot be grouping here (not exactly 3
				// digits after it, or a leading 0) → it is the decimal.
				intPart = left === '' ? '0' : left;
				fracPart = right;
			}
		}
	}
	const value = canon(sign, intPart, fracPart);
	const number = Number(value);
	if (!Number.isFinite(number)) return { ok: false, reason: 'invalid' };
	return { ok: true, value, number };
}

function canon(sign: string, int: string, frac: string): string {
	const i = int.replace(/^0+(?=\d)/, '') || '0';
	return `${sign}${i}${frac === '' ? '' : '.' + frac}`;
}

/**
 * Keystroke filter for amount fields: removes only characters that can NEVER
 * be part of an amount (letters, currency symbols, …) and keeps every digit
 * script, both marks, and spaces, so the field shows exactly what the user is
 * typing. Validation/normalisation is `parseAmountInput`'s job — this must
 * never turn one number into another.
 */
export function filterAmountTyping(raw: string, opts: { readonly signed?: boolean } = {}): string {
	let out = '';
	for (const ch of raw) {
		const c = ch.codePointAt(0)!;
		const keep =
			(ch >= '0' && ch <= '9') ||
			(c >= 0x06f0 && c <= 0x06f9) ||
			(c >= 0x0660 && c <= 0x0669) ||
			(c >= 0xff10 && c <= 0xff19) ||
			".,٫٬．，،   '".includes(ch) ||
			(opts.signed === true && (ch === '-' || ch === '−' || ch === '－'));
		if (keep) out += ch;
	}
	return out;
}

/**
 * Render a stored NUMBER (an existing order's amount, a computed seed) into an
 * amount field so that `parseAmountInput` reads it back EXACTLY under the same
 * locale: the locale's own decimal mark, no grouping, no exponent. (String(n)
 * gave "1.234" for 1.234, which a German parse would call ambiguous.)
 */
export function formatAmountForInput(n: number, locale: string | null | undefined): string {
	if (!Number.isFinite(n)) return '';
	const plain = n.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 12 });
	return localeDecimalSeparator(locale) === ',' ? plain.replace('.', ',') : plain;
}
