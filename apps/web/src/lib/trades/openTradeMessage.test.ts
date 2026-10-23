/**
 * A chat message moves a trade (address shared, funds sent) only when its
 * sender is PROVED by the key pinned for them. v1.21.13: the posting-key
 * envelope (v3) follows the same rule with the pinned POSTING key.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as secp from '@noble/secp256k1';
import type { ChatMessageRecord } from '@morphit/indexer-client';
import type { LiveIdentity } from '$crypto/keygen';

vi.mock('$app/environment', () => ({ browser: false, dev: false, building: false, version: 't' }));

const mem = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
	localStorage: {
		getItem: (k: string) => mem.get(k) ?? null,
		setItem: (k: string, v: string) => void mem.set(k, String(v)),
		removeItem: (k: string) => void mem.delete(k),
		clear: () => mem.clear(),
		key: (i: number) => [...mem.keys()][i] ?? null,
		get length() {
			return mem.size;
		}
	},
	sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
};

const { openTradeMessage } = await import('./tradeEventListener');
const { encryptToPostingKey, postingPubOf } = await import('$lib/chat/crypto');
const { resolvePostingKeyPin, clearAllPins } = await import('$lib/chat/pubPin');

const party = () => {
	const priv = secp.utils.randomPrivateKey();
	const pub = postingPubOf(priv);
	return {
		priv,
		pub,
		live: { posting: { privateKey: priv, publicKey: pub } } as unknown as LiveIdentity
	};
};
const seller = party();
const buyer = party();
const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');

async function record(from: { priv: Uint8Array }, text: string): Promise<ChatMessageRecord> {
	const env = await encryptToPostingKey(text, [buyer.pub], from.priv, 'seller-bo', 'buyer-anna');
	return {
		id: 1,
		sender: 'seller-bo',
		recipient: 'buyer-anna',
		ciphertext: env.ciphertext,
		header: {
			v: 3,
			ephemeral_pub: env.ephemeralPub,
			nonce: env.nonce,
			sk: env.senderKey,
			rk: env.recipientKeys,
			wk: env.wraps
		},
		created_at: '2026-10-20T12:00:00.000Z'
	} as ChatMessageRecord;
}

beforeEach(() => clearAllPins());

describe('openTradeMessage (v3)', () => {
	it('opens a message made with the pinned posting key', async () => {
		await resolvePostingKeyPin('seller-bo', [b64(seller.pub)]);
		expect(await openTradeMessage(await record(seller, 'addr'), 'buyer-anna', buyer.live)).toBe(
			'addr'
		);
	});
	it('nothing pinned yet: nothing is proved, nothing moves', async () => {
		expect(
			await openTradeMessage(await record(seller, 'addr'), 'buyer-anna', buyer.live)
		).toBeNull();
	});
	it('made with another key than the pinned one: nothing moves', async () => {
		await resolvePostingKeyPin('seller-bo', [b64(seller.pub)]);
		const other = party();
		expect(
			await openTradeMessage(await record(other, 'pay me'), 'buyer-anna', buyer.live)
		).toBeNull();
	});
});

describe('openTradeMessage (v4, review C-M2)', () => {
	async function v4Record(order: string, recordOrder: string | null): Promise<ChatMessageRecord> {
		const env = await encryptToPostingKey(
			'addr v4',
			[buyer.pub],
			seller.priv,
			'seller-bo',
			'buyer-anna',
			true,
			{ order, owner: 'seller-bo', t: 1_792_000_000 }
		);
		return {
			id: 2,
			sender: 'seller-bo',
			recipient: 'buyer-anna',
			ciphertext: env.ciphertext,
			header: {
				v: 4,
				t: env.t,
				o: env.o,
				ephemeral_pub: env.ephemeralPub,
				nonce: env.nonce,
				sk: env.senderKey,
				rk: env.recipientKeys,
				wk: env.wraps
			},
			created_at: '2026-10-20T12:00:00.000Z',
			...(recordOrder !== null ? { order_permlink: recordOrder } : {})
		} as ChatMessageRecord;
	}
	it('opens a v4 message in the order thread it was sealed for', async () => {
		await resolvePostingKeyPin('seller-bo', [b64(seller.pub)]);
		expect(
			await openTradeMessage(await v4Record('order-a', 'order-a'), 'buyer-anna', buyer.live)
		).toBe('addr v4');
	});
	it('moved to another order thread (or out of one): nothing opens, nothing moves', async () => {
		await resolvePostingKeyPin('seller-bo', [b64(seller.pub)]);
		expect(
			await openTradeMessage(await v4Record('order-a', 'order-b'), 'buyer-anna', buyer.live)
		).toBeNull();
		expect(
			await openTradeMessage(await v4Record('order-a', null), 'buyer-anna', buyer.live)
		).toBeNull();
	});
});
