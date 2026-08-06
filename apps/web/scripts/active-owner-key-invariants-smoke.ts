/**
 * active-owner-key-invariants smoke — guards the structural
 * invariants that protect the user's active and owner private
 * keys from leaking out of the JIT-unlock pattern.
 *
 * Background:
 *   The active key can move BLURT funds.  The owner key can
 *   change every other key on the account.  Compromising either
 *   = full account loss.  Morphit's policy is that these keys
 *   live ONLY inside the encrypted keystore, are JIT-decrypted
 *   for one signing operation, and are wiped in a `finally`
 *   block.  See SECURITY.md §1a + §1b for the full policy and
 *   the 2026-05-07 deep-audit findings.
 *
 * What this smoke checks:
 *
 * 1. `LiveIdentity` (the in-memory session identity type) does
 *    NOT have any field whose name or type suggests a
 *    private active or owner key.  It only carries
 *    `ownerPublicKey` and `activePublicKey` for the public
 *    halves.  A future maintainer adding `activePrivateKey:
 *    Uint8Array` to LiveIdentity would silently break the
 *    tier policy; this smoke fails loudly.
 *
 * 2. The only entry points to active/owner private keys are
 *    `useActiveKey`, `useActiveKeyForPasswordChange`, and
 *    `useOwnerKey` exported from `keystore.ts`.  No other
 *    file reaches into a `FullIdentity` to pull `keys.active`
 *    or `keys.owner` outside of keygen.ts internals.
 *
 * 3. `useJitKey`'s `finally` block contains
 *    `sodium.memzero(wanted)` so the key is wiped on success
 *    and exception alike.  A regression that drops the
 *    finally-wipe (e.g., refactoring to top-level wipe) is
 *    caught.
 *
 * 4. Every call site of `runWithActiveKey` and `useActiveKey`
 *    is accompanied by a `password = ''` or `passwordInput =
 *    ''` clear in the same function, on both success and
 *    error paths.
 *
 * 5. Sourcemaps are off in production build config.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const APP_WEB_SRC = path.join(REPO_ROOT, 'apps/web/src');

let failures = 0;
function fail(msg: string): void {
	console.error(`  ✗ ${msg}`);
	failures += 1;
}
function pass(msg: string): void {
	console.log(`  ✓ ${msg}`);
}

// ─── Scenario 1: LiveIdentity exposes only public halves ─────
function checkLiveIdentityShape(): void {
	// LiveIdentity moved from keygen.ts to identity-core.ts in the cp271
	// baseline-bloat refactor (keygen.ts re-exports it).  Check it where
	// it is now DEFINED.
	const corePath = path.join(APP_WEB_SRC, 'lib/crypto/identity-core.ts');
	const src = readFileSync(corePath, 'utf8');

	// Find the LiveIdentity interface body
	const m = src.match(/export interface LiveIdentity\s*\{([\s\S]*?)^\}/m);
	if (!m) {
		fail('identity-core.ts: cannot find LiveIdentity interface body');
		return;
	}
	const body = m[1] ?? '';

	// Forbidden field-name patterns: anything matching
	// /(active|owner).*(private|priv)/i suggests a private key
	// field.  We allow `ownerPublicKey` and `activePublicKey`.
	const forbidden = [
		/\bactivePrivate(Key)?\b/i,
		/\bownerPrivate(Key)?\b/i,
		/\bactive\s*:\s*Keypair\b/, // would carry the private
		/\bowner\s*:\s*Keypair\b/
	];
	for (const re of forbidden) {
		if (re.test(body)) {
			fail(`LiveIdentity exposes a private active/owner field matching ${re}`);
			return;
		}
	}

	// Required: ownerPublicKey + activePublicKey must be the
	// only owner/active surfaces.
	if (!/ownerPublicKey\s*:/.test(body)) {
		fail('LiveIdentity is missing ownerPublicKey field');
		return;
	}
	if (!/activePublicKey\s*:/.test(body)) {
		fail('LiveIdentity is missing activePublicKey field');
		return;
	}
	pass('LiveIdentity shape: only public halves of owner/active are exposed');
}

// ─── Scenario 2: only sanctioned entry points to active/owner ─
function checkEntryPointsToActiveOwner(): void {
	// Allowed callers for FullIdentity.keys.active / .owner
	const allowedFiles = new Set([
		path.join(APP_WEB_SRC, 'lib/crypto/keystore.ts'),
		path.join(APP_WEB_SRC, 'lib/crypto/keygen.ts'),
		// cp271 moved the sanctioned toLiveIdentity/wipeLiveIdentity helpers
		// here from keygen.ts — same code (memzeroes private keys, exposes
		// only public halves), just relocated.
		path.join(APP_WEB_SRC, 'lib/crypto/identity-core.ts'),
		path.join(APP_WEB_SRC, 'lib/crypto/runWithActiveKey.ts'),
		path.join(APP_WEB_SRC, 'lib/crypto/changePassword.ts')
	]);

	const offenders: string[] = [];
	walkSourceFiles(APP_WEB_SRC, (filepath) => {
		if (allowedFiles.has(filepath)) return;
		// Test files are also exempt
		if (/\.test\.ts$/.test(filepath)) return;
		const src = readFileSync(filepath, 'utf8');
		// Look for patterns like `full.keys.active` or
		// `id.keys.owner` or `identity.keys.active.privateKey`
		// reaching into the FullIdentity's active/owner slot.
		const re = /\b\w+\.keys\.(active|owner)(?:\.privateKey)?\b/;
		if (re.test(src)) {
			offenders.push(path.relative(REPO_ROOT, filepath));
		}
	});
	if (offenders.length > 0) {
		fail(`unsanctioned access to FullIdentity.keys.active/owner in: ${offenders.join(', ')}`);
		return;
	}
	pass('only sanctioned files reach into FullIdentity.keys.active/owner');
}

// ─── Scenario 3: useJitKey wipes in `finally` ─────────────────
function checkUseJitKeyFinallyWipe(): void {
	const keystorePath = path.join(APP_WEB_SRC, 'lib/crypto/keystore.ts');
	const src = readFileSync(keystorePath, 'utf8');

	// Find the useJitKey function body
	const m = src.match(/async function useJitKey<T>\([\s\S]*?\n\}/);
	if (!m) {
		fail('keystore.ts: cannot find useJitKey function body');
		return;
	}
	const body = m[0];

	// The body must contain a `finally` block with a
	// `sodium.memzero(wanted)` call.  We don't enforce the exact
	// position but we verify the two tokens appear together in a
	// finally block.
	const finallyRe = /finally\s*\{[\s\S]*?sodium\.memzero\(\s*wanted\s*\)/;
	if (!finallyRe.test(body)) {
		fail('useJitKey: finally block does not contain sodium.memzero(wanted)');
		return;
	}
	pass('useJitKey: finally block wipes `wanted` on success and throw');
}

// ─── Scenario 4: M6 pubkey-pin check is reachable ─────────────
function checkM6PubkeyPin(): void {
	const keystorePath = path.join(APP_WEB_SRC, 'lib/crypto/keystore.ts');
	const src = readFileSync(keystorePath, 'utf8');

	// Find the useJitKey function and ensure the
	// `expectedPostingPub` / `identity_mismatch` defense is
	// present.
	const m = src.match(/async function useJitKey<T>\([\s\S]*?\n\}/);
	if (!m) {
		fail('keystore.ts: cannot find useJitKey function body');
		return;
	}
	const body = m[0];

	if (!/expectedPostingPub/.test(body)) {
		fail('useJitKey: missing expectedPostingPub parameter (M6 defense gone)');
		return;
	}
	if (!/identity_mismatch/.test(body)) {
		fail('useJitKey: missing identity_mismatch throw (M6 defense gone)');
		return;
	}
	if (!/constantTimeEqual/.test(body)) {
		fail('useJitKey: M6 pubkey check should use constantTimeEqual; replaced with what?');
		return;
	}
	pass('useJitKey: M6 pubkey-pin check intact (constant-time, identity_mismatch throw)');
}

// ─── Scenario 5: every active-key call site clears its password ─
function checkPasswordClearAtCallSites(): void {
	// Files that take a user-typed password and call
	// runWithActiveKey or useActiveKey.  Each must contain at
	// least one `password = ''` or `passwordInput = ''`
	// statement.  This is a structural check — it can't prove
	// the clear happens on EVERY branch, but it verifies the
	// basic discipline.
	const callSites = [
		path.join(APP_WEB_SRC, 'lib/components/FeatureBidForm.svelte'),
		path.join(APP_WEB_SRC, 'lib/components/PayBlurtModal.svelte'),
		path.join(APP_WEB_SRC, 'lib/components/StrangerFeeModal.svelte'),
		path.join(APP_WEB_SRC, 'routes/[lang]/post/+page.svelte')
	];
	for (const file of callSites) {
		const src = readFileSync(file, 'utf8');
		const usesActiveKey = /runWithActiveKey\s*\(/.test(src) || /useActiveKey\s*\(/.test(src);
		if (!usesActiveKey) {
			fail(
				`${path.relative(REPO_ROOT, file)}: expected this file to call active-key API but it does not — registry stale`
			);
			continue;
		}
		// Must clear password in at least two distinct places (success + error)
		const clearMatches = src.match(/(password|passwordInput)\s*=\s*['"]{2}/g) ?? [];
		if (clearMatches.length < 2) {
			fail(
				`${path.relative(REPO_ROOT, file)}: clears password fewer than 2 times (expected on success AND error paths) — found ${clearMatches.length}`
			);
			continue;
		}
		pass(
			`${path.relative(REPO_ROOT, file).replace(APP_WEB_SRC, '')}: password cleared on multiple branches`
		);
	}
}

// ─── Scenario 5b: identity-boot routes clear their password ──
//
// These routes don't directly invoke runWithActiveKey, but they
// take the user's keystore password (or onboarding session
// password) and pass it to bootFromEnvelope.  After successful
// boot, the password should be cleared from component state
// before navigating away (the component unmount will GC it
// eventually, but explicit clears shorten the heap-residency
// window).
function checkBootRoutesPasswordClear(): void {
	const bootSites = [
		path.join(APP_WEB_SRC, 'routes/[lang]/login/+page.svelte'),
		path.join(APP_WEB_SRC, 'routes/[lang]/onboarding/+page.svelte'),
		path.join(APP_WEB_SRC, 'routes/[lang]/onboarding/import/+page.svelte')
	];
	for (const file of bootSites) {
		const src = readFileSync(file, 'utf8');
		const usesBoot = /bootFromEnvelope\s*\(/.test(src);
		if (!usesBoot) {
			fail(
				`${path.relative(REPO_ROOT, file)}: expected this file to call bootFromEnvelope but it does not — registry stale`
			);
			continue;
		}
		// Must clear password in at least one place (the boot path
		// always navigates away on success, so a single clear before
		// the goto() is the minimum).
		const clearMatches =
			src.match(
				/(password|passwordInput|enrollPassword|softenPassword|postingNewPassword)\s*=\s*['"]{2}/g
			) ?? [];
		if (clearMatches.length === 0) {
			fail(
				`${path.relative(REPO_ROOT, file)}: never clears its password var — leaks to GC-only cleanup`
			);
			continue;
		}
		pass(
			`${path.relative(REPO_ROOT, file).replace(APP_WEB_SRC, '')}: password var cleared (${clearMatches.length} site${clearMatches.length === 1 ? '' : 's'})`
		);
	}
}

// ─── Scenario 6: Sourcemaps off in production build ───────────
function checkSourcemapsDisabled(): void {
	const vitePath = path.join(REPO_ROOT, 'apps/web/vite.config.js');
	const src = readFileSync(vitePath, 'utf8');
	if (!/sourcemap\s*:\s*false/.test(src)) {
		fail('vite.config.js: sourcemap is not explicitly set to false');
		return;
	}
	pass('vite.config.js: sourcemap explicitly disabled in build config');
}

// ─── Scenario 7: HardwareKeyCard clears passwords on error ────
function checkHardwareKeyCardErrorClear(): void {
	const file = path.join(APP_WEB_SRC, 'lib/components/HardwareKeyCard.svelte');
	const src = readFileSync(file, 'utf8');
	// doEnroll catch block must clear enrollPassword
	const enrollCatchRe =
		/async function doEnroll[\s\S]*?\}\s*catch[\s\S]*?enrollPassword\s*=\s*['"]{2}[\s\S]*?\}\s*finally/;
	if (!enrollCatchRe.test(src)) {
		fail('HardwareKeyCard.doEnroll: catch block does not clear enrollPassword');
		return;
	}
	const softenCatchRe =
		/async function doSoften[\s\S]*?\}\s*catch[\s\S]*?softenPassword\s*=\s*['"]{2}[\s\S]*?\}\s*finally/;
	if (!softenCatchRe.test(src)) {
		fail('HardwareKeyCard.doSoften: catch block does not clear softenPassword');
		return;
	}
	pass('HardwareKeyCard: enroll + soften clear passwords on error path');
}

// ─── Walker ───────────────────────────────────────────────────
function walkSourceFiles(dir: string, visit: (filepath: string) => void): void {
	for (const entry of readdirSync(dir)) {
		const filepath = path.join(dir, entry);
		const st = statSync(filepath);
		if (st.isDirectory()) {
			if (entry === 'node_modules' || entry === '.svelte-kit') continue;
			walkSourceFiles(filepath, visit);
		} else if (st.isFile() && (filepath.endsWith('.ts') || filepath.endsWith('.svelte'))) {
			visit(filepath);
		}
	}
}

// ─── Run all scenarios ────────────────────────────────────────
console.log('active/owner key invariants smoke');
console.log('=================================');
checkLiveIdentityShape();
checkEntryPointsToActiveOwner();
checkUseJitKeyFinallyWipe();
checkM6PubkeyPin();
checkPasswordClearAtCallSites();
checkBootRoutesPasswordClear();
checkSourcemapsDisabled();
checkHardwareKeyCardErrorClear();

// Total scenario count used by run-smokes.sh's aggregator.
// LiveIdentity + entry-points + finally-wipe + M6
// + 4 active-key call-sites
// + 3 boot-route call-sites
// + sourcemaps + HardwareKeyCard
// = 13 total.
const TOTAL_SCENARIOS = 13;

if (failures > 0) {
	console.error(`\n✗ ${failures} invariant(s) violated`);
	process.exit(1);
}
console.log(`\n✓ all ${TOTAL_SCENARIOS} scenarios passed`);
