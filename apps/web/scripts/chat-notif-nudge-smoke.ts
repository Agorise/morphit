#!/usr/bin/env tsx
/**
 * chat-notif-nudge-smoke — locks down the "turn on chat notifications"
 * nudge shown the first time a user opens a trade chat thread.
 *
 * Guards:
 *   1. shouldShowChatNudge() truth table — shows ONLY when push is
 *      supported, the user is signed in, it hasn't been dismissed, and
 *      chat pings aren't already active.
 *   2. The nudge rides the EXISTING web-push system only: the component
 *      enables via subscribe() + setChannel('push',true) +
 *      setCategory('chat',true), and references NO contact-address field
 *      (no email/matrix/nostr) — privacy: opaque endpoint, no PII.
 *   3. Wiring: ConversationView imports + renders ChatNotificationNudge
 *      with the peer prop.
 *   4. Locale parity: all 10 locales carry chat_notif_nudge with the
 *      same keys (a fast local check; i18n-key-coverage is the roster's
 *      authority).
 *
 * On success prints exactly one canonical line at column 0:
 *   ✓ all N chat-notif-nudge-smoke scenarios passed
 */

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { shouldShowChatNudge, CHAT_NUDGE_DISMISSED_KEY } from '../src/lib/notifications/chatNudge.ts';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');

let checks = 0;
const failures: string[] = [];
function check(label: string, cond: boolean): void {
	checks++;
	if (!cond) failures.push(label);
}

// ── 1. shouldShowChatNudge truth table ──────────────────────────
const base = { supported: true, loggedIn: true, dismissed: false, chatPingsActive: false };
check('all conditions met → show', shouldShowChatNudge(base) === true);
check('push unsupported → hide', shouldShowChatNudge({ ...base, supported: false }) === false);
check('not signed in → hide', shouldShowChatNudge({ ...base, loggedIn: false }) === false);
check('dismissed → hide', shouldShowChatNudge({ ...base, dismissed: true }) === false);
check('chat pings already active → hide', shouldShowChatNudge({ ...base, chatPingsActive: true }) === false);
check('dismissed key is namespaced', /^morphit\./.test(CHAT_NUDGE_DISMISSED_KEY));

// ── 2. Component rides web-push only (no contact-address field) ──
const comp = readFileSync(join(webRoot, 'src', 'lib', 'components', 'ChatNotificationNudge.svelte'), 'utf8');
check("component calls subscribe()", /subscribeToPush\(|subscribe as subscribeToPush/.test(comp));
check("component enables the push channel", /setChannel\('push',\s*true\)/.test(comp));
check("component enables the chat category", /setCategory\('chat',\s*true\)/.test(comp));
// Inspect CODE only (strip comments) — the doc comment legitimately
// explains "no email/phone/Matrix address", which must not trip this.
const compCode = comp
	.replace(/<!--[\s\S]*?-->/g, '')
	.replace(/\/\*[\s\S]*?\*\//g, '')
	.replace(/\/\/[^\n]*/g, '');
check(
	'component code stores NO email/matrix/nostr address (privacy: opaque push only)',
	!/\b(email|mxid|matrix|nostr|npub)\b/i.test(compCode)
);

// ── 3. ConversationView wiring ──────────────────────────────────
const cv = readFileSync(join(webRoot, 'src', 'lib', 'components', 'ConversationView.svelte'), 'utf8');
check('ConversationView imports ChatNotificationNudge', /import ChatNotificationNudge from/.test(cv));
check('ConversationView renders <ChatNotificationNudge {peer} />', /<ChatNotificationNudge\s+\{peer\}\s*\/>/.test(cv));

// ── 4. Locale parity (fast local check) ─────────────────────────
const locDir = join(webRoot, 'src', 'lib', 'i18n', 'locales');
const locales = readdirSync(locDir).filter((f) => f.endsWith('.json'));
check('exactly 10 locale files present', locales.length === 10);
const REQUIRED_KEYS = [
	'aria_label',
	'prompt',
	'turn_on',
	'not_now',
	'dismiss_aria',
	'enabling',
	'enabled',
	'privacy_note'
];
for (const f of locales) {
	const data = JSON.parse(readFileSync(join(locDir, f), 'utf8')) as Record<string, unknown>;
	const block = data['chat_notif_nudge'] as Record<string, unknown> | undefined;
	const ok = !!block && REQUIRED_KEYS.every((k) => typeof block[k] === 'string' && (block[k] as string).length > 0);
	check(`${f}: chat_notif_nudge has all ${REQUIRED_KEYS.length} keys`, ok);
	// {peer} placeholder must be preserved in every locale's prompt.
	check(`${f}: prompt keeps the {peer} placeholder`, !!block && /\{peer\}/.test(String(block['prompt'] ?? '')));
}

// ── Result ──────────────────────────────────────────────────────
if (failures.length > 0) {
	console.error(`chat-notif-nudge-smoke: ${failures.length} FAILED of ${checks}:`);
	for (const f of failures) console.error(`  ✗ ${f}`);
	process.exit(1);
}
console.log(`✓ all ${checks} chat-notif-nudge-smoke scenarios passed`);
