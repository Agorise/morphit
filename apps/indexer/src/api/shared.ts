/**
 * Morphit indexer — shared HTTP-endpoint helpers.
 *
 * Small pure functions used across multiple endpoints. If a helper
 * becomes endpoint-specific, move it into the endpoint's own file.
 */

/** Blurt-account-name validator.
 *
 *  Blurt account names per the chain's is_valid_account_name:
 *  multi-segment, dot-separated, each segment 3+ chars,
 *  lowercase-letter-start, lowercase + digit + dash interior,
 *  total length 3..16. The regex below admits dotted names
 *  (e.g. `alice.brave`) without modeling every Blurt sub-rule —
 *  the chain already validated the name when it appeared on a
 *  signed op, so our role is to reject obvious junk, not to
 *  re-implement is_valid_account_name.
 *
 *  History (chat audit C-19): this used to be `[a-z][a-z0-9-]`
 *  (no dot), inconsistent with block.ts / strangerFee.ts which
 *  allowed dots.  The mismatch broke chat for every user with a
 *  dotted account name — chat handler rejected `recipient_invalid`,
 *  block handler accepted blocks against them, and the
 *  /v1/chat/:a/:b path 400'd.  Canonicalized to dot-allowing
 *  here in 2026-04-27 audit close-out. */
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;

export function isAccountName(s: unknown): s is string {
	return typeof s === 'string' && ACCOUNT_NAME_RE.test(s);
}

/** Escape LIKE metacharacters so a user-supplied string is matched
 *  literally when used with `ILIKE ... ESCAPE '\'`. */
export function escapeLike(s: string): string {
	return s.replace(/[\\%_]/g, '\\$&');
}

/** Generic cursor codec. Cursors are opaque to the client — we
 *  base64url-encode JSON and the client just passes it back. Shape
 *  of the decoded object is endpoint-specific; the endpoint narrows
 *  it with its own runtime guard after decoding. */
export function encodeCursor(obj: unknown): string {
	return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64url');
}

export function decodeCursor(s: string): unknown {
	try {
		return JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
	} catch {
		return null;
	}
}

/** Standard error-response body shape. Matches the ErrorResponse
 *  type in @morphit/indexer-client. */
export interface ErrorBody {
	readonly status: 'error';
	readonly code: 'not_found' | 'bad_request' | 'rate_limited' | 'internal' | 'service_starting';
	readonly message: string;
}

export function errorBody(code: ErrorBody['code'], message: string): ErrorBody {
	return { status: 'error', code, message };
}
