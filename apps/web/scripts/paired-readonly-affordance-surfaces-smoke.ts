#!/usr/bin/env tsx
/**
 * paired-readonly-affordance-surfaces-smoke (ADR-0022, Part 116).
 *
 * Sister smoke to paired-readonly-lifecycle-smoke.  Where the
 * lifecycle smoke validates the persistence layer (read/write/clear
 * round-trips through pairedSession.ts), THIS smoke pins down the
 * affordance wiring at every write-action call site: each of the
 * eight surfaces Part 114 left unwired must (a) import
 * WriteBlockedReadOnly OR widen the gate to $hasAnySession, and
 * (b) handle the paired-readonly case explicitly so paired users
 * never see the misleading "session locked, unlock to continue"
 * CTA or have a write affordance silently vanish.
 *
 * Sentinel-grep is the right tool here, same rationale as
 * sally-walkthrough-smoke: the protections touch UI surfaces that
 * need the full Svelte runtime to exercise, and a future refactor
 * that accidentally drops the affordance — say, by inlining the
 * gate via a different derived store — must be caught at smoke
 * time and force the maintainer to update this file in the same
 * commit.  That's the audit-trail discipline we want.
 *
 * Coverage (each scenario maps 1:1 to a TARBALL.md Part-115-
 * inventoried gap):
 *
 *   1. /my/orders page-shell three-way branch
 *   2. /my/orders inline feature-bid affordance
 *   3. /my/orders inline feedback affordance
 *   4. /my/orders inline cancel-order affordance
 *   5. /post/edit/[permlink] paired-readonly affordance
 *   6. profile feedback_response affordance (own profile, isOwnProfile)
 *   7. order-detail owner-actions affordance
 *   8. /orderbook fee-rejected recovery link widened to $hasAnySession
 *   9. /run-a-node operator_register three-way branch
 *  10. +layout mobile-nav sign-in link widened to $hasAnySession
 *
 * Also asserts (the cross-cutting variant + locale piece):
 *  11. WriteBlockedReadOnly component declares the 4 new variants
 *  12. WriteBlockedReadOnly component has deepLink cases for them
 *  13. en.json paired_readonly block carries the 4 new body strings
 *
 * Locale parity for the 4 new keys is enforced by the existing
 * i18n-locale-parity-smoke; no need to re-walk all 10 locales here.
 *
 * Usage:
 *   cd apps/web && npx tsx scripts/paired-readonly-affordance-surfaces-smoke.ts
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dirname, '..');

interface Scenario {
	readonly name: string;
	readonly file: string;
	/** Substrings that must ALL appear in the file. */
	readonly mustHave: readonly string[];
	/** Substrings that must NOT appear (regression sentinels).
	 *  Pre-fix patterns that the fix removed; if they reappear
	 *  the protection regressed. */
	readonly mustNotHave?: readonly string[];
}

const SCENARIOS: readonly Scenario[] = [
	{
		name: '1 — /my/orders page-shell three-way branch (paired falls through, locked still blocks)',
		file: 'src/routes/my/orders/+page.svelte',
		mustHave: [
			"import { identity, isUnlocked, isPairedReadOnly, hasAnySession } from '$stores/identity'",
			"import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte'",
			'{:else if !$isUnlocked && !$isPairedReadOnly}'
		]
	},
	{
		name: '2 — /my/orders inline feature_order affordance for paired users',
		file: 'src/routes/my/orders/+page.svelte',
		mustHave: [
			'{#if $isPairedReadOnly}',
			'variant="feature_order"',
			'orderPermlink={o.permlink}'
		]
	},
	{
		name: '3 — /my/orders inline feedback affordance for paired users (preserves permlink hash deep link)',
		file: 'src/routes/my/orders/+page.svelte',
		mustHave: ['variant="feedback"', 'peer={blurtAccount}', 'orderPermlink={o.permlink}']
	},
	{
		name: '4 — /my/orders inline cancel_order affordance for paired users',
		file: 'src/routes/my/orders/+page.svelte',
		mustHave: ['variant="cancel_order"']
	},
	{
		name: '5 — /post/edit/[permlink] paired-readonly affordance with permlink-preserving deep link',
		file: 'src/routes/post/edit/[permlink]/+page.svelte',
		mustHave: [
			"import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte'",
			"import { identity, isUnlocked, isPairedReadOnly } from '$stores/identity'",
			'{#if $isPairedReadOnly}',
			'<WriteBlockedReadOnly variant="post_order" orderPermlink={permlink} />'
		]
	},
	{
		name: '6 — profile feedback_response affordance for paired users on own profile',
		file: 'src/routes/[x+40][account=account]/+page.svelte',
		mustHave: [
			"import { isUnlocked, isPairedReadOnly } from '$stores/identity'",
			'{#if isOwnProfile && fb.responses.length === 0}',
			'variant="feedback_response"',
			'peer={account}'
		],
		mustNotHave: [
			// The pre-fix gate hid the reply affordance entirely for
			// paired users.  The fix is the three-way restructure: if
			// this regresses to a single-line $isUnlocked gate that
			// silently hides for paired, the smoke fails.
			'isOwnProfile && $isUnlocked && fb.responses.length === 0'
		]
	},
	{
		name: '7 — order-detail owner-actions affordance for paired users (edit + cancel, permlink preserved)',
		file: 'src/routes/[x+40][account=account]/[permlink=permlink]/+page.svelte',
		mustHave: [
			"import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte'",
			"import { identity, isUnlocked, isPairedReadOnly } from '$stores/identity'",
			'{#if $isPairedReadOnly}',
			'variant="post_order"',
			'variant="cancel_order"',
			'orderPermlink={permlink}'
		]
	},
	{
		name: '8 — /orderbook fee-rejected recovery link widened to $hasAnySession',
		file: 'src/routes/orderbook/+page.svelte',
		mustHave: [
			"import { isUnlocked, hasAnySession } from '$stores/identity'",
			'{#if $hasAnySession && viewerAccount !== null}'
		],
		mustNotHave: [
			// Pre-fix sentinel: the old gate was $isUnlocked &&
			// viewerAccount !== null in the same block that contains
			// the /my/orders#fee-status link.  We assert the exact
			// pre-fix shape no longer appears on the fee-status link.
			'$isUnlocked && viewerAccount !== null}\n\t\t<p class="mb-4 text-xs text-ink-500'
		]
	},
	{
		name: '9 — /run-a-node operator_register three-way branch (signed-out / paired / unlocked)',
		file: 'src/routes/run-a-node/+page.svelte',
		mustHave: [
			"import WriteBlockedReadOnly from '$components/WriteBlockedReadOnly.svelte'",
			"import { liveIdentity, isPairedReadOnly, hasAnySession } from '$stores/identity'",
			'{#if !$hasAnySession}',
			'{:else if $isPairedReadOnly}',
			'<WriteBlockedReadOnly variant="operator_register" />'
		],
		mustNotHave: [
			// Pre-fix sentinel: a !$liveIdentity gate ahead of the
			// form would, for paired-readonly users, route them into
			// the "please sign in" branch (since paired sessions have
			// $liveIdentity === null).
			'{#if !$liveIdentity}'
		]
	},
	{
		name: '10 — +layout mobile-nav sign-in link widened to $hasAnySession',
		file: 'src/routes/+layout.svelte',
		mustHave: [
			"import { isUnlocked, hasAnySession, lockSession } from '$stores/identity'",
			'{#if !$hasAnySession}'
		]
	},
	{
		name: '11 — WriteBlockedReadOnly declares the four new variants in its WriteVariant union',
		file: 'src/lib/components/WriteBlockedReadOnly.svelte',
		mustHave: [
			"| 'feedback_response'",
			"| 'operator_register'",
			"| 'feature_order'",
			"| 'cancel_order'"
		]
	},
	{
		name: '12 — WriteBlockedReadOnly has deepLink cases for the four new variants',
		file: 'src/lib/components/WriteBlockedReadOnly.svelte',
		mustHave: [
			"variant === 'feedback_response'",
			"variant === 'operator_register'",
			"variant === 'feature_order'",
			"variant === 'cancel_order'",
			// And the permlink-preserving deep-link patterns.
			'#feature=',
			'#cancel=',
			'/post/edit/',
			'/my/orders#feedback='
		]
	},
	{
		name: '13 — en.json paired_readonly block carries the four new body strings',
		file: 'src/lib/i18n/locales/en.json',
		mustHave: [
			'"write_blocked_feedback_response_body"',
			'"write_blocked_operator_register_body"',
			'"write_blocked_feature_order_body"',
			'"write_blocked_cancel_order_body"'
		]
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
		for (const m of missing) console.log(`        - ${m}`);
	}
	if (regressed.length > 0) {
		console.log(`      regressed sentinel(s) (pre-fix pattern reappeared):`);
		for (const m of regressed) console.log(`        - ${m}`);
	}
}

console.log('paired-readonly-affordance-surfaces smoke:\n');
for (const s of SCENARIOS) check(s);

console.log(`\n${scenarios} scenarios, ${failures} failed`);
if (failures > 0) {
	console.error('paired-readonly-affordance-surfaces-smoke FAILED');
	process.exit(1);
}
// Canonical success line — run-smokes.sh greps for `^✓ all` to tally
// scenarios.  Without this, the runner counts this smoke as 0
// scenarios even when it passes, which silently undercounts the
// smoke total.  See J-2 finding (Part 87): sally-walkthrough was
// added Part 68/69 but used a custom `N passed, M failed` format
// that the runner could not parse and was undercounted by 22 for
// ~20 Parts before being caught.
console.log(`✓ all ${SCENARIOS.length} paired-readonly-affordance-surfaces scenarios passed`);
