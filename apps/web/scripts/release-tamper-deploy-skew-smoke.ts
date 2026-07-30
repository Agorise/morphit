#!/usr/bin/env tsx
/**
 * Morphit — tamper-banner deploy-skew guard (v1.8.1).
 *
 * THE BUG (v1.8.1): the scary red "Build integrity check failed" banner flashed
 * on routine server upgrades. The release store's asset-hash check re-fetches
 * the SERVED bytes and compares them to the chain-pinned manifest. During a
 * deploy the served build runs ahead of the chain-pin (the operator broadcasts
 * the matching manifest moments later), so every served asset mismatched the
 * still-OLD manifest — and when the running (cached) version still equalled the
 * chain-pin version, the existing `staleBuild` suppression didn't fire, so the
 * banner showed. Morphit builds are not byte-reproducible across machines, so a
 * version match is the ONLY precondition under which the byte comparison means
 * anything.
 *
 * THE FIX: gate the asset check on the served /verify.json version. Only run the
 * byte comparison (and thus only ever alarm) when the served version equals the
 * announced version. A genuine tamper is a SAME-version byte change, which still
 * trips the check. This guard pins the gate so it can't be removed by accident.
 *
 * cp508 (tt.txt #3) — MOBILE persistence follow-up. checkManifestAgainstRunning-
 * Bundle re-fetches each asset, and those fetches hit the browser/service-worker
 * cache (the running bundle's own bytes), not the network. Right after a deploy
 * — most visibly on mobile, where the SW keeps serving the previous bundle until
 * it swaps — the RUNNING version is still OLD while served + announced are NEW,
 * so served===announced passed the v1.8.1 gate and every OLD cached asset then
 * mismatched the NEW manifest → the scary banner, which only cleared on a SECOND
 * refresh. The gate now ALSO requires RUNNING_VERSION === announcedVersion: a
 * stale running bundle is a deploy-skew (the staleBuild snackbar handles the
 * reload), not tampering. This guard pins that second clause too.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STORE = join(REPO, 'apps/web/src/lib/stores/release.ts');
const src = readFileSync(STORE, 'utf-8');

let failed = 0;
let passed = 0;
function check(name: string, ok: boolean): void {
	console.log(`  ${ok ? '✓' : '✗'} ${name}`);
	if (ok) passed++;
	else failed++;
}

// 1 — the store reads the SERVED version from /verify.json.
check(
	'release store fetches the served version from verify.json',
	/verifyJsonPollUrl|parseDeployedVersion/.test(src) && /fetchServedVersion/.test(src)
);

// 2 — the asset check is GATED: a served-vs-announced version mismatch skips
//     to a benign deploy_skew state instead of running the byte comparison.
const skewIdx = src.search(/servedVersion\s*!==\s*announcedVersion/);
const checkIdx = src.indexOf('checkManifestAgainstRunningBundle', src.indexOf('await import'));
check('a served≠announced version skew short-circuits before the byte check', skewIdx !== -1);
check(
	"the skew branch sets the benign 'deploy_skew' state (no alarm)",
	/kind:\s*'deploy_skew'/.test(src)
);
check(
	'the gate runs BEFORE the manifest byte check',
	skewIdx !== -1 && checkIdx !== -1 && skewIdx < checkIdx
);

// 4b (cp508) — the deploy_skew gate ALSO short-circuits when the RUNNING bundle
//     is not the announced version (the mobile stale-SW case). Without this the
//     OLD cached bundle's bytes mismatch the NEW manifest and flash the banner
//     until a 2nd refresh swaps the SW.
const gateMatch = src.match(
	/if\s*\(\s*(servedVersion[^)]*)\)\s*\{\s*assetCheckStore\.set\(\{\s*kind:\s*'deploy_skew'\s*\}\);\s*return;/
);
check(
	'the deploy_skew gate short-circuits on running≠announced too (cp508 mobile fix)',
	!!gateMatch && /RUNNING_VERSION\s*!==\s*announcedVersion/.test(gateMatch[1])
);

// 3 — the skew branch RETURNS, so a mismatch state is never set during a deploy.
const afterSkew = src.slice(skewIdx, skewIdx + 200);
check('the skew branch returns before any mismatch can be set', /deploy_skew'\s*\}\);\s*return;/.test(afterSkew));

// 4 — genuine tamper still reachable: the 'mismatch' state is still set after
//     the gate (same-version byte change alarms as before).
check(
	"genuine same-version tamper still sets the 'mismatch' state",
	/kind:\s*'mismatch'/.test(src.slice(checkIdx))
);

console.log('');
if (failed === 0) {
	console.log(`✓ all ${passed} release-tamper-deploy-skew scenarios passed (upgrades no longer flash the banner)`);
	process.exit(0);
} else {
	console.error(`✗ ${failed} release-tamper-deploy-skew check(s) failed`);
	process.exit(1);
}
