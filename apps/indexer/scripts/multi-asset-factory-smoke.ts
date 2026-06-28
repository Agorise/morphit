#!/usr/bin/env tsx
/**
 * Structural smoke for cp130 multi-asset price-source factory.
 *
 * What this verifies (without spinning up Postgres or Coingecko —
 * those are integration concerns):
 *
 *   1. Module exports the public surface we expect:
 *      createAssetPriceSource, createPriceSource (backwards-compat
 *      wrapper), createMultiAssetPriceSources, CP130_ASSET_DEFAULTS.
 *   2. CP130_ASSET_DEFAULTS covers BLURT + BTC + XMR with the
 *      correct shape (asset/coingeckoCoinId/staticFloor).
 *   3. The external chain is Coingecko-only (Klingex, the prior
 *      BLURT primary, went out of business in 2026 and was removed).
 *   4. Coingecko coin IDs match the well-known Coingecko ids.
 *   5. createMultiAssetPriceSources returns a Map keyed by asset
 *      ticker with exactly the cp130 launch set (BLURT, BTC, XMR).
 *   6. Each source is a separate BlurtPriceSource instance (no
 *      shared cache, no aliasing).
 *   7. Per-asset static-floor wiring: BLURT reads
 *      priceFeedStaticFloor; BTC reads priceFeedBtcStaticFloor;
 *      XMR reads priceFeedXmrStaticFloor.
 *   8. Backwards-compatibility: createPriceSource returns a
 *      BLURT-shaped source (same upstream chain as pre-cp130 except
 *      morphit_native is denomination-aware).
 */

import {
	createAssetPriceSource,
	createPriceSource,
	createMultiAssetPriceSources,
	CP130_ASSET_DEFAULTS
} from '../src/indexer/price/factory';
import { fakeConfig } from '../test/testutils/context';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const FACTORY_PATH = join(__dirname, '..', 'src', 'indexer', 'price', 'factory.ts');

let pass = 0;
let fail = 0;

function scenario(name: string, fn: () => void): void {
	try {
		fn();
		console.log(`  ✓ ${name}`);
		pass++;
	} catch (err) {
		console.log(`  ✗ ${name}: ${err}`);
		fail++;
	}
}

function assertEq<T>(actual: T, expected: T, label: string): void {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${String(expected)}, got ${String(actual)}`);
	}
}

console.log('\n── cp130 multi-asset factory smoke ──\n');

// ─── CP130-1: public surface ──
scenario('CP130-1: createAssetPriceSource is a function', () => {
	if (typeof createAssetPriceSource !== 'function') throw new Error('not a function');
});

scenario('CP130-1: createPriceSource is a function (backwards-compat wrapper)', () => {
	if (typeof createPriceSource !== 'function') throw new Error('not a function');
});

scenario('CP130-1: createMultiAssetPriceSources is a function', () => {
	if (typeof createMultiAssetPriceSources !== 'function') throw new Error('not a function');
});

scenario('CP130-1: CP130_ASSET_DEFAULTS is an object', () => {
	if (typeof CP130_ASSET_DEFAULTS !== 'object') throw new Error('not an object');
});

// ─── CP130-2: defaults shape + cp130 launch set ──
scenario('CP130-2: CP130_ASSET_DEFAULTS covers BLURT + BTC + XMR (the cp130 launch set)', () => {
	const keys = Object.keys(CP130_ASSET_DEFAULTS).sort();
	const expected = ['BLURT', 'BTC', 'XMR'].sort();
	assertEq(JSON.stringify(keys), JSON.stringify(expected), 'launch-set keys');
});

scenario('CP130-2: each default entry has the expected shape', () => {
	for (const [key, opts] of Object.entries(CP130_ASSET_DEFAULTS)) {
		if (typeof opts.asset !== 'string') throw new Error(`${key}.asset not string`);
		if (typeof opts.coingeckoCoinId !== 'string')
			throw new Error(`${key}.coingeckoCoinId not string`);
		if (typeof opts.staticFloor !== 'number')
			throw new Error(`${key}.staticFloor not number`);
		if (opts.staticFloor <= 0) throw new Error(`${key}.staticFloor not positive`);
		if (opts.asset !== key) throw new Error(`${key}.asset != key`);
	}
});

// ─── CP130-3: external chain is Coingecko-only (Klingex removed 2026) ──
scenario('CP130-3: no asset default carries the removed enableKlingex field', () => {
	for (const [key, opts] of Object.entries(CP130_ASSET_DEFAULTS)) {
		if ('enableKlingex' in opts)
			throw new Error(`${key} still carries enableKlingex (Klingex was removed)`);
	}
});

scenario('CP130-3: factory source no longer imports a Klingex fetcher', () => {
	const src = readFileSync(FACTORY_PATH, 'utf-8');
	if (/createKlingexFetcher|klingexFetcher/.test(src))
		throw new Error('factory.ts still references the deleted Klingex fetcher');
});

// ─── CP130-4: Coingecko coin IDs ──
scenario('CP130-4: BLURT coingeckoCoinId is "blurt"', () => {
	assertEq(CP130_ASSET_DEFAULTS.BLURT!.coingeckoCoinId, 'blurt', 'BLURT CG id');
});

scenario('CP130-4: BTC coingeckoCoinId is "bitcoin" (well-known CG id)', () => {
	assertEq(CP130_ASSET_DEFAULTS.BTC!.coingeckoCoinId, 'bitcoin', 'BTC CG id');
});

scenario('CP130-4: XMR coingeckoCoinId is "monero" (well-known CG id)', () => {
	assertEq(CP130_ASSET_DEFAULTS.XMR!.coingeckoCoinId, 'monero', 'XMR CG id');
});

// ─── CP130-5: createMultiAssetPriceSources behavior ──
scenario('CP130-5: createMultiAssetPriceSources returns a Map with BLURT, BTC, XMR keys', () => {
	const cfg = fakeConfig({ priceFeedEnabled: true });
	const sources = createMultiAssetPriceSources(cfg, undefined);
	const keys = [...sources.keys()].sort();
	assertEq(JSON.stringify(keys), JSON.stringify(['BLURT', 'BTC', 'XMR']), 'map keys');
});

scenario('CP130-5: each entry in the map is a distinct BlurtPriceSource instance', () => {
	const cfg = fakeConfig({ priceFeedEnabled: true });
	const sources = createMultiAssetPriceSources(cfg, undefined);
	const blurtSource = sources.get('BLURT');
	const btcSource = sources.get('BTC');
	const xmrSource = sources.get('XMR');
	if (!blurtSource || !btcSource || !xmrSource)
		throw new Error('missing source');
	if (blurtSource === btcSource) throw new Error('BLURT and BTC aliased');
	if (blurtSource === xmrSource) throw new Error('BLURT and XMR aliased');
	if (btcSource === xmrSource) throw new Error('BTC and XMR aliased');
});

// ─── CP130-6: backwards-compatibility wrapper ──
scenario('CP130-6: createPriceSource returns a usable BlurtPriceSource', () => {
	const cfg = fakeConfig({ priceFeedEnabled: true });
	const source = createPriceSource(cfg, undefined);
	if (typeof source.currentDetailed !== 'function')
		throw new Error('source.currentDetailed missing');
	if (typeof source.start !== 'function') throw new Error('source.start missing');
	if (typeof source.stop !== 'function') throw new Error('source.stop missing');
});

// ─── CP130-7: per-asset static-floor wiring ──
scenario('CP130-7: BTC source uses priceFeedBtcStaticFloor config (smoke: source builds without throw)', () => {
	const cfg = fakeConfig({
		priceFeedEnabled: true,
		priceFeedBtcStaticFloor: 55_000
	});
	const sources = createMultiAssetPriceSources(cfg, undefined);
	if (!sources.has('BTC')) throw new Error('BTC missing');
});

scenario('CP130-7: XMR source uses priceFeedXmrStaticFloor config (smoke: source builds without throw)', () => {
	const cfg = fakeConfig({
		priceFeedEnabled: true,
		priceFeedXmrStaticFloor: 180
	});
	const sources = createMultiAssetPriceSources(cfg, undefined);
	if (!sources.has('XMR')) throw new Error('XMR missing');
});

// ─── CP130-8: empty / disabled paths ──
scenario('CP130-8: createAssetPriceSource works with empty db (no morphit_native)', () => {
	const cfg = fakeConfig({ priceFeedEnabled: true, priceFeedNativeEnabled: false });
	const source = createAssetPriceSource(cfg, CP130_ASSET_DEFAULTS.BTC!, undefined);
	if (typeof source.currentDetailed !== 'function') throw new Error('source malformed');
});

// ─── CP130-9: denomination flows through to all assets ──
scenario('CP130-9: EUR denomination flows through to all per-asset sources (smoke: build with EUR)', () => {
	const cfg = fakeConfig({
		priceFeedEnabled: true,
		priceFeedDenominationFiat: 'EUR'
	});
	const sources = createMultiAssetPriceSources(cfg, undefined);
	// All three should build; the EUR denomination is wired through
	// to each source's coingeckoFetcher's vsCurrency parameter.
	assertEq(sources.size, 3, 'three sources');
});

// ─── CP130-10: doc-comment design pillars ──
scenario('CP130-10: factory.ts source still documents the cp130 architecture decisions', () => {
	const src = readFileSync(FACTORY_PATH, 'utf-8');
	const markers = [
		'cp130',
		'went out of business', // the Klingex-removal historical note
		'preemptive complexity', // why per-asset denomination wasn't added
		'multi-asset',
		'BLURT/USD',
		'BTC/USD',
		'XMR/USD'
	];
	for (const m of markers) {
		if (!src.includes(m)) {
			throw new Error(`missing marker: ${m}`);
		}
	}
});

// Settle + report
console.log('\n' + '─'.repeat(56));
if (fail === 0) {
	console.log(`✓ all ${pass} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${fail} of ${pass + fail} scenarios FAILED`);
	process.exit(1);
}
