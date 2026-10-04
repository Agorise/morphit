/**
 * The conversation controller sends ONLY the v2 (sender-authenticated)
 * envelope, opens incoming messages with the peer's PINNED key, and never lets
 * a message whose sender is not proved move a trade forward.
 *
 * Real crypto (crypto.ts) end to end; only the network is faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const recordFundsSent = vi.fn();
const triggerBlurtVerification = vi.fn();
vi.mock('$lib/trades/tradeStatus', () => ({
	recordAddressShared: vi.fn(),
	recordFundsSent: (...a: unknown[]) => recordFundsSent(...a)
}));
vi.mock('$lib/trades/tradeVerify', () => ({
	triggerBlurtVerification: (...a: unknown[]) => triggerBlurtVerification(...a)
}));

import sodium from 'libsodium-wrappers-sumo';
import { createConversationController, type ChatControllerDeps } from './chatService';
import * as chat from './crypto';
import type { ChatMessageRecord } from '@morphit/indexer-client';
import type { LiveIdentity } from '$crypto/keygen';

const FUNDS_SENT = JSON.stringify({
	v: 1,
	kind: 'morphit_funds_sent',
	method: 'blurt',
	txid: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4',
	amount: '10.000',
	order_permlink: 'order-1'
});

let ctrls: { destroy(): void }[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	recordFundsSent.mockClear();
	triggerBlurtVerification.mockClear();
});
afterEach(() => {
	for (const c of ctrls) c.destroy();
	ctrls = [];
	vi.useRealTimers();
});

async function ids() {
	await sodium.ready;
	return {
		alice: await chat.deriveChatIdentity(sodium.randombytes_buf(32), 'alice'),
		bob: await chat.deriveChatIdentity(sodium.randombytes_buf(32), 'bob')
	};
}

function record(env: chat.ChatEnvelopeWire, id: number): ChatMessageRecord {
	return {
		id,
		sender: 'alice',
		recipient: 'bob',
		ciphertext: env.ciphertext,
		header: { ...(env.v === 2 ? { v: 2 } : {}), ephemeral_pub: env.ephemeralPub, nonce: env.nonce },
		created_at: '2026-10-02T12:00:00.000Z',
		source_trx_id: 'e'.repeat(40)
	} as ChatMessageRecord;
}

function deps(
	k: Awaited<ReturnType<typeof ids>>,
	items: ChatMessageRecord[],
	broadcasts: Record<string, unknown>[] = []
): ChatControllerDeps {
	const fetchHistory = vi.fn();
	fetchHistory.mockResolvedValueOnce({ ok: true, items, nextCursor: null });
	fetchHistory.mockResolvedValue({ ok: true, items: [], nextCursor: null });
	return {
		me: 'bob',
		peer: 'alice',
		orderPermlink: null,
		getLiveIdentity: () => ({}) as LiveIdentity,
		now: () => new Date('2026-10-02T12:00:00Z'),
		visibilityState: () => 'visible',
		onVisibilityChange: () => () => undefined,
		generateClientTag: () => 'a'.repeat(32),
		fetchHistory: fetchHistory as unknown as ChatControllerDeps['fetchHistory'],
		broadcast: (async (_l: unknown, payload: Record<string, unknown>) => {
			broadcasts.push(payload);
			return { block_num: null, trx_id: 'f'.repeat(40) };
		}) as unknown as ChatControllerDeps['broadcast'],
		fetchPeerChatPub: async () => k.alice.pub,
		pinnedPeerPubs: () => [k.alice.pub],
		deriveMyChatIdentity: async () => ({ priv: k.bob.priv, pub: k.bob.pub }),
		encrypt: async (pt, rpub, s, r, sender, self) =>
			chat.encryptToRecipient(pt, rpub, sender, s, r, self),
		decrypt: async (env, priv, pub, s, r, pubs) => {
			try {
				return await chat.decryptFromSender(env as never, { priv, pub }, s, r, pubs ?? []);
			} catch {
				return null;
			}
		},
		onChange: () => undefined
	};
}

async function load(d: ChatControllerDeps) {
	const c = createConversationController(d);
	ctrls.push(c);
	c.start();
	await vi.runOnlyPendingTimersAsync();
	return c;
}

describe('chat controller sender authentication', () => {
	it('sends the v2 envelope (header v: 2)', async () => {
		const k = await ids();
		const sent: Record<string, unknown>[] = [];
		const c = await load(deps(k, [], sent));
		await c.sendMessage('hello');
		expect(sent.length).toBe(1);
		expect((sent[0]!.header as Record<string, unknown>).v).toBe(2);
	});

	it('a v1 message injected "from" the peer (made with only our public key) is marked unverified and records no trade', async () => {
		const k = await ids();
		const forged = await chat.encryptToRecipientV1(FUNDS_SENT, k.bob.pub, 'alice', 'bob');
		const c = await load(deps(k, [record(forged, 7)]));
		const m = c.snapshot().find((x) => x.id === 7)!;
		expect(m.decryptFailed).toBe(false);
		expect(m.senderUnverified).toBe(true);
		expect(recordFundsSent).not.toHaveBeenCalled();
		expect(triggerBlurtVerification).not.toHaveBeenCalled();
	});

	it('a genuine v2 message from the peer is proved and drives the trade', async () => {
		const k = await ids();
		const env = await chat.encryptToRecipient(FUNDS_SENT, k.bob.pub, k.alice, 'alice', 'bob');
		const c = await load(deps(k, [record(env, 8)]));
		const m = c.snapshot().find((x) => x.id === 8)!;
		expect(m.decryptFailed).toBe(false);
		expect(m.senderUnverified).toBeUndefined();
		expect(recordFundsSent).toHaveBeenCalledTimes(1);
	});

	it('a v2 message made with another key than the pinned one does not open', async () => {
		const k = await ids();
		const mallory = await chat.deriveChatIdentity(sodium.randombytes_buf(32), 'mallory');
		const env = await chat.encryptToRecipient(FUNDS_SENT, k.bob.pub, mallory, 'alice', 'bob');
		const c = await load(deps(k, [record(env, 9)]));
		const m = c.snapshot().find((x) => x.id === 9)!;
		expect(m.decryptFailed).toBe(true);
		expect(recordFundsSent).not.toHaveBeenCalled();
	});
});
