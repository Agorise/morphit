/**
 * The fee numbers a verdict uses, by the op's block time (feeRulesAtBlock.ts).
 * The database parts are covered by
 * test/integration/fee-rules-at-block-consensus.test.ts.
 */
import { describe, expect, it } from 'vitest';

import {
	blurtBaseOf,
	externalFeeAmountOf,
	featureFeeBlurtPerHourAt,
	feeToleranceAt,
	listingFeeInputsAt
} from '$indexer/fee/feeRulesAtBlock';
import { CONSENSUS_V2_ACTIVATION_TIME } from '$indexer/consensusActivation';
import { loadConfig } from '$config';

const ACT = Date.parse(CONSENSUS_V2_ACTIVATION_TIME);
const before = new Date(ACT - 1);
const at = new Date(ACT);

/** The config a node gets with nothing but the required settings. */
function shippedDefaults(): ReturnType<typeof loadConfig> {
	const saved = { ...process.env };
	for (const k of Object.keys(process.env)) if (k.startsWith('MORPHIT_')) delete process.env[k];
	Object.assign(process.env, {
		MORPHIT_INDEXER_DATABASE_URL: 'postgres://u:p@localhost:5432/morphit_indexer',
		MORPHIT_INDEXER_RELAY_ACCOUNT: 'tester',
		MORPHIT_INDEXER_FEE_RECIPIENT: 'tester',
		MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://indexer.example.org',
		MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY:
			'BLT6CVC6C3PgmMe5xDtxFXJvGHaLnUTtcsK1ghHomDqLPWW7yeMp9',
		MORPHIT_INDEXER_CHAIN_ID: 'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f'
	});
	try {
		return loadConfig();
	} finally {
		process.env = saved;
	}
}

/** A database with no release rows. */
const noReleases = {
	query: async () => ({ rows: [], rowCount: 0 }) as never
};

describe('fee rules by block time', () => {
	it('the tolerance is the node’s before the activation time, the federation’s from it', () => {
		expect(feeToleranceAt(before, 0.5)).toBe(0.5);
		expect(feeToleranceAt(at, 0.5)).toBe(0.001);
		expect(feeToleranceAt(at, 0.001)).toBe(0.001);
		// An unreadable time is never taken as activated.
		expect(feeToleranceAt(new Date(Number.NaN), 0.5)).toBe(0.5);
	});

	it('a node left on the shipped defaults judges exactly as the federation does', async () => {
		const cfg = shippedDefaults();
		const legacy = () => ({ baseBlurt: cfg.feeBaseBlurt, feeTolerance: cfg.feeTolerance });
		const pre = await listingFeeInputsAt(noReleases, { blockNum: 10, blockTime: before }, legacy);
		const post = await listingFeeInputsAt(noReleases, { blockNum: 10, blockTime: at }, legacy);
		expect(post).toEqual(pre);
		expect(feeToleranceAt(at, cfg.feeTolerance)).toBe(feeToleranceAt(before, cfg.feeTolerance));
		expect(featureFeeBlurtPerHourAt(at, cfg.featureFeeBlurtPerHour)).toBe(
			featureFeeBlurtPerHourAt(before, cfg.featureFeeBlurtPerHour)
		);
	});

	it('reads the pinned BLURT base and BTC / XMR amounts, and nothing malformed', () => {
		expect(blurtBaseOf({ blurt: { base: 62.5 } })).toBe(62.5);
		for (const t of [
			null,
			{},
			{ blurt: null },
			{ blurt: { base: 0 } },
			{ blurt: { base: '125' } }
		]) {
			expect(blurtBaseOf(t)).toBeNull();
		}
		expect(externalFeeAmountOf({ btc: { address: 'bc1q', satoshis: 400 } }, 'btc')).toBe(400);
		expect(externalFeeAmountOf({ xmr: { address: '8', piconero: '781250000' } }, 'xmr')).toBe(
			781250000n
		);
		for (const t of [
			null,
			{ btc: null },
			{ btc: { satoshis: 0 } },
			{ btc: { satoshis: 1.5 } },
			{ xmr: { piconero: '0' } },
			{ xmr: { piconero: 'x1' } }
		]) {
			expect(externalFeeAmountOf(t, 'btc')).toBeUndefined();
			expect(externalFeeAmountOf(t, 'xmr')).toBeUndefined();
		}
	});

	it('the featured-slot price is the node’s before the activation time, the federation’s from it', () => {
		expect(featureFeeBlurtPerHourAt(before, 80)).toBe(80);
		expect(featureFeeBlurtPerHourAt(at, 80)).toBe(50);
		expect(featureFeeBlurtPerHourAt(at, 10)).toBe(50);
	});
});
