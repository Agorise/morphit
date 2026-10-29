#!/usr/bin/env tsx
/**
 * orderbook-filter-header-steady — v1.21.17 (owner's report).
 *
 * Opening the orderbook's Filter card pushed the word "Filter" and its +/−
 * button down a line (the card's padding, the text size and the button size
 * all grew when open), so the pointer had to chase the button to close the
 * card again. Measured in Chromium at 1280 and 390 px: 25 px down and 24→32 px
 * before; 0 px after. This pins that nothing in the header row depends on
 * whether the card is open — only the space below it does.
 *
 * Tamper tests (each must turn this red): make the card's top padding, the
 * button's padding, the word's size or the button's size depend on
 * `filtersExpanded` again.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const page = readFileSync(join(WEB, 'src/routes/[lang]/orderbook/+page.svelte'), 'utf8');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean): void => {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (cond) passed++;
	else failed++;
};

const start = page.indexOf('data-testid="filters-card"');
const end = page.indexOf('</h2>', start);
const header =
	start >= 0 && end > start ? page.slice(page.lastIndexOf('<section', start), end) : '';

check('the Filter card header is found', header.length > 0);
check(
	'the card keeps its top padding open or closed (only the bottom grows)',
	/class="card mb-6 px-6 pt-1 \{filtersExpanded \? 'pb-6' : 'pb-1'\}"/.test(header)
);
check(
	'the toggle row has one padding',
	/class="group -mx-2 flex w-full items-center justify-between gap-3 rounded-xl px-2 py-0\.5 text-start[^"{]*"/.test(
		header
	)
);
check(
	'the word "Filter" has one size',
	/<span class="font-display text-base font-bold">/.test(header)
);
check(
	'the +/− button has one size',
	/<span\s+class="flex h-6 w-6 flex-none items-center justify-center rounded-full[^"{]*"/.test(
		header
	)
);
// Only the card's bottom padding, the h2's bottom margin, the tooltip and the
// icon's turn may follow the open state inside the header.
const uses = header.match(/filtersExpanded \?/g) ?? [];
check(
	`only the bottom spacing, the tooltip and the icon's turn follow the open state (${uses.length} uses)`,
	uses.length === 4 &&
		/title=\{filtersExpanded \? \$_\('orderbook\.filters\.collapse'\) : \$_\('orderbook\.filters\.expand'\)\}/.test(
			header
		) &&
		/class=\{filtersExpanded \? 'mb-4' : 'mb-0'\}/.test(header) &&
		/\{filtersExpanded \? 'rotate-45' : ''\}/.test(header)
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed === 0) {
	console.log(`✓ all ${passed} orderbook-filter-header-steady scenarios passed`);
	process.exit(0);
}
console.log(`✗ ${failed} of ${passed + failed} orderbook-filter-header-steady scenarios FAILED`);
process.exit(1);
