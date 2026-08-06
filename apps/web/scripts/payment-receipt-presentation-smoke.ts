#!/usr/bin/env tsx
/**
 * payment-receipt-presentation — cp474 (t.txt #8).
 *
 * Ken, on live morphit.io, listed three things wrong with the Payment Receipt
 * bubble. All three are presentation living in a .svelte file, which no vitest
 * can reach, so they are pinned here.
 *
 *   (a) "get rid of the underline that appears under the magnifying glass and
 *       its 'Verify on block explorer' text ... only show that underline (as
 *       dots) when i mouseover it."
 *
 *   (b) "where it says 'BLURT SENT|RECEIVED' change that text to say 'BLURT
 *       SENT|RECEIVED on 14 May, 2026 @ 05:03:22 UTC' and remove that date/time
 *       from everywhere else on the Payment Receipt. right now, when you
 *       mouseover anywhere on the payment receipt, that date/time alt text
 *       appears and it's annoying."
 *
 *   (c) "the entire Payment Receipt bubble seems to be hyperlinked to nothing,
 *       so please remove that hyperlink from the card itself."
 *
 * (b) and (c) were ONE mechanism, which is why they arrived together: the
 * bubble carried `title={fullTimestamp}` — a native tooltip that fires anywhere
 * over the card and can't be styled or dismissed — plus `cursor-pointer` and an
 * onclick, which is what made it look like a link to nowhere. The click only
 * toggled a popover showing that same timestamp. A receipt is a document: the
 * time belongs printed on its face, and once it is there the popover is a
 * duplicate of something already on screen. So the receipt opts out of the
 * affordance entirely.
 *
 * Ordinary message bubbles MUST keep it (cp402 [5]): their timestamp is printed
 * nowhere, so tap-to-reveal is the only way to see it. Removing the popover
 * wholesale would fix Ken's receipt and silently break every other bubble —
 * this smoke pins both halves.
 *
 * Tamper tests (each must turn this smoke red):
 *   - Put `underline` back on the verify link's resting state → fails.
 *   - Restore `title={fullTimestamp || undefined}` on the bubble → fails.
 *   - Make `timestampRevealable` ignore isReceipt → fails.
 *   - Drop the timestamp from the SENT/RECEIVED line → fails.
 *   - Remove the tap-to-reveal popover from ordinary bubbles → fails.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SUPPORTED_LOCALES } from '../src/lib/i18n/locales';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
// Derived, never hand-listed — `locale-source-of-truth-smoke` caught exactly this
// in the first battery run after this file was written, and it was right to: an
// inline array silently stops covering locale #11 the day one is added, while
// still reporting green.
const LOCALES = SUPPORTED_LOCALES.map((l) => l.code);

function read(rel: string): string {
	return readFileSync(join(REPO, rel), 'utf8');
}

let passed = 0;
let failed = 0;

function check(name: string, cond: boolean, detail = ''): void {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
}

console.log('\n── payment-receipt-presentation (cp474 / t.txt #8) ────\n');

const msg = read('apps/web/src/lib/components/ChatMessage.svelte');

// ─── (a) the verify link's underline is hover/focus-only, dotted ─
const verifyLink =
	/<a\s+href=\{lp\(verifyPath\)\}\s+class="([^"]*)"/.exec(msg)?.[1] ?? '';
check('the "Verify on block explorer" link was found', verifyLink.length > 0);
check(
	'(a) no underline at rest',
	verifyLink.includes('no-underline') && !/(^|\s)underline(\s|$)/.test(verifyLink),
	`class was: ${verifyLink.slice(0, 120)}…`
);
check('(a) underline appears on hover', verifyLink.includes('hover:underline'));
check('(a) …and it is DOTTED, per Ken', verifyLink.includes('decoration-dotted'));
check(
	'(a) keyboard users get the same dots (no pointer to reveal them with)',
	verifyLink.includes('focus-visible:underline')
);

// ─── (b)+(c) the receipt opts out of the timestamp affordance ────
check(
	'(b/c) a receipt is identified for presentation purposes',
	/const isReceipt = \$derived\(decoded\?\.kind === 'funds_sent'\)/.test(msg)
);
check(
	'(b/c) the timestamp affordance is gated on NOT being a receipt',
	/const timestampRevealable = \$derived\(fullTimestamp !== '' && !isReceipt\)/.test(msg),
	'without !isReceipt the tooltip + pseudo-link come straight back'
);
check(
	'(b) the bubble tooltip is suppressed on a receipt',
	/title=\{timestampRevealable \? fullTimestamp : undefined\}/.test(msg),
	'a bare title={fullTimestamp} fires anywhere over the card — the "annoying" mouseover'
);
check(
	'(c) the pointer cursor (the "hyperlink to nothing") is gone on a receipt',
	/class:cursor-pointer=\{timestampRevealable\}/.test(msg)
);
check(
	'(c) the click handler no-ops on a receipt',
	/function onBubbleActivate[\s\S]{0,240}?if \(!timestampRevealable\) return;/.test(msg)
);

// ─── (b) the timestamp is printed ON the SENT/RECEIVED line ──────
check(
	'(b) the SENT/RECEIVED line prints the timestamp',
	/chat\.funds_sent\.receipt_when[\s\S]{0,60}?values: \{ when: fullTimestamp \}/.test(msg),
	'this is the "remove it from everywhere else" half — it has to be SOMEWHERE'
);
check(
	'(b) the printed timestamp uses the canonical sitewide formatter',
	/formatDayMonthTime/.test(msg),
	'a second date format on one card is how a date standard dies'
);
check(
	'(b) the uppercase pill row does not shout the month name',
	/normal-case/.test(msg),
	'the row is `uppercase`; without normal-case it renders "14 MAY, 2026"'
);

// ─── ordinary bubbles must KEEP the popover ──────────────────────
check(
	'ordinary (non-receipt) bubbles still reveal their timestamp on tap',
	/showTimestamp = !showTimestamp/.test(msg),
	'their timestamp is printed nowhere — removing this would break every other bubble to fix the receipt'
);

// ─── locale parity: all ten, same turn ───────────────────────────
for (const loc of LOCALES) {
	const json = JSON.parse(read(`apps/web/src/lib/i18n/locales/${loc}.json`)) as {
		chat?: { funds_sent?: Record<string, string> };
	};
	const v = json.chat?.funds_sent?.receipt_when;
	check(
		`locale ${loc}: receipt_when present and carries {when}`,
		typeof v === 'string' && v.includes('{when}'),
		v === undefined ? 'missing' : `got ${JSON.stringify(v)}`
	);
}

console.log(`\n${'─'.repeat(54)}`);
if (failed === 0) {
	console.log(`✓ all ${passed} payment-receipt-presentation checks passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed}/${passed + failed} payment-receipt-presentation checks failed`);
	process.exit(1);
}
