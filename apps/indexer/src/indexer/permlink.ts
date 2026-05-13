/**
 * Permlink validation — single source of truth.
 *
 * Blurt permlinks (and Morphit permlinks per ADR-0001) are
 * lowercase alphanumeric segments separated by single dashes.
 * Length bounds are domain-specific:
 *   - chain-level Blurt allows up to 256 chars
 *   - Morphit orders cap at 32 chars (UI-friendly URLs)
 *
 * Use `validateOrderPermlink` for order create/replace handlers
 * (32-char cap), `validateChatOrderPermlink` for chat references
 * (256-char cap matches chain).
 *
 * Both functions return null on success and a stable rejection
 * reason on failure, so the caller can use:
 *   const fail = validateOrderPermlink(p); if (fail) return { ok: false, reason: fail };
 */

const PERMLINK_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Order-side permlink validator: charset + 1..32 chars. */
export function validateOrderPermlink(
	p: unknown
): 'permlink_not_string' | 'permlink_bad_length' | 'permlink_bad_chars' | null {
	if (typeof p !== 'string') return 'permlink_not_string';
	if (p.length < 1 || p.length > 32) return 'permlink_bad_length';
	if (!PERMLINK_RE.test(p)) return 'permlink_bad_chars';
	return null;
}

/** Chat-side permlink validator: charset + 1..256 chars (chain max).
 *  Used when a chat message claims to reference a posted order; the
 *  cap matches the Blurt chain's maximum permlink length so any
 *  legitimate-shape claim passes. The downstream DB lookup verifies
 *  the order exists AND is owned by the message recipient — without
 *  a real order, the bypass doesn't fire. */
export function validateChatOrderPermlink(
	p: unknown
): 'order_permlink_not_string' | 'order_permlink_bad_chars' | null {
	if (typeof p !== 'string') return 'order_permlink_not_string';
	if (p.length < 1 || p.length > 256) return 'order_permlink_bad_chars';
	if (!PERMLINK_RE.test(p)) return 'order_permlink_bad_chars';
	return null;
}
