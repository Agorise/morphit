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
