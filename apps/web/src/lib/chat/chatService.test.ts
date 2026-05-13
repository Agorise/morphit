/**
 * Tests for chatService — the chat conversation controller.
 *
 * Focus areas:
 *   - Optimistic state machine (pending → broadcast → confirmed)
 *   - client_tag reconciliation
 *   - Dedup by server id across repeated polls / SSE events
 *   - Failure + retry paths
 *   - SSE-primary delivery via subscribeStream dep (Phase E.5)
 *   - Defense-in-depth fallback polling (60s) when SSE absent
 *   - Cleanup on destroy
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	createConversationController,
	type ChatControllerDeps,
	type LocalMessage
} from './chatService';
import type { ChatMessageRecord } from '@morphit/indexer-client';
import type { LiveIdentity } from '$crypto/keygen';

/** Fake LiveIdentity — we never exercise it beyond identity
 *  presence, so an empty object cast is fine for tests. */
const fakeLive = {} as unknown as LiveIdentity;

/** Build a mock ChatMessageRecord with sensible defaults. */
function mockRecord(overrides: Partial<ChatMessageRecord> = {}): ChatMessageRecord {
	return {
		id: 1,
		sender: 'alice',
		recipient: 'bob',
		ciphertext: 'c3R1Yg==',
		header: {},
		created_at: '2026-04-23T12:00:00.000Z',
		...overrides
	};
}

/** Helper to build ChatControllerDeps with controllable mocks.
 *  Any field can be overridden; sensible defaults for the rest. */
function mockDeps(overrides: Partial<ChatControllerDeps> = {}): ChatControllerDeps & {
	emitted: LocalMessage[][];
	fetchMock: ReturnType<typeof vi.fn>;
	broadcastMock: ReturnType<typeof vi.fn>;
	encryptMock: ReturnType<typeof vi.fn>;
	decryptMock: ReturnType<typeof vi.fn>;
	fetchPeerChatPubMock: ReturnType<typeof vi.fn>;
	visibilityListeners: (() => void)[];
	setVisibility: (v: 'visible' | 'hidden') => void;
} {
	let vis: 'visible' | 'hidden' = 'visible';
	const visibilityListeners: (() => void)[] = [];
	const emitted: LocalMessage[][] = [];
	const fetchMock = vi.fn();
	const broadcastMock = vi.fn();
	const encryptMock = vi.fn();
	const decryptMock = vi.fn();
	const fetchPeerChatPubMock = vi.fn();
	let tagCounter = 0;

	// A non-zero 32-byte value used as both the peer pub and
	// as the "my identity" keys. No actual X25519 math runs in
	// tests, so the exact bytes don't matter — just that they're
	// valid length.
	const fakePub = new Uint8Array(32).fill(7);
	const fakePriv = new Uint8Array(32).fill(9);
	fetchPeerChatPubMock.mockResolvedValue(fakePub);
	// encrypt stub: packs plaintext into ciphertext field so test
	// assertions can see what was "encrypted" (base64-encoded so
	// the on-chain validators in test fixtures are happy).
	encryptMock.mockImplementation(async (plaintext: string) => ({
		ciphertext: btoa(
			// Encode as UTF-8 bytes first so non-ASCII plaintext
			// round-trips through btoa (which only accepts
			// Latin-1).
			String.fromCharCode(...new TextEncoder().encode(plaintext))
		),
		ephemeralPub: btoa(String.fromCharCode(...fakePub)),
		nonce: btoa(String.fromCharCode(...new Uint8Array(12).fill(3)))
	}));
	// decrypt stub: inverts the encrypt stub — pull plaintext back
	// out of the base64 ciphertext. Real-crypto tests live in
	// crypto.test.ts; this just lets chatService tests check the
	// decrypt-call plumbing.
	decryptMock.mockImplementation(async (envelope: { ciphertext: string }) => {
		const bytes = Uint8Array.from(atob(envelope.ciphertext), (ch) => ch.charCodeAt(0));
		return new TextDecoder().decode(bytes);
	});

	const base: ChatControllerDeps = {
		me: 'alice',
		peer: 'bob',
		// Q11: default to null in tests; specific test cases that
		// exercise the order-response bypass override.
		orderPermlink: null,
		getLiveIdentity: () => fakeLive,
		now: () => new Date('2026-04-23T12:00:00Z'),
		visibilityState: () => vis,
		onVisibilityChange: (cb) => {
			visibilityListeners.push(cb);
			return () => {
				const i = visibilityListeners.indexOf(cb);
				if (i >= 0) visibilityListeners.splice(i, 1);
			};
		},
		generateClientTag: () => {
			tagCounter += 1;
			return `tag${tagCounter.toString().padStart(28, '0')}`;
		},
		fetchHistory: fetchMock as unknown as ChatControllerDeps['fetchHistory'],
		broadcast: broadcastMock as unknown as ChatControllerDeps['broadcast'],
		fetchPeerChatPub: fetchPeerChatPubMock as unknown as ChatControllerDeps['fetchPeerChatPub'],
		deriveMyChatIdentity: async () => ({ priv: fakePriv, pub: fakePub }),
		encrypt: encryptMock as unknown as ChatControllerDeps['encrypt'],
		decrypt: decryptMock as unknown as ChatControllerDeps['decrypt'],
		onChange: (m) => {
			emitted.push([...m]);
		}
	};

	return {
		...base,
		...overrides,
		emitted,
		fetchMock,
		broadcastMock,
		encryptMock,
		decryptMock,
		fetchPeerChatPubMock,
		visibilityListeners,
		setVisibility: (v) => {
			vis = v;
			for (const cb of visibilityListeners) cb();
		}
	};
}

describe('chatService — controller', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	// ─── Send path ──────────────────────────────────────────────

	it('send moves a message from pending to broadcast on success', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });
		let resolveBroadcast: (v: { block_num: number; trx_id: string }) => void = () => undefined;
		deps.broadcastMock.mockReturnValue(
			new Promise((r) => {
				resolveBroadcast = r;
			})
		);

		const ctrl = createConversationController(deps);
		// Don't start the poll loop for this test — send path only.
		const sendPromise = ctrl.sendMessage('hello');

		// After the synchronous-push, there's one pending message.
		let snap = ctrl.snapshot();
		expect(snap).toHaveLength(1);
		expect(snap[0]!.state).toBe('pending');
		expect(snap[0]!.text).toBe('hello');
		expect(snap[0]!.sender).toBe('alice');
		expect(snap[0]!.clientTag).toMatch(/^tag0+1$/);

		// Resolve the broadcast.
		resolveBroadcast({ block_num: 1, trx_id: 'trx1' });
		await sendPromise;

		snap = ctrl.snapshot();
		expect(snap[0]!.state).toBe('broadcast');
	});

	it('send marks message failed when broadcast throws', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });
		deps.broadcastMock.mockRejectedValue(new Error('chain error'));

		const ctrl = createConversationController(deps);
		await ctrl.sendMessage('hello');

		const snap = ctrl.snapshot();
		expect(snap[0]!.state).toBe('failed');
		expect(snap[0]!.error).toBe('chain error');
	});

	it('send with locked identity records a failed message', async () => {
		const deps = mockDeps({ getLiveIdentity: () => null });
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });

		const ctrl = createConversationController(deps);
		await ctrl.sendMessage('hello');

		const snap = ctrl.snapshot();
		expect(snap).toHaveLength(1);
		expect(snap[0]!.state).toBe('failed');
		expect(snap[0]!.error).toMatch(/locked/i);
		expect(deps.broadcastMock).not.toHaveBeenCalled();
	});

	it('send ignores empty/whitespace-only text', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });

		const ctrl = createConversationController(deps);
		await ctrl.sendMessage('');
		await ctrl.sendMessage('   ');
		await ctrl.sendMessage('\t\n');

		expect(ctrl.snapshot()).toHaveLength(0);
		expect(deps.broadcastMock).not.toHaveBeenCalled();
	});

	it('send trims whitespace from the saved text', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });
		deps.broadcastMock.mockResolvedValue({ block_num: 1, trx_id: 'trx1' });

		const ctrl = createConversationController(deps);
		await ctrl.sendMessage('  hi there  \n');

		expect(ctrl.snapshot()[0]!.text).toBe('hi there');
	});

	// ─── Reconciliation path ────────────────────────────────────

	it('poll response with matching client_tag upgrades pending to confirmed', async () => {
		const deps = mockDeps();
		deps.broadcastMock.mockResolvedValue({ block_num: 1, trx_id: 'trx1' });

		const ctrl = createConversationController(deps);
		await ctrl.sendMessage('hello');
		// The message is 'broadcast' now.
		let snap = ctrl.snapshot();
		expect(snap[0]!.state).toBe('broadcast');
		const tag = snap[0]!.clientTag!;

		// Server returns the message with matching header.client_tag.
		deps.fetchMock.mockResolvedValue({
			ok: true,
			items: [
				mockRecord({
					id: 42,
					sender: 'alice',
					recipient: 'bob',
					header: { client_tag: tag }
				})
			],
			nextCursor: null
		});

		ctrl.start();
		// Advance time just enough for the initial pollOnce to fire
		// and complete. Microtasks after fake-timers advance.
		await vi.runOnlyPendingTimersAsync();

		snap = ctrl.snapshot();
		expect(snap).toHaveLength(1);
		expect(snap[0]!.state).toBe('confirmed');
		expect(snap[0]!.id).toBe(42);
		expect(snap[0]!.createdAt).toBeInstanceOf(Date);

		ctrl.destroy();
	});

	it('poll without matching client_tag adds message as confirmed, not merged', async () => {
		const deps = mockDeps();
		deps.broadcastMock.mockResolvedValue({ block_num: 1, trx_id: 'trx1' });

		const ctrl = createConversationController(deps);
		await ctrl.sendMessage('hello');
		const ourTag = ctrl.snapshot()[0]!.clientTag!;

		// Server returns a message from alice but with a DIFFERENT
		// client_tag (sent by alice from another client).
		deps.fetchMock.mockResolvedValue({
			ok: true,
			items: [
				mockRecord({
					id: 99,
					sender: 'alice',
					recipient: 'bob',
					header: { client_tag: 'other-device-tag-00000000000000000' }
				})
			],
			nextCursor: null
		});

		ctrl.start();
		await vi.runOnlyPendingTimersAsync();

		const snap = ctrl.snapshot();
		// Now we should have BOTH: our own broadcast (still broadcast
		// state because its tag didn't match) plus the new confirmed
		// message from the other device.
		expect(snap).toHaveLength(2);
		const states = snap.map((m) => m.state).sort();
		// Confirmed sorts before broadcast (by createdAt vs null).
		expect(states).toEqual(['broadcast', 'confirmed']);
		// Verify our tag is preserved on the broadcast entry.
		const our = snap.find((m) => m.clientTag === ourTag)!;
		expect(our.state).toBe('broadcast');

		ctrl.destroy();
	});

	it('incoming message from peer is added as confirmed', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({
			ok: true,
			items: [
				mockRecord({
					id: 7,
					sender: 'bob',
					recipient: 'alice'
				})
			],
			nextCursor: null
		});

		const ctrl = createConversationController(deps);
		ctrl.start();
		await vi.runOnlyPendingTimersAsync();

		const snap = ctrl.snapshot();
		expect(snap).toHaveLength(1);
		expect(snap[0]!.sender).toBe('bob');
		expect(snap[0]!.state).toBe('confirmed');
		expect(snap[0]!.id).toBe(7);
		// Placeholder plaintext until crypto lands.
		expect(snap[0]!.text).toBe('(encrypted)');

		ctrl.destroy();
	});

	// ─── Dedup ──────────────────────────────────────────────────

	it('repeated poll with same ids does not duplicate messages', async () => {
		const deps = mockDeps();
		const records = [
			mockRecord({
				id: 1,
				sender: 'bob',
				recipient: 'alice',
				created_at: '2026-04-23T12:00:01.000Z'
			}),
			mockRecord({
				id: 2,
				sender: 'bob',
				recipient: 'alice',
				created_at: '2026-04-23T12:00:02.000Z'
			})
		];
		deps.fetchMock.mockResolvedValue({ ok: true, items: records, nextCursor: null });

		const ctrl = createConversationController(deps);
		ctrl.start();
		await vi.runOnlyPendingTimersAsync();
		expect(ctrl.snapshot()).toHaveLength(2);

		// Advance past the fallback poll cadence (60s base + up-to-5s
		// jitter).  70s is comfortably past — second poll fires
		// returning the same items; dedup-by-id keeps message count
		// stable.
		await vi.advanceTimersByTimeAsync(70_000);
		// Still 2 — no duplicates.
		expect(ctrl.snapshot()).toHaveLength(2);

		ctrl.destroy();
	});

	it('chronological sort: older messages first, pending at the end', async () => {
		const deps = mockDeps();
		deps.broadcastMock.mockResolvedValue({ block_num: 1, trx_id: 'trx1' });

		// First: load some history.
		deps.fetchMock.mockResolvedValue({
			ok: true,
			items: [
				mockRecord({ id: 2, created_at: '2026-04-23T12:00:02.000Z' }),
				mockRecord({ id: 1, created_at: '2026-04-23T12:00:01.000Z' })
			],
			nextCursor: null
		});

		const ctrl = createConversationController(deps);
		ctrl.start();
		await vi.runOnlyPendingTimersAsync();

		// Now send a new message — it's pending, should sort after.
		await ctrl.sendMessage('hello');

		const snap = ctrl.snapshot();
		expect(snap.map((m) => m.id)).toEqual([1, 2, null]);
		expect(snap[2]!.state).toBe('broadcast');

		ctrl.destroy();
	});

	// ─── Retry ──────────────────────────────────────────────────

	it('retry sends a failed message again', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });
		deps.broadcastMock
			.mockRejectedValueOnce(new Error('chain error'))
			.mockResolvedValueOnce({ block_num: 1, trx_id: 'trx2' });

		const ctrl = createConversationController(deps);
		await ctrl.sendMessage('hello');

		let snap = ctrl.snapshot();
		expect(snap[0]!.state).toBe('failed');
		const seq = snap[0]!.localSeq;

		await ctrl.retryMessage(seq);
		snap = ctrl.snapshot();
		expect(snap).toHaveLength(1); // no new entry, same slot upgraded
		expect(snap[0]!.state).toBe('broadcast');
		expect(snap[0]!.error).toBeNull();
		// The retry uses a NEW client_tag so it's distinct on the chain.
		expect(snap[0]!.clientTag).toBe('tag' + '0'.repeat(27) + '2');
	});

	it('retry on a non-failed message is a no-op', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });
		deps.broadcastMock.mockResolvedValue({ block_num: 1, trx_id: 'trx1' });

		const ctrl = createConversationController(deps);
		await ctrl.sendMessage('hello');
		const snap = ctrl.snapshot();
		expect(snap[0]!.state).toBe('broadcast');

		// Retry should no-op since state !== 'failed'.
		deps.broadcastMock.mockClear();
		await ctrl.retryMessage(snap[0]!.localSeq);
		expect(deps.broadcastMock).not.toHaveBeenCalled();
	});

	// ─── SSE-primary delivery (Phase E.5) ──────────────────────

	it('SSE snapshot lands through subscribeStream and merges', async () => {
		const deps = mockDeps();
		// Without SSE configured, the controller would fall back to
		// polling — we explicitly wire a controllable subscribeStream
		// so we can drive snapshot/append events directly.
		let onSnapshot: ((items: readonly ChatMessageRecord[]) => void) | null = null;
		let onAppend: ((rec: ChatMessageRecord) => void) | null = null;
		const subscribeStream: ChatControllerDeps['subscribeStream'] = (handlers) => {
			onSnapshot = handlers.onSnapshot;
			onAppend = handlers.onAppend;
			return () => {
				onSnapshot = null;
				onAppend = null;
			};
		};
		const ctrl = createConversationController({ ...deps, subscribeStream });
		ctrl.start();
		await vi.runOnlyPendingTimersAsync();

		// SSE snapshot replaces local state.
		onSnapshot!([
			mockRecord({
				id: 1,
				sender: 'bob',
				recipient: 'alice',
				created_at: '2026-04-23T12:00:01.000Z'
			}),
			mockRecord({
				id: 2,
				sender: 'bob',
				recipient: 'alice',
				created_at: '2026-04-23T12:00:02.000Z'
			})
		]);
		// mergePollResponse runs decryptOrPlaceholder which is async;
		// flush microtasks so the merge completes.
		await vi.runOnlyPendingTimersAsync();
		await Promise.resolve();
		await Promise.resolve();
		expect(ctrl.snapshot()).toHaveLength(2);

		// Subsequent message_appended event adds without duplicating
		// (same id would be deduped; new id appends).
		onAppend!(
			mockRecord({
				id: 3,
				sender: 'bob',
				recipient: 'alice',
				created_at: '2026-04-23T12:00:03.000Z'
			})
		);
		await vi.runOnlyPendingTimersAsync();
		await Promise.resolve();
		await Promise.resolve();
		expect(ctrl.snapshot()).toHaveLength(3);

		ctrl.destroy();
	});

	it('SSE wired: initial REST snapshot is skipped (SSE delivers it)', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });
		const subscribeStream: ChatControllerDeps['subscribeStream'] = () => () => undefined;
		const ctrl = createConversationController({ ...deps, subscribeStream });
		ctrl.start();
		// IMPORTANT: don't advance timers here.  The impl's invariant
		// is "no IMMEDIATE REST fetch when SSE is wired."  The 60-second
		// fallback poll IS scheduled for defense-in-depth — it fires
		// only if SSE is silent for that long.  Calling
		// runOnlyPendingTimersAsync() would tick past that boundary
		// and the fallback would fire, defeating this assertion.
		await Promise.resolve();
		await Promise.resolve();

		// With SSE wired, the controller must NOT make the initial
		// REST history call — the SSE snapshot delivers the same
		// data slightly faster.  Bandwidth savings and avoids a
		// redundant round-trip on every conversation open.
		expect(deps.fetchMock).not.toHaveBeenCalled();

		ctrl.destroy();
	});

	it('SSE absent: falls back to polling (initial fetch fires)', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });
		// No subscribeStream configured — controller is in poll-only
		// mode (legacy / no-SSE-browser path).
		const ctrl = createConversationController(deps);
		ctrl.start();
		// Flush microtasks so the immediate pollOnce() resolves;
		// avoid runOnlyPendingTimersAsync() because it can run
		// the freshly-scheduled fallback timer too (depending on
		// Vitest's timer-tracking semantics across the await).
		for (let i = 0; i < 4; i++) await Promise.resolve();

		expect(deps.fetchMock).toHaveBeenCalledTimes(1);

		ctrl.destroy();
	});

	it('fallback poll: SSE-absent path polls at the 60s cadence', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });
		const ctrl = createConversationController(deps);
		ctrl.start();
		for (let i = 0; i < 4; i++) await Promise.resolve();
		expect(deps.fetchMock).toHaveBeenCalledTimes(1);

		// 3.5s — no poll yet (the old visible cadence is gone;
		// fallback runs at 60s + up-to-5s jitter).
		await vi.advanceTimersByTimeAsync(3500);
		expect(deps.fetchMock).toHaveBeenCalledTimes(1);

		// 70s total (well past the 65s upper bound) — fallback fires.
		await vi.advanceTimersByTimeAsync(70_000);
		expect(deps.fetchMock).toHaveBeenCalledTimes(2);

		ctrl.destroy();
	});

	it('destroy cleans up the SSE subscription', async () => {
		const deps = mockDeps();
		let unsubscribed = false;
		const subscribeStream: ChatControllerDeps['subscribeStream'] = () => {
			return () => {
				unsubscribed = true;
			};
		};
		const ctrl = createConversationController({ ...deps, subscribeStream });
		ctrl.start();
		await vi.runOnlyPendingTimersAsync();

		ctrl.destroy();
		expect(unsubscribed).toBe(true);
	});

	// ─── Lifecycle ──────────────────────────────────────────────

	it('destroy cancels pending timers and in-flight requests', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });

		const ctrl = createConversationController(deps);
		ctrl.start();
		for (let i = 0; i < 4; i++) await Promise.resolve();
		expect(deps.fetchMock).toHaveBeenCalledTimes(1);

		ctrl.destroy();

		// Advancing time must NOT trigger more polls.
		await vi.advanceTimersByTimeAsync(60000);
		expect(deps.fetchMock).toHaveBeenCalledTimes(1);
	});

	it('destroy is idempotent', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });

		const ctrl = createConversationController(deps);
		ctrl.start();
		for (let i = 0; i < 4; i++) await Promise.resolve();

		ctrl.destroy();
		ctrl.destroy();
		ctrl.destroy();
		// No throw, no double-clear issues.
	});

	it('start is idempotent', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });

		const ctrl = createConversationController(deps);
		ctrl.start();
		ctrl.start();
		ctrl.start();
		for (let i = 0; i < 4; i++) await Promise.resolve();
		// Only one fetch from the three starts.
		expect(deps.fetchMock).toHaveBeenCalledTimes(1);

		ctrl.destroy();
	});

	// ─── onChange emissions ─────────────────────────────────────

	it('onChange fires on every state mutation', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });
		deps.broadcastMock.mockResolvedValue({ block_num: 1, trx_id: 'trx1' });

		// Capture state-strings at the moment of each emission.
		// emit() returns a shallow copy of the messages array — the
		// message objects themselves are shared references, so by
		// the time the test assertion runs after sendMessage()
		// returns, every captured object reflects the FINAL state
		// (broadcast).  To preserve the per-emission state we have
		// to snapshot the relevant fields synchronously inside the
		// onChange callback, not rely on the array reference.
		const stateAtEmission: string[] = [];
		const dep2 = {
			...deps,
			onChange: (msgs: (typeof deps.emitted)[0]) => {
				deps.emitted.push([...msgs]);
				stateAtEmission.push(msgs[0]?.state ?? 'empty');
			}
		};
		const ctrl = createConversationController(dep2);
		await ctrl.sendMessage('hello');

		// Expected emissions during send:
		//   1. pending (just appended)
		//   2. broadcast (after the chain broadcast succeeded)
		expect(deps.emitted.length).toBe(2);
		expect(stateAtEmission[0]).toBe('pending');
		expect(stateAtEmission[1]).toBe('broadcast');

		ctrl.destroy();
	});
});

describe('chatService — crypto integration', () => {
	it('send fails with peer_not_ready when peer has no published chat pubkey', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });
		// Override fetchPeerChatPub to simulate "peer hasn't published"
		deps.fetchPeerChatPubMock.mockResolvedValue(null);

		const ctrl = createConversationController(deps);
		await ctrl.sendMessage('hello');

		const snap = ctrl.snapshot();
		expect(snap.length).toBe(1);
		expect(snap[0]!.state).toBe('failed');
		expect(snap[0]!.error).toBe('peer_not_ready');
		// Broadcast should NOT have been called — we bailed before.
		expect(deps.broadcastMock).not.toHaveBeenCalled();

		ctrl.destroy();
	});

	it('encrypt is called with trimmed plaintext + peer pub + accounts', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });
		deps.broadcastMock.mockResolvedValue({ block_num: 1, trx_id: 'trx1' });

		const ctrl = createConversationController(deps);
		await ctrl.sendMessage('  hi there  '); // whitespace trimmed

		expect(deps.encryptMock).toHaveBeenCalledTimes(1);
		const [plaintext, pub, sender, recipient] = deps.encryptMock.mock.calls[0]!;
		expect(plaintext).toBe('hi there');
		expect(pub).toBeInstanceOf(Uint8Array);
		expect((pub as Uint8Array).length).toBe(32);
		expect(sender).toBe('alice');
		expect(recipient).toBe('bob');

		ctrl.destroy();
	});

	it('broadcast payload includes ephemeral_pub + nonce in header', async () => {
		const deps = mockDeps();
		deps.fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });
		deps.broadcastMock.mockResolvedValue({ block_num: 1, trx_id: 'trx1' });

		const ctrl = createConversationController(deps);
		await ctrl.sendMessage('hey');

		expect(deps.broadcastMock).toHaveBeenCalledTimes(1);
		const broadcastArgs = deps.broadcastMock.mock.calls[0]!;
		const payload = broadcastArgs[1] as Record<string, unknown>;
		expect(payload.recipient).toBe('bob');
		expect(typeof payload.ciphertext).toBe('string');
		expect((payload.ciphertext as string).length).toBeGreaterThan(0);
		const header = payload.header as Record<string, unknown>;
		expect(typeof header.client_tag).toBe('string');
		expect(typeof header.ephemeral_pub).toBe('string');
		expect(typeof header.nonce).toBe('string');

		ctrl.destroy();
	});

	it('incoming messages are decrypted via deps.decrypt', async () => {
		const deps = mockDeps();
		// The fake encrypt stub produces base64(plaintext) ciphertext,
		// and the fake decrypt stub reverses that. A "received message"
		// fixture with the right shape should decrypt back to its
		// plaintext source.
		const plaintext = 'hello alice';
		const fakeCiphertext = btoa(String.fromCharCode(...new TextEncoder().encode(plaintext)));
		const fakePub = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
		const fakeNonce = btoa(String.fromCharCode(...new Uint8Array(12).fill(3)));

		const incoming = {
			id: 42,
			sender: 'bob',
			recipient: 'alice',
			ciphertext: fakeCiphertext,
			header: { ephemeral_pub: fakePub, nonce: fakeNonce },
			created_at: '2026-04-23T12:00:00.000Z'
		};
		deps.fetchMock.mockResolvedValue({
			ok: true,
			items: [incoming],
			nextCursor: null
		});

		const ctrl = createConversationController(deps);
		ctrl.start();
		// Let the initial pollOnce resolve.
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(deps.decryptMock).toHaveBeenCalledTimes(1);
		const snap = ctrl.snapshot();
		expect(snap.length).toBe(1);
		expect(snap[0]!.text).toBe(plaintext);
		expect(snap[0]!.decryptFailed).toBe(false);

		ctrl.destroy();
	});

	it('incoming messages with decrypt failure show placeholder + decryptFailed=true', async () => {
		const deps = mockDeps();
		deps.decryptMock.mockResolvedValue(null); // force decrypt failure

		const fakePub = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
		const fakeNonce = btoa(String.fromCharCode(...new Uint8Array(12).fill(3)));
		const incoming = {
			id: 42,
			sender: 'bob',
			recipient: 'alice',
			ciphertext: 'garbage',
			header: { ephemeral_pub: fakePub, nonce: fakeNonce },
			created_at: '2026-04-23T12:00:00.000Z'
		};
		deps.fetchMock.mockResolvedValue({
			ok: true,
			items: [incoming],
			nextCursor: null
		});

		const ctrl = createConversationController(deps);
		ctrl.start();
		await new Promise((resolve) => setTimeout(resolve, 0));
		await new Promise((resolve) => setTimeout(resolve, 0));

		const snap = ctrl.snapshot();
		expect(snap.length).toBe(1);
		expect(snap[0]!.text).toBe('(encrypted)');
		expect(snap[0]!.decryptFailed).toBe(true);

		ctrl.destroy();
	});
});
