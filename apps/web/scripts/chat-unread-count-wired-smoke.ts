#!/usr/bin/env tsx
/**
 * Smoke: the chat unread count is actually WIRED into the global notification
 * store. Anchor 2026-07-08.
 *
 * THE BUG THIS GUARDS AGAINST. The Notifications menu showed "Chat 0" and the
 * avatar badge never ticked up for waiting chat messages, because nothing fed
 * the `chat` category of the notification `counts` store — only `feedback`
 * ever called into it. The chat page tracked unread locally, but that never
 * reached the global counts.
 *
 * This locks in the fix:
 *   1. A STATE-based setter (`setCategoryCount`) exists — chat's count is the
 *      live unread-conversation total, not a stream of discrete events.
 *   2. A global `startChatUnreadChannel` polls conversations + read-state and
 *      pushes the unread total via setCategoryCount (using isUnread).
 *   3. `startAmbientChannels` actually STARTS that channel (so it runs app-wide,
 *      not just on the chat page).
 *   4. `markRead()` (menu-open, no arg) does NOT zero `chat` — chat clears only
 *      by reading a conversation, so opening the menu must leave a still-unread
 *      chat badge alone (it clears only order + feedback).
 *
 * Tamper tests (each must turn this smoke red):
 *   - Remove the startChatUnreadChannel() call from startAmbientChannels → fails.
 *   - Make the chat channel use notify() instead of setCategoryCount → fails.
 *   - Have markRead() no-arg reset chat too → fails.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const NOTIF = join(__dirname, '..', 'src', 'lib', 'notifications');

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

const index = readFileSync(join(NOTIF, 'index.ts'), 'utf8');
const chatUnread = readFileSync(join(NOTIF, 'chatUnread.ts'), 'utf8');
const ambient = readFileSync(join(NOTIF, 'ambient.ts'), 'utf8');
const tradeListener = readFileSync(join(NOTIF, '..', 'trades', 'tradeEventListener.ts'), 'utf8');

// 1. state-based setter exists + exported
check(
	'notifications exports setCategoryCount (state-based count setter)',
	/export function setCategoryCount\s*\(/.test(index)
);
// The ambient badge is always-on: setCategoryCount must NOT gate the count
// on the per-category opt-in (categories.chat even defaults false).
const setBody = /export function setCategoryCount[\s\S]*?\n}/.exec(index)?.[0] ?? '';
check(
	'setCategoryCount is NOT gated on the per-category opt-in (ambient always-on)',
	setBody.length > 0 && !/prefs\.categories\[/.test(setBody)
);

// 2. the chat channel computes unread + pushes via setCategoryCount + isUnread
check(
	'chatUnread exports startChatUnreadChannel',
	/export function startChatUnreadChannel\s*\(/.test(chatUnread)
);
check(
	'chatUnread pushes the count via setCategoryCount(\u2018chat\u2019, …)',
	/setCategoryCount\(\s*['"]chat['"]/.test(chatUnread)
);
check(
	'chatUnread computes unread with isUnread + getConversations',
	/isUnread\(/.test(chatUnread) && /getConversations\(/.test(chatUnread)
);
check(
	'chatUnread does NOT use notify() (chat is state-based, not event-based)',
	!/\bnotify\(/.test(chatUnread)
);

// 3. the channel is actually started app-wide
check(
	'startAmbientChannels imports + starts the chat-unread channel',
	/from '\.\/chatUnread'/.test(ambient) && /startChatUnreadChannel\(\)/.test(ambient)
);

// 4. markRead() (no arg) must not zero chat — only order + feedback
const noArgBranch = /if \(category === undefined\)\s*\{[\s\S]*?return \{([\s\S]*?)\};/.exec(index);
check('markRead() no-arg branch found', noArgBranch !== null);
if (noArgBranch) {
	const body = noArgBranch[1];
	check('markRead() no-arg clears order', /order:\s*0/.test(body));
	check('markRead() no-arg clears feedback', /feedback:\s*0/.test(body));
	check('markRead() no-arg does NOT clear chat', !/chat:\s*0/.test(body) && !/emptyCounts\(\)/.test(body));
}

// ── ORDER category: routed through notify() (count + native, one path) ──────
// notify() must bump the ambient count BEFORE the per-category opt-in gate —
// the badge is always-on; only the ALERTS (native/chime) are gated.
const notifyBody = /export function notify\([\s\S]*?\n}/.exec(index)?.[0] ?? '';
const countIdx = notifyBody.indexOf('counts.update');
const gateIdx = notifyBody.indexOf('prefs.categories[event.category]');
check(
	'notify() bumps the ambient count BEFORE the opt-in gate (count is always-on)',
	countIdx !== -1 && gateIdx !== -1 && countIdx < gateIdx
);
check(
	'order events route through notify({ category: \u2018order\u2019, … }) — one path for count + native',
	/notify\(\{[\s\S]{0,120}?category:\s*['"]order['"]/.test(tradeListener)
);
check(
	'the dead legacy order-native path is gone (no maybeBrowserNotify, no bumpCount, no tradeNotificationsEnabled)',
	!/maybeBrowserNotify/.test(tradeListener) &&
		!/bumpCount/.test(tradeListener) &&
		!/tradeNotificationsEnabled/.test(tradeListener)
);
check(
	'the legacy tradeNotifications module is retired (file deleted)',
	!existsSync(join(NOTIF, 'tradeNotifications.ts'))
);
const prefs = readFileSync(join(NOTIF, 'preferences.ts'), 'utf8');
check(
	'a one-time migration carries legacy trade-notif users → channels.native',
	/migrateLegacyTradeNotifications/.test(prefs) &&
		/morphit\.tradeNotifications\.enabled/.test(prefs) &&
		/channels:\s*\{[^}]*native:\s*true/.test(prefs)
);

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} chat-unread-count-wired scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} chat-unread-count-wired checks FAILED`);
	process.exit(1);
}
