/**
 * Morphit — chat-inbox profile map merging.
 *
 * The inbox keeps a component-level `Record<account, ProfileResponse | null>`
 * alongside the module-level cache in `profileCache.ts`. Two rules govern it,
 * and getting either wrong makes a display name or avatar silently degrade to
 * `@username` — which reads to the user as "this person has no profile," not
 * "we couldn't reach the indexer for a moment."
 *
 *   1. NULL IS NOT AN ANSWER, IT'S AN ABSENCE. The old code asked
 *      `!(peer in profileMap)` to decide what to re-fetch. A failed batch wrote
 *      `null`, the KEY then existed, and that peer was never requested again
 *      for the life of the page. `profileCache` already distinguishes the two
 *      null causes (authoritative "no profile" → full TTL; fetch failure →
 *      soft, expires in seconds), but it only gets to act on that if someone
 *      asks again. Re-asking is cheap: a fresh cache entry answers from memory
 *      with no HTTP.
 *
 *   2. NEVER DOWNGRADE A KNOWN-GOOD PROFILE TO NULL. Once we've seen a real
 *      profile for an account, a later transient failure must not erase it. The
 *      same keep-prior rule `selfProfile` already applies to the header avatar.
 */

import type { ProfileResponse } from '@morphit/indexer-client';

export type ProfileMap = Record<string, ProfileResponse | null>;

/**
 * Which peers still need a profile fetch: the ones we have no profile for,
 * whether that's because we never asked or because the last answer was null.
 */
export function peersNeedingProfile(
	peers: readonly string[],
	map: ProfileMap
): string[] {
	return peers.filter((p) => map[p] == null);
}

/**
 * Merge a freshly-fetched batch into the map, keeping any profile we already
 * hold when the new value is null (a transient failure or an account that has
 * since been de-listed must not blank a name we successfully rendered).
 */
export function mergeProfileMap(
	prev: ProfileMap,
	fetched: ReadonlyMap<string, ProfileResponse | null>
): ProfileMap {
	const next: ProfileMap = { ...prev };
	for (const [account, profile] of fetched) {
		next[account] = profile ?? next[account] ?? null;
	}
	return next;
}
