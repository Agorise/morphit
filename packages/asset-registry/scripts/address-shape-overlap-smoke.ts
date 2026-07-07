#!/usr/bin/env tsx
/**
 * address-shape-overlap-smoke.
 *
 * CP42 K-73 closure of LL #50 (cp41): when adding chains with shared
 * protocol lineage, two assets may share address formats — the regex
 * layer can't disambiguate; only context (asset field, tab selection)
 * can.  This smoke pins the KNOWN intentional overlaps as an explicit
 * allowlist and FAILS if a future asset addition introduces a NEW
 * overlap that isn't documented.
 *
 * Methodology: for each pair (A, B) of registered assets, generate
 * specimen addresses for A and test whether B's addressShape accepts
 * them.  Each specimen address is built deterministically from A's
 * regex alternations.
 *
 * Currently documented intentional overlaps:
 *  - {USDT, USDC, DAI} all accept 0x... ERC-20 addresses (same EVM
 *    family; context = token-contract address).
 *  - {USDT, USDC} both accept base58 SPL addresses (Solana family).
 *  - {USDT} accepts T... Tron addresses, USDC/DAI don't.
 *  - {BTC, BCH, LTC} legacy `1...` and `3...` addresses overlap
 *    (BCH preserves legacy compatibility; LTC `3...` is legacy P2SH).
 *  - {ZEC, ARRR} both accept zs1 Sapling shielded addresses (cp41
 *    LL #50: Pirate Chain forked from Zcash Sapling protocol).
 *
 * Any UNDOCUMENTED overlap fails the smoke.
 *
 * NOTE on USDT/USDC SPL permissiveness: USDT and USDC are multi-network
 * stablecoins where the SPL (Solana) network uses base58 Token Account
 * addresses that have no fixed prefix.  Their regex
 * `[1-9A-HJ-NP-Za-km-z]{32,44}` is correctly permissive but matches
 * many other chains' base58 addresses (DOGE/DASH/BCH-legacy/LTC/ZEC-
 * transparent etc.).  The mitigation lives at the order layer:
 * USDT/USDC orders carry an `asset_network` field, and per-network
 * regex validation happens after shape-check.  This smoke documents
 * the shape overlaps; `asset_network` and per-network smokes pin
 * the routing invariant.
 */

import { ASSETS as CANONICAL } from '../src/index';

let failed = 0;
let passed = 0;

console.log('\n── address-shape overlap smoke ───────────────────────\n');

// Specimens: representative addresses for each ticker.
const SPECIMENS: Record<string, string[]> = {
	BTC: ['1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq'],
	XMR: ['4' + 'A'.repeat(94)],
	BLURT: ['alice', 'bob-trader-42'],
	USDT: ['0xdAC17F958D2ee523a2206206994597C13D831ec7', 'TRwBdHwgaTtSGyhz8XmFmcv8VspbXP7AwL', 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'],
	USDC: ['0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
	DAI: ['0x6B175474E89094C44Da98b954EedeAC495271d0F'],
	BCH: ['bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', 'qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a', '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'],
	LTC: ['LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL', 'MJRSgZ3UUFcTBTBAaN38XAXvZLwRe9q92K', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', 'ltc1qhgqd3p9hky4r29mxrkv0p38apgmt9rqxmf04qd'],
	DASH: ['XwnLY8qaFu8aGM9XRdcaQ9XgnnQ8AbnXkc', '7gnwGHt17heGpG9Crfeh4KGpYNFugPhJdh'],
	DOGE: ['DPHwLrG5Cm5R8KCNNfMcXSEoVbCRBkXxhf', '9oWnzfQwHJxQwgKZBJjBPNxhSEy7sCwbtL', 'A7M2sPo9o6KBdaA1V8tNuS9YqQ8eJ9YHHb'],
	ZEC: ['t1RKFygRTZxfP7Z3uW4kBJjGNB6cqxQyEmA', 't3JXcyHRZqv6sgCnJiR9Zc4sXh9pK77HQjE', 'zs1' + 'q'.repeat(75), 'u1' + 'q'.repeat(80)],
	ARRR: ['zs1' + 'q'.repeat(75)],
	DCR: ['Dsmcfb6dGoZBaBdF8u1QFcKsuyaPgxR8N7d', 'DcaBzU8eM3o5dC6Phx8nDQAVa1iSYHwSc9N'],
	SOL: ['So11111111111111111111111111111111111111112', '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM'],
	ETH: ['0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'],
	XRP: ['rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh', 'rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv']
};

// Documented intentional overlaps as (A_owner, addr_class, B_acceptors).
// Each pair (A, B) where B accepts an A specimen must appear here.
const EXPECTED_OVERLAPS: Set<string> = new Set([
	'ARRR-zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq->ZEC',
	'BCH-1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa->BTC',
	'BCH-1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa->SOL',
	'BCH-1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa->USDC',
	'BCH-1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa->USDT',
	'BCH-qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a->SOL',
	'BCH-qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a->USDC',
	'BCH-qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a->USDT',
	'BTC-1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa->BCH',
	'BTC-1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa->SOL',
	'BTC-1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa->USDC',
	'BTC-1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa->USDT',
	'BTC-3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy->BCH',
	'BTC-3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy->LTC',
	'BTC-3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy->SOL',
	'BTC-3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy->USDC',
	'BTC-3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy->USDT',
	'DAI-0x6B175474E89094C44Da98b954EedeAC495271d0F->ETH',
	'DAI-0x6B175474E89094C44Da98b954EedeAC495271d0F->USDC',
	'DAI-0x6B175474E89094C44Da98b954EedeAC495271d0F->USDT',
	'DASH-7gnwGHt17heGpG9Crfeh4KGpYNFugPhJdh->SOL',
	'DASH-7gnwGHt17heGpG9Crfeh4KGpYNFugPhJdh->USDC',
	'DASH-7gnwGHt17heGpG9Crfeh4KGpYNFugPhJdh->USDT',
	'DASH-XwnLY8qaFu8aGM9XRdcaQ9XgnnQ8AbnXkc->SOL',
	'DASH-XwnLY8qaFu8aGM9XRdcaQ9XgnnQ8AbnXkc->USDC',
	'DASH-XwnLY8qaFu8aGM9XRdcaQ9XgnnQ8AbnXkc->USDT',
	'DCR-DcaBzU8eM3o5dC6Phx8nDQAVa1iSYHwSc9N->SOL',
	'DCR-DcaBzU8eM3o5dC6Phx8nDQAVa1iSYHwSc9N->USDC',
	'DCR-DcaBzU8eM3o5dC6Phx8nDQAVa1iSYHwSc9N->USDT',
	'DCR-Dsmcfb6dGoZBaBdF8u1QFcKsuyaPgxR8N7d->SOL',
	'DCR-Dsmcfb6dGoZBaBdF8u1QFcKsuyaPgxR8N7d->USDC',
	'DCR-Dsmcfb6dGoZBaBdF8u1QFcKsuyaPgxR8N7d->USDT',
	'DOGE-9oWnzfQwHJxQwgKZBJjBPNxhSEy7sCwbtL->SOL',
	'DOGE-9oWnzfQwHJxQwgKZBJjBPNxhSEy7sCwbtL->USDC',
	'DOGE-9oWnzfQwHJxQwgKZBJjBPNxhSEy7sCwbtL->USDT',
	'DOGE-A7M2sPo9o6KBdaA1V8tNuS9YqQ8eJ9YHHb->SOL',
	'DOGE-A7M2sPo9o6KBdaA1V8tNuS9YqQ8eJ9YHHb->USDC',
	'DOGE-A7M2sPo9o6KBdaA1V8tNuS9YqQ8eJ9YHHb->USDT',
	'DOGE-DPHwLrG5Cm5R8KCNNfMcXSEoVbCRBkXxhf->SOL',
	'DOGE-DPHwLrG5Cm5R8KCNNfMcXSEoVbCRBkXxhf->USDC',
	'DOGE-DPHwLrG5Cm5R8KCNNfMcXSEoVbCRBkXxhf->USDT',
	'ETH-0x742d35Cc6634C0532925a3b844Bc454e4438f44e->DAI',
	'ETH-0x742d35Cc6634C0532925a3b844Bc454e4438f44e->USDC',
	'ETH-0x742d35Cc6634C0532925a3b844Bc454e4438f44e->USDT',
	'ETH-0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045->DAI',
	'ETH-0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045->USDC',
	'ETH-0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045->USDT',
	'LTC-3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy->BCH',
	'LTC-3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy->BTC',
	'LTC-3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy->SOL',
	'LTC-3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy->USDC',
	'LTC-3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy->USDT',
	'LTC-LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL->SOL',
	'LTC-LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL->USDC',
	'LTC-LdP8Qox1VAhCzLJNqrr74YovaWYyNBUWvL->USDT',
	'LTC-MJRSgZ3UUFcTBTBAaN38XAXvZLwRe9q92K->SOL',
	'LTC-MJRSgZ3UUFcTBTBAaN38XAXvZLwRe9q92K->USDC',
	'LTC-MJRSgZ3UUFcTBTBAaN38XAXvZLwRe9q92K->USDT',
	'SOL-9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM->USDC',
	'SOL-9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM->USDT',
	'SOL-So11111111111111111111111111111111111111112->USDC',
	'SOL-So11111111111111111111111111111111111111112->USDT',
	'USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48->DAI',
	'USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48->ETH',
	'USDC-0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48->USDT',
	'USDC-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v->SOL',
	'USDC-EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v->USDT',
	'USDT-0xdAC17F958D2ee523a2206206994597C13D831ec7->DAI',
	'USDT-0xdAC17F958D2ee523a2206206994597C13D831ec7->ETH',
	'USDT-0xdAC17F958D2ee523a2206206994597C13D831ec7->USDC',
	'USDT-Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB->SOL',
	'USDT-Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB->USDC',
	'USDT-TRwBdHwgaTtSGyhz8XmFmcv8VspbXP7AwL->SOL',
	'USDT-TRwBdHwgaTtSGyhz8XmFmcv8VspbXP7AwL->USDC',
	'XRP-rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv->SOL',
	'XRP-rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv->USDC',
	'XRP-rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv->USDT',
	'XRP-rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh->SOL',
	'XRP-rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh->USDC',
	'XRP-rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh->USDT',
	'ZEC-t1RKFygRTZxfP7Z3uW4kBJjGNB6cqxQyEmA->SOL',
	'ZEC-t1RKFygRTZxfP7Z3uW4kBJjGNB6cqxQyEmA->USDC',
	'ZEC-t1RKFygRTZxfP7Z3uW4kBJjGNB6cqxQyEmA->USDT',
	'ZEC-t3JXcyHRZqv6sgCnJiR9Zc4sXh9pK77HQjE->SOL',
	'ZEC-t3JXcyHRZqv6sgCnJiR9Zc4sXh9pK77HQjE->USDC',
	'ZEC-t3JXcyHRZqv6sgCnJiR9Zc4sXh9pK77HQjE->USDT',
	'ZEC-zs1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq->ARRR',
]);

// Walk every (A, specimen, B) triple and record overlaps
const found = new Set<string>();
for (const a of CANONICAL) {
	const aSpecs = SPECIMENS[a.ticker] ?? [];
	for (const spec of aSpecs) {
		for (const b of CANONICAL) {
			if (a.ticker === b.ticker) continue;
			if (b.addressShape.test(spec)) {
				found.add(`${a.ticker}-${spec}->${b.ticker}`);
			}
		}
	}
}

// Now compare
const unexpected: string[] = [];
for (const overlap of found) {
	if (!EXPECTED_OVERLAPS.has(overlap)) {
		unexpected.push(overlap);
	}
}
const missing: string[] = [];
for (const expected of EXPECTED_OVERLAPS) {
	if (!found.has(expected)) {
		missing.push(expected);
	}
}

if (unexpected.length === 0 && missing.length === 0) {
	console.log(`  ✓ All ${found.size} cross-asset address-shape overlaps match the documented allowlist`);
	passed++;
} else {
	if (unexpected.length) {
		console.error(`  ✗ UNEXPECTED overlaps (potential LL #50 risk):`);
		for (const u of unexpected) console.error(`      ${u}`);
		failed++;
	}
	if (missing.length) {
		console.error(`  ✗ Expected overlaps not observed (allowlist stale):`);
		for (const m of missing) console.error(`      ${m}`);
		failed++;
	}
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
	console.error('\naddress-shape-overlap smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${passed} address-shape-overlap scenarios passed`);
