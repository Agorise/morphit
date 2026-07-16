// @vitest-environment jsdom
/**
 * cp474 (t.txt #5, "fastmessagestatusupdate") — a folder move must survive an
 * immediate refresh.
 *
 * THE BUG THIS GUARDS AGAINST. Ken, on live morphit.io: "if i move a message to
 * a different folder, and then i immediately refresh the page, my message move
 * doesn't actually take effect until after around 1 minute."
 *
 * `syncChatFoldersFromChain` adopted the on-chain state UNCONDITIONALLY. A move
 * writes the local mirror instantly but only reaches the chain after a 1.5s
 * debounce, a block, and indexing — so for roughly a minute `/v1/chat-folders`
 * still serves the PRE-move state. Refresh inside that window and the
 * mount-time sync handed that stale copy straight back over the user's own
 * change. The move didn't just look slow; it was actively REVERTED, and only
 * reappeared once the indexer caught up.
 *
 * The endpoint has always returned `updated_at`, and `ChatFoldersResponse` has
 * always carried it — nobody read it. These tests pin last-write-wins against
 * that field, in both directions: a chain that's behind us must not clobber,
 * and a chain that's genuinely ahead (another device) must still win, or
 * cross-device sync would be traded away for the fix.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';
import { writable } from 'svelte/store';

const ME = 'kentest3';
const PEER = 'kentest2';
const ORDER = 'im-selling-200-mxn-of-xmr';

// `vi.mock` factories are hoisted above every top-level statement, so anything
// they close over has to be hoisted with them.
const h = vi.hoisted(() => {
	return {
		/** What `/v1/chat-folders/:account` will answer with. */
		chain: {
			enc: 'opaque-ciphertext' as string | null,
			updatedAt: null as string | null,
			/** What decrypting `enc` yields. */
			state: { starred: [] as string[], archived: [] as string[] }
		}
	};
});

const identityStore = writable<unknown>({
	state: 'unlocked',
	live: { posting: { privateKey: 'fake-priv', publicKey: 'fake-pub' } }
});

vi.mock('$lib/stores/identity', async () => {
	const { writable: w } = await import('svelte/store');
	return {
		identity: w({
			state: 'unlocked',
			live: { posting: { privateKey: 'fake-priv', publicKey: 'fake-pub' } }
		})
	};
});

vi.mock('$blurt/ops/profile', async (importOriginal) => {
	const actual = await importOriginal<typeof import('$blurt/ops/profile')>();
	return { ...actual, getUserBlurtAccount: () => ME };
});

vi.mock('$lib/indexer/client', () => ({
	getChatFolders: vi.fn(async () => ({
		ok: true as const,
		data: { account: 'kentest3', enc: h.chain.enc, updated_at: h.chain.updatedAt }
	}))
}));

vi.mock('./folderCrypto', () => ({
	decryptFolderState: vi.fn(async () => h.chain.state),
	encryptFolderState: vi.fn(async () => 'opaque-ciphertext')
}));

// The broadcast is not what's under test and must not need a chain.
vi.mock('$blurt/ops/chatFolders', () => ({
	broadcastChatFolders: vi.fn(async () => ({ ok: true }))
}));

import {
	archiveThread,
	isArchived,
	isStarred,
	clearChatFolders,
	__reloadChatFolders,
	resurrectArchivedOnNewActivity,
	syncChatFoldersFromChain
} from './chatFolders';

describe('cp474 — chat folder sync is last-write-wins (t.txt #5)', () => {
	beforeEach(() => {
		localStorage.clear();
		clearChatFolders();
		__reloadChatFolders();
		h.chain.enc = 'opaque-ciphertext';
		h.chain.state = { starred: [], archived: [] };
		h.chain.updatedAt = null;
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('does NOT let a stale chain undo a move made moments ago', async () => {
		vi.useFakeTimers();
		// The chain's newest folder op is from yesterday and knows nothing of the
		// thread — this is the state the indexer serves for ~a minute after a move.
		h.chain.updatedAt = '2026-07-14T09:00:00.000Z';
		h.chain.state = { starred: [], archived: [] };

		// The user archives the thread NOW...
		vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));
		archiveThread(PEER, ORDER);
		expect(isArchived(PEER, ORDER)).toBe(true);

		// ...and immediately refreshes. That mount calls the sync, which sees a
		// chain older than our change and must leave the move alone.
		await syncChatFoldersFromChain();

		expect(isArchived(PEER, ORDER)).toBe(true);
	});

	it('DOES adopt a chain that is genuinely newer (another device filed it)', async () => {
		vi.useFakeTimers();
		// Our last local change was yesterday...
		vi.setSystemTime(new Date('2026-07-14T09:00:00.000Z'));
		archiveThread(PEER, ORDER);

		// ...and the user's phone starred something an hour ago. The chain is ahead,
		// so cross-device sync must still win — this is the property the fix must
		// not trade away.
		vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));
		h.chain.updatedAt = '2026-07-15T08:00:00.000Z';
		h.chain.state = { starred: [`${PEER}\u0000${ORDER}`], archived: [] };

		await syncChatFoldersFromChain();

		expect(isStarred(PEER, ORDER)).toBe(true);
		expect(isArchived(PEER, ORDER)).toBe(false);
	});

	// cp474 — found during the cp474 deep-deep, not reported by Ken. The on-chain
	// payload carries no timestamps, so `stateToMap` has to invent an `at`. It
	// used to stamp `now` on EVERY adopted entry, which silently switched off
	// `resurrectArchivedOnNewActivity` on the poll path: that compares a thread's
	// newest message time to `entry.at`, so re-stamping every archived thread to
	// "now" on each sync makes all real message times look older than the archive
	// — and a message that landed while the user was away could never resurface.
	// The Gmail behaviour the resurrect documents was being disabled by its
	// neighbour.
	it('carries the REAL archive time through an adopt, so resurrect still works', async () => {
		vi.useFakeTimers();

		// Archived on the 13th, and the chain agrees about it.
		vi.setSystemTime(new Date('2026-07-13T09:00:00.000Z'));
		archiveThread(PEER, ORDER);

		// The chain is newer than our stamp, so this adopt is taken.
		vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));
		h.chain.updatedAt = '2026-07-14T09:00:00.000Z';
		h.chain.state = { starred: [], archived: [`${PEER}\u0000${ORDER}`] };
		await syncChatFoldersFromChain();
		expect(isArchived(PEER, ORDER)).toBe(true);

		// A message from the 14th postdates the real archive (the 13th) but PREDATES
		// the adopt (the 15th). If the adopt re-stamped `at` to now, this resurrect
		// is a no-op and the message stays buried.
		resurrectArchivedOnNewActivity([
			{ peer: PEER, orderPermlink: ORDER, lastMessageAt: '2026-07-14T10:00:00.000Z' }
		]);
		expect(isArchived(PEER, ORDER)).toBe(false);
	});

	it('does NOT resurface pre-existing history on a device seeing a thread for the first time', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));

		// A fresh device has no mirror entry, so there is no real archive time to
		// carry forward and `now` is the honest answer. The point of that default is
		// exactly this: signing in on a new device must not dump the whole Archived
		// tab into the Inbox.
		h.chain.updatedAt = '2026-07-14T09:00:00.000Z';
		h.chain.state = { starred: [], archived: [`${PEER}\u0000${ORDER}`] };
		await syncChatFoldersFromChain();
		expect(isArchived(PEER, ORDER)).toBe(true);

		resurrectArchivedOnNewActivity([
			{ peer: PEER, orderPermlink: ORDER, lastMessageAt: '2026-07-10T10:00:00.000Z' }
		]);
		expect(isArchived(PEER, ORDER)).toBe(true);
	});

	it('adopts when there is no local change at all (fresh device)', async () => {
		// A brand-new device has no stamp, so the chain is authoritative — the
		// pre-cp474 behaviour, and the correct default.
		h.chain.updatedAt = '2026-07-15T08:00:00.000Z';
		h.chain.state = { starred: [], archived: [`${PEER}\u0000${ORDER}`] };

		await syncChatFoldersFromChain();

		expect(isArchived(PEER, ORDER)).toBe(true);
	});

	// NOTE (honest scope): this pins that being "ahead" is never a permanent
	// lock-out — a later chain write still wins. It does NOT pin
	// `clearLocalChange()` specifically: chain timestamps advance monotonically
	// past a stale stamp, so removing that call leaves this green. The clear is
	// belt-and-braces (it stops a device carrying a pointless "I'm ahead" claim),
	// not the thing that makes the property hold.
	it('being ahead of the chain is never a permanent lock-out', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-07-15T09:00:00.000Z'));
		archiveThread(PEER, ORDER);

		// The broadcast lands and the indexer publishes it: the chain now carries
		// our change and is newer than our stamp.
		vi.setSystemTime(new Date('2026-07-15T09:01:00.000Z'));
		h.chain.updatedAt = '2026-07-15T09:00:30.000Z';
		h.chain.state = { starred: [], archived: [`${PEER}\u0000${ORDER}`] };
		await syncChatFoldersFromChain();
		expect(isArchived(PEER, ORDER)).toBe(true);

		// The stamp must be gone, or this device would refuse every future sync.
		// Prove it by serving a newer chain state that contradicts us: it must win.
		h.chain.updatedAt = '2026-07-15T09:02:00.000Z';
		h.chain.state = { starred: [], archived: [] };
		await syncChatFoldersFromChain();
		expect(isArchived(PEER, ORDER)).toBe(false);
	});
});
