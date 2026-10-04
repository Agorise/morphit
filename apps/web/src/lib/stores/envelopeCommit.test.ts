/**
 * A re-keyed keystore (YubiKey added/removed/hardened/softened, password
 * changed, 2FA changed) must land in the session AND on disk together — and on
 * disk only when the session's keystore is the one this device remembers.
 *
 * Before: the YubiKey card wrote only the disk copy, and the password change
 * re-encrypted the session's stale copy and wrote it back — so a REMOVED
 * (lost) YubiKey unlocked again, and a "YubiKey-only" keystore opened with the
 * password again. A session that was never remembered (another account
 * remembered on the device) overwrote that other account's keystore.
 *
 * Real keystore + identity store; localStorage is an in-memory stand-in; the
 * YubiKey is an HMAC-SHA1 stand-in.
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
import { encryptIdentity, decryptIdentity } from '$crypto/keystore';
import { generateFullIdentity } from '$crypto/keygen';
import { ensureSodium } from '$crypto/sodium';
import {
	enrollYubikey,
	unenrollWrap,
	hardenToYubikeyOnly,
	unlockWithYubikey,
	listYubikeyWraps,
	isYubikeyOnly
} from '$crypto/keystoreYubikey';
import { writeEnvelope, readEnvelope, writeKeystoreMode } from '$crypto/persistentKeystore';
import { bootFromEnvelope, currentEnvelope, commitSessionEnvelope, reset } from '$stores/identity';
import { changePassword } from '$crypto/changePassword';

const PW = 'correct-horse-battery-staple-1';
const PW2 = 'another-long-password-2025!';
const lost = Buffer.alloc(20, 9);
const hmacLost = async (c: Uint8Array) =>
	new Uint8Array(createHmac('sha1', lost).update(c).digest());

async function rememberedLayeredSession() {
	await ensureSodium();
	const simple = await encryptIdentity(await generateFullIdentity(), PW);
	writeKeystoreMode('password');
	const layered = await enrollYubikey(simple, PW, hmacLost, 2 as never, 'lost key');
	writeEnvelope(layered);
	await bootFromEnvelope(layered, PW);
	return layered;
}

beforeEach(() => {
	reset();
	mem.clear();
});

describe('YubiKey changes reach the session and the disk together', () => {
	it('remove a lost YubiKey, then change the password: the lost key stays removed', async () => {
		await rememberedLayeredSession();
		const env = get(currentEnvelope)!;
		const idx = (env as unknown as { wraps: readonly unknown[] }).wraps.findIndex((w) =>
			JSON.stringify(w).includes('yubikey')
		);
		expect(commitSessionEnvelope(unenrollWrap(env as never, idx), { requirePersisted: true })).toBe(
			'persisted'
		);
		expect(listYubikeyWraps(get(currentEnvelope)!).length).toBe(0);
		const r = await changePassword(PW, PW2);
		expect(r.ok).toBe(true);
		let lostUnlocks = false;
		try {
			await unlockWithYubikey(readEnvelope()!, hmacLost);
			lostUnlocks = true;
		} catch {
			/* refused */
		}
		expect(lostUnlocks).toBe(false);
	});

	it('the old flow (disk written, session stale) no longer resurrects the key on a password change', async () => {
		await rememberedLayeredSession();
		const env = get(currentEnvelope)!;
		const idx = (env as unknown as { wraps: readonly unknown[] }).wraps.findIndex((w) =>
			JSON.stringify(w).includes('yubikey')
		);
		writeEnvelope(unenrollWrap(env as never, idx));
		await changePassword(PW, PW2);
		let lostUnlocks = false;
		try {
			await unlockWithYubikey(readEnvelope()!, hmacLost);
			lostUnlocks = true;
		} catch {
			/* refused */
		}
		expect(lostUnlocks).toBe(false);
	});

	it('harden to YubiKey-only, then change the password: a password alone still does not unlock', async () => {
		await rememberedLayeredSession();
		expect(
			commitSessionEnvelope(hardenToYubikeyOnly(get(currentEnvelope)! as never), {
				requirePersisted: true
			})
		).toBe('persisted');
		expect(isYubikeyOnly(get(currentEnvelope)!)).toBe(true);
		await changePassword(PW, PW2);
		const disk = readEnvelope()!;
		expect(isYubikeyOnly(disk)).toBe(true);
		let pwUnlocks = false;
		try {
			await decryptIdentity(disk, PW2);
			pwUnlocks = true;
		} catch {
			/* refused */
		}
		expect(pwUnlocks).toBe(false);
	});
});

describe('a session that is not the remembered one never overwrites it', () => {
	it('account B (not remembered) changes its password: account A’s keystore on disk is untouched', async () => {
		await ensureSodium();
		writeKeystoreMode('password');
		const envA = await encryptIdentity(await generateFullIdentity(), PW);
		writeEnvelope(envA);
		const envB = await encryptIdentity(await generateFullIdentity(), PW);
		await bootFromEnvelope(envB, PW);
		const before = JSON.stringify(readEnvelope());
		const r = await changePassword(PW, PW2);
		expect(r.ok).toBe(true);
		expect(JSON.stringify(readEnvelope())).toBe(before);
		// and B's session took the new password
		await expect(decryptIdentity(get(currentEnvelope)!, PW2)).resolves.toBeTruthy();
	});

	it('a YubiKey change on a not-remembered session is refused, not half-applied', async () => {
		await ensureSodium();
		writeKeystoreMode('password');
		const envA = await encryptIdentity(await generateFullIdentity(), PW);
		writeEnvelope(envA);
		const envB = await enrollYubikey(
			await encryptIdentity(await generateFullIdentity(), PW),
			PW,
			hmacLost,
			2 as never,
			'k'
		);
		await bootFromEnvelope(envB, PW);
		const before = JSON.stringify(readEnvelope());
		expect(
			commitSessionEnvelope(hardenToYubikeyOnly(envB as never), { requirePersisted: true })
		).toBe('not_remembered');
		expect(JSON.stringify(readEnvelope())).toBe(before);
		expect(isYubikeyOnly(get(currentEnvelope)!)).toBe(false);
	});
});
