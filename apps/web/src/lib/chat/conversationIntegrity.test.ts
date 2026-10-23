/**
 * v1.21.14 full chat audit — the conversation controller's own findings:
 *
 *   W-H3  a copy with the SAME encrypted bytes is the same message, whatever
 *         its client tag (the tag is outside the encryption: a hostile
 *         operator could re-serve an old message under a new one);
 *   W-M1  scrolling back to an old message never changes the format we answer
 *         in (it used to follow the last proved message OPENED; since v1.21.14
 *         every message is in the posting-key format, whatever was read);
 *   W-M8  a first-contact key lookup that could not be made is not a
 *         decryption failure: the message is opened again when it next comes;
 *   W-L1  messages that arrived while the session was locked are opened
 *         after the unlock, in a view that stayed mounted;
 *   W-L3  an unchanged poll answer changes nothing and redraws nothing;
 *   W-L5  sendMessage says whether the node took the message;
 *   W-M5  a message whose ciphertext the indexer would refuse is never
 *         broadcast (no fee for a message that cannot be delivered).
 *
 * The real controller and payload codec; the crypto and network are faked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { get } from 'svelte/store';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
// Stream tickets need the signed-in session (identity store); not under test here.
vi.mock('$lib/chat/streamTicket', () => ({ withStreamTicket: (p: string) => `${p}?ticket=t` }));

import {
	createConversationController,
	clearOwnSentPlaintextCache,
	MESSAGE_TOO_LONG_SENTINEL,
	SESSION_LOCKED_SENTINEL,
	type ChatControllerDeps,
	type LocalMessage
} from '$lib/chat/chatService';
import { encodeAddressPayload, MAX_CHAT_CIPHERTEXT_CHARS } from '$lib/chat/payload';
import * as ts from '$lib/trades/tradeStatus';
import type { ChatMessageRecord } from '@morphit/indexer-client';

const ORDER = 'bob-sells-blurt';
const b64 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
const unb64 = (s: string) =>
	new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)));

function rec(over: Partial<ChatMessageRecord> & { text?: string; v?: 2 | 3 }): ChatMessageRecord {
	const { text, v, ...rest } = over;
	const ct = b64(text ?? 'hello');
	return {
		id: 1,
		sender: 'bob',
		recipient: 'alice',
		ciphertext: ct,
		header:
			v === 3
				? {
						v: 3,
						ephemeral_pub: `E${ct}`,
						nonce: `N${ct}`,
						sk: 's',
						rk: ['r'],
						wk: ['w'],
						client_tag: '1'.repeat(32)
					}
				: { v: 2, ephemeral_pub: `E${ct}`, nonce: `N${ct}`, client_tag: '1'.repeat(32) },
		created_at: '2026-10-21T12:00:00.000Z',
		order_permlink: ORDER,
		...rest
	} as ChatMessageRecord;
}

interface Rig {
	deliver(items: ChatMessageRecord[]): Promise<void>;
	snap(): readonly LocalMessage[];
	emits: () => number;
	ctrl: ReturnType<typeof createConversationController>;
}

function rig(over: Partial<ChatControllerDeps> = {}): Rig {
	let snapH: ((i: readonly ChatMessageRecord[]) => void) | null = null;
	let emits = 0;
	const deps: ChatControllerDeps = {
		me: 'alice',
		peer: 'bob',
		orderPermlink: ORDER,
		getLiveIdentity: () => ({}) as never,
		now: () => new Date(),
		visibilityState: () => 'visible',
		onVisibilityChange: () => () => undefined,
		generateClientTag: () => 'a'.repeat(32),
		fetchHistory: async () => ({ ok: true, items: [], nextCursor: null }),
		broadcast: async () => ({ block_num: null, trx_id: 'b'.repeat(40) }),
		fetchPeerChatPub: async () => new Uint8Array(32).fill(7),
		deriveMyChatIdentity: async () => ({
			priv: new Uint8Array(32).fill(1),
			pub: new Uint8Array(32)
		}),
		fetchPostingPubs: async () => [new Uint8Array(33).fill(2)],
		encryptPosting: async (p: string) => ({ ciphertext: b64(p), ephemeralPub: 'e', nonce: 'n' }),
		decrypt: async (env) => ({ text: unb64(env.ciphertext), authenticated: true }),
		pinnedPeerPubs: () => [new Uint8Array(32).fill(7)],
		onChange: () => {
			emits++;
		},
		subscribeStream: (h) => {
			snapH = h.onSnapshot;
			return () => undefined;
		},
		...over
	};
	const ctrl = createConversationController(deps);
	ctrl.start();
	ctrls.push(ctrl);
	return {
		ctrl,
		async deliver(items) {
			snapH?.(items);
			await vi.advanceTimersByTimeAsync(0);
		},
		snap: () => ctrl.snapshot(),
		emits: () => emits
	};
}

let ctrls: { destroy(): void }[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(new Date('2026-10-21T12:00:00Z'));
	ts.clearAllTradeStates();
	// Unconfirmed / unsent own sends are kept past a view: start each test clean.
	clearOwnSentPlaintextCache();
});
afterEach(() => {
	for (const c of ctrls) c.destroy();
	ctrls = [];
	vi.useRealTimers();
});

describe('W-H3: the same bytes under a new tag are not a new message', () => {
	const oldAddr = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'bobold',
		amount: '10',
		orderPermlink: ORDER
	});
	const newAddr = encodeAddressPayload({
		v: 1,
		kind: 'morphit_addr',
		method: 'blurt',
		address: 'bobnew',
		amount: '10',
		orderPermlink: ORDER
	});

	it('an old address re-served (provisional, fresh tag) is neither shown again nor re-applied', async () => {
		const r = rig();
		const old = rec({ id: 1, text: oldAddr, created_at: '2026-10-21T11:00:00.000Z' });
		await r.deliver([rec({ id: 2, text: newAddr }), old]);
		expect(ts.getTradeState('bob', ORDER)?.address).toBe('bobnew');
		const replay = {
			...old,
			id: 0,
			header: { ...(old.header as object), client_tag: 'f'.repeat(32) }
		};
		await r.deliver([replay as ChatMessageRecord]);
		expect(r.snap()).toHaveLength(2);
		expect(ts.getTradeState('bob', ORDER)?.address).toBe('bobnew');
	});

	it('…nor with the tag removed, nor as a second durable row', async () => {
		const r = rig();
		const old = rec({ id: 1, text: 'pay me' });
		await r.deliver([old]);
		await r.deliver([
			{ ...old, id: 9, header: { ...(old.header as object), client_tag: undefined } }
		]);
		expect(r.snap()).toHaveLength(1);
	});

	it('one of OUR messages re-served under another tag is not shown twice', async () => {
		const r = rig({
			decryptSelfCopy: async () => 'my words'
		});
		const mine = rec({
			id: 3,
			sender: 'alice',
			recipient: 'bob',
			text: 'mine',
			header: {
				v: 2,
				ephemeral_pub: 'E',
				nonce: 'N',
				client_tag: 'd'.repeat(32),
				self_ciphertext: 's',
				self_nonce: 'n'
			}
		});
		await r.deliver([mine]);
		await r.deliver([
			{ ...mine, id: 0, header: { ...(mine.header as object), client_tag: 'e'.repeat(32) } }
		]);
		expect(r.snap()).toHaveLength(1);
	});
});

describe('W-M1: what was read never decides the format of the next send', () => {
	const encryptPosting = () =>
		vi.fn(async () => ({
			v: 3 as const,
			ciphertext: 'x',
			ephemeralPub: 'e',
			nonce: 'n',
			senderKey: 's',
			recipientKeys: ['r'],
			wraps: ['w']
		}));

	it('scrolling back to an old chat-key message: the next send is in the posting-key format', async () => {
		const enc = encryptPosting();
		const sent: Record<string, unknown>[] = [];
		const newest = rec({ id: 10, v: 3, text: 'new v3', created_at: '2026-10-21T12:00:00.000Z' });
		const older = rec({ id: 5, v: 2, text: 'old v2', created_at: '2026-10-01T12:00:00.000Z' });
		const r = rig({
			encryptPosting: enc,
			broadcast: async (_l, payload) => {
				sent.push(payload);
				return { block_num: null, trx_id: 'b'.repeat(40) };
			},
			decryptPosting: async () => ({ text: 'new v3', authenticated: true }),
			pinnedPostingKeys: () => [new Uint8Array(33)],
			fetchHistory: async (_a, _b, o) =>
				o.cursor === undefined
					? { ok: true, items: [newest], nextCursor: 'c1' }
					: { ok: true, items: [older], nextCursor: null }
		});
		await r.deliver([newest]);
		await r.ctrl.loadOlder();
		await r.ctrl.loadOlder();
		expect(r.snap().map((m) => m.text)).toContain('old v2');
		await r.ctrl.sendMessage('reply');
		expect(enc).toHaveBeenCalledTimes(1);
		expect((sent[0]!.header as Record<string, unknown>).v).toBe(3);
	});

	it('the peer’s NEWEST message in the chat-key format: still the posting-key format', async () => {
		const enc = encryptPosting();
		const r = rig({
			encryptPosting: enc,
			decryptPosting: async () => ({ text: 'v3', authenticated: true }),
			pinnedPostingKeys: () => [new Uint8Array(33)]
		});
		await r.deliver([rec({ id: 1, v: 3, text: 'v3', created_at: '2026-10-21T11:00:00.000Z' })]);
		await r.deliver([rec({ id: 2, v: 2, text: 'v2', created_at: '2026-10-21T11:30:00.000Z' })]);
		await r.ctrl.sendMessage('answer');
		expect(enc).toHaveBeenCalledTimes(1);
	});
});

describe('W-M8: a key lookup that could not be made is retried, not a failure', () => {
	it('an older-format message whose sender key could not be read: shown unopened, opened when it comes again', async () => {
		let works = false;
		const r = rig({
			fetchPeerChatPub: async () => {
				if (!works) throw new Error('relay timed out');
				return new Uint8Array(32).fill(7);
			},
			// No chat key pinned (nothing pins one since v1.21.14).
			pinnedPeerPubs: () => [],
			decrypt: async (env, _p, _q, _s, _r, pubs) =>
				pubs && pubs.length > 0 ? { text: unb64(env.ciphertext), authenticated: true } : null
		});
		const m = rec({ id: 9, text: 'I sent 500 BLURT' });
		await r.deliver([m]);
		expect(r.snap()[0]?.decryptFailed).toBe(false);
		expect(r.snap()[0]?.reopen).toBe(true);
		works = true;
		// The failed lookup is asked again after KEY_LOOKUP_RETRY_MS.
		await vi.advanceTimersByTimeAsync(31_000);
		await r.deliver([m]);
		expect(r.snap()[0]?.text).toBe('I sent 500 BLURT');
		expect(r.snap()[0]?.decryptFailed).toBe(false);
		expect(r.snap()[0]?.reopen).toBeUndefined();
		// Opened with a key that is not pinned: readable, the calm note.
		expect([r.snap()[0]?.senderUnverified, r.snap()[0]?.olderFormat]).toEqual([true, true]);
	});

	it('a pin verdict (not a failed lookup) stays a failure', async () => {
		const { PubPinError, PUB_PIN_ERROR } = await import('$lib/chat/pubPin');
		const r = rig({
			fetchPeerChatPub: async () => {
				throw new PubPinError(PUB_PIN_ERROR.tampered_same_ref, 'bob', 'x');
			},
			pinnedPeerPubs: () => [],
			decrypt: async () => null
		});
		await r.deliver([rec({ id: 9, text: 'x' })]);
		expect(r.snap()[0]?.decryptFailed).toBe(true);
		expect(r.snap()[0]?.reopen).toBeUndefined();
	});

	it('a posting-key message whose sender keys could not be read (a 502) is proved later', async () => {
		let works = false;
		const r = rig({
			fetchPostingPubs: async () => {
				if (!works) throw new Error('indexer /v1/account/:name/keys returned 502');
				return [new Uint8Array(33).fill(2)];
			},
			pinnedPostingKeys: () => [],
			decryptPosting: async (_e, _l, _s, _r, pubs) => ({
				text: 'paid',
				authenticated: pubs.length > 0
			})
		});
		const m = rec({ id: 4, v: 3, text: 'paid' });
		await r.deliver([m]);
		expect(r.snap()[0]?.senderUnverified).toBe(true);
		expect(r.snap()[0]?.reopen).toBe(true);
		works = true;
		await vi.advanceTimersByTimeAsync(31_000);
		await r.deliver([m]);
		expect(r.snap()[0]?.senderUnverified).toBeUndefined();
		expect(r.snap()[0]?.reopen).toBeUndefined();
	});

	it('reopened and now proved: its trade effects run once', async () => {
		let works = false;
		const r = rig({
			fetchPostingPubs: async () => {
				if (!works) throw new Error('indexer /v1/account/:name/keys returned 502');
				return [new Uint8Array(33).fill(2)];
			},
			pinnedPostingKeys: () => [],
			decryptPosting: async (env, _l, _s, _r, pubs) => ({
				text: unb64(env.ciphertext),
				authenticated: pubs.length > 0
			})
		});
		const m = rec({
			id: 9,
			v: 3,
			text: encodeAddressPayload({
				v: 1,
				kind: 'morphit_addr',
				method: 'blurt',
				address: 'bob',
				orderPermlink: ORDER
			})
		});
		await r.deliver([m]);
		expect(get(ts.tradeStates).size).toBe(0);
		works = true;
		await vi.advanceTimersByTimeAsync(31_000);
		await r.deliver([m]);
		expect(ts.getTradeState('bob', ORDER)?.address).toBe('bob');
	});
});

describe('W-L1: locked, then unlocked with the view still open', () => {
	it('the peer’s messages merged while locked are opened after the unlock', async () => {
		let live: unknown = {};
		const r = rig({ getLiveIdentity: () => live as never });
		const m = rec({ id: 5, text: 'pay me at @bob' });
		await r.deliver([m]);
		live = null;
		clearOwnSentPlaintextCache(); // lockSession()
		await r.deliver([m]);
		expect(r.snap()[0]?.text).toBe('(encrypted)');
		live = {}; // another tab hands the session back
		await r.deliver([m]);
		expect(r.snap().map((x) => x.text)).toEqual(['pay me at @bob']);
	});

	it('our own messages merged while locked are opened after the unlock', async () => {
		let live: unknown = {};
		const r = rig({
			getLiveIdentity: () => live as never,
			decryptSelfCopy: async () => 'my words'
		});
		const mine = rec({
			id: 3,
			sender: 'alice',
			recipient: 'bob',
			text: 'x',
			header: {
				v: 2,
				ephemeral_pub: 'E',
				nonce: 'N',
				client_tag: 'd'.repeat(32),
				self_ciphertext: 's',
				self_nonce: 'n'
			}
		});
		live = null;
		clearOwnSentPlaintextCache();
		await r.deliver([mine]);
		expect(r.snap()[0]?.text).toBe('(encrypted)');
		live = {};
		await r.deliver([mine]);
		expect(r.snap().map((x) => x.text)).toEqual(['my words']);
	});
});

describe('W-L3: an unchanged answer changes nothing', () => {
	it('five identical answers after the first redraw nothing', async () => {
		const r = rig({ decryptSelfCopy: async () => 'my words' });
		const own = rec({
			id: 3,
			sender: 'alice',
			recipient: 'bob',
			header: {
				v: 2,
				ephemeral_pub: 'E',
				nonce: 'N',
				client_tag: 'd'.repeat(32),
				self_ciphertext: 's',
				self_nonce: 'n'
			}
		});
		const theirs = rec({ id: 4, text: 'hi' });
		await r.deliver([theirs, own]);
		const after = r.emits();
		for (let i = 0; i < 5; i++) await r.deliver([theirs, own]);
		expect(r.emits()).toBe(after);
	});

	it('a retry copy folded in once is not opened and folded again on every poll', async () => {
		const decrypt = vi.fn(async (env: { ciphertext: string }) => ({
			text: unb64(env.ciphertext),
			authenticated: true
		}));
		const r = rig({ decrypt });
		const first = rec({ id: 0, text: 'same words' });
		const retry = rec({
			id: 0,
			text: 'same words',
			header: {
				v: 2,
				ephemeral_pub: 'E2',
				nonce: 'N2',
				client_tag: '2'.repeat(32),
				prior_tags: ['1'.repeat(32)]
			}
		});
		await r.deliver([first]);
		await r.deliver([retry]);
		expect(r.snap()).toHaveLength(1);
		const calls = decrypt.mock.calls.length;
		const emitted = r.emits();
		for (let i = 0; i < 3; i++) await r.deliver([retry]);
		expect(decrypt.mock.calls.length).toBe(calls);
		expect(r.emits()).toBe(emitted);
	});

	it('after a lock, a folded retry copy shows again (nothing remembered across the lock)', async () => {
		let live: unknown = {};
		const r = rig({ getLiveIdentity: () => live as never });
		const first = rec({ id: 0, text: 'same words' });
		const retry = rec({
			id: 0,
			text: 'same words',
			header: {
				v: 2,
				ephemeral_pub: 'E2',
				nonce: 'N2',
				client_tag: '2'.repeat(32),
				prior_tags: ['1'.repeat(32)]
			}
		});
		await r.deliver([first]);
		await r.deliver([retry]);
		live = null;
		clearOwnSentPlaintextCache();
		live = {};
		await r.deliver([retry]);
		expect(r.snap().map((m) => m.text)).toEqual(['same words']);
	});

	it('…but a copy that DOES change something still redraws', async () => {
		const r = rig();
		await r.deliver([rec({ id: 0, text: 'hi' })]);
		const after = r.emits();
		await r.deliver([rec({ id: 77, text: 'hi' })]); // its durable copy
		expect(r.emits()).toBe(after + 1);
		expect(r.snap()[0]?.id).toBe(77);
	});
});

describe('W-L5: sendMessage says how the send went', () => {
	it('taken by the node: ok', async () => {
		const r = rig();
		expect(await r.ctrl.sendMessage('hi')).toEqual({ ok: true });
	});

	it('refused by the node: not ok, and the bubble is failed', async () => {
		const r = rig({
			broadcast: async () => {
				throw new Error('insufficient funds');
			}
		});
		const out = await r.ctrl.sendMessage('hi');
		expect(out.ok).toBe(false);
		expect(r.snap()[0]?.state).toBe('failed');
	});

	it('refused, but our own copy already came back: it was delivered (ok)', async () => {
		let release: (e: Error) => void = () => undefined;
		let snapH: ((i: readonly ChatMessageRecord[]) => void) | null = null;
		const r = rig({
			broadcast: () =>
				new Promise((_res, rej) => {
					release = rej;
				}),
			subscribeStream: (h) => {
				snapH = h.onSnapshot;
				return () => undefined;
			}
		});
		const p = r.ctrl.sendMessage('hi');
		await vi.advanceTimersByTimeAsync(0);
		snapH!([
			rec({
				id: 0,
				sender: 'alice',
				recipient: 'bob',
				header: { v: 2, ephemeral_pub: 'E', nonce: 'N', client_tag: 'a'.repeat(32) }
			})
		]);
		await vi.advanceTimersByTimeAsync(0);
		release(new Error('response lost on the wire'));
		expect(await p).toEqual({ ok: true });
	});

	it('nothing to send, or locked: not ok', async () => {
		const r = rig({ getLiveIdentity: () => null });
		expect((await r.ctrl.sendMessage('   ')).ok).toBe(false);
		expect(await r.ctrl.sendMessage('hi')).toEqual({ ok: false, error: SESSION_LOCKED_SENTINEL });
	});
});

describe('W-M5: never broadcast what the indexer will refuse', () => {
	it('a ciphertext over the cap: failed with "too long", nothing broadcast', async () => {
		const broadcast = vi.fn(async () => ({ block_num: null, trx_id: 'b'.repeat(40) }));
		const r = rig({
			broadcast,
			encryptPosting: async () => ({
				v: 3,
				ciphertext: 'A'.repeat(MAX_CHAT_CIPHERTEXT_CHARS + 4),
				ephemeralPub: 'e',
				nonce: 'n'
			})
		});
		const out = await r.ctrl.sendMessage('long');
		expect(out).toEqual({ ok: false, error: MESSAGE_TOO_LONG_SENTINEL });
		expect(broadcast).not.toHaveBeenCalled();
		expect(r.snap()[0]?.error).toBe(MESSAGE_TOO_LONG_SENTINEL);
	});

	it('…the self-copy over the cap too', async () => {
		const broadcast = vi.fn(async () => ({ block_num: null, trx_id: 'b'.repeat(40) }));
		const r = rig({
			broadcast,
			encryptPosting: async () => ({
				v: 3,
				ciphertext: 'AAAA',
				ephemeralPub: 'e',
				nonce: 'n',
				selfCiphertext: 'A'.repeat(MAX_CHAT_CIPHERTEXT_CHARS + 4),
				selfNonce: 'n'
			})
		});
		expect((await r.ctrl.sendMessage('long')).ok).toBe(false);
		expect(broadcast).not.toHaveBeenCalled();
	});

	it('exactly at the cap: sent', async () => {
		const broadcast = vi.fn(async () => ({ block_num: null, trx_id: 'b'.repeat(40) }));
		const r = rig({
			broadcast,
			encryptPosting: async () => ({
				v: 3,
				ciphertext: 'A'.repeat(MAX_CHAT_CIPHERTEXT_CHARS),
				ephemeralPub: 'e',
				nonce: 'n',
				selfCiphertext: 'A'.repeat(MAX_CHAT_CIPHERTEXT_CHARS),
				selfNonce: 'n'
			})
		});
		expect((await r.ctrl.sendMessage('ok')).ok).toBe(true);
		expect(broadcast).toHaveBeenCalledTimes(1);
	});
});
