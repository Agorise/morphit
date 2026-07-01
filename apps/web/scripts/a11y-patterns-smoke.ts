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
	join(REPO_ROOT, 'apps/web/src/routes/[lang]/+layout.svelte'),
	'utf8'
);
const POST = readFileSync(
	join(REPO_ROOT, 'apps/web/src/routes/[lang]/post/+page.svelte'),
	'utf8'
);
const POST_EDIT = readFileSync(
	join(REPO_ROOT, 'apps/web/src/routes/[lang]/post/edit/[permlink]/+page.svelte'),
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
const FIAT_SELECT = readFileSync(
	join(REPO_ROOT, 'apps/web/src/lib/components/FiatCurrencySelect.svelte'),
	'utf8'
);
const PROTECTED_TEXTAREA = readFileSync(
	join(REPO_ROOT, 'apps/web/src/lib/components/ProtectedTextarea.svelte'),
	'utf8'
);
const CHAT_COMPOSER = readFileSync(
	join(REPO_ROOT, 'apps/web/src/lib/components/ChatComposer.svelte'),
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
	// The fiat field is a FiatCurrencySelect combobox (cp295): the page
	// passes invalid/describedById, and the component forwards them to its
	// <input role="combobox"> as aria-invalid / aria-describedby — the same
	// error association the old native input had. Both legs are checked.
	{
		name: '/post fiat combobox has aria-invalid wired to fiatError',
		ok:
			/<FiatCurrencySelect[\s\S]{0,200}invalid=\{!!fiatError\}/.test(POST) &&
			/aria-invalid=\{invalid/.test(FIAT_SELECT)
	},
	{
		name: '/post fiat combobox has aria-describedby wired to fiat-error',
		ok:
			/<FiatCurrencySelect[\s\S]{0,200}describedById=\{fiatError\s*\?\s*'fiat-error'/.test(POST) &&
			/aria-describedby=\{describedById\}/.test(FIAT_SELECT)
	},
	{
		name: '/post fiat StatusLine has id="fiat-error"',
		ok: /<StatusLine[^>]*id="fiat-error"[^>]*>\{fiatError\}/.test(POST)
	},
	// NB /post's amount + price inputs are one-way `value={…}` +
	// `oninput` (cp360: the decimal sanitiser keepDecimal/keepSignedDecimal
	// can't run cleanly through a two-way bind), so these match `value={…}`
	// not `bind:value={…}`.  /post/edit (below) still uses bind:value.
	// cp368 split the shared `amountError` into per-field `amountMinHasError`
	// / `amountMaxHasError` and gated the red on `amountTouched` /
	// `fixedPriceTouched` (premature-red fix).  The a11y requirement is that
	// each input still carries an aria-invalid wired to the field's OWN error
	// state — these matchers assert that, tolerant of the touched-gate prefix.
	{
		name: '/post amountMin input has aria-invalid (per-field, touch-gated)',
		ok: /value=\{amountMin\}[\s\S]{0,300}aria-invalid=\{[^}]*amountMinHasError[^}]*\}/.test(POST)
	},
	{
		name: '/post amountMax input has aria-invalid (per-field, touch-gated)',
		ok: /value=\{amountMax\}[\s\S]{0,300}aria-invalid=\{[^}]*amountMaxHasError[^}]*\}/.test(POST)
	},
	{
		name: '/post amount StatusLine has id="amount-error"',
		ok: /<StatusLine[^>]*id="amount-error"[^>]*>\{amountError\}/.test(POST)
	},
	{
		name: '/post spread price input has aria-invalid',
		ok: /value=\{spreadPercent\}[\s\S]{0,300}aria-invalid=\{[^}]*priceModelError[^}]*\}/.test(POST)
	},
	{
		name: '/post fixed price input has aria-invalid (touch-gated)',
		ok: /value=\{fixedPrice\}[\s\S]{0,300}aria-invalid=\{[^}]*priceModelError[^}]*\}/.test(POST)
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
		ok: /value=\{amountMin\}[\s\S]{0,300}aria-invalid=\{!!amountError\}/.test(POST_EDIT) &&
			/value=\{amountMax\}[\s\S]{0,300}aria-invalid=\{!!amountError\}/.test(POST_EDIT)
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
		ok: /afterNavigate\s*\(\s*\(\s*nav\s*\)\s*=>[\s\S]{0,1100}mainEl\?\.focus\(/.test(LAYOUT)
	},
	{
		// cp305 — the focus MUST be { preventScroll: true }. A plain
		// .focus() scrolls <main> into view, and with the sticky top-0
		// header that tucks the page's top heading under the header on
		// every client-side navigation. Guarding so the scroll bug
		// can't silently return.
		name: 'Layout afterNavigate focus uses { preventScroll: true }',
		ok: /mainEl\?\.focus\(\s*\{[^}]*preventScroll\s*:\s*true[^}]*\}\s*\)/.test(LAYOUT)
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
		ok: /aria-invalid=\{invalid \|\| noMatch \|\| undefined\}/.test(PICKER)
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
	},
	// ─── Form-field id/name (cp371 — clears the "a form field should
	//     have an id or name attribute" autofill warning Ken flagged;
	//     completes the cp369 form-id/name pass) ──────────────────
	{
		name: 'PaymentMethodsPicker search input carries a name',
		ok: PICKER.includes('name="payment-methods-search"')
	},
	{
		name: 'PaymentMethodsPicker decorative checkboxes carry a per-entry name',
		ok: PICKER.includes('name={`pm-${entry.key}`}')
	},
	{
		name: 'ProtectedTextarea exposes a name prop and forwards it to <textarea>',
		ok: PROTECTED_TEXTAREA.includes('name?: string;') && PROTECTED_TEXTAREA.includes('{name}')
	},
	{
		name: '/post + /post/edit give the terms ProtectedTextarea a name',
		ok: POST.includes('name="order-terms"') && POST_EDIT.includes('name="order-terms"')
	},
	{
		name: 'ChatComposer gives its ProtectedTextarea a name',
		ok: CHAT_COMPOSER.includes('name="chat-message"')
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
