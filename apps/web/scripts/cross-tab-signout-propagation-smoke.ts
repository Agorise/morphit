#!/usr/bin/env tsx
/**
 * Smoke: cross-tab SIGN-OUT propagation for the in-memory session handoff.
 *
 * Anchor: BroadcastChannel session handoff + its flagged follow-up.
 *
 * Background. A later change added an in-memory cross-tab session handoff
 * (`stores/identity.ts`, channel `morphit-session-handoff-v1`): a freshly
 * booted locked tab can be handed a live session by a sibling tab, in
 * memory, never touching disk. That closed a real UX gap (a new tab no
 * longer forces a re-login) but opened a SECURITY gap: the only older
 * cross-tab sign-out mirror is `handleStorageEvent`, which fires solely on
 * an on-disk envelope CHANGE. For an in-memory-only session (the default —
 * "Remember me" unchecked → no persisted envelope), an explicit Sign Out
 * deletes nothing on disk, so no `storage` event fires, so a sibling tab
 * that the handoff cloned the session into would KEEP its live keys after
 * the user explicitly signed out. For a non-custodial wallet that is a real
 * defect ("I signed out but my keys are still live in another tab").
 *
 * Fix: a `'signout'` message on the handoff channel plus
 * an exported `broadcastSignOut()` that posts it and then resets THIS tab.
 * The explicit Sign Out button (`AvatarMenu.svelte` confirmSignOut)
 * calls `broadcastSignOut()` instead of `reset()`.
 *
 * THE CRITICAL SAFETY INVARIANT this smoke protects. The signout broadcast
 * must live ONLY in `broadcastSignOut()` — NEVER in `reset()`, the
 * `pagehide` tab-close handler, or `lockSession()`. `reset()` is itself
 * called from `pagehide`, so a signout broadcast inside `reset()` would mean
 * "closing one tab signs the user out of every other tab", and the idle
 * auto-lock routes through `lockSession()`, which must not sign sibling
 * tabs out either. (v1.20.0: the EXPLICIT Lock uses `lockAllTabs()`, which
 * broadcasts a `'lock'` — never `'signout'` — so sibling tabs lock and keep
 * the Remember-me envelope; #11 pins that.) vitest cannot exercise the pagehide path
 * (the listener is registered only under the SvelteKit `browser` flag, false
 * in jsdom), so this source-level guard is the regression net for it.
 *
 * BEHAVIOUR (#2): the cross-tab handlers are RUN — the vitest suites
 * src/lib/stores/identity.test.ts and identity.lockAllTabs.test.ts drive
 * handleSessionHandoffMessage / handleStorageEvent / broadcastSignOut /
 * lockAllTabs with real messages and events; this smoke runs them and
 * requires every case to pass, the sign-out ones by name.
 *
 * What this asserts against the on-disk source (the pagehide listener is
 * registered only in the browser, so these stay structural):
 *   1. identity.ts declares a SessionHandoffMessage 'signout' variant.
 *   3. broadcastSignOut is exported, posts { t: 'signout' }, and calls
 *      reset().
 *   4. SAFETY: reset()'s body contains NO signout broadcast / postMessage.
 *   5. SAFETY: the pagehide listener body contains NO signout broadcast /
 *      postMessage.
 *   6. SAFETY: lockSession()'s body contains NO signout broadcast /
 *      postMessage.
 *   7. SAFETY: 'signout' is posted from EXACTLY ONE place (broadcastSignOut).
 *   8. AvatarMenu.svelte's confirmSignOut calls broadcastSignOut() and
 *      not a bare reset()/resetIdentity().
 *  11. lockAllTabs() (explicit Lock) broadcasts { t: 'lock' } and never
 *      'signout'; the handler's 'lock' branch locks (lockSession) and never
 *      clears the disk. (Behaviour is covered by identity.lockAllTabs.test.ts.)
 *
 * Tamper tests (each must turn the smoke red):
 *   - Move the postMessage({ t:'signout' }) from broadcastSignOut into
 *     reset() → fails #4 and #7.
 *   - Drop the reset() call from broadcastSignOut → fails #3.
 *   - Point confirmSignOut back at reset()/resetIdentity() → fails #8.
 *   - Remove the t==='signout' branch from the handler → fails #2.
 */

import { readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

const STORE = join(REPO_ROOT, 'apps/web/src/lib/stores/identity.ts');
const AVATAR_MENU = join(REPO_ROOT, 'apps/web/src/lib/components/AvatarMenu.svelte');

for (const p of [STORE, AVATAR_MENU]) {
	if (!existsSync(p)) {
		console.error(`  ✗ source file missing: ${p}`);
		process.exit(1);
	}
}

const store = readFileSync(STORE, 'utf-8');
const avatarMenu = readFileSync(AVATAR_MENU, 'utf-8');

let passes = 0;
let failures = 0;
function pass(msg: string): void {
	console.log(`  ✓ ${msg}`);
	passes++;
}
function fail(msg: string, detail: string): void {
	console.error(`  ✗ ${msg}`);
	console.error(`      ${detail}`);
	failures++;
}

/**
 * Extract a function body by brace-matching from the first `{` at or after
 * the signature match. Returns the body text (between the outer braces),
 * or null if the signature isn't found / braces don't balance.
 */
function extractBody(src: string, signatureRe: RegExp): string | null {
	const m = signatureRe.exec(src);
	if (!m) return null;
	const open = src.indexOf('{', m.index + m[0].length - 1);
	if (open < 0) return null;
	let depth = 0;
	for (let i = open; i < src.length; i++) {
		const c = src[i];
		if (c === '{') depth++;
		else if (c === '}') {
			depth--;
			if (depth === 0) return src.slice(open + 1, i);
		}
	}
	return null;
}

/** A signout broadcast = any post/postMessage call carrying t:'signout'. */
const SIGNOUT_BROADCAST_RE = /(?:postMessage|post)\s*\(\s*\{\s*t\s*:\s*['"]signout['"]/;

// ── #1: SessionHandoffMessage has a 'signout' variant ───────────────────────
if (/type\s+SessionHandoffMessage\b[\s\S]*?\{\s*t\s*:\s*['"]signout['"]\s*\}/.test(store)) {
	pass(`SessionHandoffMessage declares a { t: 'signout' } variant`);
} else {
	fail(
		`SessionHandoffMessage 'signout' variant missing`,
		`expected the union type to include { t: 'signout' }`
	);
}

// ── #2: the handlers, RUN (vitest) ─────────────────────────────────────────
{
	const out = join(tmpdir(), `cross-tab-vitest-${process.pid}.json`);
	const r = spawnSync(
		'npx',
		[
			'vitest',
			'run',
			'src/lib/stores/identity.test.ts',
			'src/lib/stores/identity.lockAllTabs.test.ts',
			'--reporter=json',
			`--outputFile=${out}`
		],
		{ cwd: join(REPO_ROOT, 'apps/web'), encoding: 'utf8', timeout: 600_000 }
	);
	let report: {
		numFailedTests?: number;
		numPassedTests?: number;
		testResults?: { assertionResults?: { title: string; status: string }[] }[];
	} = {};
	try {
		report = JSON.parse(readFileSync(out, 'utf-8')) as typeof report;
	} catch {
		// no report: counted as a failure below
	}
	const results = (report.testResults ?? []).flatMap((t) => t.assertionResults ?? []);
	const passedTitle = (re: RegExp): boolean =>
		results.some((a) => re.test(a.title) && a.status === 'passed');
	if (
		r.status === 0 &&
		(report.numFailedTests ?? 1) === 0 &&
		passedTitle(/'signout' from a sibling tab wipes our in-memory session/) &&
		passedTitle(/broadcastSignOut resets THIS tab/) &&
		passedTitle(/envelope deletion in another tab/) &&
		passedTitle(/sibling tab that receives the Lock locks too/)
	) {
		pass(
			`cross-tab handlers behave (${report.numPassedTests} vitest cases, sign-out/lock ones included)`
		);
	} else {
		fail(
			`cross-tab handler behaviour`,
			`vitest exit ${r.status}, ${report.numFailedTests ?? '?'} failed — run: npx vitest run src/lib/stores/identity.test.ts src/lib/stores/identity.lockAllTabs.test.ts`
		);
	}
}

// ── #3: broadcastSignOut posts signout AND resets ───────────────────────────
const isExportedBroadcast = /export\s+function\s+broadcastSignOut\b/.test(store);
const broadcastBody = extractBody(store, /function\s+broadcastSignOut\b/);
if (!isExportedBroadcast) {
	fail(`broadcastSignOut not exported`, `the Sign Out button needs to import it`);
} else if (!broadcastBody) {
	fail(`broadcastSignOut body not found`, `brace-match failed`);
} else {
	const postsSignout = SIGNOUT_BROADCAST_RE.test(broadcastBody);
	const resetsLocally = /\breset\s*\(\s*\)/.test(broadcastBody);
	if (postsSignout && resetsLocally) {
		pass(`broadcastSignOut posts { t: 'signout' } and resets this tab`);
	} else {
		const missing: string[] = [];
		if (!postsSignout) missing.push("postMessage({ t: 'signout' })");
		if (!resetsLocally) missing.push('reset() call');
		fail(`broadcastSignOut incomplete`, `missing: ${missing.join('; ')}`);
	}
}

// ── #4: SAFETY — reset() must NOT broadcast signout ─────────────────────────
const resetBody = extractBody(store, /export\s+function\s+reset\s*\([^)]*\)\s*:/);
if (!resetBody) {
	fail(`reset() body not found`, `brace-match failed`);
} else if (SIGNOUT_BROADCAST_RE.test(resetBody) || /postMessage\s*\(/.test(resetBody)) {
	fail(
		`SAFETY VIOLATION: reset() broadcasts signout / postMessage`,
		`reset() is called from pagehide — a signout broadcast here means closing one tab signs the user out everywhere`
	);
} else {
	pass(`SAFETY: reset() does not broadcast signout (tab-close stays local)`);
}

// ── #5: SAFETY — pagehide handler must NOT broadcast signout ────────────────
// The listener may take the event (`(e) =>`) and delegate to the exported
// handlePageHide(); check both bodies.
const listenerBody = extractBody(
	store,
	/addEventListener\s*\(\s*['"]pagehide['"]\s*,\s*\(\s*\w*\s*\)\s*=>/
);
const handlePageHideBody = extractBody(store, /export\s+function\s+handlePageHide\s*\([^)]*\)\s*:/);
const pagehideBody =
	listenerBody === null ? null : listenerBody + '\n' + (handlePageHideBody ?? '');
if (!pagehideBody) {
	fail(`pagehide handler body not found`, `brace-match failed`);
} else if (SIGNOUT_BROADCAST_RE.test(pagehideBody) || /postMessage\s*\(/.test(pagehideBody)) {
	fail(
		`SAFETY VIOLATION: pagehide handler broadcasts signout / postMessage`,
		`closing a tab must not sign the user out of their other tabs`
	);
} else {
	pass(`SAFETY: pagehide handler does not broadcast signout`);
}

// ── #6: SAFETY — lockSession() must NOT broadcast signout ───────────────────
const lockBody = extractBody(store, /export\s+function\s+lockSession\s*\(\s*\)\s*:/);
if (!lockBody) {
	fail(`lockSession() body not found`, `brace-match failed`);
} else if (SIGNOUT_BROADCAST_RE.test(lockBody) || /postMessage\s*\(/.test(lockBody)) {
	fail(
		`SAFETY VIOLATION: lockSession() broadcasts signout / postMessage`,
		`the idle auto-lock and per-tab Lock route through lockSession — they must not sign sibling tabs out`
	);
} else {
	pass(`SAFETY: lockSession() does not broadcast signout (idle-lock stays local)`);
}

// ── #7: SAFETY — signout is broadcast from EXACTLY ONE place ────────────────
const broadcastSites = (store.match(new RegExp(SIGNOUT_BROADCAST_RE.source, 'g')) ?? []).length;
if (broadcastSites === 1) {
	pass(`signout is broadcast from exactly one site (broadcastSignOut)`);
} else {
	fail(
		`signout broadcast site count is ${broadcastSites}, expected exactly 1`,
		`the single distinguishing act of an EXPLICIT sign-out must live only in broadcastSignOut`
	);
}

// ── #8: settings Sign Out button calls broadcastSignOut, not bare reset ─────
const importsBroadcast =
	/import\s*\{[^}]*\bbroadcastSignOut\b[^}]*\}\s*from\s*['"]\$stores\/identity['"]/.test(
		avatarMenu
	);
const confirmBody = extractBody(avatarMenu, /function\s+confirmSignOut\s*\(\s*\)\s*:/);
if (!importsBroadcast) {
	fail(`AvatarMenu does not import broadcastSignOut`, `Sign Out must propagate cross-tab`);
} else if (!confirmBody) {
	fail(`confirmSignOut body not found in AvatarMenu`, `brace-match failed`);
} else {
	const callsBroadcast = /\bbroadcastSignOut\s*\(\s*\)/.test(confirmBody);
	// A bare reset()/resetIdentity() in confirmSignOut would skip the
	// cross-tab broadcast — the exact pre-fix bug.
	const callsBareReset = /\b(?:reset|resetIdentity)\s*\(\s*\)/.test(confirmBody);
	if (callsBroadcast && !callsBareReset) {
		pass(`AvatarMenu confirmSignOut calls broadcastSignOut() (not a bare reset)`);
	} else if (!callsBroadcast) {
		fail(
			`confirmSignOut does not call broadcastSignOut()`,
			`cross-tab sign-out would not propagate`
		);
	} else {
		fail(
			`confirmSignOut still calls a bare reset()/resetIdentity()`,
			`use broadcastSignOut() exclusively so the in-memory-only case propagates`
		);
	}
}

// ── #11: explicit Lock broadcasts 'lock' (never 'signout') ──────────────────
const lockAllBody = extractBody(store, /export\s+function\s+lockAllTabs\s*\(/);
const lockBranch =
	/msg\.t\s*===\s*['"]lock['"]\s*\)\s*\{([\s\S]*?)\}\s*else\s+if/.exec(store)?.[1] ?? null;
if (!lockAllBody) {
	fail(`lockAllTabs() body not found`, `the explicit Lock must reach sibling tabs (v1.20.0 F-5)`);
} else if (
	SIGNOUT_BROADCAST_RE.test(lockAllBody) ||
	!/\{\s*t\s*:\s*['"]lock['"]\s*\}/.test(lockAllBody)
) {
	fail(`lockAllTabs() must post { t: 'lock' } and never 'signout'`, `Lock is not Sign Out`);
} else if (
	lockBranch === null ||
	!/\blockSession\s*\(/.test(lockBranch) ||
	/clearDisk|reset\s*\(/.test(lockBranch)
) {
	fail(
		`the handler's 'lock' branch must call lockSession() and never clear the disk`,
		`Lock keeps the Remember-me envelope`
	);
} else {
	pass(
		`explicit Lock broadcasts 'lock' (not 'signout') and siblings lock without clearing the disk`
	);
}

// ── #9: broadcastSignOut clears the cached self-avatar ───────────────
// The selfProfile store holds the logged-in user's own avatar (shown in the
// menu + their IdentityLabels). On an EXPLICIT sign-out it must be dropped,
// or the next account / signed-out view briefly shows the prior user's
// avatar. Regression guard for the find (clearSelfProfile was
// defined but never called). The per-tab part of a sign-out lives in
// forgetAccountInThisTab(), which broadcastSignOut AND the sibling tabs'
// 'signout' handler both call (behaviour: src/lib/stores/signOutSiblingTab.test.ts).
const forgetBody = extractBody(store, /function\s+forgetAccountInThisTab\b/);
const signOutClears = (body: string): boolean =>
	/clearSelfProfile/.test(body) ||
	(forgetBody !== null &&
		/\bforgetAccountInThisTab\s*\(\s*\)/.test(body) &&
		/clearSelfProfile/.test(forgetBody));
if (broadcastBody && signOutClears(broadcastBody)) {
	pass(`broadcastSignOut clears the cached self-avatar (clearSelfProfile)`);
} else if (broadcastBody) {
	fail(
		`broadcastSignOut does not clear the self-avatar`,
		`must call clearSelfProfile() (selfProfile store) so the prior user's avatar can't leak across sign-out`
	);
}

// ── #10: SAFETY — reset()/lock must NOT clear the self-avatar ────────────────
// Like the name-clear and the signout broadcast, dropping the self-avatar
// belongs to an EXPLICIT sign-out only. reset() runs on pagehide/lockSession,
// where the avatar is public data that should survive (re-shown on unlock);
// clearing it there would flicker the menu on every tab-close/lock.
if (resetBody && /clearSelfProfile/.test(resetBody)) {
	fail(
		`reset() clears the self-avatar`,
		`clearSelfProfile belongs in broadcastSignOut only — reset() runs on pagehide/lock where the avatar should persist`
	);
} else {
	pass(`SAFETY: reset() does not clear the self-avatar (persists across lock/tab-close)`);
}

// ── #11: broadcastSignOut clears the keystore SYNCHRONOUSLY ──────────
// The signed-out header CTA reads hasPersistedKeystore() inside a $derived
// whose only reactive trigger is $hasAnySession — which flips synchronously
// inside reset(). If the disk clear is deferred (reset()'s async clearDisk
// dynamic-import path), it lands a microtask AFTER that single re-run, so the
// button stays stuck on "Unlock" post-sign-out (AvatarMenu lives in the
// layout, so the navigation home doesn't remount it to re-read, and
// hasPersistedKeystore() is a plain localStorage read, not a reactive dep).
// broadcastSignOut must therefore call clearKeystore() synchronously in its
// own body, before reset() runs. accept BOTH the direct call
// `clearKeystore()` and the isolated form `bestEffort(clearKeystore)`: the
// sign-out hardening wraps each clear in a synchronous try/catch isolator
// (`bestEffort` invokes its argument immediately), so the keystore is still
// wiped synchronously and BEFORE reset() — the invariant is preserved,
// just wrapped. Strip line comments first so comment-mentions of `reset()` /
// `clearKeystore` (this body has several) don't skew the presence/order check,
// then assert the ordering (keystore clear precedes reset) on real code only.
const broadcastCode = broadcastBody ? broadcastBody.replace(/\/\/[^\n]*/g, '') : '';
const keystoreSyncIdx = broadcastBody
	? broadcastCode.search(/\bclearKeystore\s*\(\s*\)|\bbestEffort\s*\(\s*clearKeystore\s*[),]/)
	: -1;
const resetCallIdx = broadcastBody ? broadcastCode.search(/\breset\s*\(\s*\)/) : -1;
if (
	broadcastBody &&
	keystoreSyncIdx !== -1 &&
	(resetCallIdx === -1 || keystoreSyncIdx < resetCallIdx)
) {
	pass(
		`broadcastSignOut clears the keystore synchronously before reset() (header CTA reverts to Sign in, not Unlock)`
	);
} else if (broadcastBody) {
	fail(
		`broadcastSignOut does not clear the keystore synchronously before reset()`,
		`clear the keystore in broadcastSignOut BEFORE reset() — directly as clearKeystore() or via the synchronous isolator bestEffort(clearKeystore); relying only on reset()'s async clearDisk path leaves the signed-out header button stuck on "Unlock"`
	);
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} cross-tab-signout-propagation scenarios passed`);
