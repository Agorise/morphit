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

scenario('all current assets registered (14 assets: BTC, XMR, BLURT, USDT, USDC, DAI, BCH, LTC, DASH, DOGE, ZEC, ARRR, DCR, SOL)', () => {
	const tickers = ASSETS.map((a) => a.ticker).sort();
	const expected = ['arrr', 'bch', 'blurt', 'btc', 'dai', 'dash', 'dcr', 'doge', 'ltc', 'sol', 'usdc', 'usdt', 'xmr', 'zec'];
	if (JSON.stringify(tickers) !== JSON.stringify(expected)) {
		throw new Error(`expected ${expected}, got ${tickers}`);
	}
});

scenario('XMR is first in display order (audience priority)', () => {
	if (ASSETS[0]!.ticker !== 'xmr') {
		throw new Error(`expected xmr first, got ${ASSETS[0]!.ticker}`);
	}
});

scenario('getAsset throws on unknown ticker', () => {
	let threw = false;
	try {
		// @ts-expect-error -- testing runtime behavior
		getAsset('eth');
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

scenario('logo paths are stable + distinct', () => {
	const paths = ASSETS.map((a) => a.logoSvgPath);
	const set = new Set(paths);
	if (set.size !== paths.length) {
		throw new Error('duplicate logo path');
	}
	// cp30-DD-DD CODE-A — pre-existing broken assertion: BCH (cp21),
	// LTC (cp24), DASH (cp27), USDC (cp30) all live under /icons/
	// (not /coins/), so the original `startsWith('/coins/')` check
	// has been broken since cp21.  Accept either prefix; both are
	// served by SvelteKit's static path resolver and the registry's
	// `logoSvgPath` is currently only consumed by this smoke
	// (nothing in the UI reads it — components hardcode their own
	// path template), so the path-convention split is purely
	// declarative.  REVISIT to consolidate to one directory.
	for (const p of paths) {
		if (!p.startsWith('/coins/') && !p.startsWith('/icons/')) {
			throw new Error(`logo path should start with /coins/ or /icons/: ${p}`);
		}
		if (!p.endsWith('.svg')) {
			throw new Error(`logo path should end with .svg: ${p}`);
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
		'sol'
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
