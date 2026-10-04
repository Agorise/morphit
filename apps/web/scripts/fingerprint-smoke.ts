/**
 * Verify-peer safety-number smoke.
 *
 * Executes computeSafetyNumber ($lib/chat/fingerprint) and checks the
 * properties the out-of-band comparison relies on:
 *
 *   - deterministic, and identical on both sides ((A, B) and (B, A));
 *   - 12 groups of 5 digits — about 199 bits, far above 128;
 *   - each party's 30 digits depend only on that party's account and key, so
 *     a key substituted by a hostile indexer changes ITS half only: matching
 *     needs a second preimage of each half, not a birthday collision (the old
 *     64-bit 8-word fingerprint over the pair fell to a ~2^32 search);
 *   - the account name is bound in;
 *   - a flipped bit in a key changes that half completely;
 *   - wrong-length keys and empty account names are refused.
 *
 * Usage: tsx --tsconfig apps/web/tsconfig.smoke.json apps/web/scripts/fingerprint-smoke.ts
 */

import { computeSafetyNumber } from '../src/lib/chat/fingerprint.ts';

let failures = 0;
let scenarios = 0;

async function scenario(name: string, fn: () => Promise<void>): Promise<void> {
	scenarios++;
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}
function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}
const pub = (seed: number) => new Uint8Array(32).map((_, i) => (seed * 131 + i * 17) & 0xff);
const party = (account: string, seed: number) => ({ account, pub: pub(seed) });
const halves = (g: readonly string[]) => {
	const s = g.join('');
	return [s.slice(0, 30), s.slice(30)];
};

async function main(): Promise<void> {
	console.log('verify-peer safety number smoke\n');
	const alice = party('alice', 1);
	const bob = party('bob', 2);

	await scenario('deterministic', async () => {
		const a = await computeSafetyNumber(alice, bob);
		const b = await computeSafetyNumber(alice, bob);
		assert(JSON.stringify(a) === JSON.stringify(b), 'two runs differ');
	});
	await scenario('both sides see the same number', async () => {
		const a = await computeSafetyNumber(alice, bob);
		const b = await computeSafetyNumber(bob, alice);
		assert(JSON.stringify(a) === JSON.stringify(b), `${a.join(' ')} ≠ ${b.join(' ')}`);
	});
	await scenario('12 groups of 5 digits (≈199 bits ≥ 128)', async () => {
		const g = await computeSafetyNumber(alice, bob);
		assert(g.length === 12 && g.every((x) => /^\d{5}$/.test(x)), g.join(' '));
		assert(g.join('').length * Math.log2(10) >= 128, 'fewer than 128 bits');
	});
	await scenario("a substituted key changes only the substituted party's half", async () => {
		const real = halves(await computeSafetyNumber(alice, bob));
		const mitm = halves(await computeSafetyNumber(alice, party('bob', 3)));
		const shared = real.filter((h) => mitm.includes(h));
		assert(shared.length === 1, `shared halves: ${shared.length}`);
	});
	await scenario('the account name is bound in', async () => {
		const a = (await computeSafetyNumber(alice, bob)).join('');
		const b = (await computeSafetyNumber(alice, { account: 'b0b', pub: bob.pub })).join('');
		assert(a !== b, 'same number for another account name');
	});
	await scenario('one flipped bit changes that half entirely', async () => {
		const flipped = pub(2);
		flipped[7] = flipped[7]! ^ 1;
		const a = halves(await computeSafetyNumber(alice, bob));
		const b = halves(await computeSafetyNumber(alice, { account: 'bob', pub: flipped }));
		const bobOld = a.find((h) => !b.includes(h))!;
		const bobNew = b.find((h) => !a.includes(h))!;
		let same = 0;
		for (let i = 0; i < 30; i++) if (bobOld[i] === bobNew[i]) same++;
		assert(same < 12, `${same} of 30 digits unchanged`);
	});
	for (const [label, bad] of [
		['31-byte key', { account: 'bob', pub: new Uint8Array(31) }],
		['33-byte key', { account: 'bob', pub: new Uint8Array(33) }],
		['empty account name', { account: '', pub: pub(2) }],
		[
			'plain array instead of Uint8Array',
			{ account: 'bob', pub: Array.from(pub(2)) as unknown as Uint8Array }
		]
	] as const) {
		await scenario(`refuses: ${label}`, async () => {
			let threw = false;
			try {
				await computeSafetyNumber(alice, bad);
			} catch {
				threw = true;
			}
			assert(threw, 'accepted');
		});
	}

	console.log('');
	if (failures > 0) {
		console.log(`✗ ${failures} of ${scenarios} safety-number scenarios failed`);
		process.exit(1);
	}
	console.log(`✓ all ${scenarios} safety-number scenarios passed`);
}

void main();
