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
// The page must refresh ONLY when the user clicks "Load it now" — never on its
// own. So: posts APPLY_UPDATE (asks the SW to skipWaiting), offers Later/apply,
// and the single location.reload() lives inside applyUpdate(). cp368: applyUpdate
// now also waits for controllerchange before reloading (one tap lands the new
// bundle on mobile) — that listener is allowed, but ONLY inside applyUpdate,
// never at module/effect scope where it would auto-reload behind the user's back.
{
	const path = resolve(root, 'src/lib/components/UpdateBanner.svelte');
	const exists = existsSync(path);
	const text = exists ? readFileSync(path, 'utf8') : '';
	const postsApply = /postMessage\(\s*\{\s*type:\s*['"]APPLY_UPDATE['"]/.test(text);
	const applyIdx = text.indexOf('function applyUpdate');
	const dismissIdx = text.indexOf('function dismiss');
	const reloadIdx = text.indexOf('location.reload()');
	// applyUpdate body bound: from its start to the next top-level fn / $effect.
	const applyStop = (() => {
		if (applyIdx < 0) return -1;
		const nextFn = text.indexOf('\n\tfunction ', applyIdx + 1);
		const nextEffect = text.indexOf('\n\t$effect', applyIdx + 1);
		const ends = [nextFn, nextEffect].filter((i) => i !== -1);
		return ends.length ? Math.min(...ends) : text.length;
	})();
	const applyBody = applyIdx >= 0 ? text.slice(applyIdx, applyStop) : '';
	const ccRe = /addEventListener\(\s*['"]controllerchange['"]/g;
	const ccTotal = [...text.matchAll(ccRe)].length;
	const ccInApply = [...applyBody.matchAll(ccRe)].length;
	// A controllerchange listener may exist now, but only inside applyUpdate.
	const controllerChangeConsentGated = ccTotal === ccInApply;
	const reloadIsUserConsentOnly =
		applyIdx >= 0 && reloadIdx > applyIdx && (dismissIdx === -1 || reloadIdx < dismissIdx);
	const offersChoice = /update\.apply/.test(text) && /update\.later/.test(text);
	const ok =
		exists && postsApply && controllerChangeConsentGated && reloadIsUserConsentOnly && offersChoice;
	results.push({
		name: 'UpdateBanner offers Load-it-now/Later, posts APPLY_UPDATE, reloads only on user consent (controllerchange only inside applyUpdate)',
		ok,
		detail: ok
			? undefined
			: `exists: ${exists}; posts APPLY_UPDATE: ${postsApply}; controllerchange only inside applyUpdate (${ccInApply}/${ccTotal}): ${controllerChangeConsentGated}; reload lives inside applyUpdate only: ${reloadIsUserConsentOnly}; offers apply+later: ${offersChoice}. The page must refresh ONLY when the user clicks "Load it now"; a controllerchange listener outside applyUpdate auto-reloads behind the user's back.`
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

// ─── 12. "Load it now" reliably reloads — exactly one reload site ───
// applyUpdate() posts APPLY_UPDATE (skipWaiting), waits for controllerchange,
// then reloads (with a setTimeout fallback if the handoff stalls). Navigations
// are network-first, so the reload pulls the fresh shell regardless of SW state.
// There is exactly ONE reload site (a single reloadOnce guard), so there is no
// double-reload to guard against even with the controllerchange + fallback paths.
{
	const path = resolve(root, 'src/lib/components/UpdateBanner.svelte');
	const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
	const postsApply = /postMessage\(\s*\{\s*type:\s*['"]APPLY_UPDATE['"]/.test(text);
	const reloadViaTimeout = /setTimeout\(/.test(text) && /location\.reload\s*\(/.test(text);
	const reloadSites = (text.match(/location\.reload\s*\(\s*\)/g) || []).length;
	const ok = postsApply && reloadViaTimeout && reloadSites === 1;
	results.push({
		name: 'UpdateBanner "Load it now" posts APPLY_UPDATE and reloads exactly once (single reload site)',
		ok,
		detail: ok
			? undefined
			: `posts APPLY_UPDATE: ${postsApply}; reloads via setTimeout: ${reloadViaTimeout}; location.reload() sites (want exactly 1): ${reloadSites}. The reload must be the single user-consent path — extra reload sites reintroduce the auto-reload / double-reload bugs.`
	});
}

// ─── 13. "Load it now" hides the snackbar instantly; applying is in-memory ───
// PC bug (beta18): the click reloaded but the snackbar kept reappearing,
// clearing only minutes later. The earlier fix PERSISTED an `applying` flag
// across the reload — which then got STUCK true and suppressed the snackbar
// for minutes (cp339). The correct fix: `applying` gates the snackbar so it
// hides instantly on click, but is IN-MEMORY ONLY — a reload resets it, so it
// can never wedge. If the update didn't actually land, the snackbar correctly
// reappears so the user can retry.
{
	const path = resolve(root, 'src/lib/components/UpdateBanner.svelte');
	const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
	// Snackbar template must be gated on !applying so it hides the instant you click.
	const hidesOnApply = /\{#if[^}]*!applying[^}]*\}/.test(text);
	const setsApplyingOnClick = /applying\s*=\s*true/.test(text);
	// applying must NOT be persisted to web storage (the stuck-suppression bug).
	const notPersisted = !/APPLYING_KEY/.test(text) && !/setItem\([^)]*[Aa]pplying/.test(text);
	const ok = hidesOnApply && setsApplyingOnClick && notPersisted;
	results.push({
		name: 'UpdateBanner snackbar hides instantly on click; applying is in-memory only (no stuck-suppression)',
		ok,
		detail: ok
			? undefined
			: `template gated on !applying: ${hidesOnApply}; sets applying on click: ${setsApplyingOnClick}; applying NOT persisted to storage: ${notPersisted}. Persisting "applying" caused the PC bug where the snackbar stayed hidden for minutes after a reload that didn't fully apply.`
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
