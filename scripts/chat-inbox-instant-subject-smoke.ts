#!/usr/bin/env tsx
/**
 * chat-inbox-instant-subject — cp515 (Ken's t.txt).
 *
 * THE BUG. cp514 made the optimistic inbox card appear within ~4s of the push.
 * Its SUBJECT still didn't: the "RE:" line rendered a placeholder for about a
 * minute until the durable conversation row arrived. Ken: "please make the
 * subject line show up immediately as well if it has an order id permlink
 * attached to it (which in this case it does)."
 *
 * WHY it lagged: the fast push carries only (peer, orderPermlink), so the
 * injected card's `order` was a STUB of empty strings — enough to link to, not
 * enough to title. The fix resolves the real order (public data, owned by one
 * of the two participants) and caches it per permlink.
 *
 * Tamper tests (each must turn this red):
 *   - Drop the resolver and go back to a bare empty-string stub → fails.
 *   - Call resolvePendingOrder from inside the $derived (impure, self-re-entering) → fails.
 *   - Hardcode `pending: true` again, so a resolved card still shows the placeholder → fails.
 *   - Mutate the map in place instead of reassigning (derived never re-runs) → fails.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const page = readFileSync(join(REPO, 'apps/web/src/routes/[lang]/chat/+page.svelte'), 'utf8');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── chat-inbox-instant-subject (cp515) ────────────────\n');

check(
	'the inbox caches resolved orders for optimistic cards',
	/let pendingOrders = \$state<Map<string, ConversationOrderRef>>/.test(page)
);
check(
	'it resolves the order from the participants (peer first, then me)',
	/for \(const owner of \[peer, me\]\)/.test(page),
	'the order always belongs to one of the two people in the thread'
);
check(
	'it fetches the order rather than inventing a title',
	/getOrdersByAccount\(owner/.test(page)
);
check(
	'the resolved card uses the REAL order, falling back to the stub',
	/const resolved = p\.orderPermlink \? pendingOrders\.get\(p\.orderPermlink\) : undefined;/.test(page) &&
		/order: p\.orderPermlink\s*\?\s*\(resolved \?\?/.test(page)
);
check(
	'`pending` means "a subject is still loading", not "this card is optimistic"',
	/pending: p\.orderPermlink !== '' && resolved === undefined/.test(page),
	'a resolved card must drop the placeholder; an order-LESS thread never shows one'
);
check(
	'the map is REASSIGNED, not mutated (or the derived never re-runs)',
	/const next = new Map\(pendingOrders\);[\s\S]{0,600}?pendingOrders = next;/.test(page)
);
check(
	'an absent status renders no label rather than a fabricated "(Live)"',
	/status: rec\.status \?\? ''/.test(page)
);

// The lookup must be driven by an effect. A $derived that fires fetches is
// impure and re-enters on its own result.
const derivedBody = /const sortedConversations = \$derived\.by\(\(\) => \{([\s\S]*?)\n\t\}\);/.exec(page)?.[1] ?? '';
check('the sortedConversations derived was located', derivedBody.length > 0);
check(
	'the derived stays PURE — no resolver call inside it',
	derivedBody.length > 0 && !/resolvePendingOrder\(/.test(derivedBody),
	'firing a fetch from a derived re-enters when its own result lands'
);
check(
	'an $effect drives the lookup instead',
	/\$effect\(\(\) => \{[\s\S]{0,400}?resolvePendingOrder\(c\.peer, c\.order\.permlink\)/.test(page)
);
check(
	'each permlink is fetched at most once (in-flight guard + cache check)',
	/pendingOrders\.has\(permlink\) \|\| pendingOrderLookups\.has\(permlink\)/.test(page)
);
check(
	'the in-flight guard is released even when the lookup throws',
	/finally \{[\s\S]{0,120}?pendingOrderLookups\.delete\(permlink\)/.test(page)
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} chat-inbox-instant-subject checks passed` : '✗ chat-inbox-instant-subject FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
