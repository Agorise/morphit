/**
 * Morphit — seed-phrase input normalization.
 *
 * Pure, dependency-free string tidy applied to the import seed textarea on
 * blur. BIP-39 mnemonics are always lowercase, single-space-separated words,
 * so commas (with or without spaces) and capital letters are always
 * user-input noise we can safely fix rather than reject. Split out from the
 * import page so it can be unit-smoked.
 *
 *   "Ripple, Cabin,Echo"  →  "ripple cabin echo"
 *   "WORD1  word2\nword3" →  "word1 word2 word3"
 *
 * Idempotent: normalizeSeedPhrase(normalizeSeedPhrase(x)) === normalizeSeedPhrase(x).
 */
export function normalizeSeedPhrase(raw: string): string {
	return raw
		.replace(/,/g, ' ')
		.replace(/\s+/g, ' ')
		.trim()
		.toLowerCase();
}
