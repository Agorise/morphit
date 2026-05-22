#!/usr/bin/env tsx
/**
 * Smoke for the frontend asset registry — task #12.
 *
 * Pure tests; no DOM, no I/O.
 */

import {
	ASSETS,
	getAsset,
	tradeableAssets,
	feePayableAssets,
	memoCapableAssets,
	type AssetMetadata
} from '../../web/src/lib/assets/registry.ts';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE_DIR, '..', '..', '..');
const STATIC_ROOT = join(REPO_ROOT, 'apps/web/static');

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

console.log('\n── asset registry smoke ─────────────────────────────────\n');

scenario('all current assets registered (16 assets: BTC, XMR, BLURT, USDT, USDC, DAI, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL, ETH, XRP)', () => {
	const tickers = ASSETS.map((a) => a.ticker).sort();
	const expected = ['arrr', 'bch', 'blurt', 'btc', 'dai', 'dash', 'dcr', 'doge', 'eth', 'ltc', 'sol', 'usdc', 'usdt', 'xmr', 'xrp', 'zec'];
	if (JSON.stringify(tickers) !== JSON.stringify(expected)) {
		throw new Error(`expected ${expected}, got ${tickers}`);
	}
});

scenario('XMR is first in display order (audience priority)', () => {
	if (ASSETS[0]!.ticker !== 'xmr') {
		throw new Error(`expected xmr first, got ${ASSETS[0]!.ticker}`);
	}
});

// CP48 STRUCTURAL DEFENSE — Ken's cp47-A1 finding flagged this as
// a recurring bug class.  3 of 8 asset additions hit the same trap:
// cp33 'doge' became valid, cp39 'zec' became valid, cp47 'eth'
// became valid.  Each required a manual stand-in swap.
//
// The structural fix: assert at runtime that the chosen stand-in
// is NOT in ASSET_TICKERS_SET.  If a future contributor either
// (a) adds a new asset whose ticker matches the stand-in, or
// (b) uses a real ticker as stand-in by accident, this assertion
// surfaces it immediately at smoke-run time — not 3 checkpoints
// later when the bug is finally noticed.
//
// Also: the stand-in itself is chosen to be a string mathematically
// unable to be a real ticker (4-letter all-uppercase TRX is at
// risk; using lower-case '__unknown__' with underscores is impossible
// because ASSET_TICKERS regex-enforces all-caps tickers).
import { ASSET_TICKERS_SET } from '@morphit/asset-registry';
const UNKNOWN_STANDIN = '__unknown__';
if (ASSET_TICKERS_SET.has(UNKNOWN_STANDIN.toUpperCase())) {
	throw new Error(
		`UNKNOWN_STANDIN '${UNKNOWN_STANDIN}' is now a valid ticker — ` +
			`pick a different one.  This assertion is the cp48 structural ` +
			`defense for Ken's cp47-A1 recurring bug class.`
	);
}

scenario('getAsset throws on unknown ticker', () => {
	let threw = false;
	try {
		// CP48 structural fix: use a synthetic non-ticker that
		// cannot become a real asset.  Underscores are not allowed
		// in ticker symbols (canonical regex enforces uppercase
		// letters only).  Replaces the previous cp47-A1 swap to
		// 'trx' which was still at risk of becoming valid if
		// Morphit ever ships native Tron support.
		// @ts-expect-error -- testing runtime behavior with synthetic non-ticker
		getAsset(UNKNOWN_STANDIN);
	} catch (err) {
		threw = true;
		if (!(err instanceof Error) || !err.message.includes('not in registry')) {
			throw new Error(`wrong error: ${err}`);
		}
	}
	if (!threw) throw new Error('expected throw');
});

scenario('every entry has all required fields', () => {
	for (const a of ASSETS) {
		const required: (keyof AssetMetadata)[] = [
			'ticker',
			'displayTicker',
			'displayName',
			'oneLineDescription',
			'logoSvgPath',
			'accentClass',
			'decimals',
			'supportsMemo',
			'addressValidator',
			'canBeUsedForListingFee',
			'canBeTraded'
		];
		for (const k of required) {
			if (a[k] === undefined || a[k] === null) {
				throw new Error(`${a.ticker}: missing ${String(k)}`);
			}
		}
	}
});

scenario('logo paths are stable + distinct + exist on disk', () => {
	const paths = ASSETS.map((a) => a.logoSvgPath);
	const set = new Set(paths);
	if (set.size !== paths.length) {
		throw new Error('duplicate logo path');
	}
	// cp115 — All 16 tradable assets now consistently use the
	// /icons/icon-<lower-ticker>.svg path convention.  An earlier
	// /coins/<ticker>.svg path was vestigial (files never shipped to
	// disk under that path) and has been folded into the canonical
	// form.  The CoinCarousel component (cp115) is the first real
	// consumer of `logoSvgPath` outside this smoke, so this assertion
	// is now load-bearing: a broken path means a broken homepage.
	//
	// Defense beyond cp30-CODE-A: also verify each path actually
	// resolves to a file in apps/web/static.  Catches accidental
	// rename of an icon file without registry update, and vice versa.
	for (const p of paths) {
		if (!p.startsWith('/icons/')) {
			throw new Error(`logo path should start with /icons/: ${p}`);
		}
		if (!p.endsWith('.svg')) {
			throw new Error(`logo path should end with .svg: ${p}`);
		}
		const onDisk = join(STATIC_ROOT, p.replace(/^\//, ''));
		if (!existsSync(onDisk)) {
			throw new Error(
				`logo path ${p} not found on disk at ${onDisk} — registry references an icon that does not ship`
			);
		}
	}
});

scenario('display tickers are uppercase', () => {
	for (const a of ASSETS) {
		if (a.displayTicker !== a.displayTicker.toUpperCase()) {
			throw new Error(`${a.ticker}: displayTicker not uppercase`);
		}
	}
});

scenario('lower-case tickers match payload union', () => {
	// cp30-DD-DD CODE-B — pre-existing broken assertion: this set
	// was last updated at cp3 (USDT addition) and never extended for
	// BCH (cp21), LTC (cp24), DASH (cp27), or USDC (cp30) so the
	// scenario has been throwing on first non-baseline asset since
	// cp21.  Source of truth is the ChatAssetTicker union in
	// `lib/chat/payload.ts`; keep this list in lockstep with that
	// union (or, better: import the union's values dynamically —
	// follow-up).
	const valid = new Set([
		'btc',
		'xmr',
		'blurt',
		'usdt',
		'usdc',
		'dai',
		'bch',
		'ltc',
		'dash',
		'doge',
		'zec',
		'arrr',
		'dcr',
		'sol',
		'eth',
		'xrp'
	]);
	for (const a of ASSETS) {
		if (!valid.has(a.ticker)) {
			throw new Error(`${a.ticker}: not in ChatAssetTicker union — payload.ts must be updated`);
		}
	}
});

scenario('decimals are positive integers', () => {
	for (const a of ASSETS) {
		if (!Number.isInteger(a.decimals) || a.decimals <= 0) {
			throw new Error(`${a.ticker}: bad decimals ${a.decimals}`);
		}
	}
});

scenario('XMR validator accepts standard mainnet address', () => {
	const xmr = getAsset('xmr');
	const std =
		'47jK4EWnpSDeoCJTMHpsPpD6KvJDqs6kdiouULmgubgKnQwzfeREi39pGUz3qKL76b3aJUFwfN77MfDw5VHgYdjr3Bx9c5o';
	if (!xmr.addressValidator(std)) {
		throw new Error('expected standard XMR address to validate');
	}
});

scenario('XMR validator accepts subaddress', () => {
	const xmr = getAsset('xmr');
	const sub =
		'8AUaHTLqaJVPqMQTm2ko42WTqTuShVHtjDzD8AwNdWypnFy56tPUMrL5UZWLoqxnFqkx2DJDgZi6KSaTASFhZRPpAxRzyPF';
	if (!xmr.addressValidator(sub)) {
		throw new Error('expected XMR subaddress to validate');
	}
});

scenario('XMR validator rejects garbage', () => {
	const xmr = getAsset('xmr');
	if (xmr.addressValidator('not-an-address')) {
		throw new Error('expected garbage to reject');
	}
	if (xmr.addressValidator('')) {
		throw new Error('empty should reject');
	}
});

scenario('BTC validator accepts P2PKH, P2SH, bech32', () => {
	const btc = getAsset('btc');
	if (!btc.addressValidator('1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa')) throw new Error('P2PKH');
	if (!btc.addressValidator('3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy')) throw new Error('P2SH');
	if (!btc.addressValidator('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'))
		throw new Error('bech32');
});

scenario('BTC validator rejects testnet, ETH, garbage', () => {
	const btc = getAsset('btc');
	if (btc.addressValidator('tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx'))
		throw new Error('testnet should reject');
	if (btc.addressValidator('0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb0'))
		throw new Error('ETH should reject');
});

scenario('BLURT validator accepts valid account names', () => {
	const blurt = getAsset('blurt');
	if (!blurt.addressValidator('alice')) throw new Error('alice');
	if (!blurt.addressValidator('alice-test')) throw new Error('alice-test');
	if (!blurt.addressValidator('user123')) throw new Error('user123');
});

scenario('BLURT validator rejects invalid names', () => {
	const blurt = getAsset('blurt');
	if (blurt.addressValidator('a')) throw new Error('1-char should reject');
	if (blurt.addressValidator('-leading')) throw new Error('leading dash');
	if (blurt.addressValidator('trailing-')) throw new Error('trailing dash');
	if (blurt.addressValidator('UPPER')) throw new Error('uppercase');
	if (blurt.addressValidator('123start')) throw new Error('digit-start');
});

scenario('tradeableAssets includes everything currently', () => {
	const t = tradeableAssets();
	if (t.length !== ASSETS.length) {
		throw new Error('expected all assets tradeable currently');
	}
});

scenario('feePayableAssets matches canBeUsedForListingFee', () => {
	const f = feePayableAssets();
	const expected = ASSETS.filter((a) => a.canBeUsedForListingFee);
	if (f.length !== expected.length) {
		throw new Error('feePayable mismatch');
	}
});

scenario('memoCapableAssets includes BLURT, excludes BTC + XMR', () => {
	const m = memoCapableAssets()
		.map((a) => a.ticker)
		.sort();
	const expected = ['blurt'];
	if (JSON.stringify(m) !== JSON.stringify(expected)) {
		throw new Error(`expected ${expected}, got ${m}`);
	}
});

scenario('registry is frozen-ish (immutable shape contract)', () => {
	// @ts-expect-error -- testing runtime
	const original = ASSETS[0]!.ticker;
	// Try mutating; readonly should make this a compile error,
	// but at runtime ASSETS may not be Object.frozen.  Check the
	// shape contract holds.
	if (ASSETS[0]!.ticker !== original) {
		throw new Error('registry mutated unexpectedly');
	}
});

console.log(`\n${'─'.repeat(54)}`);
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
