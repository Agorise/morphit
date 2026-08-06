#!/usr/bin/env tsx
/**
 * profile-account-change-reload — v1.8.10 (Ken, t.txt).
 *
 * TWO BUGS THIS EXISTS TO CATCH, both on the profile page.
 *
 * 1. STALE PROFILE ON SPA NAVIGATION. The page loaded everything in a one-shot
 *    `onMount`. SvelteKit REUSES the same component instance when navigating
 *    /@a → /@b (same route, different param), so onMount fired only for the
 *    first profile viewed and nothing ever reloaded. Every subsequent profile
 *    rendered the PREVIOUS user's reputation, reviews and orders until a hard
 *    refresh forced a fresh mount. Ken hit it live: /@kentest3 showed
 *    kentest2's 5-star card. The fix is an `$effect` keyed on `account` that
 *    RESETS the account-scoped state and re-fires the loads.
 *
 *    The reset is the load-bearing half. Re-fetching without clearing still
 *    shows the old user's data for the whole in-flight window, and the
 *    reputation card derives from `feedback` — precisely the state that
 *    rendered the wrong score.
 *
 * 2. TWO DIFFERENT HEADLINE NUMBERS FOR ONE TRADER. The hero showed the RAW
 *    time-decayed average (`weighted_rating`), while every order card and chat
 *    header shows the COMPOSITE `reputation_score` (cp404 Bayesian shrinkage).
 *    Same trader, different number per page — and the profile always flattered,
 *    since the composite pulls a thin sample toward neutral. Ken saw 4.75 on
 *    the profile vs 3.97 everywhere else. The headline is now the composite.
 *
 * Tamper tests (each must turn this red):
 *   - Put the loads back in `onMount` → the effect checks fail.
 *   - Drop any state slice from the reset block → the reset check fails.
 *   - Point the headline back at `weighted_rating` → the headline check fails.
 *   - Remove a stale-response guard → the guard check fails.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB = join(HERE, '..');
const PAGE = join(WEB, 'src/routes/[lang]/[x+40][account=account]/+page.svelte');

const src = readFileSync(PAGE, 'utf8');
/** Comment lines are stripped for anti-pattern checks: this fix's own comments
 *  necessarily NAME the broken pattern they replaced (`onMount`,
 *  `weighted_rating`), and a naive scan would flag the documentation as the
 *  bug. Same trap that bit twice in the v1.8.7–1.8.9 arc. */
const code = src
	.split('\n')
	.filter((l) => !/^\s*(\/\/|\*|\/\*|<!--|-->)/.test(l.trim()))
	.join('\n');

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

console.log('\n── profile-account-change-reload (v1.8.10) ───────────\n');

// ─── 1. the reload is reactive, not one-shot ─────────────────────
check(
	'the loads are NOT wired to a one-shot onMount',
	!/onMount\(\s*\(\)\s*=>\s*\{[\s\S]{0,400}?loadProfile\(\)/.test(code),
	'onMount fires once per component instance; SPA nav /@a → /@b reuses it'
);
check(
	'an $effect drives the reload',
	/\$effect\(\(\)\s*=>\s*\{/.test(code),
	'without a reactive effect nothing re-runs when the route param changes'
);
const effectBlock = /\$effect\(\(\)\s*=>\s*\{([\s\S]*?)\n\t\}\);/.exec(code)?.[1] ?? '';
check(
	'the effect reads `account`, establishing it as the dependency',
	/const\s+forAccount\s*=\s*account\s*;/.test(effectBlock),
	'the effect must depend on the route param or it will never re-fire'
);
check(
	'all five loads fire from inside the effect',
	['loadProfile()', 'loadFeedbackPage()', 'loadFeedbackGivenPage()', 'loadOrders()',
		'loadReputationScore()'].every((fn) => effectBlock.includes(fn)),
	'a load left outside the effect keeps showing the previous account'
);

// ─── 2. the reset clears every account-scoped slice ──────────────
// Anything account-scoped that is NOT reset will visibly bleed across profiles.
const MUST_RESET = [
	'profile',
	'feedback',
	'reputationScore',
	'feedbackItems',
	'feedbackNextCursor',
	'feedbackState',
	'feedbackGivenItems',
	'feedbackGivenState',
	'allOrders',
	'ordersState',
	'reviewerProfileMap'
];
for (const slice of MUST_RESET) {
	check(
		`the effect resets \`${slice}\` before reloading`,
		new RegExp(`\\n\\s*${slice}\\s*=\\s*`).test(effectBlock),
		'an unreset slice renders the PREVIOUS account\'s data while the fetch is in flight'
	);
}

// ─── 3. stale cross-account responses are discarded ──────────────
// Navigating twice quickly can land an old response after the new reset.
const LOADERS = [
	'loadProfile',
	'loadFeedbackPage',
	'loadFeedbackGivenPage',
	'loadOrders',
	'loadReputationScore'
];
for (const fn of LOADERS) {
	const body =
		new RegExp(`async function ${fn}\\([^)]*\\): Promise<void> \\{([\\s\\S]*?)\\n\\t\\}`).exec(
			code
		)?.[1] ?? '';
	check(
		`${fn} discards a response for a since-navigated-away account`,
		/const\s+forAccount\s*=\s*account\s*;/.test(body) &&
			/if\s*\(\s*forAccount\s*!==\s*account\s*\)\s*return\s*;/.test(body),
		'a slow fetch for the previous profile would overwrite the new one'
	);
}

// ─── 4. the headline matches what order cards + chat show ────────
check(
	'the reputation headline renders the composite score, not the raw average',
	/headlineRating\.toFixed\(2\)/.test(code) &&
		!/\{feedback\.summary\.weighted_rating\.toFixed\(2\)\}/.test(code),
	'the profile must not show a different number than the order card for one trader'
);
check(
	'the headline prefers reputationScore and falls back to the raw average',
	/headlineRating\s*=\s*\$derived\(\s*\n?\s*reputationScore\s*\?\?/.test(code),
	'a missing score must degrade to the old behaviour, never to a blank card'
);
check(
	'the raw average is still shown, explicitly labelled',
	/profile\.average_rating_detail/.test(code),
	'the histogram plots the raw average, so it has to remain visible and named'
);
check(
	'the composite score comes from the same receipt endpoint the chat header uses',
	/getReputationReceipt/.test(code) && /summary\.reputation_score/.test(code),
	'deriving it separately would let the two surfaces drift apart again'
);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} profile-account-change-reload checks passed` : '✗ profile-account-change-reload FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
