/**
 * The "Verify peer" safety number must withstand a hostile indexer that
 * serves each side a key of its own choosing (M_B to Alice, M_A to Bob).
 *
 * The old 8-word fingerprint was 64 bits over the PAIR of keys, so the
 * attacker only needed any collision F(A, M_B) = F(M_A, B): a ~2^32 birthday
 * search. Now each party's half is computed from that party's own key alone,
 * so a match needs a second preimage of BOTH halves, and the number carries
 * far more than 128 bits.
 */
import { describe, expect, it } from 'vitest';
import * as fp from './fingerprint';

type Party = { account: string; pub: Uint8Array };
const key = (seed: number) => new Uint8Array(32).map((_, i) => (i * 31 + seed * 7) & 0xff);
const alice: Party = { account: 'alice', pub: key(1) };
const bob: Party = { account: 'bob', pub: key(2) };

/** What the panel shows for a pair, whatever the module's API is. */
async function shown(a: Party, b: Party): Promise<readonly string[]> {
	const m = fp as unknown as {
		computeSafetyNumber?: (a: Party, b: Party) => Promise<readonly string[]>;
		computeFingerprint?: (a: Uint8Array, b: Uint8Array) => Promise<readonly string[]>;
	};
	if (m.computeSafetyNumber) return m.computeSafetyNumber(a, b);
	return m.computeFingerprint!(a.pub, b.pub);
}
/** Bits of the displayed value: digit groups carry log2(10) per digit, PGP
 *  words 8 bits each. */
function bits(groups: readonly string[]): number {
	return groups.every((g) => /^\d+$/.test(g))
		? groups.join('').length * Math.log2(10)
		: groups.length * 8;
}

describe('verify-peer safety number', () => {
	it('carries at least 128 bits', async () => {
		expect(bits(await shown(alice, bob))).toBeGreaterThanOrEqual(128);
	});

	it('is the same on both sides', async () => {
		expect(await shown(alice, bob)).toEqual(await shown(bob, alice));
	});

	it("each party's half depends only on that party's key: a substituted key changes only its own half", async () => {
		const mallory: Party = { account: 'bob', pub: key(3) };
		const real = (await shown(alice, bob)).join('');
		const mitm = (await shown(alice, mallory)).join('');
		expect(mitm).not.toBe(real);
		const halves = (s: string) => [s.slice(0, s.length / 2), s.slice(s.length / 2)];
		// Alice's own half appears unchanged in both — the attacker must match
		// Bob's half by a second preimage, not by any collision.
		const shared = halves(real).filter((h) => halves(mitm).includes(h));
		expect(shared.length).toBe(1);
	});

	it('binds the account name: the same key under another account gives another number', async () => {
		const renamed: Party = { account: 'b0b', pub: bob.pub };
		expect((await shown(alice, renamed)).join('')).not.toBe((await shown(alice, bob)).join(''));
	});

	it('refuses a key that is not 32 bytes', async () => {
		await expect(shown(alice, { account: 'bob', pub: new Uint8Array(31) })).rejects.toThrow();
	});
});
