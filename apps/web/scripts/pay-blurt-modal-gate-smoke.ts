/**
 * pay-blurt-modal-gate-smoke — guards PayBlurtModal's composer ("Pay now")
 * flow against the cp470 regressions.
 *
 * The bug: the confirm summary (which CONTAINS the password field and the
 * posting-only UnlockActiveKeyModal) was gated on `canPay`, and `canPay`
 * requires `passwordFilled` + `hasActiveKey`.  That is circular — the field
 * used to enter the password sat behind a gate that required the password
 * already filled, and the posting-only unlock branch was unreachable.  On
 * top of that the amount field started empty rather than pre-filled to the
 * order minimum, so the amount was invalid and no Send button ever showed.
 *
 * This guard asserts the summary is gated on a password-independent
 * `amountReady`, that `amountReady` is NOT circular, that `canPay` still
 * fully gates the Pay button, that the amount is pre-filled, that the order
 * minimum is enforced, and that the field is numeric-only with a red-border
 * invalid state.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODAL = join(
	dirname(fileURLToPath(import.meta.url)),
	'..',
	'src/lib/components/PayBlurtModal.svelte'
);

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
		console.log(`      ${String((err as Error)?.message ?? err)}`);
	}
}
function assert(cond: boolean, msg: string): void {
	if (!cond) throw new Error(msg);
}

function stripComments(s: string): string {
	return s
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1')
		.replace(/<!--[\s\S]*?-->/g, '');
}

const src = stripComments(readFileSync(MODAL, 'utf8'));

/** Extract a `const NAME = $derived(...)` (or $derived.by) block body. */
function derivedBody(name: string): string {
	const m = src.match(new RegExp(`const ${name}\\s*=\\s*\\$derived(?:\\.by)?\\(([\\s\\S]*?)\\);`));
	if (!m) throw new Error(`could not find derived \`${name}\``);
	return m[1];
}

// ── The summary gate is amountReady, not the circular canPay ──────────
scenario('summary is gated on !amountReady (not !canPay)', () => {
	assert(src.includes('{#if !amountReady}'), 'summary gate is not `{#if !amountReady}`');
	assert(!src.includes('{#if !canPay}'), 'circular `{#if !canPay}` summary gate is back');
});

// ── amountReady must NOT depend on the password or the active key ──────
scenario('amountReady is password/active-key-independent (not circular)', () => {
	const body = derivedBody('amountReady');
	assert(!/passwordFilled/.test(body), 'amountReady references passwordFilled — circular gate');
	assert(!/hasActiveKey/.test(body), 'amountReady references hasActiveKey — posting-only locked out');
	assert(/amountValid/.test(body), 'amountReady should require amountValid');
});

// ── canPay still fully gates the Pay button ───────────────────────────
scenario('canPay still requires password AND active key AND valid amount', () => {
	const body = derivedBody('canPay');
	assert(/passwordFilled/.test(body), 'canPay dropped the passwordFilled gate');
	assert(/hasActiveKey/.test(body), 'canPay dropped the hasActiveKey gate');
	assert(/amountValid/.test(body), 'canPay dropped the amountValid gate');
});
scenario('Pay button is disabled={!canPay ...}', () => {
	assert(/disabled=\{!canPay/.test(src), 'Send button is no longer gated on canPay');
});

// ── The posting-only unlock branch is present (now reachable) ─────────
scenario('posting-only path renders UnlockActiveKeyModal when !hasActiveKey', () => {
	assert(/\{:else if !hasActiveKey\}/.test(src), 'missing the !hasActiveKey branch');
	assert(/<UnlockActiveKeyModal/.test(src), 'UnlockActiveKeyModal is not rendered');
	assert(/canProceed=\{amountValid\}/.test(src), 'unlock CTA is not gated on amountValid');
});

// ── Amount is pre-filled from the order-minimum seed ──────────────────
scenario('amount field is pre-filled from the seed (order minimum)', () => {
	assert(/seedToInput\(amount\)/.test(src), 'enteredAmount is not seeded from `amount`');
	assert(/let enteredAmount = \$state\(/.test(src), 'enteredAmount init not found');
});

// ── Order-minimum floor is enforced ───────────────────────────────────
scenario('entered amount is floored at the order minimum', () => {
	assert(/orderMinBlurt/.test(src), 'no orderMinBlurt floor');
	assert(/aboveOrderMin/.test(src), 'no aboveOrderMin check');
	const av = derivedBody('amountValid');
	assert(/aboveOrderMin/.test(av), 'amountValid does not enforce the order minimum');
});

// ── Numeric-only input + red border on invalid ────────────────────────
scenario('amount input is numeric-only with a red-border invalid state', () => {
	assert(/oninput=\{sanitizeAmount\}/.test(src), 'amount input has no sanitizeAmount handler');
	assert(/amountFieldInvalid/.test(src), 'no amountFieldInvalid red-border flag');
	assert(/border-red-500/.test(src), 'no red border class on the amount field');
});

if (failures === 0) {
	console.log(`✓ all ${scenarios} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} of ${scenarios} pay-blurt-modal-gate checks FAILED`);
	process.exit(1);
}
