/**
 * Chat identity upkeep (since v1.21.13: re-publish only).
 *
 * v1.21.13: a FIRST publication no longer happens. It was a broadcast the
 * user never asked for, paid from their own BLURT the first time they opened
 * chat, and until it landed nobody could write to them; a new member short of
 * BLURT could never be reached at all. Messages to an account without a
 * published chat key now go to its posting key (the v3 envelope, crypto.ts),
 * which is on chain from the moment the account exists, so nothing needs
 * publishing. What stays is the RE-publication: an account that published a
 * chat key and later changed its posting key would otherwise keep a stale key
 * on chain, and peers sending the older format to it could not be read.
 *
 * Before v1.21.13:
 *
 * Per ADR-0015, every account has an X25519 chat identity that
 * must be PUBLISHED on-chain before peers can send encrypted
 * messages to it. The publication is automatic — triggered the
 * first time the user opens any chat surface — so users never
 * see a "set up chat" screen.
 *
 * This helper encapsulates the full flow: check the indexer for
 * an existing record, compare with what we'd derive, and
 * broadcast if needed. Safe to call repeatedly (idempotent once
 * published).
 *
 * Call from chat route page-mount handlers. Non-blocking: fire
 * and forget, the user never waits for this.
 */

import { get } from 'svelte/store';

import { isUnlocked, liveIdentity } from '$stores/identity';
import { getUserBlurtAccount } from '$blurt/ops/profile';
import { deriveChatIdentity, encodeChatPub, wipeChatIdentity } from '$lib/chat/crypto';
import { broadcastChatIdentity } from '$blurt/ops/chatIdentity';
import { getChatIdentity } from '$lib/indexer/client';
import { recordOwnPublished } from '$lib/chat/pubPin';

export type PublishResult =
	| { kind: 'already_published' }
	| { kind: 're_published'; trx_id: string; block_num: number }
	| { kind: 'skipped'; reason: 'locked' | 'no_account' | 'not_published' }
	| { kind: 'failed'; reason: string };

/**
 * Per-session cache: account name → confirmed-published-at
 * timestamp. Once we've verified (or just performed) a
 * publication for an account in this session, subsequent calls
 * short-circuit to 'already_published' without hitting the
 * indexer.
 *
 * Deliberately NOT cleared on lock: entries are public account
 * names (not secrets), and a stale entry at worst causes one
 * extra indexer GET after unlock to re-confirm. That's cheaper
 * than an import-dependency chain that would pull this module
 * (and its libsodium transitively) into the base bundle via
 * the identity store.
 */
const publishedThisSession: Set<string> = new Set();

/**
 * Ensure the current user's chat identity is published on-chain.
 *
 * Behavior:
 *   - Session locked → returns {kind: 'skipped', reason: 'locked'}.
 *     Caller can retry after unlock.
 *   - No Blurt account on file → same, 'no_account'. Pre-onboarding.
 *   - Already confirmed in this session → 'already_published'
 *     (short-circuit, no network).
 *   - Existing record matches derived pubkey → 'already_published'.
 *     No broadcast.
 *   - Existing record present but pubkey differs → 're_published'.
 *     This happens after a posting-key rotation (the derivation
 *     changed).
 *   - No existing record → 'skipped' ('not_published'): nothing is broadcast
 *     (v1.21.13 — messages to us go to our posting key).
 *   - Any network / broadcast error → 'failed' with reason.
 *
 * This function never throws — errors are wrapped in the return
 * value. The caller is typically a page-mount handler firing this
 * as a background task.
 */
export async function ensureChatIdentityPublished(): Promise<PublishResult> {
	try {
		if (!get(isUnlocked)) {
			return { kind: 'skipped', reason: 'locked' };
		}
		const live = get(liveIdentity);
		if (live === null) {
			return { kind: 'skipped', reason: 'locked' };
		}
		const account = getUserBlurtAccount();
		if (!account) {
			return { kind: 'skipped', reason: 'no_account' };
		}

		// Fast path: already confirmed published in this session.
		// Skips the derivation, the indexer GET, and the potential
		// broadcast. This is the common case on repeat visits.
		if (publishedThisSession.has(account)) {
			return { kind: 'already_published' };
		}

		// Derive what our chat pubkey SHOULD be.
		const identity = await deriveChatIdentity(live.posting.privateKey, account);
		const expectedPubBase64 = encodeChatPub(identity.pub);
		// The priv is now in memory; we don't need it past this
		// point (broadcast only sends the pub). Wipe to minimize
		// memory exposure. Best-effort per sodium.memzero.
		wipeChatIdentity(identity);

		// Check the indexer for any existing published record.
		const existing = await getChatIdentity(account);

		if (existing.ok) {
			if (existing.data.chat_pub === expectedPubBase64) {
				publishedThisSession.add(account);
				// Seen current: a later "none" from an indexer cannot move this
				// account's conversations off chat keys (chatService.ownChatKeyStatus).
				recordOwnPublished(account, expectedPubBase64);
				return { kind: 'already_published' };
			}
			// Existing record doesn't match — user must have
			// rotated their posting key. Re-publish.
			const r = await broadcastChatIdentity(live, expectedPubBase64);
			publishedThisSession.add(account);
			// Not recorded as current yet: accepted is not on chain. The next
			// check that SEES it there records it.
			return {
				kind: 're_published',
				trx_id: r.trx_id,
				block_num: r.block_num
			};
		}

		// Not published: nothing to keep current, and nothing is published
		// (v1.21.13). Any other error is a real failure.
		if (existing.code !== 'not_found') {
			return {
				kind: 'failed',
				reason: `indexer lookup failed: ${existing.message}`
			};
		}
		return { kind: 'skipped', reason: 'not_published' };
	} catch (err) {
		// Audit 2026-05 finding 2-4: don't echo the underlying
		// error text into the `reason` field — it surfaces in
		// telemetry / dev console / page UI in some callers and
		// could leak internal library wording or stack hints.
		// Log full detail for devtools, surface a generic
		// classification.
		// eslint-disable-next-line no-console
		console.warn('[ensureChatIdentity] unexpected error:', err);
		return {
			kind: 'failed',
			reason: 'unexpected error during chat identity publish'
		};
	}
}
