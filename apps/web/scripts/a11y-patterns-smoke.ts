#!/usr/bin/env tsx
/**
 * Smoke for the accessibility patterns established in
 * Memory #11 Category N (Part 100).
 *
 * Asserts structural invariants that svelte-check's
 * standard a11y rules don't catch:
 *
 *   - ConfirmModal exposes its title to screen readers via
 *     `aria-labelledby={titleId}` matching `<h2 id={titleId}>`.
 *   - Layout has a skip-link to `#main` and a `<main id="main">`
 *     target.
 *   - The /post success phase has aria-live so screen-reader
 *     users hear about successful broadcasts.
 *   - Form fields with validation errors have `aria-invalid` +
 *     `aria-describedby` wired to their StatusLine's id.
 *
 * Future regressions where someone refactors a confirm modal,
 * removes the skip-link, or drops aria-live on a status surface
 * will fail the smoke at CI time.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

const CONFIRM_MODAL = readFileSync(
	join(REPO_ROOT, 'apps/web/src/lib/components/ConfirmModal.svelte'),
	'utf8'
);
const LAYOUT = readFileSync(
	join(REPO_ROOT, 'apps/web/src/routes/+layout.svelte'),
	'utf8'
);
const POST = readFileSync(
	join(REPO_ROOT, 'apps/web/src/routes/post/+page.svelte'),
	'utf8'
);
const POST_EDIT = readFileSync(
	join(REPO_ROOT, 'apps/web/src/routes/post/edit/[permlink]/+page.svelte'),
	'utf8'
);
const STATUS_LINE = readFileSync(
	join(REPO_ROOT, 'apps/web/src/lib/components/StatusLine.svelte'),
	'utf8'
);
const PICKER = readFileSync(
	join(REPO_ROOT, 'apps/web/src/lib/components/PaymentMethodsPicker.svelte'),
	'utf8'
);

interface Scenario {
	readonly name: string;
	readonly ok: boolean;
}

const scenarios: readonly Scenario[] = [
	// ─── ConfirmModal ─────────────────────────────────────
	{
		name: 'ConfirmModal declares titleId',
		ok: /const titleId = `confirm-modal-title-/.test(CONFIRM_MODAL)
	},
	{
		name: 'ConfirmModal <dialog> has aria-labelledby',
		ok: /<dialog\b[\s\S]*?aria-labelledby=\{titleId\}/.test(CONFIRM_MODAL)
	},
	{
		name: 'ConfirmModal title <h2> has matching id',
		ok: /<h2 id=\{titleId\}/.test(CONFIRM_MODAL)
	},
	{
		name: 'ConfirmModal default-focuses Cancel button',
		ok: /cancelBtn\?\.focus\(\)/.test(CONFIRM_MODAL)
	},

	// ─── Skip link ─────────────────────────────────────────
	{
		name: 'Layout has skip-link to #main',
		ok: /href="#main"[\s\S]*?a11y\.skip_to_content/.test(LAYOUT)
	},
	{
		name: 'Layout has <main id="main">',
		ok: /<main\b[^>]*id="main"/.test(LAYOUT)
	},

	// ─── /post aria-live ──────────────────────────────────
	{
		name: '/post success phase has aria-live="polite" + role="status"',
		ok: /phase === 'success'[\s\S]{0,400}aria-live="polite"[\s\S]{0,200}role="status"/.test(POST) ||
			/phase === 'success'[\s\S]{0,400}role="status"[\s\S]{0,200}aria-live="polite"/.test(POST)
	},
	{
		name: '/post broadcasting phase has aria-live',
		ok: /phase === 'broadcasting'[\s\S]{0,400}aria-live="polite"/.test(POST)
	},
	{
		name: '/post error phase has role="alert" + aria-live="assertive"',
		ok: /phase === 'error'[\s\S]{0,500}role="alert"[\s\S]{0,200}aria-live="assertive"/.test(POST)
	},

	// ─── /post field validation aria ───────────────────────
	{
		name: '/post fiat input has aria-invalid wired to fiatError',
		ok: /bind:value=\{fiat\}[\s\S]{0,400}aria-invalid=\{!!fiatError\}/.test(POST)
	},
	{
		name: '/post fiat input has aria-describedby wired to fiat-error',
		ok: /bind:value=\{fiat\}[\s\S]{0,400}aria-describedby=\{fiatError\s*\?\s*'fiat-error'/.test(POST)
	},
	{
		name: '/post fiat StatusLine has id="fiat-error"',
		ok: /<StatusLine[^>]*id="fiat-error"[^>]*>\{fiatError\}/.test(POST)
	},
	{
		name: '/post amountMin input has aria-invalid',
		ok: /bind:value=\{amountMin\}[\s\S]{0,300}aria-invalid=\{!!amountError\}/.test(POST)
	},
	{
		name: '/post amountMax input has aria-invalid',
		ok: /bind:value=\{amountMax\}[\s\S]{0,300}aria-invalid=\{!!amountError\}/.test(POST)
	},
	{
		name: '/post amount StatusLine has id="amount-error"',
		ok: /<StatusLine[^>]*id="amount-error"[^>]*>\{amountError\}/.test(POST)
	},
	{
		name: '/post spread price input has aria-invalid',
		ok: /bind:value=\{spreadPercent\}[\s\S]{0,300}aria-invalid=\{!!priceModelError\}/.test(POST)
	},
	{
		name: '/post fixed price input has aria-invalid',
		ok: /bind:value=\{fixedPrice\}[\s\S]{0,300}aria-invalid=\{!!priceModelError\}/.test(POST)
	},
	{
		name: '/post payment-methods StatusLine has id',
		ok: /<StatusLine[^>]*id="payment-methods-error"[^>]*>\{paymentMethodsError\}/.test(POST)
	},

	// ─── /post/edit field validation aria ──────────────────
	{
		name: '/post/edit fiat input has aria-invalid',
		ok: /bind:value=\{fiat\}[\s\S]{0,300}aria-invalid=\{!!fiatError\}/.test(POST_EDIT)
	},
	{
		name: '/post/edit fiat StatusLine has id="edit-fiat-error"',
		ok: /<StatusLine[^>]*id="edit-fiat-error"[^>]*>\{fiatError\}/.test(POST_EDIT)
	},
	{
		name: '/post/edit amount inputs have aria-invalid',
		ok: /bind:value=\{amountMin\}[\s\S]{0,300}aria-invalid=\{!!amountError\}/.test(POST_EDIT) &&
			/bind:value=\{amountMax\}[\s\S]{0,300}aria-invalid=\{!!amountError\}/.test(POST_EDIT)
	},
	{
		name: '/post/edit amount StatusLine has id="edit-amount-error"',
		ok: /<StatusLine[^>]*id="edit-amount-error"[^>]*>\{amountError\}/.test(POST_EDIT)
	},
	{
		name: '/post/edit pm StatusLine has id="edit-pm-error"',
		ok: /<StatusLine[^>]*id="edit-pm-error"[^>]*>\{pmError\}/.test(POST_EDIT)
	},

	// ─── StatusLine component ──────────────────────────────
	{
		name: 'StatusLine accepts id prop for aria-describedby linking',
		ok: /id\?:\s*string/.test(STATUS_LINE) && /\{id\}/.test(STATUS_LINE)
	},
	{
		name: 'StatusLine emits aria-live polite for warn/idle/loading/ok',
		ok: /aria-live=\{ariaLive\}/.test(STATUS_LINE) &&
			/kind === 'error' \? 'assertive' : 'polite'/.test(STATUS_LINE)
	},

	// ─── Layout afterNavigate focus management (Part 102) ─
	{
		name: 'Layout imports afterNavigate from $app/navigation',
		ok: /import\s*\{[^}]*afterNavigate[^}]*\}\s*from\s*['"]\$app\/navigation['"]/.test(LAYOUT)
	},
	{
		name: 'Layout has afterNavigate hook that focuses mainEl',
		ok: /afterNavigate\s*\(\s*\(\s*nav\s*\)\s*=>[\s\S]{0,400}mainEl\?\.focus\(\)/.test(LAYOUT)
	},
	{
		name: 'Layout <main> has tabindex="-1" for programmatic focus',
		ok: /<main\b[^>]*tabindex="-1"/.test(LAYOUT)
	},
	{
		name: 'Layout <main> has bind:this={mainEl}',
		ok: /<main\b[^>]*bind:this=\{mainEl\}/.test(LAYOUT)
	},

	// ─── PaymentMethodsPicker aria props (Part 102) ────────
	{
		name: 'PaymentMethodsPicker accepts invalid + describedById props',
		ok: /invalid\?:\s*boolean/.test(PICKER) && /describedById\?:\s*string/.test(PICKER)
	},
	{
		name: 'PaymentMethodsPicker root has role="group" + aria-label',
		ok: /role="group"[\s\S]{0,200}aria-label/.test(PICKER)
	},
	{
		name: 'PaymentMethodsPicker search input wires aria-invalid conditionally',
		ok: /aria-invalid=\{invalid \|\| undefined\}/.test(PICKER)
	},
	{
		name: 'PaymentMethodsPicker search input wires aria-describedby conditionally',
		ok: /aria-describedby=\{invalid && describedById \? describedById : undefined\}/.test(PICKER)
	},
	{
		name: '/post passes invalid + describedById to PaymentMethodsPicker',
		ok: /<PaymentMethodsPicker\b[\s\S]{0,400}invalid=\{!!paymentMethodsError\}[\s\S]{0,200}describedById="payment-methods-error"/.test(POST)
	},
	{
		name: '/post/edit passes invalid + describedById to PaymentMethodsPicker',
		ok: /<PaymentMethodsPicker\b[\s\S]{0,400}invalid=\{!!pmError\}[\s\S]{0,200}describedById="edit-pm-error"/.test(POST_EDIT)
	}
];

console.log('');
console.log('── a11y patterns smoke ─────────────────────────────────');
console.log('');

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

if (failed > 0) {
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
