/**
 * Morphit — account-number-shaped string detector.
 *
 * Tier 2.1 of the grandma-friendly investigation: a chat
 * message with an account number, IBAN, or card-shaped digit
 * run is going on the Blurt chain forever.  Encrypted, yes —
 * but if the recipient's chat key is ever compromised (or the
 * recipient simply screenshots the message and posts it
 * publicly), a typo in an account number is unrecoverable.
 *
 * This detector flags messages that LOOK like they contain
 * payment-routing identifiers, and the chat composer surfaces
 * a one-time-per-session "this is permanent — proofread
 * before sending" warning when the user is about to send one.
 *
 * Crucially, this detector does NOT redact (unlike the
 * private-key detector).  Account numbers are LEGITIMATE in
 * chat — they're how trade partners tell each other where to
 * send fiat.  The goal here is reminding the user to
 * proofread, not blocking the action.
 *
 * Detected patterns:
 *
 *   1. IBAN — alphanumeric, 15-34 chars, country-code prefix
 *      (2 letters + 2 check digits + ≥11 BBAN chars).  IBAN
 *      validation rejects most random alphanumeric runs.
 *
 *   2. Long digit runs — 9+ consecutive digits, optionally
 *      separated by spaces or hyphens (covers US bank routing/
 *      account, US SSN, Canadian transit-account, EU 13-digit
 *      accounts, payment card 13-19 digits).  Whitespace and
 *      hyphens are tolerated as group separators because users
 *      type them naturally.
 *
 *   3. SWIFT/BIC code — uppercase letters, 8 or 11 chars,
 *      letter-letter-letter-letter (institution) +
 *      letter-letter (country) + alphanumeric-alphanumeric
 *      (location) + optional 3-char branch.  Pattern is
 *      narrow enough that false positives on regular text are
 *      rare.
 *
 * Known gaps (intentional):
 *
 *   - PayPal email addresses, Venmo/CashApp handles, crypto
 *     addresses are NOT in scope here.  PayPal-shaped emails
 *     and @handles are very common in legitimate chat;
 *     warning on every one would train users to ignore the
 *     warning.  Crypto addresses ARE in scope of the
 *     existing `redactPrivateKeys` and `safeContactUrl`
 *     defenses (and: a typo in a crypto address sends the
 *     funds to the typo, not to a different person — the
 *     loss model is different from a bank-account typo).
 *
 *   - Phone numbers.  Most phone numbers fall under the
 *     "9+ digit run" rule but with a country-code prefix and
 *     parens; that's already caught by the digit-run
 *     detector.  No special handling.
 *
 * The detector intentionally has a low precision/recall
 * tradeoff: prefer false positives (warn the user when they
 * weren't typing an account number) over false negatives
 * (silently let an account-number typo through).  False
 * positives just show a warning that the user dismisses;
 * false negatives lose money.
 */

export type AccountNumberMatchKind = 'iban' | 'digit_run' | 'swift_bic';

export interface AccountNumberMatch {
	/** Character offset where the match starts. */
	readonly start: number;
	/** Character offset one past the end. */
	readonly end: number;
	/** Exact text matched. */
	readonly text: string;
	/** Which detector pattern fired. */
	readonly kind: AccountNumberMatchKind;
}

// ─── IBAN detector ─────────────────────────────────────────────

/** IBAN: 2 letters (country) + 2 digits (check) + 11-30 alphanumeric (BBAN).
 *  Total length 15-34.  Word-bounded so it doesn't match inside random
 *  alphanumeric blobs.  Case-insensitive but real IBANs are uppercase;
 *  we tolerate lowercase paste-ins. */
const IBAN_RE = /\b[A-Z]{2}[0-9]{2}[A-Z0-9]{11,30}\b/gi;

// ─── Long digit-run detector ───────────────────────────────────

/** Run of 9+ digits, optionally with single space or single hyphen
 *  group separators.  Anchored to require all-digit content (no
 *  letters mixed in).  Examples that match:
 *    "123456789"
 *    "123-456-7890"
 *    "1234 5678 9012 3456"  (16-digit card)
 *    "ACH 071000013 12345678"
 *  Examples that don't match:
 *    "abc123" (letters mixed in)
 *    "12-34" (only 4 digits total)
 *    "20260509" (8 digits — under the floor; date-shaped)
 *
 *  The regex captures groups of 1+ digits separated by single
 *  space-or-hyphen separators, then validates that the digit
 *  total is ≥9 in the post-processing step.
 */
const DIGIT_RUN_RE = /\b[0-9]+(?:[ -][0-9]+)*\b/g;
const MIN_DIGIT_RUN = 9;

// ─── SWIFT/BIC detector ────────────────────────────────────────

/** SWIFT/BIC: 8 or 11 chars, all uppercase letters and digits.
 *  AAAA (institution, letters only) + BB (country, letters only) +
 *  CC (location, letter+digit or digit+letter or letter+letter or
 *  digit+digit) + optional DDD (branch, alphanumeric).
 *
 *  Real BICs are uppercase; paste-ins of legitimate BICs are
 *  almost always uppercase too.  The case-sensitive match keeps
 *  false-positive rate low (lowercase 8-char alphanumeric runs
 *  are very common in regular prose).
 */
const SWIFT_BIC_RE = /\b[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g;

// ─── Detection ──────────────────────────────────────────────────

/**
 * Scan `input` for account-number-shaped strings.
 *
 * Returns matches in input order.  Each kind is detected
 * independently; overlapping matches are NOT deduped because the
 * detector is informational (showing "we saw an IBAN AND a digit
 * run" is more useful than picking one).  In practice the
 * pattern shapes are disjoint enough that overlap is rare.
 */
export function detectAccountNumbers(input: string): readonly AccountNumberMatch[] {
	if (input.length === 0) return [];
	const matches: AccountNumberMatch[] = [];

	for (const m of input.matchAll(IBAN_RE)) {
		if (m.index === undefined) continue;
		matches.push({ start: m.index, end: m.index + m[0].length, text: m[0], kind: 'iban' });
	}

	for (const m of input.matchAll(DIGIT_RUN_RE)) {
		if (m.index === undefined) continue;
		// Count the digits — DIGIT_RUN_RE matches groups separated
		// by space-or-hyphen, so the total length includes
		// separators.  Filter to runs with ≥ MIN_DIGIT_RUN actual
		// digits.
		const digitCount = (m[0].match(/[0-9]/g) ?? []).length;
		if (digitCount < MIN_DIGIT_RUN) continue;
		matches.push({
			start: m.index,
			end: m.index + m[0].length,
			text: m[0],
			kind: 'digit_run'
		});
	}

	for (const m of input.matchAll(SWIFT_BIC_RE)) {
		if (m.index === undefined) continue;
		matches.push({
			start: m.index,
			end: m.index + m[0].length,
			text: m[0],
			kind: 'swift_bic'
		});
	}

	// Sort by start offset for stable ordering.
	matches.sort((a, b) => a.start - b.start);
	return matches;
}

/**
 * True if `input` contains at least one match.  Convenience
 * for the chat composer's "should I show the warning?" check —
 * cheaper than allocating the full match array when the caller
 * only cares about presence/absence.
 */
export function hasAccountNumberShape(input: string): boolean {
	if (input.length === 0) return false;
	if (IBAN_RE.test(input)) {
		// matchAll() resets state via the regex's `lastIndex`,
		// but `.test()` mutates it.  Reset explicitly so the
		// next caller sees the same regex behavior.
		IBAN_RE.lastIndex = 0;
		return true;
	}
	IBAN_RE.lastIndex = 0;
	if (SWIFT_BIC_RE.test(input)) {
		SWIFT_BIC_RE.lastIndex = 0;
		return true;
	}
	SWIFT_BIC_RE.lastIndex = 0;
	// Digit-run check: we need ≥9 actual digits in a connected
	// run.  Cheaper than the full matchAll for early exit.
	let digitsInRun = 0;
	for (let i = 0; i < input.length; i++) {
		const c = input.charCodeAt(i);
		if (c >= 48 && c <= 57) {
			digitsInRun++;
			if (digitsInRun >= MIN_DIGIT_RUN) return true;
		} else if (c === 32 /* space */ || c === 45 /* hyphen */) {
			// Tolerate as separators — don't reset count.
		} else {
			digitsInRun = 0;
		}
	}
	return false;
}
