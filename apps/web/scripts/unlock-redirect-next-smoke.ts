/**
 * unlock-redirect-next-smoke (cp356)
 *
 * Pins the "clicking Post now / Chat (or any session-required page) while
 * locked takes you to the welcome-back screen, and after you unlock with your
 * password you land on the page you actually wanted — not the homepage"
 * contract end to end:
 *
 *   1. RequireLiveSession, on a locked visit, captures the current path and
 *      redirects to /login?next=<that path> (NOT straight to '/').
 *   2. The login page reads `next` and forwards there after BOTH unlock paths
 *      (password + YubiKey) via postUnlockDestination().
 *   3. postUnlockDestination() is an OPEN-REDIRECT guard: it resolves `next`
 *      against our own origin and only honors a same-origin path, so a crafted
 *      /login?next=//evil.example can't bounce a freshly-unlocked user off-site.
 *
 * Static source scan (these files pull $-aliases the bare runner can't resolve).
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, '..');
const read = (rel: string) => readFileSync(join(webRoot, rel), 'utf8');

const guard = read('src/lib/components/RequireLiveSession.svelte');
const login = read('src/routes/[lang]/login/+page.svelte');

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

console.log('\nunlock-redirect-next smoke:\n');

// ─── 1. the guard carries the intended destination to the unlock screen ──────
check(
	'RequireLiveSession redirects to /login?next= (not straight to the homepage)',
	/gotoLocale\(\s*['"]\/login\?next=/.test(guard) && !/gotoLocale\(\s*['"]\/['"]\s*\)/.test(guard)
);
check(
	'RequireLiveSession captures the current path (pathname + search + hash) and encodes it',
	/window\.location\.pathname/.test(guard) &&
		/window\.location\.search/.test(guard) &&
		/window\.location\.hash/.test(guard) &&
		/encodeURIComponent\(/.test(guard)
);
check(
	'the redirect still fires ONLY when fully locked (paired-readonly keeps access)',
	/!get\(isUnlocked\)[\s\S]{0,40}!get\(isPairedReadOnly\)/.test(guard)
);

// ─── 2. the login page forwards to `next` after unlock ───────────────────────
check(
	'login defines postUnlockDestination() reading next from the URL',
	/function postUnlockDestination\(\)/.test(login) &&
		/searchParams\.get\(\s*['"]next['"]\s*\)/.test(login)
);
check(
	'the password unlock path forwards via postUnlockDestination() (not a hardcoded home)',
	/await gotoLocale\(postUnlockDestination\(\)\)/.test(login)
);
check(
	'BOTH unlock paths (password + YubiKey) use postUnlockDestination()',
	(login.match(/gotoLocale\(postUnlockDestination\(\)\)/g) || []).length >= 2
);

// ─── 3. open-redirect guard ──────────────────────────────────────────────────
check(
	'postUnlockDestination resolves next against our own origin (same-origin only)',
	/new URL\(\s*raw\s*,\s*\$page\.url\.origin\s*\)/.test(login) &&
		/\.origin === \$page\.url\.origin/.test(login)
);
check(
	'an off-origin or malformed next falls back to the homepage',
	/return '\/';/.test(login)
);

console.log('');
if (failed === 0) {
	console.log(`\u2713 all ${passed} unlock-redirect-next scenarios passed`);
} else {
	console.log(`\u2717 ${failed} failed, ${passed} passed`);
	process.exit(1);
}
