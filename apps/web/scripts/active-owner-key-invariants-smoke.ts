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
 * 1. BEHAVIOUR: a live session built from a full identity
 *    (`toLiveIdentity`) holds no owner, active or memo private key
 *    bytes anywhere in it — and the source's copies are zeroed.
 *
 * 2. The only entry points to the active private key are
 *    `useActiveKey` / `useActiveKeyForPasswordChange` in
 *    `keystore.ts` (nothing hands out the owner key). No other
 *    file reaches into a `FullIdentity` to pull `keys.active`
 *    or `keys.owner` outside the sanctioned crypto modules.
 *
 * 3. BEHAVIOUR: `useActiveKey` hands the callback the ACTIVE key
 *    (not owner, not posting), and the buffer it handed over is
 *    zeroed afterwards — on success and when the callback throws.
 *
 * 3b. BEHAVIOUR: a keystore that decrypts to a different account
 *    than the running session (the M6 defence) is refused with
 *    `identity_mismatch`, and the callback never runs.
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

// ─── Scenario 1: a live session holds no owner/active/memo private key ─
async function checkLiveIdentityHoldsNoRecoveryKeys(): Promise<void> {
	const { generateFullIdentity, toLiveIdentity } = await import('../src/lib/crypto/keygen.ts');
	const full = await generateFullIdentity();
	const secrets = (['owner', 'active', 'memo'] as const).map((r) =>
		full.keys[r]!.privateKey.slice()
	);
	const live = toLiveIdentity(full);
	const held: Uint8Array[] = [];
	const collect = (v: unknown): void => {
		if (v instanceof Uint8Array) held.push(v);
		else if (v && typeof v === 'object') for (const x of Object.values(v)) collect(x);
	};
	collect(live);
	const same = (a: Uint8Array, b: Uint8Array): boolean =>
		a.length === b.length && a.every((x, i) => x === b[i]);
	if (held.some((h) => secrets.some((sec) => same(h, sec)))) {
		fail('the live session holds an owner, active or memo private key');
		return;
	}
	if (
		(['owner', 'active', 'memo'] as const).some((r) =>
			full.keys[r]!.privateKey.some((b) => b !== 0)
		)
	) {
		fail('toLiveIdentity left an owner/active/memo private key un-zeroed in its source');
		return;
	}
	pass('a live session holds only the posting private key (owner/active/memo zeroed)');
}

// ─── Scenario 2: only sanctioned entry points to active/owner ─
function checkEntryPointsToActiveOwner(): void {
	// Allowed callers for FullIdentity.keys.active / .owner
	const allowedFiles = new Set([
		path.join(APP_WEB_SRC, 'lib/crypto/keystore.ts'),
		path.join(APP_WEB_SRC, 'lib/crypto/keygen.ts'),
		// A later change moved the sanctioned toLiveIdentity/wipeLiveIdentity helpers
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

// ─── Scenario 3: useActiveKey hands out the ACTIVE key and wipes it ───
async function checkUseActiveKeyHandsOutActiveAndWipes(): Promise<void> {
	const { generateFullIdentity } = await import('../src/lib/crypto/keygen.ts');
	const { encryptIdentity, useActiveKey } = await import('../src/lib/crypto/keystore.ts');
	const PW = 'correct-horse-battery-staple';
	const full = await generateFullIdentity();
	const active = full.keys.active!.privateKey.slice();
	const postingPub = full.keys.posting.publicKey.slice();
	const env = await encryptIdentity(full, PW);
	let handed: Uint8Array | null = null;
	let gotActive = false;
	await useActiveKey(
		env,
		PW,
		async (k) => {
			handed = k;
			gotActive = k.length === active.length && k.every((b, i) => b === active[i]);
		},
		postingPub
	);
	const wipedOnSuccess = handed !== null && (handed as Uint8Array).every((b) => b === 0);
	let handedOnThrow: Uint8Array | null = null;
	await useActiveKey(
		env,
		PW,
		async (k) => {
			handedOnThrow = k;
			throw new Error('callback failed');
		},
		postingPub
	).catch(() => undefined);
	const wipedOnThrow =
		handedOnThrow !== null && (handedOnThrow as Uint8Array).every((b) => b === 0);
	if (!gotActive) fail('useActiveKey did not hand the callback the ACTIVE private key');
	else if (!wipedOnSuccess) fail('useActiveKey left the active key un-wiped after the callback');
	else if (!wipedOnThrow) fail('useActiveKey left the active key un-wiped when the callback threw');
	else pass('useActiveKey hands out the active key and wipes it on success and on throw');
}

// ─── Scenario 3b: a keystore of another account is refused (M6) ─────
async function checkIdentityMismatchRefused(): Promise<void> {
	const { generateFullIdentity } = await import('../src/lib/crypto/keygen.ts');
	const { encryptIdentity, useActiveKey } = await import('../src/lib/crypto/keystore.ts');
	const PW = 'correct-horse-battery-staple';
	const mine = await generateFullIdentity();
	const theirs = await generateFullIdentity();
	const swapped = await encryptIdentity(theirs, PW);
	let called = false;
	const err = await useActiveKey(
		swapped,
		PW,
		async () => {
			called = true;
		},
		mine.keys.posting.publicKey
	).then(
		() => null,
		(e: unknown) => e as { kind?: string }
	);
	if (called || err?.kind !== 'identity_mismatch') {
		fail(
			'a keystore of another account was not refused with identity_mismatch before the callback'
		);
		return;
	}
	pass('a keystore of another account is refused (identity_mismatch), callback never runs');
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
await checkLiveIdentityHoldsNoRecoveryKeys();
checkEntryPointsToActiveOwner();
await checkUseActiveKeyHandsOutActiveAndWipes();
await checkIdentityMismatchRefused();
checkPasswordClearAtCallSites();
checkBootRoutesPasswordClear();
checkSourcemapsDisabled();
checkHardwareKeyCardErrorClear();

// Total scenario count used by run-smokes.sh's aggregator.
// live session + entry-points + active key handed out & wiped + M6
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
