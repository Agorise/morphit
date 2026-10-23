/**
 * A FIRST conversation, as it went on the live site (v1.21.14): B pressed
 * "Message" on A's order. A has a published chat key (an older Morphit
 * published one for everybody); B, a newer member, has none.
 *
 *   - B saw "Sender not verified: this message came in an older format…" on
 *     EVERY message from A;
 *   - B's reply was refused: "Not sent: these are not keys you have checked
 *     for this person… until now you only wrote to them in the older format",
 *     until B pressed "I compared it — accept the new key".
 *
 * Why: opening the conversation fetched A's CHAT key and pinned it; A answered
 * in the posting-key format, and a peer with a pinned chat key got no posting
 * keys on first use (they were held as a "change" for Verify peer). A normal
 * first conversation must show neither.
 *
 * Chat relies on the POSTING KEY only now: every new message is v3, posting
 * keys are trusted on first use whatever chat key is pinned, and the chat key
 * is only derived to READ old (v2) messages.
 *
 * The REAL runtime wiring (runtimeDeps: pin store, envelope crypto, key
 * reads); only the network is a fake — the indexer's answers, the chain's
 * account keys and the broadcast.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as secp from '@noble/secp256k1';
import type { ChatMessageRecord } from '@morphit/indexer-client';
import type { LiveIdentity } from '$crypto/keygen';
import { formatPublicKeyBLT } from '$crypto/keygen';

/** The pin store lives in the browser's localStorage: a stand-in here (the
 *  node environment: libsodium refuses jsdom's typed arrays). */
const mem = new Map<string, string>();
const localStorage = {
	getItem: (k: string) => mem.get(k) ?? null,
	setItem: (k: string, v: string) => void mem.set(k, String(v)),
	removeItem: (k: string) => void mem.delete(k),
	clear: () => mem.clear(),
	key: (i: number) => [...mem.keys()][i] ?? null,
	get length() {
		return mem.size;
	}
};
(globalThis as unknown as { window: unknown }).window = {
	localStorage,
	location: new URL('https://morphit.example/en/chat/anna'),
	sessionStorage: { getItem: () => null, setItem: () => undefined, removeItem: () => undefined }
};

let chain: ChatMessageRecord[] = [];
let nextId = 1;
/** Chat keys the indexer reports as published, per account (base64). */
const publishedChatKeys = new Map<string, string>();
/** Posting keys the chain lists, per account. */
const postingKeys = new Map<string, Uint8Array[]>();
const broadcasts: { account: string; payload: Record<string, unknown> }[] = [];

vi.mock('$lib/indexer/client', async (orig) => ({
	...((await orig()) as object),
	getChatIdentity: vi.fn(async (account: string) => {
		const pub = publishedChatKeys.get(account);
		return pub === undefined
			? { ok: false, code: 'not_found', message: 'not found' }
			: {
					ok: true,
					data: {
						account,
						chat_pub: pub,
						source_block_num: 5,
						source_trx_id: 'a'.repeat(40)
					}
				};
	}),
	getChatHistory: vi.fn(async (a: string, b: string) => ({
		ok: true,
		data: {
			items: chain.filter(
				(r) => (r.sender === a && r.recipient === b) || (r.sender === b && r.recipient === a)
			),
			next_cursor: null
		}
	}))
}));
vi.mock('$blurt/accountKeys', () => ({
	fetchAccountKeys: vi.fn(async (_origin: string, account: string) => {
		const keys = postingKeys.get(account);
		return keys === undefined
			? null
			: {
					posting: {
						weight_threshold: 1,
						key_auths: await Promise.all(
							keys.map(async (k) => [await formatPublicKeyBLT(k), 1] as [string, number])
						)
					}
				};
	})
}));
vi.mock('$blurt/sign', async (orig) => ({
	...((await orig()) as object),
	broadcastChatMessage: vi.fn(
		async (_live: unknown, payload: Record<string, unknown>, account: string) => {
			broadcasts.push({ account, payload });
			chain.push({
				id: nextId++,
				sender: account,
				recipient: payload.recipient as string,
				ciphertext: payload.ciphertext as string,
				header: payload.header as Record<string, unknown>,
				order_permlink: (payload.order_permlink as string | undefined) ?? null,
				created_at: new Date(Date.UTC(2026, 9, 21, 12, 0, nextId)).toISOString()
			} as ChatMessageRecord);
			return { block_num: null, trx_id: `${nextId}`.padStart(40, '0') };
		}
	)
}));
vi.mock('$lib/chat/chainVerify', async (orig) => ({
	...((await orig()) as object),
	// The chain confirms whatever the indexer reported (no tampering here).
	verifyPeerChatIdentityOnChain: vi.fn(
		async (peer: string, claimed: { blockNum: number; trxId: string }) => {
			const pub = publishedChatKeys.get(peer);
			return pub === undefined ? null : { chatPubB64: pub, ...claimed };
		}
	)
}));

import {
	clearOwnSentPlaintextCache,
	createConversationController,
	runtimeDeps
} from './chatService';
import { deriveChatIdentity, encodeChatPub, encryptToRecipient, postingPubOf } from './crypto';
import { clearAllPins, pendingPostingKeyChange, pinnedPubsFor, setPin } from './pubPin';

interface Party {
	name: string;
	live: LiveIdentity;
	pub: Uint8Array;
	priv: Uint8Array;
}
function party(name: string): Party {
	const priv = secp.utils.randomPrivateKey();
	const pub = postingPubOf(priv);
	postingKeys.set(name, [pub]);
	return {
		name,
		priv,
		pub,
		live: {
			posting: { role: 'posting', privateKey: priv, publicKey: pub }
		} as unknown as LiveIdentity
	};
}

const ORDER = 'anna-sells-blurt';

async function open(me: Party, peer: Party) {
	const c = createConversationController({
		...runtimeDeps(me.name, peer.name, () => me.live, ORDER),
		subscribeStream: undefined,
		onChange: () => undefined
	});
	c.start();
	// Every message of the pair on "chain" is in the view (opened, or not):
	// the key reads and the crypto finish on their own schedule.
	const onChain = chain.filter(
		(r) => [r.sender, r.recipient].sort().join() === [me.name, peer.name].sort().join()
	).length;
	await vi.waitFor(() => {
		if (c.snapshot().length < onChain) throw new Error('still loading');
	});
	await vi.runOnlyPendingTimersAsync();
	return c;
}

beforeEach(() => {
	vi.useFakeTimers();
	localStorage.clear();
	clearAllPins();
	clearOwnSentPlaintextCache();
	chain = [];
	nextId = 1;
	publishedChatKeys.clear();
	postingKeys.clear();
	broadcasts.length = 0;
});
afterEach(() => {
	vi.useRealTimers();
});

describe('a first conversation: B presses "Message" on A’s order', () => {
	it('every message is proved and every reply goes — no "older format", no key to accept', async () => {
		const anna = party('anna'); // A: an older Morphit published her chat key
		const bobby = party('bobby'); // B: never published one
		publishedChatKeys.set(
			anna.name,
			encodeChatPub((await deriveChatIdentity(anna.priv, anna.name)).pub)
		);

		// B opens the conversation from A's order and writes first.
		const b1 = await open(bobby, anna);
		await b1.sendMessage('hi, is this still available?');
		expect(b1.snapshot().map((m) => m.error)).toEqual([null]);
		b1.destroy();

		// A reads it (proved) and answers.
		const a1 = await open(anna, bobby);
		expect(a1.snapshot().map((m) => [m.text, m.senderUnverified ?? false])).toEqual([
			['hi, is this still available?', false]
		]);
		await a1.sendMessage('yes it is');
		expect(a1.snapshot().find((m) => m.text === 'yes it is')!.error).toBeNull();
		a1.destroy();

		// B sees A's answer as proved — not "Sender not verified".
		const b2 = await open(bobby, anna);
		const fromAnna = b2.snapshot().filter((m) => m.sender === anna.name);
		expect(fromAnna.map((m) => [m.text, m.senderUnverified ?? false])).toEqual([
			['yes it is', false]
		]);
		// …and B's reply goes, with nothing to accept.
		await b2.sendMessage('great, I will pay now');
		expect(b2.snapshot().find((m) => m.text === 'great, I will pay now')!.error).toBeNull();
		expect(pendingPostingKeyChange(anna.name)).toBeNull();
		b2.destroy();

		// Every new message, both ways, is in the posting-key format.
		expect(broadcasts.map((b) => (b.payload.header as Record<string, unknown>).v)).toEqual([
			3, 3, 3
		]);
	});

	it('the other way round: A writes first — B reads it proved and answers', async () => {
		const anna = party('anna');
		const bobby = party('bobby');
		publishedChatKeys.set(
			anna.name,
			encodeChatPub((await deriveChatIdentity(anna.priv, anna.name)).pub)
		);
		const a1 = await open(anna, bobby);
		await a1.sendMessage('hello, thanks for your interest');
		expect(a1.snapshot().map((m) => m.error)).toEqual([null]);
		a1.destroy();

		const b1 = await open(bobby, anna);
		expect(b1.snapshot().map((m) => [m.text, m.senderUnverified ?? false])).toEqual([
			['hello, thanks for your interest', false]
		]);
		await b1.sendMessage('hi!');
		expect(b1.snapshot().find((m) => m.text === 'hi!')!.error).toBeNull();
		b1.destroy();

		const a2 = await open(anna, bobby);
		expect(
			a2
				.snapshot()
				.filter((m) => m.sender === bobby.name)
				.map((m) => [m.text, m.senderUnverified ?? false])
		).toEqual([['hi!', false]]);
		a2.destroy();
		expect(broadcasts.map((b) => (b.payload.header as Record<string, unknown>).v)).toEqual([3, 3]);
	});
});

/** A message in the OLDER chat-key format (v2), as an older Morphit — on this
 *  instance or another — still writes it to an account with a published chat
 *  key. Put on "chain" as the indexer stores it. */
async function olderClientWrites(from: Party, to: Party, text: string): Promise<void> {
	const fromId = await deriveChatIdentity(from.priv, from.name);
	const toId = await deriveChatIdentity(to.priv, to.name);
	const env = await encryptToRecipient(text, toId.pub, fromId, from.name, to.name, true);
	chain.push({
		id: nextId++,
		sender: from.name,
		recipient: to.name,
		ciphertext: env.ciphertext,
		header: {
			v: 2,
			client_tag: `older-${nextId}`.padEnd(32, '0'),
			ephemeral_pub: env.ephemeralPub,
			nonce: env.nonce,
			self_ciphertext: env.selfCiphertext,
			self_nonce: env.selfNonce
		},
		order_permlink: ORDER,
		created_at: new Date(Date.UTC(2026, 9, 21, 12, 0, nextId)).toISOString()
	} as ChatMessageRecord);
}

async function publishChatKey(p: Party): Promise<string> {
	const b64 = encodeChatPub((await deriveChatIdentity(p.priv, p.name)).pub);
	publishedChatKeys.set(p.name, b64);
	return b64;
}

describe('messages from an older Morphit (the chat-key format, v2) are still read', () => {
	it('readable, with the calm "older format" note (no chat key pinned); our reply goes in the posting-key format', async () => {
		const anna = party('anna');
		const bobby = party('bobby');
		await publishChatKey(anna);
		await publishChatKey(bobby);
		await olderClientWrites(anna, bobby, 'written by an older version');

		const b = await open(bobby, anna);
		const m = b.snapshot().find((x) => x.sender === anna.name)!;
		expect([m.text, m.decryptFailed, m.senderUnverified, m.olderFormat]).toEqual([
			'written by an older version',
			false,
			true,
			true
		]);
		await b.sendMessage('got it');
		expect(b.snapshot().find((x) => x.text === 'got it')!.error).toBeNull();
		expect((broadcasts[0]!.payload.header as Record<string, unknown>).v).toBe(3);
		// Opening it pinned nothing: no chat key is pinned any more.
		expect(pinnedPubsFor(anna.name)).toEqual([]);
		b.destroy();
	});

	it('a chat key pinned in a conversation before v1.21.14 still proves it', async () => {
		const anna = party('anna');
		const bobby = party('bobby');
		const annaChat = await publishChatKey(anna);
		await publishChatKey(bobby);
		setPin(anna.name, { blockNum: 5, trxId: 'a'.repeat(40), pubB64: annaChat });
		await olderClientWrites(anna, bobby, 'proved by the old pin');
		const b = await open(bobby, anna);
		const m = b.snapshot().find((x) => x.sender === anna.name)!;
		expect([m.text, m.senderUnverified ?? false, m.olderFormat ?? false]).toEqual([
			'proved by the old pin',
			false,
			false
		]);
		b.destroy();
	});

	it('our OWN older-format message is read back from its self-copy', async () => {
		const anna = party('anna');
		const bobby = party('bobby');
		await publishChatKey(anna);
		await publishChatKey(bobby);
		await olderClientWrites(bobby, anna, 'I wrote this before the update');
		const b = await open(bobby, anna);
		expect(b.snapshot().map((x) => [x.sender, x.text])).toEqual([
			[bobby.name, 'I wrote this before the update']
		]);
		b.destroy();
	});

	it('a chat key the chain does not confirm is not used: the message stays closed', async () => {
		const anna = party('anna');
		const bobby = party('bobby');
		await publishChatKey(anna); // the indexer reports her real key…
		await publishChatKey(bobby);
		await olderClientWrites(anna, bobby, 'x');
		// …but the chain does not confirm the op it names.
		const { verifyPeerChatIdentityOnChain } = await import('./chainVerify');
		vi.mocked(verifyPeerChatIdentityOnChain).mockResolvedValueOnce(null);
		const b = await open(bobby, anna);
		const m = b.snapshot().find((x) => x.sender === anna.name)!;
		expect([m.text === 'x', m.decryptFailed]).toEqual([false, true]);
		b.destroy();
	});

	it('…nor one the chain says differs from what the indexer reported', async () => {
		const anna = party('anna');
		const bobby = party('bobby');
		const real = await publishChatKey(anna);
		await publishChatKey(bobby);
		await olderClientWrites(anna, bobby, 'x');
		// The indexer reports another key; the chain names her real one.
		publishedChatKeys.set(anna.name, encodeChatPub(new Uint8Array(32).fill(5)));
		const { verifyPeerChatIdentityOnChain } = await import('./chainVerify');
		vi.mocked(verifyPeerChatIdentityOnChain).mockResolvedValueOnce({
			chatPubB64: real,
			blockNum: 5,
			trxId: 'a'.repeat(40)
		});
		const b = await open(bobby, anna);
		const m = b.snapshot().find((x) => x.sender === anna.name)!;
		expect([m.text === 'x', m.decryptFailed]).toEqual([false, true]);
		b.destroy();
	});
});

describe('after accepting a peer’s new posting key, their OLDER messages (review C, L4)', () => {
	it('are shown with the calm note, not the "compare the new safety number" warning', async () => {
		const anna = party('anna');
		const bobby = party('bobby');
		const a1 = await open(anna, bobby);
		await a1.sendMessage('sent with my first key');
		a1.destroy();
		const b1 = await open(bobby, anna);
		expect(b1.snapshot().map((m) => [m.text, m.senderUnverified ?? false])).toEqual([
			['sent with my first key', false]
		]);
		b1.destroy();

		// Anna changes her posting key; Bobby compares the new number and accepts.
		const newPriv = secp.utils.randomPrivateKey();
		const newPub = postingPubOf(newPriv);
		postingKeys.set(anna.name, [newPub]);
		anna.priv = newPriv;
		anna.pub = newPub;
		anna.live = {
			posting: { role: 'posting', privateKey: newPriv, publicKey: newPub }
		} as unknown as LiveIdentity;
		const { acceptPostingKeysShown } = await import('./pubPin');
		expect(acceptPostingKeysShown(anna.name, [btoa(String.fromCharCode(...newPub))])).toBe(true);

		const a2 = await open(anna, bobby);
		await a2.sendMessage('sent with my new key');
		a2.destroy();

		const b2 = await open(bobby, anna);
		const seen = b2
			.snapshot()
			.filter((m) => m.sender === anna.name)
			.map((m) => [m.text, m.senderUnverified ?? false, m.olderFormat ?? false]);
		expect(seen).toEqual([
			['sent with my first key', true, true],
			['sent with my new key', false, false]
		]);
		b2.destroy();
	});
});
