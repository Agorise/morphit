#!/usr/bin/env tsx
/**
 * service-worker-single-registration smoke — Part 122 cp81
 * (LL #81 / O-27).
 *
 * Prevents the cp81-D22 dual-registration bug from regressing.
 *
 * The bug: app.html manually called
 *   navigator.serviceWorker.register('/sw.js', { scope: '/' })
 * on window.load.  SvelteKit's auto-register (svelte.config.js
 * `serviceWorker: { register: true }`) ALSO injected a
 * window.load handler calling
 *   navigator.serviceWorker.register('/service-worker.js')
 * at the same scope `/`.  Per spec, the second register() call
 * at the same scope replaces the existing registration with the
 * new scriptURL.  App.html's manual script ran later in document
 * order, so /sw.js superseded the SvelteKit-managed
 * /service-worker.js — and /sw.js (the legacy static SW) had
 * no `push` or `notificationclick` handler.  Push notifications
 * were silently broken in production despite the full stack
 * being wired correctly.
 *
 * cp81-D22a fix: removed the manual register from app.html.
 * cp81-D22b fix: deleted apps/web/static/sw.js entirely.
 *
 * This smoke locks in the fix:
 *   - app.html must NOT contain any manual
 *     navigator.serviceWorker.register call.
 *   - apps/web/static/ must NOT contain sw.js (the legacy SW).
 *   - svelte.config.js must keep `serviceWorker.register: true`
 *     so SvelteKit's auto-register handles registration.
 *   - apps/web/src/service-worker.ts must exist (so SvelteKit
 *     has something to register).
 *
 * Mutation tests:
 *   M-150a: re-add manual register('/sw.js') to app.html →
 *     smoke fires.
 *   M-150b: recreate apps/web/static/sw.js → smoke fires.
 *   M-150c: set serviceWorker.register: false in svelte.config →
 *     smoke fires.
 *   M-150d: delete apps/web/src/service-worker.ts → smoke fires.
 *
 * Why this matters:
 *   - Push notifications are user-facing; silent breakage is
 *     worse than a loud error.
 *   - The pre-launch hardening campaign's whole point is
 *     preventing silent breakage of user-facing surfaces.
 */
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

interface Result {
	name: string;
	ok: boolean;
	detail?: string;
}
const results: Result[] = [];

// Resolve relative to the apps/web directory (where tsx will run this).
const root = resolve(import.meta.dirname, '..');

// ─── 1. app.html has no manual SW registration ──────────────
{
	const path = resolve(root, 'src/app.html');
	const text = readFileSync(path, 'utf8');
	// Strip HTML comments first so the historical reference in the
	// "this used to be a manual register" comment doesn't trip us.
	const stripped = text.replace(/<!--[\s\S]*?-->/g, '');
	const pat = /navigator\s*\.\s*serviceWorker\s*\.\s*register\s*\(/;
	const matches = pat.test(stripped);
	results.push({
		name: 'app.html has no manual navigator.serviceWorker.register call (outside comments)',
		ok: !matches,
		detail: matches
			? "Found manual register() call in app.html — this conflicts with SvelteKit's auto-register at the same scope (cp81-D22 regression)."
			: undefined
	});
}

// ─── 2. apps/web/static/sw.js does not exist ─────────────────
{
	const path = resolve(root, 'static/sw.js');
	const exists = existsSync(path);
	results.push({
		name: 'apps/web/static/sw.js (legacy SW) does not exist',
		ok: !exists,
		detail: exists
			? 'Legacy static/sw.js was reintroduced; it would be served at /sw.js and could be registered manually, racing with SvelteKit auto-register.'
			: undefined
	});
}

// ─── 3. svelte.config.js keeps serviceWorker.register: true ─
{
	const path = resolve(root, 'svelte.config.js');
	const text = readFileSync(path, 'utf8');
	// Look for the register: true setting inside a serviceWorker
	// block.  The block has multi-line formatting; check for the
	// literal "register: true" near "serviceWorker:".
	const swBlockIdx = text.indexOf('serviceWorker:');
	const swRegisterIdx = text.indexOf('register: true', swBlockIdx);
	const ok = swBlockIdx >= 0 && swRegisterIdx > swBlockIdx && swRegisterIdx - swBlockIdx < 400;
	results.push({
		name: 'svelte.config.js sets kit.serviceWorker.register: true (auto-register active)',
		ok,
		detail: ok
			? undefined
			: 'kit.serviceWorker.register: true not found near the serviceWorker block. Without auto-register, no SW is registered at all and push/cache features break.'
	});
}

// ─── 4. apps/web/src/service-worker.ts exists ────────────────
{
	const path = resolve(root, 'src/service-worker.ts');
	const exists = existsSync(path);
	results.push({
		name: 'apps/web/src/service-worker.ts exists (SvelteKit registration target)',
		ok: exists,
		detail: exists
			? undefined
			: 'src/service-worker.ts deleted; SvelteKit auto-register would have nothing to register.'
	});
}

// ─── 5. service-worker.ts has push + notificationclick handlers ───
{
	const path = resolve(root, 'src/service-worker.ts');
	const text = readFileSync(path, 'utf8');
	const hasPush = /addEventListener\(\s*['"]push['"]/.test(text);
	const hasClick = /addEventListener\(\s*['"]notificationclick['"]/.test(text);
	results.push({
		name: "service-worker.ts has both 'push' and 'notificationclick' listeners",
		ok: hasPush && hasClick,
		detail:
			hasPush && hasClick
				? undefined
				: `push=${hasPush} notificationclick=${hasClick}; the canonical SW must implement both for push notifications to work.`
	});
}

// ─── 6. clickPath origin validation present (cp81-D22b) ─────
//
// The logic is extracted to $lib/notifications/sanitizeClickPath
// so it can be unit-tested.  Verify two things:
//   a) service-worker.ts imports sanitizeClickPath and uses it
//   b) sanitizeClickPath.ts implements the origin check
{
	const swPath = resolve(root, 'src/service-worker.ts');
	const swText = readFileSync(swPath, 'utf8');
	const importsHelper =
		/from\s+['"]\$lib\/notifications\/sanitizeClickPath['"]/.test(swText) &&
		/sanitizeClickPath\s*\(/.test(swText);

	const helperPath = resolve(root, 'src/lib/notifications/sanitizeClickPath.ts');
	const helperExists = existsSync(helperPath);
	const helperText = helperExists ? readFileSync(helperPath, 'utf8') : '';
	const helperHasOriginCheck =
		/resolved\.origin\s*!==\s*origin/.test(helperText) ||
		/resolved\.origin\s*===\s*origin/.test(helperText);

	const ok = importsHelper && helperExists && helperHasOriginCheck;
	results.push({
		name: 'service-worker.ts uses sanitizeClickPath; helper validates same-origin (cp81-D22b)',
		ok,
		detail: ok
			? undefined
			: `service-worker.ts imports sanitizeClickPath: ${importsHelper}; helper file exists: ${helperExists}; helper has origin check: ${helperHasOriginCheck}. Without this gate, a malicious push payload could open a cross-origin URL via clients.openWindow().`
	});
}

// ─── 7. sanitizeClickPath has unit tests ────────────────────
{
	const testPath = resolve(root, 'src/lib/notifications/sanitizeClickPath.test.ts');
	const exists = existsSync(testPath);
	results.push({
		name: 'sanitizeClickPath has a co-located unit test',
		ok: exists,
		detail: exists
			? undefined
			: 'No sanitizeClickPath.test.ts — the validation logic must be vitest-unit-covered so static-grep neutralization (e.g. wrapping in `if (false)`) gets caught by tests, not just by the smoke.'
	});
}

// ─── 8. fetch handler rebuilds redirected responses on navigations ───
//
// A navigation request has redirect mode "manual"; returning a
// `redirected === true` response for it is a hard network error
// ("a redirected response was used for a request whose redirect mode is
// not 'follow'") and the page dies with ERR_FAILED.  This bit a real
// user whose SW had cached a prerendered route during a deploy window in
// which the server briefly 301'd it (e.g. a trailing-slash redirect).
// The fetch handler must rebuild any redirected response as a plain one
// before returning it for a navigation — on BOTH the precached and the
// fresh-network return paths.
{
	const path = resolve(root, 'src/service-worker.ts');
	const text = readFileSync(path, 'utf8');
	const definesCleaner = /function cleanRedirect\b/.test(text) && /\.redirected\b/.test(text);
	const wiredOnNavigation =
		(text.match(/return cleanRedirect\(/g) ?? []).length >= 2;
	const ok = definesCleaner && wiredOnNavigation;
	results.push({
		name: 'service-worker.ts rebuilds redirected responses on the navigation path (ERR_FAILED guard)',
		ok,
		detail: ok
			? undefined
			: `defines cleanRedirect + checks .redirected: ${definesCleaner}; wired on >=2 navigation returns: ${wiredOnNavigation}. Without this, a redirected response cached during a deploy-time 301 window fails every navigation with ERR_FAILED.`
	});
}

// ─── 9. SW update is CONSENT-GATED, not auto-applied (snackbar regression guard) ───
//
// A new worker must SIT IN "waiting" so the in-app UpdateBanner can offer
// "Load it now / Later" — the user upgrades on their own schedule, never an
// auto-reload mid-form or mid-read. skipWaiting() therefore must NOT live in
// the install handler (that auto-activates the new worker → clients.claim() →
// controllerchange → the banner force-reloads before the user ever sees it);
// it belongs ONLY in the APPLY_UPDATE message handler. This regressed once: a
// build added skipWaiting() to install to dodge a stale-shell black page — but
// that rescue actually comes from network-first navigation (the fetch path),
// not from auto-activation.
{
	const path = resolve(root, 'src/service-worker.ts');
	const text = readFileSync(path, 'utf8');

	// Strip JS comments so the explanatory "DO NOT skipWaiting() here" /
	// "skipWaiting() runs only from APPLY_UPDATE" notes aren't mistaken for code.
	const stripJs = (s: string): string =>
		s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

	// Slice out the install handler body: from the install listener to the
	// next top-level self.addEventListener(.
	const installStart = text.indexOf("addEventListener('install'");
	const afterInstall = text.indexOf('self.addEventListener(', installStart + 1);
	const installBody =
		installStart >= 0 && afterInstall > installStart
			? stripJs(text.slice(installStart, afterInstall))
			: '';
	const installHasSkipWaiting = /skipWaiting\s*\(/.test(installBody);

	// skipWaiting must exist in the message / APPLY_UPDATE handler.
	const msgStart = text.indexOf("addEventListener('message'");
	const msgBody = msgStart >= 0 ? stripJs(text.slice(msgStart)) : '';
	const applyUpdateSkips = /APPLY_UPDATE/.test(msgBody) && /skipWaiting\s*\(/.test(msgBody);

	const ok = installStart >= 0 && msgStart >= 0 && !installHasSkipWaiting && applyUpdateSkips;
	results.push({
		name: 'SW update is consent-gated: skipWaiting() only in APPLY_UPDATE handler, never in install',
		ok,
		detail: ok
			? undefined
			: `install handler found: ${installStart >= 0}; install calls skipWaiting (must be FALSE): ${installHasSkipWaiting}; APPLY_UPDATE handler calls skipWaiting (must be TRUE): ${applyUpdateSkips}. skipWaiting() in install auto-activates the new worker → clients.claim() → controllerchange → the UpdateBanner force-reloads the user mid-task, never showing "Load it now / Later".`
	});
}

// ─── 10. UpdateBanner wires the consent → apply → reload flow ───
{
	const path = resolve(root, 'src/lib/components/UpdateBanner.svelte');
	const exists = existsSync(path);
	const text = exists ? readFileSync(path, 'utf8') : '';
	const postsApply = /postMessage\(\s*\{\s*type:\s*['"]APPLY_UPDATE['"]/.test(text);
	const reloadsOnControllerChange =
		/controllerchange/.test(text) && /location\.reload\s*\(/.test(text);
	const offersChoice = /update\.apply/.test(text) && /update\.later/.test(text);
	const ok = exists && postsApply && reloadsOnControllerChange && offersChoice;
	results.push({
		name: 'UpdateBanner offers Load-it-now/Later, posts APPLY_UPDATE, reloads on controllerchange',
		ok,
		detail: ok
			? undefined
			: `exists: ${exists}; posts APPLY_UPDATE: ${postsApply}; reloads on controllerchange: ${reloadsOnControllerChange}; offers apply+later: ${offersChoice}. This is the user-consent surface for SW updates; without it the only upgrade paths are an auto-takeover (bad UX) or a cold restart.`
	});
}

// ─── 11. UpdateBanner clears a stale waiting worker (no phantom snackbar) ───
// Seen on the beta16 deploy: the banner only ever SET waitingWorker (from
// reg.waiting) and never cleared it, so once a worker had been waiting the
// "update available" snackbar could linger after that worker activated or
// was discarded — a "Load it now" button with nothing to act on. check()
// must clear waitingWorker when there is neither a waiting nor an installing
// worker.
{
	const path = resolve(root, 'src/lib/components/UpdateBanner.svelte');
	const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
	const clearsStale =
		/!reg\.installing/.test(text) && /waitingWorker\s*=\s*null/.test(text);
	results.push({
		name: 'UpdateBanner clears waitingWorker when nothing is waiting/installing (no phantom snackbar)',
		ok: clearsStale,
		detail: clearsStale
			? undefined
			: `clears waitingWorker on the no-waiting/no-installing branch: ${clearsStale}. Without this a stale waitingWorker leaves the snackbar offering an "update available" prompt whose "Load it now" can't do anything.`
	});
}

// ─── 12. "Load it now" always acts: fallback reload + double-reload guard ───
// controllerchange is not guaranteed to fire (an uncontrolled page after a
// hard refresh, or a wedged worker) — exactly the "Load it now does nothing"
// report. applyUpdate() must post APPLY_UPDATE AND fall back to a reload, and
// a `refreshing` flag must guard BOTH reload sites so the two paths can't
// double-reload.
{
	const path = resolve(root, 'src/lib/components/UpdateBanner.svelte');
	const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
	const hasGuard = /let\s+refreshing\s*=\s*false/.test(text);
	const hasFallbackReload =
		/setTimeout\(/.test(text) && /location\.reload\s*\(/.test(text);
	// The guard must appear at BOTH reload sites (controllerchange + fallback).
	const guardSites = (text.match(/if\s*\(refreshing\)\s*return/g) || []).length;
	const ok = hasGuard && hasFallbackReload && guardSites >= 2;
	results.push({
		name: 'UpdateBanner "Load it now" has a fallback reload guarded against a double reload',
		ok,
		detail: ok
			? undefined
			: `refreshing flag declared: ${hasGuard}; setTimeout fallback reload present: ${hasFallbackReload}; refreshing guard sites (need >=2): ${guardSites}. Without a fallback, "Load it now" silently does nothing whenever controllerchange never fires.`
	});
}

// ─── 13. "Load it now" hides the snackbar instantly and survives the reload ───
// PC bug (beta18): the click reloaded the page but the snackbar kept coming
// back across reloads, only clearing minutes later once the browser activated
// the worker on its own. The fix: (a) an `applying` flag gates the snackbar so
// it hides the instant you click; (b) APPLYING_KEY persists that across the
// reload so a reload that lands before the new worker takes over doesn't
// re-show it; (c) armActivation reloads the moment the worker reaches
// 'activated' (re-triggering skipWaiting), instead of waiting on the browser.
{
	const path = resolve(root, 'src/lib/components/UpdateBanner.svelte');
	const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
	// Snackbar template must be gated on !applying.
	const hidesOnApply = /\{#if[^}]*!applying[^}]*\}/.test(text);
	// applying is set on click...
	const setsApplyingOnClick = /applying\s*=\s*true/.test(text);
	// ...and persisted across the reload, restored on mount, and cleared.
	const persistsKey =
		/APPLYING_KEY/.test(text) &&
		/sessionStorage\.setItem\(APPLYING_KEY/.test(text) &&
		/getItem\(APPLYING_KEY\)\s*===\s*'1'/.test(text) &&
		/removeItem\(APPLYING_KEY\)/.test(text);
	// Reloads the moment the worker activates (not a blind wait).
	const reloadsOnActivated =
		/state\s*===\s*'activated'/.test(text) && /location\.reload\s*\(/.test(text);
	const ok = hidesOnApply && setsApplyingOnClick && persistsKey && reloadsOnActivated;
	results.push({
		name: 'UpdateBanner snackbar hides instantly on click and cannot reappear across the reload',
		ok,
		detail: ok
			? undefined
			: `template gated on !applying: ${hidesOnApply}; sets applying on click: ${setsApplyingOnClick}; persists/restores/clears APPLYING_KEY: ${persistsKey}; reloads on worker 'activated': ${reloadsOnActivated}. Without all four the "Load it now" snackbar reappears across reloads (the PC reappear-loop) and only clears minutes later.`
	});
}

// ─── Report ──────────────────────────────────────────────────
console.log('\n── service-worker-single-registration smoke (cp81 LL #81 / O-27) ──\n');
let passed = 0;
let failed = 0;
for (const r of results) {
	if (r.ok) {
		console.log(`  ✓ ${r.name}`);
		passed++;
	} else {
		console.log(`  ✗ ${r.name}`);
		if (r.detail) console.log(`    ${r.detail}`);
		failed++;
	}
}
console.log(`\n${passed} passed, ${failed} failed (${results.length} total)`);
if (failed > 0) {
	console.log(
		`✗ service-worker-single-registration: ${failed} scenarios failed`
	);
	process.exit(1);
}
console.log(`✓ all ${results.length} service-worker-single-registration scenarios passed`);
