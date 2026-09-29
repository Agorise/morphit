/**
 * v1.20.0 (MK-H2) — per-order BTC fee addresses from the pinned treasury
 * account xpub (packages/release-schema/src/btcXpub.ts).
 *
 * The indexer, the release validator and the browser all derive fee addresses
 * through this one module, so these vectors pin all three at once.
 *
 * Vectors checked:
 *   1. BIP84 "Test vectors" (github.com/bitcoin/bips, bip-0084.mediawiki):
 *      mnemonic "abandon abandon abandon abandon abandon abandon abandon abandon
 *      abandon abandon abandon about", account 0 zpub6rFR7y4Q2Aij…AGutZYs,
 *      m/84'/0'/0'/0/0 = bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu,
 *      m/84'/0'/0'/0/1 = bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g.
 *   2. BIP32 "Test vector 1" (bip-0032.mediawiki): the public child
 *      m/0H/1/2H → m/0H/1/2H/2 (CKDpub of a depth-3 hardened key).
 *   3. An INDEPENDENT implementation: bip_utils 2.12.2 (PyPI), four BIP84
 *      accounts from fixed seeds, receive indices 0, 1, 2, 19, 20, 21, 999,
 *      65535 and 2^31-1, plus the xpub re-serialization and the key id
 *      (HASH160(pubkey)[0:4]). Generated with:
 *        Bip84.FromSeed(sha256("morphit-mk-h2-crosscheck-<k>"), BITCOIN)
 *          .Purpose().Coin().Account(k).Change(CHAIN_EXT).AddressIndex(i)
 */
import { describe, expect, it } from 'vitest';

import {
	parseAccountXpub,
	deriveBtcFeeAddress,
	deriveChildXpub,
	BTC_FEE_MAX_INDEX
} from '@morphit/release-schema';

const BIP84_ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';
const BIP84_ZPRV =
	'zprvAdG4iTXWBoARxkkzNpNh8r6Qag3irQB8PzEMkAFeTRXxHpbF9z4QgEvBRmfvqWvGp42t42nvgGpNgYSJA9iefm1yYNZKEm7z6qUWCroSQnE';
const BIP84_ROOTPUB =
	'zpub6jftahH18ngZxLmXaKw3GSZzZsszmt9WqedkyZdezFtWRFBZqsQH5hyUmb4pCEeZGmVfQuP5bedXTB8is6fTv19U1GQRyQUKQGUTzyHACMF';

const CROSSCHECK: {
	zpub: string;
	xpub: string;
	keyId: string;
	addresses: Record<number, string>;
}[] = [
	{
		zpub: 'zpub6rpvvF5syBD7z9qUeqMCZVn1FDVvDdS96Vopu8P7nhfnyVQ4JGiJL8PVrBiT5mB6kouzENRMcQEMz66zehJ7is9AkRu4u2zvazS4XHkJ1xg',
		xpub: 'xpub6DAQJuk3fp8AHZTEz7mx9KazuHD2LPT9GGmPLLbM2gv2sHmbnxPB615DomoH5wsFwXgNjREEh5XGDWssDJU68Pmy1kWDjDMx3YJmk7tfRk9',
		keyId: 'ab0973c3',
		addresses: {
			0: 'bc1qqvlc56myrgt8ncnrmujhn8609prsl9ejtalt9q',
			1: 'bc1qqvdhwly9uws70dmpsshqx6hry6hvpzsv4m2424',
			2: 'bc1qkqrx76qyjkwlanj9c9duzct2vkuns94v893q94',
			19: 'bc1q4jvx054yay5lalqs7vg284tyfp4lgkds3dhv9e',
			20: 'bc1q74yrtaf5qs30a2a20yyfyytycmgq25xa92tqu4',
			21: 'bc1q3f7h3dqm0ct93485zhj679vk3hgdxvvevekwkl',
			999: 'bc1q2gsvlwn38al6dndmqz8tzwym58cd83tc9qss0f',
			65535: 'bc1qau4wq8xvyelwgsr4ng4rgnl53jpp0qn4mf5ya7',
			2147483647: 'bc1qfx96gmf5prvgc67h2r03wczvuf854q0mv3ae24'
		}
	},
	{
		zpub: 'zpub6rcLaYBbvGb9vPYgutNCRJP1WPCmnRvKy9FCk4uZKexLYXceDxR4mEKY5gDhgZUAcXLLeqst3VzrWD3fv4f272LbZHPMgTrgx47oDWZkHT3',
		xpub: 'xpub6CwoyCqmcuWCDoATFAnx18C1ASusuBwL8vCmBH7nZeCaSKzBie5wX71G3GJXgkAKoF6j9tgm8BHkjdpYUfpzWYyPpbzWWeDiQbzWSS2TGVi',
		keyId: 'ca7bedca',
		addresses: {
			0: 'bc1ql4se4rmvhmsg05l7clq3jkyswwc8jcuerx5xvj',
			1: 'bc1qlnwle6gkea62w7ty0ykkxmnqjv4w5uf4xz9ew5',
			2: 'bc1qddvwp8zgx8v05agwmnp853tllz53n5564ahgqy',
			19: 'bc1q3jxnjazylqeq4jfuy5325c4n00xpxdxxsck38d',
			20: 'bc1q9pledveytasmwwvseeua5fs4swgqfjfuc9kktf',
			21: 'bc1qdfnnpdad56rvvkfl6l4x4wemurehjxegza08ge',
			999: 'bc1q5axll40kk0rr0p8u8e6q4v0zjlhmz8zzd8xrkh',
			65535: 'bc1qwupv0afvs04ujvtwvcpdm9ffg798szz9seuqaq',
			2147483647: 'bc1qsfwdmk9anlujc20v5jxk2ykmyu8l9jafwhcslm'
		}
	},
	{
		zpub: 'zpub6qrUbaPqGyp45iiivGEH1VfVpLcBLVbhqYCZPGuHQP2LENyQWXQjdQQzQuUipUPrAAAofJHB4bKUcyvdbopWDCaMZE5DBmLbCVc76W9WDNd',
		xpub: 'xpub6CBwzF3zycj6P8LVFYf2bKUVUQKHTFci1KA7pV7WeNGa8BLx1D5cPH6iNVZYpf61LswCAM649GcNrQhWAQzUcjD9pYgN1whcf3UpKLiZYT3',
		keyId: 'e199cac5',
		addresses: {
			0: 'bc1q7tuwh4kz80e8m4p2mlwwlq6ss20pnd9vt3yme4',
			1: 'bc1qsneu2qscar5sxj9yw38tv549uujl3l9vxsjje2',
			2: 'bc1q4055hjpwvtnjtmkxfp8zseje84xreeakhcg3wt',
			19: 'bc1ql6gcnqtp73zmhdhuwqstkfj6n6dk25nsw550xl',
			20: 'bc1qyfer7kv4tld9sqvny94h9aug9x0mppdswexjhp',
			21: 'bc1qgn84zumms5x54hckgwa88jtt64k74xn480vecw',
			999: 'bc1qlrcry3p88cf3caatcag2mxwqwcwl2kj07jechv',
			65535: 'bc1ql6yresla4qp940grl8znvqzcuqrdvjunrs97pa',
			2147483647: 'bc1q3u8kufy8r8prs95h366yngcdh0mr2jvjfqterz'
		}
	},
	{
		zpub: 'zpub6qxLaPntgGtorYruLpnuDxBNTucmPKvzvpdX7b6SYMJxgnPvN1WgornFnZaBRUcCwacgKTvdzPS4A9MFDLs4eYomjk28tKxBStWwVDCeSkc',
		xpub: 'xpub6CHoy4T4Nuor9xUfg7DeomzN7yKsW5x16bb5YoJfnLZCaamTrhBZZjTyk9f1RfJN8JP4pWjX54ixPa87mx3345Sa14dHiWKCuSPei7Xhbv7',
		keyId: 'ad300c18',
		addresses: {
			0: 'bc1qy8lv4wynkhycu42skk6e9ck6lsx5nmwne82rga',
			1: 'bc1q4nwktjmpxslf2apntmfkf9kzqqlcxzr8p3adru',
			2: 'bc1q68kcr9tccmzc26uxpn9wy7z7wy6jgjtq60pj2j',
			19: 'bc1qfqf06tnf99qxajxrdajqv3mm6mlpwcdqucjml0',
			20: 'bc1q53hu03yaytkgag943dgp63rlzym3y33k8ac0ed',
			21: 'bc1q5kzgdh3u734cr34e8ampylxlhu04ku2l8p67a4',
			999: 'bc1q9wmlpj28kq8w9j9yy0yqe7dqxvtmyr7dz88vk0',
			65535: 'bc1qndchgr5q08s4mevnepdreeuse3d8jhe7v4v0xx',
			2147483647: 'bc1qjeu9suphe4rk4wlu6zz5h5m7trjax0c47ffkg4'
		}
	}
];

describe('BIP84 account xpub → per-order fee address', () => {
	it('matches the BIP84 test vectors (receive #0 and #1)', () => {
		expect(deriveBtcFeeAddress(BIP84_ZPUB, 0)).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
		expect(deriveBtcFeeAddress(BIP84_ZPUB, 1)).toBe('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
	});

	it('gives the same addresses for the xpub and zpub spellings of one key', () => {
		const p = parseAccountXpub(BIP84_ZPUB);
		expect(p.ok).toBe(true);
		if (!p.ok) return;
		expect(p.value.xpub.startsWith('xpub')).toBe(true);
		expect(p.value.zpub).toBe(BIP84_ZPUB);
		expect(deriveBtcFeeAddress(p.value.xpub, 0)).toBe('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
		// Normalisation is idempotent: parsing the canonical form yields itself.
		const again = parseAccountXpub(p.value.xpub);
		expect(again.ok && again.value.xpub).toBe(p.value.xpub);
	});

	it('matches BIP32 test vector 1: CKDpub(m/0H/1/2H, 2)', () => {
		const p = parseAccountXpub(
			'xpub6D4BDPcP2GT577Vvch3R8wDkScZWzQzMMUm3PWbmWvVJrZwQY4VUNgqFJPMM3No2dFDFGTsxxpG5uJh7n7epu4trkrX7x7DogT5Uv6fcLW5'
		);
		expect(p.ok).toBe(true);
		if (!p.ok) return;
		expect(deriveChildXpub(p.value, 2)).toBe(
			'xpub6FHa3pjLCk84BayeJxFW2SP4XRrFd1JYnxeLeU8EqN3vDfZmbqBqaGJAyiLjTAwm6ZLRQUMv1ZACTj37sR62cfN7fe5JnJ7dh8zL4fiyLHV'
		);
	});

	it('agrees with an independent implementation (bip_utils 2.12.2) on every vector', () => {
		for (const v of CROSSCHECK) {
			const p = parseAccountXpub(v.zpub);
			expect(p.ok).toBe(true);
			if (!p.ok) continue;
			expect(p.value.xpub).toBe(v.xpub);
			expect(p.value.keyId).toBe(v.keyId);
			for (const [i, addr] of Object.entries(v.addresses)) {
				expect(deriveBtcFeeAddress(v.zpub, Number(i))).toBe(addr);
				expect(deriveBtcFeeAddress(v.xpub, Number(i))).toBe(addr);
			}
		}
	});

	it('refuses private, testnet, wrong-script, non-account and corrupted keys', () => {
		const reason = (s: unknown) => {
			const r = parseAccountXpub(s);
			return r.ok ? 'ok' : r.reason;
		};
		expect(reason(BIP84_ZPRV)).toBe('xpub_is_private');
		expect(
			reason(
				'xpub661MyMwAqRbcFtXgS5sYJABqqG9YLmC4Q1Rdap9gSE8NqtwybGhePY2gZ29ESFjqJoCu1Rupje8YtGqsefD265TMg7usUDFdp6W1EGMcet8'
			)
		).toBe('xpub_not_account_level'); // BIP32 TV1 master key (depth 0)
		expect(reason(BIP84_ROOTPUB)).toBe('xpub_not_account_level');
		expect(
			reason(
				'vpub5YFAPkuWn7i4tYUFkwqKpdSoxES92E4f2Antqkz27cPNYbhF76ZzXzN8ML8tHS446MnD5sdzEndTT2WLVwicrH4DFGGZNvto2Hz8R7qT4Ef'
			)
		).toBe('xpub_testnet');
		expect(
			reason(
				'ypub6WnrV4bdsHKswMsH1Fu97Abvq9FQMakLYduhmYG4MCGhcpk7nFbLffBLcz6a43NGMvSVDwFhjDxd3dtYBaeQVWLwWKyfG6rGW3HBR1s7xHZ'
			)
		).toBe('xpub_wrong_script_type');
		// depth 3 but a NON-hardened child number: not an account key.
		expect(
			reason(
				'xpub6CBAQNzqvUrz3J3rNEkzKXGLZtNUzpeunnznLRpR6do236BmuqPE9bW3tFYHWDmyctZfdKRJZuonDiKCq5wbLSwAnTwSudRDzWQa7bunBnk'
			)
		).toBe('xpub_not_account_level');
		// depth 2
		expect(
			reason(
				'xpub6AJ2YbUy3qix94aHZtdgfuGYAM7AnikQtrspRPpwvBgfyioKcJBDEJeFco6PqpdLYLgziurBbHKgQr9ytYodmAzfWQ91ggd6tckNQ8D7iBJ'
			)
		).toBe('xpub_not_account_level');
		// key bytes that are not a compressed point (0x04 prefix)
		expect(
			reason(
				'xpub6CBAQNzzG9PwzqCkbt6Sz32sxa27VSrrxm1DoFhcb83aQdk8eagZ1zDrNSFiwDvsBtUbdcyJfUmjzxqqb8oN7znMAL79sKJ6hf6bSKXjg5c'
			)
		).toBe('xpub_bad_key');
		// one-character typo → checksum fails
		const typo =
			BIP84_ZPUB.slice(0, 40) + (BIP84_ZPUB[40] === 'a' ? 'b' : 'a') + BIP84_ZPUB.slice(41);
		expect(reason(typo)).toBe('xpub_bad_checksum');
		expect(reason(42)).toBe('xpub_not_string');
		expect(reason('')).toBe('xpub_not_string');
		// surrounding whitespace from a copy-paste is fine
		expect(reason(`  ${BIP84_ZPUB}\n`)).toBe('ok');
	});

	it('refuses indices outside 0 … 2^31-1', () => {
		expect(() => deriveBtcFeeAddress(BIP84_ZPUB, -1)).toThrow('btc_fee_index_out_of_range');
		expect(() => deriveBtcFeeAddress(BIP84_ZPUB, BTC_FEE_MAX_INDEX + 1)).toThrow(
			'btc_fee_index_out_of_range'
		);
		expect(() => deriveBtcFeeAddress(BIP84_ZPUB, 1.5)).toThrow('btc_fee_index_out_of_range');
		expect(() => deriveBtcFeeAddress(BIP84_ZPRV, 0)).toThrow('xpub_is_private');
	});
});
