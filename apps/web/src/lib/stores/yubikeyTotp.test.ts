/**
 * The YubiKey is an ALTERNATIVE unlock (decision (a)), never a way around
 * two-factor authentication, and what it unlocks with does not stay the same:
 *
 *   - a keystore with TOTP enrolled does not unlock with the YubiKey alone;
 *   - an authenticator code is accepted once (not again within its window);
 *   - every YubiKey unlock moves the challenge, so a recorded response stops
 *     working;
 *   - re-encrypting a YubiKey-protected keystore (backup-code redemption,
 *     2FA changes, "keep my Active key") keeps the YubiKey wrap, and the copy
 *     on disk is replaced only when it IS that keystore;
 *   - the Active key's two halves must belong together.
 *
 * Real keystore + identity store; localStorage is an in-memory stand-in; the
 * YubiKey is an HMAC-SHA1 stand-in that records what it answered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
vi.mock('$app/environment', () => ({ browser: true, dev: false, building: false, version: 't' }));
const mem = vi.hoisted(() => {
	const mem = new Map<string, string>();
	const ls = {
		getItem: (k: string) => mem.get(k) ?? null,
		setItem: (k: string, v: string) => void mem.set(k, String(v)),
		removeItem: (k: string) => void mem.delete(k),
		clear: () => mem.clear(),
		key: (i: number) => [...mem.keys()][i] ?? null,
		get length() {
			return mem.size;
		}
	};
	const g = globalThis as Record<string, unknown>;
	g.localStorage = ls;
	g.sessionStorage = ls;
	g.window = g;
	g.addEventListener = () => {};
	g.removeEventListener = () => {};
	g.dispatchEvent = () => true;
	return mem;
});
import { get } from 'svelte/store';
import { createHmac } from 'node:crypto';
import * as secp256k1 from '@noble/secp256k1';
import {
	KeystoreError,
	decryptIdentity,
	encryptIdentity,
	upgradeToPostingActive,
	type KeystoreEnvelope
} from '$crypto/keystore';
import { generateFullIdentity, type Identity } from '$crypto/keygen';
import { ensureSodium } from '$crypto/sodium';
import { enrollYubikey, listYubikeyWraps, unlockWithYubikey } from '$crypto/keystoreYubikey';
import { readEnvelope, writeEnvelope, writeKeystoreMode } from '$crypto/persistentKeystore';
import { enrollTotp } from '$crypto/keystoreTotpEnroll';
import { verifyTotpOrBackup } from '$crypto/keystoreTotp';
import { computeCode, generateSecret } from '$lib/auth/totp';
import { generatePlaintextCodes } from '$lib/auth/backupCodes';
import { bootFromEnvelopeWithYubikey, currentEnvelope, identity, reset } from '$stores/identity';

const PW = 'correct-horse-battery-staple-1';
const SLOT_SECRET = Buffer.alloc(20, 5);

/** A YubiKey stand-in that records every (challenge → response) it gave. */
function yubikey() {
	const seen: { challenge: Uint8Array; response: Uint8Array }[] = [];
	const hmac = async (c: Uint8Array) => {
		const response = new Uint8Array(createHmac('sha1', SLOT_SECRET).update(c).digest());
		seen.push({ challenge: c.slice(), response: response.slice() });
		return response;
	};
	return { hmac, seen };
}

/** A recorder of ONE earlier answer: replays it for that challenge only. */
function replayOf(recorded: { challenge: Uint8Array; response: Uint8Array }) {
	return async (c: Uint8Array) => {
		if (Buffer.compare(Buffer.from(c), Buffer.from(recorded.challenge)) !== 0) {
			throw new Error('no recorded answer for this challenge');
		}
		return recorded.response.slice();
	};
}

const nowStep = (): number => Math.floor(Date.now() / 1000);

/** A remembered keystore with 2FA enrolled, then a YubiKey added. */
async function rememberedTotpYubikey(): Promise<{
	env: KeystoreEnvelope;
	secret: Uint8Array;
	backup: string[];
}> {
	await ensureSodium();
	const full = await generateFullIdentity();
	const simple = await encryptIdentity(full, PW);
	const secret = generateSecret();
	const backup = generatePlaintextCodes();
	const withTotp = await enrollTotp(simple, full, PW, secret, backup);
	const key = yubikey();
	const layered = await enrollYubikey(withTotp.envelope, PW, key.hmac, 2 as never, 'key');
	writeKeystoreMode('password');
	writeEnvelope(layered);
	return { env: layered, secret, backup };
}

beforeEach(() => {
	reset();
	mem.clear();
});

describe('2FA applies to the YubiKey unlock too', () => {
	it('the YubiKey alone does not unlock a keystore with 2FA enrolled', async () => {
		const { env } = await rememberedTotpYubikey();
		await expect(bootFromEnvelopeWithYubikey(env, yubikey().hmac)).rejects.toMatchObject({
			kind: 'totp_required'
		});
		expect(get(identity).state).toBe('locked');
	});

	it('with the authenticator code it unlocks', async () => {
		const { env, secret } = await rememberedTotpYubikey();
		await bootFromEnvelopeWithYubikey(env, yubikey().hmac, await computeCode(secret));
		expect(get(identity).state).toBe('unlocked');
	});

	it('a wrong code does not unlock', async () => {
		const { env, secret } = await rememberedTotpYubikey();
		const wrong = await computeCode(secret, nowStep() + 10_000);
		await expect(bootFromEnvelopeWithYubikey(env, yubikey().hmac, wrong)).rejects.toBeInstanceOf(
			KeystoreError
		);
		expect(get(identity).state).toBe('locked');
	});
});

describe('an authenticator code is accepted once', () => {
	it('the same code again, within its window: refused', async () => {
		await ensureSodium();
		const id = { ...(await generateFullIdentity()), totpSecret: generateSecret() } as Identity;
		const code = await computeCode(id.totpSecret!);
		expect((await verifyTotpOrBackup(id, code)).kind).toBe('ok');
		await expect(verifyTotpOrBackup(id, code)).rejects.toMatchObject({ kind: 'totp_invalid' });
		// The next step's code still works.
		const next = await computeCode(id.totpSecret!, nowStep() + 30);
		expect((await verifyTotpOrBackup(id, next)).kind).toBe('ok');
	});
});

describe('every YubiKey unlock moves the challenge', () => {
	it('a response recorded at one unlock does not open the keystore afterwards', async () => {
		const { env, secret } = await rememberedTotpYubikey();
		const key = yubikey();
		await bootFromEnvelopeWithYubikey(env, key.hmac, await computeCode(secret));
		const recorded = key.seen[0]!; // what a compromised computer saw
		const after = readEnvelope()!;
		expect(listYubikeyWraps(after)[0]!.wrap.challenge).not.toBe(
			listYubikeyWraps(env)[0]!.wrap.challenge
		);
		expect(get(currentEnvelope)).toEqual(after);
		// The recorded answer still opens the OLD keystore copy …
		await expect(unlockWithYubikey(env, replayOf(recorded))).resolves.toBeTruthy();
		// … but not the one on the device now.
		await expect(unlockWithYubikey(after, replayOf(recorded))).rejects.toThrow();
		// The real key still does.
		await expect(unlockWithYubikey(after, yubikey().hmac)).resolves.toBeTruthy();
	});
});

describe('re-encrypting keeps the YubiKey, and the disk only when it is this keystore', () => {
	it('a backup code redeemed on the YubiKey path keeps the YubiKey wrap and is spent', async () => {
		const { env, backup } = await rememberedTotpYubikey();
		await bootFromEnvelopeWithYubikey(env, yubikey().hmac, backup[0]);
		const after = readEnvelope()!;
		expect(listYubikeyWraps(after)).toHaveLength(1);
		reset();
		await expect(
			bootFromEnvelopeWithYubikey(after, yubikey().hmac, backup[0])
		).rejects.toMatchObject({
			kind: 'totp_invalid'
		});
	});

	it('2FA enrolment on a YubiKey keystore keeps the YubiKey', async () => {
		await ensureSodium();
		const full = await generateFullIdentity();
		const layered = await enrollYubikey(
			await encryptIdentity(full, PW),
			PW,
			yubikey().hmac,
			2 as never,
			'k'
		);
		const opened = await decryptIdentity(layered, PW);
		const enrolled = await enrollTotp(
			layered,
			opened,
			PW,
			generateSecret(),
			generatePlaintextCodes()
		);
		expect(listYubikeyWraps(enrolled.envelope)).toHaveLength(1);
		expect((await unlockWithYubikey(enrolled.envelope, yubikey().hmac)).totpSecret).toBeTruthy();
	});

	it('"keep my Active key" keeps the YubiKey; mismatched halves are refused', async () => {
		await ensureSodium();
		const full = await generateFullIdentity();
		const postingOnly = {
			...full,
			origin: 'posting-only',
			seedBytes: null,
			keys: { owner: null, active: null, posting: full.keys.posting, memo: null }
		} as unknown as Identity;
		const layered = await enrollYubikey(
			await encryptIdentity(postingOnly, PW),
			PW,
			yubikey().hmac,
			2 as never,
			'k'
		);
		const scalar = full.keys.active!.privateKey.slice();
		const pub = secp256k1.getPublicKey(scalar, true);
		const upgraded = await upgradeToPostingActive(layered, PW, scalar.slice(), pub);
		expect(listYubikeyWraps(upgraded)).toHaveLength(1);
		const otherPub = secp256k1.getPublicKey(full.keys.owner!.privateKey, true);
		await expect(upgradeToPostingActive(layered, PW, scalar.slice(), otherPub)).rejects.toThrow();
	});
});
