#!/usr/bin/env tsx
/**
 * chat-pay-now-flow-smoke (cp402 [7]).
 *
 * Pins down the SAFETY-CRITICAL wiring of the chat "Pay now" flow —
 * this is where a trader initiates or records a real money transfer,
 * so the invariants below must never silently regress. Sentinel-grep
 * (same rationale as paired-readonly-affordance-surfaces-smoke): these
 * protections live in Svelte components that need the full runtime to
 * exercise, and a future refactor that drops one must be caught at
 * smoke time and force the maintainer to update this file in the same
 * commit.
 *
 * The invariants (each maps to a design decision in REVISIT cp402 #7):
 *
 *   ASSET LOCK — the composer "Pay now" locks the coin to the ORDER's
 *   asset so grandma can never send the wrong coin. FundsSentModal
 *   grows a `lockedMethod` that (a) initialises `method`, (b) makes
 *   `selectMethod` a no-op, and (c) replaces the 16-coin picker with a
 *   read-only "Paying with X" pill. ConversationView only locks to an
 *   asset that is actually in the registry (`isKnownChatAsset`).
 *
 *   REQUIRED AMOUNT — the composer flow requires a valid, strictly-
 *   positive amount (the order minimum is FIAT and the send field is
 *   CRYPTO, so there is no safe default; the field stays blank+required
 *   per Ken's answer). FundsSentModal's `amountRequired` folds a
 *   `Number(...) > 0` guard into `amountLooksValid`.
 *
 *   BLURT ROUTING — BLURT is broadcast by the app itself (no manual
 *   txid), so a BLURT order routes to PayBlurtModal with a validated
 *   in-modal amount (`amountEditable`); every other asset records an
 *   external payment (amount + txid) via FundsSentModal.
 *
 *   AMOUNT RECORDED = AMOUNT SENT — PayBlurtModal's `onPaid` returns
 *   the amount it actually broadcast (`effectiveAmount`), and
 *   handlePaidBlurt records THAT into both the on-chain funds-sent
 *   receipt and the trade-status entry. The pre-fix code recorded the
 *   staged `payBlurtArgs.amount`, which is a 0 placeholder in the
 *   composer flow — a real payment would have been logged as 0 BLURT.
 *   The `mustNotHave` sentinels below guard that exact regression.
 *
 *   PILL FLOW UNCHANGED — the address-pill pay path passes no
 *   `amountEditable` (defaults false) and PayBlurtModal then uses the
 *   pill-provided `amount` verbatim, exactly as before.
 *
 * Locale parity for the new keys is enforced by i18n-locale-parity-smoke.
 *
 * Usage:
 *   cd apps/web && npx tsx scripts/chat-pay-now-flow-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');

interface Scenario {
	readonly name: string;
	readonly file: string;
	/** Substrings that must ALL appear. */
	readonly mustHave: readonly string[];
	/** Substrings that must NOT appear (pre-fix regression sentinels). */
	readonly mustNotHave?: readonly string[];
}

const CONV = 'src/lib/components/ConversationView.svelte';
const FUNDS = 'src/lib/components/FundsSentModal.svelte';
const PAYB = 'src/lib/components/PayBlurtModal.svelte';

const SCENARIOS: readonly Scenario[] = [
	{
		name: '1 — composer Pay-now asset lock derives ONLY from a registry-known order asset',
		file: CONV,
		// cp406 — the case-folding registry lookup moved into chatAssetFromTicker
		// (in $lib/assets/registry): OrderRecord.asset is UPPERCASE ('BLURT'),
		// ChatAssetTicker is lower-case ('blurt'); the helper folds the case and
		// returns undefined for anything not in the registry.
		mustHave: [
			"import { chatAssetFromTicker, getAsset } from '$lib/assets/registry'",
			'const composerPayNowAsset = $derived(',
			'markSentArgs === null && orderRecord',
			'chatAssetFromTicker(orderRecord.asset) ?? undefined'
		]
	},
	{
		name: '2 — composer Pay-now routes BLURT → PayBlurtModal (editable amount), else → FundsSentModal',
		file: CONV,
		mustHave: [
			"if (composerPayNowAsset === 'blurt') {",
			'recipient: peer',
			'amountEditable: true',
			'} else {',
			'showFundsSentModal = true;'
		]
	},
	{
		name: '3 — FundsSentModal invocation locks the asset + requires the amount for the composer flow',
		file: CONV,
		mustHave: ['lockedMethod={composerPayNowAsset}', 'amountRequired={markSentArgs === null}']
	},
	{
		name: '4 — PayBlurtModal invocation threads the editable-amount flag (pill flow defaults false)',
		file: CONV,
		mustHave: ['amountEditable={payBlurtArgs.amountEditable ?? false}']
	},
	{
		name: '5 — handlePaidBlurt records the ACTUAL broadcast amount (args.amount), never the 0 placeholder',
		file: CONV,
		mustHave: [
			'args: {\n\t\ttrxId: string;\n\t\tblockNum: number;\n\t\tamount: number;\n\t}',
			'amount: args.amount,',
			'amount: String(args.amount),'
		],
		mustNotHave: [
			// Pre-fix bug: staged amount (0 in composer flow) into the
			// trade-status entry or the on-chain receipt.
			'amount: stagedArgs.amount',
			'String(stagedArgs.amount)'
		]
	},
	{
		name: '6 — FundsSentModal declares lockedMethod + amountRequired and computes methodLocked',
		file: FUNDS,
		mustHave: [
			'lockedMethod?: ChatAssetTicker;',
			'amountRequired?: boolean;',
			'const methodLocked = lockedMethod !== undefined && lockedMethod !== null;',
			'let method = $state<ChatAssetTicker>(lockedMethod ?? initialMethod);'
		]
	},
	{
		name: '7 — FundsSentModal: locked asset cannot be changed (selectMethod no-ops) + read-only pill replaces the picker',
		file: FUNDS,
		mustHave: [
			'if (methodLocked) return;',
			'{#if methodLocked}',
			"$_('chat.funds_sent.locked_method_label'",
			'{:else}',
			'role="tablist"'
		]
	},
	{
		name: '8 — FundsSentModal: required amount must be strictly positive (regex alone accepts 0)',
		file: FUNDS,
		mustHave: ['if (amountRequired) {', 'return wellFormed && Number(trimmedAmount) > 0;']
	},
	{
		name: '9 — PayBlurtModal: optional amount + editable mode drive a single effectiveAmount',
		file: PAYB,
		mustHave: [
			'amount?: number;',
			'amountEditable?: boolean;',
			// cp470 — enteredAmount is no longer empty-init; it pre-fills the
			// order-minimum seed (via untrack(() => … seedToInput(amount) …)) so
			// the field starts valid. Assert the state declaration + the pre-fill,
			// not the old empty string.
			'let enteredAmount = $state(',
			'seedToInput(amount)',
			'const effectiveAmount = $derived(amountEditable ? Number(enteredAmount.trim()) : amount);'
		]
	},
	{
		name: '10 — PayBlurtModal: the SAME canPay guard + broadcast use effectiveAmount, and onPaid returns it',
		file: PAYB,
		mustHave: [
			// tt.txt #12 — the inline `effectiveAmount > 0 &&` guard in canPay was
			// replaced by `amountValid`, which is STRICTER: a hard MIN_BLURT floor
			// plus `hasBlurtPrecision` (toFixed(3) rounds UP, so 1.0006 would have
			// broadcast 1.001 of someone else's money). Pin the real invariant.
			'const canPay = $derived(',
			'amountValid &&',
			'amount >= MIN_BLURT && hasBlurtPrecision(amount)',
			'Number.isFinite(effectiveAmount)',
			'formatBlurtAmount(Number.isFinite(effectiveAmount) && effectiveAmount > 0 ? effectiveAmount : 0)',
			'onPaid({ trxId: result.trx_id, blockNum: result.block_num, amount: effectiveAmount });',
			'{#if amountEditable}'
		],
		mustNotHave: [
			// Pre-fix: onPaid without the amount → parent can't know what
			// was actually sent in the composer flow.
			'blockNum: result.block_num });'
		]
	}
];

let failures = 0;
let scenarios = 0;

function check(s: Scenario): void {
	scenarios++;
	const path = join(REPO, s.file);
	let body: string;
	try {
		body = readFileSync(path, 'utf8');
	} catch (err) {
		failures++;
		console.log(`  ✗ ${s.name}`);
		console.log(`      could not read ${s.file}: ${err instanceof Error ? err.message : err}`);
		return;
	}
	const missing = s.mustHave.filter((m) => !body.includes(m));
	const regressed = (s.mustNotHave ?? []).filter((m) => body.includes(m));
	if (missing.length === 0 && regressed.length === 0) {
		console.log(`  ✓ ${s.name}`);
		return;
	}
	failures++;
	console.log(`  ✗ ${s.name}`);
	if (missing.length > 0) {
		console.log(`      missing sentinel(s):`);
		for (const m of missing) console.log(`        - ${JSON.stringify(m)}`);
	}
	if (regressed.length > 0) {
		console.log(`      regressed sentinel(s) (pre-fix pattern reappeared):`);
		for (const m of regressed) console.log(`        - ${JSON.stringify(m)}`);
	}
}

console.log('chat-pay-now-flow smoke:\n');
for (const s of SCENARIOS) check(s);

console.log(`\n${scenarios} scenarios, ${failures} failed`);
if (failures > 0) {
	console.error('chat-pay-now-flow-smoke FAILED');
	process.exit(1);
}
// Canonical success line — run-smokes.sh greps for `^✓ all` to tally.
console.log(`✓ all ${SCENARIOS.length} chat-pay-now-flow scenarios passed`);
