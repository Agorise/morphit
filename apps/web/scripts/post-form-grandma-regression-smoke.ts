#!/usr/bin/env tsx
/**
 * post-form-grandma-regression-smoke (cp360).
 *
 * Pins the grandma-friendly overhaul of the new-order screen
 * (/post) so a later refactor cannot silently undo any of the
 * behaviour fixes Ken reported.  Source-structural: it scans the
 * +page.svelte source for sentinels that MUST be present and
 * anti-patterns that MUST be absent.  Two of these guard reported
 * bugs:
 *
 *   1. Draft-restore banner on a pristine first-trade form.
 *      `draftHasContent` must NOT count side/asset — the
 *      first-trade lock force-sets side='buy'/asset='BLURT'
 *      without the user typing anything, so counting them made a
 *      pristine first-trade form announce a restored draft.  The
 *      meaningful-content check is the fields the user fills in.
 *
 *   2. "Enter a flat price." error leaking into market mode.
 *      `priceModelError` must be a `$derived` (recomputes per
 *      kind, never a stale mutable `let`), and each per-kind error
 *      StatusLine must sit INSIDE its own `priceModelKind === …`
 *      block so it cannot render under the other kind.
 *
 * The rest lock the new grandma surfaces: the live summary card's
 * locale-aware disjunction list, the numeric-only/sanitised amount
 * + price inputs, and the first-trade subtitle/heading conditionals.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const POST_PAGE = join(
	__dirname,
	'..',
	'src',
	'routes',
	'[lang]',
	'post',
	'+page.svelte'
);

const src = readFileSync(POST_PAGE, 'utf8');

interface Scenario {
	readonly name: string;
	/** Returns null when the invariant holds, else a failure reason. */
	readonly check: () => string | null;
}

/** Extract the body of a top-level `function NAME(...) {...}` from the
 *  <script>.  Non-greedy to the first line that closes at one tab. */
function functionBody(name: string): string | null {
	const re = new RegExp(
		`function ${name}\\([^)]*\\)(?::[^\\{]*)?\\{([\\s\\S]*?)\\n\\t\\}`,
		'm'
	);
	const m = src.match(re);
	return m ? m[1] : null;
}

const SCENARIOS: Scenario[] = [
	{
		name: 'draftHasContent does NOT count side/asset (pristine first-trade form must not trigger restore banner)',
		check: () => {
			const body = functionBody('draftHasContent');
			if (body === null) return 'draftHasContent function not found';
			if (/\bd\.side\b/.test(body)) return 'd.side is still counted as content';
			if (/\bd\.asset\b/.test(body)) return 'd.asset is still counted as content';
			return null;
		}
	},
	{
		name: 'draftHasContent counts the real user-entered fields',
		check: () => {
			const body = functionBody('draftHasContent');
			if (body === null) return 'draftHasContent function not found';
			for (const f of ['d.fiat', 'd.amountMin', 'd.amountMax', 'd.paymentMethods', 'd.terms']) {
				if (!body.includes(f)) return `missing content field: ${f}`;
			}
			return null;
		}
	},
	{
		name: 'priceModelError is a $derived (recomputes per kind, never a stale mutable let)',
		check: () => {
			if (!/const priceModelError = \$derived/.test(src))
				return 'priceModelError is not declared as a $derived';
			if (/\blet priceModelError\b/.test(src))
				return 'priceModelError is a mutable let — can go stale across kind switches';
			return null;
		}
	},
	{
		name: 'fixed-price error StatusLine is gated inside the fixed-kind block',
		check: () => {
			const guard = src.indexOf("priceModelKind === 'fixed'");
			const err = src.indexOf('id="fixed-price-error"');
			if (guard < 0) return "no `priceModelKind === 'fixed'` guard found";
			if (err < 0) return 'no fixed-price-error StatusLine found';
			if (guard > err) return 'fixed-price-error renders before/outside its kind guard';
			return null;
		}
	},
	{
		name: 'spread error StatusLine is gated inside the spread-kind block',
		check: () => {
			const guard = src.indexOf("priceModelKind === 'spread'");
			const err = src.indexOf('id="price-model-error"');
			if (guard < 0) return "no `priceModelKind === 'spread'` guard found";
			if (err < 0) return 'no spread (price-model) error StatusLine found';
			if (guard > err) return 'spread error renders before/outside its kind guard';
			return null;
		}
	},
	{
		name: 'live summary card joins payment methods with a locale-aware disjunction list',
		check: () => {
			if (!/Intl\.ListFormat\(currentLang/.test(src))
				return 'summary does not use Intl.ListFormat(currentLang, …)';
			if (!/type: 'disjunction'/.test(src)) return "ListFormat is not type 'disjunction' (Oxford-or)";
			if (!/displayNamesForMethods/.test(src))
				return 'summary does not resolve names via displayNamesForMethods (picker parity)';
			if (!/post_order\.summary\.sentence_buy/.test(src))
				return 'summary buy template key not referenced';
			if (!/post_order\.summary\.sentence_sell/.test(src))
				return 'summary sell template key not referenced';
			return null;
		}
	},
	{
		name: 'amount + price inputs are numeric-only (sanitised) with a decimal keypad',
		check: () => {
			if (!/function keepDecimal\b/.test(src)) return 'keepDecimal sanitiser missing';
			if (!/function keepSignedDecimal\b/.test(src)) return 'keepSignedDecimal sanitiser missing';
			if (!/inputmode="decimal"/.test(src)) return 'no inputmode="decimal" on the number fields';
			// The four sanitised fields each wire oninput through a keeper.
			const keepCalls = (src.match(/keepDecimal\(e\.currentTarget\.value\)/g) ?? []).length;
			const signedCalls = (src.match(/keepSignedDecimal\(e\.currentTarget\.value\)/g) ?? []).length;
			if (keepCalls < 3)
				return `expected ≥3 keepDecimal-wired inputs (min/max/fixed), found ${keepCalls}`;
			if (signedCalls < 1) return `expected the spread field wired through keepSignedDecimal`;
			return null;
		}
	},
	{
		name: 'amount labels swap to the in-fiat variant when a fiat is chosen',
		check: () => {
			if (!/post_order\.form\.amount_min_label_in_fiat/.test(src))
				return 'amount_min_label_in_fiat not referenced';
			if (!/post_order\.form\.amount_max_label_in_fiat/.test(src))
				return 'amount_max_label_in_fiat not referenced';
			return null;
		}
	},
	{
		name: 'subtitle is hidden and the heading changes for first-time traders',
		check: () => {
			if (!/\{#if !isFirstTrade\}/.test(src))
				return 'subtitle is not wrapped in {#if !isFirstTrade}';
			if (!/post_order\.form\.step_1_heading_first/.test(src))
				return 'first-trade step-1 heading key not referenced';
			return null;
		}
	}
];

console.log('── post-form-grandma-regression smoke ──────────────────\n');
let failures = 0;
for (const s of SCENARIOS) {
	const reason = s.check();
	if (reason === null) {
		console.log(`  ✓ ${s.name}`);
	} else {
		failures++;
		console.log(`  ✗ ${s.name}`);
		console.log(`      ${reason}`);
	}
}
console.log('\n────────────────────────────────────────────────────────');

if (failures > 0) {
	console.error(`post-form-grandma-regression-smoke FAILED (${failures})`);
	process.exit(1);
}
// Canonical success line — run-smokes.sh greps for `^✓ all` to tally.
console.log(`✓ all ${SCENARIOS.length} post-form-grandma-regression scenarios passed`);
