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
const orderDetail = readFileSync(
	join(WEB, 'src', 'routes', '[lang]', '[x+40][account=account]', '[permlink=permlink]', '+page.svelte'),
	'utf8'
);
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
// Ken's #20 REQUIREMENT — "I just paid, and my order doesn't exist" must never
// happen — is unchanged and still pinned below. The MECHANISM changed in v1.7.0.
//
// #20 originally shipped a poll: hide "View my order" until the indexer could
// see the order. That could not work, and reliably didn't. The poll was bounded
// at 20 × 2s ≈ 40s against a 45-63s last-irreversible lag (ADR-0008), so it
// always timed out and surfaced the button anyway ("never hide the order from
// its owner") — whereupon the detail page, whose retry was calibrated against
// the same wrong number (~24s), said "Order not found". Both workarounds
// reasoned about POLL lag when the real wait was IRREVERSIBILITY, so the exact
// scenario #20 existed to prevent happened every single time.
//
// v1.7.0 fixes it at the root: the browser stages the order it just broadcast
// (`pendingOrders`) and the detail page reads it, so the destination cannot
// 404 for its owner and the button needs no gate. These checks now pin THAT —
// the requirement, not the failed mechanism.
check('the post page stages the order it just broadcast', /stagePostedOrder\(result\.payload\)/.test(post));
check('staging derives from the PAYLOAD that went on chain, not the raw form', /orderPayloadToRecord\(blurtAccount, payload/.test(post));
check('"View my order" is offered immediately (no gate to fail open)', /\{#if successPermlink && blurtAccount\}/.test(post));
check('the broken visibility poll is gone', !/ORDER_VISIBLE_MAX_ATTEMPTS|pollUntilOrderVisible|orderVisibleOnChain/.test(post));
check('the detail page reads the staged order, so it cannot 404 on its owner', /mergePendingOrders\(r\.data\.items, get\(pendingOrders\)/.test(orderDetail));
// The page RECORDED cancels (t.txt #6/#7) but never APPLIED them, so cancelling
// from /my/orders and then opening the order showed it "live" for ~45-63s. It
// recorded the truth and didn't use it.
check('the detail page APPLIES the cancels it records', /applyRecentCancels\(merged\)/.test(orderDetail));
// Order matters: a staged post the user has since cancelled isn't in the
// indexer's list at all, so cancels must be applied to the MERGED result or the
// staged copy reads "live" on a cancelled order.
check('cancels are applied AFTER the staged merge, not before', orderDetail.indexOf('const merged = mergePendingOrders(') < orderDetail.indexOf('applyRecentCancels(merged)'));
check("not-found title is Ken's exact copy", loc('en').order_detail.not_found_title === 'Order is loading');
check("not-found body is Ken's exact copy", loc('en').order_detail.not_found_body === 'This order is being posted by the blockchain and may take a minute for it to appear.');
check('all 10 locales carry the not-found copy', LOCALES.every((c) => typeof loc(c).order_detail.not_found_title === 'string' && typeof loc(c).order_detail.not_found_body === 'string'));

// ─── v1.7.0 fastorderstatuschange (ADR-0051) ─────────────────────────
// Ken: "if i am looking at an order detail page and its status changes, i want
// the pills to update WHILE i am looking at the page."
//
// Exactly ONE case is genuinely stale, and being precise about which is the
// point: Live→Expired already flips client-side off expires_at; payment status
// ("funds sent") is a CHAT message so it rides the chat fast path; and an owner
// cancelling their own order sees it instantly because they did it on this page.
// What's left is watching SOMEONE ELSE'S order when the owner cancels or
// completes it — and since both durable handlers gate on `account = signer`, the
// owner is the only one who can, which is precisely why a watcher can't know
// without being told. Polling cannot fix it: the durable row doesn't change for
// 45-63s, so a poll just asks a stale table more often.
check('the detail page subscribes to a live stream for THIS order', /createOrderbookStream\(/.test(orderDetail));
check('it subscribes narrowly (one order), not to the whole orderbook', /query: \(\) => \(\{ account, permlink \}\)/.test(orderDetail));
check('the subscription is torn down on destroy (no orphaned EventSource)', /orderStream\?\.stop\(\)/.test(orderDetail));
// The stream is live-only + fee-verified-only, so a removal means "no longer a
// live listing" and nothing more. Painting "Cancelled" from it would be
// inventing a detail we don't have — the head-block op isn't irreversible yet
// and it might just as well have been "Completed".
check('a removal only claims what it knows — never a guessed status', /noLongerLive = true;/.test(orderDetail) && !/status = 'cancelled'/.test(orderDetail));
check('a removal triggers the durable refetch that replaces the hedge', /noLongerLive = true;[\s\S]{0,400}?loadOrder\(0\)/.test(orderDetail));
check('the hedge chip hides itself once the real status lands', /\{#if noLongerLive && effectiveStatus\(order\) === 'live'\}/.test(orderDetail));
check('all 10 locales carry the settling copy', LOCALES.every((c) => typeof loc(c).order_detail.status_settling === 'string'));

// ─── v1.7.0 fastrepliestofeedbacks + fastprofileupdate (ADR-0051) ────
const profilePage = readFileSync(
	join(WEB, 'src', 'routes', '[lang]', '[x+40][account=account]', '+page.svelte'),
	'utf8'
);
const profileCache = readFileSync(join(WEB, 'src', 'lib', 'indexer', 'profileCache.ts'), 'utf8');

// The page said "Reply posted ✓" above a visibly empty reply slot for ~45-63s —
// the user's own words missing from their own profile, which reads as "it didn't
// work". A reply is DISPLAY, not reputation: `feedback_responses` is only ever
// SELECTed to attach display rows; weighted_rating/feedback_count are computed
// from `feedback` rows and never read responses. Verified, not assumed.
check('a just-posted reply is staged from the text that went on chain', /addPendingReply\(fb\.source_trx_id, account, res\.comment\)/.test(profilePage));
check('the feedback list merges staged replies', /mergePendingReplies\(r\.data\.items, get\(pendingFeedbackReplies\)/.test(profilePage));
check('profile hydration sees the staged responder (avatar, not identicon)', /hydrateReviewerProfiles\(merged, 'received'\)/.test(profilePage));

// PRIME_HOLD_MS was 12s against a 45-63s wait, with a comment claiming it
// "comfortably covers indexer catch-up". `profiles` is written only by
// handlers/profile.ts, which runs from the LIB-bounded poller — so the hold
// expired ~40s before the indexer could know, and the next fetch reverted the
// user's own just-saved name. The exact "I saved it but it reverted" flicker the
// constant exists to prevent.
check('the profile prime-hold outlasts irreversibility, not block time', /const PRIME_HOLD_MS = PENDING_TTL_MS;/.test(profileCache));
check('the prime-hold shares the chain constant rather than hand-tuning a copy', /from '\$lib\/stores\/pendingEcho'/.test(profileCache));

// ─── v1.7.0 fastdisplaycurrentstatus (ADR-0051 §3) ───────────────────
// Ken: "never make the user wonder what is going on."
//
// A staged order renders with status 'live', which is TRUE and, unlabelled,
// misleading: it's on chain but NOT in the public orderbook, because that gates
// on fee_status IN ('verified','verified_by_attestation') and nothing has
// verified the fee yet. Unmarked, the honest reading is "my order is live", and
// the user's first clue otherwise is a friend saying they can't find it.
// ADR-0051 §3: "the user gets feedback in ~6s, not finality in ~6s, and is never
// misled about which one they have."
check('a staged order is labelled as still confirming', /\{#if isProvisional\}/.test(orderDetail));
check('provisional-ness is computed from the echo store, not guessed', /pendingOrderKeys\(\$pendingOrders/.test(orderDetail));
check('the label clears itself once the indexer serves the row', /order !== null &&\s*\n?\s*pendingOrderKeys\(/.test(orderDetail));
check('all 10 locales carry the confirming copy', LOCALES.every((c) => typeof loc(c).order_detail.status_confirming === 'string'));

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
