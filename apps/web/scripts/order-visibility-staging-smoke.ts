#!/usr/bin/env tsx
/**
 * order-visibility-staging-smoke — "I just paid, and my order doesn't exist"
 * must never happen, and a watched order's status must not go stale.
 *
 *  - The post page stages the order it just broadcast (`pendingOrders`) and
 *    the detail page reads it, so the destination cannot 404 for its owner
 *    during the ~45-63 s last-irreversible lag (ADR-0008). An earlier poll that
 *    hid "View my order" until the indexer saw the order was bounded at ~40 s,
 *    always timed out, and is gone.
 *  - Cancels and completes this session broadcast are APPLIED to the merged
 *    result, after the staged merge.
 *  - Only the poster gets the "still being posted" wait state; anyone else
 *    gets "not found" at once.
 *  - The detail page subscribes to a live stream for THIS order (ADR-0051), so
 *    watching someone else's order shows the owner's cancel or complete, and a
 *    removal claims only "no longer live", never a guessed status.
 *  - A staged order is labelled as still confirming until the indexer serves
 *    the row (ADR-0051 §3: feedback in ~6 s, never mistaken for finality).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);
const loc = (c: string) =>
	JSON.parse(readFileSync(join(WEB, 'src', 'lib', 'i18n', 'locales', `${c}.json`), 'utf8'));

const post = readFileSync(join(WEB, 'src', 'routes', '[lang]', 'post', '+page.svelte'), 'utf8');
const orderDetail = readFileSync(
	join(
		WEB,
		'src',
		'routes',
		'[lang]',
		'[x+40][account=account]',
		'[permlink=permlink]',
		'+page.svelte'
	),
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

// ─── staging the just-posted order ───────────────────────────────────
check(
	'the post page stages the order it just broadcast',
	/stagePostedOrder\(result\.payload\)/.test(post)
);
check(
	'staging derives from the PAYLOAD that went on chain, not the raw form',
	/orderPayloadToRecord\(blurtAccount, payload/.test(post)
);
check(
	'"View my order" is offered immediately (no gate to fail open)',
	/\{#if successPermlink && blurtAccount\}/.test(post)
);
check(
	'the broken visibility poll is gone',
	!/ORDER_VISIBLE_MAX_ATTEMPTS|pollUntilOrderVisible|orderVisibleOnChain/.test(post)
);
check(
	'the detail page reads the staged order, so it cannot 404 on its owner',
	/mergePendingOrders\(indexed, get\(pendingOrders\)/.test(orderDetail)
);
check(
	'the detail page APPLIES the cancels it records',
	/applyRecentCancels\(merged\)/.test(orderDetail)
);
check(
	'cancels are applied AFTER the staged merge, not before',
	orderDetail.indexOf('const merged = mergePendingOrders(') <
		orderDetail.indexOf('applyRecentCancels(merged)')
);

// ─── wait state for the poster only, not-found for everyone else ─────
check(
	'only the poster gets the "still being posted" retry',
	/viewerAccount === a && attempt < ORDER_RETRY_ATTEMPTS/.test(orderDetail)
);
check(
	'all 10 locales carry the posting (wait) copy',
	LOCALES.every(
		(c) =>
			typeof loc(c).order_detail.posting_title === 'string' &&
			typeof loc(c).order_detail.posting_body === 'string'
	)
);
check(
	'all 10 locales carry the not-found copy',
	LOCALES.every(
		(c) =>
			typeof loc(c).order_detail.not_found_title === 'string' &&
			typeof loc(c).order_detail.not_found_body === 'string'
	)
);

// ─── live status for a watched order ─────────────────────────────────
check(
	'the detail page subscribes to a live stream for THIS order',
	/createOrderbookStream\(/.test(orderDetail)
);
check(
	'it subscribes narrowly (one order), not to the whole orderbook',
	/query: \(\) => \(\{ account, permlink \}\)/.test(orderDetail)
);
check(
	'the subscription is torn down on destroy (no orphaned EventSource)',
	/orderStream\?\.stop\(\)/.test(orderDetail)
);
check(
	'a removal only claims what it knows — never a guessed status',
	/noLongerLive = true;/.test(orderDetail) && !/status = 'cancelled'/.test(orderDetail)
);
check(
	'a removal triggers the durable refetch that replaces the hedge',
	/noLongerLive = true;[\s\S]{0,400}?loadOrder\(0\)/.test(orderDetail)
);
check(
	'the hedge chip hides itself once the real status lands',
	/\{#if noLongerLive && effectiveStatus\(order\) === 'live'\}/.test(orderDetail)
);
check(
	'all 10 locales carry the settling copy',
	LOCALES.every((c) => typeof loc(c).order_detail.status_settling === 'string')
);

// ─── provisional label ───────────────────────────────────────────────
check('a staged order is labelled as still confirming', /\{#if isProvisional\}/.test(orderDetail));
check(
	'provisional-ness is computed from the echo store, not guessed',
	/pendingOrderKeys\(\$pendingOrders/.test(orderDetail)
);
check(
	'the label clears itself once the indexer serves the row',
	/order !== null &&\s*\n?\s*pendingOrderKeys\(/.test(orderDetail)
);
check(
	'all 10 locales carry the confirming copy',
	LOCALES.every((c) => typeof loc(c).order_detail.status_confirming === 'string')
);

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} order-visibility-staging checks passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} order-visibility-staging checks FAILED`);
	process.exit(1);
}
