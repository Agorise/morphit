/**
 * faq-scroll-block-start-smoke — every scrollIntoView() in FaqSearch.svelte
 * must use block:'start'.
 *
 * WHY: the FAQ page has a sticky header and a global `scroll-padding-top:
 * 5rem` (app.css). With block:'start', scrollIntoView lands a clicked /
 * Entered FAQ card so its TOP — the question title — sits just below the
 * header, which is what the user wants to see ("did I land on the right
 * article?"). block:'center' (the prior behavior) centers a tall card and
 * pushes its title above the viewport, so the user scrolls "too far" and
 * can't see the title. This smoke pins block:'start' for all FAQ-card
 * scrolls and asserts the global offset it relies on still exists.
 *
 * Usage (from apps/web):
 *   tsx scripts/faq-scroll-block-start-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const faqFile = join(import.meta.dirname, '..', 'src', 'lib', 'components', 'FaqSearch.svelte');
const cssFile = join(import.meta.dirname, '..', 'src', 'app.css');
const src = readFileSync(faqFile, 'utf-8');
const css = readFileSync(cssFile, 'utf-8');

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

console.log('\n── FAQ scroll lands on card top ───────────────────────');

// Each scrollIntoView({...}) options object + the block alignment inside.
const calls = [...src.matchAll(/scrollIntoView\(\{[^}]*\}\)/g)].map((m) => m[0]);
check('found at least one scrollIntoView call', calls.length > 0, `found ${calls.length}`);

for (const [i, call] of calls.entries()) {
	const m = call.match(/block:\s*'([^']+)'/);
	const block = m ? m[1] : '(none specified)';
	check(`scrollIntoView #${i + 1} uses block:'start'`, block === 'start', `got '${block}'`);
}

// Belt + suspenders: no center/end/nearest alignment lingering in the file.
check("no block:'center' remains in FaqSearch", !/block:\s*'center'/.test(src));

// The fix relies on the global header offset; if that's removed, the title
// would hide under the sticky header even with block:'start'.
check('global scroll-padding-top still set in app.css', /scroll-padding-top:\s*\S/.test(css));

console.log('');
if (failures === 0) {
	console.log(`✓ all ${checks} faq-scroll-block-start scenarios passed (${calls.length} scrollIntoView calls, every block:'start')`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} check(s) failed`);
	process.exit(1);
}
