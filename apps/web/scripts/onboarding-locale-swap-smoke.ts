/**
 * Onboarding in-place locale-swap wiring smoke.
 *
 * Changing the language mid-onboarding must NOT wipe the form — the user
 * may be mid-backup on a freshly generated, in-memory-only keypair. The
 * LanguageSwitcher therefore swaps the locale IN PLACE on /onboarding*
 * routes (replaceState — no navigation → no remount → keys survive)
 * instead of navigating to /<newlang>/onboarding (which remounts the page
 * and resets all component state). For the on-page links to stay correct
 * during that shallow swap, the onboarding routes AND the shared layout
 * header must derive their locale prefix from the active-locale STORE
 * ($currentLocale), not $page.data.lang — the latter only updates on a
 * real navigation, so a shallow URL change would leave it stale.
 *
 * This smoke pins both halves so a later "tidy-up" can't silently
 * reintroduce the form-wipe regression. Pure source-grep — no DOM.
 *
 * Usage (from apps/web):
 *   tsx scripts/onboarding-locale-swap-smoke.ts
 */
import fs from 'node:fs';

let failures = 0;
let scenarios = 0;

function scenario(name: string, fn: () => void): void {
	scenarios++;
	try {
		fn();
		console.log(`  ✓ ${name}`);
	} catch (err) {
		failures++;
		console.log(`  ✗ ${name}`);
		console.log(`      ${err instanceof Error ? err.message : String(err)}`);
	}
}

function read(path: string): string {
	return fs.readFileSync(path, 'utf-8');
}

console.log('\n── Onboarding in-place locale-swap wiring ──────────');

// 1. The switcher swaps in place on /onboarding* (replaceState), not goto.
scenario('LanguageSwitcher imports replaceState and gates an in-place swap on /onboarding', () => {
	const src = read('src/lib/components/LanguageSwitcher.svelte');
	if (!/import \{[^}]*\breplaceState\b[^}]*\} from '\$app\/navigation'/.test(src)) {
		throw new Error('replaceState is not imported from $app/navigation');
	}
	if (!/startsWith\('\/onboarding'\)[\s\S]{0,240}replaceState\(/.test(src)) {
		throw new Error(
			'expected an /onboarding-gated replaceState() in choose() — the in-place swap that avoids a remount'
		);
	}
});

// 2. Onboarding routes + the shared layout derive currentLang from the
//    active-locale STORE so the shallow swap re-prefixes every link.
const STORE_ROUTES = [
	'src/routes/[lang]/+layout.svelte',
	'src/routes/[lang]/onboarding/+page.svelte',
	'src/routes/[lang]/onboarding/register-name/+page.svelte'
];
for (const rel of STORE_ROUTES) {
	scenario(`${rel}: currentLang reads $currentLocale (the store), not $page.data.lang`, () => {
		const src = read(rel);
		if (!/const currentLang = \$derived\(\$currentLocale\)/.test(src)) {
			throw new Error('currentLang must derive from $currentLocale (the active-locale store)');
		}
		if (/currentLang = \$derived\(\(\$page\.data\?\.lang/.test(src)) {
			throw new Error(
				'currentLang still derives from $page.data.lang — a shallow locale swap will not update its links'
			);
		}
	});
}

console.log('');
if (failures === 0) {
	console.log('────────────────────────────────────────────────────');
	console.log(`✓ all ${scenarios} onboarding-locale-swap scenarios passed`);
	process.exit(0);
} else {
	console.log('────────────────────────────────────────────────────');
	console.log(`✗ ${failures} of ${scenarios} scenarios failed`);
	process.exit(1);
}
