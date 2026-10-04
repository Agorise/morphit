/**
 * A seed imported without "Remember me" is kept encrypted under a random
 * password the user never saw. Before a backup is exported, the user chooses a
 * password; the keyfile then opens with THAT password (and "Show seed", which
 * asks for it, works). Nothing is written to disk.
 *
 * Real keystore + identity store; localStorage is an in-memory stand-in.
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
import { blobToEnvelope, decryptIdentity, encryptIdentity, envelopeToBlob } from '$crypto/keystore';
import { generateFullIdentity } from '$crypto/keygen';
import { ensureSodium } from '$crypto/sodium';
import {
	bootFromEnvelope,
	currentEnvelope,
	noteEphemeralSessionPassword,
	protectSessionWithPassword,
	reset,
	sessionPasswordIsEphemeral
} from '$stores/identity';

const RANDOM = 'a3f9'.repeat(12);
const CHOSEN = 'river-lantern-quietly-87';

/** What the import page does for a seed without "Remember me". */
async function seedSessionWithoutRememberMe() {
	await ensureSodium();
	const env = await encryptIdentity(await generateFullIdentity(), RANDOM);
	await bootFromEnvelope(env, RANDOM);
	noteEphemeralSessionPassword(env, RANDOM);
}

beforeEach(() => {
	reset();
	mem.clear();
});

describe('a backup of a "just this session" seed import', () => {
	it('asks for a password first; the exported keyfile then opens with it', async () => {
		await seedSessionWithoutRememberMe();
		expect(sessionPasswordIsEphemeral()).toBe(true);
		expect(await protectSessionWithPassword(CHOSEN)).toBe('ok');
		expect(sessionPasswordIsEphemeral()).toBe(false);
		// The download button exports the session's keystore.
		const keyfile = await blobToEnvelope(envelopeToBlob(get(currentEnvelope)!));
		const opened = await decryptIdentity(keyfile, CHOSEN);
		expect(opened.seedBytes).not.toBeNull();
		await expect(decryptIdentity(keyfile, RANDOM)).rejects.toThrow();
	});

	it('nothing is written to this device', async () => {
		await seedSessionWithoutRememberMe();
		await protectSessionWithPassword(CHOSEN);
		expect([...mem.keys()].filter((k) => k.startsWith('morphit.keystore'))).toEqual([]);
	});

	it('a session whose password the user chose is not asked again', async () => {
		await ensureSodium();
		const env = await encryptIdentity(await generateFullIdentity(), CHOSEN);
		await bootFromEnvelope(env, CHOSEN);
		expect(sessionPasswordIsEphemeral()).toBe(false);
		expect(await protectSessionWithPassword('another-password-123')).toBe('not_ephemeral');
	});
});
