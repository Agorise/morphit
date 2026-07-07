/**
 * Morphit relay — Blurt account name policy.
 *
 * Blurt account names inherit rules from Steem/Hive (Graphene-lineage):
 *   - 3 to 16 characters
 *   - lowercase ASCII letters, digits, and dashes only
 *   - must start with a letter
 *   - no leading/trailing dash
 *   - no consecutive dashes
 *   - no dots (dotted names are reserved on-chain for service accounts
 *     like witnesses; we refuse to register them via the relay)
 *
 * Plus a reserved-name allowlist that protects the Morphit project's
 * own namespace from squatters. Registering reserved names directly
 * on-chain is still possible (operator-signed) but not via the relay.
 */

/** Stable machine-readable reason codes. NEVER rename — the frontend
 *  maps these to localized error messages in every locale.
 *  Adding new codes is fine; renaming or removing breaks clients. */
export type NameReason =
	| 'ok'
	| 'too_short'
	| 'too_long'
	| 'bad_chars'
	| 'leading_trailing_dash'
	| 'consecutive_dashes'
	| 'must_start_with_letter'
	| 'dotted_not_allowed'
	| 'reserved';

/** Account names the relay refuses to register. Rationale: protect
 *  Morphit project identity from squatters/impersonators. If one of
 *  these turns out to need to be registered later (e.g. the team
 *  decides to run morphit-bot), the operator can sign and broadcast
 *  the account_create op directly — bypassing the relay is legitimate
 *  operator action.
 *
 *  Includes common confusable / typo-squat variants of the project
 *  name (Finding N14): digit-for-letter substitutions, common
 *  transpositions, missing/added letters.  Not exhaustive — this is
 *  about catching the lowest-effort impersonations.  The frontend
 *  flags suspiciously-similar names that aren't on this list. */
const RESERVED_NAMES = new Set<string>([
	// Exact + canonical service accounts.
	'morphit',
	'morphit-relay',
	'morphit-indexer',
	'morphit-payment',
	'morphit-support',
	'morphit-bot',
	'morphit-admin',
	'morphit-official',
	'morphit-team',
	'morphit-oracle',
	// Generic admin-ish names.
	'admin',
	'root',
	'null',
	'undefined',
	// Project-adjacent organizations.
	'agorise',
	'agorise-relay',
	'agorise-indexer',
	// Confusable variants of the project name.  Common digit-for-
	// letter substitutions:
	'm0rphit', // 0 for o
	'morph1t', // 1 for i
	'morphlt', // l for i
	'morpht', // missing i
	'morpit', // missing h
	'mophit', // missing r
	'mophit-relay',
	'morfit', // ph→f phonetic
	// Common dash variants and prefixes/suffixes.
	'morph-it',
	'morphit1',
	'morphit2',
	'morphit-app',
	'morphit-www',
	'morphit-web',
	'morphit-fees', // protects @morphit-fees recipient namespace
	'morphit-com',
	'morphit-io',
	'morphit-net',
	// Common transpositions / typo squats.
	'mrophit',
	'mophit-team',
	'mophit-admin'
]);

/**
 * Check a proposed account name against Blurt's consensus rules +
 * the relay's reserved list. Returns `'ok'` iff the name is
 * acceptable; otherwise the first rule that fails determines the
 * reason.
 *
 * Does NOT check whether the name is already registered on-chain —
 * that's a separate RPC call handled by the availability endpoint.
 */
export function validateBlurtName(name: string): NameReason {
	if (name.length < 3) return 'too_short';
	if (name.length > 16) return 'too_long';

	const first = name.charCodeAt(0);
	if (!isLowerAlpha(first)) return 'must_start_with_letter';

	if (name.endsWith('-')) return 'leading_trailing_dash';

	if (name.includes('.')) return 'dotted_not_allowed';

	let prev = 0;
	for (let i = 0; i < name.length; i++) {
		const c = name.charCodeAt(i);
		if (isLowerAlpha(c)) {
			// ok
		} else if (isDigit(c)) {
			// ok
		} else if (c === 0x2d /* - */) {
			if (i === 0) return 'leading_trailing_dash';
			if (prev === 0x2d) return 'consecutive_dashes';
		} else {
			return 'bad_chars';
		}
		prev = c;
	}

	if (RESERVED_NAMES.has(name)) return 'reserved';
	return 'ok';
}

export function isReserved(name: string): boolean {
	return RESERVED_NAMES.has(name);
}

function isLowerAlpha(c: number): boolean {
	return c >= 0x61 /* a */ && c <= 0x7a; /* z */
}

function isDigit(c: number): boolean {
	return c >= 0x30 /* 0 */ && c <= 0x39; /* 9 */
}
