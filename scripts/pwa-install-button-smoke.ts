#!/usr/bin/env tsx
/**
 * pwa-install-button — cp701.
 *
 * The PWA install affordance was ~built but never appeared: installPrompt.ts
 * captures `beforeinstallprompt`, but it was imported only by the settings page,
 * so the (single, early) event was missed and the deferred prompt store stayed
 * null. cp701 registers the capture at boot and adds a prominent, dismissible
 * InstallBanner that covers Chromium (native prompt) AND iOS Safari (manual
 * Add-to-Home-Screen guidance). Guards all of that + 10-locale string parity.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (r: string): string => readFileSync(join(REPO, r), 'utf8');
let pass = 0, fail = 0;
const check = (n: string, c: boolean): void => {
	if (c) { console.log(`  ✓ ${n}`); pass++; } else { console.log(`  ✗ ${n}`); fail++; }
};

console.log('\n── pwa-install-button (cp701) ─────────────────────────\n');

// 1. the capture is registered at BOOT (not just when settings loads)
const hooks = read('apps/web/src/hooks.client.ts');
check('beforeinstallprompt capture is imported at client boot (hooks.client.ts)',
	/import '\$lib\/pwa\/installPrompt'/.test(hooks));

// 2. the banner exists + covers both the native prompt and the iOS path
const banner = read('apps/web/src/lib/components/InstallBanner.svelte');
check('InstallBanner triggers the native prompt (Chromium) via promptInstall()', /promptInstall\(\)/.test(banner));
check('InstallBanner has an iOS-Safari manual path (no beforeinstallprompt there)', /isIOS/.test(banner) && /ios_help/.test(banner));
check('InstallBanner hides when already installed', /isInstalled/.test(banner));
check('InstallBanner is dismissible + remembers dismissal', /DISMISS_KEY/.test(banner) && /localStorage/.test(banner));

// 3. it's actually rendered app-wide in the layout
const layout = read('apps/web/src/routes/[lang]/+layout.svelte');
check('InstallBanner is imported AND rendered in the [lang] layout',
	/import InstallBanner /.test(layout) && /<InstallBanner \/>/.test(layout));

// 4. all 10 locales carry the install.banner strings (parity)
const locDir = join(REPO, 'apps/web/src/lib/i18n/locales');
const locs = readdirSync(locDir).filter((f) => f.endsWith('.json'));
const need = ['heading', 'blurb', 'cta', 'ios_cta', 'ios_help', 'dismiss'];
let parity = locs.length === 10;
for (const f of locs) {
	const b = (JSON.parse(read(`apps/web/src/lib/i18n/locales/${f}`)).install || {}).banner || {};
	if (!need.every((k) => typeof b[k] === 'string' && b[k].length > 0)) parity = false;
}
check(`all 10 locales carry install.banner.{${need.join(',')}}`, parity);

console.log(`\n${pass} passed, ${fail} failed\n${fail === 0 ? `✓ all ${pass} pwa-install-button checks passed` : '✗ FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
