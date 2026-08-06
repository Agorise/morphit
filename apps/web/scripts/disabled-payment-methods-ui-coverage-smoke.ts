#!/usr/bin/env tsx
/**
 * Smoke: the disabled_payment_methods operator feature is wired into
 * EVERY web surface, end-to-end.
 *
 * cp208 added `disabled_payment_methods` (the payment-method analogue
 * of `disabled_assets`): an operator turns off canonical payment
 * methods via MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS; the indexer
 * gate (covered by order-handler-smoke + disabled-payment-methods-
 * parse-smoke) refuses an order only when EVERY method on it is
 * disabled.  The WEB side has no other coverage, so this sentinel
 * pins the five surfaces that must honour the operator's stance:
 *
 *   1. PaymentMethodsPicker (post-order) reads the store value and
 *      filters BOTH the flat search list AND the grouped category
 *      view — a disabled method must not be selectable when posting.
 *   2. PaymentFilterSelect (orderbook filter) accepts a `disabled`
 *      prop and filters its options on it.
 *   3. The orderbook route passes $instance.disabled_payment_methods
 *      into PaymentFilterSelect (without the wire, the prop defaults
 *      to [] and disabled methods reappear in the filter).
 *   4. /about-this-instance surfaces the operator's disabled-method
 *      stance read-only (parity with the asset-stance panel).
 *   5. /admin/setup-wizard hydrates from the store AND emits the
 *      MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS env line.
 *
 * Tamper test: dropping the `.filter(... disabled ...)` in either
 * component, or removing the orderbook prop wire, or deleting either
 * surfacing, fires this smoke.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

const PICKER = join(REPO_ROOT, 'apps/web/src/lib/components/PaymentMethodsPicker.svelte');
const FILTER = join(REPO_ROOT, 'apps/web/src/lib/components/PaymentFilterSelect.svelte');
const ORDERBOOK = join(REPO_ROOT, 'apps/web/src/routes/[lang]/orderbook/+page.svelte');
const ABOUT = join(REPO_ROOT, 'apps/web/src/routes/[lang]/about-this-instance/+page.svelte');
const WIZARD = join(REPO_ROOT, 'apps/web/src/routes/[lang]/admin/setup-wizard/+page.svelte');

let passes = 0;
let failures = 0;
function check(file: string, label: string, needles: string[]): void {
	const src = readFileSync(file, 'utf8');
	const missing = needles.filter((n) => !src.includes(n));
	if (missing.length === 0) {
		passes += 1;
		console.log(`  ✓ ${label}`);
	} else {
		failures += 1;
		console.error(`  ✗ ${label} — missing: ${missing.map((m) => JSON.stringify(m)).join(', ')}`);
	}
}

console.log('disabled-payment-methods-ui-coverage-smoke\n');

// 1 — PaymentMethodsPicker: reads the store + filters BOTH views.
check(PICKER, 'PaymentMethodsPicker reads disabled_payment_methods and filters list + grouped views', [
	'disabled_payment_methods',
	'!disabledMethods.includes'
]);

// 2 — PaymentFilterSelect: `disabled` prop + filters on it.
check(FILTER, 'PaymentFilterSelect accepts a `disabled` prop and filters options on it', [
	'disabled',
	'!disabled.includes'
]);

// 3 — orderbook route wires the store value into the filter.
check(ORDERBOOK, 'orderbook route passes $instance.disabled_payment_methods into PaymentFilterSelect', [
	'disabled={$instance.disabled_payment_methods}'
]);

// 4 — /about-this-instance surfaces the stance read-only.
check(ABOUT, '/about-this-instance surfaces disabled_payment_methods (payment-stance panel)', [
	'disabled_payment_methods',
	'about_this_instance.section.payment_stance'
]);

// 5 — /admin/setup-wizard hydrates from the store + emits the env line.
check(WIZARD, '/admin/setup-wizard hydrates disabled_payment_methods and emits the env line', [
	'disabled_payment_methods',
	'MORPHIT_INDEXER_DISABLED_PAYMENT_METHODS'
]);

console.log(`\n${passes} passed, ${failures} failed`);
if (failures === 0) console.log(`✓ all ${passes} scenarios passed`);
process.exit(failures > 0 ? 1 : 0);
