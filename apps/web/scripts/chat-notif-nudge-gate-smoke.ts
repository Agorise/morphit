#!/usr/bin/env tsx
/**
 * apps/web/scripts/chat-notif-nudge-gate-smoke.ts  (v1.9.0, Ken)
 *
 * The in-chat "turn on notifications" nudge kept prompting users who had ALREADY
 * enabled "Push notifications (tab closed)". Two root causes, both pinned here:
 *   (1) the nudge hard-required a live currentSubscription() probe, which returns
 *       null on a not-yet-ready service worker (and threw → false), re-nagging on a
 *       cold load. It now gates on the DURABLE intent the Settings page shows:
 *       channels.push && categories.chat. The probe import is gone.
 *   (2) categories.chat must default ON (so a fresh push opt-in delivers chat), with
 *       a one-time migration carrying that to anyone who persisted the old false.
 *
 * shouldShowChatNudge is imported and exercised directly. Source greps strip comments.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { shouldShowChatNudge } from '../src/lib/notifications/chatNudge';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, '..', 'src');
let pass = 0,
	fail = 0;
const ok = (m: string) => (pass++, console.log(`  \u2713 ${m}`));
const bad = (m: string, d = '') => (fail++, console.log(`  \u2717 ${m}${d ? `\n      ${d}` : ''}`));
const strip = (s: string) =>
	s
		.replace(/\/\*[\s\S]*?\*\//g, '')
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
const read = (p: string) => strip(readFileSync(p, 'utf8'));

// shouldShowChatNudge: shows only when supported + loggedIn + !dismissed + pings OFF.
{
	const show = (o: Partial<Parameters<typeof shouldShowChatNudge>[0]>) =>
		shouldShowChatNudge({
			supported: true,
			loggedIn: true,
			dismissed: false,
			chatPingsActive: false,
			...o
		});
	show({}) === true ? ok('shows when chat pings are OFF') : bad('shows when pings off');
	show({ chatPingsActive: true }) === false
		? ok('suppresses when chat pings are ON')
		: bad('suppresses when pings on');
	show({ dismissed: true }) === false ? ok('suppresses when dismissed') : bad('dismissed suppresses');
	show({ supported: false }) === false ? ok('suppresses when unsupported') : bad('unsupported suppresses');
	show({ loggedIn: false }) === false ? ok('suppresses when signed out') : bad('signed-out suppresses');
}

// The nudge gates on DURABLE prefs, not the flaky live probe.
{
	const n = read(resolve(SRC, 'lib', 'components', 'ChatNotificationNudge.svelte'));
	/chatPingsActive\s*=\s*prefs\.channels\.push\s*&&\s*prefs\.categories\.chat/.test(n)
		? ok('nudge gates on channels.push && categories.chat (durable)')
		: bad('nudge gates on durable prefs');
	// the flaky probe must be gone from the show-decision path
	!/currentSubscription/.test(n)
		? ok('currentSubscription probe removed from the nudge')
		: bad('currentSubscription still referenced in the nudge');
}

// categories.chat defaults ON, and a one-time migration carries it forward.
{
	const p = read(resolve(SRC, 'lib', 'notifications', 'preferences.ts'));
	/categories:\s*\{\s*order:\s*true,\s*chat:\s*true,\s*feedback:\s*true\s*\}/.test(p)
		? ok('DEFAULTS.categories.chat is true')
		: bad('DEFAULTS.categories.chat is true');
	/function migrateEnableChatByDefault/.test(p) && /CHAT_DEFAULT_ON_KEY/.test(p)
		? ok('one-time chat-default-on migration present')
		: bad('chat-default-on migration present');
}

console.log('\n' + '\u2500'.repeat(56));
if (fail > 0) {
	console.log(`\u2717 chat-notif-nudge-gate smoke FAILED (${fail})`);
	process.exit(1);
}
console.log('\u2713 nudge respects durable push+chat opt-in; no flaky probe; chat defaults on');
console.log(`\u2713 all ${pass} chat-notif-nudge-gate scenarios passed`);
