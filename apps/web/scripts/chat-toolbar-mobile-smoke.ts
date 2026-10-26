#!/usr/bin/env tsx
/**
 * Smoke: the chat's bottom toolbar and its "Regarding …" line on a phone, and
 * the inbox subject read from the reader's side (v1.21.16).
 *
 *   - The toolbar stacks its buttons on a phone (flex-col), side by side from
 *     `sm` up; every button there is full width and at least 44 px tall on a
 *     phone, compact from `sm` up, and keeps the one shared green outlined
 *     style (v1.4.8: no lone solid button).
 *   - The money-flow buttons take their labels from chatMoneyFlowLabels (they
 *     name the coin: "Send BLURT", "Share your XMR address"), never a fixed
 *     "Pay now" / "Share crypto address" key.
 *   - The header's order line takes its label and voice from chatOrderHeading
 *     ("Regarding my order: I'm buying …" / "Regarding @alice's order:
 *     Buying …"); on a phone the title gets a line of its own.
 *   - The inbox card's subject uses the same voice: the peer's order in the
 *     third person, mine in the first.
 *   - The address modal opened from the toolbar offers only the order's coin.
 *   - The PDF export heads this order's messages with the same reader-side line.
 *
 * The rendered labels are pinned by ConversationView.moneyFlow.test.ts; this
 * pins the layout classes and the wiring a render test cannot see.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..');
const strip = (s: string): string =>
	s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
const cv = strip(
	readFileSync(join(WEB, 'src', 'lib', 'components', 'ConversationView.svelte'), 'utf8')
);
const inbox = strip(
	readFileSync(join(WEB, 'src', 'routes', '[lang]', 'chat', '+page.svelte'), 'utf8')
);

let pass = 0;
let fail = 0;
const check = (name: string, ok: boolean, detail?: string): void => {
	if (ok) {
		pass++;
		console.log(`  ✓ ${name}`);
	} else {
		fail++;
		console.error(`  ✗ ${name}${detail ? `\n      ${detail}` : ''}`);
	}
};

console.log('\n── chat toolbar on a phone ────────────────────────────\n');

const tStart = cv.indexOf('{#if !locked && showChatActionToolbar}');
const tEnd = cv.indexOf('<ChatComposer', tStart);
const toolbar = tStart >= 0 && tEnd > tStart ? cv.slice(tStart, tEnd) : '';
check('the toolbar block is found', toolbar.length > 0);

const rowClass = /<div\s+class="([^"]*\bmax-w-2xl\b[^"]*)"/.exec(toolbar)?.[1] ?? '';
const rowTokens = new Set(rowClass.split(/\s+/));
check(
	'the button row stacks on a phone and sits side by side from sm up',
	['flex', 'flex-col', 'items-stretch', 'sm:flex-row', 'sm:flex-wrap'].every((t) =>
		rowTokens.has(t)
	),
	rowClass
);

const buttons = [...toolbar.matchAll(/<button\b[\s\S]*?<\/button>/g)].map((m) => m[0]);
check('the toolbar holds its four buttons', buttons.length === 4, String(buttons.length));
const classOf = (b: string): Set<string> =>
	new Set((/class="([^"]*)"/.exec(b)?.[1] ?? '').split(/\s+/));
for (const [i, b] of buttons.entries()) {
	const c = classOf(b);
	const aria = /aria-label=\{\$_\(([^,)]+)/.exec(b)?.[1] ?? `button ${i}`;
	check(
		`${aria}: full width and 44 px tall on a phone, compact from sm up`,
		['w-full', 'min-h-11', 'sm:w-auto', 'sm:min-h-0'].every((t) => c.has(t)),
		[...c].join(' ')
	);
	check(
		`${aria}: the shared green outlined style, no solid face`,
		c.has('border-morphit-teal/40') &&
			c.has('dark:text-morphit-emerald') &&
			![...c].some((t) => /^bg-morphit-btn|^bg-\[var\(--morphit-btn-face\)\]/.test(t)),
		[...c].join(' ')
	);
}

console.log('\n── the money-flow labels name the coin ────────────────\n');

check(
	'the labels come from chatMoneyFlowLabels(orderRecord)',
	/const moneyFlowLabels = \$derived\(chatMoneyFlowLabels\(orderRecord\)\)/.test(cv)
);
for (const k of ['shareAddress', 'shareAddressAria', 'payNow', 'payNowAria']) {
	check(
		`the toolbar renders moneyFlowLabels.${k} with its values`,
		new RegExp(
			`\\$_\\(moneyFlowLabels\\.${k}\\.key,\\s*\\{\\s*values:\\s*moneyFlowLabels\\.${k}\\.values\\s*\\}\\)`
		).test(toolbar)
	);
}
check(
	'no fixed "Pay now" / "Share crypto address" key is left in the toolbar',
	!/'chat\.funds_sent\.button(_aria)?'|'chat\.address\.share_button(_aria)?'/.test(toolbar)
);
check(
	'the address modal is limited to the order’s coin when no barter list applies',
	/allowedMethods=\{barterAcceptedMethods \?\? \(orderChatAsset \? \[orderChatAsset\] : undefined\)\}/.test(
		cv
	)
);

console.log('\n── "Regarding …" from the reader’s side ───────────────\n');

check(
	'the heading comes from chatOrderHeading(orderIsMine, owner)',
	/const orderHeading = \$derived\(chatOrderHeading\(orderIsMine, orderOwner \?\? peer\)\)/.test(cv)
);
check(
	'the header title is read in the heading’s voice',
	/const orderSummaryForReader = \$derived\.by\(\(\) => \{(?:(?!const orderSummary =)[\s\S]){0,900}voice: orderHeading\.voice/.test(
		cv
	)
);
const reStart = cv.indexOf('{#if orderSummaryForReader}');
const reBlock =
	reStart >= 0 ? cv.slice(reStart, cv.indexOf('{/if}', cv.indexOf('</a>', reStart))) : '';
check(
	'the line shows the heading label, then the reader’s title',
	/\$_\(orderHeading\.label\.key, \{ values: orderHeading\.label\.values \}\)\}/.test(reBlock) &&
		/>\{orderSummaryForReader\}</.test(reBlock),
	reBlock.slice(0, 300)
);
const titleSpan = /<span class="([^"]*)"\s*>\{orderSummaryForReader\}/.exec(reBlock)?.[1] ?? '';
const titleTokens = new Set(titleSpan.split(/\s+/));
check(
	'on a phone the title gets a line of its own; from sm up it shares the line and truncates',
	['order-last', 'w-full', 'truncate', 'sm:order-none', 'sm:w-auto'].every((t) =>
		titleTokens.has(t)
	),
	titleSpan
);
const linkClass = /<a[\s\S]*?class="([^"]*)"/.exec(reBlock)?.[1] ?? '';
check(
	'the line wraps on a phone and stays one line from sm up',
	linkClass.split(/\s+/).includes('flex-wrap') && linkClass.split(/\s+/).includes('sm:flex-nowrap'),
	linkClass
);
check(
	'the PDF export heads this order’s messages with the same reader-side line',
	/thread === orderPermlink && orderSummaryForReader\s*\?\s*`\$\{t\(orderHeading\.label\.key, orderHeading\.label\.values\)\} \$\{orderSummaryForReader\}`/.test(
		cv
	)
);
check(
	'the label carries its own colon (no ":" glued on in code) and may wrap on a phone',
	/<span class="min-w-0 break-words font-medium sm:flex-none"\s*>\{\$_\(orderHeading\.label\.key, \{ values: orderHeading\.label\.values \}\)\}<\/span/.test(
		reBlock
	)
);

console.log('\n── the inbox subject, same voice ──────────────────────\n');

check(
	'the inbox card reads the order in the voice chatOrderHeading gives this side',
	/orderTitleParts\(\s*convo\.order,[\s\S]{0,200}voice: chatOrderHeading\(convo\.order\.account === me, convo\.order\.account\)\.voice/.test(
		inbox
	)
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log(`✗ ${fail} of ${pass + fail} chat-toolbar-mobile checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${pass} chat-toolbar-mobile scenarios passed`);
