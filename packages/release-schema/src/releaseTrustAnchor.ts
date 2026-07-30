/**
 * Morphit — pure helpers for release-trust-anchor verification.
 *
 * Carved out of releaseFetch.ts so the validation logic is
 * smoke-testable from outside the SvelteKit context.  releaseFetch
 * itself imports from `$blurt/client` (a SvelteKit path alias) and
 * therefore can't be loaded directly by the indexer-context
 * tsx smoke runner.  This module has zero project imports.
 */

/** Result shape: did the pinned trust-anchor pubkey appear in the
 *  posting authority's key_auths with non-zero weight?  Audit J-1
 *  hardening — weight-0 entries are operationally inert (can't sign
 *  anything) and must NOT count as the trust anchor still being in
 *  effect. */
export interface PubkeyAuthorityCheck {
	readonly ok: boolean;
	readonly chainKeys: readonly string[];
	readonly pinnedWeight: number;
}

/** Check whether `pinned` is present in `keyAuths` with non-zero
 *  weight.  Defensive against malformed inputs (non-array,
 *  malformed entries) — anything not a `[string, number]` tuple is
 *  silently ignored.
 *
 *  Returns a structured result so the caller can also report the
 *  full list of pubkeys actually present (useful for the
 *  "pubkey_mismatch" UI surface, which shows the user what IS on
 *  chain vs what's pinned). */
export function checkPinnedKeyInAuthority(keyAuths: unknown, pinned: string): PubkeyAuthorityCheck {
	const chainKeys: string[] = [];
	let pinnedWeight = 0;
	if (Array.isArray(keyAuths)) {
		for (const entry of keyAuths) {
			if (
				Array.isArray(entry) &&
				entry.length === 2 &&
				typeof entry[0] === 'string' &&
				typeof entry[1] === 'number'
			) {
				chainKeys.push(entry[0]);
				if (entry[0] === pinned && entry[1] > 0) {
					pinnedWeight = entry[1];
				}
			}
		}
	}
	return {
		ok: pinnedWeight > 0,
		chainKeys,
		pinnedWeight
	};
}
