#!/usr/bin/env tsx
/**
 * Smoke: the chat inbox is an inbox of DISCUSSIONS, not of people (cp446, Ken).
 *
 * "I will have multiple discussions with the same person, but regarding
 * different orders." So: one card per (peer, order), an order-less thread gets
 * its own card and no RE: subline, newest first, and opening a card scopes the
 * transcript to that order.
 *
 * The two silent regressions this guards:
 *   1. keying the list on `peer` — two cards collide and Svelte reuses one node;
 *   2. dropping the transcript filter — a reply about order A shows up in the
 *      discussion about order B, which is a privacy-adjacent correctness bug,
 *      not a cosmetic one.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const REPO = join(WEB, '..', '..');

const strip = (src: string): string =>
	src
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.split('\n')
		.filter((l) => !l.trim().startsWith('*') && !l.trim().startsWith('//'))
		.join('\n');

const inbox = strip(readFileSync(join(WEB, 'src', 'routes', '[lang]', 'chat', '+page.svelte'), 'utf8'));
const service = strip(readFileSync(join(WEB, 'src', 'lib', 'chat', 'chatService.ts'), 'utf8'));
const conversations = strip(readFileSync(join(REPO, 'apps', 'indexer', 'src', 'api', 'conversations.ts'), 'utf8'));
const chatApi = strip(readFileSync(join(REPO, 'apps', 'indexer', 'src', 'api', 'chat.ts'), 'utf8'));
const stream = strip(readFileSync(join(REPO, 'apps', 'indexer', 'src', 'api', 'chatStream.ts'), 'utf8'));
const tailer = strip(readFileSync(join(REPO, 'apps', 'indexer', 'src', 'indexer', 'chatHeadTailer.ts'), 'utf8'));
const chatHandler = strip(readFileSync(join(REPO, 'apps', 'indexer', 'src', 'indexer', 'handlers', 'chat.ts'), 'utf8'));
const chatFolders = strip(readFileSync(join(WEB, 'src', 'lib', 'chat', 'chatFolders.ts'), 'utf8'));
const chatUnread = strip(readFileSync(join(WEB, 'src', 'lib', 'notifications', 'chatUnread.ts'), 'utf8'));
const explicitLock = strip(readFileSync(join(WEB, 'src', 'lib', 'chat', 'explicitLock.ts'), 'utf8'));
const convView = strip(readFileSync(join(WEB, 'src', 'lib', 'components', 'ConversationView.svelte'), 'utf8'));

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean): void => {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}`);
	}
};

// ─── server: one row per discussion ──────────────────────────────────
check('conversations GROUP BY (peer, order_permlink) — not by peer', /GROUP BY peer, order_permlink/.test(conversations));
check('…and NOT the old peer-only grouping', !/GROUP BY peer\s*\n/.test(conversations));
check('newest discussion first', /ORDER BY g\.last_message_at DESC/.test(conversations));
check('the order owner is whichever PARTY owns it (not "the recipient")', /ord\.account IN \(\$1, g\.peer\)/.test(conversations));
check('…preferring the peer when both could match, deterministically', /ORDER BY \(ord\.account = g\.peer\) DESC/.test(conversations));
check('a thread with no order still yields a row (LEFT JOIN LATERAL … ON TRUE)', /LEFT JOIN LATERAL[\s\S]{0,240}\) o ON TRUE/.test(conversations));

// ─── server: every message carries its order ─────────────────────────
check('/v1/chat selects order_permlink', /SELECT id::text, sender, recipient, ciphertext, header, created_at, order_permlink/.test(chatApi));
check('/v1/chat returns it on each item', /order_permlink: r\.order_permlink/.test(chatApi));
check('the SSE row select carries it', /ROW_SELECT[\s\S]{0,200}order_permlink/.test(stream));
check('the sub-6s FAST PATH carries it too (else a live message jumps threads)', /order_permlink: ev\.orderPermlink/.test(stream));
check('…and the tailer parses it off the op body', /order_permlink[\s\S]{0,200}orderPermlink/.test(tailer));
check('the tailer shape-validates rather than trusting the signer', /rawPermlink\.length <= 256/.test(tailer));

// ─── the tag and the fee-bypass are DIFFERENT things ─────────────────
// Conflating them meant the ORDER OWNER could not reply in their own thread (a
// person is not the recipient of their own listing), and nobody could speak in a
// thread once the order was cancelled — precisely the "(Cancelled)" threads the
// inbox now shows. Caught only because the inbox began linking with `?order=`.
check('the tag is accepted when EITHER party owns the order', /account IN \(\$2, \$4\)/.test(chatHandler));
check('…and rejected when neither does (a tag is not a free-text field)', /return \{ ok: false, reason: 'order_permlink_not_found' \}/.test(chatHandler));
check('the stranger-fee bypass still requires the RECIPIENT to own a LIVE order', /orderResponseBypass = ord\.account === recipient && ord\.live;/.test(chatHandler));
check('…and liveness still excludes expired orders', /status = 'live' AND \(expires_at IS NULL OR expires_at > \$3\)/.test(chatHandler));
check('a cancelled order no longer rejects the message outright', !/status = 'live'[\s\S]{0,120}\) AS exists/.test(chatHandler));

// ─── client: the transcript is scoped to ONE thread ──────────────────
check('every inbound record is filtered to this thread', /if \(\(rec\.order_permlink \?\? null\) !== \(deps\.orderPermlink \?\? null\)\) continue;/.test(service));
check('…at the single seam every record passes through', /for \(const rec of oldestFirst\) \{[\s\S]{0,400}continue;/.test(service));
check('both outgoing sites (pending + failed) inherit the thread\u2019s order', (service.match(/orderPermlink: deps\.orderPermlink \?\? null/g) ?? []).length === 2);
check('wire messages keep the order they arrived with', (service.match(/orderPermlink: rec\.order_permlink \?\? null/g) ?? []).length === 2);
check('LocalMessage carries the order', /orderPermlink: string \| null;/.test(service));

// ─── client: the inbox renders discussions, email-inbox style (cp450) ─
check('the list is keyed on (peer, order), never on peer alone', /\{#each activeList as convo \(threadKey\(convo\)\)\}/.test(inbox));
check('…and the key separator cannot occur in a name or permlink', /\\u0000/.test(inbox));
check('a card opens its own thread, scoped by ?order=', /\$\{base\}\?order=\$\{encodeURIComponent\(c\.order\.permlink\)\}/.test(inbox));
check('an order-less card opens the plain conversation', /return c\.order \? .* : base;/.test(inbox));
check('the avatar is a uniform 40px on every card (t.txt 8)', /avatarSize=\{40\}/.test(inbox));

// t.txt item 12 — the "RE:" line is ALWAYS shown; "RE: -" when there is no order.
check('the RE: prefix renders unconditionally (not gated on convo.order)', /re_prefix'\)\}<\/span>\s*\{#if convo\.order\}/.test(inbox));
check('…with a "RE: -" fallback when the thread cites no order', /\{:else\}[\s\S]{0,140}truncate">-<\/span>/.test(inbox));
// t.txt item 16 — the RE: line is plain text now; the whole card opens the chat.
check('the RE: line no longer links to the order page', !/\/@\$\{convo\.order\.account\}\/\$\{convo\.order\.permlink\}/.test(inbox));
// t.txt item 9 — the per-card unread green dot is gone.
check('no per-card unread green dot', !/h-2 w-2 flex-none rounded-full bg-morphit-emerald/.test(inbox));

// ─── the three folders replace Messages/Requests (cp450) ─────────────
check('the tabs are the tri-state folder, not Messages/Requests', /type InboxTab = 'inbox' \| 'starred' \| 'archived'/.test(inbox));
check('Inbox is the default tab', /let activeTab = \$state<InboxTab>\('inbox'\)/.test(inbox));
check('all three tab labels render', /tab_inbox/.test(inbox) && /tab_starred/.test(inbox) && /tab_archived/.test(inbox));
check('the lists are folder-based', /inboxList = \$derived\(sortedConversations\.filter\(\(c\) => c\.folder === 'inbox'\)\)/.test(inbox) && /starredList = \$derived\(sortedConversations\.filter\(\(c\) => c\.folder === 'starred'\)\)/.test(inbox) && /archivedList = \$derived\(sortedConversations\.filter\(\(c\) => c\.folder === 'archived'\)\)/.test(inbox));
check('sorted by date newest-first, not unread-first (t.txt 6)', /withFlags\.sort\(\(a, b\) => b\.last_message_at\.localeCompare\(a\.last_message_at\)\)/.test(inbox) && !/if \(a\.unread && !b\.unread\) return -1/.test(inbox));
check('every card has a star to the right of the time (t.txt 11)', /handleToggleStar\(convo\)/.test(inbox) && /starred \? '★' : '☆'/.test(inbox));
check('every card has an Archive/Restore action box (t.txt 7)', /action_archive/.test(inbox) && /action_restore/.test(inbox) && /handleArchive\(convo\)/.test(inbox) && /handleRestore\(convo\)/.test(inbox));
check('no leftover Messages/Requests machinery', !/const engaged =/.test(inbox) && !/requestsList/.test(inbox) && !/tab_messages/.test(inbox) && !/tab_requests/.test(inbox));

// ─── the folder store: tri-state, default inbox, cleared on lock (cp450) ─
check('chatFolders is a tri-state per-discussion folder', /export type ChatFolder = 'inbox' \| 'starred' \| 'archived'/.test(chatFolders));
check('…default inbox = ABSENCE from the map', /entry \? entry\.folder : 'inbox'/.test(chatFolders));
check('…the star toggles inbox <-> starred', /isStarred\(peer, orderPermlink\) \? 'inbox' : 'starred'/.test(chatFolders));
check('…archive & restore exist', /export function archiveThread/.test(chatFolders) && /export function restoreThread/.test(chatFolders));
check('…keyed exactly like read-state (peer NUL order)', /\$\{peer\}\\u0000\$\{orderPermlink\}/.test(chatFolders));
check('the folder state is wiped on explicit lock (same privacy class as read-state)', /clearChatFolders\(\)/.test(explicitLock));

// ─── the chatroom star mirrors the inbox star (t.txt item 13) ────────
check('the chatroom kebab star toggles the SAME folder state', /toggleStar\(peer, orderPermlink \?\? ''\)/.test(convView) && /threadStarred \? '★' : '☆'/.test(convView));

// ─── the unread badge excludes archived discussions (t.txt item 10) ──
check('the favicon / avatar-menu count skips archived discussions', /isArchived\(c\.peer, order\)/.test(chatUnread));

// The FAQ describes this inbox to users; it must describe the NEW one.
const faqEn = JSON.parse(readFileSync(join(WEB, 'src', 'lib', 'i18n', 'locales', 'en.json'), 'utf8'));
const faq = faqEn.faq.entries.chat_inbox_features.a as string;
check('the FAQ says one card per discussion', /one card per discussion/i.test(faq));
check('…that reading one card marks only that one read', /only that one/i.test(faq));
check('…it describes the three folders Inbox / Starred / Archived', /\bInbox\b/.test(faq) && /\bStarred\b/.test(faq) && /\bArchived\b/.test(faq));
check('…the star, archive and restore actions', /star/i.test(faq) && /\bArchive\b/.test(faq) && /\bRestore\b/.test(faq));
check('…with no leftover Messages/Requests/Dismiss model', !/Messages tab/i.test(faq) && !/Requests tab/i.test(faq) && !/\bDismiss\b/.test(faq));

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} chat-inbox-threading scenarios passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} chat-inbox-threading checks FAILED`);
	process.exit(1);
}
