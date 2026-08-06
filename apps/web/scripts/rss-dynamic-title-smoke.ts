/**
 * rss-dynamic-title-smoke — the per-asset RSS feed <title> must spell out the
 * active orderbook filters, built from the FORM's own labels (single source of
 * truth), and the indexer must echo that title without reconstructing any
 * label itself.
 *
 * Ken's requirement: "if we ever change the code for the values that the
 * filter form presents, the rss feed generator needs to automatically reflect
 * those changes."  We meet it by building the title in the frontend from the
 * same i18n label keys + registries the form renders, passing it via the feed
 * URL's `feed_title` param, and having the indexer echo it.  This smoke pins:
 *   1. the frontend title-builder references the canonical label keys (NOT
 *      hardcoded strings) + the asset/payment registries, so label edits
 *      propagate automatically;
 *   2. the feed URL carries `feed_title`;
 *   3. the indexer echoes `feed_title` (with a static fallback) and never
 *      parses it as a filter (cosmetic-only);
 *   4. the new i18n keys exist in every locale and the old per-asset pill key
 *      is fully retired;
 *   5. the pill text is the static "generated dynamically" label.
 *
 * Usage (from apps/web):
 *   tsx scripts/rss-dynamic-title-smoke.ts
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const webRoot = join(__dirname, '..');
const repoRoot = join(webRoot, '..', '..');
const page = readFileSync(
	join(webRoot, 'src', 'routes', '[lang]', 'orderbook', '+page.svelte'),
	'utf-8'
);
const handler = readFileSync(
	join(repoRoot, 'apps', 'indexer', 'src', 'api', 'rssOrderbookHandlers.ts'),
	'utf-8'
);
const localesDir = join(webRoot, 'src', 'lib', 'i18n', 'locales');

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = ''): void {
	checks++;
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		failures++;
		console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
	}
}

console.log('\n── RSS dynamic title (single source of truth) ─────────');

// 1. Frontend title-builder references the form's canonical label keys —
//    these are the SAME keys the form's options/field labels use, so a label
//    change there is reflected in the feed title with no extra work.
const labelKeys = [
	'orderbook.filters.side_${side}',
	'orderbook.filters.asset_label',
	'orderbook.filters.fiat_label',
	'orderbook.filters.region_label',
	'orderbook.filters.payment_methods_label',
	'orderbook.filters.min_trades_${minTrades}',
	'orderbook.filters.sort_label',
	'orderbook.filters.sort_${sortMode}',
	'orderbook.filters.rss_title_prefix'
];
for (const k of labelKeys) check(`rssTitle references ${k}`, page.includes(k));

// Single-source registries (asset name + payment names), NOT hardcoded maps.
check(
	'rssTitle uses displayNamesForMethods (same payment names as the rows)',
	page.includes('displayNamesForMethods(paymentMethods, instLookup)')
);
check(
	'rssTitle uses the ASSETS registry for the asset name',
	page.includes('ASSETS.find((x) => x.displayTicker === asset)')
);

// 2. The feed URL carries the built title.
check("rssQuery sets feed_title", /params\.set\('feed_title', rssTitle\)/.test(page));

// 3. The indexer echoes feed_title, keeps a static fallback, and does NOT
//    treat it as a filter (cosmetic only).
check('indexer reads rawFilters.feed_title', handler.includes('rawFilters.feed_title'));
check(
	'indexer keeps a static fallback title',
	/Morphit — New \$\{asset\} orderbook entries/.test(handler)
);
const parseBlock = handler.match(/function parseFeedFilters[\s\S]*?\n\}/)?.[0] ?? '';
check(
	'parseFeedFilters ignores feed_title (stays cosmetic)',
	parseBlock.length > 0 && !parseBlock.includes('feed_title')
);

// 4. i18n parity for the new keys + retirement of the old per-asset pill key.
const locales = readdirSync(localesDir).filter((f) => f.endsWith('.json'));
check('found all 10 locale files', locales.length === 10, `found ${locales.length}`);
for (const f of locales) {
	const filters = JSON.parse(readFileSync(join(localesDir, f), 'utf-8')).orderbook.filters;
	check(
		`${f}: rss_title_prefix present + keeps {site}`,
		typeof filters.rss_title_prefix === 'string' && filters.rss_title_prefix.includes('{site}')
	);
	check(
		`${f}: rss_generated_label present`,
		typeof filters.rss_generated_label === 'string' && filters.rss_generated_label.length > 0
	);
	check(`${f}: old rss_asset_label retired`, filters.rss_asset_label === undefined);
}

// 5. The pill text is the static generated-dynamically label.
check(
	'pill text uses rss_generated_label',
	page.includes("text={$_('orderbook.filters.rss_generated_label')")
);
check('pill no longer uses rss_asset_label', !page.includes('rss_asset_label'));

console.log('');
if (failures === 0) {
	console.log(`✓ all ${checks} rss-dynamic-title scenarios passed (${locales.length} locales, single-source title wired)`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} check(s) failed`);
	process.exit(1);
}
