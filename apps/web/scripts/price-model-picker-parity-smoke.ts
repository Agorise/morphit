#!/usr/bin/env tsx
/**
 * price-model-picker-parity-smoke (Part 117).
 *
 * Sister smoke to `price-model-display-smoke`.  Where the display
 * smoke validates the read-side formatter (priceModelDisplay.ts +
 * its 4 i18n keys per locale), THIS smoke pins down the write-side
 * surfaces: both `/post` (the new-order screen) and
 * `/post/edit/[permlink]` (the edit screen) MUST carry the
 * split-state picker AND the validation logic AND the canonical
 * submission shape — so a future refactor cannot strip the picker
 * from one of them and ship an asymmetry.
 *
 * The risk being defended against:
 *
 *   Pre-Part-117, /post had the picker but /post/edit kept the
 *   loaded `price_model` opaque and passed it through unchanged.
 *   A user who wanted to change their pricing after posting had
 *   to cancel and re-list.  Part 117 closed the gap by mirroring
 *   /post's picker into /post/edit.  This smoke makes the
 *   asymmetry actively dangerous to re-introduce: any commit that
 *   removes the picker, the validation, or the canonical {kind,
 *   percent|price} reassembly from EITHER screen breaks the smoke
 *   and forces the maintainer to fix the parity before merge.
 *
 * Sentinel-grep is the right tool here, same rationale as
 * paired-readonly-affordance-surfaces-smoke + sally-walkthrough-
 * smoke: the picker is a fully-rendered Svelte fieldset whose
 * runtime exercise needs the SvelteKit harness, which is heavier
 * than this audit-trail check warrants.  The smoke pins the
 * structural sentinels (radio binding, picker derived error,
 * canonical reassembly at submit) so the next refactor can move
 * the picker into a shared component without losing the contract,
 * but cannot silently drop it.
 *
 * Coverage:
 *
 *   1. /post imports + state — PriceModelKind union + split state
 *      vars (priceModelKind, spreadPercent, fixedPrice).
 *   2. /post derived `priceModelError` exists and references the
 *      same five validation error keys defined in en.json
 *      (`spread_not_a_number`, `spread_out_of_range`,
 *      `fixed_price_required`, `fixed_price_invalid`,
 *      `fixed_price_too_large`).
 *   3. /post canonical reassembly — submit path builds
 *      `{ kind: 'spread', percent: Number(spreadPercent) || 0 }`
 *      OR `{ kind: 'fixed', price: Number(fixedPrice) }` and
 *      passes the result to `OrderFormInput.priceModel`.
 *   4. /post picker UI — fieldset with radio group bound to
 *      `priceModelKind`, conditional spread% input, conditional
 *      fixed-price input.
 *   5. /post/edit imports + state — same union + same split
 *      vars.
 *   6. /post/edit derived `priceModelError` — same logic, same
 *      five validation keys.
 *   7. /post/edit canonical reassembly — same shape, same
 *      submission contract.
 *   8. /post/edit load derives picker state from on-chain
 *      `price_model` defensively (handles 'spread', 'fixed',
 *      and unknown/legacy/missing shapes — three branches).
 *   9. /post/edit picker UI — same fieldset structure, with
 *      `edit-`-prefixed radio name + ARIA IDs so the two screens
 *      coexist if ever rendered side-by-side.
 *  10. /post/edit canSave derived gate includes priceModelError.
 *  11. priceModelDisplay.ts read-side formatter still recognizes
 *      both canonical shapes (sanity that the write/read contract
 *      hasn't drifted).
 *  12. All five validation keys exist in en.json
 *      (i18n-locale-parity-smoke enforces them across all 10
 *      locales; we just need to confirm they're in en here).
 *  13. /my/orders `relistOrder` derivation handles both canonical
 *      shapes (the third write-adjacent surface — relisting an
 *      expired order MUST carry the price model forward, not silently
 *      reset it to 'spread 0').
 *
 * Usage:
 *   cd apps/web && npx tsx scripts/price-model-picker-parity-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');

interface Scenario {
	readonly name: string;
	readonly file: string;
	/** Substrings that must ALL appear in the file. */
	readonly mustHave: readonly string[];
	/** Substrings that must NOT appear (regression sentinels).
	 *  Pre-fix patterns that the fix removed; if they reappear
	 *  the protection regressed. */
	readonly mustNotHave?: readonly string[];
}

const SCENARIOS: readonly Scenario[] = [
	{
		name: '1 — /post imports and split state (PriceModelKind union, three picker vars)',
		file: 'src/routes/post/+page.svelte',
		mustHave: [
			'PriceModelKind',
			'priceModelKind = $state',
			'spreadPercent = $state',
			'fixedPrice = $state'
		]
	},
	{
		name: '2 — /post priceModelError references all five validation keys',
		file: 'src/routes/post/+page.svelte',
		mustHave: [
			'priceModelError',
			"post_order.errors.spread_not_a_number",
			"post_order.errors.spread_out_of_range",
			"post_order.errors.fixed_price_required",
			"post_order.errors.fixed_price_invalid",
			"post_order.errors.fixed_price_too_large"
		]
	},
	{
		name: '3 — /post canonical reassembly: { kind: spread | fixed, percent | price }',
		file: 'src/routes/post/+page.svelte',
		mustHave: [
			"{ kind: 'spread', percent: Number(spreadPercent) || 0 }",
			"{ kind: 'fixed', price: Number(fixedPrice) }"
		]
	},
	{
		name: '4 — /post picker UI (radio group bound to priceModelKind, conditional inputs)',
		file: 'src/routes/post/+page.svelte',
		mustHave: [
			'name="price-model-kind"',
			'bind:group={priceModelKind}',
			"priceModelKind === 'spread'",
			"priceModelKind === 'fixed'",
			'price_model_legend',
			'price_model_spread_label',
			'price_model_fixed_label'
		]
	},
	{
		name: '5 — /post/edit imports and split state (PriceModelKind union, three picker vars)',
		file: 'src/routes/post/edit/[permlink]/+page.svelte',
		mustHave: [
			'PriceModelKind',
			'priceModelKind = $state',
			'spreadPercent = $state',
			'fixedPrice = $state'
		],
		mustNotHave: [
			// Pre-Part-117 sentinel: the page used to declare
			// `priceModel` as opaque state and pass it through
			// unchanged.  Reintroducing this single-state declaration
			// would mean the picker has been ripped out; fail
			// loudly.
			'let priceModel = $state<Record<string, unknown>>'
		]
	},
	{
		name: '6 — /post/edit priceModelError references all five validation keys',
		file: 'src/routes/post/edit/[permlink]/+page.svelte',
		mustHave: [
			'priceModelError',
			"post_order.errors.spread_not_a_number",
			"post_order.errors.spread_out_of_range",
			"post_order.errors.fixed_price_required",
			"post_order.errors.fixed_price_invalid",
			"post_order.errors.fixed_price_too_large"
		]
	},
	{
		name: '7 — /post/edit canonical reassembly mirrors /post submission shape',
		file: 'src/routes/post/edit/[permlink]/+page.svelte',
		mustHave: [
			"{ kind: 'spread', percent: Number(spreadPercent) || 0 }",
			"{ kind: 'fixed', price: Number(fixedPrice) }"
		]
	},
	{
		name: '8 — /post/edit load derives picker state defensively (spread, fixed, fallback)',
		file: 'src/routes/post/edit/[permlink]/+page.svelte',
		mustHave: [
			'order.price_model',
			"obj.kind === 'spread'",
			"obj.kind === 'fixed'",
			'typeof obj.percent',
			'typeof obj.price'
		]
	},
	{
		name: '9 — /post/edit picker UI (radio group with edit- prefix, conditional inputs)',
		file: 'src/routes/post/edit/[permlink]/+page.svelte',
		mustHave: [
			'name="edit-price-model-kind"',
			'bind:group={priceModelKind}',
			"priceModelKind === 'spread'",
			"priceModelKind === 'fixed'",
			'edit-price-model-error',
			'edit-fixed-price-error'
		]
	},
	{
		name: '10 — /post/edit canSave gate includes priceModelError',
		file: 'src/routes/post/edit/[permlink]/+page.svelte',
		mustHave: ['!priceModelError']
	},
	{
		name: '11 — priceModelDisplay read-side formatter recognizes both canonical shapes',
		file: 'src/lib/orders/priceModelDisplay.ts',
		mustHave: [
			"pm.kind === 'spread'",
			"pm.kind === 'fixed'",
			"typeof pm.percent === 'number'",
			"typeof pm.price === 'number'",
			'orderbook.price_model.spread_market',
			'orderbook.price_model.spread_pct',
			'orderbook.price_model.fixed',
			'orderbook.price_model.custom'
		]
	},
	{
		name: '12 — en.json carries all five validation keys (parity smoke fans out to 10 locales)',
		file: 'src/lib/i18n/locales/en.json',
		mustHave: [
			'"spread_not_a_number"',
			'"spread_out_of_range"',
			'"fixed_price_required"',
			'"fixed_price_invalid"',
			'"fixed_price_too_large"',
			'"price_model_legend"',
			'"price_model_hint"',
			'"price_model_spread_label"',
			'"price_model_fixed_label"'
		]
	},
	{
		name: '13 — /my/orders relistOrder derivation handles both canonical shapes',
		file: 'src/routes/my/orders/+page.svelte',
		mustHave: [
			'function relistOrder',
			"priceModelKind: 'spread' | 'fixed'",
			"obj.kind === 'spread'",
			"obj.kind === 'fixed'"
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
		for (const m of missing) console.log(`        - ${m}`);
	}
	if (regressed.length > 0) {
		console.log(`      regressed sentinel(s) (pre-fix pattern reappeared):`);
		for (const m of regressed) console.log(`        - ${m}`);
	}
}

console.log('price-model-picker-parity smoke:\n');
for (const s of SCENARIOS) check(s);

console.log(`\n${scenarios} scenarios, ${failures} failed`);
if (failures > 0) {
	console.error('price-model-picker-parity-smoke FAILED');
	process.exit(1);
}
// Canonical success line — run-smokes.sh greps for `^✓ all` to tally
// scenarios.  J-2 finding from Part 87.
console.log(`✓ all ${SCENARIOS.length} price-model-picker-parity scenarios passed`);
