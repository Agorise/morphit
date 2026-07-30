/**
 * termsForbiddenChars — frontend mirror of the indexer's terms character
 * gate, so a user can never BROADCAST (and pay the listing fee for) an order
 * whose terms the indexer will silently reject.
 *
 * The `terms` field is a multi-line markdown textarea, so TAB (U+0009),
 * LF (U+000A), and CR (U+000D) are PERMITTED. Everything the indexer blocks —
 * the other C0/C1 control characters, the Unicode line/paragraph separators
 * (U+2028/U+2029), bidi overrides, and zero-width / invisible formatting
 * characters — is blocked here too.
 *
 * CRITICAL: this regex is kept BYTE-IDENTICAL to
 * `FORBIDDEN_MULTILINE_TEXT_CHARS` in
 * `apps/indexer/src/indexer/handlers/order.ts` and `orderReplace.ts`. If one
 * changes, change all three (the terms-parity smoke pins this).
 */
export const FORBIDDEN_TERMS_CHARS =
	/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200D\u2028\u2029\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/;

/** True if `terms` contains a character the indexer would reject. Normalizes
 *  to NFC first, exactly like the indexer, so the two agree byte-for-byte. */
export function termsHasForbiddenChar(terms: string): boolean {
	return FORBIDDEN_TERMS_CHARS.test(terms.normalize('NFC'));
}
