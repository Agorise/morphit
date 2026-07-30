/**
 * upgrade-banner-behavior-smoke.
 *
 * Guards the post-upgrade UX (Ken t.txt #9): after a server upgrade a user
 * should see ONLY the translucent "Load it now" snackbar (UpdateBanner, which
 * carries a "Later"/cancel), never the redundant reload-bar nor a red
 * "tampered" scare that a routine version bump would otherwise trip.
 *
 *   - StaleBuildBanner (the emerald reload-bar) is GONE — not imported, not
 *     rendered, and the component file is deleted; UpdateBanner covers the
 *     reload prompt,
 *   - TamperAlertBanner suppresses its ASSET-mismatch alert during a stale
 *     build (the running bundle is simply older than a chain-signed release —
 *     an expected mismatch, since the tamper check hashes the running bundle
 *     against the NEW manifest — not tampering), while the pubkey-mismatch and
 *     invalid-payload alerts stay UNCONDITIONAL,
 *   - UpdateBanner still offers both "Load it now" and "Later".
 */

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const web = join(here, '..');
const layoutSrc = readFileSync(join(web, 'src/routes/[lang]/+layout.svelte'), 'utf8');
const tamperSrc = readFileSync(join(web, 'src/lib/components/TamperAlertBanner.svelte'), 'utf8');
const updateSrc = readFileSync(join(web, 'src/lib/components/UpdateBanner.svelte'), 'utf8');

let pass = 0;
let fail = 0;
function expect(name: string, cond: boolean): void {
	if (cond) {
		pass++;
		console.log(`  \u2713 ${name}`);
	} else {
		fail++;
		console.log(`  \u2717 ${name}`);
	}
}

// ─── StaleBuildBanner fully removed ──────────────────────────────────
expect(
	'StaleBuildBanner.svelte is deleted',
	!existsSync(join(web, 'src/lib/components/StaleBuildBanner.svelte'))
);
expect('layout no longer references StaleBuildBanner', !/StaleBuildBanner/.test(layoutSrc));
expect('layout still renders the UpdateBanner snackbar', /<UpdateBanner\s*\/>/.test(layoutSrc));
expect('layout still renders TamperAlertBanner', /<TamperAlertBanner\s*\/>/.test(layoutSrc));

// ─── TamperAlertBanner: gate asset-mismatch on !staleBuild ───────────
expect(
	'TamperAlertBanner imports staleBuild',
	/import \{[^}]*staleBuild[^}]*\} from '\$stores\/release'/.test(tamperSrc)
);
expect(
	'asset-mismatch alert is gated on a non-stale build',
	/tamperedPaths\.length > 0 &&\s*\$staleBuild !== true/.test(tamperSrc)
);
// cp514 (t.txt A) — the scary red "Build integrity check failed" banner still
// flashed during a routine upgrade, before the friendly "Load it now" snackbar.
// The asset-hash case is now ALSO suppressed while a service-worker update is
// pending and for a short post-boot grace window, so the update path leads. A
// genuine same-version tamper on a settled bundle still fires once these clear.
expect(
	'cp514 — TamperAlertBanner imports the SW-update + grace gates',
	/import \{[^}]*swUpdatePending[^}]*tamperGraceElapsed[^}]*\} from '\$lib\/updates\/tamperBannerGate'/.test(
		tamperSrc
	)
);
expect(
	'cp514 — asset-mismatch is suppressed while a SW update is pending',
	/!\$swUpdatePending/.test(tamperSrc)
);
expect(
	'cp514 — asset-mismatch is suppressed during the post-boot grace window',
	/\$tamperGraceElapsed/.test(tamperSrc)
);
expect(
	'pubkey-mismatch + invalid-payload stay ungated (only assetTamper is gated)',
	/show = \$derived\(showPubkeyMismatch \|\| showInvalidPayload \|\| assetTamper\)/.test(tamperSrc)
);

// ─── UpdateBanner keeps both actions ─────────────────────────────────
expect('UpdateBanner offers "Load it now" (apply)', /onclick=\{applyUpdate\}/.test(updateSrc));
expect('UpdateBanner offers "Later" (the cancel)', /onclick=\{dismiss\}/.test(updateSrc));

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 upgrade-banner-behavior smoke FAILED');
	process.exit(1);
}
console.log(`\u2713 all ${pass} upgrade-banner-behavior checks passed`);
