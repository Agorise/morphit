/**
 * chat-notif-default-on-smoke — cp453 (t.txt)
 *
 * Chat-message notifications must be ON for EVERY user by default. Two parts:
 *   - new users: DEFAULTS.categories.chat === true;
 *   - existing users who persisted prefs before the chat default flipped
 *     false→true (cp450) carry a stale chat:false that overrides the default — a
 *     one-time migration flips it on, guarded by a done-flag so it runs once and
 *     never re-enables against a LATER explicit opt-out.
 * Source-level invariants, tamper-tested.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = readFileSync(join(repo, 'apps/web/src/lib/notifications/preferences.ts'), 'utf8');

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

// 1. New users: chat is on by default.
check(
	'DEFAULTS.categories.chat is true (new users get chat notifications)',
	/categories:\s*\{\s*order:\s*true,\s*chat:\s*true,\s*feedback:\s*true\s*\}/.test(src)
);

// 2. A one-time migration flips a persisted chat:false → true.
check(
	'a migration enables chat for existing prefs (flips !categories.chat → true)',
	/function migrateEnableChatByDefault/.test(src) &&
		/if \(!prefs\.categories\.chat\)/.test(src) &&
		/categories: \{ \.\.\.prefs\.categories, chat: true \}/.test(src)
);

// 3. It's actually wired into the store's initial value.
check(
	'the migration runs on store init (chained into the writable)',
	/migrateEnableChatByDefault\(migrateLegacyTradeNotifications\(hydrate\(\)\)\)/.test(src)
);

// 4. One-time + opt-out-safe: guarded by a done-flag set before any flip.
check(
	'it runs exactly once (done-flag) so a later explicit opt-out is never overridden',
	/CHAT_DEFAULT_ON_KEY/.test(src) &&
		/safeLocal\.get\(CHAT_DEFAULT_ON_KEY\) !== null\) return prefs/.test(src) &&
		/safeLocal\.set\(CHAT_DEFAULT_ON_KEY/.test(src)
);

if (failures === 0) {
	console.log('✓ all 4 chat-notif-default-on scenarios passed');
} else {
	console.log(`\n✗ ${failures}/4 chat-notif-default-on scenarios failed`);
	process.exit(1);
}
