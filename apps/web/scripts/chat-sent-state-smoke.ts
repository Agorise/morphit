/**
 * chat-sent-state-smoke — cp453 (t.txt #8, ~60s perceived send time)
 *
 * The broadcast is fast (~3s) but a message stayed "sending…" until `confirmed`,
 * which waits on the ~45s-behind indexer read-back — so a sent message looked
 * stuck for ~a minute. Fix: the moment the broadcast succeeds (`broadcast`
 * state) the bubble shows a light "✓ Sent" (single-tick) instead of holding
 * "sending…"; only `pending` reads "sending…"; `confirmed` stays clean. This
 * decouples the sender's PERCEIVED send time from follower/SSE lag entirely.
 * Source-level invariants, tamper-tested.
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
	'"sending…" is shown ONLY while pending (isSending === state pending)',
	/const isSending = \$derived\(message\.state === 'pending'\)/.test(src)
);
check(
	'a "Sent" state exists for a successful broadcast (isSent === state broadcast)',
	/const isSent = \$derived\(message\.state === 'broadcast'\)/.test(src)
);
check(
	'the meta line no longer holds "sending…" through the broadcast state',
	!/message\.state === 'pending' \|\| message\.state === 'broadcast'/.test(src)
);
check(
	'the broadcast state renders a light ✓ "Sent" (single-tick, checkmark + label)',
	/\{#if isSending\}[\s\S]*?chat\.message\.sending[\s\S]*?\{:else if isSent\}[\s\S]*?M20 6 9 17l-5-5[\s\S]*?chat\.message\.sent/.test(
		src
	)
);
check(
	'the bubble is dimmed only while actively sending (opacity-80 on isSending)',
	/class:opacity-80=\{isSending\}/.test(src) && !/class:opacity-80=\{isInFlight\}/.test(src)
);
check('the chat.message.sent label exists', Boolean(en.chat.message.sent));

if (failures === 0) {
	console.log('✓ all 6 chat-sent-state scenarios passed');
} else {
	console.log(`\n✗ ${failures}/6 chat-sent-state scenarios failed`);
	process.exit(1);
}
