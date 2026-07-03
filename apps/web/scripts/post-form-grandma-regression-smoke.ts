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

const STARTER_PACK = join(
	__dirname,
	'..',
	'src',
	'lib',
	'components',
	'FirstPostStarterPack.svelte'
);
const starterSrc = readFileSync(STARTER_PACK, 'utf8');

// cp368: also read the en locale so we can assert the waiver-benefit
// `_with_fiat` keys actually exist — when they were missing, svelte-i18n
// rendered the raw key path ("post_order.waiver_benefits.tier_1")
// straight into the "What your buy unlocks" box.
const EN_JSON = join(__dirname, '..', 'src', 'lib', 'i18n', 'locales', 'en.json');
const enLocale = JSON.parse(readFileSync(EN_JSON, 'utf8')) as Record<string, unknown>;
function enKey(path: string): unknown {
	return path
		.split('.')
		.reduce<unknown>(
			(o, k) => (o && typeof o === 'object' ? (o as Record<string, unknown>)[k] : undefined),
			enLocale
		);
}

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
			// cp406 — the subtitle is now also phase-gated (editing/reviewing
			// only), but the grandma-friendly `!isFirstTrade` guard remains.
			if (!/\{#if !isFirstTrade\b/.test(src))
				return 'subtitle is not gated on !isFirstTrade';
			if (!/post_order\.form\.step_1_heading_first/.test(src))
				return 'first-trade step-1 heading key not referenced';
			return null;
		}
	},
	{
		// cp364 Ken-reported: a first-time trader saw the asset card but
		// NOTHING below it (no Step 2, no nav). Root: Step 2 is gated
		// `{#if step1Done}` (needs side!==null && asset!==null), but the
		// only thing forcing side='buy'/asset='BLURT' was a post-render
		// $effect that lands a flush AFTER the template reads step1Done off
		// the just-resolved isFirstTrade. The fix forces the shape
		// SYNCHRONOUSLY in the checkWaiverEligibility resolution handler,
		// the same tick isFirstTrade flips, so step1Done is consistent and
		// the submitted order carries the right shape (not just the gate).
		name: 'eligibility resolution force-sets side=buy/asset=BLURT in the same tick (not only via the post-render lock effect)',
		check: () => {
			// Grab the checkWaiverEligibility(...).then(...) handler body.
			const m = src.match(
				/checkWaiverEligibility\([\s\S]*?\.then\(\(r\)\s*=>\s*\{([\s\S]*?)\n\t\t\t\t\}\)/
			);
			if (m === null) return 'checkWaiverEligibility(...).then handler not found';
			const body = m[1];
			if (!/waiverEligibility\s*=\s*r/.test(body))
				return 'handler does not assign waiverEligibility = r';
			if (!/eligible_unknown_account/.test(body))
				return 'handler does not branch on the eligible kinds';
			if (!/side\s*=\s*'buy'/.test(body))
				return "handler does not force side = 'buy' on eligibility (step1Done could stay false)";
			if (!/asset\s*=\s*'BLURT'/.test(body))
				return "handler does not force asset = 'BLURT' on eligibility";
			return null;
		}
	},
	{
		// cp364 (root cause of the vanishing form, found via Ken's console
		// `…trim is not a function`): a stale/old-schema restored draft could
		// put a NON-STRING into fiatArr/amounts, and a downstream `.trim()`
		// (step2Done reads fiat.trim() the instant step1Done flips) threw an
		// uncaught TypeError that aborted the render flush → form blank below
		// Step 1. applyDraft must coerce, and the `fiat` derived must guard.
		name: 'restored-draft fields are type-coerced so .trim() can never throw',
		check: () => {
			const body = functionBody('applyDraft');
			if (body === null) return 'applyDraft function not found';
			if (/fiatArr\s*=\s*d\.fiat\s*\?\s*\[d\.fiat\]/.test(body))
				return 'applyDraft still passes d.fiat through unchecked (non-string would reach .trim())';
			if (!/typeof\s+v\s*===\s*'string'/.test(body) && !/str\(/.test(body))
				return 'applyDraft does not string-coerce its fields';
			if (!/str\(d\.amountMin\)/.test(body) || !/str\(d\.amountMax\)/.test(body))
				return 'applyDraft does not coerce the amount fields';
			if (!/const fiat = \$derived\(typeof fiatArr\[0\] === 'string'/.test(src))
				return 'fiat derived does not guard typeof string (a non-string fiatArr[0] could still throw)';
			return null;
		}
	},
	{
		// cp364 Ken-reported: the "Your first order? Some safer defaults"
		// starter-pack card must RE-APPEAR on a later /post visit if the
		// user still hasn't placed their first order. The X is a per-VIEW
		// "not now", never a persisted dismissal — so dismiss() must NOT
		// touch sessionStorage/localStorage, and onMount must not consult a
		// stored "dismissed" flag (the zero-orders check is the real
		// stop-showing signal).
		name: 'FirstPostStarterPack dismiss is in-memory only (re-appears on return visits until first order)',
		check: () => {
			if (/sessionStorage|localStorage/.test(starterSrc))
				return 'starter-pack still touches web storage — dismissal would persist and not re-appear';
			if (/readDismissed|writeDismissed|DISMISSED_KEY/.test(starterSrc))
				return 'starter-pack still has persisted-dismissal plumbing (readDismissed/writeDismissed/DISMISSED_KEY)';
			const dm = starterSrc.match(/function dismiss\(\)\s*:\s*void\s*\{([\s\S]*?)\n\t\}/);
			if (dm === null) return 'dismiss() not found';
			if (!/visible\s*=\s*false/.test(dm[1]))
				return 'dismiss() does not set visible = false';
			// The zero-orders gate must remain the real visibility signal.
			if (!/getOrdersByAccount/.test(starterSrc))
				return 'starter-pack no longer gates on the zero-orders check';
			return null;
		}
	},
	{
		// cp365 Ken-reported: the "Read the full first-trade walkthrough ⇨"
		// link must turn the TEXT emerald on hover, not just the arrow.
		// In dark mode the link defaults to white (`dark:text-white`), which
		// out-specifies a plain `hover:text-morphit-emerald`, so the combined
		// `dark:hover:` variant is required for the text to flip (the arrow
		// already turns emerald via the .nav-arrow CSS, so without this the
		// line went two-tone on hover — green arrow, white text).
		name: 'walkthrough link text turns emerald on hover in dark mode (not just the arrow)',
		check: () => {
			const m = starterSrc.match(/first_post_starter\.faq_link[\s\S]{0,200}/);
			// The faq_link anchor carries the hover classes just above the key.
			const anchor = starterSrc.match(/<a[\s\S]*?first_post_starter\.faq_link/);
			const cls = anchor ? anchor[0] : '';
			if (!/hover:text-morphit-emerald/.test(cls))
				return 'walkthrough link missing light-mode hover:text-morphit-emerald';
			if (!/dark:hover:text-morphit-emerald/.test(cls))
				return 'walkthrough link missing dark:hover:text-morphit-emerald — text stays white on hover in dark mode';
			if (m === null) return 'first_post_starter.faq_link not found';
			return null;
		}
	},
	// ─── cp368/cp369/cp372: first-trade /post screen ───
	{
		name: 'waiver floor is the $1 USD-equivalent (FX-aware, fiat→USD), not a 500-BLURT constant (cp369 reverses §F.11; cp372 makes it multi-currency)',
		check: () => {
			if (!/const WAIVER_MIN_FIAT_USD = FIRST_ORDER_MIN_USD\b/.test(src))
				return 'floor is not wired to canonical FIRST_ORDER_MIN_USD';
			if (
				!/import\s*\{[^}]*\bFIRST_ORDER_MIN_USD\b[^}]*\}\s*from\s*'@morphit\/asset-registry'/.test(
					src
				)
			)
				return 'FIRST_ORDER_MIN_USD not imported from @morphit/asset-registry';
			if (/WAIVER_MIN_BLURT/.test(src)) return 'stale WAIVER_MIN_BLURT constant remains';
			if (!/waiverMinUsd[^\n]*<\s*WAIVER_MIN_FIAT_USD/.test(src))
				return 'floor check does not compare the (FX-converted) minimum to WAIVER_MIN_FIAT_USD';
			// cp372: the floor MUST be FX-aware — convert the entered
			// minimum (in the selected fiat) to USD via fiatToUsd, with a
			// `?? amountMinNum` fallback that mirrors the indexer's order.ts
			// (`ctx.fiatToUsd(amount_min, fiat) ?? amount_min`) so the
			// client pre-submit check and the on-chain check agree for ANY
			// currency, not just USD.
			if (!/fiatToUsd\(fxTable, amountMinNum, fiat\)\s*\?\?\s*amountMinNum/.test(src))
				return 'floor is not FX-aware (waiverMinUsd must be `fiatToUsd(fxTable, amountMinNum, fiat) ?? amountMinNum`, matching the indexer)';
			return null;
		}
	},
	{
		name: 'cp372 Min-value default-seed is safe-by-construction (no cp364-class loop/overwrite; re-syncs on fiat change while untouched)',
		check: () => {
			// The seed effect must exist and bail out the instant the
			// user has typed (amountTouched) — otherwise it would fight a
			// user-entered value (a cp364-class bug).
			if (!/if \(!isFirstTrade \|\| fxTable === null \|\| fiat === '' \|\| amountTouched\) return;/.test(src))
				return 'seed effect missing its bail-out guard (not-first-trade / no-fx / empty-fiat / amountTouched)';
			// It must track the last-seeded fiat so re-running with the
			// same fiat is a no-op (no infinite loop) but a currency switch
			// re-seeds.  It must NOT read `amountMin` (reading the signal it
			// writes is the classic self-trigger loop) — the lastSeededFiat
			// guard is what makes that unnecessary.
			if (!/if \(fiat === lastSeededFiat\) return;/.test(src))
				return 'seed effect missing the `fiat === lastSeededFiat` no-loop / re-sync guard';
			if (!/lastSeededFiat = fiat;/.test(src))
				return 'seed effect does not record lastSeededFiat (would re-seed every run)';
			// The grandma-facing $1-equivalent hint must be rendered.
			if (!/firstOrderMinHint/.test(src))
				return 'first-order-min hint ($1-equivalent in the user fiat) not present';
			return null;
		}
	},
	{
		name: 'cp372 Terms typewriter placeholder: 8 untranslated phrases, reduced-motion fallback, cleaned up, wired to the textarea',
		check: () => {
			if (!/TERMS_PLACEHOLDER_PHRASES/.test(src))
				return 'TERMS_PLACEHOLDER_PHRASES not present';
			// The multilingual example set: verify distinctive phrases
			// across scripts survive (the design — several languages
			// cycling — is the point, not the exact count).
			for (const p of [
				'Weekends only',
				'Debajo del puente',
				'请在工作开始前取走您的个人物品',
				'На трибунах баскетбольной площадки'
			]) {
				if (!src.includes(p)) return `typewriter example phrase missing: ${p}`;
			}
			// Accessibility: motion-sensitive users must not get the
			// per-character animation.
			if (!/prefers-reduced-motion/.test(src))
				return 'typewriter does not honor prefers-reduced-motion';
			// No leaked timer on unmount.
			if (!/clearTimeout|clearInterval/.test(src))
				return 'typewriter timer is not cleaned up on unmount';
			// The textarea must render the animated placeholder, not the
			// old static key.
			if (!/placeholder=\{termsPlaceholder\}/.test(src))
				return 'Terms textarea not wired to the typewriter placeholder';
			return null;
		}
	},
	{
		name: 'waiver-benefit ladder is fiat-first ($1/$4/$20/$100 breakpoints; fiat-named tier keys interpolate {amount}, never "{amount} BLURT")',
		check: () => {
			// amount_min and the tiers are fiat values; the floor is $1.
			// cp370: the tier keys are now named for their fiat breakpoint
			// (tier_1/4/20/100), not the old BLURT quantities (500/2000/…).
			for (const t of ['tier_1', 'tier_4', 'tier_20', 'tier_100']) {
				const k = `post_order.waiver_benefits.${t}`;
				const v = enKey(k);
				if (typeof v !== 'string') return `missing key: ${k}`;
				if (!v.includes('{amount}')) return `${k} does not interpolate {amount}`;
				if (/\{amount\}\s*BLURT/.test(v))
					return `${k} still renders "{amount} BLURT" (BLURT-quantity, not fiat)`;
			}
			// The old BLURT-named tier keys (and the superseded with-fiat
			// variants) must be gone from en.json.
			for (const stale of ['tier_500', 'tier_2000', 'tier_10000', 'tier_50000']) {
				if (enKey(`post_order.waiver_benefits.${stale}`) !== undefined)
					return `stale BLURT-named key still present: ${stale}`;
				if (enKey(`post_order.waiver_benefits.${stale}_with_fiat`) !== undefined)
					return `stale ${stale}_with_fiat key still present`;
			}
			// The code's tier mapping must reference the fiat-named keys and
			// the fiat breakpoints — and must NOT reference the old names.
			if (!/\{ at: 1, key: 'post_order\.waiver_benefits\.tier_1' \}/.test(src))
				return 'tier_1 breakpoint is not the $1 fiat floor';
			if (/waiver_benefits\.tier_(500|2000|10000|50000)\b/.test(src))
				return 'code still references an old BLURT-named tier key';
			if (/at: 500,|at: 2000,|at: 10_000,|at: 50_000,/.test(src))
				return 'a BLURT-quantity tier breakpoint (500/2000/10000/50000) remains';
			// The ladder builds the fiat label via formatFiat, not a _with_fiat suffix.
			if (/_with_fiat/.test(src)) return 'code still references the _with_fiat suffix';
			if (!/formatFiat\(tier\.at, denominationFiat\)/.test(src))
				return 'ladder no longer formats the tier threshold as a fiat amount';
			return null;
		}
	},
	{
		name: 'amount field red border + bottom error are gated on amountTouched (no premature red on a pristine form)',
		check: () => {
			if (!/let amountTouched\b/.test(src)) return 'amountTouched state not found';
			// Per-field touched-gated borders.
			if (!/amountTouched && amountMinHasError/.test(src))
				return 'min border not gated on `amountTouched && amountMinHasError`';
			if (!/amountTouched && amountMaxHasError/.test(src))
				return 'max border not gated on `amountTouched && amountMaxHasError`';
			// Bottom amount-error StatusLine gated too.
			if (!/\{#if amountTouched && amountError\}/.test(src))
				return 'bottom amount-error StatusLine not gated on amountTouched';
			// Anti-pattern: an ungated `{amountError ?` border must not return.
			if (/border-2 \{amountError\b/.test(src))
				return 'an amount input border still keys off raw amountError (ungated → premature red)';
			return null;
		}
	},
	{
		name: 'per-field error attribution exists (a min-only fault must not redden the max field)',
		check: () => {
			if (!/const amountMinHasError = \$derived/.test(src))
				return 'amountMinHasError $derived not found';
			if (!/const amountMaxHasError = \$derived/.test(src))
				return 'amountMaxHasError $derived not found';
			return null;
		}
	},
	{
		name: 'flat-price red border + StatusLine are gated on fixedPriceTouched (no red on reveal before typing)',
		check: () => {
			if (!/let fixedPriceTouched\b/.test(src)) return 'fixedPriceTouched state not found';
			if (!/fixedPriceTouched && priceModelError/.test(src))
				return 'flat-price border not gated on `fixedPriceTouched && priceModelError`';
			if (!/\{#if fixedPriceTouched && priceModelError\}/.test(src))
				return 'flat-price StatusLine not gated on fixedPriceTouched';
			return null;
		}
	},
	{
		name: 'number inputs force the cleaned value back onto the DOM (typed letters cannot linger)',
		check: () => {
			// The resync helper + its use is what stops a one-way
			// `value={…}` field from keeping visually-typed letters when
			// the sanitised result equals the current (empty) state.
			if (!/function syncCleaned\(/.test(src)) return 'syncCleaned helper not found';
			if (!/el\.value !== clean/.test(src))
				return 'syncCleaned does not rewrite the DOM value when it differs';
			for (const h of [
				'handleAmountMinInput',
				'handleAmountMaxInput',
				'handleSpreadInput',
				'handleFixedPriceInput'
			]) {
				if (!new RegExp(`function ${h}\\(`).test(src)) return `missing input handler: ${h}`;
				if (!new RegExp(`oninput=\\{${h}\\}`).test(src))
					return `${h} is not wired to an input's oninput`;
			}
			// Anti-pattern: the old inline strip-without-resync handlers.
			if (/oninput=\{\(e\) => \(amountMin = keepDecimal/.test(src))
				return 'min input still uses the inline strip-without-resync handler';
			if (/oninput=\{\(e\) => \(spreadPercent = keepSignedDecimal/.test(src))
				return 'spread input still uses the inline strip-without-resync handler';
			return null;
		}
	},
	{
		name: 'progressive-disclosure dead-end has a nudge (continue_locked_hint when step1Done && !step2Done)',
		check: () => {
			if (typeof enKey('post_order.form.continue_locked_hint') !== 'string')
				return 'continue_locked_hint key missing from en locale';
			if (!/\{#if step1Done && !step2Done\}/.test(src))
				return 'no `step1Done && !step2Done` block to surface the locked hint';
			if (!/post_order\.form\.continue_locked_hint/.test(src))
				return 'continue_locked_hint is not referenced in the template';
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
