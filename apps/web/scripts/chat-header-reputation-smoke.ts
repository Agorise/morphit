#!/usr/bin/env tsx
/**
 * Smoke: the chat conversation header shows the peer's reputation cluster —
 * new-trader sprout + ⭐ composite score + trade count — mirroring the order
 * card (Ken #4). Anchor 2026-07-08.
 *
 * Data comes from the reputation-receipt summary (same composite score the
 * order cards show); best-effort + silent so it never blocks the chat.
 *
 * cp473 — THIS SMOKE PINNED TWO REAL BUGS, so its assertions are inverted here.
 * The header is where a user sizes up a stranger before handing over money, and
 * it was reading the RATING count for two different trade-shaped things:
 *
 *   1. It rendered `orderbook.card.trades_only` — literally "{count} trades" —
 *      populated with the review count. A peer with 9 reviews and zero
 *      completed trades was announced as "9 trades", in all 10 locales.
 *   2. It derived the 🌱 sprout from `summary.count_total`, the receipt's
 *      deliberately UNFILTERED total, which counts rows the indexer threw out
 *      as sock-puppet / pile-on / concentration fraud. Proven at cp473 against
 *      real Postgres: 4 flagged sock reviews (0 included, 0 trades) cleared the
 *      "new trader" warning for an account whose real reputation was zero.
 *
 * Both now key off `summary.trade_count` — the same canonical completed-trade
 * count every order card uses since v1.5.5.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const cv = readFileSync(join(WEB, 'src', 'lib', 'components', 'ConversationView.svelte'), 'utf8');

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

check('imports getReputationReceipt (same source as the order card score)', /getReputationReceipt/.test(cv));
check('imports NewTraderChip (the 🌱 sprout) + formatCountCompact', /import NewTraderChip/.test(cv) && /formatCountCompact/.test(cv));
check('loadPeerReputation fetches the receipt', /async function loadPeerReputation/.test(cv) && /getReputationReceipt\(peer\)/.test(cv));
check('the 🌱 sprout keys off COMPLETED TRADES (< 4), matching the order card', /isNewTrader: trades < 4/.test(cv));
check('trades come from summary.trade_count', /const trades = r\.data\.summary\.trade_count \?\? 0/.test(cv));
check('the rating count is the INCLUDED one, never the receipt\'s unfiltered total', /const ratings = r\.data\.summary\.count_included/.test(cv));
check('the header NEVER reads summary.count_total (it counts excluded fraud)', !/summary\.count_total/.test(cv));
check('score taken from the receipt summary', /summary\.reputation_score/.test(cv));
// The window is generous on purpose: this pins the ORDER (ok-guard before the
// assignment, inside a try/catch), not how many comment lines sit between them.
// A tight window fails on an added comment, which teaches people to delete the
// comment rather than keep the guard.
check('loadPeerReputation is best-effort/silent (try/catch, ok-guard)', /if \(!r\.ok\) return;[\s\S]{0,600}peerReputation =/.test(cv) && /catch \{[\s\S]{0,60}peerReputation = null/.test(cv));
check('loadPeerReputation kicked off on mount', /void loadPeerReputation\(\);/.test(cv));

// header render
// tt.txt #7 — the sprout moved OUT of the `{#if peerReputation}` reputation
// block and onto line 1, at the end of the display name (order-card shape). The
// intent is unchanged: it renders iff the peer is a new trader.
check('header renders NewTraderChip when the peer is new', /\{#if peerReputation\?\.isNewTrader\}[\s\S]{0,60}<NewTraderChip \/>/.test(cv));
check('the sprout is NOT gated on having a reputation score', !/peerReputation\.score[\s\S]{0,120}<NewTraderChip \/>/.test(cv));
check('header renders the ⭐ score using the shared reputation aria string', /peerReputation\.score !== null[\s\S]{0,400}orderbook\.card\.reputation_aria[\s\S]{0,200}\u2b50/.test(cv));
check('header renders the trade count via the shared trades string, fed the TRADE count', /orderbook\.card\.trades_only[\s\S]{0,120}formatCountCompact\(peerReputation\.trades\)/.test(cv));
check('the trades line is hidden at zero (a new peer never reads "0 trades")', /\{#if peerReputation\.trades > 0\}/.test(cv));
check('cluster sits in the header, before the RE: order line', cv.indexOf('{#if peerReputation}') < cv.indexOf('{#if orderSummary}'));

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} chat-header-reputation scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} chat-header-reputation checks FAILED`);
	process.exit(1);
}
