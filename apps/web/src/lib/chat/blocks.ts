/**
 * Morphit — client-side block-list store.
 *
 * Single source of truth for "who has the local user blocked?"
 * across the UI: conversation header (to show Block vs
 * Unblock), inbox (to hide pending blocked-sender messages from
 * the indexer's eventual-consistency window), Settings →
 * Blocked Accounts.
 *
 * Load model:
 *   - Lazy: first access fetches via getBlocks().
 *   - Cache valid for the session. Navigating away and back
 *     triggers a refresh via refreshBlocks().
 *   - After a broadcast, the caller updates the store
 *     optimistically with markBlocked / markUnblocked. The
 *     indexer confirms on the next refresh.
 *
 * Not persisted to localStorage. A stale blocks list on next
 * session-open would tell the user they've blocked someone they
 * haven't, or vice versa; a one-roundtrip fetch on cold start
 * is the honest tradeoff.
 */

import { writable, type Readable, get } from 'svelte/store';

import { getBlocks } from '$lib/indexer/client';

/** Set of accounts the local user currently has blocked.
 *  Normalized lowercase — Blurt accounts are lowercase by
 *  spec, but normalizing here avoids any case-mismatch bug
 *  when comparing against UI-entered names later. */
const blockedSet = writable<Set<string>>(new Set());

let loaded = false;
let inflight: Promise<void> | null = null;
/** Bumped on every optimistic mutation (markBlocked / markUnblocked).
 *  loadBlocks snapshots it before its fetch and refuses to overwrite the
 *  store if the user mutated the set while the fetch was in flight — so a
 *  Block/Unblock clicked mid-load can't be silently clobbered by a now-
 *  stale indexer snapshot. The next refreshBlocks reconciles. */
let mutationGen = 0;

/** Readable store surface for components. Always safe to
 *  subscribe — initial value is an empty set. Components can
 *  render optimistically ("not blocked") until the load
 *  completes. */
export const blockedAccounts: Readable<Set<string>> = {
	subscribe: blockedSet.subscribe
};

/** Ensure the store has been loaded at least once. Safe to
 *  call repeatedly — concurrent callers share the same
 *  in-flight fetch. */
export async function loadBlocks(myAccount: string): Promise<void> {
	if (loaded && !inflight) {
		return;
	}
	if (inflight) {
		return inflight;
	}
	const startGen = mutationGen;
	inflight = (async () => {
		const res = await getBlocks(myAccount);
		if (res.ok) {
			// If the user optimistically mutated the set (markBlocked /
			// markUnblocked) while this fetch was in flight, the indexer
			// snapshot we just received predates their action — adopting it
			// would clobber a Block/Unblock they just clicked (it would
			// "un-stick"). Keep their newer state; a later refreshBlocks
			// reconciles once the op is indexed. With no intervening
			// mutation, adopt the indexer truth as the authoritative set.
			if (mutationGen === startGen) {
				const s = new Set<string>();
				for (const e of res.data.items) {
					s.add(e.blocked.toLowerCase());
				}
				blockedSet.set(s);
			}
			loaded = true;
		}
		// On failure, leave loaded=false so a later access
		// retries. Callers see an empty set, which is safe —
		// it just means the UI shows "Block" instead of
		// "Unblock" until the indexer responds.
	})();
	try {
		await inflight;
	} finally {
		inflight = null;
	}
}

/** Force a refresh from the indexer. Use on Settings > Blocked
 *  Accounts mount, or after a navigation where the inbox state
 *  may have drifted. */
export async function refreshBlocks(myAccount: string): Promise<void> {
	loaded = false;
	return loadBlocks(myAccount);
}

/** Optimistic update: the local user just broadcast a block
 *  against `account`. Update the store so every surface sees
 *  the new state immediately. The indexer will confirm on the
 *  next refresh; if it dissents (unlikely — the op signature
 *  validates or doesn't), refreshBlocks() corrects us. */
export function markBlocked(account: string): void {
	const normalized = account.toLowerCase();
	mutationGen++;
	blockedSet.update((s) => {
		if (s.has(normalized)) return s;
		const next = new Set(s);
		next.add(normalized);
		return next;
	});
}

/** Optimistic update: the local user just broadcast an
 *  unblock. Parallel to markBlocked. */
export function markUnblocked(account: string): void {
	const normalized = account.toLowerCase();
	mutationGen++;
	blockedSet.update((s) => {
		if (!s.has(normalized)) return s;
		const next = new Set(s);
		next.delete(normalized);
		return next;
	});
}

/** Synchronous check. For components that already have a
 *  subscription, prefer reading through the store. For one-off
 *  checks (e.g. "is this peer blocked right now?"), this
 *  helper avoids the subscribe/unsubscribe ceremony. */
export function isBlocked(account: string): boolean {
	return get(blockedSet).has(account.toLowerCase());
}
