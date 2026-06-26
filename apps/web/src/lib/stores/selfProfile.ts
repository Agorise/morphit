/**
 * selfProfile — the logged-in user's OWN avatar (sanitized SVG / data URI),
 * resolved from their on-chain profile once and shared so it can render
 * EVERYWHERE the heart identicon otherwise appears: the top-right avatar
 * menu, and any IdentityLabel whose subject is the current user. Without
 * this, each surface only had the deterministic identicon — the user's
 * uploaded avatar showed on their public profile page but nowhere else.
 *
 * Populated on account change (AvatarMenu effect) and refreshed after the
 * user broadcasts a profile update (settings page, bustCache=true). Cleared
 * on sign-out. A network failure leaves the previous value in place; the
 * identicon fallback covers the empty case.
 */
import { writable } from 'svelte/store';
import { getProfileCached, clearProfileCache } from '$lib/indexer/profileCache';
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
	try {
		const profile = await getProfileCached(account);
		// A newer refresh (account switch) superseded this one — discard.
		if (token !== latest) return;
		const props = extractLabelPropsFromProfile(profile);
		selfProfile.set({
			account,
			avatarSvg: props.avatarSvg,
			avatarDataUri: props.avatarDataUri
		});
	} catch {
		// Network/fetch failure — keep whatever we had; identicon covers it.
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
