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
	isGoodsAsset,
	MULTI_NETWORK_TICKERS,
	NATIVE_COIN_TICKERS,
	COIN_PRIVACY_CLASS,
	PRIVACY_COIN_TICKERS,
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
	assert(ASSET_TICKERS_SET.has(t), `ASSET_TICKERS_SET missing entry '${t}'`);
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
	assert(a.ticker === a.ticker.toUpperCase(), `asset ticker '${a.ticker}' must be uppercase`);
	assert(
		Number.isInteger(a.decimals) && a.decimals >= 0 && a.decimals <= 18,
		`asset '${a.ticker}' has implausible decimals: ${a.decimals}`
	);
	assert(typeof a.canBeTraded === 'boolean', `asset '${a.ticker}' canBeTraded must be boolean`);
	assert(
		typeof a.canPayListingFee === 'boolean',
		`asset '${a.ticker}' canPayListingFee must be boolean`
	);
	assert(
		typeof a.isCoordinationChain === 'boolean',
		`asset '${a.ticker}' isCoordinationChain must be boolean`
	);
	if (isGoodsAsset(a.ticker)) {
		// goods assets (BARTER) are OFF-CHAIN: they settle in crypto
		// but have no network of their own, so supportedNetworks is EMPTY and
		// defaultNetwork is null. Assert that shape rather than non-empty.
		assert(
			Array.isArray(a.supportedNetworks) && a.supportedNetworks.length === 0,
			`goods asset '${a.ticker}' supportedNetworks must be EMPTY (off-chain)`
		);
		assert(
			a.defaultNetwork === null,
			`goods asset '${a.ticker}' defaultNetwork must be null (off-chain)`
		);
	} else {
		assert(
			Array.isArray(a.supportedNetworks) && a.supportedNetworks.length > 0,
			`asset '${a.ticker}' supportedNetworks must be a non-empty array`
		);
		for (const net of a.supportedNetworks) {
			assert(
				typeof net === 'string' && net.length > 0,
				`asset '${a.ticker}' supportedNetworks contains a non-string or empty value`
			);
		}
		assert(
			a.defaultNetwork === null || a.supportedNetworks.includes(a.defaultNetwork),
			`asset '${a.ticker}' defaultNetwork '${a.defaultNetwork}' is not in supportedNetworks ${JSON.stringify(a.supportedNetworks)}`
		);
	}
	assert(
		a.privacyWarningKey === null ||
			(typeof a.privacyWarningKey === 'string' && a.privacyWarningKey.length > 0),
		`asset '${a.ticker}' privacyWarningKey must be null or non-empty string`
	);
	// The frozen fee_method invariant: only BLURT/BTC/XMR may have canPayListingFee=true.
	// The fee-method enum in apps/indexer/src/indexer/handlers/order.ts is frozen
	// at 'blurt' | 'waived_first_buy' | 'btc' | 'xmr'; any asset with
	// canPayListingFee=true must map to one of those tickers.
	if (a.canPayListingFee) {
		assert(
			a.ticker === 'BLURT' || a.ticker === 'BTC' || a.ticker === 'XMR',
			`asset '${a.ticker}' has canPayListingFee=true but only BLURT/BTC/XMR may pay listing fees (trade-only rule, fee_method enum is frozen)`
		);
	}
	assert(a.addressShape instanceof RegExp, `asset '${a.ticker}' addressShape must be a RegExp`);
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
	assert(!seenTickers.has(a.ticker), `duplicate ticker '${a.ticker}' in ASSETS`);
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
	assert(a.canPayListingFee, `feePayable() returned non-fee-payable '${a.ticker}'`);
}
for (const a of externalAssets()) {
	assert(!a.isCoordinationChain, `externalAssets() returned coordination chain '${a.ticker}'`);
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
		assert(a.addressShape.test(valid), `'${a.ticker}' addressShape rejects known-valid '${valid}'`);
	}
	for (const bad of INVALID_ADDRESSES) {
		assert(!a.addressShape.test(bad), `'${a.ticker}' addressShape accepts obviously-bad '${bad}'`);
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
		// read through the same cast the write used. Reading `first.ticker`
		// directly let TS narrow to the AssetTicker union and call the comparison
		// impossible; the runtime check is exactly what this scenario is for.
		mutated = (first as { ticker: string }).ticker === 'HACKED';
	} catch {
		// Frozen object throws on assignment in strict mode — good.
	}
	assert(!mutated, `ASSETS[0] entry was mutable: ticker became '${first.ticker}'`);
}
{
	let mutated = false;
	// Capture the original length BEFORE attempting mutation;
	// hardcoded counts (the prior literal `4` was from a 4-asset
	// era; later literals 7, 8, 9 and
	// 10) drift every asset addition.  Dynamic capture — never hardcode an asset count in a smoke.
	const originalLength = ASSETS.length;
	try {
		(ASSETS as AssetEntry[]).push({
			ticker: 'HACK' as AssetTicker,
			decimals: 0,
			isCoordinationChain: false,
			canBeTraded: false,
			canPayListingFee: false,
			supportedNetworks: ['mainnet'],
			defaultNetwork: null,
			privacyWarningKey: null,
			// REQUIRED by AssetEntry since an earlier release and missing here.
			privacyFeatures: {
				freshAddressAdvice: 'hd-derived',
				optInPrivacyTech: null,
				privacyGuideKey: 'privacy.guides.hack'
			},
			addressShape: /./
		});
		mutated = ASSETS.length !== originalLength;
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

// BLURT's address shape is the account-name rule (dotted names are valid
// accounts; the shape used to refuse them).
{
	const shape = getAsset('BLURT').addressShape;
	for (const ok of ['alice', 'alice.brave', 'a-b.c-d', 'trader42']) {
		assert(shape.test(ok), `BLURT addressShape refuses the valid account ${ok}`);
	}
	for (const bad of ['Alice', '1alice', 'al', 'alice-', 'alice.', 'a'.repeat(17)]) {
		assert(!shape.test(bad), `BLURT addressShape accepts the invalid account ${bad}`);
	}
}

// ── MULTI_NETWORK_TICKERS / NATIVE_COIN_TICKERS follow the entries ─
// NativeCoinTicker (one chain, one explorer, one chat-link setting) is derived
// from MULTI_NETWORK_TICKERS; the list must be exactly the entries with more
// than one network, or a new multi-network token would be asked for a single
// explorer, or a new coin left without one.
{
	const multi = ASSETS.filter((a) => a.supportedNetworks.length > 1).map((a) => a.ticker);
	assert(
		[...multi].sort().join() === [...MULTI_NETWORK_TICKERS].sort().join(),
		`MULTI_NETWORK_TICKERS (${MULTI_NETWORK_TICKERS.join(', ')}) must be the entries with more than one network (${multi.join(', ')})`
	);
	const native = ASSETS.filter(
		(a) => !a.isCoordinationChain && !isGoodsAsset(a.ticker) && a.supportedNetworks.length === 1
	).map((a) => a.ticker);
	assert(
		native.join() === NATIVE_COIN_TICKERS.join(),
		`NATIVE_COIN_TICKERS (${NATIVE_COIN_TICKERS.join(', ')}) must be every single-network coin but BLURT, in registry order (${native.join(', ')})`
	);
}

// ── COIN_PRIVACY_CLASS agrees with each coin's privacy tech ──────
// The class decides which pages call a coin a privacy coin; the entry's
// optInPrivacyTech says what the chain offers. A class that contradicts it
// (a coin with no mixing or shielding called a privacy coin, or the reverse)
// would put the coin in the wrong lists.
{
	assert(
		Object.keys(COIN_PRIVACY_CLASS).sort().join() === [...NATIVE_COIN_TICKERS].sort().join(),
		`COIN_PRIVACY_CLASS must classify exactly the native coins (${NATIVE_COIN_TICKERS.join(', ')})`
	);
	const CHAIN_LEVEL: Record<string, readonly string[]> = {
		'private-by-default': ['shielded-pools'],
		'opt-in-shielded': ['shielded-pools'],
		'opt-in-mixing': ['privatesend', 'csppmix']
	};
	for (const t of NATIVE_COIN_TICKERS) {
		const tech = ASSETS.find((a) => a.ticker === t)!.privacyFeatures.optInPrivacyTech ?? [];
		const cls = COIN_PRIVACY_CLASS[t];
		const chainLevel = tech.filter((x) => ['shielded-pools', 'privatesend', 'csppmix'].includes(x));
		if (cls === 'transparent') {
			assert(
				chainLevel.length === 0,
				`${t} is classed transparent but its chain offers ${chainLevel.join(', ')}`
			);
		} else if (cls === 'private-by-default') {
			assert(
				tech.length === 0 || tech.every((x) => CHAIN_LEVEL[cls]!.includes(x)),
				`${t} is classed private-by-default; its optInPrivacyTech must be null or shielded-pools`
			);
		} else {
			assert(
				chainLevel.length > 0 && chainLevel.every((x) => CHAIN_LEVEL[cls]!.includes(x)),
				`${t} is classed ${cls}; its optInPrivacyTech must include ${CHAIN_LEVEL[cls]!.join(' or ')}`
			);
		}
	}
	assert(
		PRIVACY_COIN_TICKERS.join() ===
			NATIVE_COIN_TICKERS.filter((t) => COIN_PRIVACY_CLASS[t] !== 'transparent').join(),
		'PRIVACY_COIN_TICKERS must be every native coin not classed transparent, in display order'
	);
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
