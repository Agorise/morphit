/**
 * A message the chain never records — on both sides of the conversation.
 *
 * WHY THIS FILE EXISTS. The federation fast path hands a chat message to the
 * recipient's instance BEFORE the sender's broadcast (ADR-0052); that ordering
 * is the whole latency win. So a message can be on the recipient's screen and
 * then be refused or dropped by the chain. Until this file, three things went
 * wrong with that, and none had a test:
 *
 *   1. THE SENDER was never told. The two-minute "not confirmed on the chain"
 *      sweep looked only at messages still in 'broadcast' — but this instance
 *      delivers every accepted chat message to its own listeners, the sender's
 *      included, and that provisional copy moves the bubble to 'confirmed'
 *      first. The sweep therefore almost never fired, and a dropped message sat
 *      in the sender's transcript looking delivered. Forever.
 *
 *   2. THE RECIPIENT could not tell the copy apart from a real message.
 *
 *   3. RETRYING made it worse: the retry carried a fresh tag and nothing that
 *      linked it to the first attempt, so the recipient saw the same words
 *      twice — and in an order discussion the retry went out WITHOUT its
 *      order_permlink, into the wrong thread, where it could never reconcile.
 *
 * These cases drive the real controller with only the network faked.
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
	NOT_CONFIRMED_SENTINEL,
	SESSION_LOCKED_SENTINEL,
	MAX_PRIOR_TAGS,
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
const provisional = (over: Parameters<typeof rec>[0] = {}) =>
	rec({ id: 0, source_trx_id: '', ...over });

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
		getLiveIdentity: () => (opts.locked === true ? null : fakeLive),
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
		// A proved sender (v2): only those drive trade state.
		decrypt: (async (env: { ciphertext: string }) => ({
			text: unb64(env.ciphertext),
			authenticated: true
		})) as unknown as ChatControllerDeps['decrypt'],
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
function sentHeader(r: Rig, n: number): Record<string, unknown> {
	return sent(r, n).header as Record<string, unknown>;
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
	// Module-scoped: one case's sends must not supply another case's text.
	clearOwnSentPlaintextCache();
});
afterEach(() => {
	for (const c of live) c.destroy();
	live = [];
	vi.useRealTimers();
});

// ─────────────────────────────────────────────────────────────────────────────
describe('THE SENDER is told when the chain never records their message', () => {
	/**
	 * THE BUG. The node accepts the message; this instance delivers it to its own
	 * listeners, so the sender's own provisional copy arrives and the bubble goes
	 * 'confirmed'; then the transaction is dropped and no durable copy ever
	 * comes. The sweep ignored 'confirmed', so the sender was never told.
	 */
	it('a send confirmed only by its own provisional copy FAILS once the window passes', async () => {
		const r = rig();
		await r.ctrl.sendMessage('hello');
		await r.deliver([ownCopy(r, 0, { id: 0 })]);
		expect(r.snap()[0]?.state, 'setup: the provisional copy shows it as delivered').toBe(
			'confirmed'
		);

		await elapse(PAST_WINDOW);
		expect(
			r.snap()[0]?.state,
			'a message the chain dropped still looked delivered to the person who sent it'
		).toBe('failed');
		expect(r.snap()[0]?.error).toBe(NOT_CONFIRMED_SENTINEL);
	});

	it('…whichever arrives first, the provisional copy or the node’s answer', async () => {
		// This instance delivers to its own listeners BEFORE it answers the
		// request, so on a fast link the copy usually wins.
		let resolve!: (v: unknown) => void;
		const broadcast = vi.fn(() => new Promise((res) => (resolve = res)));
		const r = rig({ broadcast });
		const sending = r.ctrl.sendMessage('hello');
		await vi.advanceTimersByTimeAsync(0);
		await r.deliver([ownCopy(r, 0, { id: 0 })]);
		resolve({ block_num: null, trx_id: 'a'.repeat(40) });
		await sending;
		expect(r.snap()[0]?.state).toBe('confirmed');

		await elapse(PAST_WINDOW);
		expect(r.snap()[0]?.state).toBe('failed');
	});

	it('…and when the answer was LOST after the node took it', async () => {
		// The provisional copy proves the node took it; the response then died on
		// the wire. Not failed at once — the sender can see it delivered — but
		// still on the clock.
		let reject!: (e: unknown) => void;
		const broadcast = vi.fn(() => new Promise((_res, rej) => (reject = rej)));
		const r = rig({ broadcast });
		const sending = r.ctrl.sendMessage('hello');
		await vi.advanceTimersByTimeAsync(0);
		await r.deliver([ownCopy(r, 0, { id: 0 })]);
		reject(new Error('socket hang up'));
		await sending;
		expect(r.snap()[0]?.state, 'must not fail a message the sender can see').toBe('confirmed');

		await elapse(PAST_WINDOW);
		expect(r.snap()[0]?.state, 'but it must not be exempt from the window either').toBe('failed');
	});

	it('a send whose durable copy lands inside the window is never failed', async () => {
		const r = rig();
		await r.ctrl.sendMessage('hello');
		await r.deliver([ownCopy(r, 0, { id: 0 })]);
		await elapse(60_000);
		await r.deliver([ownCopy(r, 0, { id: 42 })]);
		await elapse(PAST_WINDOW * 2);
		expect(r.snap()[0]?.state).toBe('confirmed');
		expect(r.snap()[0]?.id).toBe(42);
	});

	it('is not failed a moment too early: the window covers expiry plus irreversibility', async () => {
		// 60 s to expiry + up to 63 s to irreversibility. A window shorter than
		// that prompts a resend of a message that is still on its way.
		expect(NEVER_RECORDED_AFTER_MS).toBeGreaterThanOrEqual(60_000 + 63_000);
		const r = rig();
		await r.ctrl.sendMessage('hello');
		await r.deliver([ownCopy(r, 0, { id: 0 })]);
		await elapse(60_000 + 63_000);
		expect(r.snap()[0]?.state).toBe('confirmed');
	});

	it('a late durable copy clears the failure', async () => {
		const r = rig();
		await r.ctrl.sendMessage('hello');
		await r.deliver([ownCopy(r, 0, { id: 0 })]);
		await elapse(PAST_WINDOW);
		expect(r.snap()[0]?.state).toBe('failed');
		await r.deliver([ownCopy(r, 0, { id: 42 })]);
		expect(r.snap()[0]?.state).toBe('confirmed');
		expect(r.snap()[0]?.error).toBeNull();
	});

	it('a locked session is reported by sentinel, not by English prose', async () => {
		const r = rig({ locked: true });
		await r.ctrl.sendMessage('hello');
		expect(r.snap()[0]?.error).toBe(SESSION_LOCKED_SENTINEL);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe('a RETRY is the same message, on the wire and on both screens', () => {
	it('names the attempt it replaces in prior_tags', async () => {
		const r = rig();
		await r.ctrl.sendMessage('hello');
		await r.deliver([ownCopy(r, 0, { id: 0 })]);
		await elapse(PAST_WINDOW);
		await r.ctrl.retryMessage(r.snap()[0]!.localSeq);

		expect(sentHeader(r, 1).client_tag, 'a retry still gets a fresh tag').toBe(T2);
		expect(sentHeader(r, 1).prior_tags).toEqual([T1]);
		expect(sentHeader(r, 0).prior_tags, 'a first send declares nothing').toBeUndefined();
	});

	/**
	 * The retry payload was a second hand-written literal, and it had lost
	 * `order_permlink`. In an order discussion a retry went out as a direct
	 * message: wrong thread on both sides, the stranger fee the order waives,
	 * and a durable copy this conversation filters out — so it never reconciled
	 * and was failed again. Retrying could not work.
	 */
	it('keeps the order it is about', async () => {
		const r = rig({ orderPermlink: 'order-1' });
		await r.ctrl.sendMessage('hello');
		expect(sent(r, 0).order_permlink, 'setup: the first send carries it').toBe('order-1');
		await r.deliver([ownCopy(r, 0, { id: 0 })]);
		await elapse(PAST_WINDOW);
		await r.ctrl.retryMessage(r.snap()[0]!.localSeq);
		expect(
			sent(r, 1).order_permlink,
			'the retry went out as a direct message, outside the order it was about'
		).toBe('order-1');
	});

	it('…and so the retried message in an order thread can actually confirm', async () => {
		const r = rig({ orderPermlink: 'order-1' });
		await r.ctrl.sendMessage('hello');
		await r.deliver([ownCopy(r, 0, { id: 0 })]);
		await elapse(PAST_WINDOW);
		await r.ctrl.retryMessage(r.snap()[0]!.localSeq);
		await r.deliver([ownCopy(r, 1, { id: 43 })]);
		expect(r.snap()).toHaveLength(1);
		expect(r.snap()[0]?.state).toBe('confirmed');
		expect(r.snap()[0]?.id).toBe(43);
	});

	it('declares at most MAX_PRIOR_TAGS, however often Retry is pressed', async () => {
		const reject = vi.fn(async () => {
			throw new Error('rejected');
		});
		const r = rig({
			broadcast: reject,
			tags: Array.from({ length: 20 }, (_, i) => tag(i + 1))
		});
		await r.ctrl.sendMessage('hello');
		for (let i = 0; i < 15; i++) await r.ctrl.retryMessage(r.snap()[0]!.localSeq);
		const calls = reject.mock.calls as unknown as unknown[][];
		const last = calls.at(-1)![1] as { header: { prior_tags: string[] } };
		expect(last.header.prior_tags.length).toBe(MAX_PRIOR_TAGS);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe('THE RECIPIENT is shown which messages the chain never recorded', () => {
	it('a provisional copy with no durable twin is marked unrecorded once the window passes', async () => {
		const r = rig();
		await r.deliver([provisional()]);
		await elapse(NEVER_RECORDED_AFTER_MS - 10_000);
		expect(r.snap()[0]?.unrecorded, 'too early to say').not.toBe(true);
		await elapse(20_000);
		expect(
			r.snap()[0]?.unrecorded,
			'a message the chain never recorded looked exactly like one it did'
		).toBe(true);
		expect(r.snap(), 'marked, never removed — the recipient has read it').toHaveLength(1);
	});

	it('a durable copy arriving after the mark clears it', async () => {
		const r = rig();
		await r.deliver([provisional()]);
		await elapse(PAST_WINDOW);
		await r.deliver([rec({ id: 42 })]);
		expect(r.snap()).toHaveLength(1);
		expect(r.snap()[0]?.unrecorded).toBe(false);
		expect(r.snap()[0]?.id).toBe(42);
	});

	it('a message loaded durable is never marked', async () => {
		const r = rig();
		await r.deliver([rec({ id: 42 })]);
		await elapse(PAST_WINDOW * 2);
		expect(r.snap()[0]?.unrecorded).not.toBe(true);
	});

	/** The window runs on THIS device's clock. `created_at` comes from elsewhere,
	 *  and a skewed clock here would otherwise mark every fresh message. */
	it('the window starts when the copy ARRIVES, not at its created_at', async () => {
		const r = rig();
		await r.deliver([provisional({ created_at: '2026-04-23T11:00:00.000Z' })]); // an hour "old"
		await elapse(20_000);
		expect(r.snap()[0]?.unrecorded).not.toBe(true);
	});

	/** Our own messages from another session come back provisional too. Every
	 *  provisional carries id 0, and a 0 stored as an id entered the seen-ids
	 *  set — so each LATER provisional from that session was silently dropped
	 *  until its durable copy came, a minute on. */
	it('several provisional messages from our other session all appear at once', async () => {
		const r = rig({ tags: [] });
		// Separately, as they arrive in life: the seen-ids set is rebuilt per
		// merge, so a single batch would hide the drop.
		await r.deliver([provisional({ sender: 'alice', recipient: 'bob', tag: T1, text: 'one' })]);
		await r.deliver([provisional({ sender: 'alice', recipient: 'bob', tag: T2, text: 'two' })]);
		expect(r.snap().map((m) => m.clientTag)).toEqual([T1, T2]);
		expect(r.snap().every((m) => m.id === null)).toBe(true);
	});

	it('…and one of those that is never recorded is marked too', async () => {
		const r = rig({ tags: [] });
		await r.deliver([provisional({ sender: 'alice', recipient: 'bob', tag: T1 })]);
		await elapse(PAST_WINDOW);
		expect(r.snap()[0]?.unrecorded).toBe(true);
		expect(r.snap()[0]?.state, 'not ours to retry from here').toBe('confirmed');
	});
});

// ─────────────────────────────────────────────────────────────────────────────
describe('the recipient folds a retry into the attempt it resends', () => {
	it('first attempt never recorded, retry lands: ONE message', async () => {
		const r = rig();
		await r.deliver([provisional({ tag: T1 })]);
		await elapse(PAST_WINDOW);
		await r.deliver([provisional({ tag: T2, prior: [T1] })]);
		await r.deliver([rec({ id: 42, tag: T2, prior: [T1] })]);
		expect(r.snap(), 'the recipient saw the same words twice').toHaveLength(1);
		expect(r.snap()[0]?.id).toBe(42);
		expect(r.snap()[0]?.unrecorded).toBe(false);
	});

	it('a fresh provisional retry restarts the window rather than inheriting the verdict', async () => {
		const r = rig();
		await r.deliver([provisional({ tag: T1 })]);
		await elapse(PAST_WINDOW);
		await r.deliver([provisional({ tag: T2, prior: [T1] })]);
		expect(r.snap()[0]?.unrecorded).toBe(false);
		await elapse(PAST_WINDOW);
		expect(r.snap()[0]?.unrecorded, 'and a retry that also fails is marked again').toBe(true);
	});

	it('the retry arriving FIRST still absorbs the late original', async () => {
		const r = rig();
		await r.deliver([rec({ id: 42, tag: T2, prior: [T1] })]);
		await r.deliver([provisional({ tag: T1 })]);
		expect(r.snap()).toHaveLength(1);
		expect(r.snap()[0]?.id).toBe(42);
	});

	/** The side effects ran for the first copy. A second run records the same
	 *  payment claim against the order twice. */
	it('a retried funds-sent claim is recorded once', async () => {
		const fundsSent = JSON.stringify({
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'blurt',
			txid: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
			amount: '10.000',
			order_permlink: 'order-1'
		});
		const r = rig();
		await r.deliver([provisional({ tag: T1, text: fundsSent })]);
		await elapse(PAST_WINDOW);
		await r.deliver([rec({ id: 42, tag: T2, prior: [T1], text: fundsSent })]);
		expect(recordFundsSent.mock.calls.length).toBe(1);
		expect(triggerBlurtVerification.mock.calls.length).toBe(1);
	});

	/**
	 * THE LINK NEEDS BOTH HALVES. A tag link alone would let a sender send
	 * something NEW that names an old message's tag, and have the new words
	 * vanish into the old bubble — in the live view only, so the two parties'
	 * screens and the chain would all disagree.
	 */
	it('a "retry" with DIFFERENT words is shown, not absorbed', async () => {
		const r = rig();
		await r.deliver([provisional({ tag: T1, text: 'I will pay tomorrow' })]);
		await r.deliver([rec({ id: 42, tag: T2, prior: [T1], text: 'I never agreed to that' })]);
		expect(r.snap().map((m) => m.text)).toEqual(['I will pay tomorrow', 'I never agreed to that']);
	});

	it('…nor a late original whose words differ from the retry that named it', async () => {
		const r = rig();
		await r.deliver([rec({ id: 42, tag: T2, prior: [T1], text: 'one thing' })]);
		await r.deliver([provisional({ tag: T1, text: 'another thing' })]);
		expect(r.snap()).toHaveLength(2);
	});

	it('the same words sent twice WITHOUT a tag link are two messages', async () => {
		const r = rig();
		await r.deliver([rec({ id: 41, tag: T1, text: 'ok' })]);
		await r.deliver([rec({ id: 42, tag: T2, text: 'ok' })]);
		expect(r.snap()).toHaveLength(2);
	});

	it('only the same sender can link: a peer cannot absorb a third party’s — or our — words', async () => {
		const r = rig({ tags: [T1] });
		await r.ctrl.sendMessage('hello'); // ours, tag T1
		await r.deliver([rec({ id: 42, tag: T2, prior: [T1], text: 'hello' })]); // bob names it
		expect(r.snap()).toHaveLength(2);
		expect(new Set(r.snap().map((m) => m.sender))).toEqual(new Set(['alice', 'bob']));
	});

	/**
	 * A tag is chosen by whoever signs. Once a retry can NAME tags, a peer could
	 * name one of OURS — and our own durable copy, arriving from another session,
	 * used to be reconciled against any message holding that tag, the peer's
	 * included, and vanish.
	 */
	it('a peer naming one of our tags cannot swallow our own message', async () => {
		const r = rig({ tags: [] });
		await r.deliver([rec({ id: 41, tag: T2, prior: [T1], text: 'bait' })]);
		await r.deliver([rec({ id: 42, sender: 'alice', recipient: 'bob', tag: T1 })]);
		expect(r.snap().filter((m) => m.sender === 'alice')).toHaveLength(1);
	});

	/** A locked session renders every message as the same placeholder with
	 *  decryptFailed false. Identical placeholders are not identical words. */
	it('two unreadable messages are never linked', async () => {
		const r = rig({ locked: true });
		await r.deliver([provisional({ tag: T1, text: 'a' })]);
		await r.deliver([rec({ id: 42, tag: T2, prior: [T1], text: 'b' })]);
		expect(r.snap()).toHaveLength(2);
	});

	it('a malformed prior_tags is ignored, not half-honoured', async () => {
		for (const bad of [
			'not-an-array',
			[T1, 'zz'],
			Array.from({ length: MAX_PRIOR_TAGS + 1 }, (_, i) => tag(i + 10)).concat([T1])
		]) {
			const r = rig();
			await r.deliver([provisional({ tag: T1 })]);
			await r.deliver([rec({ id: 42, tag: T2, prior: bad })]);
			expect(r.snap(), `prior_tags = ${JSON.stringify(bad).slice(0, 40)}`).toHaveLength(2);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
/**
 * v1.18.0 review (W3). The window assumes our indexer keeps up. When it is
 * catching up — hidden-only RPC, a restart — a message that DID land has no
 * durable copy yet, the sweep called it failed, and the Retry it offered put a
 * SECOND copy on chain. The controller now asks the chain first.
 */
describe('the chain is asked before a send is called failed', () => {
	it('a send the chain HAS is not failed just because our indexer is behind', async () => {
		const onChain = vi.fn(async () => 'found' as const);
		const r = rig({ onChain });
		await r.ctrl.sendMessage('hello');
		await r.deliver([ownCopy(r, 0, { id: 0 })]);
		await elapse(PAST_WINDOW);
		expect(onChain, 'the chain was never asked').toHaveBeenCalledWith('a'.repeat(40));
		expect(
			r.snap()[0]?.state,
			'a message on chain was called failed — and Retry would put a second copy there'
		).toBe('confirmed');
	});

	it('a send the chain does NOT have still fails, with Retry', async () => {
		const r = rig({ onChain: vi.fn(async () => 'not_found' as const) });
		await r.ctrl.sendMessage('hello');
		await r.deliver([ownCopy(r, 0, { id: 0 })]);
		await elapse(PAST_WINDOW);
		expect(r.snap()[0]?.state).toBe('failed');
		expect(r.snap()[0]?.error).toBe(NOT_CONFIRMED_SENTINEL);
	});

	it('and a question that cannot be answered fails it exactly as before', async () => {
		const r = rig({ onChain: vi.fn(async () => 'unknown' as const) });
		await r.ctrl.sendMessage('hello');
		await r.deliver([ownCopy(r, 0, { id: 0 })]);
		await elapse(PAST_WINDOW);
		expect(r.snap()[0]?.state).toBe('failed');
	});
});

/**
 * v1.18.0 review (W2). The "not confirmed on chain" state lived only inside one
 * conversation view. Sending and then leaving is the ordinary pattern, and the
 * next view rebuilt the message from the indexer: a fresh clock (no Retry)
 * within five minutes, nothing at all after that — a dropped send vanished,
 * silently, exactly when its sender was not looking.
 */
describe('an unconfirmed send survives leaving the chat', () => {
	it('a send the chain dropped is still reported after leaving and coming back', async () => {
		const first = rig();
		await first.ctrl.sendMessage('hello');
		first.ctrl.destroy();

		// Back after 100 s. The window is 150 s from the SEND, so 60 s more is
		// past it — while a clock restarted on return would still be waiting.
		await elapse(100_000);
		const again = rig();
		expect(
			again.snap().map((m) => m.text),
			'the message the sender wrote vanished from their view when they came back'
		).toEqual(['hello']);
		await elapse(60_000);
		expect(again.snap()[0]?.state, 'and its clock was not restarted: it still fails').toBe(
			'failed'
		);
		expect(again.snap()[0]?.error).toBe(NOT_CONFIRMED_SENTINEL);
	});

	it('once the chain has it, nothing is restored', async () => {
		const first = rig();
		await first.ctrl.sendMessage('hello');
		await first.deliver([ownCopy(first, 0, { id: 7 })]);
		first.ctrl.destroy();
		const again = rig();
		expect(again.snap(), 'a delivered message was resurrected as unconfirmed').toEqual([]);
	});

	it('a copy the indexer still has reconciles with the restored message, not beside it', async () => {
		const first = rig();
		await first.ctrl.sendMessage('hello');
		const copy = ownCopy(first, 0, { id: 0 });
		first.ctrl.destroy();
		const again = rig();
		await again.deliver([copy]);
		expect(again.snap()).toHaveLength(1);
	});

	it('destroy mode keeps nothing past the chat, as it promises', async () => {
		const first = rig({ mode: 'destroy' });
		await first.ctrl.sendMessage('hello');
		first.ctrl.destroy();
		expect(rig({ mode: 'destroy' }).snap()).toEqual([]);
	});

	it('and locking clears it, like every other plaintext held in memory', async () => {
		const first = rig();
		await first.ctrl.sendMessage('hello');
		first.ctrl.destroy();
		clearOwnSentPlaintextCache();
		expect(rig().snap()).toEqual([]);
	});
});
