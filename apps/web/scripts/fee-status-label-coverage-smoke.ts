#!/usr/bin/env tsx
/**
 * Smoke for fee_status label coverage in My Orders and on
 * the order-detail page.
 *
 * Background — Part 103 closure of a real production bug:
 * the May-6 Phase J FAQ audit concluded that `'missing'`,
 * `'underpaid'`, and `'unverified'` were "dead UI branches"
 * (indexer never writes them) and had the case arms removed
 * from `feeStatusLabel` plus the i18n keys deleted.  Part 70
 * later re-extended `OrderRecord.fee_status` to include all
 * 7 states because `order_detail`'s rendering relies on
 * them and svelte-check was failing without the type
 * coverage — but `feeStatusLabel` in My Orders was NOT
 * re-extended at the same time.  Result: an order in
 * fee_status='missing' or 'underpaid' (which the indexer
 * DOES write — verified at order.ts:649,714 and the
 * order-handler smoke) rendered an empty amber pill.
 *
 * To prevent that drift class from re-occurring, this smoke
 * asserts:
 *
 *   1. The set of fee_status values the indexer writes
 *      (parsed structurally from order.ts) is a SUBSET of
 *      the cases handled in `feeStatusLabel`.
 *   2. Every i18n key referenced by `feeStatusLabel` exists
 *      in en.json (smoke-only check; full locale parity is
 *      enforced by locale-parity-smoke).
 *   3. order_detail's fee_status branches cover at least
 *      the same indexer-written set, plus an `else` fallback
 *      (which it already has).
 *   4. `feeStatusLabel` has a defensive `default:` returning
 *      the raw status (not empty) so any future indexer
 *      addition surfaces visibly.
 *
 * Why static-source: the smoke runs in <1 second, doesn't
 * need a database, and catches the exact drift pattern that
 * cost us a real bug.  Runtime tests would catch it too,
 * but only if you remember to write a test per state — the
 * static check is exhaustive by construction.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

const ORDER_HANDLER = join(REPO_ROOT, 'apps/indexer/src/indexer/handlers/order.ts');
const FEE_ATTEST_HANDLER = join(REPO_ROOT, 'apps/indexer/src/indexer/handlers/feeAttest.ts');
const MY_ORDERS_PAGE = join(REPO_ROOT, 'apps/web/src/routes/[lang]/my/orders/+page.svelte');
const ORDER_DETAIL_PAGE = join(
	REPO_ROOT,
	'apps/web/src/routes/[lang]/[x+40][account=account]/[permlink=permlink]/+page.svelte'
);
const EN_LOCALE = join(REPO_ROOT, 'apps/web/src/lib/i18n/locales/en.json');

console.log('');
console.log('── fee_status label coverage smoke ─────────────────────');
console.log('');

// ─── Step 1: parse indexer-written fee_status values ───────────
//
// Two extraction strategies, both required to fire before we
// trust the resulting set:
//   (a) literal string assignments to a feeStatus variable
//       (`feeStatus = 'verified'`, etc.)
//   (b) literal strings inside `VALUES (... 'verified' ...)`
//       SQL fragments that include the fee_status column.
//
// Either alone would be incomplete.  The intersection is
// what the handler can actually emit at runtime.

const orderHandlerSrc = readFileSync(ORDER_HANDLER, 'utf-8');
const feeAttestSrc = readFileSync(FEE_ATTEST_HANDLER, 'utf-8');

// (a) feeStatus = 'value' assignments AND `let/const feeStatus
// [: type annotation] = 'value'` initializations.  The type
// annotation can include union-string literals (which are
// themselves single-quoted), so we extract the LAST single-
// quoted string before a statement-terminator.  Pattern:
//   `feeStatus` followed by anything-but-newline (the optional
//   type annotation), then `=`, then the assigned literal.
const assignRe = /\bfeeStatus\b[^\n]*?=\s*'([a-z_]+)'\s*[;,)\n]/g;
const writtenViaAssign = new Set<string>();
for (const m of orderHandlerSrc.matchAll(assignRe)) {
	writtenViaAssign.add(m[1]);
}
for (const m of feeAttestSrc.matchAll(assignRe)) {
	writtenViaAssign.add(m[1]);
}

// (b) literal strings in VALUES (...) fragments where the
//     INSERT column list contains fee_status.  We grep for
//     SQL fragments that mention fee_status and extract the
//     literal-string values that appear in them.
const sqlLiteralRe =
	/'(verified|verified_by_attestation|pending_external|reused|missing|underpaid|unverified)'/g;
const writtenViaSql = new Set<string>();
for (const file of [orderHandlerSrc, feeAttestSrc]) {
	// crude but effective: find INSERT INTO orders blocks
	// and scan their VALUES clause for known-shape literals.
	const blocks = file.match(/INSERT INTO orders[^]*?ON CONFLICT/g) ?? [];
	for (const block of blocks) {
		for (const m of block.matchAll(sqlLiteralRe)) {
			writtenViaSql.add(m[1]);
		}
	}
	// Plus UPDATE statements that SET fee_status:
	const updates = file.match(/SET fee_status\s*=\s*'([a-z_]+)'/g) ?? [];
	for (const upd of updates) {
		const m = upd.match(/'([a-z_]+)'/);
		if (m) writtenViaSql.add(m[1]);
	}
}

// Union of both (since runtime can take either path).
const indexerWritten = new Set<string>([...writtenViaAssign, ...writtenViaSql]);

// ─── Step 2: parse feeStatusLabel cases ────────────────────────

const myOrdersSrc = readFileSync(MY_ORDERS_PAGE, 'utf-8');

// Find feeStatusLabel function body; extract `case 'X':` arms
// and check for a `default:` arm.
const fnRe = /function feeStatusLabel\([^)]*\)\s*:\s*string\s*{([\s\S]*?)\n\t}/;
const fnMatch = myOrdersSrc.match(fnRe);
const labelCases = new Set<string>();
let hasDefault = false;
let defaultIsEmpty = false;
let defaultBody = '';
if (fnMatch) {
	const body = fnMatch[1];
	for (const m of body.matchAll(/case\s+'([a-z_]+)'\s*:/g)) {
		labelCases.add(m[1]);
	}
	const defaultM = body.match(/default\s*:\s*([\s\S]*?)\n\t\t}/);
	if (defaultM) {
		hasDefault = true;
		defaultBody = defaultM[1].trim();
		// Empty-string fallback is the bug we're guarding against.
		// `return '';` (or the empty-string literal alone) means
		// any unmatched fee_status renders an empty pill.
		defaultIsEmpty =
			/return\s+''\s*;?/.test(defaultBody) && !/return\s+o\.fee_status/.test(defaultBody);
	}
}

// ─── Step 3: parse i18n keys referenced by feeStatusLabel ──────

const i18nRefRe = /\$_\(\s*'(my_orders\.order\.fee_[a-z_]+)'\s*\)/g;
const labelI18nKeys = new Set<string>();
if (fnMatch) {
	for (const m of fnMatch[1].matchAll(i18nRefRe)) {
		labelI18nKeys.add(m[1]);
	}
}

// ─── Step 4: parse order_detail fee_status branches ────────────

const orderDetailSrc = readFileSync(ORDER_DETAIL_PAGE, 'utf-8');
const detailCases = new Set<string>();
for (const m of orderDetailSrc.matchAll(/order\.fee_status\s*===\s*'([a-z_]+)'/g)) {
	detailCases.add(m[1]);
}
// order_detail must have an {:else} fallback after its branches.
const detailHasElse = /order_detail/.test(orderDetailSrc) // guard
	? /\{:else\}\s*<!--[\s\S]*?Future-proof[\s\S]*?-->\s*<span/.test(orderDetailSrc)
	: false;

// ─── Step 5: load en.json to verify referenced keys exist ──────

interface JsonObj {
	[k: string]: unknown;
}
const enJson = JSON.parse(readFileSync(EN_LOCALE, 'utf-8')) as JsonObj;
function getDeep(obj: unknown, path: string): unknown {
	let cur: unknown = obj;
	for (const seg of path.split('.')) {
		if (typeof cur !== 'object' || cur === null) return undefined;
		cur = (cur as JsonObj)[seg];
	}
	return cur;
}
const missingI18n: string[] = [];
for (const k of labelI18nKeys) {
	const v = getDeep(enJson, k);
	if (typeof v !== 'string' || v.trim() === '') missingI18n.push(k);
}

// ─── Step 5b: Finding #1 (cp391) — `unverified` is the DB column
// DEFAULT (order.ts always writes a definite status, so a row only
// reaches 'unverified' via the column default — a migration artifact
// or a future handler that forgets to set it). It is a NEUTRAL
// "not yet verified" state, NOT a rejection. order_detail already
// renders it neutral; my/orders must too — grouped with
// pending_external in the ink branch, never the red "fee rejected"
// catch-all (which links to faq#order_fee_rejected). ─────────────

const SCHEMA_SQL = join(REPO_ROOT, 'apps/indexer/src/db/schema.sql');
const schemaSrc = readFileSync(SCHEMA_SQL, 'utf-8');
const schemaDefaultsUnverified = /fee_status\s+TEXT\s+NOT\s+NULL\s+DEFAULT\s+'unverified'/.test(
	schemaSrc
);

// my/orders neutral (ink) branch must match BOTH pending_external
// and unverified, so unverified can never fall through to the red
// catch-all below it.
const unverifiedInNeutralBranch =
	/'pending_external'\s*\|\|\s*o\.fee_status\s*===\s*'unverified'/.test(myOrdersSrc);

// ─── Step 6: scenarios ─────────────────────────────────────────

const indexerWrittenList = [...indexerWritten].sort();
const labelCasesList = [...labelCases].sort();
const detailCasesList = [...detailCases].sort();

// Compute coverage gap: indexer values NOT in label cases.
const labelGap = indexerWrittenList.filter((v) => !labelCases.has(v));
const detailGap = indexerWrittenList.filter((v) => !detailCases.has(v));

const scenarios = [
	{
		name: 'indexer fee_status extraction found at least 4 distinct values',
		ok: indexerWritten.size >= 4
	},
	{
		name: 'indexer extraction includes the four core states',
		ok:
			indexerWritten.has('verified') &&
			indexerWritten.has('pending_external') &&
			indexerWritten.has('verified_by_attestation') &&
			indexerWritten.has('reused')
	},
	{
		name: 'indexer extraction includes missing + underpaid (the Part 103 bug)',
		ok: indexerWritten.has('missing') && indexerWritten.has('underpaid')
	},
	{
		name: 'feeStatusLabel function found and parsed',
		ok: !!fnMatch && labelCases.size >= 4
	},
	{
		name: 'every indexer-written value has an explicit case in feeStatusLabel',
		ok: labelGap.length === 0
	},
	{
		name: 'feeStatusLabel has a default: arm (defense-in-depth for unknown states)',
		ok: hasDefault
	},
	{
		name: 'feeStatusLabel default: returns the raw status, not the empty string',
		ok: hasDefault && !defaultIsEmpty
	},
	{
		name: 'every i18n key referenced by feeStatusLabel exists in en.json',
		ok: missingI18n.length === 0
	},
	{
		name: 'order_detail covers every indexer-written value with an explicit branch',
		ok: detailGap.length === 0
	},
	{
		name: 'order_detail has a future-proof {:else} fallback after its branches',
		ok: detailHasElse
	},
	{
		name: "Finding #1 — schema confirms 'unverified' is the fee_status column DEFAULT (so it is reachable + must be handled)",
		ok: schemaDefaultsUnverified
	},
	{
		name: "Finding #1 — feeStatusLabel has an explicit 'unverified' case (localized label, not the raw-string fallback)",
		ok: labelCases.has('unverified')
	},
	{
		name: "Finding #1 — my/orders renders 'unverified' in the NEUTRAL ink branch (grouped with pending_external), never the red 'fee rejected' catch-all",
		ok: unverifiedInNeutralBranch
	}
];

let passed = 0;
let failed = 0;
const failures: string[] = [];
for (const s of scenarios) {
	if (s.ok) {
		passed++;
	} else {
		failed++;
		failures.push(`  ✗ ${s.name}`);
	}
}

if (labelGap.length > 0) {
	console.log(
		`  feeStatusLabel missing cases for indexer-written values: ` + `${JSON.stringify(labelGap)}`
	);
}
if (detailGap.length > 0) {
	console.log(
		`  order_detail missing branches for indexer-written values: ` + `${JSON.stringify(detailGap)}`
	);
}
if (missingI18n.length > 0) {
	console.log(`  Missing i18n keys: ${JSON.stringify(missingI18n)}`);
}
if (defaultIsEmpty) {
	console.log(
		`  feeStatusLabel default returns ''; should return o.fee_status ?? '' ` +
			`so unknown states render as raw text rather than an empty pill.`
	);
}

if (failures.length > 0) {
	console.log('');
	console.log('  Indexer-written set (parsed):  ' + JSON.stringify(indexerWrittenList));
	console.log('  feeStatusLabel cases:          ' + JSON.stringify(labelCasesList));
	console.log('  order_detail branches:         ' + JSON.stringify(detailCasesList));
	console.log('');
	console.log(failures.join('\n'));
	console.log('');
}

console.log('────────────────────────────────────────────────────────');
if (failed === 0) {
	console.log(`✓ all ${passed} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed} of ${passed + failed} scenarios failed`);
	process.exit(1);
}
