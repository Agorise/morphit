/**
 * v1.20.0 (MK-H2) — bound XMR fees: integrated addresses and the encrypted
 * payment ID, checked against an INDEPENDENT implementation.
 *
 * Every vector below was produced with the PyPI `monero` package (1.1.1,
 * libsodium ed25519 via PyNaCl + its own Keccak), not with this code:
 *   - primary address: base58.encode(0x12 ‖ B ‖ A ‖ keccak[0..4]), accepted by
 *     monero.address.address() as a mainnet Address with the same keys;
 *   - integrated: Address.with_payment_id(pid), parsed back as
 *     IntegratedAddress with that payment_id;
 *   - derivation: ed25519.scalarmult(8·r, A) and, independently,
 *     scalarmult(8·a, R) — equal (sender == receiver);
 *   - payment_id8 = pid XOR keccak_256(derivation ‖ 0x8d)[0..8]
 *     (monero-project/monero device_default.cpp encrypt_payment_id);
 *   - extra = 01 ‖ R ‖ 02 09 01 ‖ payment_id8, parsed back by
 *     monero.transaction.extra.ExtraParser (nonce 01‖payment_id8, pubkey R).
 * pid = keccak_256("morphit-fee-v1|<account>/<permlink>")[0..8].
 * Generator: scratchpad M/genxmr.py (seeds "mk-h2-xmr-<view|spend|txkey>-<k>").
 */
import { describe, expect, it } from 'vitest';

import {
	parseXmrAddress,
	parseXmrPrimaryAddress,
	xmrFeePaymentId,
	xmrIntegratedAddress,
	moneroBase58Decode,
	moneroBase58Encode
} from '@morphit/release-schema';
import {
	encryptedPaymentIdsFromExtra,
	xmrDecryptPaymentId,
	xmrKeyDerivation
} from '$indexer/fee/xmrPaymentId';

const V = [
	{
		account: 'alice',
		permlink: 'order-kx2mq7p4n8za',
		primary:
			'447UAtPLv7u8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL49CyFBGy',
		integrated:
			'4Dp9BhCqXPR8bB454DGupLTFj5cBy4XgP8ru1EGpgrB7NgbxCXowhwEBStCS3zWuEXTQBdi2qSEAMScqifFo4VL4D5AqWT5Do24HzptoQp',
		payment_id: '2c510de573cb5596',
		tx_key: 'e5b4fe26ae0a3a2f7d2bbed8a0c2a1c6d66925ccdbcb6bcef67a0ad66a9b9807',
		tx_pub: '795b5d51f7d7ed6459559babccb0cc4943a56c79f58a90e9b250246fe749b1b5',
		derivation: '926172cd771793d96b1cddd08286a04e9f027cd026e7648366fda3757a335ac1',
		payment_id8: 'e75f39371458536e',
		extra:
			'01795b5d51f7d7ed6459559babccb0cc4943a56c79f58a90e9b250246fe749b1b5020901e75f39371458536e'
	},
	{
		account: 'bob',
		permlink: 'order-abc',
		primary:
			'47ohRcAbr8b8iaqq3sQWm795zAr8V5DKSLzfLDihsi55W4xaZ5dBu3zVnkqE7zMVc7ckPgz8AHYai96BzyNF4D4X5eSHr7B',
		integrated:
			'4HWNSQz6TQ78iaqq3sQWm795zAr8V5DKSLzfLDihsi55W4xaZ5dBu3zVnkqE7zMVc7ckPgz8AHYai96BzyNF4D4X7siYzW1cBbm5y9ah2G',
		payment_id: '19774cae1a70a02c',
		tx_key: 'e3deb87b0cb3877e6a223e7f123d782f70beef4bfe73751d7089bbaa3b733003',
		tx_pub: 'ffd818a3ded7ff51904d839f3533871e29329ddca2765b4bef939843001f4b7b',
		derivation: 'ff71b830490afaed5764314869dc444ca8f5689880998028f116e3c861f1760e',
		payment_id8: '21ef5479a14c4508',
		extra:
			'01ffd818a3ded7ff51904d839f3533871e29329ddca2765b4bef939843001f4b7b02090121ef5479a14c4508'
	},
	{
		account: 'a.b-c',
		permlink: 'order-zzzzzzzzzzzz',
		primary:
			'48qm4BLKDdbGZMcA5pJD8WPywsmdJwr4t7dLdNnx7J43D8Ar6hKGdYmVV3tanhe1CAfEmUqyYXd6URVdbRbymtVk7eNRA89',
		integrated:
			'4JYS4z9opu7GZMcA5pJD8WPywsmdJwr4t7dLdNnx7J43D8Ar6hKGdYmVV3tanhe1CAfEmUqyYXd6URVdbRbymtVkAmVvKn4X3tVKDEKmx4',
		payment_id: '64f5ed2e193ff2a1',
		tx_key: '30b01d9b7dc709d28705359cc20ed714a5ee8cb297cc98a074bb919c7475e80b',
		tx_pub: '099e0c5a719813f2d590bc550e17de52ea213133bb595e38e21420496f879e4d',
		derivation: '313d06cad3c976af200a14d37c2dde02af176b96a2313ed3e9609ca0d8eb8b97',
		payment_id8: '474424f1b24577cf',
		extra:
			'01099e0c5a719813f2d590bc550e17de52ea213133bb595e38e21420496f879e4d020901474424f1b24577cf'
	},
	{
		account: 'morphit',
		permlink: 'x',
		primary:
			'49KYK11CyC3GagpZ1cX78S3m19TCQz3LvJUti1zHGJU1PxcJrC2cN3VWuGE9DpfKoFW7F2hCMVtH77hCaaMNjWLACvyXbrN',
		integrated:
			'4K2DKophaTZGagpZ1cX78S3m19TCQz3LvJUti1zHGJU1PxcJrC2cN3VWuGE9DpfKoFW7F2hCMVtH77hCaaMNjWLAJbPceQbJUdeMLThRs6',
		payment_id: '2e66934a839a01b4',
		tx_key: '551942e0cc7cd093d0d5d502589eefc2cf00fd527b58eaad20494921d2818c00',
		tx_pub: '1d705d0ea7196957e3fe46b6c3d4c0369eb46b18c21a0ee23f0eb624978770e5',
		derivation: '75de485117563cd847f5473e45cf3a2b983ff78f7ed8f9c9280269e014be47d3',
		payment_id8: '5d9375bea8558ef6',
		extra:
			'011d705d0ea7196957e3fe46b6c3d4c0369eb46b18c21a0ee23f0eb624978770e50209015d9375bea8558ef6'
	}
];

// Morphit's real canonical treasury subaddress (canonicalTreasury.ts).
const CANONICAL_SUBADDRESS =
	'84bwu2PWp3NaRudAKTadmeZPBLTjL5f4bKU8F6NJKqxgUvwth6QxUVSUNFAQnHbbuQcMRNR4baYUKNcZXQtKMMKm4aVE3Fe';
// monero-python-built: same keys, other prefixes.
const TESTNET =
	'9uvyLnpzBSV84B29APC8AQ4Qmx7nd2X4eX79cxtmXecv76exk4mG7YyDeH15hKJkJ7Y5q26GZoo3V64qL6Fs1A1A7D9oaFf';
const STAGENET =
	'54bTwP5gYgV84B29APC8AQ4Qmx7nd2X4eX79cxtmXecv76exk4mG7YyDeH15hKJkJ7Y5q26GZoo3V64qL6Fs1A1A7GXfmQS';
const SUB =
	'85DaBupZVVo84B29APC8AQ4Qmx7nd2X4eX79cxtmXecv76exk4mG7YyDeH15hKJkJ7Y5q26GZoo3V64qL6Fs1A1A7HWyMoe';

describe('bound XMR fee — addresses (vs PyPI monero)', () => {
	it('derives the payment ID and integrated address byte-for-byte', () => {
		for (const v of V) {
			expect(xmrFeePaymentId(v.account, v.permlink)).toBe(v.payment_id);
			expect(xmrIntegratedAddress(v.primary, v.payment_id)).toBe(v.integrated);
			const i = parseXmrAddress(v.integrated);
			expect(i.ok && i.value.kind).toBe('integrated');
			expect(i.ok && i.value.paymentId).toBe(v.payment_id);
		}
	});

	it('round-trips Monero base58 on every vector', () => {
		for (const v of V) {
			for (const a of [v.primary, v.integrated]) {
				expect(moneroBase58Encode(moneroBase58Decode(a)!)).toBe(a);
			}
		}
	});

	it('accepts only a mainnet STANDARD address as the treasury primary', () => {
		const reason = (s: string) => {
			const r = parseXmrPrimaryAddress(s);
			return r.ok ? r.value.kind : r.reason;
		};
		expect(reason(V[0]!.primary)).toBe('standard');
		expect(reason(CANONICAL_SUBADDRESS)).toBe('xmr_primary_is_subaddress');
		expect(reason(SUB)).toBe('xmr_primary_is_subaddress');
		expect(reason(V[0]!.integrated)).toBe('xmr_primary_is_integrated');
		expect(reason(TESTNET)).toBe('xmr_primary_wrong_network');
		expect(reason(STAGENET)).toBe('xmr_primary_wrong_network');
		const typo =
			V[0]!.primary.slice(0, 50) +
			(V[0]!.primary[50] === 'a' ? 'b' : 'a') +
			V[0]!.primary.slice(51);
		expect(reason(typo)).toBe('xmr_address_bad_checksum');
		expect(reason('4' + 'x'.repeat(94))).toMatch(/^xmr_address_/);
	});
});

describe('bound XMR fee — encrypted payment ID (vs PyPI monero)', () => {
	it('computes the key derivation 8·r·A exactly like libsodium', () => {
		for (const v of V) {
			const p = parseXmrAddress(v.primary);
			expect(p.ok).toBe(true);
			if (!p.ok) continue;
			expect(xmrKeyDerivation(p.value.viewPub, v.tx_key)).toBe(v.derivation);
		}
	});

	it("decrypts the wallet-encrypted payment ID back to the order's ID", () => {
		for (const v of V) {
			const p = parseXmrAddress(v.primary);
			if (!p.ok) throw new Error('bad vector');
			expect(xmrDecryptPaymentId(p.value.viewPub, v.tx_key, v.payment_id8)).toBe(v.payment_id);
		}
	});

	it('a different order, account or tx key does not decrypt to the right ID', () => {
		const v = V[0]!;
		const w = V[1]!;
		const p = parseXmrAddress(v.primary);
		if (!p.ok) throw new Error('bad vector');
		expect(xmrDecryptPaymentId(p.value.viewPub, w.tx_key, v.payment_id8)).not.toBe(v.payment_id);
		expect(xmrFeePaymentId('mallory', v.permlink)).not.toBe(v.payment_id);
		expect(xmrFeePaymentId(v.account, v.permlink + 'x')).not.toBe(v.payment_id);
	});

	it('finds the encrypted ID in tx extra (as ExtraParser does)', () => {
		for (const v of V) expect(encryptedPaymentIdsFromExtra(v.extra)).toEqual([v.payment_id8]);
		// padding + additional pubkeys field before the nonce
		expect(encryptedPaymentIdsFromExtra('0000' + '0401' + 'aa'.repeat(32) + V[0]!.extra)).toEqual([
			V[0]!.payment_id8
		]);
		expect(encryptedPaymentIdsFromExtra('zz')).toBeNull();
	});

	it('walks extra layouts exactly as PyPI monero ExtraParser splits them', () => {
		const R = '795b5d51f7d7ed6459559babccb0cc4943a56c79f58a90e9b250246fe749b1b5';
		const add = Array.from({ length: 64 }, (_, i) => i.toString(16).padStart(2, '0')).join('');
		// ExtraParser: pubkeys [R, add0, add1], nonces ['01e75f…'] — TWO additional keys to skip
		expect(
			encryptedPaymentIdsFromExtra('01' + R + '0402' + add + '020901e75f39371458536e')
		).toEqual(['e75f39371458536e']);
		// ExtraParser: nonces ['00' + 32 zero bytes] — an UNencrypted 32-byte ID is not an encrypted one
		expect(encryptedPaymentIdsFromExtra('01' + R + '0221' + '00'.repeat(33))).toEqual([]);
		// nonce first, then the tx pubkey
		expect(encryptedPaymentIdsFromExtra('020901e75f39371458536e01' + R)).toEqual([
			'e75f39371458536e'
		]);
		// a 9-byte nonce whose marker is not 0x01 (monero: TX_EXTRA_NONCE_ENCRYPTED_PAYMENT_ID) is not an ID
		expect(encryptedPaymentIdsFromExtra('01' + R + '020900e75f39371458536e')).toEqual([]);
	});

	it('refuses tx keys that are not a reduced 32-byte scalar', () => {
		const p = parseXmrAddress(V[0]!.primary);
		if (!p.ok) throw new Error('bad vector');
		expect(xmrKeyDerivation(p.value.viewPub, '00'.repeat(32))).toBeNull();
		expect(xmrKeyDerivation(p.value.viewPub, 'ff'.repeat(32))).toBeNull();
		expect(xmrKeyDerivation(p.value.viewPub, 'ab'.repeat(31))).toBeNull();
	});
});
