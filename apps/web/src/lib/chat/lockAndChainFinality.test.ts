/**
 * v1.18.0 deep-deep — M3, L1, L2: what a conversation does when the session
 * locks, when the chain has a message the indexers refused, and what comes back
 * when a thread is reopened.
 *
 *   M3. The idle auto-lock emptied the W2 map, but a mounted conversation kept
 *       the whole decrypted transcript on screen, and its sweep or a send still
 *       in flight wrote the words straight back — so a LOCKED view then showed
 *       our own sends in plain text beside "(encrypted)" incoming messages.
 *   L1. W3 read "on chain" as "will be recorded" and re-armed forever: a send
 *       the indexers refused (blocked, stranger fee, order gone) said
 *       "confirmed" for good while the recipient never got it.
 *   L2. W2 put back a send whose durable copy had landed while no view was
 *       open — then failed it and offered a Retry that put a second copy on
 *       chain.
 *
 * These drive the real controller with only the network faked.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const recordAddressShared = vi.fn();
const recordFundsSent = vi.fn();
const triggerBlurtVerification = vi.fn();

vi.mock('$lib/trades/tradeStatus', () => ({
	recordAddressShared: (...a: unknown[]) => recordAddressShared(...a),
	recordFundsSent: (...a: unknown[]) => recordFundsSent(...a)
}));
vi.mock('$lib/trades/tradeVerify', () => ({
	triggerBlurtVerification: (...a: unknown[]) => triggerBlurtVerification(...a)
}));

import {
	createConversationController,
	NEVER_RECORDED_AFTER_MS,
	ON_CHAIN_NOT_ACCEPTED_SENTINEL,
	clearOwnSentPlaintextCache,
	type ChatControllerDeps,
	type ChatController,
	type LocalMessage
} from './chatService';
import type { ChatMessageRecord } from '@morphit/indexer-client';
import type { LiveIdentity } from '$crypto/keygen';

const fakeLive = {} as unknown as LiveIdentity;
const fakePub = new Uint8Array(32).fill(7);
const fakePriv = new Uint8Array(32).fill(9);

// Real-shaped tags: 16 bytes of hex. `prior_tags` validation rejects anything
// else, so a test using a toy tag would be testing the rejection by accident.
const tag = (n: number): string => n.toString(16).padStart(32, '0');
const T1 = tag(1);
const T2 = tag(2);
const T3 = tag(3);

/** The session, as the controller sees it: `lockNow()` is what the idle
 *  auto-lock does — the live identity goes away and identity.ts runs the chat
 *  lock hook (clearOwnSentPlaintextCache). */
const session = { locked: false };
function lockNow(): void {
	session.locked = true;
	clearOwnSentPlaintextCache();
}

function b64(s: string): string {
	return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}
function unb64(s: string): string {
	return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));
}

/** A record as the indexer serves it. Ciphertext is the plaintext in base64:
 *  the fake crypto below makes "decrypt" the identity. */
function rec(
	over: Partial<ChatMessageRecord> & { text?: string; tag?: string; prior?: unknown } = {}
): ChatMessageRecord {
	const { text, tag: t, prior, ...rest } = over;
	return {
		id: 1,
		sender: 'bob',
		recipient: 'alice',
		ciphertext: b64(text ?? 'hello'),
		header: {
			client_tag: t ?? T1,
			ephemeral_pub: b64('e'),
			nonce: b64('n'),
			...(prior !== undefined ? { prior_tags: prior } : {})
		},
		created_at: '2026-04-23T12:00:00.000Z',
		source_trx_id: 'f'.repeat(40),
		order_permlink: null,
		...rest
	} as ChatMessageRecord;
}
interface Rig {
	ctrl: ChatController;
	deliver(items: ChatMessageRecord[]): Promise<void>;
	broadcast: ReturnType<typeof vi.fn>;
	snap(): readonly LocalMessage[];
}

/**
 * A controller whose network is a queue the test fills. Records reach it the
 * way SSE delivers them in production — through `subscribeStream` — so a test
 * decides exactly when each copy arrives.
 */
function rig(
	opts: {
		orderPermlink?: string | null;
		tags?: string[];
		locked?: boolean;
		broadcast?: ReturnType<typeof vi.fn>;
		onChain?: ReturnType<typeof vi.fn>;
		mode?: 'keep' | 'destroy';
		decrypt?: (env: { ciphertext: string }) => Promise<string | null>;
		fetchHistory?: () => Promise<unknown>;
	} = {}
): Rig {
	const tags = [...(opts.tags ?? [T1, T2, T3])];
	let onAppend: ((r: ChatMessageRecord) => void) | null = null;
	const broadcast =
		opts.broadcast ?? vi.fn(async () => ({ block_num: null, trx_id: 'a'.repeat(40) }));
	const deps: ChatControllerDeps = {
		me: 'alice',
		peer: 'bob',
		orderPermlink: opts.orderPermlink ?? null,
		getLiveIdentity: () => (opts.locked === true || session.locked ? null : fakeLive),
		now: () => new Date(),
		visibilityState: () => 'visible',
		onVisibilityChange: () => () => undefined,
		generateClientTag: () => tags.shift() ?? tag(99),
		fetchHistory: (async () => ({
			ok: true,
			items: [],
			nextCursor: null
		})) as unknown as ChatControllerDeps['fetchHistory'],
		broadcast: broadcast as unknown as ChatControllerDeps['broadcast'],
		fetchPeerChatPub: (async () => fakePub) as unknown as ChatControllerDeps['fetchPeerChatPub'],
		deriveMyChatIdentity: async () => ({ priv: fakePriv, pub: fakePub }),
		encrypt: (async (p: string) => ({
			ciphertext: b64(p),
			ephemeralPub: b64('e'),
			nonce: b64('n')
		})) as unknown as ChatControllerDeps['encrypt'],
		decrypt: (opts.decrypt ??
			(async (env: { ciphertext: string }) =>
				unb64(env.ciphertext))) as unknown as ChatControllerDeps['decrypt'],
		...(opts.fetchHistory !== undefined
			? { fetchHistory: opts.fetchHistory as unknown as ChatControllerDeps['fetchHistory'] }
			: {}),
		onChange: () => undefined,
		subscribeStream: (h) => {
			onAppend = h.onAppend;
			return () => undefined;
		},
		...(opts.onChain !== undefined
			? { transactionOnChain: opts.onChain as unknown as ChatControllerDeps['transactionOnChain'] }
			: {}),
		...(opts.mode !== undefined ? { chatSecurityMode: () => opts.mode! } : {})
	};
	const ctrl = createConversationController(deps);
	live.push(ctrl);
	ctrl.start();
	return {
		ctrl,
		broadcast,
		snap: () => ctrl.snapshot(),
		async deliver(items) {
			for (const r of items) onAppend?.(r);
			// mergePollResponse is async (decrypt); let it settle.
			await vi.advanceTimersByTimeAsync(0);
		}
	};
}

/** Let `ms` of wall time pass, with every fallback poll and sweep in it. */
const elapse = (ms: number) => vi.advanceTimersByTimeAsync(ms);
/** Past the window by more than one poll interval, so a sweep has run. */
const PAST_WINDOW = NEVER_RECORDED_AFTER_MS + 10_000;

/** The payload handed to the node on the n-th broadcast (0-based). */
function sent(r: Rig, n: number): Record<string, unknown> {
	return r.broadcast.mock.calls[n]![1] as Record<string, unknown>;
}
/** Our own message coming back, as the sender's own instance delivers it. */
function ownCopy(r: Rig, n: number, over: Parameters<typeof rec>[0] = {}): ChatMessageRecord {
	const p = sent(r, n);
	return rec({
		sender: 'alice',
		recipient: 'bob',
		ciphertext: p.ciphertext as string,
		header: p.header as Record<string, unknown>,
		order_permlink: (p.order_permlink as string | undefined) ?? null,
		...over
	});
}

let live: ChatController[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-04-23T12:00:00Z'));
	recordAddressShared.mockClear();
	recordFundsSent.mockClear();
	triggerBlurtVerification.mockClear();
	session.locked = false;
	// Module-scoped: one case's sends must not supply another case's text.
	clearOwnSentPlaintextCache();
});
afterEach(() => {
	for (const c of live) c.destroy();
	live = [];
	vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────

const texts = (r: Rig): string[] => r.snap().map((m) => m.text);

describe('M3 — a lock while a conversation is open', () => {
	it('the open view stops showing the decrypted transcript', async () => {
		const r = rig();
		await r.deliver([rec({ id: 7, text: 'peer secret' })]);
		await r.ctrl.sendMessage('my secret');
		expect(texts(r)).toEqual(['peer secret', 'my secret']);

		lockNow();

		expect(texts(r).filter((t) => t.includes('secret'))).toEqual([]);
	});

	it('P1: a send still in flight when the lock lands does not put its words back', async () => {
		let resolve!: (v: unknown) => void;
		const broadcast = vi.fn(() => new Promise((res) => (resolve = res)));
		const first = rig({ broadcast });
		const p = first.ctrl.sendMessage('secret words');
		await elapse(0);
		lockNow();
		resolve({ block_num: null, trx_id: 'a'.repeat(40) });
		await p;
		expect(texts(first)).not.toContain('secret words');
		first.ctrl.destroy();

		const lockedView = rig();
		expect(texts(lockedView)).not.toContain('secret words');
		// …nor after unlocking: the words were never kept once the lock landed.
		lockedView.ctrl.destroy();
		session.locked = false;
		const unlockedView = rig();
		expect(texts(unlockedView)).not.toContain('secret words');
	});

	it('P2: the sweep hearing "on chain" after the lock does not put the words back', async () => {
		const onChain = vi.fn(async () => 'found' as const);
		const first = rig({ onChain });
		await first.ctrl.sendMessage('secret two');
		await first.deliver([ownCopy(first, 0, { id: 0 })]);
		lockNow();
		// The provisional copy comes back while locked, and the sweep asks.
		await first.deliver([ownCopy(first, 0, { id: 0 })]);
		await elapse(PAST_WINDOW);
		expect(texts(first)).not.toContain('secret two');

		const lockedView = rig({ onChain });
		expect(texts(lockedView)).not.toContain('secret two');
	});

	it('a merge still decrypting when the lock lands adds nothing', async () => {
		let release!: () => void;
		const gate = new Promise<void>((res) => (release = res));
		const decrypt = vi.fn(async (env: { ciphertext: string }) => {
			await gate;
			return unb64(env.ciphertext);
		});
		const r = rig({ decrypt });
		const delivering = r.deliver([rec({ id: 9, text: 'late secret' })]);
		lockNow();
		release();
		await delivering;
		await elapse(0);
		expect(texts(r)).not.toContain('late secret');
	});
});

describe('L1 — on the chain, but the indexers never record it', () => {
	it('after one further window it is final — no Retry, not "confirmed" forever', async () => {
		const onChain = vi.fn(async () => 'found' as const);
		const r = rig({ onChain });
		await r.ctrl.sendMessage('hello');
		await r.deliver([ownCopy(r, 0, { id: 0 })]);
		await elapse(60 * 60_000);
		const m = r.snap()[0]!;
		expect(m.state).toBe('failed');
		expect(m.error).toBe(ON_CHAIN_NOT_ACCEPTED_SENTINEL);
		// Asked twice (found, then found again a window later) — not every sweep.
		expect(onChain.mock.calls.length).toBe(2);

		// Retry is refused: a resend would be refused the same way, on chain twice.
		await r.ctrl.retryMessage(m.localSeq);
		expect(r.broadcast).toHaveBeenCalledTimes(1);
		expect(r.snap()[0]!.error).toBe(ON_CHAIN_NOT_ACCEPTED_SENTINEL);
	});

	it('a durable copy arriving in that further window still confirms it', async () => {
		const onChain = vi.fn(async () => 'found' as const);
		const r = rig({ onChain });
		await r.ctrl.sendMessage('hello');
		await r.deliver([ownCopy(r, 0, { id: 0 })]);
		await elapse(PAST_WINDOW); // first "found": one more window
		await r.deliver([ownCopy(r, 0, { id: 55 })]);
		await elapse(60 * 60_000);
		expect(r.snap()[0]!.state).toBe('confirmed');
		expect(r.snap()[0]!.id).toBe(55);
	});

	it('the "found" re-arm survives leaving and reopening the chat (no fresh pair of windows)', async () => {
		const onChain = vi.fn(async () => 'found' as const);
		const first = rig({ onChain });
		await first.ctrl.sendMessage('hello');
		await elapse(PAST_WINDOW); // found once, re-armed
		expect(onChain).toHaveBeenCalledTimes(1);
		first.ctrl.destroy();
		const again = rig({ onChain });
		await elapse(PAST_WINDOW);
		expect(again.snap()[0]!.error).toBe(ON_CHAIN_NOT_ACCEPTED_SENTINEL);
	});
});

describe('L2 — what comes back when a thread is reopened', () => {
	it('a send whose durable copy was seen (in any thread with this peer) is not put back', async () => {
		const first = rig({ orderPermlink: 'order-a' });
		await first.ctrl.sendMessage('about order a');
		const durable = ownCopy(first, 0, { id: 77 });
		first.ctrl.destroy();

		// Another thread with the same peer sees the durable copy go by.
		const other = rig({ orderPermlink: null });
		await other.deliver([durable]);
		other.ctrl.destroy();

		const reopened = rig({ orderPermlink: 'order-a' });
		expect(texts(reopened)).not.toContain('about order a');
	});

	it('an unconfirmed send well past the window plus margin is not put back', async () => {
		const first = rig();
		await first.ctrl.sendMessage('long ago');
		first.ctrl.destroy();
		// Past the window plus a generous margin (RESTORE_UNCONFIRMED_MAX_AGE_MS).
		vi.setSystemTime(Date.now() + NEVER_RECORDED_AFTER_MS + 5 * 60_000);
		const reopened = rig();
		expect(texts(reopened)).not.toContain('long ago');
	});

	it('a recent one still is (W2 unchanged)', async () => {
		const first = rig();
		await first.ctrl.sendMessage('just now');
		first.ctrl.destroy();
		vi.setSystemTime(Date.now() + 30_000);
		const reopened = rig();
		expect(texts(reopened)).toContain('just now');
	});
});
