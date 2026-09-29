/**
 * v1.20.0 (MK-H2) — `sudo morphit-ops treasury btc`: what the maintainer sets in the
 * wallet so it sees every per-order BTC fee payment.
 *
 * Each BTC-fee order pays its own receive address n of the treasury xpub.
 * Orders that are never paid leave unused addresses; a wallet stops scanning
 * after "gap limit" unused addresses in a row, so the command reports the
 * longest such run and recommends a gap limit above it.
 * Address vectors: BIP84 "abandon … about", account 0 (bip-0084.mediawiki).
 */
import { describe, expect, it } from 'vitest';

import { buildBtcTreasuryReport, formatBtcTreasuryReport } from '../src/commands/treasury.ts';

const XPUB =
	'xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V';
const ZPUB =
	'zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs';

const alloc = (
	idx: number,
	funded: boolean,
	status = funded ? 'verified' : 'awaiting_payment'
) => ({
	idx,
	account: `u${idx}`,
	permlink: `p${idx}`,
	fee_status: status,
	received_sats: funded ? 1000 : 0,
	unconfirmed_sats: 0
});

describe('treasury btc report', () => {
	it('finds the longest run of unused addresses and recommends a gap limit above it', () => {
		// funded: 0, 2, 40 → runs: 1 (idx 1) and 37 (idx 3..39); 4 unused above the last
		const allocs = [alloc(0, true), alloc(1, false), alloc(2, true)];
		for (let i = 3; i < 40; i++) allocs.push(alloc(i, false, 'missing'));
		allocs.push(
			alloc(40, true),
			alloc(41, false),
			alloc(42, false),
			alloc(43, false),
			alloc(44, false)
		);
		const r = buildBtcTreasuryReport({ xpub: XPUB, pinnedInBlock: 1234 }, allocs, 2);
		expect(r).toMatchObject({
			keyId: 'fd13aac9',
			zpub: ZPUB,
			handedOut: 45,
			highestIndex: 44,
			paid: 3,
			awaiting: 5,
			refused: 2,
			longestUnusedRun: 37,
			unusedAboveLastPaid: 4
		});
		expect(r.recommendedGapLimit).toBeGreaterThan(37);
		expect(r.recommendedGapLimit % 10).toBe(0);
	});

	it('never recommends less than the usual wallet default of 20', () => {
		const r = buildBtcTreasuryReport({ xpub: XPUB, pinnedInBlock: 1 }, [alloc(0, true)], 0);
		expect(r.recommendedGapLimit).toBe(20);
		const none = buildBtcTreasuryReport({ xpub: XPUB, pinnedInBlock: 1 }, [], 0);
		expect(none).toMatchObject({ handedOut: 0, highestIndex: null, recommendedGapLimit: 20 });
	});

	it('counts an address with money seen on it as used even if the order is not verified', () => {
		const a = { ...alloc(5, false), received_sats: 300 };
		const r = buildBtcTreasuryReport({ xpub: XPUB, pinnedInBlock: 1 }, [a], 0);
		expect(r.longestUnusedRun).toBe(5);
	});

	it('prints the wallet settings, and the address list only when asked', () => {
		const r = buildBtcTreasuryReport(
			{ xpub: XPUB, pinnedInBlock: 1234 },
			[alloc(0, true), alloc(1, false)],
			0
		);
		const short = formatBtcTreasuryReport(r, false).join('\n');
		expect(short).toContain(ZPUB);
		expect(short).toContain(`wpkh(${XPUB}/0/*)`);
		expect(short).toContain('Settings → Advanced → Gap limit');
		expect(short).toContain('wallet.change_gap_limit(20)');
		expect(short).not.toContain('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
		const long = formatBtcTreasuryReport(r, true).join('\n');
		expect(long).toContain('bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu');
		expect(long).toContain('bc1qnjg0jd8228aq7egyzacy8cys3knf9xvrerkf9g');
	});
});
