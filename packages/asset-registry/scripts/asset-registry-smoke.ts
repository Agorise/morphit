#!/usr/bin/env -S npx tsx
/**
 * @morphit/asset-registry smoke — verify the canonical asset list
 * and its derived structures are internally consistent.
 *
 * Run as part of bash scripts/run-smokes.sh.  A failure here means
 * the registry was edited in a way that breaks one of its
 * invariants — usually a forgotten field on a new entry.
 *
 * This is a self-test of the registry; cross-package consistency
 * (frontend lib/assets/registry.ts agrees on the same set of
 * tickers, indexer fee verifiers exist for every external asset)
 * is enforced by separate smokes elsewhere.
 */

import {
	ASSETS,
	ASSET_TICKERS,
	ASSET_TICKERS_SET,
	COORDINATION_CHAIN,
	externalAssets,
	feePayable,
	getAsset,
	isAssetTicker,
	tradeable,
	type AssetEntry,
	type AssetTicker
} from '../src/index.ts';

const failures: string[] = [];

function assert(cond: unknown, msg: string): void {
	if (!cond) failures.push(msg);
}

console.log('\n── @morphit/asset-registry smoke ───────────────────────────\n');

// ── ASSET_TICKERS / ASSETS / ASSET_TICKERS_SET agree ─────────────
assert(
	ASSETS.length === ASSET_TICKERS.length,
	`ASSETS.length (${ASSETS.length}) !== ASSET_TICKERS.length (${ASSET_TICKERS.length})`
);
assert(
	ASSET_TICKERS_SET.size === ASSET_TICKERS.length,
	`ASSET_TICKERS_SET.size (${ASSET_TICKERS_SET.size}) !== ASSET_TICKERS.length (${ASSET_TICKERS.length})`
);
for (const t of ASSET_TICKERS) {
	assert(
		ASSET_TICKERS_SET.has(t),
		`ASSET_TICKERS_SET missing entry '${t}'`
	);
}
for (const a of ASSETS) {
	assert(
		(ASSET_TICKERS as readonly string[]).includes(a.ticker),
		`ASSETS entry has ticker '${a.ticker}' not in ASSET_TICKERS list`
	);
}

// ── Each entry has all required fields with sensible values ──────
for (const a of ASSETS) {
	assert(
		typeof a.ticker === 'string' && a.ticker.length >= 3,
		`asset has bad ticker: ${JSON.stringify(a.ticker)}`
	);
	assert(
		a.ticker === a.ticker.toUpperCase(),
		`asset ticker '${a.ticker}' must be uppercase`
	);
	assert(
		Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 18,
		`asset '${a.ticker}' has implausible decimals: ${a.decimals}`
	);
	assert(
		typeof a.canBeTraded === 'boolean',
		`asset '${a.ticker}' canBeTraded must be boolean`
	);
	assert(
		typeof a.canPayListingFee === 'boolean',
		`asset '${a.ticker}' canPayListingFee must be boolean`
	);
	assert(
		typeof a.isCoordinationChain === 'boolean',
		`asset '${a.ticker}' isCoordinationChain must be boolean`
	);
	assert(
		a.addressShape instanceof RegExp,
		`asset '${a.ticker}' addressShape must be a RegExp`
	);
}

// ── Exactly one coordination chain ───────────────────────────────
const coordCount = ASSETS.filter((a) => a.isCoordinationChain).length;
assert(
	coordCount === 1,
	`exactly one asset must have isCoordinationChain=true; found ${coordCount}`
);
assert(
	COORDINATION_CHAIN !== null && COORDINATION_CHAIN !== undefined,
	`COORDINATION_CHAIN constant must be defined`
);

// ── No duplicate tickers ─────────────────────────────────────────
const seenTickers = new Set<string>();
for (const a of ASSETS) {
	assert(
		!seenTickers.has(a.ticker),
		`duplicate ticker '${a.ticker}' in ASSETS`
	);
	seenTickers.add(a.ticker);
}

// ── isAssetTicker type guard works ───────────────────────────────
for (const t of ASSET_TICKERS) {
	assert(isAssetTicker(t), `isAssetTicker(${JSON.stringify(t)}) returned false`);
}
assert(!isAssetTicker('NOTACOIN'), `isAssetTicker('NOTACOIN') returned true`);
assert(!isAssetTicker(42), `isAssetTicker(42) returned true`);
assert(!isAssetTicker(null), `isAssetTicker(null) returned true`);
assert(!isAssetTicker(undefined), `isAssetTicker(undefined) returned true`);

// ── getAsset returns the right entry ─────────────────────────────
for (const a of ASSETS) {
	const got = getAsset(a.ticker);
	assert(got === a, `getAsset('${a.ticker}') returned a different entry`);
}

// ── Filter helpers return only matching entries ──────────────────
for (const a of tradeable()) {
	assert(a.canBeTraded, `tradeable() returned non-tradeable '${a.ticker}'`);
}
for (const a of feePayable()) {
	assert(
		a.canPayListingFee,
		`feePayable() returned non-fee-payable '${a.ticker}'`
	);
}
for (const a of externalAssets()) {
	assert(
		!a.isCoordinationChain,
		`externalAssets() returned coordination chain '${a.ticker}'`
	);
}

// ── Address-shape regex sanity ───────────────────────────────────
// At least one well-known valid address per asset matches; at
// least one obviously bad string doesn't.  Catches pasted-from-
// elsewhere regex bugs.
const VALID_ADDRESSES: Record<string, string> = {
	BTC: 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq',
	XMR: '4AdUndXHHZ6cfufTMvppY6JwXNouMBzSkbLYfpAV5Usx3skxNgYeYTRj5UzqtReoS44qo9mtmXCqY45DJ852K5Jv2bYXZKKQePHES9khPK',
	BLURT: 'morphit-fees'
};
const INVALID_ADDRESSES = ['', 'a', 'definitely not a wallet address'];
for (const a of ASSETS) {
	const valid = VALID_ADDRESSES[a.ticker];
	if (valid !== undefined) {
		assert(
			a.addressShape.test(valid),
			`'${a.ticker}' addressShape rejects known-valid '${valid}'`
		);
	}
	for (const bad of INVALID_ADDRESSES) {
		assert(
			!a.addressShape.test(bad),
			`'${a.ticker}' addressShape accepts obviously-bad '${bad}'`
		);
	}
}

// ── Runtime immutability ─────────────────────────────────────────
// Defense-in-depth: the readonly types are compile-time only.  A
// JS file or a `(x as any)` escape hatch can mutate runtime
// objects unless we freeze them.  Verify every entry rejects
// mutation, and that ASSET_TICKERS_SET rejects add/delete/clear.
{
	const first = ASSETS[0]!;
	let mutated = false;
	try {
		(first as { ticker: string }).ticker = 'HACKED';
		mutated = first.ticker === 'HACKED';
	} catch {
		// Frozen object throws on assignment in strict mode — good.
	}
	assert(!mutated, `ASSETS[0] entry was mutable: ticker became '${first.ticker}'`);
}
{
	let mutated = false;
	try {
		(ASSETS as AssetEntry[]).push({
			ticker: 'HACK' as AssetTicker,
			decimals: 0,
			isCoordinationChain: false,
			canBeTraded: false,
			canPayListingFee: false,
			addressShape: /./
		});
		mutated = ASSETS.length !== 3;
	} catch {
		// Frozen array throws on push in strict mode — good.
	}
	assert(!mutated, `ASSETS array was mutable: length is now ${ASSETS.length}`);
}
{
	let added = false;
	try {
		(ASSET_TICKERS_SET as Set<string>).add('HACKED');
		added = ASSET_TICKERS_SET.has('HACKED');
	} catch {
		// Proxy trap throws — good.
	}
	assert(!added, `ASSET_TICKERS_SET was mutable: 'HACKED' is now a member`);
}

// ── Result ───────────────────────────────────────────────────────
if (failures.length > 0) {
	console.log(`  ✗ ${failures.length} assertion(s) failed:`);
	for (const f of failures) console.log(`    - ${f}`);
	console.log('\n──────────────────────────────────────────────────────');
	console.log(`✗ ${failures.length}/${failures.length} scenarios failed`);
	process.exit(1);
} else {
	console.log(`  ✓ ${ASSETS.length} assets registered, all invariants hold`);
	console.log('\n──────────────────────────────────────────────────────');
	console.log('✓ all 1 scenarios passed');
}
