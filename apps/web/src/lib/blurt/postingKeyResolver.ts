/**
 * postingKeyResolver — ONE place that answers "what is @account's posting key?"
 *
 * ─── Why this exists ──────────────────────────────────────────────────
 *
 * Ken posted his first order as @kencode and the order CARD showed no
 * truncated key, while the order DETAIL page and the settings display-name
 * card both showed `BLT8eGZMn…oAVo` perfectly. Three surfaces, three different
 * ways of obtaining the same fact:
 *
 *   settings card  — derives it from the in-memory session key. Always right
 *                    for yourself, useless for anyone else.
 *   order detail   — `fetchAccountKeys()`, a live read of the account's
 *                    on-chain authorities through the indexer proxy.
 *   order card     — `order.posting_pubkey`, served inline by the orderbook
 *                    query from the indexer's `accounts.posting_pubkey`
 *                    column — which is filled by a BACKFILL JOB
 *                    (`postingKeyBackfill.ts`, `WHERE posting_pubkey IS NULL`).
 *
 * So the card alone depended on a background job having already run. For an
 * account new to Morphit the column is briefly empty, the card renders without
 * the key, and it appears minutes later once the backfill catches up. Ken saw
 * exactly that, and reasonably read it as "pre-fork accounts are broken" —
 * they are not; nothing about the key is special, only where that one surface
 * looked for it.
 *
 * The key is also the anti-impersonation anchor: the display name is free-form
 * and duplicable, the key is not. A surface that silently omits it is the one
 * place a reader most needs it, so "sometimes present" is the wrong behaviour.
 *
 * ─── What this does ───────────────────────────────────────────────────
 *
 * Prefer the value the caller already has (free, no request). Fall back to the
 * live authority lookup the detail page uses, cached and de-duplicated per
 * account so an orderbook of twenty cards makes at most one request per
 * distinct poster — not twenty, and not one per card re-render.
 *
 * Best-effort by construction: a failed lookup resolves to null and the caller
 * renders exactly as it does today. Nothing here can block or break a card.
 */
import { fetchAccountKeys } from './accountKeys';
import { MORPHIT_INDEXER_ORIGIN, resolveOrigin } from '$net/config';

/** Resolved keys, per account. `null` = looked up, genuinely absent. */
const cache = new Map<string, string | null>();
/** In-flight lookups, so N cards for one poster share a single request. */
const inFlight = new Map<string, Promise<string | null>>();

/**
 * The account's canonical posting key, or null when it cannot be determined.
 *
 * @param account   the account to resolve.
 * @param inline    a value the caller already holds (e.g. `order.posting_pubkey`).
 *                  When present it is returned as-is and no request is made.
 */
export async function resolvePostingKey(
	account: string,
	inline?: string | null
): Promise<string | null> {
	// The inline value is authoritative when present — the backfill writes the
	// same key this lookup would return, so a hit here is not a shortcut, it is
	// the identical answer without a round trip.
	if (typeof inline === 'string' && inline.length > 0) {
		cache.set(account, inline);
		return inline;
	}
	if (!account) return null;

	const cached = cache.get(account);
	if (cached !== undefined) return cached;

	const existing = inFlight.get(account);
	if (existing) return existing;

	const p = (async (): Promise<string | null> => {
		try {
			const keys = await fetchAccountKeys(resolveOrigin(MORPHIT_INDEXER_ORIGIN), account);
			const key = keys?.posting?.key_auths?.[0]?.[0] ?? null;
			// Only a POSITIVE result is cached. A null here may mean the indexer
			// was briefly unreachable, and caching that would reproduce the very
			// bug this module exists to fix — a transient absence remembered as
			// a permanent one. An unresolved account is simply retried next time.
			if (key !== null) cache.set(account, key);
			return key;
		} catch {
			return null;
		} finally {
			inFlight.delete(account);
		}
	})();
	inFlight.set(account, p);
	return p;
}

/** Test seam / sign-out hook: forget every resolved key. */
export function clearPostingKeyCache(): void {
	cache.clear();
	inFlight.clear();
}
