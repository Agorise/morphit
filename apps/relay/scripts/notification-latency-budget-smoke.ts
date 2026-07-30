#!/usr/bin/env tsx
/**
 * notification-latency-budget-smoke (cp450) — lock the "lightning-fast"
 * guarantee (<6s end-to-end) against regression.
 *
 * The end-to-end budget for a chat message / notification is ~6s:
 *   ~3s Blurt block  +  indexer index/enqueue  +  delivery hop.
 * The delivery hop is the part we control, and it has three tunable
 * constants. If any drifts up, notifications quietly get slow again
 * (this is exactly how the push drain sat at 30s). This smoke pins them:
 *
 *   - relay push-sender drain interval  — the Web Push (tab-closed) hop
 *   - chat inbox foreground poll          — the client backstop when SSE is down
 *   - chat unread-badge poll              — same backstop for the favicon/badge
 *
 * ...and asserts the chat live path is the real-time event BUS (instant),
 * with the 60s indexer poll as a labeled defense-in-depth backstop, not
 * the primary delivery mechanism.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..', '..', '..');
const read = (p: string): string => {
	try {
		return readFileSync(join(REPO, p), 'utf-8');
	} catch {
		return '';
	}
};

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.error(`  \u2717 ${name}${detail ? ` — ${detail}` : ''}`);
	}
};

// ── 1. Web Push drain interval (tab-closed delivery) ────────────────
const relayCfg = read('apps/relay/src/config/index.ts');
const pushDefault = (() => {
	// Grab the .default(N) that immediately follows the
	// MORPHIT_RELAY_PUSH_POLL_INTERVAL_MS declaration.
	const idx = relayCfg.indexOf('MORPHIT_RELAY_PUSH_POLL_INTERVAL_MS');
	if (idx < 0) return NaN;
	const tail = relayCfg.slice(idx, idx + 300);
	const m = tail.match(/\.default\((\d[\d_]*)\)/);
	return m ? Number(m[1].replace(/_/g, '')) : NaN;
})();
const PUSH_CEILING_MS = 3000; // must stay well under the ~6s budget
check(
	`relay push drain default \u2264 ${PUSH_CEILING_MS}ms (is ${pushDefault})`,
	Number.isFinite(pushDefault) && pushDefault <= PUSH_CEILING_MS,
	`got ${pushDefault} — a snappy drain is what keeps tab-closed notifications <6s`
);

// ── 2. chat inbox foreground poll (client backstop) ─────────────────
const inbox = read('apps/web/src/routes/[lang]/chat/+page.svelte');
const inboxPoll = (() => {
	const m = inbox.match(/POLL_MS\s*=\s*(\d[\d_]*)/);
	return m ? Number(m[1].replace(/_/g, '')) : NaN;
})();
check(
	`chat inbox POLL_MS \u2264 6000 (is ${inboxPoll})`,
	Number.isFinite(inboxPoll) && inboxPoll <= 6000,
	'the SSE bus is primary; this poll is only the backstop and must itself be within budget'
);

// ── 3. unread-badge poll (same backstop) ────────────────────────────
const unread = read('apps/web/src/lib/notifications/chatUnread.ts');
const unreadPoll = (() => {
	const m = unread.match(/POLL_MS\s*=\s*(\d[\d_]*)/);
	return m ? Number(m[1].replace(/_/g, '')) : NaN;
})();
check(
	`unread-badge POLL_MS \u2264 6000 (is ${unreadPoll})`,
	Number.isFinite(unreadPoll) && unreadPoll <= 6000
);

// ── 4. chat live path is the real-time bus, not the fallback poll ────
const stream = read('apps/indexer/src/api/chatStream.ts');
check(
	'chat stream primary path is the real-time event bus (subscribes to the poller bus)',
	/real time without polling/.test(stream) && /bus/.test(stream)
);
check(
	'the 60s indexer poll is explicitly a defense-in-depth backstop, not the primary',
	/Defense-in-depth poll/.test(stream) && /FALLBACK_POLL_MS\s*=\s*60_000/.test(stream)
);

console.log('');
if (fail === 0) console.log(`\u2713 all ${pass} notification-latency-budget scenarios passed`);
else {
	console.error(`\u2717 ${fail} of ${pass + fail} notification-latency-budget checks FAILED`);
	process.exit(1);
}
