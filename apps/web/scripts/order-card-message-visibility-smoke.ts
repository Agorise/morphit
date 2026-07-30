#!/usr/bin/env tsx
/**
 * order-card-message-visibility — v1.8.12 (Ken).
 *
 * THE BUG. The Message button was hidden whenever `viewerAccount` was null —
 * i.e. from every SIGNED-OUT visitor. Someone browsing the orderbook saw a wall
 * of orders and no way to begin, which is the one action the page exists to
 * produce. Ken reported it missing; his screenshots show the header "Start"
 * button, confirming a signed-out session.
 *
 * Hiding it was never necessary. `/chat/:peer` is already guarded: an anonymous
 * visitor is redirected to onboarding, or to the unlock screen if a keystore
 * exists, carrying `?next=` so they land back in that exact conversation once
 * they have keys. The orderbook was simply refusing to link to machinery that
 * already handled the case.
 *
 * The rule now, on EVERY surface that renders an order card:
 *
 *     hide the Message button ⟺ the order is the VIEWER'S OWN
 *
 * Two surfaces render these cards (orderbook, profile) and they drifted into
 * the same wrong shape independently, which is why this is pinned rather than
 * left to review.
 *
 * Tamper tests (each must turn this red):
 *   - Re-add a `viewerAccount !== null` term to either derivation.
 *   - Drop the own-order check, letting someone message themselves.
 *   - Add a third surface with the old gate.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const read = (p: string): string => readFileSync(join(WEB, p), 'utf8');

/** Every surface that supplies `messageHref` to an OrderCard. */
const SURFACES = [
	'src/routes/[lang]/orderbook/+page.svelte',
	'src/routes/[lang]/[x+40][account=account]/+page.svelte'
] as const;

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── order-card-message-visibility (v1.8.12) ───────────\n');

for (const surface of SURFACES) {
	const src = read(surface);
	// Comment lines stripped: the fix's own comment necessarily describes the
	// signed-out case it removed, and a naive scan would read that as the bug.
	const code = src
		.split('\n')
		.filter((l) => !/^\s*(<!--|\/\/|\*|-->|\s+\S.*-->)/.test(l))
		.join('\n');
	const label = surface.split('/').slice(-2).join('/');

	const m = /messageHref=\{([\s\S]*?)\n\s*[a-zA-Z]+=/.exec(code);
	check(`${label}: supplies messageHref`, m !== null);
	if (m === null) continue;
	const expr = m[1]!;

	check(
		`${label}: does NOT hide the button from signed-out visitors`,
		!/viewerAccount\s*!==\s*null/.test(expr),
		'the chat route already bounces anonymous visitors to sign-in with ?next=, so hiding it only removes the way in'
	);
	check(
		`${label}: still hides it on the viewer's OWN order`,
		/viewerAccount\s*===\s*(account|o\.account)/.test(expr),
		'you cannot message yourself'
	);
}

// The whole fix rests on the chat route handling anonymous visitors. If that
// guard were removed, showing the button would strand people on a dead page.
const chat = read('src/routes/[lang]/chat/[peer=account]/+page.svelte');
check(
	'the chat route still guards anonymous visitors',
	/RequireLiveSession/.test(chat),
	'without this guard, an anonymous click would land nowhere'
);
const guard = read('src/lib/components/RequireLiveSession.svelte');
check(
	'the guard carries ?next= so the visitor returns to the conversation',
	/\?next=' \+ encodeURIComponent/.test(guard),
	'bouncing to sign-in without a return path loses the order they were interested in'
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} order-card-message-visibility checks passed` : '✗ order-card-message-visibility FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
