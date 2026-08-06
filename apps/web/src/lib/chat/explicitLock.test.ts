// @vitest-environment jsdom
/**
 * Tests for the explicit-lock cleanup helper.
 *
 * runExplicitLockExtras wipes chat-related local state on a
 * user-initiated Lock. We verify:
 *   - Chat drafts (every chat.* slot in storage) are cleared
 *   - The recent-peers list itself is cleared
 *   - Orphan chat drafts (peer no longer in the recent-peers
 *     list, e.g. fell off the cap-of-20) ALSO get cleared —
 *     this guards Finding C from the chat audit, which
 *     uncovered a leak when the prior implementation iterated
 *     only the recent-peers list.
 *   - All in-scope draft namespaces (post.compose, feedback.*,
 *     feedback_response.*) are cleared
 *   - Safe to call when no state exists
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runExplicitLockExtras } from './explicitLock';
import { recordRecentPeer, loadRecentPeers } from './recentPeers';
import { markConversationRead, getLastVisited } from './readState';
import { setPin, getPin, type ChatPubPin } from './pubPin';
import { saveDraft, loadDraft } from '$lib/drafts';

describe('explicitLock — runExplicitLockExtras', () => {
	beforeEach(() => {
		// Clear any cross-test leftovers.
		try {
			localStorage.clear();
		} catch {
			// noop
		}
	});

	afterEach(() => {
		try {
			localStorage.clear();
		} catch {
			// noop
		}
	});

	it('is safe to call with no peers and no drafts', () => {
		// Should not throw.
		expect(() => runExplicitLockExtras()).not.toThrow();
	});

	it('clears chat drafts for each known peer', () => {
		recordRecentPeer('alice');
		recordRecentPeer('bob');
		saveDraft('chat.alice', { text: 'hello alice' });
		saveDraft('chat.bob', { text: 'hello bob' });
		// Sanity: drafts are saved.
		expect(loadDraft<{ text: string }>('chat.alice')).toEqual({
			text: 'hello alice'
		});
		expect(loadDraft<{ text: string }>('chat.bob')).toEqual({
			text: 'hello bob'
		});

		runExplicitLockExtras();

		expect(loadDraft<{ text: string }>('chat.alice')).toBeNull();
		expect(loadDraft<{ text: string }>('chat.bob')).toBeNull();
	});

	it('clears the recent-peers list', () => {
		recordRecentPeer('alice');
		recordRecentPeer('bob');
		expect(loadRecentPeers()).toEqual(['bob', 'alice']);

		runExplicitLockExtras();

		expect(loadRecentPeers()).toEqual([]);
	});

	it('clears orphan chat drafts (Finding C regression guard)', () => {
		// A draft for a peer who is NOT in the recent-peers list.
		// The recent-peers list is capped at 20 entries — older
		// peers that fall off the list could orphan their drafts.
		// The contract is "explicit lock = wipe", so even orphans
		// must be cleared.
		recordRecentPeer('alice');
		saveDraft('chat.alice', { text: 'to alice' });
		saveDraft('chat.charlie', { text: 'to charlie (orphan)' });

		runExplicitLockExtras();

		expect(loadDraft<{ text: string }>('chat.alice')).toBeNull();
		// Charlie's draft must also be gone — even though Charlie
		// is not in the recent-peers list, an explicit lock should
		// not leak it.
		expect(loadDraft<{ text: string }>('chat.charlie')).toBeNull();
	});

	it('clears all in-scope draft namespaces (post, feedback, feedback_response)', () => {
		recordRecentPeer('alice');
		saveDraft('chat.alice', { text: 'chat draft' });
		saveDraft('post.compose', { side: 'buy', asset: 'BTC' });
		saveDraft('feedback.order123', { comment: 'fb' });
		saveDraft('feedback_response.abc', { comment: 'resp' });

		runExplicitLockExtras();

		expect(loadDraft('chat.alice')).toBeNull();
		expect(loadDraft('post.compose')).toBeNull();
		expect(loadDraft('feedback.order123')).toBeNull();
		expect(loadDraft('feedback_response.abc')).toBeNull();
	});

	it('clears the per-peer read-state map (Finding E regression guard)', () => {
		// readState.ts says it should be wiped on lock — and the
		// data is privacy-sensitive (who you visited and when), so
		// runExplicitLockExtras must call clearReadState().
		markConversationRead('alice', '', new Date('2026-04-20T10:00:00Z'));
		markConversationRead('bob', '', new Date('2026-04-21T11:00:00Z'));
		expect(getLastVisited('alice', '')).toBe('2026-04-20T10:00:00.000Z');
		expect(getLastVisited('bob', '')).toBe('2026-04-21T11:00:00.000Z');

		runExplicitLockExtras();

		expect(getLastVisited('alice', '')).toBeNull();
		expect(getLastVisited('bob', '')).toBeNull();
	});

	it('clears all chat-pub pins (Option 5 / S2 wiring)', () => {
		// The chain-anchored chat-pub pins reveal which peers the
		// user has chatted with — same privacy class as recent-
		// peers and read-state.  Explicit lock must wipe them.
		const pin: ChatPubPin = {
			blockNum: 12345,
			trxId: 'a'.repeat(40),
			pubB64: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='
		};
		setPin('alice', pin);
		setPin('bob', { ...pin, blockNum: 67890 });
		expect(getPin('alice')).not.toBeNull();
		expect(getPin('bob')).not.toBeNull();

		runExplicitLockExtras();

		expect(getPin('alice')).toBeNull();
		expect(getPin('bob')).toBeNull();
	});

	it('is idempotent — multiple calls are safe', () => {
		recordRecentPeer('alice');
		saveDraft('chat.alice', { text: 'hi' });

		runExplicitLockExtras();
		runExplicitLockExtras();
		runExplicitLockExtras();

		expect(loadDraft('chat.alice')).toBeNull();
		expect(loadRecentPeers()).toEqual([]);
	});
});
