/**
 * Chat to someone who never opened chat (v1.21.13).
 *
 * A buyer pressed "Message" on a new member's order and got a red "This
 * recipient hasn't opened Morphit chat yet. Once they do, your message will go
 * through on retry." Nothing was stored for the recipient, who could not have
 * paid to publish a chat key anyway, and after leaving the chat and coming
 * back the failed message was gone. Messages to an account without a
 * published chat key now go to its POSTING keys (crypto.ts v3), which every
 * account has on chain.
 *
 * Two real parties, real crypto (both envelope versions), a shared "chain".
 * Only the network is a fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as secp from '@noble/secp256k1';
import type { ChatMessageRecord } from '@morphit/indexer-client';
import type { LiveIdentity } from '$crypto/keygen';
import { formatPublicKeyBLT } from '$crypto/keygen';
import {
	clearOwnSentPlaintextCache,
	createConversationController,
	orderPostingPubs,
	pinPostingKeyInStore,
	pinnedPostingKeysInStore,
	postingEnvelopeCrypto,
	CHAIN_UNREACHABLE_SENTINEL,
	KEY_LOOKUP_RETRY_MS,
	PEER_NOT_FOUND_SENTINEL,
	PEER_NO_POSTING_KEY_SENTINEL,
	DECRYPT_YIELD_EVERY,
	__cachedPostingReader,
	type ChatControllerDeps
} from './chatService';
import {
	decryptFromSender,
	decryptSelfCopy,
	deriveChatIdentity,
	encryptToRecipient,
	postingPubOf,
	DecryptError
} from './crypto';
import { ChainRejectedError } from '$blurt/broadcastTransport';
import {
	PubPinError,
	acceptKeyChange,
	clearAllPins,
	pendingPostingKeyChange,
	pinnedPostingFor,
	setPin
} from './pubPin';

/** The pin store lives in the browser's localStorage: a stand-in here. */
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

interface Party {
	name: string;
	priv: Uint8Array;
	pub: Uint8Array;
	live: LiveIdentity;
}
const party = (name: string): Party => {
	const priv = secp.utils.randomPrivateKey();
	const pub = postingPubOf(priv);
	return {
		name,
		priv,
		pub,
		live: {
			posting: { role: 'posting', privateKey: priv, publicKey: pub }
		} as unknown as LiveIdentity
	};
};

let chain: ChatMessageRecord[] = [];
let nextId = 1;

interface World {
	/** Accounts whose chat key is published (and current). */
	published: Set<string>;
	/** Posting keys the chain lists per account (absent: no such account). */
	postingKeys: Map<string, Uint8Array[]>;
	parties: Map<string, Party>;
}

function deps(
	w: World,
	me: Party,
	peer: string,
	over: Partial<ChatControllerDeps> = {}
): ChatControllerDeps & { sent: Record<string, unknown>[] } {
	const sent: Record<string, unknown>[] = [];
	let tag = 0;
	const chatPubOf = async (account: string) => {
		const p = w.parties.get(account)!;
		return (await deriveChatIdentity(p.priv, account)).pub;
	};
	return {
		me: me.name,
		peer,
		orderPermlink: null,
		getLiveIdentity: () => me.live,
		now: () => new Date(),
		visibilityState: () => 'visible',
		onVisibilityChange: () => () => undefined,
		generateClientTag: () => `${me.name}-tag-${++tag}`.padEnd(32, '0'),
		fetchHistory: async (a, b) => ({
			ok: true,
			items: chain.filter(
				(r) => (r.sender === a && r.recipient === b) || (r.sender === b && r.recipient === a)
			),
			nextCursor: null
		}),
		broadcast: async (_live, payload) => {
			sent.push(payload);
			chain.push({
				id: nextId++,
				sender: me.name,
				recipient: payload.recipient as string,
				ciphertext: payload.ciphertext as string,
				header: payload.header as Record<string, unknown>,
				created_at: new Date(Date.UTC(2026, 9, 20, 12, 0, nextId)).toISOString()
			} as ChatMessageRecord);
			return { block_num: null, trx_id: `trx${nextId}` };
		},
		fetchPeerChatPub: async (account) => (w.published.has(account) ? chatPubOf(account) : null),
		deriveMyChatIdentity: async (live, account) =>
			deriveChatIdentity(live.posting.privateKey, account),
		encrypt: async (pt, recipientPub, sa, ra, sender, self) =>
			encryptToRecipient(pt, recipientPub, sender, sa, ra, self) as never,
		decrypt: async (env, priv, pub, sa, ra, pubs) => {
			try {
				return await decryptFromSender(env as never, { priv, pub }, sa, ra, pubs ?? []);
			} catch (e) {
				if (e instanceof DecryptError) return null;
				throw e;
			}
		},
		decryptSelfCopy: async (env, priv, pub, sa, ra, pubs) => {
			try {
				return await decryptSelfCopy(env as never, { priv, pub }, sa, ra, pubs ?? []);
			} catch (e) {
				if (e instanceof DecryptError) return null;
				throw e;
			}
		},
		fetchPostingPubs: async (account) => w.postingKeys.get(account) ?? null,
		myChatKeyStatus: async () => (w.published.has(me.name) ? 'current' : 'none'),
		...postingEnvelopeCrypto,
		onChange: () => undefined,
		...over,
		sent
	};
}

const buyer = party('buyer-anna');
const seller = party('seller-bo');
const world = (published: string[] = []): World => ({
	published: new Set(published),
	postingKeys: new Map([
		[buyer.name, [buyer.pub]],
		[seller.name, [seller.pub]]
	]),
	parties: new Map([
		[buyer.name, buyer],
		[seller.name, seller]
	])
});

async function view(d: ChatControllerDeps) {
	const c = createConversationController(d);
	c.start();
	await vi.runOnlyPendingTimersAsync();
	return c;
}

beforeEach(() => {
	vi.useFakeTimers();
	clearOwnSentPlaintextCache();
	clearAllPins();
	chain = [];
	nextId = 1;
});
afterEach(() => {
	vi.useRealTimers();
});

describe('a message to someone who never published a chat key', () => {
	it('goes on chain at once, and they read it when they sign in — proved as from the sender', async () => {
		const w = world([buyer.name]); // buyer has a chat key; seller never opened chat
		const kd = deps(w, buyer, seller.name);
		const kc = await view(kd);
		await kc.sendMessage('hey there ;)');
		const mine = kc.snapshot()[0]!;
		expect(mine.error).toBeNull();
		expect(mine.state === 'broadcast' || mine.state === 'confirmed').toBe(true);
		expect(kd.sent).toHaveLength(1);
		const h = kd.sent[0]!.header as Record<string, unknown>;
		expect(h.v).toBe(3);
		expect((h.rk as string[]).map((k) => Buffer.from(k, 'base64'))).toEqual([
			Buffer.from(seller.pub)
		]);
		expect(h.wk as string[]).toHaveLength(1);
		expect(Buffer.from(h.sk as string, 'base64')).toEqual(Buffer.from(buyer.pub));
		kc.destroy();

		// The seller signs in later, never having published anything.
		const jc = await view(deps(w, seller, buyer.name));
		const got = jc.snapshot();
		expect(got).toHaveLength(1);
		expect(got[0]!.text).toBe('hey there ;)');
		expect(got[0]!.decryptFailed).toBe(false);
		expect(got[0]!.senderUnverified ?? false).toBe(false);
		jc.destroy();
	});

	it('their reply reaches us too, though they have no chat key (the replier pays the fee for it, like any sender)', async () => {
		const w = world([buyer.name]);
		const jd = deps(w, seller, buyer.name);
		const jc = await view(jd);
		await jc.sendMessage('oi');
		expect(jc.snapshot()[0]!.error).toBeNull();
		// The buyer HAS a chat key, but seller has none to be proved with: v3.
		expect((jd.sent[0]!.header as Record<string, unknown>).v).toBe(3);
		jc.destroy();
		const kc = await view(deps(w, buyer, seller.name));
		expect(kc.snapshot().map((m) => [m.text, m.senderUnverified ?? false])).toEqual([
			['oi', false]
		]);
		kc.destroy();
	});

	it('we reread our own message from chain (its self-copy) after the in-memory copy is gone', async () => {
		const w = world([]);
		const kc = await view(deps(w, buyer, seller.name));
		await kc.sendMessage('remember me');
		kc.destroy();
		clearOwnSentPlaintextCache(); // a lock / a reload: nothing left in memory
		const again = await view(deps(w, buyer, seller.name));
		expect(again.snapshot().map((m) => m.text)).toEqual(['remember me']);
		again.destroy();
	});

	it('a message whose sender key is not on the sender’s account reads, but is not proved', async () => {
		const w = world([]);
		const kc = await view(deps(w, buyer, seller.name));
		await kc.sendMessage('who am i');
		kc.destroy();
		const imposter = party('x');
		w.postingKeys.set(buyer.name, [imposter.pub]); // the chain lists another key for buyer
		const jc = await view(deps(w, seller, buyer.name));
		expect(jc.snapshot().map((m) => [m.text, m.senderUnverified ?? false])).toEqual([
			['who am i', true]
		]);
		jc.destroy();
	});
});

describe('the first message is not slower (the 6-second delivery budget)', () => {
	it('the key lookups run as the conversation opens, so Send does not wait on a slow hidden round trip', async () => {
		const w = world([buyer.name]);
		const slow =
			<T>(v: () => Promise<T>, ms: number) =>
			() =>
				new Promise<T>((r) => setTimeout(() => void v().then(r), ms));
		const base = deps(w, buyer, seller.name);
		let postingCalls = 0;
		let ownCalls = 0;
		const d = {
			...base,
			// A Tor/I2P instance: every lookup is a 2.6 s hidden round trip.
			fetchPeerChatPub: (a: string) => slow(() => base.fetchPeerChatPub(a), 2600)(),
			myChatKeyStatus: () => {
				ownCalls++;
				return slow(() => base.myChatKeyStatus!(), 2600)();
			},
			fetchPostingPubs: (a: string) => {
				postingCalls++;
				return slow(() => base.fetchPostingPubs!(a), 2600)();
			}
		};
		const c = createConversationController(d);
		c.start();
		// The user reads the order and types for three seconds; the lookups run
		// side by side meanwhile.
		await vi.advanceTimersByTimeAsync(3000);
		let sentAt: number | null = null;
		const t0 = Date.now();
		const sending = c.sendMessage('fast').then(() => (sentAt = Date.now()));
		await vi.advanceTimersByTimeAsync(0);
		await sending;
		expect(sentAt! - t0).toBe(0); // no further wait at all
		expect(base.sent).toHaveLength(1);
		expect(postingCalls).toBe(1); // looked up once, at open — not again on Send
		expect(ownCalls).toBe(1);
		c.destroy();

		// Send at once, while the lookups are still on their way: it joins
		// them rather than starting its own (one round trip each, not two).
		// Different delays, so each lookup is in flight when the send asks.
		let peerCalls = 0;
		postingCalls = 0;
		ownCalls = 0;
		const w2 = world([buyer.name, seller.name]); // both published: the v2 path asks all three
		const base2 = deps(w2, buyer, seller.name);
		const d2 = {
			...base2,
			fetchPeerChatPub: (a: string) => {
				peerCalls++;
				return slow(() => base2.fetchPeerChatPub(a), 100)();
			},
			myChatKeyStatus: () => {
				ownCalls++;
				return slow(() => base2.myChatKeyStatus!(), 2600)();
			}
		};
		const c2 = createConversationController(d2);
		c2.start();
		const t1 = Date.now();
		let done2: number | null = null;
		const s2 = c2.sendMessage('right away').then(() => (done2 = Date.now()));
		await vi.advanceTimersByTimeAsync(2600);
		await s2;
		expect(done2! - t1).toBe(2600);
		expect(peerCalls).toBe(1);
		expect(ownCalls).toBe(1);
		expect(base2.sent).toHaveLength(1);
		c2.destroy();
	});
});

describe('which envelope a send uses', () => {
	it('both chat keys published: the chat-key envelope (v2), exactly as before, and it opens', async () => {
		const w = world([buyer.name, seller.name]);
		const kd = deps(w, buyer, seller.name);
		const kc = await view(kd);
		await kc.sendMessage('as before');
		expect((kd.sent[0]!.header as Record<string, unknown>).v).toBe(2);
		kc.destroy();
		const jc = await view(deps(w, seller, buyer.name));
		expect(jc.snapshot().map((m) => [m.text, m.senderUnverified ?? false])).toEqual([
			['as before', false]
		]);
		jc.destroy();
	});

	it('a chat-key check that FAILS (a changed key, tampering) still stops the send — no way around it', async () => {
		const w = world([buyer.name, seller.name]);
		const kd = deps(w, buyer, seller.name, {
			fetchPeerChatPub: async () => {
				throw new PubPinError('pub_pin_key_changed', 'seller-bo', 'changed');
			}
		});
		const kc = await view(kd);
		await kc.sendMessage('x');
		expect(kc.snapshot()[0]!.error).toBe('pub_pin_key_changed');
		expect(kd.sent).toHaveLength(0);
		kc.destroy();
	});

	it('no such account on chain: said so, nothing broadcast', async () => {
		const w = world([]);
		const kd = deps(w, buyer, 'nobody-here');
		const kc = await view(kd);
		await kc.sendMessage('hello?');
		expect(kc.snapshot()[0]!.error).toBe(PEER_NOT_FOUND_SENTINEL);
		expect(kd.sent).toHaveLength(0);
		kc.destroy();
	});
});

describe('a failed send', () => {
	const lowFunds = () =>
		new ChainRejectedError(
			'Assert Exception:acnt.balance >= fee: Account does not have sufficient funds for transaction fee.'
		);

	it('reads "insufficient funds" in the shared wording, not the chain’s raw text', async () => {
		const w = world([]);
		const kc = await view(
			deps(w, buyer, seller.name, {
				broadcast: async () => {
					throw lowFunds();
				}
			})
		);
		await kc.sendMessage('no money');
		const m = kc.snapshot()[0]!;
		expect(m.state).toBe('failed');
		expect(m.error).toBe('broadcast_err:low_blurt');
		kc.destroy();
	});

	it('is still there, with Retry, after leaving the chat and coming back — and a retry that works clears it', async () => {
		const w = world([]);
		let fail = true;
		const d = (): ChatControllerDeps => {
			const base = deps(w, buyer, seller.name);
			return {
				...base,
				broadcast: async (live, payload, acct) => {
					if (fail) throw lowFunds();
					return base.broadcast(live, payload, acct);
				}
			};
		};
		const first = await view(d());
		await first.sendMessage('try me later');
		first.destroy();

		const back = await view(d());
		const restored = back.snapshot();
		expect(restored.map((m) => [m.text, m.state, m.error])).toEqual([
			['try me later', 'failed', 'broadcast_err:low_blurt']
		]);
		fail = false;
		await back.retryMessage(restored[0]!.localSeq);
		expect(back.snapshot()[0]!.error).toBeNull();
		back.destroy();

		// Once more: the message is on chain, shown once, not failed.
		const third = await view(d());
		expect(third.snapshot().map((m) => [m.text, m.state])).toEqual([['try me later', 'confirmed']]);
		third.destroy();
	});

	it('is forgotten on a lock / sign-out, and never kept in "destroy" mode', async () => {
		const w = world([]);
		const failing = (over: Partial<ChatControllerDeps> = {}) =>
			deps(w, buyer, seller.name, {
				broadcast: async () => {
					throw lowFunds();
				},
				...over
			});
		const a = await view(failing());
		await a.sendMessage('locked away');
		a.destroy();
		clearOwnSentPlaintextCache();
		const b = await view(failing());
		expect(b.snapshot()).toEqual([]);
		b.destroy();

		const c = await view(failing({ chatSecurityMode: () => 'destroy' }));
		await c.sendMessage('burn after reading');
		c.destroy();
		const d2 = await view(failing({ chatSecurityMode: () => 'destroy' }));
		expect(d2.snapshot()).toEqual([]);
		d2.destroy();
	});
});

describe('a posting key that changes (pinned like a chat key)', () => {
	it('is never used silently: sending stops until the new safety number is accepted; their messages are not proved meanwhile', async () => {
		const w = world([]);
		const pinned = {
			pinPostingKey: pinPostingKeyInStore,
			pinnedPostingKeys: pinnedPostingKeysInStore
		};
		const first = await view(deps(w, buyer, seller.name, pinned));
		await first.sendMessage('one');
		expect(first.snapshot()[0]!.error).toBeNull();
		first.destroy();

		// The seller resets their keys (or someone substitutes one).
		const reset = party(seller.name);
		w.parties.set(seller.name, reset);
		w.postingKeys.set(seller.name, [reset.pub]);

		const d2 = deps(w, buyer, seller.name, pinned);
		const second = await view(d2);
		await second.sendMessage('two');
		const m = second.snapshot().find((x) => x.text === 'two')!;
		expect(m.error).toBe('pub_pin_posting_key_changed');
		expect(d2.sent).toHaveLength(0);

		// A message from the new key meanwhile: readable, not proved.
		const sd = await view(deps(w, reset, buyer.name, pinned));
		await sd.sendMessage('it is me, new key');
		sd.destroy();
		const third = await view(deps(w, buyer, seller.name, pinned));
		const incoming = third.snapshot().find((x) => x.sender === seller.name)!;
		expect(incoming.text).toBe('it is me, new key');
		expect(incoming.senderUnverified).toBe(true);
		third.destroy();

		// Accepted after comparing the new safety number: sending works again.
		expect(acceptKeyChange(seller.name, 'chat')).toBe(false); // the other kind: nothing
		expect(acceptKeyChange(seller.name, 'posting')).toBe(true);
		await second.retryMessage(m.localSeq);
		expect(second.snapshot().find((x) => x.text === 'two')!.error).toBeNull();
		const h = d2.sent[0]!.header as Record<string, unknown>;
		expect((h.rk as string[]).map((k) => Buffer.from(k, 'base64'))).toEqual([
			Buffer.from(reset.pub)
		]);
		second.destroy();
	});
});

describe('orderPostingPubs', () => {
	it('only keys that can sign alone, at most 3, duplicates and unreadable keys dropped; no account → null', async () => {
		const [a, b, c, d, e] = ['a', 'b', 'c', 'd', 'e'].map(party);
		const blt = (p: Party) => formatPublicKeyBLT(p.pub);
		const keys = {
			posting: {
				weight_threshold: 2,
				key_auths: [
					[await blt(a!), 1],
					['BLTnotakey', 5],
					[await blt(b!), 2],
					[await blt(b!), 3],
					[await blt(c!), 2],
					[await blt(d!), 4],
					[await blt(e!), 2]
				] as Array<[string, number]>
			}
		};
		expect(orderPostingPubs(keys)).toEqual([b!.pub, c!.pub, d!.pub]);
		expect(orderPostingPubs(null)).toBeNull();
		expect(orderPostingPubs({ posting: { weight_threshold: 1, key_auths: [] } })).toEqual([]);
		// Only a multi-signature set, or other accounts: nothing usable.
		expect(
			orderPostingPubs({ posting: { weight_threshold: 2, key_auths: [[await blt(a!), 1]] } })
		).toEqual([]);
	});
});

describe('never a silent move off checked keys (review H1)', () => {
	const pinStore = {
		pinPostingKey: pinPostingKeyInStore,
		pinnedPostingKeys: pinnedPostingKeysInStore
	};
	const chatPinOf = async (p: Party) =>
		Buffer.from((await deriveChatIdentity(p.priv, p.name)).pub).toString('base64');

	it('a peer whose chat key is pinned here, and the indexer now says has none: not sent, nothing broadcast', async () => {
		const w = world([buyer.name]); // the indexer claims the seller has no chat key
		setPin(seller.name, { blockNum: 5, trxId: 'a'.repeat(40), pubB64: await chatPinOf(seller) });
		const peerAsked = vi.fn();
		const posting = vi.fn(async (a: string) => w.postingKeys.get(a) ?? null);
		const d = deps(w, buyer, seller.name, {
			...pinStore,
			pinnedPeerPubs: () => [new Uint8Array(32).fill(1)],
			fetchPeerChatPub: async () => {
				peerAsked();
				return null;
			},
			fetchPostingPubs: posting
		});
		const c = await view(d);
		posting.mockClear();
		await c.sendMessage('to the pinned key only');
		expect(c.snapshot()[0]!.error).toBe('pub_pin_withdrawn');
		expect(d.sent).toHaveLength(0);
		expect(posting).not.toHaveBeenCalled();
		c.destroy();
	});

	it('our own status unknown: not sent (retry), never guessed', async () => {
		const w = world([buyer.name, seller.name]);
		const d = deps(w, buyer, seller.name, {
			myChatKeyStatus: async () => {
				throw new Error('indexer down');
			}
		});
		const c = await view(d);
		await c.sendMessage('x');
		expect(c.snapshot()[0]!.error).toBe(CHAIN_UNREACHABLE_SENTINEL);
		expect(d.sent).toHaveLength(0);
		c.destroy();
	});

	it('a v3 message "from" a peer whose chat key is pinned, while ours is current: readable, not proved, and the indexer is not asked for keys to prove it', async () => {
		const w = world([buyer.name]);
		// The seller (no chat key published per this world) writes v3.
		const sd = await view(deps(w, seller, buyer.name));
		await sd.sendMessage('trust me');
		sd.destroy();
		const posting = vi.fn(async (a: string) => w.postingKeys.get(a) ?? null);
		const c = await view(
			deps(w, buyer, seller.name, {
				...pinStore,
				pinnedPeerPubs: () => [new Uint8Array(32).fill(1)], // chat key pinned here
				fetchPeerChatPub: async () => new Uint8Array(32).fill(1),
				fetchPostingPubs: posting
			})
		);
		const m = c.snapshot().find((x) => x.sender === seller.name)!;
		expect(m.text).toBe('trust me');
		expect(m.senderUnverified).toBe(true);
		// Only the warm-up's lookup (for sending) — not one to prove the message.
		expect(posting.mock.calls.length).toBeLessThanOrEqual(1);
		c.destroy();
	});

	it('a peer with no pins at all: their first v3 message pins their keys and is proved', async () => {
		const w = world([]);
		const sd = await view(deps(w, seller, buyer.name));
		await sd.sendMessage('first contact');
		sd.destroy();
		const c = await view(deps(w, buyer, seller.name, pinStore));
		const m = c.snapshot().find((x) => x.sender === seller.name)!;
		expect([m.text, m.senderUnverified ?? false]).toEqual(['first contact', false]);
		expect(pinnedPostingKeysInStore(seller.name)).toEqual([seller.pub]);
		c.destroy();
	});
});

describe('lookups: as few as possible, and none remembered wrongly (review H3, M5, M6)', () => {
	it('our status none/stale: the peer’s chat key is never asked for a send', async () => {
		const w = world([seller.name]); // the seller has a chat key; we have none
		const peerAsked = vi.fn(async () => null);
		const d = deps(w, buyer, seller.name, { fetchPeerChatPub: peerAsked });
		const c = await view(d);
		peerAsked.mockClear(); // the warm-up's
		await c.sendMessage('one');
		await c.sendMessage('two');
		expect(peerAsked).not.toHaveBeenCalled();
		expect(d.sent.map((p) => (p.header as Record<string, unknown>).v)).toEqual([3, 3]);
		c.destroy();
	});

	it('a peer with no chat key is asked once per conversation, not once per message; Retry asks again', async () => {
		const w = world([buyer.name]);
		const peerAsked = vi.fn(async () => null);
		let fail = true;
		const base = deps(w, buyer, seller.name, { fetchPeerChatPub: peerAsked });
		const d = {
			...base,
			broadcast: async (l: LiveIdentity, p: Record<string, unknown>, a: string) => {
				if (fail) throw new Error('boom');
				return base.broadcast(l, p, a);
			}
		};
		const c = await view(d);
		await c.sendMessage('one');
		await c.sendMessage('two');
		expect(peerAsked).toHaveBeenCalledTimes(1);
		fail = false;
		await c.retryMessage(c.snapshot()[0]!.localSeq);
		expect(peerAsked).toHaveBeenCalledTimes(2);
		c.destroy();
	});

	it('"no such account" is not remembered: once the account exists, the next send goes', async () => {
		const w = world([]);
		w.postingKeys.delete(seller.name);
		const d = deps(w, buyer, seller.name);
		const c = await view(d);
		await c.sendMessage('one');
		expect(c.snapshot()[0]!.error).toBe(PEER_NOT_FOUND_SENTINEL);
		w.postingKeys.set(seller.name, [seller.pub]);
		await c.sendMessage('two');
		expect(c.snapshot()[1]!.error).toBeNull();
		c.destroy();
	});

	it('an account with no posting key of its own: said so, nothing broadcast', async () => {
		const w = world([]);
		w.postingKeys.set(seller.name, []);
		const d = deps(w, buyer, seller.name);
		const c = await view(d);
		await c.sendMessage('x');
		expect(c.snapshot()[0]!.error).toBe(PEER_NO_POSTING_KEY_SENTINEL);
		expect(d.sent).toHaveLength(0);
		c.destroy();
	});

	it('a failed lookup is asked again only after a pause (one lookup, not one per message); Retry asks at once', async () => {
		const w = world([]);
		let down = true;
		const posting = vi.fn(async (a: string) => {
			if (down) throw new Error('timed out');
			return w.postingKeys.get(a) ?? null;
		});
		const d = deps(w, buyer, seller.name, { fetchPostingPubs: posting });
		const c = await view(d);
		expect(posting).toHaveBeenCalledTimes(1); // the warm-up
		await c.sendMessage('one');
		await c.sendMessage('two');
		expect(c.snapshot().map((m) => m.error)).toEqual([
			CHAIN_UNREACHABLE_SENTINEL,
			CHAIN_UNREACHABLE_SENTINEL
		]);
		expect(posting).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(KEY_LOOKUP_RETRY_MS);
		await c.sendMessage('three');
		expect(posting).toHaveBeenCalledTimes(2);
		down = false;
		await c.retryMessage(c.snapshot()[0]!.localSeq);
		expect(posting).toHaveBeenCalledTimes(3);
		expect(c.snapshot()[0]!.error).toBeNull();
		c.destroy();
	});

	it('a history from a pinned sender opens with no lookup at all', async () => {
		const w = world([]);
		const pinStore = {
			pinPostingKey: pinPostingKeyInStore,
			pinnedPostingKeys: pinnedPostingKeysInStore
		};
		const sd = await view(deps(w, seller, buyer.name, pinStore));
		for (const t of ['a', 'b', 'c']) await sd.sendMessage(t);
		sd.destroy();
		await pinPostingKeyInStore(seller.name, [seller.pub]);
		// The indexer cannot even be asked now: the pin alone proves them.
		const posting = vi.fn(async (_a: string): Promise<Uint8Array[] | null> => {
			throw new Error('unreachable');
		});
		const c = createConversationController(
			deps(w, buyer, seller.name, { ...pinStore, fetchPostingPubs: posting })
		);
		c.start();
		await vi.runOnlyPendingTimersAsync();
		expect(c.snapshot().map((m) => [m.text, m.senderUnverified ?? false])).toEqual([
			['a', false],
			['b', false],
			['c', false]
		]);
		// The warm-up asks once for SENDING; reading asked nothing.
		expect(posting.mock.calls.length).toBeLessThanOrEqual(1);
		c.destroy();
	});
});

describe('an account with several posting keys (review M1)', () => {
	it('the message reaches whichever key the recipient’s session holds', async () => {
		const w = world([]);
		const otherApp = party(seller.name); // the seller's second key, held by this session
		w.postingKeys.set(seller.name, [seller.pub, otherApp.pub]);
		const kd = deps(w, buyer, seller.name);
		const kc = await view(kd);
		await kc.sendMessage('to every key');
		expect((kd.sent[0]!.header as Record<string, unknown>).rk as string[]).toHaveLength(2);
		kc.destroy();
		const sc = await view(deps(w, otherApp, buyer.name));
		expect(sc.snapshot().map((m) => [m.text, m.decryptFailed])).toEqual([['to every key', false]]);
		sc.destroy();
	});
});

describe('destroy mode chosen after a send failed (review L5)', () => {
	it('the failed words are not shown again, and not kept', async () => {
		const w = world([]);
		let mode: 'keep' | 'destroy' = 'keep';
		const d = () =>
			deps(w, buyer, seller.name, {
				broadcast: async () => {
					throw new Error('boom');
				},
				chatSecurityMode: () => mode as never
			});
		const a = await view(d());
		await a.sendMessage('secret words');
		a.destroy();
		mode = 'destroy';
		const b = await view(d());
		expect(b.snapshot()).toEqual([]);
		b.destroy();
		mode = 'keep';
		const c = await view(d());
		expect(c.snapshot()).toEqual([]);
		c.destroy();
	});
});

describe('a peer whose chat key is pinned never gets posting keys on an indexer’s word (review 2, M-1)', () => {
	const pinStore = {
		pinPostingKey: pinPostingKeyInStore,
		pinnedPostingKeys: pinnedPostingKeysInStore
	};
	const b64 = (u: Uint8Array) => Buffer.from(u).toString('base64');
	const chatPin = (peer: string) =>
		setPin(peer, { blockNum: 5, trxId: 'a'.repeat(40), pubB64: b64(new Uint8Array(32).fill(9)) });

	it('send: our key "none", their posting keys new here — not sent; held for Verify peer; sent after Accept', async () => {
		const w = world([]); // the indexer says neither of us has a chat key
		chatPin(seller.name);
		const mallory = party('mallory');
		w.postingKeys.set(seller.name, [mallory.pub]); // …and lists a substituted posting key
		const d = deps(w, buyer, seller.name, {
			...pinStore,
			pinnedPeerPubs: () => [new Uint8Array(32).fill(9)]
		});
		const c = await view(d);
		await c.sendMessage('to the keys I checked only');
		expect(c.snapshot()[0]!.error).toBe('pub_pin_posting_key_changed');
		expect(d.sent).toHaveLength(0);
		expect(pinnedPostingFor(seller.name)).toEqual([]);
		expect(pendingPostingKeyChange(seller.name)).toEqual([b64(mallory.pub)]);
		// The user compares the number in Verify peer (here: the real keys) and accepts.
		w.postingKeys.set(seller.name, [seller.pub]);
		localStorage_setPending(seller.name, [b64(seller.pub)]);
		expect(acceptKeyChange(seller.name, 'posting')).toBe(true);
		await c.retryMessage(c.snapshot()[0]!.localSeq);
		expect(c.snapshot()[0]!.error).toBeNull();
		const h = d.sent[0]!.header as Record<string, unknown>;
		expect((h.rk as string[]).map((k) => Buffer.from(k, 'base64'))).toEqual([
			Buffer.from(seller.pub)
		]);
		c.destroy();
	});

	it('receive: our key "stale", a v3 "from" them made with a key not pinned — readable, NOT proved, nothing pinned', async () => {
		const w = world([]);
		const mallory = party(seller.name);
		w.postingKeys.set(seller.name, [mallory.pub]);
		const md = await view(deps(w, mallory, buyer.name));
		await md.sendMessage('send the coins to X');
		md.destroy();
		chatPin(seller.name);
		const c = await view(
			deps(w, buyer, seller.name, {
				...pinStore,
				pinnedPeerPubs: () => [new Uint8Array(32).fill(9)],
				myChatKeyStatus: async () => 'stale'
			})
		);
		const m = c.snapshot().find((x) => x.sender === seller.name)!;
		expect([m.text, m.senderUnverified]).toEqual(['send the coins to X', true]);
		expect(pinnedPostingFor(seller.name)).toEqual([]);
		expect(pendingPostingKeyChange(seller.name)).toEqual([b64(mallory.pub)]);
		c.destroy();
	});
});

/** Stand-in for the pending change Verify peer would show for the real keys. */
function localStorage_setPending(peer: string, keys: string[]): void {
	const store = (globalThis as unknown as { window: { localStorage: Storage } }).window
		.localStorage;
	store.setItem(
		'morphit.chat.posting_pin_pending',
		JSON.stringify({ [peer]: { blockNum: 0, trxId: '0'.repeat(40), pubB64: keys.join(',') } })
	);
}

describe('answering in the format the peer proved themselves in (review 2, M-3)', () => {
	it('our key current and theirs on chain, but their last proved message is v3: we answer in v3 (their chat key may be stale)', async () => {
		const w = world([buyer.name, seller.name]);
		const pinStore = {
			pinPostingKey: pinPostingKeyInStore,
			pinnedPostingKeys: pinnedPostingKeysInStore
		};
		// Before: v2 both ways.
		const d0 = deps(w, buyer, seller.name, pinStore);
		const c0 = await view(d0);
		await c0.sendMessage('v2 first');
		expect((d0.sent[0]!.header as Record<string, unknown>).v).toBe(2);
		c0.destroy();
		// The seller's key goes stale on their side: they write v3.
		const sd = await view(
			deps(w, seller, buyer.name, { ...pinStore, myChatKeyStatus: async () => 'stale' })
		);
		await sd.sendMessage('my key changed, write to my posting key');
		sd.destroy();
		const d = deps(w, buyer, seller.name, pinStore);
		const c = await view(d);
		const theirs = c.snapshot().find((x) => x.sender === seller.name)!;
		expect(theirs.senderUnverified ?? false).toBe(false);
		await c.sendMessage('answered in v3');
		expect((d.sent[0]!.header as Record<string, unknown>).v).toBe(3);
		c.destroy();
	});
});

describe('smaller gaps (review 2, lows)', () => {
	it('a message made for another posting key of our account says so', async () => {
		const w = world([]);
		const otherKey = party(seller.name);
		w.postingKeys.set(seller.name, [otherKey.pub]); // the buyer encrypts to the seller's OTHER key
		const bd = await view(deps(w, buyer, seller.name));
		await bd.sendMessage('for the other key');
		bd.destroy();
		const sc = await view(deps(w, seller, buyer.name)); // this session holds seller.priv
		const m = sc.snapshot()[0]!;
		expect([m.decryptFailed, m.decryptFailedReason]).toEqual([true, 'other_key']);
		sc.destroy();
	});

	it('"no posting key of its own" is not remembered: once it has one, the next send goes', async () => {
		const w = world([]);
		w.postingKeys.set(seller.name, []);
		const c = await view(deps(w, buyer, seller.name));
		await c.sendMessage('one');
		expect(c.snapshot()[0]!.error).toBe(PEER_NO_POSTING_KEY_SENTINEL);
		w.postingKeys.set(seller.name, [seller.pub]);
		await c.sendMessage('two');
		expect(c.snapshot()[1]!.error).toBeNull();
		c.destroy();
	});

	it('a failed chat-key lookup is asked again only after a pause; Retry asks at once', async () => {
		const w = world([buyer.name]);
		let down = true;
		const peerAsked = vi.fn(async () => {
			if (down) throw new Error('timed out');
			return null;
		});
		const d = deps(w, buyer, seller.name, { fetchPeerChatPub: peerAsked });
		const c = await view(d);
		expect(peerAsked).toHaveBeenCalledTimes(1);
		await c.sendMessage('one');
		await c.sendMessage('two');
		expect(peerAsked).toHaveBeenCalledTimes(1);
		down = false;
		await c.retryMessage(c.snapshot()[0]!.localSeq);
		expect(peerAsked).toHaveBeenCalledTimes(2);
		expect(c.snapshot()[0]!.error).toBeNull();
		c.destroy();
	});

	it('a long history pauses for the page every few messages', async () => {
		const w = world([]);
		const sd = await view(deps(w, seller, buyer.name));
		for (let i = 0; i < 2 * DECRYPT_YIELD_EVERY + 1; i++) await sd.sendMessage(`m${i}`);
		sd.destroy();
		const yields = vi.fn(async () => undefined);
		const c = await view(deps(w, buyer, seller.name, { yieldToMain: yields }));
		expect(c.snapshot()).toHaveLength(2 * DECRYPT_YIELD_EVERY + 1);
		expect(yields).toHaveBeenCalledTimes(2);
		c.destroy();
	});

	it('lock / sign-out wipes the cached posting-key reader', async () => {
		const w = world([]);
		const sd = await view(deps(w, seller, buyer.name));
		await sd.sendMessage('x');
		sd.destroy();
		const c = await view(deps(w, buyer, seller.name));
		c.destroy();
		const reader = __cachedPostingReader();
		expect(reader?.dh2.size).toBe(1);
		clearOwnSentPlaintextCache();
		expect(__cachedPostingReader()).toBeNull();
		expect(reader!.dh2.size).toBe(0);
	});
});

describe('pins a Lock sealed are waited for (review 2, low 1)', () => {
	async function sealedPinLandingLater(): Promise<{ visible: () => boolean }> {
		const { setUnsealPending } = await import('./unsealGate');
		let visible = false;
		setUnsealPending(
			new Promise<void>((r) =>
				setTimeout(() => {
					visible = true;
					r();
				}, 0)
			)
		);
		return { visible: () => visible };
	}
	afterEach(async () => {
		(await import('./unsealGate')).setUnsealPending(Promise.resolve());
	});

	it('receive: a chat pin still being unsealed is honoured — no posting keys pinned on first use', async () => {
		const w = world([]);
		const sd = await view(deps(w, seller, buyer.name));
		await sd.sendMessage('hello');
		sd.destroy();
		const gate = await sealedPinLandingLater();
		const c = createConversationController(
			deps(w, buyer, seller.name, {
				pinPostingKey: pinPostingKeyInStore,
				pinnedPostingKeys: pinnedPostingKeysInStore,
				pinnedPeerPubs: () => (gate.visible() ? [new Uint8Array(32).fill(9)] : [])
			})
		);
		c.start();
		await vi.runOnlyPendingTimersAsync();
		await vi.runOnlyPendingTimersAsync();
		expect(c.snapshot().map((m) => [m.text, m.senderUnverified])).toEqual([['hello', true]]);
		expect(pinnedPostingFor(seller.name)).toEqual([]);
		c.destroy();
	});

	it('send: a chat pin still being unsealed counts — the indexer saying "none" is refused', async () => {
		const w = world([buyer.name]);
		const gate = await sealedPinLandingLater();
		const d = deps(w, buyer, seller.name, {
			pinnedPeerPubs: () => (gate.visible() ? [new Uint8Array(32).fill(9)] : [])
		});
		const c = createConversationController(d);
		c.start();
		const sending = c.sendMessage('x');
		await vi.runOnlyPendingTimersAsync();
		await sending;
		expect(c.snapshot()[0]!.error).toBe('pub_pin_withdrawn');
		expect(d.sent).toHaveLength(0);
		c.destroy();
	});
});
