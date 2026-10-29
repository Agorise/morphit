#!/usr/bin/env tsx
/**
 * orderbook-featured-once — v1.21.17 (owner's report).
 *
 * A featured order showed twice on the orderbook (in the "🎉 Featured" card
 * and again in the list under it), with "No featured-slot price history…"
 * under the featured card. Now: once, in the Featured card, whatever the
 * filters; no history note while one is featured; and a search that finds it
 * flashes its border twice (never on a plain visit or a live update).
 * featuredInList.test.ts covers the decision; FeaturedAuctionHistory.test.ts
 * the note; this pins the wiring.
 *
 * Tamper tests (each must turn this red): list `visibleItems` again; drop the
 * keys hand-off or the flash prop; stop recording which search the list
 * answers; count a sort change as a search; flash three times or not at all;
 * flash the page's opening filters.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(WEB, p), 'utf8');
const page = read('src/routes/[lang]/orderbook/+page.svelte');
const orders = read('src/lib/components/FeaturedOrders.svelte');
const history = read('src/lib/components/FeaturedAuctionHistory.svelte');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean): void => {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (cond) passed++;
	else failed++;
};

check(
	'the list leaves out what the Featured card shows',
	/const listedItems = \$derived\(withoutFeatured\(visibleItems, featuredKeys\)\);/.test(page) &&
		/\{#each listedItems as o \(o\.account \+ '\/' \+ o\.permlink\)\}/.test(page) &&
		!/\{#each visibleItems as o/.test(page)
);
check(
	'the Featured card hands its orders up and takes the flash down',
	/<FeaturedAuctionHistory\s+onFeaturedKeys=\{\(keys\) => \{\s*featuredKeys = new Set\(keys\);\s*featuredKnown = true;\s*\}\}\s+flashKeys=\{featuredFlash\}/.test(
		page
	) &&
		/onkeys=\{onFeaturedKeys\}\s*\{flashKeys\}/.test(history) &&
		/onkeys\?\.\(visibleSlots\.map\(\(s\) => `\$\{s\.order\.account\}\/\$\{s\.order\.permlink\}`\)\);/.test(
			orders
		)
);
check(
	'the list records which search it answers',
	/const loadingFor = untrack\(\(\) => serverSearch\);\s*listServerSearch = null;/.test(page) &&
		(page.match(/listServerSearch = loadingFor;/g) ?? []).length === 2
);
check(
	'a sort is not a search',
	/const rest: Record<string, unknown> = \{ \.\.\.currentQuery\(\) \};\s*delete rest\.sort;/.test(
		page
	)
);
check(
	'the opening filters are taken as decided, later searches decide the flash',
	/if \(!flashBaselineTaken\) \{[\s\S]{0,500}if \(listFor === null \|\| listFor !== search\) return;\s*flashBaselineTaken = true;\s*flashDecided = search;\s*return;\s*\}\s*const r = featuredFlashFor\(input\);/.test(
		page
	) &&
		/flashTimer = setTimeout\(\(\) => \(featuredFlash = new Set\(\)\), FEATURED_FLASH_MS\);/.test(
			page
		)
);
check(
	'typed words count once typing has paused, and the list must answer them',
	/const h = setTimeout\(\(\) => \(settledTokens = t\), SEARCH_SETTLE_MS\);/.test(page) &&
		/listServerSearch === null \|\| tokensNow !== settledTokens\s*\? null/.test(page)
);
check(
	'when every match is featured, the list says where it is',
	/\{#if listedItems\.length === 0\}[\s\S]{0,400}\$_\('orderbook\.match_in_featured'\)/.test(page)
);
check(
	'the featured card flashes its border twice',
	/class=\{flashKeys\?\.has\(`\$\{o\.account\}\/\$\{o\.permlink\}`\) \? 'flash-featured' : ''\}/.test(
		orders
	) &&
		/:global\(\.flash-featured\) \{\s*animation: flash-featured-border 2s ease-in-out 2;/.test(
			orders
		)
);
check(
	'no empty-history note under a featured order',
	/\{:else if liveFeaturedCount === 0 && !switching\}/.test(history) &&
		!history.includes('no_history_yet_active')
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed === 0) {
	console.log(`✓ all ${passed} orderbook-featured-once scenarios passed`);
	process.exit(0);
}
console.log(`✗ ${failed} of ${passed + failed} orderbook-featured-once scenarios FAILED`);
process.exit(1);
