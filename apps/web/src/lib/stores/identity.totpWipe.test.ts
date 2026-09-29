/**
 * v1.20.0 review (F-8): bootFromEnvelope decrypts the WHOLE identity (owner,
 * active, memo and posting private keys, the seed entropy and the TOTP secret)
 * before the 2FA gate. When the gate stops the unlock — 'totp_required' (the
 * first attempt of EVERY 2FA user) or 'totp_invalid' (a typo) — that decrypted
 * copy must be zeroed, exactly as every other decrypt site does in a finally.
 * It was simply dropped for the garbage collector, all bytes intact.
 *
 * Captures the object decryptIdentity returned (by wrapping the real
 * function) and inspects its bytes after bootFromEnvelope throws.
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import type { FullIdentity } from '$crypto/identity-core';

let captured: FullIdentity | null = null;
vi.mock('$crypto/keystore', async (importOriginal) => {
	const orig = await importOriginal<typeof import('$crypto/keystore')>();
	return {
		...orig,
		decryptIdentity: async (...a: Parameters<typeof orig.decryptIdentity>) => {
			captured = (await orig.decryptIdentity(...a)) as FullIdentity;
			return captured;
		}
	};
});

import { encryptIdentity } from '$crypto/keystore';
import { generateFullIdentity } from '$crypto/keygen';
import { ensureSodium } from '$crypto/sodium';
import { computeCode } from '$lib/auth/totp';
import { get } from 'svelte/store';
import { bootFromEnvelope, identity, reset } from './identity';

const PW = 'correct-horse-battery-staple';
const nonZero = (u: Uint8Array | null | undefined): boolean => !!u && u.some((b) => b !== 0);

function secretsLeft(full: FullIdentity): string[] {
	const left: string[] = [];
	for (const role of ['owner', 'active', 'posting', 'memo'] as const) {
		if (nonZero(full.keys[role]?.privateKey)) left.push(role);
	}
	if (nonZero(full.seedBytes)) left.push('seedBytes');
	if (nonZero(full.totpSecret)) left.push('totpSecret');
	return left;
}

describe('bootFromEnvelope — the 2FA gate wipes what it decrypted', () => {
	let env: Awaited<ReturnType<typeof encryptIdentity>>;
	beforeAll(async () => {
		await ensureSodium();
		const full = await generateFullIdentity();
		env = await encryptIdentity(
			{ ...full, totpSecret: new Uint8Array(20).fill(7), totpBackupCodes: [] },
			PW
		);
	});

	it("'totp_required' (no code yet) leaves no private bytes behind", async () => {
		reset();
		await expect(bootFromEnvelope(env, PW)).rejects.toMatchObject({ kind: 'totp_required' });
		expect(secretsLeft(captured!)).toEqual([]);
	});

	it("'totp_invalid' (wrong code) leaves no private bytes behind", async () => {
		reset();
		// A code that is certainly not one of the three accepted steps.
		const good = await computeCode(new Uint8Array(20).fill(7));
		const wrong = String((Number(good) + 500_000) % 1_000_000).padStart(6, '0');
		await expect(bootFromEnvelope(env, PW, wrong)).rejects.toMatchObject({ kind: 'totp_invalid' });
		expect(secretsLeft(captured!)).toEqual([]);
	});

	it('a correct code still unlocks, with the live posting key intact', async () => {
		reset();
		await bootFromEnvelope(env, PW, await computeCode(new Uint8Array(20).fill(7)));
		const s = get(identity);
		expect(s.state).toBe('unlocked');
		if (s.state === 'unlocked') expect(nonZero(s.live.posting.privateKey)).toBe(true);
		// Everything the live session does not own is gone.
		expect(secretsLeft(captured!).filter((k) => k !== 'posting' && k !== 'memo')).toEqual([]);
		reset();
	});
});
