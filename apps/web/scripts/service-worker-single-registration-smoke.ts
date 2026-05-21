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
