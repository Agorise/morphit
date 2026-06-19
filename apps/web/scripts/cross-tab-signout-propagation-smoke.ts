#!/usr/bin/env tsx
/**
 * Smoke: cross-tab SIGN-OUT propagation for the in-memory session handoff.
 *
 * Anchor: cp290 BroadcastChannel session handoff + its flagged follow-up.
 *
 * Background. cp290 added an in-memory cross-tab session handoff
 * (`stores/identity.ts`, channel `morphit-session-handoff-v1`): a freshly
 * booted locked tab can be handed a live session by a sibling tab, in
 * memory, never touching disk. That closed a real UX gap (a new tab no
 * longer forces a re-login) but opened a SECURITY gap: the only pre-cp290
 * cross-tab sign-out mirror is `handleStorageEvent`, which fires solely on
 * an on-disk envelope CHANGE. For an in-memory-only session (the default —
 * "Remember me" unchecked → no persisted envelope), an explicit Sign Out
 * deletes nothing on disk, so no `storage` event fires, so a sibling tab
 * that the handoff cloned the session into would KEEP its live keys after
 * the user explicitly signed out. For a non-custodial wallet that is a real
 * defect ("I signed out but my keys are still live in another tab").
 *
 * Fix (cp290 follow-up): a `'signout'` message on the handoff channel plus
 * an exported `broadcastSignOut()` that posts it and then resets THIS tab.
 * The explicit Sign Out button (`settings/+page.svelte` confirmSignOut)
 * calls `broadcastSignOut()` instead of `reset()`.
 *
 * THE CRITICAL SAFETY INVARIANT this smoke protects. The signout broadcast
 * must live ONLY in `broadcastSignOut()` — NEVER in `reset()`, the
 * `pagehide` tab-close handler, or `lockSession()`. `reset()` is itself
 * called from `pagehide`, so a signout broadcast inside `reset()` would mean
 * "closing one tab signs the user out of every other tab", and the idle
 * auto-lock / per-tab Lock route through `lockSession()`, which must not
 * sign sibling tabs out either. vitest cannot exercise the pagehide path
 * (the listener is registered only under the SvelteKit `browser` flag, false
 * in jsdom), so this source-level guard is the regression net for it.
 *
 * What this asserts against the on-disk source:
 *   1. identity.ts declares a SessionHandoffMessage 'signout' variant.
 *   2. handleSessionHandoffMessage is exported and, on t === 'signout',
 *      calls reset().
 *   3. broadcastSignOut is exported, posts { t: 'signout' }, and calls
 *      reset().
 *   4. SAFETY: reset()'s body contains NO signout broadcast / postMessage.
 *   5. SAFETY: the pagehide listener body contains NO signout broadcast /
 *      postMessage.
 *   6. SAFETY: lockSession()'s body contains NO signout broadcast /
 *      postMessage.
 *   7. SAFETY: 'signout' is posted from EXACTLY ONE place (broadcastSignOut).
 *   8. settings/+page.svelte's confirmSignOut calls broadcastSignOut() and
 *      not a bare reset()/resetIdentity().
 *
 * Tamper tests (each must turn the smoke red):
 *   - Move the postMessage({ t:'signout' }) from broadcastSignOut into
 *     reset() → fails #4 and #7.
 *   - Drop the reset() call from broadcastSignOut → fails #3.
 *   - Point confirmSignOut back at reset()/resetIdentity() → fails #8.
 *   - Remove the t==='signout' branch from the handler → fails #2.
 */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = join(__dirname, '..', '..', '..');

const STORE = join(REPO_ROOT, 'apps/web/src/lib/stores/identity.ts');
const SETTINGS = join(REPO_ROOT, 'apps/web/src/routes/[lang]/settings/+page.svelte');

for (const p of [STORE, SETTINGS]) {
	if (!existsSync(p)) {
		console.error(`  ✗ source file missing: ${p}`);
		process.exit(1);
	}
}

const store = readFileSync(STORE, 'utf-8');
const settings = readFileSync(SETTINGS, 'utf-8');

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

// ── #2: handler resets on 'signout' ─────────────────────────────────────────
const isExportedHandler = /export\s+function\s+handleSessionHandoffMessage\b/.test(store);
const handlerBody = extractBody(store, /function\s+handleSessionHandoffMessage\b/);
if (!isExportedHandler) {
	fail(`handleSessionHandoffMessage not exported`, `must be exported so vitest can drive it`);
} else if (!handlerBody) {
	fail(`handleSessionHandoffMessage body not found`, `brace-match failed`);
} else {
	const handlesSignout = /['"]signout['"]/.test(handlerBody);
	const resetsOnSignout = /\breset\s*\(\s*\)/.test(handlerBody);
	if (handlesSignout && resetsOnSignout) {
		pass(`handleSessionHandoffMessage handles 'signout' and calls reset()`);
	} else {
		const missing: string[] = [];
		if (!handlesSignout) missing.push("'signout' branch");
		if (!resetsOnSignout) missing.push('reset() call');
		fail(`handleSessionHandoffMessage signout handling incomplete`, `missing: ${missing.join('; ')}`);
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
const resetBody = extractBody(store, /export\s+function\s+reset\s*\(\s*\)\s*:/);
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
const pagehideBody = extractBody(store, /addEventListener\s*\(\s*['"]pagehide['"]\s*,\s*\(\s*\)\s*=>/);
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
const importsBroadcast = /import\s*\{[^}]*\bbroadcastSignOut\b[^}]*\}\s*from\s*['"]\$stores\/identity['"]/.test(
	settings
);
const confirmBody = extractBody(settings, /function\s+confirmSignOut\s*\(\s*\)\s*:/);
if (!importsBroadcast) {
	fail(`settings does not import broadcastSignOut`, `Sign Out must propagate cross-tab`);
} else if (!confirmBody) {
	fail(`confirmSignOut body not found in settings`, `brace-match failed`);
} else {
	const callsBroadcast = /\bbroadcastSignOut\s*\(\s*\)/.test(confirmBody);
	// A bare reset()/resetIdentity() in confirmSignOut would skip the
	// cross-tab broadcast — the exact pre-fix bug.
	const callsBareReset = /\b(?:reset|resetIdentity)\s*\(\s*\)/.test(confirmBody);
	if (callsBroadcast && !callsBareReset) {
		pass(`settings confirmSignOut calls broadcastSignOut() (not a bare reset)`);
	} else if (!callsBroadcast) {
		fail(`confirmSignOut does not call broadcastSignOut()`, `cross-tab sign-out would not propagate`);
	} else {
		fail(
			`confirmSignOut still calls a bare reset()/resetIdentity()`,
			`use broadcastSignOut() exclusively so the in-memory-only case propagates`
		);
	}
}

console.log(`\n${passes} passed, ${failures} failed`);
if (failures > 0) process.exit(1);
console.log(`✓ all ${passes} cross-tab-signout-propagation scenarios passed`);
