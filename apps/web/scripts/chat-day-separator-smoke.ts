#!/usr/bin/env tsx
/**
 * Smoke: the chat log carries a subtle, locale-aware day divider at the first
 * message of each UTC day (Ken, 2026-07-08).
 *
 * "Scroll back through hundreds of old messages and land on a specific day's
 * conversation." The divider is a hairline running the full width of the log
 * with the date centred just above it — informational, never interactive.
 *
 * The grouping rules (UTC day key; pending messages inherit the previous day)
 * live in `$lib/chat/daySeparator` and are unit-tested in daySeparator.test.ts;
 * this smoke guards the WIRING and the visual contract.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB = join(__dirname, '..');
const cv = readFileSync(join(WEB, 'src', 'lib', 'components', 'ConversationView.svelte'), 'utf8');
const helper = readFileSync(join(WEB, 'src', 'lib', 'chat', 'daySeparator.ts'), 'utf8');

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

// ─── helper contract ─────────────────────────────────────────────────
check('daySeparator helper exists and is pure (no Svelte/store imports)', /export function daySeparatorAt/.test(helper) && !/svelte/.test(helper));
check('grouping key is UTC (matches formatDayMonth, which renders in UTC)', /getUTCFullYear\(\)/.test(helper) && /getUTCMonth\(\)/.test(helper) && /getUTCDate\(\)/.test(helper));
check('a pending message (createdAt null) never gets a divider', /if \(!at\) return null;/.test(helper));
check('pending messages are skipped when comparing to the previous day', /for \(let j = i - 1; j >= 0; j--\)/.test(helper));
check('the first timestamped message in the log IS labelled', /No earlier timestamped message/.test(helper));

// ─── wiring ──────────────────────────────────────────────────────────
check('ConversationView imports the shared helper', /import \{ daySeparatorAt \} from '\$lib\/chat\/daySeparator';/.test(cv));
check('label uses the sitewide locale-aware date (formatDayMonth)', /formatDayMonth\(at\)/.test(cv) && /formatDayMonth/.test(cv));
check('separator is computed per message inside the log loop', /\{@const daySep = daySeparatorLabelAt\(visibleMessages, i\)\}/.test(cv));
check('divider renders only when a label exists', /\{#if daySep\}/.test(cv));

// ─── visual contract ─────────────────────────────────────────────────
check('divider is an <li> (valid child of the role=log <ul>)', /<li class="chat-day-separator/.test(cv));
// Whitespace-flattened + a window wide enough to span the tooltip wrapper.
// The original 120-char gap between `text-center` and `{daySep}` was a FALSE
// NEGATIVE the moment anything legitimately sat between them — v1.5.0 added
// the midnight-UTC `title` tooltip span (and its comment), and this failed
// while the visual contract it guards was perfectly intact. What actually
// matters is the ORDER: a centred date, then the hairline rule beneath it.
check(
	'date is centred ABOVE the line',
	/text-center[\s\S]{0,400}\{daySep\}[\s\S]{0,200}h-px w-full/.test(cv.replace(/\s+/g, ' '))
);
check('the rule spans the full width and is a hairline (h-px)', /h-px w-full bg-ink-200 dark:bg-ink-800/.test(cv));
check('subtle: small, muted, non-interactive (no button/anchor)', /text-\[11px\][\s\S]{0,80}text-ink-400/.test(cv) && !/<button[^>]*chat-day-separator/.test(cv));
check('accessible: exposed as a separator with the date as its label', /role="separator"[\s\S]{0,60}aria-label=\{daySep\}/.test(cv));

console.log('');
if (fail === 0) {
	console.log(`\u2713 all ${pass} chat-day-separator scenarios passed`);
} else {
	console.error(`\u2717 ${fail} of ${pass + fail} chat-day-separator checks FAILED`);
	process.exit(1);
}
