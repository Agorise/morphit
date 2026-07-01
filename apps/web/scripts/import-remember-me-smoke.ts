#!/usr/bin/env tsx
/**
 * Smoke: post-seed-import "remember me on this device" step is wired.
 *
 * Anchor: cp137 deep-deep walkthrough H-1.
 *
 * Pre-fix behavior: seed-mode import encrypted the envelope with a
 * random session password, never persisted it, and immediately
 * redirected to /settings.  When the user closed the browser, the
 * envelope was gone and they had to re-paste their 12 words from
 * scratch.  Grandma-hostile UX trap.
 *
 * Fix shipped cp137: after a successful seed-mode import, the page
 * transitions to a `remember_me_choice` stage that asks the user
 * whether to persist the envelope behind a password on this device,
 * with a checkbox UNCHECKED BY DEFAULT.  Privacy-positive default
 * preserved; explicit opt-in to persistence.
 *
 * What this smoke asserts (against the on-disk page source):
 *   1. The `importStage` state type exists with both
 *      `'form'` and `'remember_me_choice'` variants.
 *   2. The page imports the persistence helpers it actually needs:
 *      `writeKeystoreMode`, `writeEnvelope`, and `decryptIdentity`.
 *   3. The `rememberMe` reactive state is declared with `$state(false)`
 *      — the explicit `false` default is load-bearing for the
 *      privacy-positive-by-default property.
 *   4. The `finalizeImportChoice` function exists, branches on
 *      `rememberMe`, and writes the keystore mode + envelope when
 *      the user opts in.
 *   5. The template uses `importStage === 'form'` to gate the
 *      tab/form section and `importStage === 'remember_me_choice'`
 *      to render the new step.
 *
 * What this smoke does NOT assert:
 *   - The localized checkbox text (locale parity smoke covers that).
 *   - The behavior of the keyfile / posting-only paths (untouched
 *     by H-1; they have their own password capture).
 *
 * Tamper tests:
 *   - Change `$state(false)` to `$state(true)` on `rememberMe` →
 *     fails #3.  This protects the privacy-positive default.
 *   - Remove the `writeEnvelope(persistedEnv)` call →
 *     fails #4 because persistence wouldn't actually happen.
 *   - Drop the `{#if importStage === 'form'}` gate → fails #5.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');
const PAGE = join(REPO_ROOT, 'apps/web/src/routes/[lang]/onboarding/import/+page.svelte');

let passes = 0;
let failures = 0;
function pass(msg: string): void {
	passes += 1;
	console.log(`  ✓ ${msg}`);
}
function fail(msg: string, detail = ''): void {
	failures += 1;
	console.error(`  ✗ ${msg}${detail ? `\n      ${detail}` : ''}`);
}

console.log('import-remember-me-smoke\n');

if (!existsSync(PAGE)) {
	fail(`onboarding/import page not found at ${PAGE}`);
	process.exit(1);
}
const src = readFileSync(PAGE, 'utf8');

// #1: state type includes both stages.
if (
	src.includes("type ImportStage = 'form' | 'remember_me_choice'") ||
	src.includes("type ImportStage = 'remember_me_choice' | 'form'")
) {
	pass(`ImportStage type declares both 'form' and 'remember_me_choice' variants`);
} else {
	fail(
		`ImportStage type does not include both required stages`,
		`Expected: type ImportStage = 'form' | 'remember_me_choice';`
	);
}

// #2: persistence helpers imported.
const requiredImports = [
	'writeKeystoreMode',
	'writeEnvelope',
	'decryptIdentity'
];
const missingImports = requiredImports.filter((n) => !new RegExp(`\\b${n}\\b`).test(src));
if (missingImports.length === 0) {
	pass(`page imports all persistence helpers (${requiredImports.join(', ')})`);
} else {
	fail(
		`page is missing required persistence helpers: ${missingImports.join(', ')}`,
		`These are needed to encrypt-with-user-password and persist the envelope when ` +
			`the user opts in to "remember me on this device."`
	);
}

// #3: rememberMe defaults to false — load-bearing for the privacy-
// positive default.  Match either `$state(false)` or
// `$state<boolean>(false)`.
const rememberMeFalseRe = /let\s+rememberMe\s*=\s*\$state\s*(?:<\s*boolean\s*>\s*)?\(\s*false\s*\)/;
if (rememberMeFalseRe.test(src)) {
	pass(`rememberMe defaults to UNCHECKED ($state(false)) — privacy-positive default preserved`);
} else {
	fail(
		`rememberMe is not defaulted to false`,
		`The checkbox MUST be unchecked by default so the privacy-positive ` +
			`session-only behavior remains the default.  Look for: ` +
			`'let rememberMe = $state(false);' in the page source.`
	);
}

// #4: finalizeImportChoice exists, branches on rememberMe, and persists.
const hasFinalize = /async function finalizeImportChoice\b/.test(src);
const hasBranch = /if\s*\(\s*!rememberMe\s*\)|if\s*\(\s*rememberMe\s*\)/.test(src);
const hasWriteEnvelope = /writeEnvelope\s*\(\s*persistedEnv\s*\)/.test(src);
const hasWriteKeystoreMode = /writeKeystoreMode\s*\(\s*['"]password['"]\s*\)/.test(src);
if (hasFinalize && hasBranch && hasWriteEnvelope && hasWriteKeystoreMode) {
	pass(`finalizeImportChoice exists, branches on rememberMe, persists envelope + keystore mode when opted in`);
} else {
	const missing: string[] = [];
	if (!hasFinalize) missing.push('finalizeImportChoice function');
	if (!hasBranch) missing.push('branch on rememberMe');
	if (!hasWriteEnvelope) missing.push('writeEnvelope(persistedEnv) call');
	if (!hasWriteKeystoreMode) missing.push("writeKeystoreMode('password') call");
	fail(`finalizeImportChoice is incomplete`, `Missing: ${missing.join('; ')}`);
}

// #5: template gates both stages.
const hasFormGate = /\{#if\s+importStage\s*===\s*['"]form['"]\s*\}/.test(src);
const hasRememberMeStage = /\{:else if\s+importStage\s*===\s*['"]remember_me_choice['"]\s*\}/.test(src);
if (hasFormGate && hasRememberMeStage) {
	pass(`template renders both importStage branches (form + remember_me_choice)`);
} else {
	const missing: string[] = [];
	if (!hasFormGate) missing.push("{#if importStage === 'form'} gate");
	if (!hasRememberMeStage) missing.push("{:else if importStage === 'remember_me_choice'} branch");
	fail(`template stage gating is incomplete`, `Missing: ${missing.join('; ')}`);
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} import-remember-me scenarios passed`);
