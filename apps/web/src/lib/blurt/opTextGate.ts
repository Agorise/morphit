/**
 * The text every indexer refuses in ANY Morphit op, before a handler sees it
 * (apps/indexer dispatcher, `invalid_text`): a NUL, an unpaired UTF-16
 * surrogate, and — from the consensus activation time, 2026-11-01 — the
 * noncharacters U+FFFE / U+FFFF. Such an op is dropped by every indexer while
 * the chain keeps it, so an order with one loses its listing fee and a profile
 * or review save is silently lost.
 *
 * The client applies the rule at all times (no Morphit client writes these),
 * at the broadcast boundary, before anything is signed or paid.
 */

/** A NUL, an unpaired surrogate, or U+FFFE / U+FFFF. */
const REFUSED =
	/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]|[￾￿]/;

/** Does any string (value or key) in `v` hold text every indexer refuses? */
export function opTextRefused(v: unknown): boolean {
	const stack: unknown[] = [v];
	while (stack.length > 0) {
		const cur = stack.pop();
		if (typeof cur === 'string') {
			if (REFUSED.test(cur)) return true;
		} else if (cur !== null && typeof cur === 'object') {
			if (Array.isArray(cur)) stack.push(...cur);
			else
				for (const [k, c] of Object.entries(cur as Record<string, unknown>)) {
					if (REFUSED.test(k)) return true;
					stack.push(c);
				}
		}
	}
	return false;
}

/** Characters a user cannot see that every indexer refuses: removed from a
 *  single-line field before it is sent (see stripSingleLineForbidden). */
export const OP_TEXT_REFUSED_GLOBAL = /[￾￿]/g;
