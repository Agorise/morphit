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
import { get, writable } from 'svelte/store';
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
			// `reload` on ANY retry, not just an explicit bustCache: clearing our
			// in-memory entry alone leaves the browser's own HTTP cache (the
			// batch endpoint sets max-age=90) free to replay the very response
			// we are retrying because of. A retry that re-reads the same cached
			// answer is not a retry.
			const { profile, failed } = await getProfileCachedDetailed(account, undefined, {
				reload: opts?.bustCache === true || attempt > 0
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
			// v1.8.11 (Ken) — "no profile yet" is NOT a final answer.
			//
			// The retry above only covered a FAILED fetch. A fetch that
			// SUCCEEDS and reports "this account has no profile" fell straight
			// through to here, stored a null avatar, and never looked again —
			// so the menu sat on an identicon while the profile page, which
			// fetches independently, showed the real avatar on the same screen.
			// That is exactly what Ken saw, and why it "fixed itself" minutes
			// later: only a remount plus the 90s cache expiry could dislodge it.
			//
			// The absence is genuinely transient for the case that matters: a
			// profile op takes ~45-63s to be indexed, so a user who has just
			// set an avatar — or just signed in on a fresh browser while the
			// indexer is still catching up — legitimately reads as "no profile"
			// for a while. So retry on absence too, bursting the cache each
			// time (an unbusted retry would just re-read the same cached null).
			//
			// A user who genuinely has no avatar simply retries twice in the
			// background and settles on the identicon, which is what they
			// should see anyway — the cost of being wrong here is two extra
			// requests, against an avatar that never appears.
			const gotAvatar = props.avatarSvg !== null || props.avatarDataUri !== null;
			// DISCRIMINATOR between the two ways "no avatar" can arrive:
			//
			//   • We already had one for THIS account and the server now says
			//     none  ⇒  the user REMOVED it. Authoritative; apply at once,
			//     or "Remove avatar" would appear not to work for 12s.
			//   • We never had one  ⇒  absence may simply mean "not indexed
			//     yet" (a profile op takes ~45-63s to land), so retry.
			//
			// Without this split, fixing Ken's stuck-identicon would have
			// broken avatar removal — which `selfProfile.test.ts` catches.
			const hadAvatarForThisAccount = (() => {
				const cur = get(selfProfile);
				return (
					cur.account === account && (cur.avatarSvg !== null || cur.avatarDataUri !== null)
				);
			})();
			if (!gotAvatar && !hadAvatarForThisAccount && attempt < SELF_PROFILE_RETRIES) {
				// Blank FIRST if the store still holds a different account.
				// Retrying without this would leave the PREVIOUS account's
				// avatar in the store for the whole retry window — the exact
				// cross-account bleed the rest of this release exists to kill.
				// Same rule as the `failed` branch above: keep what we have for
				// THIS account (a transient blip must not clear a good avatar),
				// blank on an account SWITCH.
				selfProfile.update((cur) =>
					cur.account === account ? cur : { account, avatarSvg: null, avatarDataUri: null }
				);
				await new Promise((r) => setTimeout(r, SELF_PROFILE_RETRY_DELAY_MS));
				if (token !== latest) return;
				clearProfileCache(account);
				continue;
			}
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
 * instead of waiting for the indexer to catch up. Safe because the caller only
 * invokes this once the chain accepted the op; the next account-change refresh
 * re-confirms from the indexer. Pass null/null to reflect an avatar removal.
 *
 * v1.7.0 — this used to say the indexer needed "1–2 blocks". It needs 45-63s:
 * the poller applies only blocks up to last-irreversible (ADR-0008). The
 * MECHANISM here was always right (don't wait — you already know what you
 * broadcast), so nothing changed but the number. The same "1–2 blocks" belief
 * written into a TIMEOUT is what broke profileCache's prime hold (12s), the
 * order-detail retry (24s) and the order-visible poll (40s) — all of them
 * expiring before the indexer could possibly have the answer.
 */
export function setSelfAvatar(
	account: string,
	avatarSvg: string | null,
	avatarDataUri: string | null
): void {
	latest++;
	selfProfile.set({ account, avatarSvg, avatarDataUri });
}
