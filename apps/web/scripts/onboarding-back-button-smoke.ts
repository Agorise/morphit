#!/usr/bin/env tsx
/**
 * Smoke for the Tier 2.3 onboarding back-button flow.
 *
 * The back button at `review` stage MUST wipe `full` + `live`
 * before transitioning back to `choose`.  Failing to wipe leaves
 * the seed bytes and posting/memo private keys in heap until
 * GC, which is exactly the K1.2 / O2.1 finding pattern that the
 * existing wipe call sites (lines ~221 and ~310 at Part 98 time)
 * were added to fix.
 *
 * This smoke is structural: it parses the onboarding +page.svelte
 * source and asserts that the restart flow has the right shape.
 * Not a behavioral test (we can't drive Svelte's reactive
 * lifecycle from here), but a guard against regression where
 * someone refactors the back-button flow and forgets the wipe.
 *
 * Scenarios:
 *   1. requestRestartFromReview function exists.
 *   2. confirmRestartFromReview function exists and calls
 *      both wipeFullIdentity AND wipeLiveIdentity.
 *   3. confirmRestartFromReview nulls `full` and `live` after
 *      wiping.
 *   4. confirmRestartFromReview clears `password` (component-
 *      state residue).
 *   5. The back button in the review-stage UI is wired to
 *      requestRestartFromReview, not to a direct stage='choose'
 *      mutation that would skip the wipe.
 *   6. A ConfirmModal block is wired to pendingRestartFromReview.
 *   7. The wipeFullIdentity and wipeLiveIdentity helpers are
 *      imported from $crypto/keygen (sanity that the imports
 *      survive a refactor).
 */

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

const ONBOARDING = readFileSync(
	join(REPO_ROOT, 'apps/web/src/routes/[lang]/onboarding/+page.svelte'),
	'utf8'
);

interface Scenario {
	readonly name: string;
	readonly ok: boolean;
}

// Find the body of confirmRestartFromReview so we can do
// content-based assertions without whitespace-fragility.
function functionBody(source: string, name: string): string | null {
	const re = new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*:?\\s*[a-zA-Z]*\\s*\\{`, 'm');
	const match = re.exec(source);
	if (!match) return null;
	let depth = 1;
	let i = match.index + match[0].length;
	const start = i;
	while (i < source.length && depth > 0) {
		const ch = source[i]!;
		if (ch === '{') depth++;
		else if (ch === '}') depth--;
		i++;
	}
	return source.slice(start, i - 1);
}

const restartBody = functionBody(ONBOARDING, 'confirmRestartFromReview');

const scenarios: readonly Scenario[] = [
	{
		name: 'requestRestartFromReview function exists',
		ok: /function\s+requestRestartFromReview\s*\(/.test(ONBOARDING)
	},
	{
		name: 'confirmRestartFromReview function exists',
		ok: restartBody !== null
	},
	{
		name: 'confirmRestartFromReview calls wipeFullIdentity',
		ok: restartBody !== null && /wipeFullIdentity\s*\(\s*full\s*\)/.test(restartBody)
	},
	{
		name: 'confirmRestartFromReview calls wipeLiveIdentity',
		ok: restartBody !== null && /wipeLiveIdentity\s*\(\s*live\s*\)/.test(restartBody)
	},
	{
		name: 'confirmRestartFromReview nulls full after wipe',
		ok: restartBody !== null && /full\s*=\s*null/.test(restartBody)
	},
	{
		name: 'confirmRestartFromReview nulls live after wipe',
		ok: restartBody !== null && /live\s*=\s*null/.test(restartBody)
	},
	{
		name: 'confirmRestartFromReview clears password',
		ok: restartBody !== null && /password\s*=\s*''/.test(restartBody)
	},
	{
		name: 'confirmRestartFromReview transitions stage to choose',
		ok: restartBody !== null && /stage\s*=\s*'choose'/.test(restartBody)
	},
	{
		name: 'review-stage back button wired to requestRestartFromReview',
		ok: /onclick=\{requestRestartFromReview\}/.test(ONBOARDING)
	},
	{
		name: 'pendingRestartFromReview state declared',
		ok: /let\s+pendingRestartFromReview\s*=\s*\$state\(false\)/.test(ONBOARDING)
	},
	{
		name: 'ConfirmModal wired to pendingRestartFromReview',
		ok: /\{#if\s+pendingRestartFromReview\}[\s\S]*?<ConfirmModal/.test(ONBOARDING)
	},
	{
		name: 'wipeFullIdentity imported from $crypto/keygen',
		ok: /wipeFullIdentity[\s\S]{0,200}from\s+'\$crypto\/keygen'/.test(ONBOARDING)
	},
	{
		name: 'wipeLiveIdentity imported from $crypto/keygen',
		ok: /wipeLiveIdentity[\s\S]{0,200}from\s+'\$crypto\/keygen'/.test(ONBOARDING)
	},
	{
		name: 'i18n key onboarding.review.back_button referenced',
		ok: /\$_\(['"]onboarding\.review\.back_button['"]\)/.test(ONBOARDING)
	},
	{
		name: 'i18n key onboarding.review.back_confirm.title referenced',
		ok: /\$_\(['"]onboarding\.review\.back_confirm\.title['"]\)/.test(ONBOARDING)
	},
	{
		// The wizard swaps stages in place (review→confirm, discard→choose)
		// rather than navigating, so SvelteKit's scroll-to-top never fires.
		// An $effect keyed on `stage` must reset scroll to the top, else the
		// confirm quiz / the post-discard choose step open scrolled to the
		// bottom of the previous (long) review step.
		name: 'stage changes reset scroll to top (confirm/choose open at their heading, not at the bottom of review)',
		ok: /\$effect\(\(\)\s*=>\s*\{[^}]*\bstage\b[^}]*window\.scrollTo\(0,\s*0\)[^}]*\}\)/.test(ONBOARDING)
	}
];

console.log('');
console.log('── onboarding back-button policy smoke ─────────────────');
console.log('');

let passed = 0;
let failed = 0;
const failures: string[] = [];
for (const s of scenarios) {
	if (s.ok) {
		passed++;
	} else {
		failed++;
		failures.push(`  ✗ ${s.name}`);
	}
}

if (failed > 0) {
	console.log(failures.join('\n'));
	console.log('');
}
console.log('────────────────────────────────────────────────────────');
if (failed === 0) {
	console.log(`✓ all ${passed} scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failed} of ${passed + failed} scenarios failed`);
	process.exit(1);
}
