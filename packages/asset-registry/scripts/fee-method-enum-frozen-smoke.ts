#!/usr/bin/env tsx
/**
 * fee-method-enum-frozen-smoke.
 *
 * Memory #23 (2026-05-13) declared a hard invariant:
 *
 *   Listing fees can ONLY be paid in BLURT, XMR, or BTC.
 *   New tradable assets (USDT, ARRR, etc.) are peer-to-peer
 *   trading only.  The indexer's `fee_method` enum stays
 *   frozen: `'blurt' | 'waived_first_buy' | 'btc' | 'xmr'`.
 *
 * This smoke is a sentinel that fails LOUDLY if anyone in the
 * future tries to expand the enum (adding 'usdt', 'ltc', etc.).
 * The asset-registry-smoke catches the registry side
 * (canPayListingFee: true must imply ticker ∈ {BLURT,BTC,XMR});
 * THIS smoke catches the wire-format side (the indexer's order
 * handler hardcodes the union type).
 *
 * Belt + suspenders: a future contributor would have to update
 * BOTH the registry AND this smoke AND the indexer order handler
 * to add a new fee_method, which is exactly the friction we
 * want — the invariant is documented in three places and any
 * of them being inconsistent triggers a CI failure.
 *
 * Sentinel-grep against `apps/indexer/src/indexer/handlers/order.ts`:
 *  - The `fee_method` type union must appear exactly as the
 *    frozen 4-member set.
 *  - No string-literal `'usdt'`, `'ltc'`, `'doge'`, `'zec'`, `'arrr'`,
 *    etc. on a `fee_method` line.
 *
 * Usage:
 *   tsx packages/asset-registry/scripts/fee-method-enum-frozen-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');
const ORDER_HANDLER = join(
	REPO_ROOT,
	'apps/indexer/src/indexer/handlers/order.ts'
);

let failed = 0;
let passed = 0;

function pass(name: string): void {
	console.log(`  ✓ ${name}`);
	passed++;
}
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`);
	console.error(`      ${detail}`);
	failed++;
}

console.log('\n── fee-method-enum-frozen smoke ────────────────────────\n');

let body: string;
try {
	body = readFileSync(ORDER_HANDLER, 'utf8');
} catch (err) {
	fail(
		'order.ts readable',
		`could not read ${ORDER_HANDLER}: ${err}`
	);
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(1);
}

// ── Scenario 1 — frozen union appears in the field type ──────────
const FROZEN_UNION = /readonly fee_method:\s*'blurt'\s*\|\s*'waived_first_buy'\s*\|\s*'btc'\s*\|\s*'xmr'/;
if (FROZEN_UNION.test(body)) {
	pass(`fee_method field type union is frozen at BLURT/waived/BTC/XMR`);
} else {
	fail(
		`fee_method field type union is frozen at BLURT/waived/BTC/XMR`,
		`expected 'readonly fee_method: 'blurt' | 'waived_first_buy' | 'btc' | 'xmr'' in order.ts; not found.  Did someone add a new fee_method value?`
	);
}

// ── Scenario 2 — initializer line uses the frozen union ──────────
const INITIALIZER_UNION = /let fee_method:\s*'blurt'\s*\|\s*'waived_first_buy'\s*\|\s*'btc'\s*\|\s*'xmr'/;
if (INITIALIZER_UNION.test(body)) {
	pass(`fee_method initializer uses frozen union`);
} else {
	fail(
		`fee_method initializer uses frozen union`,
		`expected 'let fee_method: 'blurt' | 'waived_first_buy' | 'btc' | 'xmr'' in order.ts; not found`
	);
}

// ── Scenario 3 — no expansion tickers leaked in on fee_method ────
// If anyone added 'usdt', 'ltc', 'doge', 'arrr', 'eth', 'sol' as
// a fee_method value, the wire-format enum is no longer frozen.
const FORBIDDEN_TICKERS = ['usdt', 'ltc', 'doge', 'arrr', 'eth', 'sol', 'bch', 'xlm', 'dash'];
let expansionFound = false;
for (const line of body.split('\n')) {
	if (!line.includes('fee_method')) continue;
	for (const tkr of FORBIDDEN_TICKERS) {
		const re = new RegExp(`['"]${tkr}['"]`, 'i');
		if (re.test(line)) {
			fail(
				`no expansion tickers in fee_method enum`,
				`line contains '${tkr}' string literal next to fee_method: ${line.trim().slice(0, 120)}`
			);
			expansionFound = true;
		}
	}
}
if (!expansionFound) {
	pass(`no expansion tickers (USDT/LTC/DOGE/etc.) in fee_method enum`);
}

// ── Scenario 4 — the four required values are individually present ─
// Belt-on-the-belt: each member must appear on its own as a
// string literal in the file so future refactors don't silently
// drop one of them.
const REQUIRED_LITERALS = ["'blurt'", "'waived_first_buy'", "'btc'", "'xmr'"];
for (const lit of REQUIRED_LITERALS) {
	if (body.includes(lit)) {
		pass(`fee_method literal ${lit} present in order.ts`);
	} else {
		fail(
			`fee_method literal ${lit} present in order.ts`,
			`required literal ${lit} not found anywhere in order.ts`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\nfee-method-enum-frozen smoke FAILED');
	process.exit(1);
}
// Canonical success line — run-smokes.sh greps for `^✓ all` to tally
console.log(`✓ all ${total} fee-method-enum-frozen scenarios passed`);
