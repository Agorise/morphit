#!/usr/bin/env tsx
/**
 * apps/ops-cli/scripts/canary-dir-owner-smoke.ts  (cp619 — Ken)
 *
 * `morphit-ops upgrade` rebuilds apps/web/build as root (vite recreates the dir
 * root-owned), but that dir is where the operator uploads their PGP-signed
 * warrant canary (canary.txt + pgp_keys.asc) over SSH, and a bind-mount
 * frontend serves it directly. Before cp619 every upgrade re-rooted the dir and
 * the next weekly canary upload failed with "Permission denied" — a silently
 * STALE canary, which reads as "a warrant was served." This pins:
 *   A. the owner-decision (`chooseCanaryDirOwner`): keep the operator's non-root
 *      owner, else the install owner, else leave root (never guess);
 *   B. the upgrade wiring: capture the owner BEFORE the rebuild, restore it
 *      (chown -R) AFTER — mirroring the existing web-root chown.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chooseCanaryDirOwner } from '../src/lib/canaryDirOwner.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OPS = resolve(HERE, '..');

let pass = 0;
let fail = 0;
const ok = (m: string) => {
	pass++;
	console.log(`  \u2713 ${m}`);
};
const bad = (m: string, d = '') => {
	fail++;
	console.log(`  \u2717 ${m}`);
	if (d) console.log(`      ${d}`);
};

const MORPHIT = { uid: 1001, gid: 1001 };
const DEPLOY = { uid: 1002, gid: 1002 };
const ROOT = { uid: 0, gid: 0 };

// ── A. owner decision ────────────────────────────────────────────────
{
	// 1. Operator already set build/ to a non-root user → keep it (Ken's case).
	const r1 = chooseCanaryDirOwner(MORPHIT, ROOT);
	if (r1 && r1.uid === 1001) ok('keeps the existing non-root owner on build/ (the canary upload user)');
	else bad('should keep the non-root owner on build/', JSON.stringify(r1));

	// 2. build/ is root (fresh rebuild), install owned by the app user → fall back.
	const r2 = chooseCanaryDirOwner(ROOT, MORPHIT);
	if (r2 && r2.uid === 1001) ok('falls back to the install-dir owner when build/ is root-owned');
	else bad('should fall back to install owner', JSON.stringify(r2));

	// 3. build/ missing (first build) → fall back to install owner.
	const r3 = chooseCanaryDirOwner(null, MORPHIT);
	if (r3 && r3.uid === 1001) ok('falls back to the install owner when build/ does not exist yet');
	else bad('should fall back on missing build/', JSON.stringify(r3));

	// 4. Both root → null (leave it root; never guess a uid).
	if (chooseCanaryDirOwner(ROOT, ROOT) === null) ok('leaves it root when both build/ and install are root-owned');
	else bad('should return null when nothing non-root is found');

	// 5. Nothing readable → null.
	if (chooseCanaryDirOwner(null, null) === null) ok('returns null when neither dir is readable');
	else bad('should return null when neither dir is readable');

	// 6. build/ owner WINS over a different install owner (most-specific first).
	const r6 = chooseCanaryDirOwner(MORPHIT, DEPLOY);
	if (r6 && r6.uid === 1001) ok('the build/ owner takes precedence over a different install owner');
	else bad('build/ owner should win over install owner', JSON.stringify(r6));

	// 7. gid is carried through, not just uid.
	const r7 = chooseCanaryDirOwner({ uid: 1001, gid: 55 }, null);
	if (r7 && r7.gid === 55) ok('carries the gid through, not only the uid');
	else bad('should carry gid through', JSON.stringify(r7));
}

// ── B. upgrade.ts wiring: capture BEFORE build, restore AFTER ─────────
{
	const raw = readFileSync(resolve(OPS, 'src/commands/upgrade.ts'), 'utf8');
	const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

	if (/import\s*\{\s*chooseCanaryDirOwner\s*\}/.test(src)) ok('upgrade.ts imports chooseCanaryDirOwner');
	else bad('upgrade.ts should import chooseCanaryDirOwner');

	const iCapture = src.indexOf('chooseCanaryDirOwner(readOwner');
	const iBuild = src.indexOf("runOrThrow('npm', ['run', 'build'], { cwd: join(installDir, 'apps', 'web') })");
	const iRestore = src.indexOf("spawnSync('chown', ['-R', `${canaryDirUid}:${canaryDirGid}`");

	if (iCapture > 0 && iBuild > 0 && iCapture < iBuild)
		ok('captures the served-dir owner BEFORE the web rebuild (vite recreates it root-owned)');
	else bad('owner capture must run before the web rebuild', `capture=${iCapture} build=${iBuild}`);

	if (iRestore > 0 && iBuild > 0 && iRestore > iBuild)
		ok('restores ownership (chown -R) AFTER the rebuild');
	else bad('ownership restore must run after the rebuild', `restore=${iRestore} build=${iBuild}`);

	if (/chown.*canaryDirUid[\s\S]{0,400}apps.*web.*build|const webBuild = join\(installDir, 'apps', 'web', 'build'\)[\s\S]{0,600}spawnSync\('chown'/.test(src))
		ok('the restore chowns apps/web/build specifically');
	else bad('the restore should target apps/web/build');

	// Non-fatal: a chown failure must warn, not roll back a good build.
	if (/chownResult\.status === 0[\s\S]{0,400}warn\(/.test(src))
		ok('a failed chown warns (non-fatal) rather than rolling back the successful build');
	else bad('a failed chown should warn, not roll back');
}

console.log('');
console.log('\u2500'.repeat(56));
if (fail === 0) {
	console.log(`\u2713 all ${pass} canary-dir-owner scenarios passed`);
} else {
	console.log(`\u2717 ${fail} FAILED, ${pass} passed`);
	process.exit(1);
}
