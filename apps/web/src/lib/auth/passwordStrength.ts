/**
 * Morphit — lightweight password-strength heuristic for the
 * onboarding keystore password.
 *
 * Threat model: the keystore is encrypted in browser
 * localStorage and is exposed to: (a) a user installing a
 * malicious browser extension, (b) a stolen device, (c) any
 * XSS that can read localStorage.  Once exfiltrated, the
 * keystore is an offline brute-force target, KDF'd with
 * Argon2id-INTERACTIVE (~64MB, ~0.5s per guess on a normal
 * user device).  Realistic GPU-attacker speed is ~10-100
 * guesses/sec/device.
 *
 * Entropy targets at 50 guesses/sec (median attacker):
 *   - 8 chars alphabetic       ~35 bits   crackable in days
 *   - 8 chars alphanumeric     ~47 bits   crackable in months
 *   - 10 chars alphanumeric    ~59 bits   crackable in centuries
 *   - 12 chars alphanumeric    ~71 bits   infeasible
 *   - 4-word passphrase        ~50+ bits  (depends on word list)
 *
 * What we enforce:
 *   - Minimum 12 characters, OR
 *   - 10 characters AND character-class mix (3 of: lowercase,
 *     uppercase, digit, symbol)
 *
 * What we still warn (but don't block):
 *   - Common-password denylist (catches the worst dictionary hits)
 *   - Trivial sequences (12345678901, qwertyuiop, etc.)
 *
 * The blocking minimums exist because the attacker model is
 * "offline brute-force after exfil" — there's no rate limit
 * we can apply, only the KDF's own work factor.  Below the
 * 12-char / 10-char-mixed threshold, even Argon2id-INTERACTIVE
 * doesn't buy enough time.
 */

export type PasswordStrength = 'too_short' | 'too_simple' | 'common' | 'trivial' | 'short' | 'ok';

/** A small denylist of the most common passwords seen in
 *  breach corpora.  Not exhaustive — the goal is to catch the
 *  worst handful, not duplicate haveibeenpwned.  Lowercase for
 *  case-insensitive comparison. */
const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
	'password',
	'password1',
	'password123',
	'12345678',
	'123456789',
	'1234567890',
	'qwerty123',
	'qwertyuiop',
	'letmein123',
	'welcome123',
	'admin1234',
	'iloveyou123',
	'monkey1234',
	'sunshine123',
	'princess123',
	'football123',
	'baseball123',
	'dragon123',
	'master123',
	'shadow123',
	'superman123',
	'batman123',
	'morphit123',
	'morphit2024',
	'morphit2025',
	'morphit2026',
	'blurt1234',
	'blurt2024',
	'blurt2025',
	'blurtpass',
	'changeme',
	'changeme123',
	'trustno1234'
]);

/** Detect simple-sequence passwords like `12345678`, `abcdefgh`,
 *  `qwertyui`, `87654321`.  Looks for at least 6 contiguous
 *  characters where consecutive code points form a strict
 *  arithmetic progression of ±1, OR for the well-known qwerty
 *  rows. */
function isSimpleSequence(s: string): boolean {
	if (s.length < 6) return false;
	// Arithmetic progression of code points.
	let asc = true;
	let desc = true;
	for (let i = 1; i < s.length; i++) {
		const d = s.charCodeAt(i) - s.charCodeAt(i - 1);
		if (d !== 1) asc = false;
		if (d !== -1) desc = false;
		if (!asc && !desc) break;
	}
	if (asc || desc) return true;
	// Common keyboard rows (lowercase).
	const lower = s.toLowerCase();
	const rows = ['qwertyuiop', 'asdfghjkl', 'zxcvbnm', '1234567890'];
	for (const row of rows) {
		if (row.includes(lower)) return true;
		// Reverse direction.
		const rev = row.split('').reverse().join('');
		if (rev.includes(lower)) return true;
	}
	return false;
}

/** Detect repeated-single-char passwords (`aaaaaaaa`, `11111111`). */
function isRepeatedChar(s: string): boolean {
	if (s.length < 4) return false;
	const first = s[0]!;
	for (let i = 1; i < s.length; i++) {
		if (s[i] !== first) return false;
	}
	return true;
}

/** Count distinct character classes present in `s`.
 *  Used by the 10-char-with-mix threshold. */
function characterClassCount(s: string): number {
	let mask = 0;
	for (const ch of s) {
		const c = ch.charCodeAt(0);
		if (c >= 0x61 && c <= 0x7a)
			mask |= 1; // lowercase
		else if (c >= 0x41 && c <= 0x5a)
			mask |= 2; // uppercase
		else if (c >= 0x30 && c <= 0x39)
			mask |= 4; // digit
		else mask |= 8; // anything else = symbol
		if (mask === 15) return 4;
	}
	let count = 0;
	for (let m = mask; m !== 0; m >>>= 1) count += m & 1;
	return count;
}

/** Score a password.  Returns the first-matching weakness
 *  category; `'ok'` if no weakness fires.
 *
 *  Hard-fail thresholds (UI must block submission):
 *    - too_short: <10 chars
 *    - too_simple: 10-11 chars without 3-of-4 character classes
 *    - too_short again: <12 chars in 1-class only
 *
 *  Soft warnings (UI shows badge, allows submission):
 *    - common: matches a known-weak password
 *    - trivial: keyboard sequence or repeated char
 *    - short: 12+ chars but specifically warning that longer is better
 *      (kept for back-compat; not currently emitted by this fn since
 *      12+ already passes the hard threshold)
 */
export function scorePassword(password: string): PasswordStrength {
	if (password.length < 10) return 'too_short';
	const classes = characterClassCount(password);
	if (password.length < 12 && classes < 3) return 'too_simple';
	if (COMMON_PASSWORDS.has(password.toLowerCase())) return 'common';
	if (isRepeatedChar(password)) return 'trivial';
	if (isSimpleSequence(password)) return 'trivial';
	return 'ok';
}

/** Is this password strong enough that the UI should accept
 *  submission?  `true` iff scorePassword() returns a value
 *  that's not a hard-fail.  'common' and 'trivial' are warnings
 *  the user can override; 'too_short' / 'too_simple' block. */
export function isPasswordAcceptable(password: string): boolean {
	const s = scorePassword(password);
	return s !== 'too_short' && s !== 'too_simple';
}
