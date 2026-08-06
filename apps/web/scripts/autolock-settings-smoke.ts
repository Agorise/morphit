/**
 * autolock-settings-smoke — the Settings auto-lock timeout selector (cp343).
 *
 * The settings page (`settings/+page.svelte`) renders a `<select>` letting a
 * password-mode user choose how long their unlocked session survives before
 * auto-locking (15 min … 24 h, or Never). It AUTO-SAVES the instant the choice
 * changes — there is no submit button: `onchange={setAutoLock}` persists the
 * new value immediately via `writeTimeoutMinutes` and shows a transient
 * "Changed to …" confirmation. This smoke locks that wiring so the selector
 * and its save-on-change behaviour can't silently regress (it had no coverage
 * before, and a settings refactor could quietly drop it).
 *
 * The widget is gated on `hasPersistedKeystore()` — only users who chose a
 * password at onboarding have a persisted envelope, so seed-only logins (where
 * Lock and Sign Out collapse to the same thing) don't see it. That's expected,
 * NOT a bug.
 *
 * Usage (from apps/web): tsx scripts/autolock-settings-smoke.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const settings = readFileSync(
	join(root, 'src', 'routes', '[lang]', 'settings', '+page.svelte'),
	'utf-8'
);
const en = JSON.parse(readFileSync(join(root, 'src', 'lib', 'i18n', 'locales', 'en.json'), 'utf-8'));

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean): void {
	checks++;
	console.log(cond ? `  ✓ ${name}` : `  ✗ ${name}`);
	if (!cond) failures++;
}

// ── 1. The store wiring is imported ──────────────────────────────────────────
check(
	'settings imports autoLockTimeoutMinutes + writeTimeoutMinutes + NEVER_LOCK from $stores/autoLock',
	/import\s*\{[^}]*\bautoLockTimeoutMinutes\b[^}]*\bwriteTimeoutMinutes\b[^}]*\bNEVER_LOCK\b[^}]*\}\s*from\s*['"]\$stores\/autoLock['"]/.test(
		settings
	)
);

// ── 2. The selector exists and AUTO-SAVES on change (no submit button) ───────
check(
	'a <select id="autolock-select"> exists',
	/<select\b[\s\S]*?id="autolock-select"/.test(settings)
);
check(
	'the selector auto-saves on change: onchange={setAutoLock}',
	/id="autolock-select"[\s\S]*?onchange=\{setAutoLock\}/.test(settings)
);
check(
	'setAutoLock persists immediately via writeTimeoutMinutes (numeric) + NEVER_LOCK ("never")',
	/function setAutoLock\(/.test(settings) &&
		/writeTimeoutMinutes\(NEVER_LOCK\)/.test(settings) &&
		/writeTimeoutMinutes\(n\)/.test(settings)
);

// ── 3. Visibility gate: password-mode (persisted keystore) only ──────────────
check(
	'shown only to password-mode users: canConfigureAutoLock = hasPersistedKeystore()',
	/canConfigureAutoLock\s*=\s*\$derived\(\s*hasPersistedKeystore\(\)\s*\)/.test(settings) &&
		/\{#if canConfigureAutoLock\}/.test(settings)
);

// ── 4. The "Changed to …" confirmation is wired + rendered ───────────────────
check(
	'a transient "Changed to …" confirmation is set (autolock_changed) and rendered',
	/autoLockChanged\s*=\s*\$_\(\s*['"]settings\.session\.autolock_changed['"]/.test(settings) &&
		/\{#if autoLockChanged\}/.test(settings)
);

// ── 5. All timeout options are present ───────────────────────────────────────
const expectedOptions = ['15', '30', '60', '240', '540', '1440', 'never'];
check(
	`the selector offers all ${expectedOptions.length} options (${expectedOptions.join('/')})`,
	expectedOptions.every((v) => new RegExp(`<option value="${v}">`).test(settings))
);

// ── 6. The locale keys exist (en) ────────────────────────────────────────────
const session = (en.settings as { session?: Record<string, unknown> })?.session ?? {};
const requiredKeys = [
	'autolock_label',
	'autolock_help',
	'autolock_changed',
	'autolock_15min',
	'autolock_30min',
	'autolock_1h',
	'autolock_4h',
	'autolock_9h',
	'autolock_24h',
	'autolock_never'
];
check(
	`en has all ${requiredKeys.length} autolock_* locale keys`,
	requiredKeys.every((k) => typeof session[k] === 'string' && (session[k] as string).length > 0)
);

console.log('');
if (failures === 0) {
	console.log(`✓ all ${checks} autolock-settings scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} check(s) failed`);
	process.exit(1);
}
