/**
 * Our own chat key's status (v1.21.13, review H1). Only 'current' sends the
 * chat-key envelope; once our key has been SEEN current here, a later "you
 * have none" from an indexer cannot move this account's conversations off
 * chat keys — an op on chain is never withdrawn.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as secp from '@noble/secp256k1';
import type { LiveIdentity } from '$crypto/keygen';

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

let indexer:
	| { ok: true; data: { chat_pub: string } }
	| { ok: false; code: string; message: string };
const getChatIdentity = vi.fn(async () => indexer);
vi.mock('$lib/indexer/client', async (orig) => ({
	...(await orig<object>()),
	getChatIdentity
}));

const { ownChatKeyStatus } = await import('./chatService');
const { deriveChatIdentity, encodeChatPub } = await import('./crypto');
const { clearAllPins, ownPublishedRecord } = await import('./pubPin');

const priv = secp.utils.randomPrivateKey();
const live = { posting: { privateKey: priv } } as unknown as LiveIdentity;
const derived = async () => encodeChatPub((await deriveChatIdentity(priv, 'anna')).pub);

beforeEach(() => {
	clearAllPins();
	getChatIdentity.mockClear();
});

describe('ownChatKeyStatus', () => {
	it('none / stale / current, as the indexer says — and current is remembered', async () => {
		indexer = { ok: false, code: 'not_found', message: 'none' };
		expect(await ownChatKeyStatus('anna', live)).toBe('none');
		indexer = { ok: true, data: { chat_pub: 'b2xk' } };
		expect(await ownChatKeyStatus('anna', live)).toBe('stale');
		expect(ownPublishedRecord('anna')).toBeNull();
		indexer = { ok: true, data: { chat_pub: await derived() } };
		expect(await ownChatKeyStatus('anna', live)).toBe('current');
		expect(ownPublishedRecord('anna')).toBe(await derived());
	});

	it('seen current once: a later "none" from the indexer changes nothing, and it is not even asked', async () => {
		indexer = { ok: true, data: { chat_pub: await derived() } };
		await ownChatKeyStatus('anna', live);
		getChatIdentity.mockClear();
		indexer = { ok: false, code: 'not_found', message: 'none' };
		expect(await ownChatKeyStatus('anna', live)).toBe('current');
		expect(getChatIdentity).not.toHaveBeenCalled();
	});

	it('a remembered key that is not the one this posting key derives counts for nothing', async () => {
		indexer = { ok: true, data: { chat_pub: await derived() } };
		await ownChatKeyStatus('anna', live);
		const other = {
			posting: { privateKey: secp.utils.randomPrivateKey() }
		} as unknown as LiveIdentity;
		expect(await ownChatKeyStatus('anna', other)).toBe('stale');
	});

	it('the indexer cannot say: throws (the send is retried, never guessed)', async () => {
		indexer = { ok: false, code: 'network', message: 'down' };
		await expect(ownChatKeyStatus('anna', live)).rejects.toThrow();
	});

	it('waits for the unlock’s unseal: a record a Lock sealed counts, and the indexer is not asked', async () => {
		const { setUnsealPending } = await import('./unsealGate');
		const { recordOwnPublished } = await import('./pubPin');
		const mine = await derived();
		let land!: () => void;
		setUnsealPending(
			new Promise<void>((r) => {
				land = () => {
					recordOwnPublished('anna', mine);
					r();
				};
			})
		);
		indexer = { ok: false, code: 'not_found', message: 'none' };
		const p = ownChatKeyStatus('anna', live);
		// The unseal lands after the key derivation is done (a macrotask later).
		setTimeout(land, 0);
		expect(await p).toBe('current');
		expect(getChatIdentity).not.toHaveBeenCalled();
		setUnsealPending(Promise.resolve());
	});
});
