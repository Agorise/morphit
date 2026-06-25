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

/**
 * Word count of a normalized seed phrase — the gate for enabling the import
 * "Unlock my account" button in seed mode. Morphit only accepts 12-word
 * BIP-39 mnemonics (see validateMnemonic in keygen.ts), so the button must
 * stay disabled until exactly 12 words are present. Counted on the NORMALIZED
 * form so a phrase typed with commas and no spaces ("a,b,c") still counts
 * correctly before the on-blur tidy runs.
 *
 * Dependency-free on purpose: this runs on every keystroke and must not drag
 * the heavy bip39/secp256k1 graph (keygen.ts) into the import route's
 * first-paint work. Full checksum validation stays on submit, where a
 * one-word typo surfaces as a clear "invalid seed phrase" error rather than a
 * silently-disabled button.
 */
export function seedWordCount(raw: string): number {
	const normalized = normalizeSeedPhrase(raw);
	return normalized === '' ? 0 : normalized.split(' ').length;
}
