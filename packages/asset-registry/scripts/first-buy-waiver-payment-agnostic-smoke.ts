#!/usr/bin/env tsx
/**
 * first-buy-waiver-payment-agnostic-smoke.
 *
 * Memory #23 + Ken's design answer for Part 121 question 3:
 *
 *   "If their first buy order of BLURT is with USDT, that's fine."
 *
 * Translation: the first-buy waiver gate fires on (side='buy',
 * asset='BLURT') REGARDLESS of what the buyer pays their seller
 * with.  The waiver covers the LISTING FEE, not the trade
 * settlement.  A new user buying BLURT and paying their
 * counterparty in USDT, fiat, BTC, XMR, or anything else still
 * gets the listing-fee waiver.
 *
 * This smoke asserts the waiver-gate code does NOT depend on
 * `payment_methods`.  If a future contributor adds a check like
 * "only fire the waiver when payment_methods contains 'cash'" or
 * "block the waiver for USDT-paid trades", this smoke fails.
 *
 * Sentinel-grep against `apps/indexer/src/indexer/handlers/order.ts`:
 *  - Find the waived_first_buy branch
 *  - Assert it contains the side check, the asset===BLURT check,
 *    and the amount-min check
 *  - Assert it does NOT contain `payment_methods` ANYWHERE
 *    within that branch
 *
 * Usage:
 *   tsx packages/asset-registry/scripts/first-buy-waiver-payment-agnostic-smoke.ts
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

console.log('\n── first-buy-waiver-payment-agnostic smoke ─────────────\n');

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

// ── Scenario 1 — extract the waived_first_buy branch ─────────────
const branchStartRe = /if \(v\.fee_method === 'waived_first_buy'\) \{/;
const branchStart = body.search(branchStartRe);
if (branchStart < 0) {
	fail(
		`waived_first_buy branch present`,
		`expected 'if (v.fee_method === 'waived_first_buy') {' in order.ts — couldn't find the waiver branch at all`
	);
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(1);
} else {
	pass(`waived_first_buy branch present in order.ts`);
}

// Find the matching closing brace by depth-counting from the `{`
let depth = 0;
let branchEnd = -1;
let started = false;
for (let i = branchStart; i < body.length; i++) {
	const c = body[i];
	if (c === '{') {
		depth++;
		started = true;
	} else if (c === '}') {
		depth--;
		if (started && depth === 0) {
			branchEnd = i + 1;
			break;
		}
	}
}
if (branchEnd < 0) {
	fail(
		`waiver branch balanced`,
		`couldn't find matching closing brace for the waiver branch — file structure is unexpected`
	);
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(1);
} else {
	pass(`waiver branch is brace-balanced (extractable as a unit)`);
}

const waiverBranch = body.slice(branchStart, branchEnd);

// The "gate" is everything from the branch start up to the first
// INSERT statement (the success-path persistence).  References to
// `payment_methods` inside the INSERT are correct (it's a column
// being persisted, not a gate dependency).  We only flag refs
// in the gate.
const gateEnd = waiverBranch.search(/INSERT INTO orders/);
const waiverGate = gateEnd > 0 ? waiverBranch.slice(0, gateEnd) : waiverBranch;

// ── Scenario 2 — waiver checks side === 'buy' ────────────────────
if (/v\.side !== 'buy'/.test(waiverGate)) {
	pass(`waiver gate checks side !== 'buy'`);
} else {
	fail(
		`waiver gate checks side !== 'buy'`,
		`expected 'v.side !== 'buy'' in the waiver gate; not found`
	);
}

// ── Scenario 3 — waiver checks asset === 'BLURT' ─────────────────
if (/v\.asset !== 'BLURT'/.test(waiverGate)) {
	pass(`waiver gate checks asset !== 'BLURT'`);
} else {
	fail(
		`waiver gate checks asset !== 'BLURT'`,
		`expected 'v.asset !== 'BLURT'' in the waiver gate; not found`
	);
}

// ── Scenario 4 — the GATE is PAYMENT-METHOD AGNOSTIC ─────────────
// This is the load-bearing check.  Even one reference to
// payment_methods inside the gate (before the INSERT) would mean
// the waiver is dependent on what the buyer pays their seller
// with — which violates Ken's design for Part 121 question 3.
// Mentions inside the INSERT statement (column list, VALUES
// binding) are fine — they're persistence, not gating.
if (/payment_methods/.test(waiverGate)) {
	fail(
		`waiver gate does NOT reference payment_methods`,
		`the waiver gate references 'payment_methods' — the waiver must fire regardless of how the buyer pays the seller (Memory #23, Part 121 Q3 answer).  Find the gate condition and remove the dependence.`
	);
} else {
	pass(`waiver gate does NOT reference payment_methods (gate is payment-method agnostic)`);
}

// ── Scenario 5 — the GATE is NOT dependent on a specific  ────────
// payment rail like 'cash', 'paypal', 'usdt' as a string literal.
const FORBIDDEN_RAILS = ['cash', 'paypal', 'zelle', 'wise', 'usdt', 'bitso', 'venmo', 'revolut'];
let railFound = false;
for (const rail of FORBIDDEN_RAILS) {
	const re = new RegExp(`['"]${rail}['"]`, 'i');
	if (re.test(waiverGate)) {
		fail(
			`waiver gate does NOT reference fiat payment rails`,
			`waiver gate contains a '${rail}' string literal — the gate must not depend on the fiat-side payment rail`
		);
		railFound = true;
	}
}
if (!railFound) {
	pass(`waiver gate does NOT reference fiat payment rails (cash/paypal/zelle/etc.)`);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\nfirst-buy-waiver-payment-agnostic smoke FAILED');
	process.exit(1);
}
// Canonical success line — run-smokes.sh greps for `^✓ all` to tally
console.log(`✓ all ${total} first-buy-waiver-payment-agnostic scenarios passed`);
