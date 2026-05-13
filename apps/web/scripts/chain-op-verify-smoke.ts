/**
 * Morphit web — local chain-op signature verification smoke
 * (S14, Audit Part 26).
 *
 * Exercises the pure verifyTransactionSignatures helper with
 * fixture transactions and authorities.  The wrapper that
 * fetches via RPC is integration-tested manually against a
 * live Blurt endpoint; this smoke covers the cryptographic
 * core.
 *
 * Scenarios:
 *
 *   1. Single-sig posting authority, signature from the
 *      authority's key → ok:true, weightSum=1, threshold=1.
 *   2. Single-sig posting authority, signature from an
 *      UNRELATED key → weight_below_threshold.
 *   3. Tx with empty signatures array → no_signatures.
 *   4. Multi-sig (two keys, threshold=2): one matching
 *      signature → weight_below_threshold.
 *   5. Multi-sig (two keys, threshold=2): two matching
 *      signatures → ok:true, weightSum=2.
 *   6. Hostile-RPC simulation: same digest, signature
 *      tampered (one byte flipped in the recovery byte)
 *      → recovered to a non-authority key → fails.
 *   7. PublicKey-typed key_auth entry (not just strings)
 *      → key lookup still works (covers the
 *      `typeof keyOrString === 'string'` branch).
 *   8. Weight threshold of 0 (degenerate but legal in
 *      Graphene) — any signature passes vacuously.
 *
 * Usage:
 *   tsx apps/web/scripts/chain-op-verify-smoke.ts
 */

import {
	Client,
	cryptoUtils,
	PrivateKey,
	PublicKey,
	type AuthorityType,
	type SignedTransaction,
	type Transaction
} from '@beblurt/dblurt';
import { Buffer } from 'buffer';
import { verifyTransactionSignatures } from '../src/lib/chat/chainOpVerifyCore.ts';

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

function assert(cond: unknown, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

// ─── fixtures ────────────────────────────────────────────────

/** Build a deterministic test PrivateKey from a seed.
 *  The PrivateKey constructor expects a 32-byte Buffer with
 *  a leading 0x80 prefix byte... actually no, PrivateKey takes
 *  a 32-byte scalar.  We use fromSeed which derives from a
 *  string — clean and deterministic. */
function makeKeyFromSeed(seed: string): { priv: PrivateKey; pub: string } {
	const priv = PrivateKey.fromSeed(seed);
	const pub = priv.createPublic('BLT').toString();
	return { priv, pub };
}

/** Build a minimal unsigned Transaction shape acceptable to
 *  cryptoUtils.transactionDigest.  We use a custom_json op
 *  payload because it's the simplest serializable Operation. */
function buildUnsignedTx(): Transaction {
	return {
		ref_block_num: 12345,
		ref_block_prefix: 67890,
		expiration: '2026-05-04T00:00:00',
		operations: [
			[
				'custom_json',
				{
					required_auths: [],
					required_posting_auths: ['alice'],
					id: 'morphit_chat_identity_v1',
					json: '{"v":1,"chat_pub":"AAAA...","ts":1714694400}'
				}
			]
		],
		extensions: []
	};
}

/** Sign the tx with the given private key and return a
 *  SignedTransaction shape (with the synthetic chain metadata
 *  fields the verifier doesn't actually read). */
function signTx(tx: Transaction, key: PrivateKey): SignedTransaction {
	const c = Client as unknown as { DEFAULT_CHAIN_ID: Buffer };
	const signed = cryptoUtils.signTransaction(tx, [key], c.DEFAULT_CHAIN_ID);
	return {
		...signed,
		transaction_id: 'fixture0000000000000000000000000000000000',
		block_num: 1,
		transaction_num: 0
	};
}

/** Multi-key signer: produces a tx with two signatures from
 *  two different keys.  Uses signTransaction twice and merges
 *  the signatures arrays. */
function signTxMulti(tx: Transaction, keys: PrivateKey[]): SignedTransaction {
	const c = Client as unknown as { DEFAULT_CHAIN_ID: Buffer };
	let signed = cryptoUtils.signTransaction(tx, [keys[0]!], c.DEFAULT_CHAIN_ID);
	for (let i = 1; i < keys.length; i++) {
		signed = cryptoUtils.signTransaction(signed, [keys[i]!], c.DEFAULT_CHAIN_ID);
	}
	return {
		...signed,
		transaction_id: 'fixture0000000000000000000000000000000000',
		block_num: 1,
		transaction_num: 0
	};
}

// ─── tests ───────────────────────────────────────────────────

async function run(): Promise<void> {
	console.log('chain-op-verify smoke');

	const aliceKey = makeKeyFromSeed('alice posting key seed for smoke');
	const bobKey = makeKeyFromSeed('bob posting key seed for smoke');
	const carolKey = makeKeyFromSeed('carol unrelated key seed for smoke');

	// ─── Scenario 1 ───────────────────────────────────────────
	await scenario('single-sig: matching signature → ok', () => {
		const tx = buildUnsignedTx();
		const signed = signTx(tx, aliceKey.priv);
		const auth: AuthorityType = {
			weight_threshold: 1,
			account_auths: [],
			key_auths: [[aliceKey.pub, 1]]
		};
		const result = verifyTransactionSignatures(signed, auth);
		assert(result.ok === true, `expected ok=true, got ${JSON.stringify(result)}`);
		assert(result.ok === true && result.weightSum === 1, `expected weightSum=1`);
		assert(result.ok === true && result.threshold === 1, `expected threshold=1`);
	});

	// ─── Scenario 2 ───────────────────────────────────────────
	await scenario('single-sig: unrelated signature → weight_below_threshold', () => {
		const tx = buildUnsignedTx();
		const signed = signTx(tx, carolKey.priv); // signed by carol
		const auth: AuthorityType = {
			weight_threshold: 1,
			account_auths: [],
			key_auths: [[aliceKey.pub, 1]] // expects alice
		};
		const result = verifyTransactionSignatures(signed, auth);
		assert(result.ok === false, `expected ok=false`);
		assert(
			!result.ok && result.code === 'weight_below_threshold',
			`expected weight_below_threshold, got ${result.ok ? 'ok' : result.code}`
		);
	});

	// ─── Scenario 3 ───────────────────────────────────────────
	await scenario('empty signatures array → no_signatures', () => {
		const signed: SignedTransaction = {
			...buildUnsignedTx(),
			signatures: [],
			transaction_id: 'x',
			block_num: 1,
			transaction_num: 0
		};
		const auth: AuthorityType = {
			weight_threshold: 1,
			account_auths: [],
			key_auths: [[aliceKey.pub, 1]]
		};
		const result = verifyTransactionSignatures(signed, auth);
		assert(
			!result.ok && result.code === 'no_signatures',
			`expected no_signatures, got ${result.ok ? 'ok' : result.code}`
		);
	});

	// ─── Scenario 4 ───────────────────────────────────────────
	await scenario('multi-sig: only one match (sum<threshold) → weight_below_threshold', () => {
		const tx = buildUnsignedTx();
		const signed = signTx(tx, aliceKey.priv); // alice only
		const auth: AuthorityType = {
			weight_threshold: 2,
			account_auths: [],
			key_auths: [
				[aliceKey.pub, 1],
				[bobKey.pub, 1]
			]
		};
		const result = verifyTransactionSignatures(signed, auth);
		assert(
			!result.ok && result.code === 'weight_below_threshold',
			`expected weight_below_threshold for 1<2, got ${result.ok ? 'ok' : result.code}`
		);
	});

	// ─── Scenario 5 ───────────────────────────────────────────
	await scenario('multi-sig: both match (sum=threshold) → ok', () => {
		const tx = buildUnsignedTx();
		const signed = signTxMulti(tx, [aliceKey.priv, bobKey.priv]);
		const auth: AuthorityType = {
			weight_threshold: 2,
			account_auths: [],
			key_auths: [
				[aliceKey.pub, 1],
				[bobKey.pub, 1]
			]
		};
		const result = verifyTransactionSignatures(signed, auth);
		assert(result.ok === true, `expected ok=true, got ${JSON.stringify(result)}`);
		assert(result.ok === true && result.weightSum === 2, `expected weightSum=2`);
	});

	// ─── Scenario 6 ───────────────────────────────────────────
	await scenario('tampered signature: recovers to non-authority key → fails', () => {
		const tx = buildUnsignedTx();
		const signed = signTx(tx, aliceKey.priv);
		// Tamper with the signature: flip the recovery byte (first byte
		// of the hex) which changes the recovered pubkey.  Even tiny
		// edits to a valid signature recover to a totally different
		// candidate pubkey (this is how secp256k1 recovery works).
		const tampered = signed.signatures[0]!;
		const flipped = (parseInt(tampered.slice(0, 2), 16) ^ 0x01).toString(16).padStart(2, '0');
		const tamperedSig = flipped + tampered.slice(2);
		const tamperedTx: SignedTransaction = {
			...signed,
			signatures: [tamperedSig]
		};
		const auth: AuthorityType = {
			weight_threshold: 1,
			account_auths: [],
			key_auths: [[aliceKey.pub, 1]]
		};
		const result = verifyTransactionSignatures(tamperedTx, auth);
		// Expected: either weight_below_threshold (recovered key
		// not in authority) or the malformed-sig-skip path also
		// leading to weight=0.  Either way, not ok.
		assert(!result.ok, `expected failure on tampered sig, got ${JSON.stringify(result)}`);
	});

	// ─── Scenario 7 ───────────────────────────────────────────
	await scenario('PublicKey-typed key_auths entry (not string) works', () => {
		const tx = buildUnsignedTx();
		const signed = signTx(tx, aliceKey.priv);
		// dblurt's AuthorityType permits PublicKey objects in
		// key_auths (the chain-fetched account often deserializes
		// these as PublicKey instances rather than strings).  We
		// support both forms.
		const aliceKeyObj = PublicKey.fromString(aliceKey.pub);
		const auth: AuthorityType = {
			weight_threshold: 1,
			account_auths: [],
			key_auths: [[aliceKeyObj, 1]]
		};
		const result = verifyTransactionSignatures(signed, auth);
		assert(
			result.ok === true,
			`expected ok=true with PublicKey object, got ${JSON.stringify(result)}`
		);
	});

	// ─── Scenario 8 ───────────────────────────────────────────
	await scenario('weight_threshold=0 is degenerate but legal: any sig passes', () => {
		const tx = buildUnsignedTx();
		const signed = signTx(tx, aliceKey.priv);
		const auth: AuthorityType = {
			weight_threshold: 0,
			account_auths: [],
			key_auths: [[aliceKey.pub, 1]]
		};
		const result = verifyTransactionSignatures(signed, auth);
		assert(result.ok === true, `expected ok=true with threshold=0`);
		// weight_sum still 1 (sig matches alice)
		assert(result.ok === true && result.weightSum === 1, `expected weightSum=1`);
	});

	console.log(`\n${'─'.repeat(60)}`);
	if (failures === 0) {
		console.log(`✓ all ${scenarios} scenarios passed`);
		process.exit(0);
	} else {
		console.log(`✗ ${failures}/${scenarios} scenarios failed`);
		process.exit(1);
	}
}

await run();
