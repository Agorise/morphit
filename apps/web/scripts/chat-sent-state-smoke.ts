/**
 * chat-sent-state-smoke — v1.4.8 (t.txt)
 *
 * A sent message stops reading "sending…" the instant the broadcast succeeds
 * (fast perceived send), and then the bubble goes CLEAN — no checkmark, no
 * "Sent" label (Ken found that annoying). "sending…" shows ONLY while `pending`;
 * `broadcast`/`confirmed` render no status. Tamper-tested.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const src = readFileSync(join(repo, 'apps/web/src/lib/components/ChatMessage.svelte'), 'utf8');
const en = JSON.parse(
	readFileSync(join(repo, 'apps/web/src/lib/i18n/locales/en.json'), 'utf8')
) as { chat: { message: Record<string, string> } };

let failures = 0;
function check(name: string, cond: boolean): void {
	console.log(`  ${cond ? '✓' : '✗'} ${name}`);
	if (!cond) failures++;
}

check(
	'"sending…" shows ONLY while pending (isSending === state pending)',
	/const isSending = \$derived\(message\.state === 'pending'\)/.test(src)
);
check(
	'"sending…" does NOT persist through the broadcast state',
	!/message\.state === 'pending' \|\| message\.state === 'broadcast'/.test(src)
);
check(
	'the broadcast state shows NO checkmark / "Sent" indicator',
	!/isSent/.test(src) && !/M20 6 9 17l-5-5/.test(src) && !/chat\.message\.sent\b/.test(src)
);
check('the dead chat.message.sent label is removed', en.chat.message.sent === undefined);
check(
	'the meta line only renders for pending or failed (clean once sent)',
	/\{#if isSending \|\| isFailed\}/.test(src)
);
check(
	'the bubble is dimmed only while actively sending (opacity-80 on isSending)',
	/class:opacity-80=\{isSending\}/.test(src) && !/class:opacity-80=\{isInFlight\}/.test(src)
);

if (failures === 0) {
	console.log('✓ all 6 chat-sent-state scenarios passed');
} else {
	console.log(`\n✗ ${failures}/6 chat-sent-state scenarios failed`);
	process.exit(1);
}
