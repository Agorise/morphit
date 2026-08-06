#!/usr/bin/env tsx
/**
 * identity-no-swap — v1.8.13 (Ken).
 *
 * THE RULE: a surface must never assert an identity it does not yet know.
 *
 * `IdentityLabel` falls back to `@account` + identicon when it has no display
 * name or avatar. That is the RIGHT answer for an account with no custom
 * profile, and the WRONG one while a profile is still loading — it paints a
 * confident, incorrect identity and rewrites it seconds later.
 *
 * Ken, on the orderbook (~7s swap): "i should NEVER see the default username
 * and identicon if a custom display name and custom avatar have been set."
 * And on chat: "imagine chatting with someone in the chatroom and then all of a
 * sudden their avatar and/or display name changes on you like that. would you
 * do a trade with that user? hell no."
 *
 * He is right that this is a TRUST defect rather than polish. An identity that
 * mutates in front of you is indistinguishable from a swap attack, and on a
 * marketplace the counterparty's identity IS the product.
 *
 * TWO ways to satisfy the rule:
 *   1. Have the identity ALREADY — served inline with the row (the orderbook
 *      LEFT JOINs profiles), or it is the local user's own profile.
 *   2. Pass `pending` while a fetch is in flight, so the component renders a
 *      neutral placeholder instead of a fallback it cannot justify.
 *
 * This smoke exists because I fixed the orderbook and chat by hand and Ken
 * asked, correctly, "what about the order view page and other pages that i have
 * not thought of?" Enumerating by hand is how surfaces get missed — so the
 * check enumerates instead.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const SRC = join(WEB, 'src');

/** Surfaces that already HOLD the identity when they render it. */
const EXEMPT = new Map<string, string>([
	['src/lib/components/IdentityLabel.svelte', 'the component itself'],
	['src/routes/[lang]/dev/icons/+page.svelte', 'dev-only icon gallery, hardcoded samples'],
	['src/routes/[lang]/settings/+page.svelte', "the local user's OWN profile, held in memory"],
	['src/routes/[lang]/onboarding/+page.svelte', "the user's own freshly-created identity"],
	[
		'src/routes/[lang]/onboarding/register-name/+page.svelte',
		"the user's own name, typed in this form"
	],
	[
		'src/lib/components/OrderPosterIdentity.svelte',
		'a wrapper: forwards identity props, and its PARENTS are checked below'
	],
	[
		'src/lib/components/OrderCard.svelte',
		'a wrapper: forwards identity props, and its PARENTS are checked below'
	],
	['src/lib/components/ChatMessage.svelte', 'renders props supplied by ConversationView'],
	[
		'src/routes/[lang]/orderbook/+page.svelte',
		'identity is served INLINE with each order row (profiles is LEFT JOINed into the ' +
			'orderbook query), so the card is correct on first paint and there is nothing to ' +
			'wait for. The batch hydrate that remains only REFRESHES an already-correct card.'
	]
]);

/** A file fetches identity asynchronously if it calls one of these. */
const ASYNC_FETCH = /getProfilesBatch\(|getProfileCached\(|getProfileCachedDetailed\(/;

function walk(dir: string, out: string[] = []): string[] {
	for (const e of readdirSync(dir)) {
		if (e === 'node_modules' || e.startsWith('.')) continue;
		const full = join(dir, e);
		if (statSync(full).isDirectory()) walk(full, out);
		else if (e.endsWith('.svelte')) out.push(full);
	}
	return out;
}

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

console.log('\n── identity-no-swap (v1.8.13) ────────────────────────\n');

check(
	'IdentityLabel supports a pending state',
	/pending\?: boolean;/.test(readFileSync(join(SRC, 'lib/components/IdentityLabel.svelte'), 'utf8')),
	'without it a surface has no way to say "not known yet"'
);

const offenders: string[] = [];
let checkedSites = 0;
for (const file of walk(SRC)) {
	const rel = relative(SRC, file).replace(/\\/g, '/');
	const key = `src/${rel}`;
	if (EXEMPT.has(key)) continue;
	const src = readFileSync(file, 'utf8');
	// Include WRAPPERS, not just direct IdentityLabel use. The order detail page
	// renders <OrderPosterIdentity>, so it contains no <IdentityLabel at all and
	// an earlier version of this check skipped it entirely — the very page Ken
	// asked about ("what about the order view page and other pages that i have
	// not thought of?"). A wrapper forwards identity props, so the surface that
	// FETCHES is still the one that must declare pending.
	const RENDERS_IDENTITY = /<IdentityLabel\b|<OrderPosterIdentity\b|<OrderCard\b/;
	if (!RENDERS_IDENTITY.test(src)) continue;
	if (!ASYNC_FETCH.test(src)) continue; // identity arrives inline — nothing to wait for
	checkedSites++;
	// Every IdentityLabel in a file that fetches identity must declare pending.
	for (const m of src.matchAll(/<(?:IdentityLabel|OrderPosterIdentity|OrderCard)\b[\s\S]*?\/>/g)) {
		if (!/\bpending=/.test(m[0])) {
			offenders.push(key);
			break;
		}
	}
}

check(`found identity surfaces that fetch asynchronously (${checkedSites})`, checkedSites > 0);
check(
	'every asynchronously-hydrated surface passes `pending`',
	offenders.length === 0,
	offenders.length > 0
		? `these render a fallback identity before they know it:\n      ${[...new Set(offenders)].join('\n      ')}\n    → pass pending={<profile not yet loaded>} so the label waits instead of guessing`
		: ''
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} identity-no-swap checks passed` : '✗ identity-no-swap FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
