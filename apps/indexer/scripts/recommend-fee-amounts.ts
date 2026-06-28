#!/usr/bin/env tsx
/**
 * Morphit operator CLI helper — recommend BTC and XMR fee
 * amounts targeting a USD-equivalent value.
 *
 * Usage (from anywhere):
 *   tsx apps/indexer/scripts/recommend-fee-amounts.ts
 *   tsx apps/indexer/scripts/recommend-fee-amounts.ts --target-usd 0.50
 *
 * Pulls BTC/USD and XMR/USD from Coingecko's free public ticker
 * and prints `MORPHIT_INDEXER_BTC_FEE_SATOSHIS` and
 * `MORPHIT_INDEXER_XMR_FEE_PICONERO` lines you can paste into
 * morphit.config.env.
 *
 * The indexer does NOT use this script automatically — fee
 * verification is BLURT-native and doesn't depend on USD prices.
 * This is a one-off operator convenience for setting BTC/XMR
 * amounts that are economically comparable to the BLURT fee.
 *
 * Part 110: the price-fetch + math have been extracted into
 * `apps/indexer/src/lib/feeAmountCalc.ts` so the setup wizard
 * (apps/ops-cli) can reuse them without duplicating logic.
 *
 * If Coingecko is unreachable, the script prints a clear error
 * and points you at https://www.coingecko.com so you can look up
 * prices manually.
 */

import {
	computeFeeAmounts,
	fetchBtcXmrPricesFromCoingecko
} from '../src/lib/feeAmountCalc';
// Canonical USD target — the single source of truth (the canonical
// economics in @morphit/asset-registry).
import { LISTING_FEE_USD } from '@morphit/asset-registry';

function parseTargetUsd(argv: readonly string[]): number {
	const idx = argv.indexOf('--target-usd');
	if (idx === -1) return LISTING_FEE_USD.btc;
	const next = argv[idx + 1];
	if (!next) {
		console.error('--target-usd requires a value (e.g. --target-usd 0.50)');
		process.exit(2);
	}
	const n = Number(next);
	if (!Number.isFinite(n) || n <= 0) {
		console.error(`invalid --target-usd value: ${next}`);
		process.exit(2);
	}
	return n;
}

async function main(): Promise<void> {
	const argv = process.argv.slice(2);
	if (argv.includes('--help') || argv.includes('-h')) {
		console.log(
			[
				'Usage: tsx apps/indexer/scripts/recommend-fee-amounts.ts [--target-usd N]',
				'',
				`  --target-usd N    Target USD value per fee (default ${LISTING_FEE_USD.btc})`,
				'',
				'Pulls live BTC/USD and XMR/USD from Coingecko and prints',
				'copy-pasteable env-var lines for morphit.config.env.'
			].join('\n')
		);
		process.exit(0);
	}

	const targetUsd = parseTargetUsd(argv);

	console.log('');
	console.log(
		`Targeting $${targetUsd.toFixed(2)} USD per fee. Pulling live prices from coingecko...`
	);

	let prices: { btcUsd: number; xmrUsd: number };
	try {
		prices = await fetchBtcXmrPricesFromCoingecko();
	} catch (err) {
		console.error('');
		console.error('  could not reach coingecko:');
		console.error(`    ${err instanceof Error ? err.message : String(err)}`);
		console.error('');
		console.error('  please check current prices manually at:');
		console.error('    https://www.coingecko.com/en/coins/bitcoin');
		console.error('    https://www.coingecko.com/en/coins/monero');
		console.error('');
		console.error('  then compute:');
		console.error(`    satoshis  = round(${targetUsd} / btc_usd * 1e8)`);
		console.error(`    piconero  = round(${targetUsd} / xmr_usd * 1e12)`);
		console.error('');
		process.exit(1);
	}

	const { btcSatoshis, xmrPiconero } = computeFeeAmounts(targetUsd, prices);

	console.log('');
	console.log(`  BTC/USD: $${prices.btcUsd.toLocaleString()}`);
	console.log(`  XMR/USD: $${prices.xmrUsd.toLocaleString()}`);
	console.log('');
	console.log('  Recommended values for morphit.config.env:');
	console.log('');
	console.log(`    MORPHIT_INDEXER_BTC_FEE_SATOSHIS=${btcSatoshis}`);
	console.log(`    MORPHIT_INDEXER_XMR_FEE_PICONERO=${xmrPiconero}`);
	console.log('');
	console.log('  Update morphit.config.env, then restart the indexer.');
	console.log('');
}

void main();
