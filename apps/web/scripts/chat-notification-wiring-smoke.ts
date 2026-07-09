#!/usr/bin/env tsx
/**
 * Smoke: t.txt #14, #17, #18, #19, #22 — plus the #15/#37 regression guards for
 * the notification wiring (Ken: "make sure none of this can break later").
 *
 *  #14 "Mark complete / review" must smooth-scroll to the review form. It
 *      didn't, because the form is behind a LAZY dynamic import and the retry
 *      gave up after 40 animation frames (~0.66s) — a rendering budget spent on
 *      a network wait.
 *
 *  #19 The inbox card stayed green for a peer just chatted with. The
 *      conversation was acked ONCE on mount, so every later message was
 *      "newer"; and the ack used the browser clock while `last_message_at` is a
 *      CHAIN timestamp, so clock skew pinned it unread forever.
 *
 *  #17/#22 The ≤6s notification path must stay wired end to end:
 *      layout → startAmbientChannels → startChatUnreadChannel →
 *      SSE + 5s poll → totalUnread → favicon badge + avatar-menu dot.
 *      Every link here has been silently breakable: a channel nobody starts is
 *      indistinguishable from a channel that works, until you wait five minutes
 *      for a message that never announces itself.
 *
 *  #18 Message delivery is SSE-driven with a bounded fallback poll.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const read = (...p: string[]) => readFileSync(join(WEB, ...p), 'utf8');

/** Match CODE, not prose — docblocks quote the bugs they fixed. */
const code = (src: string): string =>
	src
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
		.join('\n');

const scrollHelper = read('src', 'lib', 'ui', 'scrollToLazySection.ts');
const myOrders = read('src', 'routes', '[lang]', 'my', 'orders', '+page.svelte');
const readState = read('src', 'lib', 'chat', 'readState.ts');
const convo = read('src', 'lib', 'components', 'ConversationView.svelte');
const layout = read('src', 'routes', '[lang]', '+layout.svelte');
const ambient = read('src', 'lib', 'notifications', 'ambient.ts');
const chatUnread = read('src', 'lib', 'notifications', 'chatUnread.ts');
const avatarMenu = read('src', 'lib', 'components', 'AvatarMenu.svelte');
const chatService = read('src', 'lib', 'chat', 'chatService.ts');
const inbox = read('src', 'routes', '[lang]', 'chat', '+page.svelte');

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

// ─── #14 scroll to a lazily-imported section ─────────────────────────
check('the scroll helper AWAITS the lazy chunk before looking for the element', /await loadChunk\(\);/.test(code(scrollHelper)));
check('the retry is bounded by a WALL CLOCK, not a frame count', /deadline = now\(\) \+/.test(code(scrollHelper)) && !/attempts\+\+ < 40/.test(code(scrollHelper)));
check('rAF is still used to wait for paint (just not as a timer)', /requestAnimationFrame\(tryScroll\)/.test(code(scrollHelper)));
check('a failed chunk import resolves rather than spinning', /catch \{[\s\S]{0,80}return false;/.test(code(scrollHelper)));
check('BOTH /my/orders scroll targets use the shared helper', (code(myOrders).match(/scrollToLazySection\(/g) ?? []).length === 2);
check('neither scroll helper keeps a private frame-count retry', !/attempts\+\+ < 40/.test(code(myOrders)));
check('the review form container still carries scroll-mt-24 (\u22481in below the top)', /scroll-mt-24" id="feedback-form-/.test(myOrders));

// ─── #19 read acknowledgement ────────────────────────────────────────
check('readAckTimestamp prefers the CHAIN timestamp over a lagging clock', /export function readAckTimestamp/.test(readState) && /latestSeenAt\.getTime\(\) > now\.getTime\(\) \? latestSeenAt : now/.test(code(readState)));
check('an unparseable timestamp falls back to the local clock', /Number\.isNaN\(latestSeenAt\.getTime\(\)\)/.test(code(readState)));
check('ConversationView acks with the newest CONFIRMED message', /function latestConfirmedAt\(\)/.test(convo) && /readAckTimestamp\(latestConfirmedAt\(\)\)/.test(code(convo)));
check('pending messages (no chain stamp) never drive the ack', /if \(at === null\) continue;/.test(code(convo)));
check('the conversation re-acks as messages arrive, not only on mount', /\$effect\(\(\) => \{[\s\S]{0,260}ackRead\(\);/.test(code(convo)));
check('it does NOT ack while the tab is hidden (unseen messages stay unread)', /document\.hidden\) return;/.test(code(convo)));
check('it acks once more on the way out', /onDestroy\(\(\) => \{[\s\S]{0,120}ackRead\(\);/.test(code(convo)));

// ─── #17 / #22 the ≤6s path, link by link (#15/#37 guards) ───────────
check('layout starts the ambient channels on mount', /startAmbientChannels\(\)/.test(code(layout)));
check('ambient starts the chat-unread channel', /startChatUnreadChannel\(\)/.test(code(ambient)));
check('chat-unread subscribes to the global SSE activity stream', /subscribeChatActivity\(/.test(code(chatUnread)) && /startGlobalChatActivity\(\)/.test(code(chatUnread)));
check('chat-unread also keeps a \u22645s backstop poll', /POLL_MS = 5_000/.test(code(chatUnread)));
check('the avatar menu renders a badge from totalUnread', /totalUnread/.test(code(avatarMenu)));
check('the favicon badge channel exists', /favicon/i.test(ambient));
check('the inbox refreshes on SSE activity, not just on its poll', /subscribeChatActivity\(/.test(code(inbox)));
check('the inbox poll is \u22645s', /POLL_MS = 5_000/.test(code(inbox)));

// ─── #18 message delivery ────────────────────────────────────────────
check('messages arrive over SSE with a bounded fallback poll', /FALLBACK_POLL_INTERVAL_MS = 4_000/.test(code(chatService)));
check('the fallback poll is jittered (clients do not stampede)', /POLL_JITTER_MS/.test(code(chatService)));

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} chat-notification-wiring scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} chat-notification-wiring checks FAILED`);
	process.exit(1);
}
