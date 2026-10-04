/**
 * (+ nit) — a pinned treasury address is decoded with its
 * checksum. A shape regex alone let a mistyped address pin, and every fee paid
 * to it would be burned. Both validators — the shared release-schema one and
 * the indexer's release handler — refuse a typo; real addresses of every
 * mainnet kind, and an all-uppercase bech32 address (BIP173), pass.
 */
import { describe, expect, it } from 'vitest';
import { isBtcMainnetAddress, validateReleasePayload } from '@morphit/release-schema';
import { validateReleaseOp } from '$indexer/handlers/release';
import { CANONICAL_TREASURY } from '../../src/config/canonicalTreasury';

const H = 'sha256-' + 'a'.repeat(43) + '=';
const typo = (s: string, at: number) =>
	s.slice(0, at) +
	(s[at] === 'q' ? 'p' : s[at] === 'A' ? 'B' : s[at] === '2' ? '3' : 'q') +
	s.slice(at + 1);

const withTreasury = (btc: string | null, xmr: string | null) => ({
	version: '1.20.4',
	hash_manifest: { 'index.html': H },
	treasury: {
		btc: btc === null ? null : { address: btc, satoshis: 416 },
		xmr: xmr === null ? null : { address: xmr, piconero: '781250000' }
	}
});
const schemaVerdict = (btc: string | null, xmr: string | null) => {
	const r = validateReleasePayload(withTreasury(btc, xmr));
	return r.ok ? 'ok' : r.reason;
};
const handlerVerdict = (btc: string | null, xmr: string | null) => {
	const r = validateReleaseOp(withTreasury(btc, xmr)) as { reason?: string };
	return r.reason ?? 'ok';
};

describe('treasury addresses are checksum-validated', () => {
	const goodBtc = [
		CANONICAL_TREASURY.btc,
		'1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
		'3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
		'bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297',
		CANONICAL_TREASURY.btc.toUpperCase()
	];
	for (const a of goodBtc) {
		it(`accepts ${a.slice(0, 12)}…`, () => {
			expect(isBtcMainnetAddress(a)).toBe(true);
		});
	}

	it('refuses a one-character typo of a BTC address, in both validators', () => {
		const bad = typo(CANONICAL_TREASURY.btc, 20);
		expect(isBtcMainnetAddress(bad)).toBe(false);
		expect(schemaVerdict(bad, null)).toBe('treasury_btc_address_bad_checksum');
		expect(handlerVerdict(bad, null)).toBe('treasury_btc_address_bad_checksum');
		expect(schemaVerdict(CANONICAL_TREASURY.btc, null)).toBe('ok');
	});

	it('refuses a one-character typo of an XMR address, in both validators', () => {
		const bad = typo(CANONICAL_TREASURY.xmr, 40);
		expect(schemaVerdict(null, bad)).toBe('treasury_xmr_address_bad_checksum');
		expect(handlerVerdict(null, bad)).toBe('treasury_xmr_address_bad_checksum');
		expect(schemaVerdict(null, CANONICAL_TREASURY.xmr)).toBe('ok');
		expect(handlerVerdict(null, CANONICAL_TREASURY.xmr)).toBe('ok');
	});

	it('refuses mixed-case bech32 and a testnet-version base58 address', () => {
		const mixed = 'bc1Q' + CANONICAL_TREASURY.btc.slice(4);
		expect(isBtcMainnetAddress(mixed)).toBe(false);
		expect(isBtcMainnetAddress('mipcBbFg9gMiCh81Kj8tqqdgoZub1ZJRfn')).toBe(false);
	});
});
