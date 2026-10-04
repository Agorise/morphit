/**
 * The "safety number changed" step cannot be skipped:
 *
 *   - an explicit Lock does not forget who has which key: the pins are sealed
 *     (unreadable on disk, no peer names) and come back at the next unlock of
 *     the same account, so a key the operator substitutes after a lock is
 *     still held back for confirmation;
 *   - after an accepted key change, the REPLACED key opens older messages for
 *     reading only — a message made with it never counts as sent by the peer,
 *     so it never moves a trade.
 *
 * Real pubPin, explicit-lock, identity store and chat crypto; browser storage
 * is an in-memory stand-in.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import sodium from 'libsodium-wrappers-sumo';

vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
vi.hoisted(() => {
	const area = () => {
		const m = new Map<string, string>();
		return {
			getItem: (k: string) => m.get(k) ?? null,
			setItem: (k: string, v: string) => void m.set(k, String(v)),
			removeItem: (k: string) => void m.delete(k),
			clear: () => m.clear(),
			key: (i: number) => [...m.keys()][i] ?? null,
			get length() {
				return m.size;
			}
		};
	};
	const g = globalThis as Record<string, unknown>;
	g.localStorage = area();
	g.sessionStorage = area();
	g.window = g;
	g.addEventListener = () => {};
	g.removeEventListener = () => {};
	g.dispatchEvent = () => true;
});

const recordFundsSent = vi.fn();
vi.mock('$lib/trades/tradeStatus', async (orig) => ({
	...(await orig<typeof import('$lib/trades/tradeStatus')>()),
	recordAddressShared: vi.fn(),
	recordFundsSent: (...a: unknown[]) => recordFundsSent(...a)
}));
vi.mock('$lib/trades/tradeVerify', () => ({ triggerBlurtVerification: vi.fn() }));

const T1 = 'a'.repeat(40);
const T2 = 'b'.repeat(40);
/** The operator's relay: answers whatever the indexer said. */
const relay = async (_p: string, ref: { blockNum: number; trxId: string; pubB64: string }) => ({
	chatPubB64: ref.pubB64,
	blockNum: ref.blockNum,
	trxId: ref.trxId
});

beforeAll(async () => {
	await sodium.ready;
});
beforeEach(() => {
	window.localStorage.clear();
	window.sessionStorage.clear();
	recordFundsSent.mockClear();
});
afterEach(async () => {
	const { reset } = await import('$stores/identity');
	reset();
});

function liveFor(seed: number) {
	return {
		createdAt: 1,
		origin: 'posting-only',
		posting: {
			role: 'posting',
			publicKey: new Uint8Array(33).fill(2),
			privateKey: new Uint8Array(32).fill(seed)
		},
		memo: null,
		ownerPublicKey: null,
		activePublicKey: null
	};
}
const ENV = {
	v: 1,
	kdf: 'argon2id',
	kdfParams: { opslimit: 2, memlimit: 64 * 1024 * 1024 },
	salt: 'c2FsdA==',
	nonce: 'bm9uY2U=',
	ciphertext: 'Y3Q=',
	createdAt: 1
};
async function unlockAs(seed: number) {
	const id = await import('$stores/identity');
	id.handleSessionHandoffMessage(
		{ t: 'offer', payload: { state: 'unlocked', live: liveFor(seed), envelope: ENV } } as never,
		() => {}
	);
}
/** How many sealed pin slots are on disk (one per account that locked). */
function sealCount(): number {
	let n = 0;
	for (let i = 0; i < window.localStorage.length; i++) {
		if (window.localStorage.key(i)!.startsWith('morphit.chat.pub_pin_sealed')) n++;
	}
	return n;
}
/** The operator substitutes bob's key: refused, or resolved without a word? */
async function substitute(pp: typeof import('$lib/chat/pubPin')): Promise<string> {
	return pp
		.resolveChatPubFromIndexer('bob', { blockNum: 20, trxId: T2, pubB64: 'OPERATORKEY' }, relay)
		.then(
			(v) => `resolved silently to ${v}`,
			(e: { code?: string }) => `refused: ${e.code}`
		);
}
/** Account `seed` meets bob, then Lock (extras, then the lock — the menu's order). */
async function meetBobAndLock(seed: number): Promise<void> {
	const pp = await import('$lib/chat/pubPin');
	await unlockAs(seed);
	await pp.resolveChatPubFromIndexer('bob', { blockNum: 10, trxId: T1, pubB64: 'BOBKEY' }, relay);
	const before = sealCount();
	const { runExplicitLockExtras } = await import('$lib/chat/explicitLock');
	const { lockSession } = await import('$stores/identity');
	runExplicitLockExtras();
	lockSession();
	await vi.waitFor(() => expect(sealCount()).toBeGreaterThan(before)).catch(() => undefined);
}
/** Unlock as `seed` and give the async unseal time to land. */
async function unlockAndSettle(seed: number): Promise<void> {
	const pp = await import('$lib/chat/pubPin');
	await unlockAs(seed);
	await vi
		.waitFor(() => expect(pp.getPin('bob')).not.toBeNull(), { timeout: 500 })
		.catch(() => undefined);
}

function everythingStored(): string {
	let out = '';
	for (const s of [window.localStorage, window.sessionStorage]) {
		for (let i = 0; i < s.length; i++) out += `${s.key(i)}=${s.getItem(s.key(i)!)}\n`;
	}
	return out;
}

describe('an explicit Lock keeps the key-change step', () => {
	it('a key substituted after Lock + unlock is still held back as "key changed"', async () => {
		const pp = await import('$lib/chat/pubPin');
		await unlockAs(7);
		expect(
			await pp.resolveChatPubFromIndexer(
				'bob',
				{ blockNum: 10, trxId: T1, pubB64: 'BOBKEY' },
				relay
			)
		).toBe('BOBKEY');
		const { runExplicitLockExtras } = await import('$lib/chat/explicitLock');
		const { lockSession } = await import('$stores/identity');
		runExplicitLockExtras();
		lockSession();
		// The seal is written asynchronously.
		await vi.waitFor(() => expect(sealCount()).toBeGreaterThan(0)).catch(() => undefined);
		// Nothing readable names the peer while locked.
		expect(everythingStored()).not.toContain('bob');
		expect(everythingStored()).not.toContain('BOBKEY');

		await unlockAs(7);
		// Unsealed asynchronously.
		await vi.waitFor(() => expect(pp.getPin('bob')).not.toBeNull()).catch(() => undefined);
		const err = await pp
			.resolveChatPubFromIndexer('bob', { blockNum: 20, trxId: T2, pubB64: 'OPERATORKEY' }, relay)
			.then(
				() => null,
				(e: unknown) => e
			);
		expect((err as { code?: string } | null)?.code).toBe('pub_pin_key_changed');
	});

	it("another account's unlock cannot read or use the sealed pins", async () => {
		const pp = await import('$lib/chat/pubPin');
		await unlockAs(7);
		await pp.resolveChatPubFromIndexer('bob', { blockNum: 10, trxId: T1, pubB64: 'BOBKEY' }, relay);
		const { runExplicitLockExtras } = await import('$lib/chat/explicitLock');
		const { lockSession } = await import('$stores/identity');
		runExplicitLockExtras();
		lockSession();
		await vi.waitFor(() => expect(sealCount()).toBeGreaterThan(0));
		await unlockAs(9);
		// Give a wrong unseal every chance to show up.
		await vi
			.waitFor(() => expect(pp.getPin('bob')).not.toBeNull(), { timeout: 300 })
			.catch(() => undefined);
		expect(pp.getPin('bob')).toBeNull();
		expect(sealCount()).toBeGreaterThan(0);
	});
});

describe('sealed pins belong to one account', () => {
	it('Lock run in the other order (lock first, then the extras) does not lose the pins', async () => {
		const pp = await import('$lib/chat/pubPin');
		await unlockAs(7);
		await pp.resolveChatPubFromIndexer('bob', { blockNum: 10, trxId: T1, pubB64: 'BOBKEY' }, relay);
		const { runExplicitLockExtras } = await import('$lib/chat/explicitLock');
		const { lockSession } = await import('$stores/identity');
		lockSession();
		runExplicitLockExtras();
		await unlockAndSettle(7);
		expect(await substitute(pp)).toBe('refused: pub_pin_key_changed');
	});

	it("a second account's Lock on the same browser leaves the first account's seal", async () => {
		const pp = await import('$lib/chat/pubPin');
		await meetBobAndLock(7); // account A
		await unlockAs(9); // account B: meets carol, then Lock
		await pp.resolveChatPubFromIndexer(
			'carol',
			{ blockNum: 11, trxId: 'c'.repeat(40), pubB64: 'CAROLKEY' },
			relay
		);
		const { runExplicitLockExtras } = await import('$lib/chat/explicitLock');
		const { lockSession } = await import('$stores/identity');
		const before = sealCount();
		runExplicitLockExtras();
		lockSession();
		await vi.waitFor(() => expect(sealCount()).toBeGreaterThan(before)).catch(() => undefined);
		await unlockAndSettle(7); // account A again
		expect(await substitute(pp)).toBe('refused: pub_pin_key_changed');
	});

	it("a second account's Sign Out on the same browser leaves the first account's seal", async () => {
		const pp = await import('$lib/chat/pubPin');
		await meetBobAndLock(7); // account A
		await unlockAs(9); // account B signs in, then signs out
		const { broadcastSignOut } = await import('$stores/identity');
		// The sign-out finishes in steps (chat reset, re-sweeps up to ~1 s later):
		// let all of it run before A comes back.
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
		broadcastSignOut();
		await vi.dynamicImportSettled();
		await vi.advanceTimersByTimeAsync(2_000);
		vi.useRealTimers();
		await unlockAndSettle(7); // account A again
		expect(await substitute(pp)).toBe('refused: pub_pin_key_changed');
	});
});

describe('the unlock restores the seal before anything relies on it', () => {
	it('a key looked up right after unlock, before the unseal lands, is still compared', async () => {
		const pp = await import('$lib/chat/pubPin');
		await meetBobAndLock(7);
		await unlockAs(7);
		expect(await substitute(pp)).toBe('refused: pub_pin_key_changed');
	});

	it("a Lock that lands before the unlock's unseal leaves nothing readable, and the pins kept", async () => {
		const pp = await import('$lib/chat/pubPin');
		const { runExplicitLockExtras } = await import('$lib/chat/explicitLock');
		const { lockSession } = await import('$stores/identity');
		await meetBobAndLock(7);
		await unlockAs(7);
		runExplicitLockExtras(); // at once: the unlock's unseal has not landed
		lockSession();
		// Give a late unseal every chance to put the pins back readable.
		await vi
			.waitFor(() => expect(everythingStored()).toContain('BOBKEY'), { timeout: 300 })
			.catch(() => undefined);
		expect(everythingStored()).not.toContain('BOBKEY');
		expect(sealCount()).toBeGreaterThan(0);
		await unlockAndSettle(7);
		expect(await substitute(pp)).toBe('refused: pub_pin_key_changed');
	});
});

describe('a replaced chat key reads history, never authenticates', () => {
	it('a NEW message made with the replaced key is not counted as from the peer', async () => {
		const pp = await import('$lib/chat/pubPin');
		const chat = await import('$lib/chat/crypto');
		const { createConversationController } = await import('$lib/chat/chatService');
		const b64 = (u: Uint8Array) => sodium.to_base64(u, sodium.base64_variants.ORIGINAL);
		const me = await chat.deriveChatIdentity(sodium.randombytes_buf(32), 'bob');
		const oldAlice = await chat.deriveChatIdentity(sodium.randombytes_buf(32), 'alice');
		const newAlice = await chat.deriveChatIdentity(sodium.randombytes_buf(32), 'alice');
		await pp.resolveChatPubFromIndexer(
			'alice',
			{ blockNum: 10, trxId: T1, pubB64: b64(oldAlice.pub) },
			relay
		);
		await pp
			.resolveChatPubFromIndexer(
				'alice',
				{ blockNum: 20, trxId: T2, pubB64: b64(newAlice.pub) },
				relay
			)
			.catch(() => {});
		expect(pp.acceptKeyChange('alice')).toBe(true);

		const FUNDS = JSON.stringify({
			v: 1,
			kind: 'morphit_funds_sent',
			method: 'blurt',
			txid: 'c'.repeat(40),
			amount: '10.000',
			order_permlink: 'order-1'
		});
		// Whoever holds alice's OLD key writes today:
		const forged = await chat.encryptToRecipient(FUNDS, me.pub, oldAlice, 'alice', 'bob');
		const decode = (list: string[]) =>
			list.map((s) => sodium.from_base64(s, sodium.base64_variants.ORIGINAL));
		vi.useFakeTimers();
		const c = createConversationController({
			me: 'bob',
			peer: 'alice',
			orderPermlink: null,
			getLiveIdentity: () => ({}) as never,
			now: () => new Date('2026-10-02T12:00:00Z'),
			visibilityState: () => 'visible',
			onVisibilityChange: () => () => undefined,
			generateClientTag: () => 'a'.repeat(32),
			fetchHistory: vi
				.fn()
				.mockResolvedValueOnce({
					ok: true,
					items: [
						{
							id: 7,
							sender: 'alice',
							recipient: 'bob',
							ciphertext: forged.ciphertext,
							header: { v: 2, ephemeral_pub: forged.ephemeralPub, nonce: forged.nonce },
							created_at: '2026-10-02T12:00:00.000Z',
							source_trx_id: 'e'.repeat(40)
						}
					],
					nextCursor: null
				})
				.mockResolvedValue({ ok: true, items: [], nextCursor: null }) as never,
			broadcast: (async () => ({ block_num: null, trx_id: 'f'.repeat(40) })) as never,
			fetchPeerChatPub: async () => newAlice.pub,
			// exactly what the app wires (chatService defaults)
			pinnedPeerPubs: (p: string) => decode(pp.pinnedPubsFor(p)),
			replacedPeerPubs: (p: string) =>
				decode((pp as { replacedPubsFor?: (p: string) => string[] }).replacedPubsFor?.(p) ?? []),
			deriveMyChatIdentity: async () => ({ priv: me.priv, pub: me.pub }),
			encrypt: async () => {
				throw new Error('not sending');
			},
			decrypt: async (
				env: unknown,
				priv: Uint8Array,
				pub: Uint8Array,
				s: string,
				r: string,
				pubs?: readonly Uint8Array[]
			) => {
				try {
					return await chat.decryptFromSender(env as never, { priv, pub }, s, r, pubs ?? []);
				} catch {
					return null;
				}
			},
			onChange: () => undefined
		} as never);
		c.start();
		await vi.runOnlyPendingTimersAsync();
		vi.useRealTimers();
		const m = c.snapshot().find((x) => x.id === 7)!;
		c.destroy();
		expect(m.decryptFailed).toBe(false); // history stays readable
		expect(m.senderUnverified).toBe(true);
		expect(recordFundsSent).not.toHaveBeenCalled();
	});
});
