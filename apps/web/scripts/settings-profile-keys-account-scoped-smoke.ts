/**
 * settings-profile-keys-account-scoped-smoke (cp346)
 *
 * Regression guard for the cross-account profile-draft leak: signing out of
 * one account and into another used to show the previous account's cached
 * display-name / short-bio / blurt.media / nostr values in the settings form,
 * because those localStorage keys were GLOBAL (`morphit.displayName` etc.).
 *
 * This smoke is a static source scan of the settings page. It asserts the four
 * profile-draft keys are scoped by the current account, that the pre-cp346
 * global keys are purged on mount, and that the form hydrates empty fields from
 * the on-chain profile (so a fresh device shows real values, not blanks) — and,
 * critically, that none of the four keys is ever written under its bare global
 * name (which is what caused the leak).
 *
 * Static-only (no runtime); runs under the smoke tsconfig like the other
 * source-scan sentinels.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');

function read(p: string): string {
	return readFileSync(p, 'utf8');
}

let passed = 0;
let failed = 0;
function check(label: string, cond: boolean, detail = ''): void {
	if (cond) {
		passed++;
		console.log(`  \u2713 ${label}`);
	} else {
		failed++;
		console.log(`  \u2717 ${label}${detail ? `: ${detail}` : ''}`);
	}
}

console.log('\nsettings-profile-keys-account-scoped smoke:\n');

const settings = read(join(webRoot, 'src/routes/[lang]/settings/+page.svelte'));

const bases = ['morphit.displayName', 'morphit.nostrUrl', 'morphit.streamingUrl', 'morphit.websiteUrl', 'morphit.shortBio'];

// 1. The per-account suffix is derived from the logged-in account.
// v1.8.11 — this used to require the scope be a plain `const … = browser ?
// (getUserBlurtAccount() …`, i.e. resolved ONCE at component init. That is
// precisely the bug Ken hit: sign out and back in as someone else without a
// page reload and the component never remounts, so the suffix stays pinned to
// the PREVIOUS account and the new person reads their drafts. The requirement
// is now the STRONGER one — the scope must be REACTIVE — so the assertion
// pins $derived rather than the const form it replaced.
check(
	'profile-key scope is REACTIVE (re-resolves on sign-out/sign-in), not resolved once',
	/PROFILE_KEY_SCOPE\s*=\s*\$derived/.test(settings),
	'a const captured at init keeps the previous account\'s suffix across an in-SPA account switch'
);
check(
	'profile-key scope still derives from getUserBlurtAccount()',
	/PROFILE_KEY_SCOPE\s*=\s*\$derived[\s\S]{0,400}?getUserBlurtAccount\(\)/.test(settings)
);
check(
	'the suffix, and every key built from it, are reactive too',
	/PROFILE_KEY_SUFFIX\s*=\s*\$derived\(PROFILE_KEY_SCOPE\s*\?\s*`\.\$\{PROFILE_KEY_SCOPE\}`/.test(
		settings
	),
	'a const suffix would freeze at the first account, reintroducing the bug one layer down'
);

// 2. Each of the four keys is defined WITH the scope suffix.
for (const base of bases) {
	const scoped = new RegExp('`' + base.replace('.', '\\.') + '\\$\\{PROFILE_KEY_SUFFIX\\}`');
	check(`${base} key is account-scoped`, scoped.test(settings));
}

// 3. No key is ever WRITTEN under its bare global name (the leak vector).
//    setItem/getItem/removeItem must use the scoped constant, never a string
//    literal equal to one of the bare base names.
for (const base of bases) {
	const literalWrite = new RegExp(
		'(setItem|getItem|removeItem)\\(\\s*[\'"]' + base.replace('.', '\\.') + '[\'"]'
	);
	// Exception: the LEGACY_GLOBAL_PROFILE_KEYS purge list intentionally names
	// the bare keys, but it removes them via the array (removeItem(legacy)),
	// not via a string-literal removeItem — so a literal call here is a leak.
	check(`${base} is never read/written under its bare global name`, !literalWrite.test(settings));
}

// 4. The legacy global keys are declared and purged on mount.
check(
	'legacy global keys are declared for purge',
	/LEGACY_GLOBAL_PROFILE_KEYS\s*=\s*\[/.test(settings) &&
		bases.every((b) => settings.includes(`'${b}'`))
);
check(
	'legacy global keys are removed on mount',
	/for \(const legacy of LEGACY_GLOBAL_PROFILE_KEYS\)/.test(settings) &&
		/removeItem\(legacy\)/.test(settings)
);

// 5. Empty fields hydrate from the on-chain profile (Bug B), gated on "no local
//    draft for this account".
check(
	'tracks which fields have no local draft for this account',
	/const noLocalName = !s;/.test(settings) &&
		/const noLocalStreaming = !bm;/.test(settings) &&
		/const noLocalWebsite = !ws;/.test(settings) &&
		/const noLocalBio = !bio;/.test(settings) &&
		/const noLocalNostr = !n;/.test(settings)
);
check(
	'hydrates empty fields from extractLabelPropsFromProfile',
	/if \(noLocalName && props\.displayName\)/.test(settings) &&
		/if \(noLocalBio && props\.shortBio\)/.test(settings) &&
		/if \(noLocalStreaming && props\.streamingUrl\)/.test(settings) &&
		/if \(noLocalWebsite && props\.websiteUrl\)/.test(settings) &&
		/if \(noLocalNostr && props\.nostrUrl\)/.test(settings)
);

// 6. The extractor actually exposes shortBio (so the bio hydration is real).
const profileProps = read(join(webRoot, 'src/lib/indexer/profileProps.ts'));
check(
	"profileProps exposes shortBio from json_metadata.short_bio",
	/readonly shortBio: string \| null;/.test(profileProps) &&
		/shortBio: str\('short_bio'\)/.test(profileProps)
);

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} settings-profile-keys-account-scoped scenarios passed`);
} else {
	console.log(`\u2717 ${failed} failed, ${passed} passed`);
	process.exit(1);
}
