/**
 * Morphit explorer — search-input parser (Batch K).
 *
 * Takes a raw user-typed string from the search bar and classifies
 * it as one of:
 *
 *   • account   — a Blurt account name like "alice" or "@alice".
 *   • txid      — a Blurt transaction id (40 hex chars).
 *   • block     — a positive integer block number.
 *   • unknown   — couldn't classify; the UI shows "no idea what
 *                 this is" rather than guessing.
 *
 * Pure: no I/O, no DOM.  The actual lookup happens after
 * classification.
 *
 * Edge cases handled:
 *
 *   - Leading/trailing whitespace stripped.
 *   - "@alice" is the same as "alice".
 *   - All-digit input that's also a valid account-name ("123abc"
 *     is NOT a valid account because account names must start
 *     with a letter, but "1234" alone classifies as block).
 *   - Hex strings of length 40 → txid; other hex lengths → unknown
 *     (we don't try to be clever about block-id lookups).
 *
 * The parser is deliberately strict.  Better to return 'unknown'
 * and prompt the user than to silently route to the wrong target.
 */

const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;
const HEX_TXID_RE = /^[0-9a-fA-F]{40}$/;
const POSITIVE_INT_RE = /^[0-9]+$/;

export type ParsedSearchTarget =
	| { kind: 'account'; account: string }
	| { kind: 'txid'; txid: string }
	| { kind: 'block'; blockNumber: number }
	| { kind: 'unknown'; raw: string };

export function parseSearchInput(raw: string): ParsedSearchTarget {
	if (typeof raw !== 'string') return { kind: 'unknown', raw: String(raw) };
	const trimmed = raw.trim();
	if (trimmed.length === 0) return { kind: 'unknown', raw: trimmed };

	// Strip a leading @ — accommodates "@alice" the same as "alice".
	const stripped = trimmed.startsWith('@') ? trimmed.slice(1) : trimmed;

	// Block number: pure digits, parse to int, must be positive.
	if (POSITIVE_INT_RE.test(stripped)) {
		const n = Number(stripped);
		// Cap at JS-safe-integer / chain-realistic upper bound.
		// 2^53 is way beyond any conceivable block number; this
		// guards against pathological "100000000000000000" inputs.
		if (Number.isInteger(n) && n > 0 && n < Number.MAX_SAFE_INTEGER) {
			return { kind: 'block', blockNumber: n };
		}
		return { kind: 'unknown', raw: trimmed };
	}

	// Transaction id: 40 hex chars.
	if (HEX_TXID_RE.test(stripped)) {
		return { kind: 'txid', txid: stripped.toLowerCase() };
	}

	// Account name: lowercase, starts with letter, 3-16 chars.
	if (ACCOUNT_NAME_RE.test(stripped)) {
		return { kind: 'account', account: stripped };
	}

	return { kind: 'unknown', raw: trimmed };
}
