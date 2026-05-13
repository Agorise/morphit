#!/usr/bin/env tsx
/**
 * sally-walkthrough-smoke.
 *
 * Structural smokes for the Sally walkthrough fixes from the
 * Part 68 hardening pass.  Each scenario locks in a specific
 * UX or security protection by greping the source for the
 * sentinel pattern that proves the fix is still wired.  If a
 * later refactor accidentally removes the protection, the
 * smoke fails loudly.
 *
 * Sentinel-grep is a deliberate choice over runtime testing:
 *   - The fixes touch UI surfaces that need a real DOM /
 *     reactive Svelte runtime to exercise.  The per-fix smoke
 *     would otherwise need the whole svelte-kit harness, which
 *     is excessive for "did this line still exist."
 *   - Future bug-fixes that change WHICH file holds the
 *     protection (e.g. extracting to a helper) are caught and
 *     the maintainer is forced to update this file in the same
 *     commit.  That's the audit trail we want.
 *
 * Coverage:
 *   H1  password not cleared on user-input errors
 *   H2  import → settings session-flag handoff
 *   H4  orderbook needs-account banner
 *   H6  backup-keys show-seed flow exists
 *   H7  /support is no longer a one-card bounce
 *   H8  AvatarMenu has View my profile
 *   H9  feedback first-trade disclosure with selling-point pitch
 *   L8  /post broadcasts run redactPrivateKeys() over region +
 *       payment-method entries (in addition to terms)
 *   M3  waiver asset-locked hint renders ABOVE the chip row
 *   M9  /explorer/account uses recursive setTimeout backoff,
 *       not setInterval(POLL_MS)
 *
 * Usage:
 *   cd apps/web && npx tsx scripts/sally-walkthrough-smoke.ts
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
		name: 'H1 — onboarding/import retains password on user-input errors',
		file: 'src/routes/onboarding/import/+page.svelte',
		mustHave: ['Sally finding H1', "verdict.kind === 'wrong-role'"],
		// Pre-fix the wrong-role / account-not-found branches each
		// reset both password fields.  Verify those resets are gone.
		mustNotHave: [
			"// Hygiene: clear passwords on this early-exit branch.\n\t\t\t\tpostingNewPassword = '';"
		]
	},
	{
		name: 'H2 — import flow writes session flag for settings banner',
		file: 'src/routes/onboarding/import/+page.svelte',
		mustHave: ['Sally finding H2', 'morphit.import.needs_account_name']
	},
	{
		name: 'H2 — settings reads-and-clears the import banner flag',
		file: 'src/routes/settings/+page.svelte',
		mustHave: [
			'morphit.import.needs_account_name',
			'needsAccountNameBanner',
			'settings.import_landing_banner.title'
		]
	},
	{
		name: 'H4 — orderbook shows needs-account banner when unlocked but unregistered',
		file: 'src/routes/orderbook/+page.svelte',
		mustHave: [
			'Sally finding H4',
			'orderbook.needs_account.title',
			'$isUnlocked && viewerAccount === null'
		]
	},
	{
		name: 'H4 — orderbook viewerAccount is reactive ($derived), not const',
		file: 'src/routes/orderbook/+page.svelte',
		mustHave: ['const viewerAccount = $derived.by'],
		mustNotHave: ['const viewerAccount: string | null = getUserBlurtAccount();']
	},
	{
		name: 'H6 — backup-keys has show-seed flow with password gate',
		file: 'src/routes/backup-keys/+page.svelte',
		mustHave: [
			'Sally finding H6',
			'backup_keys.show_seed.heading',
			'mnemonicForBackup',
			'decryptIdentity',
			// FullIdentity must be wiped after extracting the
			// mnemonic — guards against the 12-word recovery
			// bytes lingering in component state.
			'wipeFullIdentity(id)'
		]
	},
	{
		name: 'H7 — /support is a real page, not a one-card bounce to /faq',
		file: 'src/routes/support/+page.svelte',
		mustHave: [
			'support.heading',
			'support.faq.heading',
			'support.operator.heading',
			'support.security.heading',
			'support.self_host.heading'
		],
		// Pre-Part-68 the entire body was a single card with
		// "still need help?" text.  That one phrase is gone.
		mustNotHave: ['faq.still_need_help']
	},
	{
		name: 'H8 — AvatarMenu has View my profile entry',
		file: 'src/lib/components/AvatarMenu.svelte',
		mustHave: ['Sally finding H8', 'avatar_menu.view_my_profile', 'goToMyProfile', 'canViewProfile']
	},
	{
		name: 'H9 — feedback first-trade disclosure has selling-point pitch + checkbox',
		file: 'src/lib/components/LeaveFeedbackForm.svelte',
		mustHave: [
			'Sally finding H9',
			'feedback.first_trade_disclosure.heading',
			'feedback.first_trade_disclosure.pitch',
			'setFirstTradeAnnounce(e.currentTarget.checked)'
		]
	},
	{
		name: 'H9 — per-order syndicate checkbox has selling-point pitch',
		file: 'src/routes/post/+page.svelte',
		mustHave: ['syndicate.opt_in_pitch']
	},
	{
		name: 'L8 — /post redacts private keys from region + payment-method entries',
		file: 'src/routes/post/+page.svelte',
		mustHave: [
			'Sally finding L8',
			'redactPrivateKeys(region.trim())',
			'paymentMethods.map((pm) => redactPrivateKeys(pm))'
		]
	},
	{
		name: 'M3 — waiver asset-locked hint renders ABOVE the chip row',
		file: 'src/routes/post/+page.svelte',
		mustHave: ['Sally finding M3', 'post_order.form.waiver_asset_hint']
	},
	{
		name: 'M9 — /explorer/account uses backoff, not naive setInterval',
		file: 'src/routes/explorer/account/[name=account]/+page.svelte',
		mustHave: ['Sally finding M9', 'POLL_MS_BASE', 'POLL_MS_MAX', 'currentPollMs'],
		mustNotHave: [
			"setInterval(() => {\n\t\t\tif (typeof document !== 'undefined' && document.hidden) return;"
		]
	},
	{
		name: 'M12 — /instances pins current instance to top of list',
		file: 'src/routes/instances/+page.svelte',
		mustHave: ['Sally finding M12', 'if (aIsCurrent && !bIsCurrent) return -1']
	},
	{
		name: 'L13 — XMR jitter shows explicit guidance in BOTH on/off states',
		file: 'src/lib/components/AddressShareModal.svelte',
		mustHave: [
			'Sally finding L13',
			'chat.address.xmr_jitter_send_exact_hint',
			'chat.address.xmr_jitter_off_warning_heading',
			'chat.address.xmr_jitter_off_warning_body'
		]
	},
	// ─── Part 69 second-pass scenarios ─────────────────────────────
	{
		name: 'DL1 — /download direct-APK link no longer points at /morphit.apk',
		file: 'src/routes/download/+page.svelte',
		mustHave: ['Sally finding DL1', 'https://git.agorise.net/agorise/morphit/releases'],
		// Pre-Part-69 the direct-download went to /morphit.apk on
		// the local origin — 404 on every instance that didn't
		// manually drop the APK in static/.
		mustNotHave: ["id: 'direct', url: '/morphit.apk'"]
	},
	{
		name: 'RAN2 — /run-a-node uses Forgejo URL syntax (not GitLab /-/blob/)',
		file: 'src/routes/run-a-node/+page.svelte',
		mustHave: [
			'Sally finding RAN2',
			'git.agorise.net/agorise/morphit/src/branch/main/docs/RUN-A-MORPHIT-NODE.md',
			'git.agorise.net/agorise/morphit/src/branch/main/docs/OPERATIONS.md'
		],
		mustNotHave: ['git.agorise.net/agorise/morphit/-/blob/']
	},
	{
		name: 'ATI1 — /about-this-instance warns "type don\'t click" for known-good URLs',
		file: 'src/routes/about-this-instance/+page.svelte',
		mustHave: [
			'Sally finding ATI1',
			'about_this_instance.worried.type_warning_heading',
			'about_this_instance.worried.type_warning_body',
			// select-all class on the URLs so they copy cleanly
			'select-all'
		]
	},
	{
		name: 'CMP1 — /compare offers re-run without retyping URL',
		file: 'src/routes/compare/+page.svelte',
		mustHave: ['Sally finding CMP1', 'compare.button.rerun']
	},
	{
		name: 'CMP2 — /compare order references are clickable links',
		file: 'src/routes/compare/+page.svelte',
		mustHave: [
			'Sally finding CMP2',
			'`/@${o.account}/${o.permlink}`',
			// Part 70 hardening: hardened cross-instance links
			// through safeInstanceOrigin().
			'safeInstanceOrigin(otherOrigin)',
			'`${safeOther}/@${o.account}/${o.permlink}`'
		],
		// Pre-Part-69 they were plain mono text spans.
		mustNotHave: ['<li class="font-mono text-xs break-all">']
	},
	{
		name: "H3 — voucher path warns user they're leaving Morphit + plain-text fallback",
		file: 'src/routes/onboarding/register-name/+page.svelte',
		mustHave: ['Sally finding H3 follow-up', 'daily_ceiling_voucher_external_warning']
	},
	{
		name: 'OPS2 — /operators inline validateContactUrl documented as intentional',
		file: 'src/routes/operators/+page.svelte',
		mustHave: [
			'Sally finding OPS2',
			// Confirm the inline helper still https-only (stricter
			// than the shared safeContactUrl).
			"u.protocol !== 'https:'"
		]
	}
];

let failed = 0;
let passed = 0;

console.log('sally-walkthrough smoke:\n');

for (const sc of SCENARIOS) {
	const path = join(REPO, sc.file);
	let body: string;
	try {
		body = readFileSync(path, 'utf8');
	} catch (err) {
		console.error(`  ✗ ${sc.name}`);
		console.error(`      file not readable: ${sc.file}`);
		console.error(`      ${err}`);
		failed++;
		continue;
	}

	const missing = sc.mustHave.filter((s) => !body.includes(s));
	const present = (sc.mustNotHave ?? []).filter((s) => body.includes(s));

	if (missing.length === 0 && present.length === 0) {
		console.log(`  ✓ ${sc.name}`);
		passed++;
	} else {
		console.error(`  ✗ ${sc.name}`);
		for (const s of missing) {
			console.error(`      MUST HAVE (not found): ${JSON.stringify(s.slice(0, 100))}`);
		}
		for (const s of present) {
			console.error(`      MUST NOT HAVE (found): ${JSON.stringify(s.slice(0, 100))}`);
		}
		failed++;
	}
}

console.log(`\n${passed} passed, ${failed} failed (${SCENARIOS.length} total)`);

if (failed > 0) {
	console.error('\nsally-walkthrough smoke FAILED');
	process.exit(1);
}
// Canonical success line — run-smokes.sh greps for `^✓ all` to tally
// scenarios. Without this, the runner counts this smoke as 0 scenarios
// even when it passes, which silently undercounts the smoke total. See
// J-2 finding (Part 87): sally was added Part 68/69 but used a custom
// `N passed, M failed (T total)` format that the runner could not parse.
console.log(`✓ all ${SCENARIOS.length} sally-walkthrough scenarios passed`);
