import { describe, expect, it, beforeAll } from 'vitest';
import {
	encryptIdentity,
	decryptIdentity,
	upgradeToPostingActive,
	useActiveKey
} from './keystore';
import { importPostingOnlyFullIdentity, generateFullIdentity, ensureSodium } from './keygen';
import { toLiveIdentity } from './identity-core';
import { masterPasswordScalar } from './masterPassword';
import * as secp256k1 from '@noble/secp256k1';

const PASSWORD = 'correct-horse-battery-staple-9';
const ACCOUNT = 'kentest2';

let postingScalar: Uint8Array;
let activeScalar: Uint8Array;
let activePub: Uint8Array;

beforeAll(async () => {
	await ensureSodium();
	postingScalar = (await masterPasswordScalar(ACCOUNT, 'posting', 'pw'))!;
	activeScalar = (await masterPasswordScalar(ACCOUNT, 'active', 'pw'))!;
	activePub = secp256k1.getPublicKey(activeScalar, true);
});

/** A fresh posting-only identity each time (the import wipes its input). */
const postingOnly = async () => importPostingOnlyFullIdentity(postingScalar.slice());

describe('posting-only → posting-active upgrade', () => {
	it('a posting-only session has NO active capability', async () => {
		const live = toLiveIdentity(await postingOnly());
		expect(live.origin).toBe('posting-only');
		expect(live.activePublicKey).toBeNull();
	});

	it('upgrading stores the active key and grants capability', async () => {
		const env = await encryptIdentity(await postingOnly(), PASSWORD);
		const next = await upgradeToPostingActive(env, PASSWORD, activeScalar.slice(), activePub);

		const full = await decryptIdentity(next, PASSWORD);
		expect(full.origin).toBe('posting-active');
		expect(full.keys.active).not.toBeNull();
		expect(full.keys.posting).not.toBeNull();
		// An Active key cannot derive these. They must stay absent.
		expect(full.keys.owner).toBeNull();
		expect(full.keys.memo).toBeNull();
		expect(full.seedBytes).toBeNull();
	});

	it('the upgraded envelope grants a working JIT active key', async () => {
		const env = await encryptIdentity(await postingOnly(), PASSWORD);
		const next = await upgradeToPostingActive(env, PASSWORD, activeScalar.slice(), activePub);
		const full = await decryptIdentity(next, PASSWORD);
		const postingPub = full.keys.posting!.publicKey;

		const signedWith = await useActiveKey(
			next,
			PASSWORD,
			async (priv) => Array.from(priv.slice(0, 4)).join(','),
			postingPub
		);
		expect(signedWith).toBe(Array.from(activeScalar.slice(0, 4)).join(','));
	});

	it('capability is derived from the KEY, not the origin', async () => {
		const env = await encryptIdentity(await postingOnly(), PASSWORD);
		const next = await upgradeToPostingActive(env, PASSWORD, activeScalar.slice(), activePub);
		const live = toLiveIdentity(await decryptIdentity(next, PASSWORD));
		expect(live.origin).toBe('posting-active'); // NOT 'morphit-seed'
		expect(live.activePublicKey).not.toBeNull(); // …yet it can spend
	});

	it('refuses the wrong password (an attacker with the scalar cannot rewrite a keystore)', async () => {
		const env = await encryptIdentity(await postingOnly(), PASSWORD);
		await expect(
			upgradeToPostingActive(env, 'not-the-password', activeScalar.slice(), activePub)
		).rejects.toThrow();
	});

	it('refuses to upgrade a morphit-seed keystore', async () => {
		const env = await encryptIdentity(await generateFullIdentity(), PASSWORD);
		await expect(
			upgradeToPostingActive(env, PASSWORD, activeScalar.slice(), activePub)
		).rejects.toThrow(/refusing to upgrade/);
	});

	it('refuses to run twice (already upgraded)', async () => {
		const env = await encryptIdentity(await postingOnly(), PASSWORD);
		const once = await upgradeToPostingActive(env, PASSWORD, activeScalar.slice(), activePub);
		await expect(
			upgradeToPostingActive(once, PASSWORD, activeScalar.slice(), activePub)
		).rejects.toThrow(/refusing to upgrade/);
	});

	it('refuses a malformed scalar', async () => {
		const env = await encryptIdentity(await postingOnly(), PASSWORD);
		await expect(
			upgradeToPostingActive(env, PASSWORD, new Uint8Array(31), activePub)
		).rejects.toThrow(/32 bytes/);
	});

	it('the old posting-only envelope is untouched (upgrade returns a NEW envelope)', async () => {
		const env = await encryptIdentity(await postingOnly(), PASSWORD);
		await upgradeToPostingActive(env, PASSWORD, activeScalar.slice(), activePub);
		const stillOld = await decryptIdentity(env, PASSWORD);
		expect(stillOld.origin).toBe('posting-only');
		expect(stillOld.keys.active).toBeNull();
	});
});
