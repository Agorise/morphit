#!/usr/bin/env tsx
/**
 * chat-immersive-layout-smoke (cp402 [9]).
 *
 * Pins the mobile chat layout fix. The chat CONVERSATION route is an
 * immersive full-viewport view: ConversationView fills the space below
 * the sticky header with its composer pinned + always visible, and the
 * marketing footer is suppressed. Before the fix the chat used a FIXED
 * `h-[100svh]` container which — stacked below the sticky header (taller
 * on mobile) and above the footer — overflowed the viewport and pushed
 * the Send button below the fold.
 *
 * Invariants guarded (source-assertion — the layout math needs a real
 * viewport to see, so a smoke pins the wiring against regression):
 *
 *   • The [lang] layout detects the chat conversation route by PATHNAME
 *     SHAPE (three segments, `chat` in the middle) — so non-chat routes
 *     are untouched.
 *   • On that route ONLY: the root gets a definite height, <main> becomes
 *     a min-h-0 flex column, and the footer is suppressed. Non-chat
 *     routes keep min-h-[100dvh] + footer.
 *   • ConversationView + the loading shell FILL the flex column
 *     (flex-1 min-h-0) instead of a fixed `h-[100svh]` (regression
 *     sentinel: the fixed height must not come back).
 *   • The composer lays the textarea + Send on ONE row (Send visible
 *     without the textarea/button stack pushing it down).
 *
 * Usage:
 *   cd apps/web && npx tsx scripts/chat-immersive-layout-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');

interface Scenario {
	readonly name: string;
	readonly file: string;
	readonly mustHave: readonly string[];
	readonly mustNotHave?: readonly string[];
}

const LAYOUT = 'src/routes/[lang]/+layout.svelte';
const CONV = 'src/lib/components/ConversationView.svelte';
const COMPOSER = 'src/lib/components/ChatComposer.svelte';
const CHAT_PAGE = 'src/routes/[lang]/chat/[peer=account]/+page.svelte';

const SCENARIOS: readonly Scenario[] = [
	{
		name: '1 — layout detects the chat conversation route by pathname shape (3 segments, chat middle)',
		file: LAYOUT,
		mustHave: [
			'const isImmersiveChat = $derived.by(() => {',
			"const parts = $page.url.pathname.split('/').filter(Boolean);",
			"return parts.length === 3 && parts[1] === 'chat';"
		]
	},
	{
		name: '2 — root height is definite ONLY on chat; non-chat keeps min-h-[100dvh]',
		file: LAYOUT,
		mustHave: ["{isImmersiveChat ? 'h-[100svh]' : 'min-h-[100dvh]'}"]
	},
	{
		name: '3 — <main> becomes a min-h-0 flex column ONLY on chat',
		file: LAYOUT,
		mustHave: ["{isImmersiveChat ? 'flex min-h-0 flex-col' : ''}"]
	},
	{
		name: '4 — footer is suppressed on the immersive chat route',
		file: LAYOUT,
		mustHave: ['{#if !isImmersiveChat}', '<footer']
	},
	{
		name: '5 — ConversationView FILLS the flex column (flex-1 min-h-0), not a fixed viewport height',
		file: CONV,
		mustHave: ['<div class="chat-conversation flex min-h-0 flex-1 flex-col">'],
		mustNotHave: ['chat-conversation flex h-[100svh]']
	},
	{
		name: '6 — composer lays the textarea + Send on ONE row',
		file: COMPOSER,
		mustHave: ['<div class="flex items-end gap-2">', 'class="flex-1"']
	},
	{
		name: '7 — chat-route loading shell FILLS instead of a fixed viewport height',
		file: CHAT_PAGE,
		mustHave: ['flex min-h-0 flex-1 flex-col items-center justify-center'],
		mustNotHave: ['h-[100svh]']
	}
];

let failures = 0;
let scenarios = 0;

function check(s: Scenario): void {
	scenarios++;
	const path = join(REPO, s.file);
	let body: string;
	try {
		body = readFileSync(path, 'utf8');
	} catch (err) {
		failures++;
		console.log(`  ✗ ${s.name}`);
		console.log(`      could not read ${s.file}: ${err instanceof Error ? err.message : err}`);
		return;
	}
	const missing = s.mustHave.filter((m) => !body.includes(m));
	const regressed = (s.mustNotHave ?? []).filter((m) => body.includes(m));
	if (missing.length === 0 && regressed.length === 0) {
		console.log(`  ✓ ${s.name}`);
		return;
	}
	failures++;
	console.log(`  ✗ ${s.name}`);
	if (missing.length > 0) {
		console.log(`      missing sentinel(s):`);
		for (const m of missing) console.log(`        - ${JSON.stringify(m)}`);
	}
	if (regressed.length > 0) {
		console.log(`      regressed sentinel(s) (pre-fix pattern reappeared):`);
		for (const m of regressed) console.log(`        - ${JSON.stringify(m)}`);
	}
}

console.log('chat-immersive-layout smoke:\n');
for (const s of SCENARIOS) check(s);

console.log(`\n${scenarios} scenarios, ${failures} failed`);
if (failures > 0) {
	console.error('chat-immersive-layout-smoke FAILED');
	process.exit(1);
}
// Canonical success line — run-smokes.sh greps for `^✓ all` to tally.
console.log(`✓ all ${SCENARIOS.length} chat-immersive-layout scenarios passed`);
