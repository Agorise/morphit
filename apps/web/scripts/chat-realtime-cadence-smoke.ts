#!/usr/bin/env tsx
/**
 * Smoke: chat surfaces (messages, inbox, notifications) stay inside the ≤6s
 * "fastchat" window. Anchor 2026-07-08.
 *
 * THE BUGS THIS GUARDS AGAINST:
 *   - The chat message fallback poll was 60s, so when the SSE was flaky
 *     messages crawled in a full minute late ("chat is WAY too slow").
 *   - The inbox loaded once on mount with no refresh, so new messages /
 *     requests never appeared and a just-read conversation kept a stale dot +
 *     "N min ago" until a manual reload.
 *   - The global chat-unread poll (avatar/tab badge) was 60s.
 *
 * Locks all three cadences ≤6s and the inbox real-time refresh in place.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');

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

function num(src: string, name: string): number | null {
	const m = new RegExp(`const ${name}\\s*=\\s*([0-9_]+)`).exec(src);
	return m ? Number(m[1].replace(/_/g, '')) : null;
}

const svc = readFileSync(join(WEB, 'src', 'lib', 'chat', 'chatService.ts'), 'utf8');
const base = num(svc, 'FALLBACK_POLL_INTERVAL_MS');
const jitter = num(svc, 'POLL_JITTER_MS');
check('chatService FALLBACK_POLL_INTERVAL_MS is defined', base !== null);
check('chatService POLL_JITTER_MS is defined', jitter !== null);
check(
	`chat message fallback worst-case (base+jitter) \u2264 6s (was 60s) — got ${base}+${jitter}`,
	base !== null && jitter !== null && base + jitter <= 6_000
);

const cu = readFileSync(join(WEB, 'src', 'lib', 'notifications', 'chatUnread.ts'), 'utf8');
const cuPoll = num(cu, 'POLL_MS');
check(
	`chat-unread (badge/tab) poll \u2264 6s — got ${cuPoll}`,
	cuPoll !== null && cuPoll <= 6_000
);

const inbox = readFileSync(join(WEB, 'src', 'routes', '[lang]', 'chat', '+page.svelte'), 'utf8');
check('inbox has a refresh() that re-fetches conversations', /async function refresh\(/.test(inbox));
check(
	'inbox polls on an interval (real-time) + a visibility listener',
	/setInterval\(/.test(inbox) && /visibilitychange/.test(inbox)
);
const inboxPoll = num(inbox, 'POLL_MS');
check(`inbox poll \u2264 6s — got ${inboxPoll}`, inboxPoll !== null && inboxPoll <= 6_000);
check(
	'inbox cleans up its poll + listener onDestroy (no leak)',
	/onDestroy\(/.test(inbox) && /clearInterval\(/.test(inbox)
);
check(
	'inbox background-poll failures keep the last list (fallback only on initial load)',
	/if \(initial\) await fallbackToRecentPeers\(\)/.test(inbox)
);

// ── Global chat-activity SSE (sub-second, privacy-preserving) ───────────────
const gcas = readFileSync(join(WEB, 'src', 'lib', 'chat', 'globalChatActivityStream.ts'), 'utf8');
check(
	'global chat-activity SSE connects same-origin to /v1/chat-activity/:me/stream',
	/new EventSource\(`\/v1\/chat-activity\/\$\{encodeURIComponent\(me\)\}\/stream`\)/.test(gcas)
);
check(
	'global SSE exports start + subscribe',
	/export function startGlobalChatActivity/.test(gcas) &&
		/export function subscribeChatActivity/.test(gcas)
);
check(
	'global SSE debounces bursts (no refresh storm from a spammer)',
	/FIRE_DEBOUNCE_MS/.test(gcas)
);
check(
	'the ambient chat-unread channel starts the global SSE + re-polls on its ping',
	/startGlobalChatActivity\(\)/.test(cu) && /subscribeChatActivity\(/.test(cu)
);
check(
	'the inbox refreshes on the global SSE ping (sub-second) reusing the ambient stream',
	/subscribeChatActivity\(/.test(inbox)
);

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} chat-realtime-cadence scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} chat-realtime-cadence checks FAILED`);
	process.exit(1);
}
