/**
 * update-banner-user-consent-smoke — the update snackbar reloads ONLY on an
 * explicit "Load it now" click, never on its own, and can't get stuck hidden.
 *
 * WHY (cp339): the banner broke on PC because (a) a 'controllerchange' listener
 * auto-reloaded the page whenever the service worker activated — refreshing
 * behind the user's back — and (b) an "applying" flag persisted in
 * sessionStorage could get stuck `true` after a reload that didn't fully land
 * the update, suppressing the snackbar for minutes. The fix: NO controllerchange
 * auto-reload (the page reloads only inside applyUpdate, the "Load it now"
 * click), and "applying" is in-memory only (a reload resets it, so it can't
 * wedge). "Later" only closes the snackbar — it never reloads.
 *
 * Usage (from apps/web): tsx scripts/update-banner-user-consent-smoke.ts
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const src = readFileSync(
	join(import.meta.dirname, '..', 'src', 'lib', 'components', 'UpdateBanner.svelte'),
	'utf-8'
);

let failures = 0;
let checks = 0;
function check(name: string, cond: boolean, detail = ''): void {
	checks++;
	if (cond) {
		console.log(`  ✓ ${name}`);
	} else {
		failures++;
		console.log(`  ✗ ${name}${detail ? ' — ' + detail : ''}`);
	}
}

console.log('\n── update banner: user-consent only, never stuck ──────');

// No controllerchange auto-reload WIRING (a comment may mention the absence).
check(
	"no addEventListener('controllerchange') auto-reload",
	!/addEventListener\(\s*['"]controllerchange['"]/.test(src)
);

// location.reload() appears exactly once, and inside applyUpdate().
const reloads = [...src.matchAll(/location\.reload\(\)/g)];
check('exactly one location.reload() call', reloads.length === 1, `found ${reloads.length}`);
const applyIdx = src.indexOf('function applyUpdate');
const dismissIdx = src.indexOf('function dismiss');
const reloadIdx = src.indexOf('location.reload()');
check(
	'the reload lives inside applyUpdate() (the "Load it now" handler)',
	applyIdx !== -1 && reloadIdx > applyIdx && (dismissIdx === -1 || reloadIdx < dismissIdx)
);

// "applying" is in-memory only — never persisted to web storage.
check('no persisted APPLYING_KEY', !/APPLYING_KEY/.test(src));
check('no sessionStorage write of an applying flag', !/setItem\([^)]*[Aa]pplying/.test(src));

// dismiss() (the "Later" handler) does NOT reload.
const dismissBody = dismissIdx !== -1 ? src.slice(dismissIdx) : '';
check('dismiss() does not call location.reload()', !/location\.reload\(\)/.test(dismissBody));

// The snackbar visibility still gates on not-applying + version-aware dismiss.
check('snackbar condition includes !applying', /&&\s*!applying/.test(src));
check('snackbar dismiss is version-aware (dismissedForCurrent)', /!dismissedForCurrent/.test(src));

console.log('');
if (failures === 0) {
	console.log(`✓ all ${checks} update-banner-user-consent scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} check(s) failed`);
	process.exit(1);
}
