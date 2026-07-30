#!/usr/bin/env tsx
/**
 * fast-badge-push-contract — v1.7.5 (t.txt #1).
 *
 * THE BUG THIS EXISTS TO CATCH, AND WHY NOTHING ELSE CAUGHT IT.
 *
 * Ken: kentest2 revives an archived thread and messages kentest3. The system
 * notification lands in ~4s. The avatar/favicon badges take about a MINUTE.
 *
 * The whole fast-badge path was already built (v1.5.5 `emitFastPush`, cp474's
 * archived-thread resurrect) and unit-tested — and it had never once run in
 * production, because the SERVER and the SERVICE WORKER disagreed about how the
 * thread reaches the page, in a way that was a perfect inversion:
 *
 *   server: category = isOrderSignal ? 'order' : 'chat'
 *           clickPath = isOrderSignal ? `/<loc>/chat/<sender>?order=<permlink>`
 *                                     : `/<loc>/chat`
 *   sw:     chatThread = category === 'chat' ? parse(clickPath) : null
 *
 *   → order-scoped message: the clickPath HAS the peer, but category is 'order',
 *     so the SW never parsed it.
 *   → plain chat message: category is 'chat' so the SW parsed — but the clickPath
 *     was the LIST, with no peer in it.
 *
 * Either way the SW posted CHAT_PUSH with no peer, the page's
 * `if (typeof data.peer === 'string' && data.peer)` guard dropped it, and
 * neither the resurrect nor the badge ran. The badge could only light when the
 * durable poll finally read a fresh `last_message_at` — the ~60s Ken measured.
 *
 * WHY THE EXISTING TESTS ALL PASSED:
 *   - `chatUnread.test.ts` drives `fastPushListener(PEER, ORDER)` DIRECTLY,
 *     bypassing the SW→page bridge — i.e. it tests everything except the link
 *     that was broken.
 *   - `handler-push-click-path-route-smoke` checks the clickPath resolves to a
 *     real ROUTE, which `/<loc>/chat` does. It was asking about the click
 *     destination, not about the badge.
 *
 * So this smoke pins the CONTRACT BETWEEN the two files — the thing neither side
 * could check alone: every chat-ish push must deliver a peer to the page.
 *
 * Tamper tests (each must turn this red):
 *   - Revert the plain-chat clickPath to `/${locale}/chat` → fails.
 *   - Revert the SW to `category === 'chat' ? ... : null` → fails.
 *   - Remove `emitFastPush` from the bridge → fails.
 *   - Make the bridge stop resurrecting archived threads → fails.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

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

console.log('\n── fast-badge-push-contract (v1.7.5 / t.txt #1) ───────\n');

const enqueue = read('apps/indexer/src/indexer/chatPushEnqueue.ts');
const sw = read('apps/web/src/service-worker.ts');
/** Comment lines stripped: a fix's own comment necessarily NAMES the anti-pattern
 *  it removed, and scanning raw source would flag that documentation as the bug. */
const swCode = sw
	.split('\n')
	.filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
	.join('\n');
const bridge = read('apps/web/src/lib/chat/globalChatActivityStream.ts');
const unread = read('apps/web/src/lib/notifications/chatUnread.ts');

// ─── 1. the server names the peer in EVERY chat clickPath ────────
// This is the half that was wrong for plain chat. Both branches must carry
// `/chat/<sender>`; only the ?order scope may differ.
const clickPathBlock = /const clickPath = isOrderSignal[\s\S]{0,240}?;/.exec(enqueue)?.[0] ?? '';
check('the push enqueue builds a clickPath from isOrderSignal', clickPathBlock.length > 0);
check(
	'the ORDER-scoped clickPath names the peer',
	/\/\$\{locale\}\/chat\/\$\{params\.sender\}\?order=/.test(clickPathBlock)
);
check(
	'the PLAIN-CHAT clickPath names the peer too (was `/${locale}/chat` — the list)',
	/:\s*`\/\$\{locale\}\/chat\/\$\{params\.sender\}`/.test(clickPathBlock),
	'a clickPath with no peer means the SW can never tell the page which thread lit up'
);
check(
	'no chat clickPath points at the bare list any more',
	!/`\/\$\{locale\}\/chat`/.test(clickPathBlock),
	'the list has no peer segment, so the badge stays dark for ~60s'
);

// ─── 2. the SW parses BOTH chat-ish categories ───────────────────
// This is the other half. The server sets category='order' for exactly the
// clickPath that HAS the peer.
check(
	"the server still labels an order signal 'order' (the SW must cope with it)",
	/const category = isOrderSignal \? 'order' : 'chat';/.test(enqueue)
);
check(
	'the SW parses the thread for BOTH chat and order categories',
	/category === 'chat' \|\| category === 'order'/.test(sw),
	"parsing only 'chat' skips the order-scoped push — the one whose path has the peer"
);
check(
	'the SW recovers the thread by parsing the clickPath',
	/chatThreadFromClickPath\(clickPath\)/.test(sw)
);
check(
	'the SW forwards peer + order on the CHAT_PUSH message',
	/type: 'CHAT_PUSH',[\s\S]{0,140}?peer: chatThread\.peer, order: chatThread\.order/.test(sw)
);
check(
	'the SW pokes EVERY open tab, including backgrounded ones',
	/matchAll\(\{[\s\S]{0,80}?includeUncontrolled: true/.test(sw),
	'Ken was on another tab; a focused-only poke would never reach him'
);

// ─── 2b. the SW SUPPRESSES a redundant notification for BOTH categories (cp514 / t.txt C) ──
// While both parties are actively in the same chatroom, no OS notification
// should keep popping. The suppression check must run for the 'order' category
// too: an order-scoped chat message (messaging from an order card) is labelled
// 'order', not 'chat', so the old 'chat'-only guard left every reply popping a
// notification mid-conversation. NOTE: check 2's regex now also matches the
// badge-poke's own `chat || order`; this pins the SUPPRESSION guard specifically.
check(
	'the notification-suppression guard covers BOTH chat and order categories',
	/let activelyViewing = false;\s*if \(category === 'chat' \|\| category === 'order'\) \{/.test(sw),
	"a 'chat'-only suppression pops a notification for every order-scoped reply while you're in the room"
);
// cp515 — suppression keys on HAVING THE THREAD OPEN, not on tab visibility.
// cp514 extended the guard to the 'order' category and the pop STILL happened
// on every reply, because `visibilityState === 'visible'` fails in the ordinary
// case: the two participants of one conversation are, on a single machine, two
// tabs — and only ONE can be 'visible', so the other was judged "not looking"
// and notified mid-conversation. Re-introducing a visibility condition here
// would resurrect exactly that bug.
check(
	'suppression keys on an OPEN same-peer chat client (peer match alone)',
	/activelyViewing = openWindows\.some\(\(c\) => chatPeerMatches\(c\.url, clickPath\)\);/.test(sw),
	'a peer match on any open client — a different thread/peer, or an order-lifecycle push, still notifies'
);
check(
	'suppression is NOT gated on visibilityState (the cp514 regression)',
	!/visibilityState/.test(swCode),
	'only one tab can be visible at a time, so a visibility gate notifies the person you are chatting with'
);
check(
	'activelyViewing actually gates whether the notification is shown',
	/if \(!activelyViewing\) \{[\s\S]{0,80}?showNotification/.test(sw),
	'the suppression only matters if it skips showNotification'
);

// ─── 3. the page acts on it ──────────────────────────────────────
check('the bridge listens for CHAT_PUSH from the SW', /data\.type === 'CHAT_PUSH'/.test(bridge));
check(
	'the bridge resurrects an archived thread named by a push',
	/folderOf\(data\.peer, order\) === 'archived'\) restoreThread\(data\.peer, order\)/.test(bridge),
	'a message arriving after you archived a thread IS the un-archive signal'
);
check('the bridge lights the badge straight off the push', /emitFastPush\(data\.peer, order\)/.test(bridge));
check(
	'the badge channel subscribes to the fast push',
	/subscribeFastPush\(\(peer, order/.test(unread)
);

// ─── 3b. the SSE path — the one that works WITHOUT push permission ──
//
// The Web Push path above is only as fast as the user's notification
// permission. The chat-activity SSE fires for every message regardless, and it
// is NOT gated on document.hidden — so it is the path that has to carry a
// backgrounded tab with notifications denied. Before v1.7.5 its ping said only
// "something happened with <peer>", so the client's only move was to re-poll
// `getConversations` — the durable table the fast path never writes — and the
// badge sat dark for ~45-63s.
const activityStream = read('apps/indexer/src/api/chatActivityStream.ts');
check(
	'the SSE ping names the thread (peer + order), not just the peer',
	/sseEvent\('chat_activity', \{ peer, order, inbound[,\s}]/.test(activityStream),
	'per cp446 the thread key is (peer, order) — a peer alone cannot light the right card'
);
check(
	'the SSE fast path forwards the order permlink it already has',
	/ev\.orderPermlink \?\? ''/.test(activityStream),
	"the fast bus event carries orderPermlink; dropping it was the whole bug"
);
check(
	'the SSE marks direction, so a sender is never badged for their own message',
	/ev\.recipient === account/.test(activityStream),
	'this is a PARTICIPANT stream — it fires for what you send too (t.txt #2)'
);
check(
	'the client lights the badge off the SSE ping, not just off a push',
	/d\.inbound === true && typeof d\.peer === 'string'[\s\S]{0,900}?emitFastPush\(d\.peer, d\.order/.test(bridge),
	'without this, a user who denied notifications waits ~60s for every badge'
);
check(
	'the client resurrects an archived thread from the SSE ping too',
	/if \(folderOf\(d\.peer, d\.order\) === 'archived'\) restoreThread\(d\.peer, d\.order\);/.test(bridge)
);
check(
	'the SSE listener is NOT gated on document.hidden',
	!/document\.hidden/.test(bridge),
	'a backgrounded tab is exactly the case the badge exists for'
);
check(
	'a malformed ping still falls through to the reconciling poll',
	/\} catch \{[\s\S]{0,120}?\}\s*fire\(\);/.test(bridge),
	'the fast hint is an optimisation; the poll must remain the backstop'
);

// ─── 3c. the COLD START — browser was CLOSED when the message landed ──
//
// Ken: "even when the browser itself or tab is closed completely, and then I
// open a new tab and go to Morphit, I want the badges in 6 seconds or less."
//
// No live stream can serve this: the message arrived while no page existed to
// hear it, and getConversations legitimately cannot help because the fast path
// never writes that table. The events must be handed to whoever connects next —
// which is what the fast ring already does for a chatroom opened just after a
// message lands. This is the same hand-off, for a badge.
const bus = read('apps/indexer/src/indexer/chatEventBus.ts');
check(
	'the bus can list recent fast events by PARTICIPANT, not just by pair',
	/recentFastForAccount\(account: string\): ChatFastEvent\[\]/.test(bus),
	'a cold start has no thread in mind yet — only a badge to paint'
);
check(
	'that listing is scoped to the account (never another user\'s activity)',
	/this\.fastRing\.filter\(\(e\) => e\.lo === account \|\| e\.hi === account\)/.test(bus)
);
check(
	'the stream replays the ring on connect',
	/for \(const ev of chatEventBus\.recentFastForAccount\(account\)\)/.test(activityStream)
);
check(
	'the replay carries the message\'s REAL block time, not now()',
	/ev\.createdAt\.getTime\(\)/.test(activityStream),
	'now() would date an old message to this instant and badge one already read'
);
check(
	'the replay runs BEFORE ready (light, then reconcile — never blink)',
	activityStream.indexOf('recentFastForAccount(account)') <
		activityStream.indexOf("sseEvent('ready', {})"),
	"ready triggers the client's poll; replaying after it paints then blinks"
);
check(
	'only replayable events are retained (a stranger may still be rejected durably)',
	/if \(ev\.replayable === true\) this\.retainFast\(ev\);/.test(bus)
);
check(
	'the ring outlasts irreversibility, so nothing falls in the gap',
	/const FAST_RING_TTL_MS = 5 \* 60 \* 1000;/.test(bus),
	'5min comfortably exceeds the 45-63s fast→durable gap this bridges'
);
check(
	'the ring is bounded, so a broadcast burst cannot grow indexer memory',
	/const FAST_RING_MAX = 2_000;/.test(bus)
);
check(
	'the client honours the replayed timestamp rather than assuming now()',
	/emitFastPush\(d\.peer, d\.order, typeof d\.at === 'number' \? d\.at : undefined\)/.test(bridge)
);

// ─── 4. the load-bearing premise ─────────────────────────────────
// If the fast path ever started writing chat_messages, polling on a push would
// be enough and none of the above would be needed. It doesn't (ADR-0051
// invariant #1), which is exactly why the push must carry the thread itself.
check(
	'the fast path still never writes the message row (why the push must self-describe)',
	!/INSERT INTO chat_messages/i.test(read('apps/indexer/src/indexer/headTailer.ts')),
	'if the tailer wrote the row, a poll on push would suffice — it does not'
);

console.log(`\n${'─'.repeat(54)}`);
if (failed === 0) {
	console.log(`✓ all ${passed} fast-badge-push-contract checks passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed}/${passed + failed} fast-badge-push-contract checks failed`);
	process.exit(1);
}
