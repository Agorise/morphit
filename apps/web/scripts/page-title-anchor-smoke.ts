/**
 * page-title-anchor-smoke.
 *
 * Guards the fix for the stale browser-tab title bug. The ambient (N)-unread
 * prefix must re-anchor to the CURRENT page's title on every navigation, not
 * stamp onto the title captured once at first load — which leaked a chat page's
 * "Conversation" onto the orderbook (and "Browse Offers" onto chat).
 *
 * Static guards (the runtime effect can't be exercised headless):
 *   - ambient.ts exports setBaseTitle, which resets originalTitle and re-applies
 *     the count prefix (setTitle(lastTotal)); SSR-safe,
 *   - lastTotal is fed from the unreadCount subscription,
 *   - Head.svelte imports setBaseTitle and calls it reactively with its
 *     computed <title> ($effect keyed on `title`).
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ambientSrc = readFileSync(join(here, '../src/lib/notifications/ambient.ts'), 'utf8');
const headSrc = readFileSync(join(here, '../src/lib/components/Head.svelte'), 'utf8');

let pass = 0;
let fail = 0;
function expect(name: string, cond: boolean): void {
	if (cond) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.log(`  \u2717 ${name}`);
	}
}

// ─── ambient.ts ──────────────────────────────────────────────────────
expect('ambient exports setBaseTitle', /export function setBaseTitle/.test(ambientSrc));
expect(
	'setBaseTitle resets originalTitle to the new base',
	/setBaseTitle[\s\S]{0,180}originalTitle = base/.test(ambientSrc)
);
expect(
	'setBaseTitle re-applies the count prefix immediately',
	/setBaseTitle[\s\S]{0,220}setTitle\(lastTotal\)/.test(ambientSrc)
);
expect(
	'setBaseTitle is SSR-safe (guards typeof document)',
	/setBaseTitle[\s\S]{0,140}typeof document === 'undefined'/.test(ambientSrc)
);
expect('lastTotal is tracked from the unread subscription', /lastTotal = total/.test(ambientSrc));

// ─── Head.svelte ─────────────────────────────────────────────────────
expect(
	'Head imports setBaseTitle',
	/import \{ setBaseTitle \} from '\$lib\/notifications\/ambient'/.test(headSrc)
);
expect(
	'Head re-anchors the title in a reactive effect',
	/\$effect\(\(\) => \{[\s\S]{0,80}setBaseTitle\(title\)/.test(headSrc)
);

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 page-title-anchor smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} page-title-anchor checks passed`);
