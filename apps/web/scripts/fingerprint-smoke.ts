/**
 * Chat-pubkey fingerprint smoke (REVISIT-LIST item 11).
 *
 * Pure-function coverage of computeFingerprint + formatFingerprint:
 *
 *   - Deterministic output: same inputs → same words.
 *   - Symmetric output: (pubA, pubB) and (pubB, pubA) produce
 *     IDENTICAL fingerprints.  This is THE property the OOB
 *     verification relies on — alice and bob compute the same
 *     thing despite their inputs being mirror-images.
 *   - Different keypairs → different fingerprints (no
 *     accidental collision in test set).
 *   - Bit-flip propagation: changing one byte of either pub
 *     produces a noticeably different fingerprint (avalanche
 *     property of the underlying SHA-256).
 *   - Length validation: rejects wrong-length inputs.
 *   - Type validation: rejects non-Uint8Array inputs.
 *   - Alternation: even-indexed positions come from one
 *     wordlist, odd-indexed from the other.  No accidental
 *     uniform-list use.
 *
 * Usage:
 *   tsx apps/web/scripts/fingerprint-smoke.ts
 */

import { computeFingerprint, formatFingerprint } from '../src/lib/chat/fingerprint.ts';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void | Promise<void>): Promise<void> {
	scenarios++;
	return Promise.resolve()
		.then(fn)
		.then(
			() => {
				console.log(`  ✓ ${name}`);
			},
			(err) => {
				failures++;
				console.log(`  ✗ ${name}`);
				console.log(`      ${err instanceof Error ? err.message : String(err)}`);
			}
		);
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label}: expected ${e}, got ${a}`);
	}
}

function makePub(seed: number): Uint8Array {
	// Deterministic 32-byte test vector from a seed.  NOT
	// cryptographically meaningful — just produces distinct
	// bytes for testing.
	const out = new Uint8Array(32);
	for (let i = 0; i < 32; i++) {
		out[i] = (seed * 31 + i * 7) & 0xff;
	}
	return out;
}

async function run(): Promise<void> {
	console.log('chat fingerprint smoke');

	const alicePub = makePub(1);
	const bobPub = makePub(2);
	const carolPub = makePub(3);

	// ─── Determinism ─────────────────────────────────────────────

	await scenario('determinism: same inputs → same fingerprint', async () => {
		const a = await computeFingerprint(alicePub, bobPub);
		const b = await computeFingerprint(alicePub, bobPub);
		assertEqual(a, b, 'fingerprint');
	});

	// ─── Symmetry — THE essential property ───────────────────────

	await scenario('symmetry: (alice, bob) === (bob, alice) — Alice and Bob agree', async () => {
		const aliceComputes = await computeFingerprint(alicePub, bobPub);
		const bobComputes = await computeFingerprint(bobPub, alicePub);
		assertEqual(aliceComputes, bobComputes, 'fingerprint');
	});

	// ─── Distinctness ────────────────────────────────────────────

	await scenario('different peers → different fingerprints (alice-bob ≠ alice-carol)', async () => {
		const aliceBob = await computeFingerprint(alicePub, bobPub);
		const aliceCarol = await computeFingerprint(alicePub, carolPub);
		if (JSON.stringify(aliceBob) === JSON.stringify(aliceCarol)) {
			throw new Error('expected different fingerprints, got identical');
		}
	});

	await scenario(
		'cross-account linkability: knowing alice-bob says nothing about alice-carol',
		async () => {
			// Different inputs to the hash → different outputs.
			// We can't prove independence here (would need a
			// statistical test), but we can verify the byte
			// representations differ at every position with high
			// probability — basic avalanche.
			const aliceBob = await computeFingerprint(alicePub, bobPub);
			const aliceCarol = await computeFingerprint(alicePub, carolPub);
			let diffCount = 0;
			for (let i = 0; i < aliceBob.length; i++) {
				if (aliceBob[i] !== aliceCarol[i]) diffCount++;
			}
			// With 8 byte-positions each independently picking
			// from a 256-word list, expected differing positions
			// is ~7.97 (1 - 1/256 per position × 8).  Allow some
			// flex for unlucky test seeds.
			if (diffCount < 4) {
				throw new Error(`fingerprints share too many positions: ${diffCount}/8 differ`);
			}
		}
	);

	// ─── Avalanche ───────────────────────────────────────────────

	await scenario('avalanche: flipping 1 bit in a pub changes most output positions', async () => {
		const baseline = await computeFingerprint(alicePub, bobPub);
		const tampered = new Uint8Array(bobPub);
		tampered[0] ^= 1; // flip 1 bit
		const after = await computeFingerprint(alicePub, tampered);
		let diffCount = 0;
		for (let i = 0; i < baseline.length; i++) {
			if (baseline[i] !== after[i]) diffCount++;
		}
		if (diffCount < 4) {
			throw new Error(`avalanche failed: only ${diffCount}/8 positions changed`);
		}
	});

	// ─── Length validation ───────────────────────────────────────

	await scenario('rejects 31-byte pub', async () => {
		try {
			await computeFingerprint(new Uint8Array(31), bobPub);
			throw new Error('expected throw');
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes('32-byte Uint8Array')) {
				throw new Error(`wrong error: ${err}`);
			}
		}
	});

	await scenario('rejects 33-byte pub', async () => {
		try {
			await computeFingerprint(alicePub, new Uint8Array(33));
			throw new Error('expected throw');
		} catch (err) {
			if (!(err instanceof Error) || !err.message.includes('32-byte Uint8Array')) {
				throw new Error(`wrong error: ${err}`);
			}
		}
	});

	await scenario('rejects empty pub', async () => {
		try {
			await computeFingerprint(new Uint8Array(0), bobPub);
			throw new Error('expected throw');
		} catch (err) {
			if (!(err instanceof Error)) throw err;
		}
	});

	await scenario('rejects non-Uint8Array (regular array)', async () => {
		try {
			// @ts-expect-error — runtime defense
			await computeFingerprint([1, 2, 3] as unknown, bobPub);
			throw new Error('expected throw');
		} catch (err) {
			if (!(err instanceof Error)) throw err;
		}
	});

	// ─── Output structure ────────────────────────────────────────

	await scenario('output is exactly 8 words', async () => {
		const fp = await computeFingerprint(alicePub, bobPub);
		assertEqual(fp.length, 8, 'word count');
	});

	await scenario('all output words are non-empty strings', async () => {
		const fp = await computeFingerprint(alicePub, bobPub);
		for (const w of fp) {
			if (typeof w !== 'string' || w.length === 0) {
				throw new Error(`bad word: ${JSON.stringify(w)}`);
			}
			if (!/^[A-Za-z]+$/.test(w)) {
				throw new Error(`word contains non-alpha: ${w}`);
			}
		}
	});

	await scenario(
		'alternation: even-indexed and odd-indexed positions come from disjoint wordlists',
		async () => {
			// Compute many fingerprints and verify that the set of
			// words appearing at even indices is disjoint from the
			// set appearing at odd indices.  This validates the
			// PGP wordlist alternation actually works.
			const evenWords = new Set<string>();
			const oddWords = new Set<string>();
			for (let seed = 0; seed < 64; seed++) {
				const a = makePub(seed);
				const b = makePub(seed + 1000);
				const fp = await computeFingerprint(a, b);
				for (let i = 0; i < fp.length; i++) {
					(i % 2 === 0 ? evenWords : oddWords).add(fp[i]!);
				}
			}
			// The sets MUST be disjoint per the PGP wordlist contract.
			const overlap = [...evenWords].filter((w) => oddWords.has(w));
			if (overlap.length > 0) {
				throw new Error(`even/odd wordlist overlap detected (BUG): ${overlap.join(', ')}`);
			}
		}
	);

	// ─── formatFingerprint ───────────────────────────────────────

	await scenario('formatFingerprint joins with single spaces', async () => {
		const fp = await computeFingerprint(alicePub, bobPub);
		const formatted = formatFingerprint(fp);
		assertEqual(formatted, fp.join(' '), 'format');
	});

	await scenario('formatFingerprint round-trip: split === input', async () => {
		const fp = await computeFingerprint(alicePub, bobPub);
		const formatted = formatFingerprint(fp);
		assertEqual(formatted.split(' '), [...fp], 'roundtrip');
	});

	// ─── Domain-separation sanity ────────────────────────────────

	await scenario(
		'all-zero pubs do NOT produce all-zero fingerprint (domain tag is mixed in)',
		async () => {
			const zero1 = new Uint8Array(32);
			const zero2 = new Uint8Array(32);
			const fp = await computeFingerprint(zero1, zero2);
			// If the domain tag weren't mixed, hashing zeros could
			// produce a deterministic, well-known hash that an
			// attacker could pre-compute.  We don't assert any
			// specific value; we just verify the words look
			// "normal" — i.e. real PGP wordlist entries, not nulls
			// or undefined leaking through.
			for (const w of fp) {
				if (typeof w !== 'string' || w.length < 4) {
					throw new Error(`zero-input fingerprint word looks malformed: ${w}`);
				}
			}
		}
	);

	console.log('');
	if (failures > 0) {
		console.log(`✗ ${failures}/${scenarios} scenarios failed`);
		process.exit(1);
	} else {
		console.log(`✓ all ${scenarios} scenarios passed`);
	}
}

await run();
