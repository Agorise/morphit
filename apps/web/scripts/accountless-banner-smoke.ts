/**
 * accountless-banner-smoke (cp355)
 *
 * Pins the "signed in but no Blurt account name yet" state so it can never
 * silently revert to feeling like a bug:
 *
 *  - a GLOBAL persistent banner (NeedsAccountNameBanner) shows on every page
 *    when the session is fully unlocked but no account name is set, and is
 *    wired into the root layout;
 *  - the banner is gated on $isUnlocked AND $blurtAccountName === null (NOT
 *    isUnlocked alone — that would show it to registered users too) and is
 *    suppressed on the setup routes themselves (onboarding/settings) so it's
 *    never circular;
 *  - the banner's CTA points at register-name (claim a name), and BOTH setup
 *    cards carry a reciprocal cross-link so neither population dead-ends:
 *    register-name → Settings (for import users who already have an account),
 *    Settings → register-name (for brand-new users who must claim one).
 *
 * Static source scan + en-locale key presence.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const read = (rel: string) => readFileSync(join(webRoot, rel), 'utf8');

const banner = read('src/lib/components/NeedsAccountNameBanner.svelte');
const layout = read('src/routes/[lang]/+layout.svelte');
const registerName = read('src/routes/[lang]/onboarding/register-name/+page.svelte');
const settings = read('src/routes/[lang]/settings/+page.svelte');
const en = JSON.parse(read('src/lib/i18n/locales/en.json'));

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${label}`);
	} else {
		failed++;
		console.log(`  \u2717 ${label}`);
	}
}

console.log('\naccountless-banner smoke:\n');

// ─── the banner's gating ─────────────────────────────────────────────────────
check(
	'banner is gated on $isUnlocked AND no account name (not isUnlocked alone)',
	/\$isUnlocked\b/.test(banner) && /\$blurtAccountName === null/.test(banner)
);
check(
	'banner suppresses itself on the setup routes (onboarding/settings)',
	/onboarding\//.test(banner) && /settings/.test(banner) && /onSetupRoute/.test(banner)
);
check(
	'banner CTA points at register-name (claim a name)',
	/\/onboarding\/register-name/.test(banner)
);

// ─── wired into the root layout ──────────────────────────────────────────────
check(
	'NeedsAccountNameBanner is imported AND rendered in the root layout',
	/import NeedsAccountNameBanner from/.test(layout) && /<NeedsAccountNameBanner\s*\/>/.test(layout)
);

// ─── reciprocal cross-links so neither population dead-ends ───────────────────
check(
	'register-name links existing-account users to the Settings verify card',
	/register_name\.have_account_link/.test(registerName) &&
		/\/settings#account-name-heading/.test(registerName)
);
check(
	'Settings account-name card links brand-new users to register-name',
	/account_name\.no_account_link/.test(settings) && /\/onboarding\/register-name/.test(settings)
);

// ─── i18n keys present ───────────────────────────────────────────────────────
check(
	'en carries needs_account_name.{heading,body,cta}',
	typeof en?.needs_account_name?.heading === 'string' &&
		typeof en?.needs_account_name?.body === 'string' &&
		typeof en?.needs_account_name?.cta === 'string'
);
check(
	'en carries the two cross-link strings',
	typeof en?.onboarding?.register_name?.have_account_link === 'string' &&
		typeof en?.settings?.account_name?.no_account_link === 'string'
);

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} accountless-banner scenarios passed`);
} else {
	console.log(`\u2717 ${failed} failed, ${passed} passed`);
	process.exit(1);
}
