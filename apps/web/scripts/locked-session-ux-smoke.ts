/**
 * locked-session-ux-smoke — the locked-but-remembered UX (cp340, cp341 icons).
 *
 * WHY: a keyfile + password + "Remember me" user who refreshes is correctly
 * locked (decrypted keys never persist across a reload — the security
 * posture), and their encrypted keystore SURVIVES (cp334). The envelope is
 * intact; they only need to re-enter their password. cp340 makes that obvious
 * instead of looking like a full logout:
 *
 *   1. The header CTA reads "Unlock" (nav.unlock), not "Start", when this
 *      device has a remembered keystore — a click lands on the welcome-back
 *      unlock screen, not a fresh import.
 *   2. Refreshing while locked on a protected page (Settings) routes to the
 *      homepage (the user can't use Settings without a live session); the
 *      "Unlock" CTA then takes them to welcome-back. Runs ONCE on mount (not
 *      an $effect — a later idle auto-lock must not yank an active user away).
 *   3. The "sign in with your keys" buttons (welcome-back use_seed_instead AND
 *      the import-needed login.import_existing) carry the yellow 🔐 lock
 *      emoji, while the "use phone instead" buttons use the monochrome QR
 *      svg glyph. cp35x reverted cp341's monochrome lock svg back to the
 *      🔐 emoji: the colourful padlock is the more recognizable "this
 *      unlocks your account" affordance, which the operator prefers over a
 *      strictly-monochrome icon set.
 *
 * Usage (from apps/web): tsx scripts/locked-session-ux-smoke.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (...p: string[]): string =>
	readFileSync(join(import.meta.dirname, '..', ...p), 'utf-8');

const avatar = read('src', 'lib', 'components', 'AvatarMenu.svelte');
const settings = read('src', 'routes', '[lang]', 'settings', '+page.svelte');
const requireLiveSession = read('src', 'lib', 'components', 'RequireLiveSession.svelte');
const login = read('src', 'routes', '[lang]', 'login', '+page.svelte');
const en = JSON.parse(read('src', 'lib', 'i18n', 'locales', 'en.json')) as Record<
	string,
	unknown
>;

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean): void {
	checks++;
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		failures++;
		console.log(`  ✗ ${name}`);
	}
}

// ── 1. Header CTA: conditional Unlock vs Start ───────────────────────────────
check(
	'AvatarMenu derives a signed-out CTA label gated on hasPersistedKeystore()',
	/signedOutCtaLabel\s*=\s*\$derived\([\s\S]*?hasPersistedKeystore\(\)/.test(avatar)
);
check(
	'signed-out CTA chooses nav.unlock (remembered) vs nav.start (fresh)',
	/signedOutCtaLabel\s*=\s*\$derived\([\s\S]*?nav\.unlock[\s\S]*?nav\.start/.test(avatar)
);
check(
	'the header sign-in button renders {signedOutCtaLabel}, not a hardcoded nav.start',
	/\{signedOutCtaLabel\}/.test(avatar) &&
		// the only remaining nav.start reference is inside the derived
		(avatar.match(/nav\.start/g) || []).length === 1
);

// ── 2. Locked visitors on session-required pages go to the welcome-back ──────
//      unlock screen, carrying the page they wanted as ?next= so they land
//      there after unlocking (cp356) instead of on the homepage.
check(
	'Settings delegates the locked-redirect to <RequireLiveSession />',
	/<RequireLiveSession\s*\/>/.test(settings)
);
check(
	'RequireLiveSession redirects to the welcome-back unlock screen carrying ?next=',
	/gotoLocale\(\s*['"]\/login\?next=/.test(requireLiveSession)
);
check(
	'the redirect is guarded by !isUnlocked && !isPairedReadOnly (paired keeps access) and runs in onMount (once), routing to /login?next=',
	/!get\(isUnlocked\)[\s\S]{0,40}!get\(isPairedReadOnly\)/.test(requireLiveSession) &&
		/onMount\(\(\)\s*=>\s*\{[\s\S]*?gotoLocale\(\s*['"]\/login\?next=[\s\S]*?\}\)/.test(
			requireLiveSession
		)
);

// ── 3. Key buttons show the yellow 🔐 lock emoji; phone buttons the QR svg ───
//      (cp35x: reverted the monochrome-svg lock back to the 🔐 emoji per
//      operator preference — the colourful padlock is the recognizable
//      "this unlocks your account" affordance.)
check(
	'welcome-back seed button uses the use_seed_instead label',
	/use_seed_instead/.test(login)
);
check(
	'en use_seed_instead label has no inline emoji (the 🔐 lives in the markup span)',
	typeof (en.login as { welcome_back?: { use_seed_instead?: string } })?.welcome_back
		?.use_seed_instead === 'string' &&
		!(
			en.login as { welcome_back: { use_seed_instead: string } }
		).welcome_back.use_seed_instead.includes('\u{1F510}')
);
check(
	'en login.import_existing label has no inline emoji (the 🔐 lives in the markup span)',
	typeof (en.login as { import_existing?: string }).import_existing === 'string' &&
		!(en.login as { import_existing: string }).import_existing.includes('\u{1F510}')
);
check(
	'the 🔐 lock emoji renders on BOTH the welcome-back seed and import-needed import buttons',
	(login.match(/\u{1F510}/gu) || []).length >= 2
);
check(
	'the QR icon svg renders on BOTH the welcome-back and import-needed phone buttons',
	(login.match(/viewBox="-1 -1 2002 2002"/g) || []).length >= 2
);

// ── 4. nav.unlock locale key exists ──────────────────────────────────────────
check(
	'nav.unlock exists in en',
	typeof (en.nav as { unlock?: string })?.unlock === 'string' &&
		(en.nav as { unlock: string }).unlock.length > 0
);

// ── 5. Welcome-back autofocuses the password field (cp343) ───────────────────
check(
	'the welcome-back password field autofocuses on mount (use:focusOnMount)',
	/id="unlock-password"[\s\S]*?use:focusOnMount/.test(login) && /function focusOnMount\(/.test(login)
);

console.log('');
if (failures === 0) {
	console.log(`✓ all ${checks} locked-session-ux scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} check(s) failed`);
	process.exit(1);
}
