#!/usr/bin/env tsx
/**
 * usdt-network-picker-required-smoke.
 *
 * Part 121 sentinel: the three USDT-touching forms (/post,
 * AddressShareModal, FundsSentModal) MUST gate their submit
 * button on `usdtNetwork !== null` whenever the asset/method
 * is USDT.  This smoke is a sentinel-grep against the
 * canonical pattern so future refactors can't silently drop
 * the gate.
 *
 * Why this matters: cross-network sends lose funds.  A form
 * that lets a user submit a USDT trade with no network picked
 * would either default to one (we don't — defaultNetwork is
 * null per memory #25's no-default design) or fall through
 * with the network unset, leaving the seller to interpret
 * what chain the buyer means.  Both fail the priority-#1
 * privacy / priority-#3 grandma-friendly tests.
 *
 * Sentinel-grep targets:
 *   1. /post +page.svelte — step1Done gates on
 *      `asset !== 'USDT' || usdtNetwork !== null`
 *   2. AddressShareModal.svelte — canSubmit includes
 *      `usdtNetworkPicked`
 *   3. FundsSentModal.svelte — canSubmit includes
 *      `usdtNetworkPicked`
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

const POST_PAGE = join(REPO_ROOT, 'apps/web/src/routes/[lang]/post/+page.svelte');
const ADDRESS_MODAL = join(REPO_ROOT, 'apps/web/src/lib/components/AddressShareModal.svelte');
const FUNDS_MODAL = join(REPO_ROOT, 'apps/web/src/lib/components/FundsSentModal.svelte');

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

console.log('\n── usdt-network-picker-required smoke ────────────────\n');

// ── 1) /post page ──────────────────────────────────────────────
let postBody: string;
try {
	postBody = readFileSync(POST_PAGE, 'utf8');
} catch (err) {
	fail('/post page readable', `${err}`);
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(1);
}

// step1Done MUST reference USDT-network-gating.  Pattern:
// `asset !== 'USDT' || usdtNetwork !== null`.
const POST_GATE_RE = /asset\s*!==\s*['"]USDT['"]\s*\|\|\s*usdtNetwork\s*!==\s*null/;
if (POST_GATE_RE.test(postBody)) {
	pass('/post step1Done gates on usdtNetwork when asset === USDT');
} else {
	fail(
		'/post step1Done gates on usdtNetwork when asset === USDT',
		`expected pattern like "asset !== 'USDT' || usdtNetwork !== null" in /post +page.svelte; not found.  Did the network-required gate get removed?`
	);
}

// /post MUST import UsdtNetworkPicker.
if (/import\s+UsdtNetworkPicker\s+from/.test(postBody)) {
	pass('/post imports UsdtNetworkPicker');
} else {
	fail('/post imports UsdtNetworkPicker', 'no UsdtNetworkPicker import found');
}

// /post MUST render the picker conditionally on asset === 'USDT'.
if (/asset\s*===\s*['"]USDT['"]/.test(postBody) && /<UsdtNetworkPicker/.test(postBody)) {
	pass('/post renders <UsdtNetworkPicker /> when asset === USDT');
} else {
	fail(
		'/post renders <UsdtNetworkPicker /> when asset === USDT',
		'either the USDT branch or the picker render is missing'
	);
}

// ── 2) AddressShareModal ─────────────────────────────────────
let addrBody: string;
try {
	addrBody = readFileSync(ADDRESS_MODAL, 'utf8');
} catch (err) {
	fail('AddressShareModal readable', `${err}`);
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(1);
}

// canSubmit derivation must include usdtNetworkPicked.
const ADDR_GATE_RE = /usdtNetworkPicked/;
if (ADDR_GATE_RE.test(addrBody)) {
	pass('AddressShareModal canSubmit gates on usdtNetworkPicked');
} else {
	fail(
		'AddressShareModal canSubmit gates on usdtNetworkPicked',
		'no usdtNetworkPicked reference found — picker gate dropped?'
	);
}

// And the derivation itself: `method !== 'usdt' || usdtNetwork !== null`.
const ADDR_PICKED_RE = /method\s*!==\s*['"]usdt['"]\s*\|\|\s*usdtNetwork\s*!==\s*null/;
if (ADDR_PICKED_RE.test(addrBody)) {
	pass('AddressShareModal usdtNetworkPicked derivation correct');
} else {
	fail(
		'AddressShareModal usdtNetworkPicked derivation correct',
		`expected "method !== 'usdt' || usdtNetwork !== null" pattern; not found`
	);
}

// USDT tab present in tablist. cp425 — the method tabs are now rendered
// dynamically from the ALL_METHODS array via `{#each visibleMethods as m}`
// with a templated i18n label `chat.address.method_${m}`, so there is no
// literal `method_usdt` string anymore. Verify 'usdt' is one of the tab
// methods AND the templated label render is present (both are needed for a
// selectable USDT tab — which is what makes the network-required gate reachable).
if (/ALL_METHODS[\s\S]*?'usdt'[\s\S]*?\]/.test(addrBody) && /method_\$\{m\}/.test(addrBody)) {
	pass('AddressShareModal has USDT tab');
} else {
	fail(
		'AddressShareModal has USDT tab',
		'no USDT method in ALL_METHODS or dynamic `method_${m}` tablist label missing'
	);
}

// ── 3) FundsSentModal ──────────────────────────────────────
let fundsBody: string;
try {
	fundsBody = readFileSync(FUNDS_MODAL, 'utf8');
} catch (err) {
	fail('FundsSentModal readable', `${err}`);
	console.log(`\n${passed} passed, ${failed} failed`);
	process.exit(1);
}

if (/usdtNetworkPicked/.test(fundsBody)) {
	pass('FundsSentModal canSubmit gates on usdtNetworkPicked');
} else {
	fail(
		'FundsSentModal canSubmit gates on usdtNetworkPicked',
		'no usdtNetworkPicked reference — picker gate dropped?'
	);
}

if (/method\s*!==\s*['"]usdt['"]\s*\|\|\s*usdtNetwork\s*!==\s*null/.test(fundsBody)) {
	pass('FundsSentModal usdtNetworkPicked derivation correct');
} else {
	fail(
		'FundsSentModal usdtNetworkPicked derivation correct',
		`expected "method !== 'usdt' || usdtNetwork !== null" pattern; not found`
	);
}

// FundsSentModal needs to handle the pinned-network case (read-only
// display when the parent passed initialUsdtNetwork).
if (/networkPinned/.test(fundsBody) && /initialUsdtNetwork/.test(fundsBody)) {
	pass('FundsSentModal handles pinned-network case (initialUsdtNetwork → networkPinned)');
} else {
	fail(
		'FundsSentModal handles pinned-network case',
		'expected networkPinned + initialUsdtNetwork wiring to lock the picker when the parent pinned the network'
	);
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);

if (failed > 0) {
	console.error('\nusdt-network-picker-required smoke FAILED');
	process.exit(1);
}
console.log(`✓ all ${total} usdt-network-picker-required scenarios passed`);
