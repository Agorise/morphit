/**
 * Morphit indexer — fee-transfer parsing helpers.
 *
 * Small pure functions used by the dispatcher's fee-transfer
 * pre-pass. Extracted to their own module so they can be tested
 * directly without wiring up a full block-walk.
 */

/** Parse a Graphene-format asset string like "62.500 BLURT" into
 *  a plain number. Returns null on malformed input. */
export function parseBlurtAmount(s: unknown): number | null {
	if (typeof s !== 'string') return null;
	const match = /^(\d+(?:\.\d+)?)\s+BLURT$/.exec(s);
	if (!match) return null;
	const n = Number(match[1]);
	return Number.isFinite(n) ? n : null;
}

/** The memo format for fee transfers: `morphit-fee:<permlink>`.
 *  The permlink charset must match the one the order handler
 *  accepts (lowercase alphanumeric + single dashes, no leading/
 *  trailing dash, no double dashes). */
const MEMO_PERMLINK_RE = /^morphit-fee:([a-z0-9]+(?:-[a-z0-9]+)*)$/;

/** Extract the permlink from a fee memo, or null if the memo
 *  doesn't follow the expected format. */
export function parseMemoPermlink(memo: unknown): string | null {
	if (typeof memo !== 'string') return null;
	const m = MEMO_PERMLINK_RE.exec(memo);
	return m ? (m[1] ?? null) : null;
}
