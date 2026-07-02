/**
 * Centralized display truncation for a user's PUBLIC (posting) key —
 * the "BLT5vw…7Bjw" form shown under display names across the site
 * (order cards, chat identity labels, profile/poster cards). ONE
 * definition so the abbreviation shape is identical everywhere; before
 * this the head-9…tail-4 slice was duplicated inline (IdentityLabel).
 *
 * Head-9 … tail-4 of the canonical base58 key. Keys ≤14 chars are shown
 * whole — truncating wouldn't shorten them, and that's the shape of the
 * short sync placeholder shown before the ~53-char base58 key resolves.
 *
 * The result is MEMOIZED per full-key string, mirroring how avatars /
 * identicons are cached per account (crypto/identicon.ts, selfProfile):
 * a list of order cards or a long chat that repeats the same trader
 * doesn't recompute the slice every render. The cache is bounded with
 * oldest-first eviction so it can't grow without limit.
 *
 * NOTE: this is the PUBLIC-key display helper. It is deliberately
 * separate from `truncateKey` in security/privateKeyDetector.ts, which
 * redacts a DETECTED PRIVATE key (head-6…tail-4) in a warning — a
 * different shape for a different, security-sensitive purpose.
 */

const HEAD = 9;
const TAIL = 4;
const WHOLE_BELOW = 14;
const MAX_ENTRIES = 2000;

const cache = new Map<string, string>();

/**
 * Truncate a public key for display. Returns '' for null/empty (callers
 * render nothing). Pure + memoized.
 */
export function truncatePublicKey(fullKey: string | null | undefined): string {
	if (!fullKey) return '';
	const hit = cache.get(fullKey);
	if (hit !== undefined) return hit;
	const out = fullKey.length <= WHOLE_BELOW ? fullKey : `${fullKey.slice(0, HEAD)}…${fullKey.slice(-TAIL)}`;
	if (cache.size >= MAX_ENTRIES) {
		// Evict the oldest entry (Map preserves insertion order).
		const oldest = cache.keys().next().value;
		if (oldest !== undefined) cache.delete(oldest);
	}
	cache.set(fullKey, out);
	return out;
}

/** Test/util hook: clear the memo cache. */
export function _clearTruncatePublicKeyCache(): void {
	cache.clear();
}
