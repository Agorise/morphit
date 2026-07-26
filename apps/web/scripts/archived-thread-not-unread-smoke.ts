#!/usr/bin/env tsx
/**
 * apps/web/scripts/archived-thread-not-unread-smoke.ts  (v1.9.0, Ken kentest3)
 *
 * A thread archived+read on ANOTHER device arrived here archived (folder state syncs
 * on chain) but cursorless (the read cursor is per-device localStorage), so the inbox
 * lit an emerald "unread" border on a read card in the Archived tab. Archiving is a
 * deliberate "I'm done with this" that outranks the per-device cursor. Pins:
 *   - the inbox per-thread `unread` flag is gated on folder !== 'archived'
 *   - the global badge already excludes archived (badgeEligible ends in !isArchived)
 *     on BOTH the durable loop and the fast-pending loop
 *   - a genuinely-new-activity pending placeholder still counts (resurrection moves
 *     it to Inbox), so the fix can't silence real new messages
 *
 * Greps strip comments first.
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Inbox page: the durable per-thread unread flag is folder-gated.
{
	const page = read(resolve(SRC, 'routes', '[lang]', 'chat', '+page.svelte'));
	/folder\s*!==\s*'archived'\s*&&\s*[\r\n\s]*threadIsUnread\(/.test(page)
		? ok('inbox durable card: unread = folder !== archived && threadIsUnread(...)')
		: bad('inbox durable card gated on folder');
	// unreadTotal + per-tab counts already exclude archived (kept for lockstep)
	/c\.folder\s*!==\s*'archived'\s*&&\s*c\.unread/.test(page)
		? ok('unreadTotal excludes archived')
		: bad('unreadTotal excludes archived');
	// the fast-pending PLACEHOLDER stays unread:true — that IS new activity
	/unread:\s*true/.test(page)
		? ok('new-activity pending placeholder still counts (not silenced)')
		: bad('pending placeholder still counts');
}

// Global badge channel: archived excluded in both loops.
{
	const cu = read(resolve(SRC, 'lib', 'notifications', 'chatUnread.ts'));
	/return\s*!isArchived\(/.test(cu)
		? ok('badgeEligible ends in !isArchived')
		: bad('badgeEligible excludes archived');
	// recount reacts to folder-store changes so it settles once folders sync
	/chatFolders\.subscribe\(\(\)\s*=>\s*recount\(\)\)/.test(cu)
		? ok('badge recounts on folder-store changes')
		: bad('badge recounts on folder changes');
	// the fast-pending loop applies the SAME badgeEligible gate
	/badgeEligible\(\{\s*peer,\s*order/.test(cu)
		? ok('fast-pending loop applies badgeEligible (archived excluded)')
		: bad('fast-pending applies badgeEligible');
}

console.log('\n' + '\u2500'.repeat(56));
if (fail > 0) {
	console.log(`\u2717 archived-thread-not-unread smoke FAILED (${fail})`);
	process.exit(1);
}
console.log('\u2713 archived threads never read as unread (cards + badge); new activity still surfaces');
console.log(`\u2713 all ${pass} archived-thread-not-unread scenarios passed`);
