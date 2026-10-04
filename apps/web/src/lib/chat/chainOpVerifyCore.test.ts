/**
 * Local transaction-signature verification counts each signing KEY once, and
 * digests with the Blurt chain id.
 */
import { describe, expect, it } from 'vitest';
import { PrivateKey, cryptoUtils, DEFAULT_CHAIN_ID } from '@beblurt/dblurt';
import { verifyTransactionSignatures } from './chainOpVerifyCore';

const k1 = PrivateKey.fromSeed('signer one');
const k2 = PrivateKey.fromSeed('signer two');
const pub = (k: PrivateKey) => k.createPublic('BLT').toString();
const tx = {
	ref_block_num: 1,
	ref_block_prefix: 2,
	expiration: '2026-10-02T00:00:00',
	extensions: [],
	operations: [
		['custom_json', { required_auths: [], required_posting_auths: ['alice'], id: 'x', json: '{}' }]
	]
};
const signedBy = (...keys: PrivateKey[]) =>
	cryptoUtils.signTransaction(tx as never, keys, DEFAULT_CHAIN_ID) as unknown as {
		signatures: string[];
	};
const authority = (threshold: number) =>
	({
		weight_threshold: threshold,
		account_auths: [],
		key_auths: [
			[pub(k1), 1],
			[pub(k2), 1]
		]
	}) as never;

describe('verifyTransactionSignatures', () => {
	it('one key whose signature is listed twice does not meet a 2-of-2 threshold', async () => {
		const one = signedBy(k1);
		const dup = { ...one, signatures: [one.signatures[0]!, one.signatures[0]!] };
		const r = await verifyTransactionSignatures(dup as never, authority(2));
		expect(r.ok).toBe(false);
	});

	it('two distinct keys meet a 2-of-2 threshold', async () => {
		const r = await verifyTransactionSignatures(signedBy(k1, k2) as never, authority(2));
		expect(r.ok).toBe(true);
	});

	it('a signature made for another chain id does not verify', async () => {
		const other = cryptoUtils.signTransaction(tx as never, [k1], Buffer.alloc(32, 1)) as never;
		const r = await verifyTransactionSignatures(other, authority(1));
		expect(r.ok).toBe(false);
	});
});
