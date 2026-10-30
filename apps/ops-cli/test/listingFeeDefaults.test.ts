/**
 * What `morphit-ops edit` shows (and keeps on Enter) for a listing-fee setting
 * no settings file sets is the indexer's OWN default — tied here to the
 * indexer's real loadConfig(), run in a child as the service would, with none
 * of those settings given. (edit used to offer, and write, its own fallback
 * price 0.002 while the indexer runs with 0.001.)
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { INDEXER_LISTING_FEE_DEFAULTS } from '../src/init/steps.ts';

const REPO = join(import.meta.dirname, '..', '..', '..');

/** The indexer's resolved listing-fee settings with none of them set. */
function indexerDefaults(): Record<string, unknown> {
	const dir = mkdtempSync(join(tmpdir(), 'indexer-fee-defaults-'));
	try {
		const script = join(dir, 'probe.mts');
		writeFileSync(
			script,
			`const m = await import(${JSON.stringify(join(REPO, 'apps/indexer/src/config/index.ts'))});\n` +
				'const c = m.loadConfig();\n' +
				'process.stdout.write(JSON.stringify({ btc: c.btcFeeSatoshis, xmr: String(c.xmrFeePiconero), floor: c.priceFeedStaticFloor, fiat: c.priceFeedDenominationFiat }));\n'
		);
		const r = spawnSync(join(REPO, 'node_modules/.bin/tsx'), [script], {
			cwd: join(REPO, 'apps/indexer'),
			encoding: 'utf8',
			// Only what the indexer cannot start without; no listing-fee setting.
			env: {
				PATH: process.env.PATH,
				MORPHIT_INDEXER_DATABASE_URL: 'postgresql://u:not-a-placeholder@127.0.0.1:5432/db',
				MORPHIT_INDEXER_CHAIN_ID:
					'cd8d90f29ae273abec3eaa7731e25934c63eb654d55080caff2ebb7f5df6381f',
				MORPHIT_INDEXER_PUBLIC_ORIGIN: 'https://example.org',
				MORPHIT_INDEXER_OFFICIAL_POSTING_PUBKEY:
					'BLT6LLegbAgLAy28EHrffBVuANFWcFgmqRMW13wBmTExqFE9SCkg4'
			},
			timeout: 60_000
		});
		expect(r.status, r.stderr).toBe(0);
		return JSON.parse(r.stdout) as Record<string, unknown>;
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("edit's 'not set' listing-fee values are the indexer's own defaults", () => {
	it('BTC, XMR, fallback price and display unit', () => {
		expect(indexerDefaults()).toEqual({
			btc: INDEXER_LISTING_FEE_DEFAULTS.btcSatoshis,
			xmr: String(INDEXER_LISTING_FEE_DEFAULTS.xmrPiconero),
			floor: INDEXER_LISTING_FEE_DEFAULTS.fallbackBlurtPriceUsd,
			fiat: INDEXER_LISTING_FEE_DEFAULTS.denominationFiat
		});
	}, 120_000);
});
