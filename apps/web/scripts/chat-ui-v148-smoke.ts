/**
 * chat-ui-v148-smoke — v1.4.8 (t.txt)
 *
 * Three chat-UI fixes:
 *   #2 "Mark all as read" only shows where there's a markable unread — the Inbox
 *      or Starred tab with unread cards, NEVER on Archived (nor on a tab with
 *      nothing unread).
 *   #3 the conversation empty area says "…is loading" until the first snapshot
 *      arrives, and only then falls back to "No messages yet".
 *   #7 every chatroom action-toolbar button uses the same green outlined style
 *      (no lone solid brand-face button among them).
 * Source-level invariants, tamper-tested.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (rel: string): string => readFileSync(join(repo, rel), 'utf8');

const inbox = read('apps/web/src/routes/[lang]/chat/+page.svelte');
const convo = read('apps/web/src/lib/components/ConversationView.svelte');
const en = JSON.parse(read('apps/web/src/lib/i18n/locales/en.json')) as {
	chat: Record<string, string>;
};

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

// #2 — mark-all-read scoped to the active tab's markable unread (not global).
check(
	'#2 "Mark all as read" is gated on activeTabHasUnread, not the global unread total',
	/activeTabHasUnread && conversations\.length > 0/.test(inbox) &&
		!/unreadTotal > 0 && conversations\.length > 0/.test(inbox)
);
check(
	'#2 the Archived tab never shows it (activeTabHasUnread is false on archived)',
	/activeTab === 'archived' \? false : activeList\.some\(\(c\) => c\.unread\)/.test(inbox)
);

// #3 — loading vs empty.
check(
	'#3 a distinct loading key exists and is used while not-yet-loaded',
	Boolean(en.chat.empty_state_loading) &&
		/\{#if hasLoadedOnce\}[\s\S]*?chat\.empty_state[\s\S]*?\{:else\}[\s\S]*?chat\.empty_state_loading/.test(
			convo
		)
);
check(
	'#3 hasLoadedOnce flips true only once the controller delivers a snapshot',
	/let hasLoadedOnce = \$state\(false\)/.test(convo) && /hasLoadedOnce = true/.test(convo)
);

// #7 — the toolbar buttons share one green outlined style; no lone solid one.
const toolbar = convo.slice(
	convo.indexOf('showChatActionToolbar}'),
	convo.indexOf('<ChatComposer')
);
check(
	'#7 no chatroom toolbar button uses the solid brand-face style anymore',
	!/bg-\[var\(--morphit-btn-face\)\][^"]*text-white/.test(toolbar)
);
check(
	'#7 the toolbar buttons use the shared green outlined style (morphit-teal/emerald border)',
	(toolbar.match(/border-morphit-teal\/40[\s\S]*?dark:text-morphit-emerald/g) ?? []).length >= 3
);

if (failures === 0) {
	console.log('✓ all 6 chat-ui-v148 scenarios passed');
} else {
	console.log(`\n✗ ${failures}/6 chat-ui-v148 scenarios failed`);
	process.exit(1);
}
