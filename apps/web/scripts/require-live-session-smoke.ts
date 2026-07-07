/**
 * require-live-session-smoke — the locked → welcome-back-unlock redirect guard
 * (cp342; cp356 retargets it from the homepage to /login?next=).
 *
 * `<RequireLiveSession />` (lib/components/RequireLiveSession.svelte) is a
 * render-nothing guard for session-required pages. On a refresh / direct-nav
 * while FULLY locked (the in-memory session is wiped on every reload —
 * decrypted keys never persist; the security posture), the page's core action
 * is unusable, so it sends the user to the welcome-back UNLOCK screen (/login),
 * carrying the page they were trying to reach as `?next=…`; after they unlock
 * with their password the login page forwards them to that destination instead
 * of the homepage (cp356).
 *
 *   • Redirects ONLY when fully locked — `!isUnlocked && !isPairedReadOnly`.
 *     A paired-readonly session is a LIVE read-only session (keys on the phone)
 *     and KEEPS access; the page shows its own read-only / write-blocked
 *     affordance instead.
 *   • Runs ONCE on mount (not an `$effect`), so a later idle auto-lock while
 *     the user is actively on the page does NOT yank them away.
 *
 * cp340 introduced this redirect inline on /settings; cp342 generalized it into
 * this shared component and applied it to settings, 2FA, backup-keys, post, and
 * post/edit; cp343 extended coverage to /chat and /chat/[peer] (both require a
 * live chat identity), so the behaviour is uniform across every login-required
 * page regardless of which one you landed on.
 *
 * Pages with a genuine locked-but-useful READ-ONLY view (e.g. /my/orders, which
 * lists your on-chain order history from the cached account name) deliberately
 * do NOT use the guard — they're not stranded.
 *
 * Usage (from apps/web): tsx scripts/require-live-session-smoke.ts
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = (...p: string[]): string => readFileSync(join(root, ...p), 'utf-8');
const route = (...p: string[]): string => read('src', 'routes', '[lang]', ...p);

const componentPath = join(root, 'src', 'lib', 'components', 'RequireLiveSession.svelte');
const component = existsSync(componentPath) ? readFileSync(componentPath, 'utf-8') : '';

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

// ── 1. The guard component does the right thing ──────────────────────────────
check('RequireLiveSession.svelte exists', component.length > 0);
check(
	'redirects to the welcome-back unlock screen carrying ?next= (cp356)',
	/gotoLocale\(\s*['"]\/login\?next=/.test(component)
);
check(
	'redirects ONLY when fully locked: !isUnlocked && !isPairedReadOnly (paired keeps access)',
	/!get\(isUnlocked\)[\s\S]{0,40}!get\(isPairedReadOnly\)/.test(component)
);
check(
	'runs once in onMount (NOT an $effect that would re-fire on idle auto-lock)',
	/onMount\(/.test(component) && !/\$effect\(/.test(component)
);

// ── 2. Every session-required landing page USES the guard ────────────────────
const usingPages: ReadonlyArray<readonly [string, string]> = [
	['settings', route('settings', '+page.svelte')],
	['settings/security/2fa', route('settings', 'security', '2fa', '+page.svelte')],
	['backup-keys', route('backup-keys', '+page.svelte')],
	['post', route('post', '+page.svelte')],
	['post/edit', route('post', 'edit', '[permlink]', '+page.svelte')],
	['chat', route('chat', '+page.svelte')],
	['chat/[peer]', route('chat', '[peer=account]', '+page.svelte')]
];
for (const [name, src] of usingPages) {
	check(
		`${name} renders <RequireLiveSession /> and imports it`,
		/<RequireLiveSession\s*\/>/.test(src) && /RequireLiveSession\.svelte/.test(src)
	);
}

// ── 3. Intentional exclusions: read-only-useful / public pages must NOT use it─
const excludedPages: ReadonlyArray<readonly [string, string]> = [
	['my/orders (shows read-only order history when locked)', route('my', 'orders', '+page.svelte')],
	['orderbook (public)', route('orderbook', '+page.svelte')],
	['faq (public)', route('faq', '+page.svelte')]
];
for (const [name, src] of excludedPages) {
	check(`${name} does NOT use the guard`, !/RequireLiveSession/.test(src));
}

console.log('');
if (failures === 0) {
	console.log(`✓ all ${checks} require-live-session scenarios passed`);
	process.exit(0);
} else {
	console.log(`✗ ${failures} check(s) failed`);
	process.exit(1);
}
