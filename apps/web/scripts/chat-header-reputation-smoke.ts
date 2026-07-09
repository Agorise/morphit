#!/usr/bin/env tsx
/**
 * Smoke: the chat conversation header shows the peer's reputation cluster —
 * new-trader sprout + ⭐ composite score + trade count — mirroring the order
 * card (Ken #4). Anchor 2026-07-08.
 *
 * Data comes from the reputation-receipt summary (same composite score the
 * order cards show); a new trader has < 4 received-feedback rows (same rule as
 * the orderbook 🌱 chip); best-effort + silent so it never blocks the chat.
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
check('loadPeerReputation fetches the receipt + derives new-trader (< 4)', /async function loadPeerReputation/.test(cv) && /getReputationReceipt\(peer\)/.test(cv) && /count < 4/.test(cv));
check('score + count taken from the receipt summary', /summary\.reputation_score/.test(cv) && /summary\.count_total/.test(cv));
check('loadPeerReputation is best-effort/silent (try/catch, ok-guard)', /if \(!r\.ok\) return;[\s\S]{0,200}peerReputation =/.test(cv) && /catch \{[\s\S]{0,60}peerReputation = null/.test(cv));
check('loadPeerReputation kicked off on mount', /void loadPeerReputation\(\);/.test(cv));

// header render
// tt.txt #7 — the sprout moved OUT of the `{#if peerReputation}` reputation
// block and onto line 1, at the end of the display name (order-card shape). The
// intent is unchanged: it renders iff the peer is a new trader.
check('header renders NewTraderChip when the peer is new', /\{#if peerReputation\?\.isNewTrader\}[\s\S]{0,60}<NewTraderChip \/>/.test(cv));
check('the sprout is NOT gated on having a reputation score', !/peerReputation\.score[\s\S]{0,120}<NewTraderChip \/>/.test(cv));
check('header renders the ⭐ score using the shared reputation aria string', /peerReputation\.score !== null[\s\S]{0,400}orderbook\.card\.reputation_aria[\s\S]{0,200}\u2b50/.test(cv));
check('header renders the trade count via the shared trades string', /orderbook\.card\.trades_only[\s\S]{0,120}formatCountCompact\(peerReputation\.count\)/.test(cv));
check('cluster sits in the header, before the RE: order line', cv.indexOf('{#if peerReputation}') < cv.indexOf('{#if orderSummary}'));

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} chat-header-reputation scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} chat-header-reputation checks FAILED`);
	process.exit(1);
}
