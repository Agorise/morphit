#!/usr/bin/env tsx
/**
 * Smoke: the "🚀 Feature this order!" copy and the homepage featured section
 * (Ken, 2026-07-08).
 *
 *  - The explainer names the duration the user actually selected (6h / 24h /
 *    72h), not a vague "the selected duration".
 *  - It states the real slot cap. It used to say "Max 5 concurrent slots"
 *    while the indexer (`MAX_SLOTS = 3`) and the FAQ both said 3 — copy that
 *    hardcodes a number drifts silently, so the number now comes from a shared
 *    constant, and THIS smoke pins that constant to the indexer's value.
 *  - The homepage no longer prints a "FEATURED RIGHT NOW" eyebrow above the
 *    cards, but the section keeps an accessible name.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const REPO = join(WEB, '..', '..');
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);

const form = readFileSync(join(WEB, 'src', 'lib', 'components', 'FeatureBidForm.svelte'), 'utf8');
const featured = readFileSync(join(WEB, 'src', 'lib', 'components', 'FeaturedOrders.svelte'), 'utf8');
const slotsConst = readFileSync(join(WEB, 'src', 'lib', 'orders', 'featuredSlots.ts'), 'utf8');
const indexerFeatured = readFileSync(
	join(REPO, 'apps', 'indexer', 'src', 'api', 'featuredOrderbook.ts'),
	'utf8'
);

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
}

// ─── slot-count parity: the drift that caused the wrong copy ─────────
const webSlots = /MAX_FEATURED_SLOTS = (\d+)/.exec(slotsConst)?.[1];
const idxSlots = /const MAX_SLOTS = (\d+)/.exec(indexerFeatured)?.[1];
check('web MAX_FEATURED_SLOTS is defined', webSlots !== undefined);
check('indexer MAX_SLOTS is defined', idxSlots !== undefined);
check(`featured-slot-count-parity (web ${webSlots} === indexer ${idxSlots})`, webSlots === idxSlots);

// ─── the explainer is interpolated, not hardcoded ────────────────────
check('explainer receives the SELECTED hours', /feature_bid\.explainer',[\s\S]{0,120}hours: selectedHours/.test(form));
check('explainer receives the slot count from the shared constant', /slots: MAX_FEATURED_SLOTS/.test(form));
check('FeatureBidForm imports the constant', /import \{ MAX_FEATURED_SLOTS \} from '\$lib\/orders\/featuredSlots';/.test(form));
check('the hours ladder still offers 6 / 24 / 72', /HOURS_OPTIONS = \[6, 24, 72\]/.test(form));

// ─── locale copy ─────────────────────────────────────────────────────
let allHave = true;
let anyFive = false;
let pluralOk = true;
for (const loc of LOCALES) {
	const v = JSON.parse(readFileSync(join(WEB, 'src', 'lib', 'i18n', 'locales', `${loc}.json`), 'utf8'))
		?.feature_bid?.explainer as string | undefined;
	if (typeof v !== 'string' || !v.includes('{hours') || !v.includes('{slots}')) allHave = false;
	if (typeof v === 'string' && /\b5\b/.test(v.replace('{slots}', ''))) anyFive = true;
	if (typeof v === 'string' && !/\{hours, plural,/.test(v)) pluralOk = false;
}
check('all 10 locales interpolate {hours} and {slots}', allHave);
check('no locale still claims the stale "5" slots', !anyFive);
check('hours uses an ICU plural (correct forms in pl/ru)', pluralOk);

const en = JSON.parse(readFileSync(join(WEB, 'src', 'lib', 'i18n', 'locales', 'en.json'), 'utf8'))
	.feature_bid.explainer as string;
check('EN reads "above the main orderbook, and on the homepage for …"', /above the main orderbook, and on the homepage for \{hours/.test(en));
check('EN reads "Only {slots} slots are available; highest per-hour bid wins:"', /Only \{slots\} slots are available; highest per-hour bid wins:$/.test(en));

// ─── homepage eyebrow removed, a11y preserved ────────────────────────
check('no visible "Featured right now" heading remains', !/id="featured-heading"/.test(featured) && !/<h2[\s\S]{0,160}featured\.heading/.test(featured));
check('the section keeps an accessible name', /<section aria-label=\{\$_\('featured\.heading'\)\}/.test(featured));

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} featured-order-copy scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} featured-order-copy checks FAILED`);
	process.exit(1);
}
