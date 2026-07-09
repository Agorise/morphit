#!/usr/bin/env tsx
/**
 * Smoke: t.txt tasks #2, #13, #20, #21 (Ken, 2026-07-09).
 *
 *  #2  Display name / avatar stopped falling back to @username in the chat
 *      inbox. The inbox's own profileMap treated a null as an answer and never
 *      re-asked, so profileCache's soft-null retry never got a chance.
 *  #13 The fee-status banner text is Ken's, byte-for-byte (the trailing
 *      "there" was still present).
 *  #20 "View my order" appears only once the indexer can SEE the order, and
 *      the not-found page uses Ken's exact copy — it says WAIT, not GONE.
 *  #21 The order-detail Edit button carries a live countdown and removes
 *      itself when the 15-minute window closes.
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

const merge = readFileSync(join(WEB, 'src', 'lib', 'indexer', 'profileMerge.ts'), 'utf8');
const inbox = readFileSync(join(WEB, 'src', 'routes', '[lang]', 'chat', '+page.svelte'), 'utf8');
const post = readFileSync(join(WEB, 'src', 'routes', '[lang]', 'post', '+page.svelte'), 'utf8');
const detail = readFileSync(
	join(WEB, 'src', 'routes', '[lang]', '[x+40][account=account]', '[permlink=permlink]', '+page.svelte'),
	'utf8'
);
const myOrders = readFileSync(join(WEB, 'src', 'routes', '[lang]', 'my', 'orders', '+page.svelte'), 'utf8');
const editWindow = readFileSync(join(WEB, 'src', 'lib', 'orders', 'editWindow.ts'), 'utf8');

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

// ─── #2 profile fallback ─────────────────────────────────────────────
check('peersNeedingProfile treats a NULL as "still unknown", not an answer', /map\[p\] == null/.test(merge));
check('mergeProfileMap never downgrades a known-good profile to null', /profile \?\? next\[account\] \?\? null/.test(merge));
check('the inbox uses the shared helpers', /peersNeedingProfile\(peers, profileMap\)/.test(inbox) && /mergeProfileMap\(profileMap, fetched\)/.test(inbox));
// Strip comments first: the fix's own docblock QUOTES the old expression, and a
// naive source match would fail on the explanation of the bug it fixed.
const inboxCode = inbox
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.split('\n')
	.filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
	.join('\n');
check('the inbox no longer keys retries off mere presence', !/!\(p in profileMap\)/.test(inboxCode));

// ─── #13 fee-status banner, byte-exact ───────────────────────────────
const WANT_BANNER =
	'\u{1F4A1} Each order below shows its listing-fee status. An order appears in the public orderbook only once its fee is verified \u2014 a badge reading \u201Cnot received\u201D, \u201Cunderpaid\u201D or \u201Cnot yet verified\u201D is why an order may appear to be missing.';
check("EN fee-status banner is Ken's exact text", loc('en').my_orders.fee_status_banner.body === WANT_BANNER);
check('no locale still ends with a locative ("there"/"allí"/"dort"…)', LOCALES.every((c) => !/\b(there|all[íi]|l[àa]-bas|dort|l[ìi]|tam|там)\s*[.。]$/u.test(loc(c).my_orders.fee_status_banner.body)));
check('the banner × still dismisses forever (localStorage)', /safeLocal\.set\(FEE_BANNER_DISMISS_KEY, '1'\)/.test(myOrders));

// ─── #20 success page + not-found copy ───────────────────────────────
check('"View my order" is gated on the order being visible on chain', /\{#if successPermlink && blurtAccount && orderVisibleOnChain\}/.test(post));
check('a pending state is shown while the order lands', /view_my_order_pending/.test(post));
check('the poll is bounded and never traps the owner', /ORDER_VISIBLE_MAX_ATTEMPTS/.test(post) && /Give up waiting, but never hide the order/.test(post));
check('the poll is torn down on destroy', /onDestroy\(stopOrderVisiblePoll\)/.test(post));
check('a superseded post abandons the old poll', /if \(successPermlink !== permlink\) return;/.test(post));
check("not-found title is Ken's exact copy", loc('en').order_detail.not_found_title === 'Order is loading');
check("not-found body is Ken's exact copy", loc('en').order_detail.not_found_body === 'This order is being posted by the blockchain and may take a minute for it to appear.');
check('all 10 locales carry the new keys', LOCALES.every((c) => typeof loc(c).order_detail.not_found_title === 'string' && typeof loc(c).post_order.success.view_my_order_pending === 'string'));

// ─── #21 edit-window countdown ───────────────────────────────────────
check('the edit-window rule lives in ONE pure module', /export const EDIT_WINDOW_MS = 15 \* 60 \* 1000;/.test(editWindow) && /export function editWindowRemainingSeconds/.test(editWindow));
check('the formatter renders "4m 20s" (unpadded, matching /my/orders)', /return `\$\{minutes\}m \$\{seconds\}s`;/.test(editWindow));
check('order detail shows the countdown in the Edit label', /order_detail\.action_edit_countdown/.test(detail));
check('the countdown reads the ticking clock (not an inline Date.now())', /withinEditWindowFor\(o\.created_at, nowMs\)/.test(detail) && /editWindowRemainingSeconds\(o\.created_at, nowMs\)/.test(detail));
const detailCode = detail
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.split('\n')
	.filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
	.join('\n');
check('order detail has NO hardcoded 15-minute literal left (both call sites)', !/15 \* 60 \* 1000/.test(detailCode));
check('the "editing closed" note also derives from EDIT_WINDOW_MS', /age >= EDIT_WINDOW_MS/.test(detail));
check('/my/orders consumes the same module (no second formatter)', /editWindowRemainingSecondsFor\(o\.created_at, nowMs\)/.test(myOrders) && !/function formatRemainingMmSs/.test(myOrders));
check('all 10 locales have the countdown label with {remaining}', LOCALES.every((c) => String(loc(c).order_detail.action_edit_countdown).includes('{remaining}')));

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} ken-batch-2-scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} ken-batch-2 checks FAILED`);
	process.exit(1);
}
