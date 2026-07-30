/**
 * chat-bg-notify-v148-smoke — v1.4.8 (t.txt #6)
 *
 * A backgrounded morphit tab must still update its favicon/title unread badge
 * when a new message arrives — that's the whole point of a background
 * notification. The regression was a `!document.hidden` guard on the
 * global-chat-activity ping handler, which dropped the ping (and the badge
 * refresh) whenever the tab was hidden. Pin that the ping handler is NOT gated
 * on visibility, while the idle interval backstop MAY stay gated.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = readFileSync(join(repo, 'apps/web/src/lib/notifications/chatUnread.ts'), 'utf8');

let failures = 0;
let total = 0;
function check(name: string, cond: boolean): void {
	total++;
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

// Isolate the subscribeChatActivity(...) callback body.
const m = src.match(/subscribeChatActivity\(\(\)\s*=>\s*\{([\s\S]*?)\}\);/);
check('the chat-activity ping handler exists', m !== null);
const pingBody = m?.[1] ?? '';

check(
	'the activity-ping handler polls unconditionally (updates the badge even when hidden)',
	/void poll\(\);/.test(pingBody) && !/document\.hidden/.test(pingBody)
);
check(
	'the interval backstop is still present (idle polling stays gated is fine)',
	/setInterval\(/.test(src)
);
check(
	'a visibilitychange catch-up poll still exists',
	/addEventListener\('visibilitychange'/.test(src)
);

if (failures === 0) {
	console.log(`✓ all ${total} chat-bg-notify-v148 scenarios passed`);
} else {
	console.log(`\n✗ ${failures} chat-bg-notify-v148 scenarios failed`);
	process.exit(1);
}
