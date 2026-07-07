#!/usr/bin/env tsx
/**
 * Smoke: the first-trade community announcement ("Post A") is wired so that,
 * when a user opts in, it actually posts to the @morphit community with a
 * VALID profile link — and only ever for a first-time BUY. Anchor cp396.
 *
 * THE PRODUCT RULES THIS GUARDS:
 *   1. Post A lands in the @morphit community: primaryTag === MORPHIT_COMMUNITY
 *      === 'blurt-176570' (becomes parent_permlink on the wire, so the post
 *      shows in the community feed where curators find + upvote it).
 *   2. The link in the post body is VALID: it uses the canonical production
 *      origin (CANONICAL_ORIGIN = https://morphit.io) and the real profile
 *      route shape /{lang}/@{username}. If CANONICAL_ORIGIN ever changes, the
 *      hardcoded body link must change with it — this smoke fails on drift.
 *   3. Idempotent: the permlink is ACCOUNT-keyed (firstTradePermlink(account)),
 *      so a retry edits the same post instead of double-posting.
 *   4. First-BUY only: the FirstTradeContext documents the buy-side invariant,
 *      the order-form opt-in is gated on `isFirstTrade`, and the fire site is
 *      guarded by a first-feedback-ever dedup + the opt-in flag.
 *
 * Each invariant is a predicate reused for the live check AND a tamper test,
 * so the smoke proves its own assertions have teeth.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const PUBLISH = join(REPO, 'apps/web/src/lib/syndication/publish.ts');
const URLS = join(REPO, 'apps/web/src/lib/seo/urls.ts');
const FEEDBACK = join(REPO, 'apps/web/src/lib/components/LeaveFeedbackForm.svelte');
const POST = join(REPO, 'apps/web/src/routes/[lang]/post/+page.svelte');
const EN = join(REPO, 'apps/web/src/lib/i18n/locales/en.json');

const publish = readFileSync(PUBLISH, 'utf-8');
const urls = readFileSync(URLS, 'utf-8');
const feedback = readFileSync(FEEDBACK, 'utf-8');
const post = readFileSync(POST, 'utf-8');
const en = JSON.parse(readFileSync(EN, 'utf-8')) as {
	syndicate: { first_trade: { title: string; body: string } };
};

/** Canonical origin as declared in seo/urls.ts (single source of truth). */
function canonicalOrigin(s: string): string {
	const m = s.match(/CANONICAL_ORIGIN\s*=\s*'([^']+)'/);
	return m?.[1] ?? '';
}
const ORIGIN = canonicalOrigin(urls);

type Check = { readonly name: string; readonly holds: () => boolean };

const checks: readonly Check[] = [
	{
		name: "Post A community constant is 'blurt-176570'",
		holds: () => /const MORPHIT_COMMUNITY = 'blurt-176570';/.test(publish)
	},
	{
		name: 'Post A is published with primaryTag: MORPHIT_COMMUNITY (lands in the community feed)',
		holds: () =>
			/publishFirstTradePost[\s\S]*?primaryTag:\s*MORPHIT_COMMUNITY/.test(publish)
	},
	{
		name: 'CANONICAL_ORIGIN resolves to the production origin',
		holds: () => ORIGIN === 'https://morphit.io'
	},
	{
		name: 'first_trade.body profile link uses CANONICAL_ORIGIN + /{lang}/@{username}',
		holds: () => en.syndicate.first_trade.body.includes(`${ORIGIN}/{lang}/@{username}`)
	},
	{
		name: 'Post A body is interpolated with {username} and {lang} (link resolves to a real account)',
		holds: () =>
			/syndicate\.first_trade\.body[\s\S]*?values:\s*\{\s*username:\s*account,\s*lang\s*\}/.test(
				publish
			)
	},
	{
		name: 'Post A permlink is ACCOUNT-keyed (idempotent retry = edit, not a double-post)',
		holds: () =>
			/function firstTradePermlink\(account: string\)/.test(publish) &&
			/const permlink = firstTradePermlink\(account\);/.test(publish)
	},
	{
		name: 'FirstTradeContext documents the buy-side invariant (new user is the BUYER)',
		holds: () => /always the BUYER/.test(publish)
	},
	{
		name: 'fire site is gated: first-feedback dedup + opt-in flag',
		holds: () =>
			/if \(!postAAlreadyFired\(reviewerAccount\)\)/.test(feedback) &&
			/if \(isFirstTradeAnnounceEnabled\(\)\)/.test(feedback) &&
			/publishFirstTradePost\(state\.live/.test(feedback)
	},
	{
		name: 'order-form opt-in is gated to a genuine first-buy (isFirstTrade)',
		holds: () => /\{#if isFirstTrade && !hasFiredFirstTrade\(blurtAccount\)\}/.test(post)
	}
];

let pass = 0;
let fail = 0;
for (const c of checks) {
	if (c.holds()) {
		console.log(`  ✓ ${c.name}`);
		pass++;
	} else {
		console.error(`  ✗ ${c.name}`);
		fail++;
	}
}

// ── Tamper tests: break one invariant, assert the matching check flips red. ──
const tampers: ReadonlyArray<{
	readonly label: string;
	readonly holds: () => boolean;
}> = [
	{
		label: "community tag changed away from 'blurt-176570'",
		holds: () =>
			/const MORPHIT_COMMUNITY = 'blurt-176570';/.test(
				publish.replace(
					"const MORPHIT_COMMUNITY = 'blurt-176570';",
					"const MORPHIT_COMMUNITY = 'blurt-999';"
				)
			)
	},
	{
		label: 'body link origin drifts from CANONICAL_ORIGIN',
		holds: () =>
			en.syndicate.first_trade.body
				.replace(ORIGIN, 'https://example.test')
				.includes(`${ORIGIN}/{lang}/@{username}`)
	},
	{
		label: 'permlink switched to non-deterministic (trx-keyed)',
		holds: () =>
			/const permlink = firstTradePermlink\(account\);/.test(
				publish.replace('firstTradePermlink(account)', 'randomPermlink()')
			)
	}
];
for (const t of tampers) {
	if (t.holds()) {
		console.error(`  ✗ tamper NOT caught: "${t.label}" (toothless)`);
		fail++;
	} else {
		console.log(`  ✓ tamper caught: "${t.label}"`);
		pass++;
	}
}

console.log(`\n${pass} ok, ${fail} failing`);
if (fail > 0) process.exit(1);
console.log(`✓ all ${pass} scenarios passed`);
