/**
 * v1.20.0 (V3-1) — the treasury re-pin tool builds the next release op from
 * the release op ON CHAIN, not from what one node's /v1/release serves: a node
 * that indexed the pin release while on v1.19 serves the treasury WITHOUT
 * btc.xpub / xmr.primary_address, and copying that would silently drop them
 * for everyone (V3's repin.mts). It refuses when the served treasury differs
 * from the chain's, and reads the chain from two RPC operators that must agree.
 */
import { describe, expect, it } from 'vitest';

import {
	checkServedAgainstChain,
	fetchReleasePayloadFromChain,
	findReleaseOpPayload
} from '../../src/lib/repinSource';

const XPUB =
	'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const ADDR = 'bc1qdwaelg52ts3e0m8fellkw5u9x7plfwc0kxnwnk';
const chainPayload = {
	version: '1.20.0',
	hash_manifest: { 'index.html': 'sha256-' + 'a'.repeat(43) + '=' },
	treasury: { btc: { address: ADDR, satoshis: 1000, xpub: ZPUB }, xmr: null, blurt: { base: 60 } },
	distribution: { source_sha256: 'a'.repeat(64), gpg_fingerprint: 'abcdef01'.repeat(5) }
};
const block = (payload: unknown, signer = 'morphit') => ({
	transaction_ids: ['aaaa', 'bbbb'],
	transactions: [
		{ operations: [['transfer', {}]] },
		{
			operations: [
				[
					'custom_json',
					{
						id: 'morphit_release_v1',
						required_auths: [],
						required_posting_auths: [signer],
						json: JSON.stringify(payload)
					}
				]
			]
		}
	]
});

describe('re-pin reads the release op from chain (V3-1)', () => {
	it('finds the release op by trx id and signer', () => {
		expect(findReleaseOpPayload(block(chainPayload), 'bbbb', 'morphit')).toEqual(chainPayload);
		expect(findReleaseOpPayload(block(chainPayload, 'mallory'), 'bbbb', 'morphit')).toBeNull();
		expect(findReleaseOpPayload(block(chainPayload), 'cccc', 'morphit')).toBeNull();
	});

	it('refuses when the node serves a treasury stripped of the xpub (V3 repin.mts)', () => {
		const served = {
			version: '1.20.0',
			treasury: { btc: { address: ADDR, satoshis: 1000 }, xmr: null, blurt: { base: 60 } }
		};
		const r = checkServedAgainstChain(served, chainPayload);
		expect(r.ok).toBe(false);
		if (!r.ok) expect(r.missing).toContain('treasury.btc.xpub');
	});

	it('accepts a matching node and keeps every other field of the chain op (distribution, …)', () => {
		const served = {
			version: '1.20.0',
			treasury: {
				btc: { address: ADDR, satoshis: 1000, xpub: XPUB },
				xmr: null,
				blurt: { base: 60 }
			}
		};
		const r = checkServedAgainstChain(served, chainPayload);
		expect(r.ok).toBe(true);
		if (r.ok) {
			expect(r.base.distribution).toEqual(chainPayload.distribution);
			expect(r.chainTreasury.btc?.xpub).toBe(XPUB);
		}
	});

	it('reads the block from two RPC operators that must return the same op', async () => {
		const agree = async () => ({ result: block(chainPayload) });
		expect(
			await fetchReleasePayloadFromChain(100, 'bbbb', 'morphit', ['https://a', 'https://b'], agree)
		).toEqual({ ok: true, payload: chainPayload });
		let i = 0;
		const differ = async () => ({
			result: block(i++ === 0 ? chainPayload : { ...chainPayload, version: '9.9.9' })
		});
		expect(
			(
				await fetchReleasePayloadFromChain(
					100,
					'bbbb',
					'morphit',
					['https://a', 'https://b'],
					differ
				)
			).ok
		).toBe(false);
		const one = async (url: string) => {
			if (url === 'https://b') throw new Error('down');
			return { result: block(chainPayload) };
		};
		expect(
			(await fetchReleasePayloadFromChain(100, 'bbbb', 'morphit', ['https://a', 'https://b'], one))
				.ok
		).toBe(false);
	});
});
