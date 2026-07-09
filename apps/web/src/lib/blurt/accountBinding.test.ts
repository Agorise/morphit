import { describe, expect, it, beforeEach } from 'vitest';
import {
	resolveBroadcastAccount,
	clearAccountBindingCache,
	AccountBindingError
} from './accountBinding';
import type { LiveIdentity } from '$crypto/identity-core';
import * as secp256k1 from '@noble/secp256k1';

// A REAL compressed pubkey — formatPublicKeyBLT validates the curve point, so a
// hand-rolled 33 zero bytes is rejected (correctly).
const scalar = new Uint8Array(32);
scalar[31] = 9;
const pub = secp256k1.getPublicKey(scalar, true);
const live = { posting: { publicKey: pub } } as unknown as LiveIdentity;

beforeEach(() => clearAccountBindingCache());

describe('resolveBroadcastAccount — the account is a property of the KEY', () => {
	it('uses the account the key actually controls, ignoring a wrong hint', async () => {
		// The exact cross-tab bug: storage says kentest3, the key is kentest2's.
		const account = await resolveBroadcastAccount(live, 'kentest3', async () => ['kentest2']);
		expect(account).toBe('kentest2');
	});

	it('uses the key\u2019s account when there is no hint at all', async () => {
		expect(await resolveBroadcastAccount(live, null, async () => ['kentest2'])).toBe('kentest2');
	});

	it('refuses to broadcast when the key controls nothing', async () => {
		await expect(resolveBroadcastAccount(live, 'kentest3', async () => [])).rejects.toThrow(
			AccountBindingError
		);
		await expect(
			resolveBroadcastAccount(live, 'kentest3', async () => [])
		).rejects.toMatchObject({ kind: 'no_account_for_key' });
	});

	it('uses the hint to disambiguate a key that controls several accounts', async () => {
		const account = await resolveBroadcastAccount(live, 'bob', async () => ['alice', 'bob']);
		expect(account).toBe('bob');
	});

	it('refuses when the key controls several accounts and the hint names none of them', async () => {
		await expect(
			resolveBroadcastAccount(live, 'carol', async () => ['alice', 'bob'])
		).rejects.toMatchObject({ kind: 'ambiguous', candidates: ['alice', 'bob'] });
	});

	it('surfaces a lookup failure rather than guessing', async () => {
		await expect(
			resolveBroadcastAccount(live, 'kentest2', async () => {
				throw new Error('indexer down');
			})
		).rejects.toMatchObject({ kind: 'lookup_failed' });
	});

	it('memoizes per key (one lookup per session, not per op)', async () => {
		let calls = 0;
		const resolver = async () => {
			calls++;
			return ['kentest2'];
		};
		await resolveBroadcastAccount(live, null, resolver);
		await resolveBroadcastAccount(live, null, resolver);
		expect(calls).toBe(1);
	});

	it('a failure is NOT cached (a transient indexer blip must not poison the session)', async () => {
		await expect(
			resolveBroadcastAccount(live, null, async () => {
				throw new Error('blip');
			})
		).rejects.toThrow();
		expect(await resolveBroadcastAccount(live, null, async () => ['kentest2'])).toBe('kentest2');
	});
});
