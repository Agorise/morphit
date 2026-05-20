#!/usr/bin/env tsx
/**
 * per-asset-mandatory-family-i18n-parity smoke — Part 122 cp75 (LL #75 / O-24).
 *
 * Generalises cp51-O5 (faq-per-tradable-asset-parity) from one
 * family (`faq.entries.what_is_<asset>`) to the full set of
 * MANDATORY-when-asset-is-tradable i18n key families.
 *
 * cp51-O5 caught the cp21/cp24/cp27 drift class — new ticker added
 * to the registry but the FAQ family forgotten in some locales.
 * Since then we've added 12 more assets, AND we've added several
 * NEW per-asset families (privacy guides, cheat sheet, asset
 * explainer).  cp55-O9 polices the EN-vs-native-byte-identical
 * floor for several of these families.  cp74-O22 polices route
 * SEO presence across all locales.  This smoke fills the remaining
 * gap: structural presence of MANDATORY per-asset families across
 * all 10 locales, driven by the asset registry.
 *
 * Failure mode caught:
 *   - cp NN adds ticker FOO to packages/asset-registry.
 *   - Developer adds `faq.entries.what_is_foo` (cp51-O5 happy),
 *     and adds `privacy.guides.foo.intro` to en.json,
 *     but FORGETS the other 9 locales for some family.
 *   - i18n-locale-parity-smoke catches "key in en but not in fr",
 *     so that's covered.
 *   - But if the developer ALSO forgets en.json itself for one
 *     family (e.g. cheat_sheet.section_assets.foo), parity smoke
 *     can't catch what's not in en — only THIS registry-driven
 *     smoke catches "registry says FOO is tradable but its
 *     mandatory family is absent from en.json".
 *
 * MANDATORY families verified (each has a render site that is
 * NOT wrapped in a conditional fallback — absence is a user-
 * facing bug):
 *
 *   1. post_order.form.asset_explainer.<ticker>
 *      Used by apps/web/src/routes/[lang]/post-order/+page.svelte
 *      as the asset-specific tooltip.
 *   2. cheat_sheet.section_assets.<ticker>
 *      Used by the asset cheat sheet for each tradable asset.
 *   3. privacy.guides.<ticker>.one_line
 *      Used by privacy guide index card.
 *   4. privacy.guides.<ticker>.intro
 *      Used by the asset privacy guide body.
 *   5. privacy.guides.<ticker>.meta_description
 *      Used as the <meta description> tag for the asset guide page.
 *
 * OPTIONAL families (deliberately NOT enforced):
 *
 *   - privacy.guides.<ticker>.caveats
 *      Renderer at apps/web/src/routes/[lang]/privacy/[asset]/+page.svelte:167
 *      checks `$_(key) !== key` and skips the section if the key
 *      is absent.  Chains with nothing privacy-critical to caveat
 *      (XMR, BTC, DAI, BCH, LTC at cp75) deliberately have no
 *      caveats entry.  Adding them here would force-create no-op
 *      caveats; that defeats the design.
 *
 * Adding a new mandatory family: append to MANDATORY_FAMILIES.
 * Adding a new optional family: document it in this header so
 * future maintainers know the family was considered.
 *
 * Mutation test M-147:
 *   - Delete `post_order.form.asset_explainer.xrp` from en.json
 *     → smoke fires naming the family + ticker + locale.
 *   - Restore → smoke passes.
 *
 * Recurring class scope progression (registry-driven i18n parity):
 *   cp51-O5:  faq.entries.what_is_<asset>           (1 family × all tickers × all locales)
 *   cp74-O22: seo.<route>.{title,description}       (1 registry × all routes × all locales)
 *   cp75-O24: 5 per-asset mandatory families        (5 families × all tickers × all locales)
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_TICKERS } from '../../../packages/asset-registry/src/index';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

let failed = 0;
let passed = 0;
function pass(name: string): void { console.log(`  ✓ ${name}`); passed++; }
function fail(name: string, detail: string): void {
	console.error(`  ✗ ${name}`); console.error(`      ${detail}`); failed++;
}

console.log('\n── per-asset-mandatory-family-i18n-parity smoke (cp75 LL #75 / O-24) ──\n');

/**
 * Each mandatory family.  `pathTemplate` uses `{ticker}` as the
 * placeholder for the lowercase ticker (asset registry is the
 * authority for casing — tickers are lowercase in i18n keys
 * even though they're uppercase in the registry constant).
 */
interface Family {
	readonly id: string;
	readonly pathTemplate: string;
	readonly renderSite: string;
}

const MANDATORY_FAMILIES: Family[] = [
	{
		id: 'asset_explainer',
		pathTemplate: 'post_order.form.asset_explainer.{ticker}',
		renderSite: 'apps/web/src/routes/[lang]/post-order/+page.svelte (post-order asset tooltip)'
	},
	{
		id: 'cheat_sheet_section_assets',
		pathTemplate: 'cheat_sheet.section_assets.{ticker}',
		renderSite: 'apps/web/src/lib/cheatsheet (per-asset cheat-sheet block)'
	},
	{
		id: 'privacy_guide_one_line',
		pathTemplate: 'privacy.guides.{ticker}.one_line',
		renderSite: 'apps/web/src/routes/[lang]/privacy/+page.svelte (privacy index card)'
	},
	{
		id: 'privacy_guide_intro',
		pathTemplate: 'privacy.guides.{ticker}.intro',
		renderSite: 'apps/web/src/routes/[lang]/privacy/[asset]/+page.svelte (guide body)'
	},
	{
		id: 'privacy_guide_meta_description',
		pathTemplate: 'privacy.guides.{ticker}.meta_description',
		renderSite: 'apps/web/src/routes/[lang]/privacy/[asset]/+page.svelte (HTML meta description)'
	}
];

/** Resolve a dot-path against a nested JSON object.  Returns the
 *  value if it's a non-empty string, otherwise null. */
function resolveKey(obj: unknown, path: string): string | null {
	const parts = path.split('.');
	let cur: unknown = obj;
	for (const part of parts) {
		if (typeof cur !== 'object' || cur === null) return null;
		cur = (cur as Record<string, unknown>)[part];
	}
	return typeof cur === 'string' && cur.length > 0 ? cur : null;
}

const localesDir = join(REPO_ROOT, 'apps/web/src/lib/i18n/locales');
const localeFiles = readdirSync(localesDir)
	.filter((f) => f.endsWith('.json'))
	.map((f) => f.replace('.json', ''))
	.sort();

console.log(`▸ Checking ${MANDATORY_FAMILIES.length} families × ${ASSET_TICKERS.length} tickers × ${localeFiles.length} locales`);
console.log(`  = ${MANDATORY_FAMILIES.length * ASSET_TICKERS.length * localeFiles.length} key resolutions\n`);

interface Missing {
	readonly family: string;
	readonly ticker: string;
	readonly locale: string;
	readonly path: string;
	readonly renderSite: string;
}
const missing: Missing[] = [];

// Pre-load all locale JSONs once.
const locales = new Map<string, unknown>();
for (const loc of localeFiles) {
	try {
		locales.set(loc, JSON.parse(readFileSync(join(localesDir, `${loc}.json`), 'utf-8')));
	} catch (e) {
		fail(`${loc}.json parses as JSON`, String((e as Error).message));
	}
}

for (const family of MANDATORY_FAMILIES) {
	for (const tickerUpper of ASSET_TICKERS) {
		const ticker = tickerUpper.toLowerCase();
		const path = family.pathTemplate.replace('{ticker}', ticker);
		for (const locale of localeFiles) {
			const json = locales.get(locale);
			if (json === undefined) continue;
			if (resolveKey(json, path) === null) {
				missing.push({
					family: family.id,
					ticker,
					locale,
					path,
					renderSite: family.renderSite
				});
			}
		}
	}
}

if (missing.length === 0) {
	pass(`every mandatory family × ticker × locale resolves to a non-empty string`);
} else {
	// Group by family for readability.
	const byFamily = new Map<string, Missing[]>();
	for (const m of missing) {
		const list = byFamily.get(m.family) ?? [];
		list.push(m);
		byFamily.set(m.family, list);
	}
	for (const [familyId, entries] of byFamily.entries()) {
		const sample = entries.slice(0, 5).map((e) => `${e.locale}: ${e.path}`).join(', ');
		const more = entries.length > 5 ? ` (and ${entries.length - 5} more)` : '';
		fail(
			`family ${familyId} has all ticker × locale entries`,
			`${entries.length} missing — ${sample}${more}. Render site: ${entries[0]!.renderSite}`
		);
	}
}

const total = passed + failed;
console.log(`\n${passed} passed, ${failed} failed (${total} total)`);
if (failed > 0) {
	console.error('\nper-asset-mandatory-family-i18n-parity smoke FAILED');
	console.error('Memory rule: locale parity — every user-facing string change must be translated into all 10 locales in the same turn.');
	console.error('When adding a new ticker to packages/asset-registry, every mandatory family must ship its keys in every locale.');
	process.exit(1);
}
console.log(`✓ all ${total} per-asset-mandatory-family-i18n-parity scenarios passed`);
