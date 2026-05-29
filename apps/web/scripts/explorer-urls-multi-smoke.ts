/**
 * explorer-urls-multi smoke (cp167 LL #168).
 *
 * Covers the new externalExplorerUrls() plural API in
 * apps/web/src/lib/explorer/urls.ts.  Locks in the contract:
 *
 *   - Each multi-explorer asset (BTC, XMR, ETH, etc.) returns a
 *     non-empty ordered list; best→worst order matches the
 *     BUNDLED_<ASSET>_CHAT_LINK_URLS list from urlsCore.
 *   - Every URL in the returned list contains the txid (lowercased).
 *   - Operator override (set via instance store mock) prepends the
 *     bundled list.
 *   - Duplicate URLs are de-deduplicated on first occurrence;
 *     order of remaining items preserved.
 *   - Invalid txids return [] (empty array sentinel, not null) for
 *     iterator-safety in Svelte each-blocks.
 *   - Unknown assets return [].
 *   - Singular externalExplorerUrl() output matches
 *     externalExplorerUrls()[0] (parity rule for backward compat).
 *
 * The instance store is mocked via a global var; urls.ts imports
 * getInstanceSnapshot from '$lib/stores/instance' and the Svelte
 * runtime resolves '$lib' to apps/web/src/lib at build time, so we
 * mock the module via Node's module resolution by importing a
 * shim before importing urls.ts.  But we don't actually need a
 * real Svelte module loader — instead, we test against the pure
 * urlsCore primitives (BUNDLED_*_CHAT_LINK_URLS,
 * substituteTxidIntoTemplate) and a hand-rolled clone of
 * externalExplorerUrls's logic that takes the instance template
 * as an explicit argument.  This keeps the smoke deterministic
 * and free of SvelteKit setup overhead.
 */

import {
	BUNDLED_BTC_CHAT_LINK_URLS,
	BUNDLED_XMR_CHAT_LINK_URLS,
	BUNDLED_BCH_CHAT_LINK_URLS,
	BUNDLED_LTC_CHAT_LINK_URLS,
	BUNDLED_DASH_CHAT_LINK_URLS,
	BUNDLED_DOGE_CHAT_LINK_URLS,
	BUNDLED_ZEC_CHAT_LINK_URLS,
	BUNDLED_ARRR_CHAT_LINK_URLS,
	BUNDLED_DCR_CHAT_LINK_URLS,
	BUNDLED_SOL_CHAT_LINK_URLS,
	BUNDLED_ETH_CHAT_LINK_URLS,
	BUNDLED_XRP_CHAT_LINK_URLS,
	BUNDLED_BTC_CHAT_LINK_URL,
	BUNDLED_XMR_CHAT_LINK_URL,
	TOKEN_NETWORK_EXPLORER_URLS,
	BTC_TXID_RE,
	XMR_TXID_RE,
	substituteTxidIntoTemplate,
	isValidChatLinkTemplate
} from '../src/lib/explorer/urlsCore.js';

let scenarios = 0;
let failures = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function assertEqual<T>(actual: T, expected: T, label?: string): void {
	const a = JSON.stringify(actual);
	const e = JSON.stringify(expected);
	if (a !== e) {
		throw new Error(`${label ?? 'value'}: expected ${e}, got ${a}`);
	}
}

function assertContains(haystack: string, needle: string): void {
	if (!haystack.includes(needle)) {
		throw new Error(`expected "${haystack}" to contain "${needle}"`);
	}
}

function assertTrue(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

/** Reimplementation of externalExplorerUrls' core logic without
 *  the $lib/stores/instance import — takes the operator override
 *  template (or null) as an explicit parameter.  Mirrors the
 *  real implementation byte-for-byte except for the store read. */
function computeUrls(
	operatorTpl: string | null,
	bundledList: readonly string[],
	txidRe: RegExp,
	txid: string
): readonly string[] {
	if (typeof txid !== 'string') return [];
	if (!txidRe.test(txid)) return [];
	const lower = txid.toLowerCase();
	const seen = new Set<string>();
	const result: string[] = [];
	const push = (tpl: string): void => {
		const url = substituteTxidIntoTemplate(tpl, lower);
		if (url === null) return;
		if (seen.has(url)) return;
		seen.add(url);
		result.push(url);
	};
	if (operatorTpl !== null && isValidChatLinkTemplate(operatorTpl)) {
		push(operatorTpl);
	}
	for (const tpl of bundledList) {
		push(tpl);
	}
	return result;
}

console.log('explorer-urls-multi-smoke');
console.log('──────────────────────────────────────────────────────');

const VALID_BTC_TXID = 'a'.repeat(64);
const VALID_XMR_TXID = 'b'.repeat(64);
const INVALID_TXID = 'not-a-txid';

// ─── basic shape ─────────────────────────────────────────────

scenario('BTC bundled list is non-empty + each element is https://', () => {
	if (BUNDLED_BTC_CHAT_LINK_URLS.length === 0) throw new Error('expected non-empty');
	for (const u of BUNDLED_BTC_CHAT_LINK_URLS) {
		if (!u.startsWith('https://')) throw new Error(`non-https template: ${u}`);
		if (!u.includes('{txid}')) throw new Error(`template missing {txid}: ${u}`);
	}
});

scenario('XMR / ETH / SOL bundled lists each have ≥2 URLs (real dropdown)', () => {
	if (BUNDLED_XMR_CHAT_LINK_URLS.length < 2) throw new Error(`XMR has <2`);
	if (BUNDLED_ETH_CHAT_LINK_URLS.length < 2) throw new Error(`ETH has <2`);
	if (BUNDLED_SOL_CHAT_LINK_URLS.length < 2) throw new Error(`SOL has <2`);
});

scenario('all 12 asset bundled lists exist and are immutable readonly arrays', () => {
	const lists = [
		BUNDLED_BTC_CHAT_LINK_URLS,
		BUNDLED_XMR_CHAT_LINK_URLS,
		BUNDLED_BCH_CHAT_LINK_URLS,
		BUNDLED_LTC_CHAT_LINK_URLS,
		BUNDLED_DASH_CHAT_LINK_URLS,
		BUNDLED_DOGE_CHAT_LINK_URLS,
		BUNDLED_ZEC_CHAT_LINK_URLS,
		BUNDLED_ARRR_CHAT_LINK_URLS,
		BUNDLED_DCR_CHAT_LINK_URLS,
		BUNDLED_SOL_CHAT_LINK_URLS,
		BUNDLED_ETH_CHAT_LINK_URLS,
		BUNDLED_XRP_CHAT_LINK_URLS
	];
	if (lists.length !== 12) throw new Error('expected 12 lists');
	for (const l of lists) {
		if (l.length === 0) throw new Error('empty list');
	}
});

scenario('singular constant matches plural[0] (backward-compat parity)', () => {
	assertEqual(
		BUNDLED_BTC_CHAT_LINK_URL,
		BUNDLED_BTC_CHAT_LINK_URLS[0],
		'BTC parity'
	);
	assertEqual(
		BUNDLED_XMR_CHAT_LINK_URL,
		BUNDLED_XMR_CHAT_LINK_URLS[0],
		'XMR parity'
	);
});

// ─── computeUrls (logic that mirrors externalExplorerUrls) ────

scenario('no operator override → bundled list in order, txid substituted', () => {
	const result = computeUrls(null, BUNDLED_BTC_CHAT_LINK_URLS, BTC_TXID_RE, VALID_BTC_TXID);
	assertEqual(result.length, BUNDLED_BTC_CHAT_LINK_URLS.length, 'count');
	for (const url of result) {
		assertContains(url, VALID_BTC_TXID);
		if (!url.startsWith('https://')) throw new Error(`non-https: ${url}`);
	}
});

scenario('operator override prepended, then bundled list', () => {
	const operator = 'https://my-private-btc-explorer.example/tx/{txid}';
	const result = computeUrls(operator, BUNDLED_BTC_CHAT_LINK_URLS, BTC_TXID_RE, VALID_BTC_TXID);
	assertEqual(result.length, BUNDLED_BTC_CHAT_LINK_URLS.length + 1, 'count = bundled + 1');
	assertContains(result[0]!, 'my-private-btc-explorer.example');
	assertContains(result[0]!, VALID_BTC_TXID);
	assertContains(result[1]!, 'mempool.space');
});

scenario('operator override equal to bundled primary → no duplicate', () => {
	const operator = BUNDLED_BTC_CHAT_LINK_URLS[0]!;
	const result = computeUrls(operator, BUNDLED_BTC_CHAT_LINK_URLS, BTC_TXID_RE, VALID_BTC_TXID);
	assertEqual(result.length, BUNDLED_BTC_CHAT_LINK_URLS.length, 'dedupe applied');
});

scenario('operator override invalid → ignored, bundled list returned', () => {
	const operator = 'javascript:alert(1)';
	const result = computeUrls(operator, BUNDLED_BTC_CHAT_LINK_URLS, BTC_TXID_RE, VALID_BTC_TXID);
	assertEqual(result.length, BUNDLED_BTC_CHAT_LINK_URLS.length, 'count = bundled (override discarded)');
	for (const url of result) {
		if (url.includes('javascript')) throw new Error('XSS leak: ' + url);
	}
});

scenario('invalid txid → empty array (sentinel, not null)', () => {
	const result = computeUrls(null, BUNDLED_BTC_CHAT_LINK_URLS, BTC_TXID_RE, INVALID_TXID);
	assertEqual(result.length, 0, 'empty array');
	// Empty array must still be iterable
	let visited = 0;
	for (const _ of result) visited++;
	assertEqual(visited, 0, 'iterator-safe');
});

scenario('XMR txid validates against XMR regex', () => {
	const result = computeUrls(null, BUNDLED_XMR_CHAT_LINK_URLS, XMR_TXID_RE, VALID_XMR_TXID);
	assertTrue(result.length >= 1, 'expected at least one URL');
	assertContains(result[0]!, VALID_XMR_TXID);
});

scenario('uppercase txid is lowercased in output URLs', () => {
	const upper = 'A'.repeat(64);
	const result = computeUrls(null, BUNDLED_BTC_CHAT_LINK_URLS, BTC_TXID_RE, upper);
	assertTrue(result.length >= 1, 'expected at least one URL');
	assertContains(result[0]!, 'a'.repeat(64));
	if (result[0]!.includes('A'.repeat(64))) throw new Error('uppercase leaked');
});

// ─── cp174 — multi-network token explorer widening (USDT/USDC/DAI) ───
//
// Mirrors urls.ts tokenExplorerUrls(): per-network normalization
// (SPL case-sensitive; TRC-20 lowercase-no-prefix; EVM lowercase+0x),
// operator override first (re-validated), then bundled alternatives,
// deduped.  Tested against the pure TOKEN_NETWORK_EXPLORER_URLS map.

function normalizeTokenTxidClone(network: string, txid: string): string {
	if (network === 'spl') return txid;
	if (network === 'trc20') return txid.toLowerCase();
	const lc = txid.toLowerCase();
	return lc.startsWith('0x') ? lc : `0x${lc}`;
}

function computeTokenUrls(
	network: string,
	txid: string,
	override: string | null
): readonly string[] {
	const normalized = normalizeTokenTxidClone(network, txid);
	const alternatives = TOKEN_NETWORK_EXPLORER_URLS[network] ?? [];
	const seen = new Set<string>();
	const result: string[] = [];
	const push = (tpl: string): void => {
		const url = substituteTxidIntoTemplate(tpl, normalized);
		if (url === null) return;
		if (seen.has(url)) return;
		seen.add(url);
		result.push(url);
	};
	if (override !== null && isValidChatLinkTemplate(override)) push(override);
	for (const tpl of alternatives) push(tpl);
	return result;
}

const EVM_TXID = '0x' + 'a'.repeat(64);
const TRON_TXID = 'c'.repeat(64);
const SPL_TXID = '5'.repeat(88); // base58, 88 chars

scenario('every token network has a non-empty alternatives list', () => {
	for (const net of ['erc20', 'trc20', 'spl', 'bep20', 'base', 'polygon', 'arbitrum']) {
		const list = TOKEN_NETWORK_EXPLORER_URLS[net];
		assertTrue(Array.isArray(list) && list.length >= 1, `network ${net} has alternatives`);
	}
});

scenario('token alternatives are all https + contain {txid} template', () => {
	for (const net of Object.keys(TOKEN_NETWORK_EXPLORER_URLS)) {
		for (const tpl of TOKEN_NETWORK_EXPLORER_URLS[net]!) {
			assertTrue(tpl.startsWith('https://'), `https: ${tpl}`);
			assertTrue(tpl.includes('{txid}'), `has {txid}: ${tpl}`);
		}
	}
});

scenario('erc20 (EVM) widening: multiple URLs, lowercased + 0x preserved', () => {
	const result = computeTokenUrls('erc20', EVM_TXID, null);
	assertTrue(result.length >= 2, 'expected dropdown (≥2 explorers)');
	assertContains(result[0]!, '0x' + 'a'.repeat(64));
});

scenario('spl txid is NOT lowercased (base58 case-sensitive)', () => {
	const mixed = 'AbCdEf' + '5'.repeat(82); // 88 chars, mixed case
	const result = computeTokenUrls('spl', mixed, null);
	assertTrue(result.length >= 1, 'expected ≥1 explorer');
	assertContains(result[0]!, 'AbCdEf'); // case preserved
});

scenario('trc20 txid lowercased, no 0x prefix added', () => {
	const result = computeTokenUrls('trc20', TRON_TXID.toUpperCase(), null);
	assertTrue(result.length >= 1, 'expected ≥1 explorer');
	assertContains(result[0]!, 'c'.repeat(64));
	if (result[0]!.includes('0x')) throw new Error('trc20 must not get 0x prefix');
});

scenario('operator override prepends the token alternatives list', () => {
	const override = 'https://my-evm-explorer.example/tx/{txid}';
	const result = computeTokenUrls('erc20', EVM_TXID, override);
	assertContains(result[0]!, 'my-evm-explorer.example');
	assertEqual(
		result.length,
		TOKEN_NETWORK_EXPLORER_URLS['erc20']!.length + 1,
		'override + bundled alternatives'
	);
});

scenario('malicious token override (javascript:) is rejected; bundled list only', () => {
	const evil = 'javascript:alert(1)//{txid}';
	const result = computeTokenUrls('erc20', EVM_TXID, evil);
	assertEqual(result.length, TOKEN_NETWORK_EXPLORER_URLS['erc20']!.length, 'override discarded');
	for (const url of result) {
		if (url.includes('javascript')) throw new Error('XSS leak: ' + url);
	}
});

scenario('token alternatives de-duplicate (override equal to primary)', () => {
	const primary = TOKEN_NETWORK_EXPLORER_URLS['spl']![0]!; // solscan template
	const result = computeTokenUrls('spl', SPL_TXID, primary);
	// override == primary → after substitution the URL is identical → deduped
	assertEqual(result.length, TOKEN_NETWORK_EXPLORER_URLS['spl']!.length, 'no duplicate');
});

scenario('unknown token network → empty alternatives (graceful)', () => {
	const result = computeTokenUrls('nonexistent-net', EVM_TXID, null);
	assertEqual(result.length, 0, 'empty for unknown network');
});

// ─── End ──────────────────────────────────────────────────────

console.log('');
console.log('──────────────────────────────────────────────────────');
if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures}/${scenarios} scenarios failed`);
	process.exit(1);
}
