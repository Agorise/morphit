#!/usr/bin/env tsx
/**
 * Smoke: the compose page locks a first-ever trade to a BUY of BLURT that
 * expires in 7 days. Anchor cp295.
 *
 * THE PRODUCT RULE THIS GUARDS (O#1 / O#9). A brand-new Blurt account holds
 * no BLURT, and BLURT is what pays Morphit listing fees — so until the
 * account is funded it can't list anything. The compose page therefore
 * locks the very first trade to its funding move: a (free, waived) BUY of
 * BLURT, auto-expiring in 7 days. "First trade" is the same signal as the
 * free-first-buy waiver: the indexer reports no prior orders (`eligible`),
 * or the account isn't in the index yet (`eligible_unknown_account`).
 *
 * The lock has two halves and BOTH must stay wired or the rule is toothless:
 *   1. SCRIPT enforcement — a guarded $effect holds side=buy, asset=BLURT,
 *      and expiresDays=7 while `isFirstTrade`. This is the source of truth
 *      even against a restored draft; the template merely reflects it.
 *   2. TEMPLATE lock — the Step-1 buy/sell + asset picker is replaced by the
 *      explained "Buy BLURT" card (`first_trade_title`), the asset row shows
 *      BLURT only (`assetTickersForPicker`), and the expiry <select> is
 *      `disabled={isFirstTrade}`.
 *
 * Each invariant is a predicate reused for the live check AND for in-code
 * tamper tests, so this smoke proves its own assertions have teeth.
 *
 * Tamper tests (run below; each must flip a check red):
 *   - Drop `side = 'buy'` from the enforcement effect → forces-buy fails.
 *   - Drop `expiresDays = 7` from the effect → forces-7-day fails.
 *   - Remove `disabled={isFirstTrade}` from the <select> → expiry-lock fails.
 *   - Narrow `isFirstTrade` to drop `eligible_unknown_account` → signal fails.
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, '..', '..', '..');
const FILE = join(REPO, 'apps/web/src/routes/[lang]/post/+page.svelte');

const stripComments = (s: string): string =>
	s.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

/** Body of the guarded enforcement effect, isolated so the side/asset/expiry
 *  writes are checked INSIDE it (not against the picker onclick that also
 *  contains `side = 'buy'`). */
function enforcementBody(s: string): string {
	const m = s.match(/if \(!isFirstTrade\) return;([\s\S]{0,400}?)\}\);/);
	return m?.[1] ?? '';
}

type Check = { readonly name: string; readonly holds: (s: string) => boolean };

const checks: readonly Check[] = [
	{
		name: 'isFirstTrade is derived from the no-prior-orders waiver signal (eligible + eligible_unknown_account)',
		holds: (s) =>
			/const isFirstTrade = \$derived\(/.test(s) &&
			/isFirstTrade = \$derived\([\s\S]{0,200}kind === 'eligible'[\s\S]{0,80}kind === 'eligible_unknown_account'/.test(
				s
			)
	},
	{
		name: 'enforcement effect holds side = buy while first-trade',
		holds: (s) => /side = 'buy'/.test(enforcementBody(s))
	},
	{
		name: 'enforcement effect holds asset = BLURT while first-trade',
		holds: (s) => /asset = 'BLURT'/.test(enforcementBody(s))
	},
	{
		name: 'enforcement effect holds a 7-day expiry while first-trade',
		holds: (s) => /expiresDays = 7/.test(enforcementBody(s))
	},
	{
		name: 'Step-1 picker is replaced by the explained Buy-BLURT card while first-trade',
		holds: (s) => /\{#if isFirstTrade\}/.test(s) && /first_trade_title/.test(s)
	},
	{
		name: 'asset row shows BLURT only while first-trade (assetTickersForPicker → assetPickerItems)',
		holds: (s) =>
			// Source of truth: the ticker list is BLURT-only during the
			// first-trade lock.
			/assetTickersForPicker[\s\S]{0,160}isFirstTrade \? \(\['BLURT'\] as const\)/.test(s) &&
			// cp396 alphabetized the Step-1 blocks into `assetPickerItems`,
			// which DERIVES from `assetTickersForPicker` (so the BLURT-only
			// gating flows through unchanged), and the #each iterates that
			// derived list.
			/assetPickerItems\s*=\s*\$derived\(\s*\[\.\.\.assetTickersForPicker\]/.test(s) &&
			/#each assetPickerItems as item/.test(s)
	},
	{
		name: 'expiry <select> is disabled while first-trade',
		holds: (s) => /<select[\s\S]{0,160}disabled=\{isFirstTrade\}/.test(s)
	}
];

let pass = 0;
let fail = 0;

const live = stripComments(readFileSync(FILE, 'utf-8'));
for (const c of checks) {
	if (c.holds(live)) {
		console.log(`  ✓ ${c.name}`);
		pass++;
	} else {
		console.error(`  ✗ ${c.name}`);
		fail++;
	}
}

// ── In-code tamper tests: break one invariant at a time, assert the matching
//    check flips red (and that it was green on the live source above). ──
const tampers: ReadonlyArray<{ readonly label: string; readonly mutate: (s: string) => string; readonly check: string }> =
	[
		{
			label: "remove `side = 'buy'` from the enforcement effect",
			mutate: (s) => s.replace(/if \(side !== 'buy'\) side = 'buy';\n/, ''),
			check: 'enforcement effect holds side = buy while first-trade'
		},
		{
			label: 'remove `expiresDays = 7` from the enforcement effect',
			mutate: (s) => s.replace(/if \(expiresDays !== 7\) expiresDays = 7;\n/, ''),
			check: 'enforcement effect holds a 7-day expiry while first-trade'
		},
		{
			label: 'remove `disabled={isFirstTrade}` from the expiry <select>',
			mutate: (s) => s.replace(/\n\t\t\t\t\t\tdisabled=\{isFirstTrade\}/, ''),
			check: 'expiry <select> is disabled while first-trade'
		},
		{
			label: 'narrow isFirstTrade to drop eligible_unknown_account',
			mutate: (s) =>
				s.replace(
					/const isFirstTrade = \$derived\([\s\S]*?\);/,
					"const isFirstTrade = $derived(waiverEligibility?.kind === 'eligible');"
				),
			check: 'isFirstTrade is derived from the no-prior-orders waiver signal (eligible + eligible_unknown_account)'
		}
	];

for (const t of tampers) {
	const mutated = stripComments(t.mutate(readFileSync(FILE, 'utf-8')));
	const check = checks.find((c) => c.name === t.check);
	if (!check) {
		console.error(`  ✗ tamper wiring error: no check named "${t.check}"`);
		fail++;
		continue;
	}
	if (check.holds(mutated)) {
		console.error(`  ✗ tamper NOT caught: after "${t.label}", check still passes (toothless)`);
		fail++;
	} else {
		console.log(`  ✓ tamper caught: "${t.label}" turns "${t.check}" red`);
		pass++;
	}
}

console.log(`\n${pass} ok, ${fail} failing`);
if (fail > 0) process.exit(1);
console.log(`✓ all ${pass} scenarios passed`);
