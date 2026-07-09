/**
 * selfProfile — the logged-in user's OWN avatar (sanitized SVG / data URI),
 * resolved from their on-chain profile once and shared so it can render
 * EVERYWHERE the heart identicon otherwise appears: the top-right avatar
 * menu, and any IdentityLabel whose subject is the current user. Without
 * this, each surface only had the deterministic identicon — the user's
 * uploaded avatar showed on their public profile page but nowhere else.
 *
 * Populated on account change (AvatarMenu effect) and refreshed after the
 * user broadcasts a profile update (settings page, bustCache=true, which also
 * bypasses the browser's HTTP cache). Cleared on sign-out. A network failure
 * leaves the previous value in place and retries, rather than blanking a good
 * avatar to the identicon (#2); the identicon fallback covers the empty case.
 */
import { writable } from 'svelte/store';
import { getProfileCachedDetailed, clearProfileCache } from '$lib/indexer/profileCache';
import { extractLabelPropsFromProfile } from '$lib/indexer/profileProps';

export interface SelfProfileAvatar {
	/** The account this avatar belongs to, or null when signed out. */
	readonly account: string | null;
	/** Sanitized inline SVG, or null. Takes precedence over the data URI. */
	readonly avatarSvg: string | null;
	/** image/webp data URI, or null. */
	readonly avatarDataUri: string | null;
}

const EMPTY: SelfProfileAvatar = { account: null, avatarSvg: null, avatarDataUri: null };

export const selfProfile = writable<SelfProfileAvatar>(EMPTY);

/** Monotonic token so a slow fetch for an old account can't clobber a
 *  newer account's result (account-switch race). */
let latest = 0;

/**
 * Resolve and publish the logged-in user's own avatar.
 * @param account the current account name (null ⇒ signed out ⇒ clear)
 * @param opts.bustCache force a fresh indexer fetch (after a broadcast)
 */
/** #2 — how many times a FAILED self-profile fetch is retried, and how long
 *  we wait between attempts. The profile cache negative-caches a failed fetch
 *  for 5s (cp428's soft TTL), so waiting slightly longer than that guarantees
 *  the retry actually re-hits the network rather than replaying the failure.
 *  Without this, a single blip on first load left the user staring at their
 *  identicon for the whole session — the store is only refreshed again on an
 *  account change or a profile broadcast. */
const SELF_PROFILE_RETRIES = 2;
const SELF_PROFILE_RETRY_DELAY_MS = 6_000;

export async function refreshSelfProfile(
	account: string | null,
	opts?: { bustCache?: boolean }
): Promise<void> {
	if (!account) {
		selfProfile.set(EMPTY);
		return;
	}
	const token = ++latest;
	if (opts?.bustCache) clearProfileCache(account);
	for (let attempt = 0; ; attempt++) {
		try {
			// #2 — `reload` when busting: clearProfileCache only drops OUR
			// in-memory entry, but the batch endpoint sets `max-age=90`, so the
			// browser's own HTTP cache would keep replaying the PRE-broadcast
			// response and the user wouldn't see the avatar they just set.
			const { profile, failed } = await getProfileCachedDetailed(account, undefined, {
				reload: opts?.bustCache === true
			});
			// A newer refresh (account switch) superseded this one — discard.
			if (token !== latest) return;
			// #2 — the profile cache collapses "fetch failed" and "no profile"
			// into the same bare null, so blindly applying it used to CLEAR a
			// good avatar to the identicon on any transient blip. On failure,
			// keep whatever we're already showing for THIS account and retry;
			// only blank on an account SWITCH, where showing the previous
			// account's avatar would be wrong.
			if (failed) {
				selfProfile.update((cur) =>
					cur.account === account ? cur : { account, avatarSvg: null, avatarDataUri: null }
				);
				if (attempt < SELF_PROFILE_RETRIES) {
					await new Promise((r) => setTimeout(r, SELF_PROFILE_RETRY_DELAY_MS));
					if (token !== latest) return;
					continue;
				}
				return;
			}
			const props = extractLabelPropsFromProfile(profile);
			selfProfile.set({
				account,
				avatarSvg: props.avatarSvg,
				avatarDataUri: props.avatarDataUri
			});
			return;
		} catch {
			// Defensive: getProfileCachedDetailed resolves rather than throwing.
			// Keep whatever we had rather than blanking a good avatar.
			return;
		}
	}
}

/** Clear on sign-out / lock. */
export function clearSelfProfile(): void {
	latest++;
	selfProfile.set(EMPTY);
}

/**
 * Optimistically set the self avatar right after a CONFIRMED broadcast
 * (block_num returned) so the avatar menu / labels update instantly
 * instead of waiting for the indexer to catch up (1–2 blocks). Safe
 * because the caller only invokes this once the chain accepted the op;
 * the next account-change refresh re-confirms from the indexer. Pass
 * null/null to reflect an avatar removal.
 */
export function setSelfAvatar(
	account: string,
	avatarSvg: string | null,
	avatarDataUri: string | null
): void {
	latest++;
	selfProfile.set({ account, avatarSvg, avatarDataUri });
}
