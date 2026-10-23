/**
 * The conversation controller sends ONLY the posting-key envelope (v3, since
 * v1.21.14 — chat relies on the posting key only), still opens the OLDER
 * chat-key envelope (v2) an older Morphit writes, proves such a message only
 * by a PINNED chat key, and never lets a message whose sender is not proved
 * move a trade forward.
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
import * as secp from '@noble/secp256k1';
import {
	createConversationController,
	postingEnvelopeCrypto,
	type ChatControllerDeps
} from './chatService';
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
		source_trx_id: 'e'.repeat(40),
		// The thread of the order the payload names (v1.21.14, W-H1).
		order_permlink: 'order-1'
	} as ChatMessageRecord;
}

const bobPosting = secp.utils.randomPrivateKey();
const alicePosting = chat.postingPubOf(secp.utils.randomPrivateKey());

function deps(
	k: Awaited<ReturnType<typeof ids>>,
	items: ChatMessageRecord[],
	broadcasts: Record<string, unknown>[] = [],
	pinned: readonly Uint8Array[] = [k.alice.pub]
): ChatControllerDeps {
	const fetchHistory = vi.fn();
	fetchHistory.mockResolvedValueOnce({ ok: true, items, nextCursor: null });
	fetchHistory.mockResolvedValue({ ok: true, items: [], nextCursor: null });
	return {
		me: 'bob',
		peer: 'alice',
		orderPermlink: 'order-1',
		getLiveIdentity: () =>
			({
				posting: {
					role: 'posting',
					privateKey: bobPosting,
					publicKey: chat.postingPubOf(bobPosting)
				}
			}) as unknown as LiveIdentity,
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
		pinnedPeerPubs: () => [...pinned],
		deriveMyChatIdentity: async () => ({ priv: k.bob.priv, pub: k.bob.pub }),
		fetchPostingPubs: async () => [alicePosting],
		...postingEnvelopeCrypto,
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
	it('sends the posting-key envelope (header v: 3), even to a peer whose chat key is pinned', async () => {
		const k = await ids();
		const sent: Record<string, unknown>[] = [];
		const c = await load(deps(k, [], sent));
		await c.sendMessage('hello');
		expect(sent.length).toBe(1);
		const h = sent[0]!.header as Record<string, unknown>;
		expect(h.v).toBe(3);
		expect(h.rk).toEqual([Buffer.from(alicePosting).toString('base64')]);
	});

	it('a v1 message injected "from" the peer (made with only our public key) is marked unverified and records no trade', async () => {
		const k = await ids();
		const forged = await chat.encryptToRecipientV1(FUNDS_SENT, k.bob.pub, 'alice', 'bob');
		const c = await load(deps(k, [record(forged, 7)]));
		const m = c.snapshot().find((x) => x.id === 7)!;
		expect(m.decryptFailed).toBe(false);
		expect(m.senderUnverified).toBe(true);
		expect(m.olderFormat).toBe(true);
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
		expect(m.olderFormat).toBeUndefined();
		expect(recordFundsSent).toHaveBeenCalledTimes(1);
	});

	it('a genuine v2 message from a peer whose chat key is NOT pinned: readable, the calm "older format" note, no trade', async () => {
		const k = await ids();
		const env = await chat.encryptToRecipient(FUNDS_SENT, k.bob.pub, k.alice, 'alice', 'bob');
		const c = await load(deps(k, [record(env, 10)], [], []));
		const m = c.snapshot().find((x) => x.id === 10)!;
		expect([m.decryptFailed, m.senderUnverified, m.olderFormat]).toEqual([false, true, true]);
		expect(m.text).toBe(FUNDS_SENT);
		expect(recordFundsSent).not.toHaveBeenCalled();
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
