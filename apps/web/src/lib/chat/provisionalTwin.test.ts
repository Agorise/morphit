/**
 * A fast-path copy meeting its durable twin.
 *
 * WHY THIS MATTERS MORE SINCE v1.18.0. Before the federation fast path, an
 * incoming chat message arrived from a BLOCK — already on chain, merely not yet
 * irreversible. Now the common case is that it arrives from a PEER first, with
 * `id: 0` marking it provisional, and the durable copy follows up to a minute
 * later when the message goes irreversible. Every incoming message in an active
 * conversation therefore travels this path twice, and the collapse between the
 * two copies went from an edge case to the normal one — while having no test at
 * all.
 *
 * TWO PROPERTIES, and the second is the one with teeth.
 *
 * The first is that the copies collapse: one message in the transcript, not two,
 * whichever arrives first. A duplicate here would show on every message of every
 * conversation.
 *
 * The second is that the SIDE EFFECTS run exactly once. A Morphit chat message
 * is not only text: a recognised payload records a shared payment address or a
 * funds-sent claim into the trade store, and a funds-sent claim also fires an
 * on-chain verification. Running those again when the durable twin lands would
 * double-record a payment claim against an order — which is a marketplace
 * problem, not a rendering one. The code guards it with an early `continue` and
 * a comment; until now nothing held it there.
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

import { createConversationController, type ChatControllerDeps } from './chatService';
import type { ChatMessageRecord } from '@morphit/indexer-client';
import type { LiveIdentity } from '$crypto/keygen';

const fakeLive = {} as unknown as LiveIdentity;
const fakePub = new Uint8Array(32).fill(7);
const fakePriv = new Uint8Array(32).fill(9);

/** The tag the sender put on the op; both copies of a message carry it. */
const TAG = 'a'.repeat(32);

function b64(s: string): string {
	return btoa(String.fromCharCode(...new TextEncoder().encode(s)));
}

function record(over: Partial<ChatMessageRecord> & { text?: string } = {}): ChatMessageRecord {
	const { text, ...rest } = over;
	return {
		id: 1,
		sender: 'bob',
		recipient: 'alice',
		ciphertext: b64(text ?? 'hello'),
		// `ephemeral_pub` and `nonce` are what mark a record as decryptable;
		// without them the controller renders the placeholder and never reaches
		// the payload decode this file is about.
		header: { client_tag: TAG, ephemeral_pub: b64('e'), nonce: b64('n') },
		created_at: '2026-04-23T12:00:00.000Z',
		...rest
	} as ChatMessageRecord;
}

/** The provisional copy: `id: 0` is the marker a peer push (or a head-block
 *  read) carries, and it is the ONLY thing distinguishing it from a durable
 *  row. */
function provisional(over: Partial<ChatMessageRecord> & { text?: string } = {}): ChatMessageRecord {
	return record({ id: 0, ...over });
}

function makeDeps(fetchMock: ReturnType<typeof vi.fn>): ChatControllerDeps {
	return {
		me: 'alice',
		peer: 'bob',
		orderPermlink: null,
		getLiveIdentity: () => fakeLive,
		now: () => new Date('2026-04-23T12:00:00Z'),
		visibilityState: () => 'visible',
		onVisibilityChange: () => () => undefined,
		generateClientTag: () => TAG,
		fetchHistory: fetchMock as unknown as ChatControllerDeps['fetchHistory'],
		broadcast: (async () => ({ block_num: 1, trx_id: 'x' })) as ChatControllerDeps['broadcast'],
		fetchPeerChatPub: (async () => fakePub) as unknown as ChatControllerDeps['fetchPeerChatPub'],
		deriveMyChatIdentity: async () => ({ priv: fakePriv, pub: fakePub }),
		encrypt: (async (p: string) => ({
			ciphertext: b64(p),
			ephemeralPub: b64('e'),
			nonce: b64('n')
		})) as unknown as ChatControllerDeps['encrypt'],
		// A proved sender (v2): only those drive trade state.
		decrypt: (async (env: { ciphertext: string }) => ({
			text: new TextDecoder().decode(Uint8Array.from(atob(env.ciphertext), (c) => c.charCodeAt(0))),
			authenticated: true
		})) as unknown as ChatControllerDeps['decrypt'],
		onChange: () => undefined
	};
}

beforeEach(() => {
	vi.useFakeTimers();
	recordAddressShared.mockClear();
	recordFundsSent.mockClear();
	triggerBlurtVerification.mockClear();
});

let live: { destroy(): void }[] = [];
afterEach(() => {
	for (const c of live) c.destroy();
	live = [];
	vi.useRealTimers();
});

/**
 * Deliver each batch as its own poll, so the copies arrive as they do in
 * production: separately, and in the order the test chose.
 */
async function drive(batches: ChatMessageRecord[][]) {
	const fetchMock = vi.fn();
	for (const items of batches) {
		fetchMock.mockResolvedValueOnce({ ok: true, items, nextCursor: null });
	}
	fetchMock.mockResolvedValue({ ok: true, items: [], nextCursor: null });

	const ctrl = createConversationController(makeDeps(fetchMock));
	live.push(ctrl as unknown as { destroy(): void });
	ctrl.start();
	// One pending-timer pass per batch: the first drains the initial load, each
	// further pass drains one fallback poll.
	for (let i = 0; i < batches.length; i++) await vi.runOnlyPendingTimersAsync();
	return { final: ctrl.snapshot() };
}

describe('a provisional copy and its durable twin collapse into one message', () => {
	it('provisional first, then durable: one message, durable id adopted', async () => {
		const { final } = await drive([[provisional()], [record({ id: 42 })]]);
		expect(final).toHaveLength(1);
		expect(final[0]?.id, 'the durable id replaces the provisional null').toBe(42);
		expect(final[0]?.text).toBe('hello');
	});

	it('durable first, then provisional: still one message', async () => {
		// The orders really do race — a peer push and the durable poller are
		// independent, and on a fast chain the block can win.
		const { final } = await drive([[record({ id: 42 })], [provisional()]]);
		expect(final).toHaveLength(1);
		expect(final[0]?.id).toBe(42);
	});

	it('a provisional seen twice is still one message', async () => {
		// Two peers can push the same message: the fan-out goes to every
		// instance, and a person may be reachable through more than one.
		const { final } = await drive([[provisional()], [provisional()]]);
		expect(final).toHaveLength(1);
		expect(final[0]?.id, 'a provisional never adopts an id from another provisional').toBeNull();
	});

	it('keeps the provisional visible before the durable copy exists', async () => {
		// The whole point of the fast path: the message is READABLE now, a minute
		// before it goes irreversible.
		const { final } = await drive([[provisional()]]);
		expect(final).toHaveLength(1);
		expect(final[0]?.text).toBe('hello');
		expect(final[0]?.state).toBe('confirmed');
	});
});

describe('the trade-status side effects run exactly once', () => {
	// The real wire shape (see payload.ts): `morphit_` prefixed kind,
	// snake_case fields. A shape the decoder does not recognise decodes to
	// 'plaintext' and records nothing — which would make every assertion below
	// pass for the wrong reason.
	const fundsSent = JSON.stringify({
		v: 1,
		kind: 'morphit_funds_sent',
		method: 'blurt',
		txid: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4', // 40 hex, as Blurt uses
		amount: '10.000',
		order_permlink: 'order-1'
	});

	it('a funds-sent claim is recorded once, not again when the durable twin lands', async () => {
		await drive([[provisional({ text: fundsSent })], [record({ id: 42, text: fundsSent })]]);
		expect(
			recordFundsSent.mock.calls.length,
			'the durable twin must not re-record the payment claim against the order'
		).toBe(1);
	});

	it('...and the on-chain verification is triggered once', async () => {
		await drive([[provisional({ text: fundsSent })], [record({ id: 42, text: fundsSent })]]);
		expect(triggerBlurtVerification.mock.calls.length).toBe(1);
	});

	it('a shared payment address is recorded once', async () => {
		const address = JSON.stringify({
			v: 1,
			kind: 'morphit_addr',
			method: 'btc',
			address: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
			order_permlink: 'order-1'
		});
		await drive([[provisional({ text: address })], [record({ id: 42, text: address })]]);
		expect(recordAddressShared.mock.calls.length).toBe(1);
	});

	/**
	 * The side effect belongs to the FIRST copy, whichever that was. With the
	 * durable copy first, the provisional that follows must not re-run it
	 * either — the guard has to be about the collapse, not about which kind of
	 * copy arrived.
	 */
	it('durable first, provisional second: still recorded once', async () => {
		await drive([[record({ id: 42, text: fundsSent })], [provisional({ text: fundsSent })]]);
		expect(recordFundsSent.mock.calls.length).toBe(1);
	});

	it('an ordinary message records nothing at all', async () => {
		await drive([
			[provisional({ text: 'just talking' })],
			[record({ id: 42, text: 'just talking' })]
		]);
		expect(recordFundsSent).not.toHaveBeenCalled();
		expect(recordAddressShared).not.toHaveBeenCalled();
		expect(triggerBlurtVerification).not.toHaveBeenCalled();
	});
});

/**
 * v1.18.0 review (W1) — the TAG is the sender's to choose, so it cannot be
 * what decides that two copies are one message.
 *
 * A sender who reuses a tag can put two DIFFERENT messages behind it. The fast
 * path delivers from the federation before the chain has seen a message, so one
 * of them can be a message the chain then refuses. Merged by tag alone, the
 * refused message's WORDS adopted the id and on-chain proof of the other — and
 * the PDF export printed "Blockchain proof: <tx>" beside text that transaction
 * never carried. Or the second, on-chain message was folded into the first and
 * never shown at all.
 */
describe('two messages under one tag are two messages', () => {
	it('a refused message never inherits the proof of a different one', async () => {
		const { final } = await drive([
			[provisional({ text: 'price is 0.5 XMR' })],
			[record({ id: 42, text: 'price is 5 XMR', source_trx_id: 'tx2' })]
		]);
		const refused = final.find((m) => m.text === 'price is 0.5 XMR');
		const landed = final.find((m) => m.text === 'price is 5 XMR');
		expect(landed, 'the message that landed on chain must be shown').toBeDefined();
		expect(landed?.id).toBe(42);
		expect(
			refused?.id ?? null,
			'the words the chain never recorded took the id of a message that did land'
		).toBeNull();
		expect(refused?.trxId ?? null, 'and its on-chain proof').toBeNull();
	});

	it('a second on-chain message under a reused tag is shown, not folded away', async () => {
		const { final } = await drive([
			[record({ id: 41, text: 'first' })],
			[record({ id: 42, text: 'second' })]
		]);
		expect(final.map((m) => m.text).sort()).toEqual(['first', 'second']);
	});

	it('the genuine twin still collapses: same tag AND the same bytes', async () => {
		const { final } = await drive([
			[provisional({ text: 'same' })],
			[record({ id: 42, text: 'same' })]
		]);
		expect(final).toHaveLength(1);
		expect(final[0]?.id).toBe(42);
	});
});
