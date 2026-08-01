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
import { chooseCanaryDirOwner, parsePasswdRefreshTarget } from '../src/lib/canaryDirOwner.ts';

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

	if (/import\s*\{[^}]*chooseCanaryDirOwner[^}]*\}/.test(src)) ok('upgrade.ts imports chooseCanaryDirOwner');
	else bad('upgrade.ts should import chooseCanaryDirOwner');

	const iCapture = src.indexOf('chooseCanaryDirOwner(readOwner');
	const iBuild = src.indexOf("runOrThrow('npm', ['run', 'build'], { cwd: join(installDir, 'apps', 'web') })");
	const iRestore = src.indexOf("spawnSync('chown', ['-R', `${canaryDirUid}:${canaryDirGid}`");

	if (iCapture > 0 && iBuild > 0 && iCapture < iBuild)
		ok('captures the served-dir owner BEFORE the web rebuild (vite recreates it root-owned)');
	else bad('owner capture must run before the web rebuild', `capture=${iCapture} build=${iBuild}`);

	// cp624 — the owner MUST be read from the OLD install (backupDir), NOT the fresh
	// post-extract tree. Step 7 renamed the operator's install (with their chowned,
	// non-root build/) to backupDir, and step 8 extracted a root-owned installDir
	// with NO build/ yet — so reading installDir preserved NOTHING and a root-owned
	// /opt/morphit install still hit EACCES. This is the assertion the original
	// wiring test lacked (it checked "capture before build" but not WHERE from).
	if (/const oldBuild = join\(backupDir, 'apps', 'web', 'build'\)/.test(src))
		ok('cp624: oldBuild resolves to backupDir/apps/web/build (the pre-upgrade install)');
	else bad('cp624: oldBuild should be backupDir/apps/web/build');

	if (/chooseCanaryDirOwner\(readOwner\(oldBuild\), readOwner\(backupDir\)\)/.test(src))
		ok('cp624: reads the canary-dir owner from the OLD install (backupDir), not the fresh tree');
	else bad('cp624: owner capture must read from backupDir, not the freshly-extracted installDir');

	// Guard against regressing to the buggy source: the capture must NOT read the
	// owner from the fresh installDir tree.
	if (!/chooseCanaryDirOwner\(readOwner\(webBuild\), readOwner\(installDir\)\)/.test(src))
		ok('cp624: capture no longer reads the owner from the fresh installDir tree');
	else bad('cp624: capture still reads the owner from installDir (the fresh tree) — the cp619 bug');

	if (iRestore > 0 && iBuild > 0 && iRestore > iBuild)
		ok('restores ownership (chown -R) AFTER the rebuild');
	else bad('ownership restore must run after the rebuild', `restore=${iRestore} build=${iBuild}`);

	if (/chown.*canaryDirUid[\s\S]{0,400}apps.*web.*build|const webBuild = join\(installDir, 'apps', 'web', 'build'\)[\s\S]{0,600}spawnSync\('chown'/.test(src))
		ok('the restore chowns apps/web/build specifically');
	else bad('the restore should target apps/web/build');

	// Non-fatal: a chown failure must warn, not roll back a good build.
	if (/chownOk[\s\S]{0,400}warn\(/.test(src))
		ok('a failed chown warns (non-fatal) rather than rolling back the successful build');
	else bad('a failed chown should warn, not roll back');

	// cp622 — the restore now also hands static/ back (the refresh writes
	// static/canary.txt before copying it into build/, so it needs both writable).
	if (/'apps', 'web', 'static'/.test(src))
		ok('the restore also chowns apps/web/static (generate.sh writes the signed canary there)');
	else bad('the restore should also chown apps/web/static');
}

// ── C. parsePasswdRefreshTarget (cp622 — same-box refresh target) ─────
{
	const good = parsePasswdRefreshTarget('morphit:x:1001:1001::/home/morphit:/bin/bash');
	if (
		good &&
		good.user === 'morphit' &&
		good.home === '/home/morphit' &&
		good.refreshScript === '/home/morphit/.morphit/update-canary.sh'
	)
		ok('parses a normal passwd line into user + home + refresh-script path');
	else bad('should parse a normal passwd line', JSON.stringify(good));

	// getent output can carry a trailing newline — take the first line only.
	const trailingNl = parsePasswdRefreshTarget('kc:x:1000:1000:Ken:/home/kc:/bin/bash\n');
	if (trailingNl && trailingNl.user === 'kc' && trailingNl.refreshScript === '/home/kc/.morphit/update-canary.sh')
		ok('tolerates a trailing newline from getent');
	else bad('should tolerate a trailing newline', JSON.stringify(trailingNl));

	// A GECOS field with spaces/commas must not confuse the colon split.
	const gecos = parsePasswdRefreshTarget('op:x:1005:1005:Op Erator,,,:/srv/op:/bin/sh');
	if (gecos && gecos.user === 'op' && gecos.home === '/srv/op')
		ok('reads home from field 6 even with a populated GECOS field');
	else bad('should read home past the GECOS field', JSON.stringify(gecos));

	// Malformed / empty → null (caller then falls back to the manual reminder).
	if (parsePasswdRefreshTarget('') === null) ok('empty line → null');
	else bad('empty line should be null');
	if (parsePasswdRefreshTarget('nobody') === null) ok('no home field → null');
	else bad('a line with no home field should be null');
	if (parsePasswdRefreshTarget(':x:0:0:::') === null) ok('blank username → null');
	else bad('a blank username should be null');
}

// ── D. upgrade.ts cp622 wiring: same-box auto-restore, guarded ────────
{
	const raw = readFileSync(resolve(OPS, 'src/commands/upgrade.ts'), 'utf8');
	const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');

	if (/import\s*\{[^}]*parsePasswdRefreshTarget[^}]*\}/.test(src)) ok('upgrade.ts imports parsePasswdRefreshTarget');
	else bad('upgrade.ts should import parsePasswdRefreshTarget');

	// Only for operators who had a canary before the upgrade.
	if (/existsSync\(join\(backupDir, 'apps', 'web', 'build', 'canary\.txt'\)\)/.test(src))
		ok('auto-restore only fires when the previous install actually had a canary');
	else bad('auto-restore should gate on a pre-upgrade canary');

	// Runs the refresh AS the owner, non-interactively, with a timeout (no hang).
	if (/sudo'[\s\S]{0,80}'-n'[\s\S]{0,80}'-u'[\s\S]{0,120}'bash'/.test(src) && /timeout: 90_000/.test(src))
		ok('runs the refresh via sudo -n -u <user> bash with a 90s timeout (can never hang)');
	else bad('the auto-refresh must be sudo -n -u <user> bash + timeout-guarded');

	// No controlling tty → a passphrase-protected key fails fast, not a pinentry hang.
	if (/GPG_TTY: ''/.test(src)) ok("clears GPG_TTY so a passphrased key can't hang on a tty pinentry");
	else bad('should clear GPG_TTY for the non-interactive refresh');

	// The manual reminder must NOT also fire when the auto-restore succeeded.
	if (/!canaryAutoRefreshed && existsSync\(join\(backupDir/.test(src))
		ok('the manual re-run reminder is suppressed once the canary is auto-restored');
	else bad('the reminder should be gated on !canaryAutoRefreshed');

	// Placement: auto-restore runs BEFORE step 9c so a web-root copy includes it.
	const iRefresh = src.indexOf('parsePasswdRefreshTarget(pw.stdout)');
	const iPublish = src.indexOf('const plan = planFrontendDeploy(');
	if (iRefresh > 0 && iPublish > 0 && iRefresh < iPublish)
		ok('auto-restore runs BEFORE the frontend publish (9c), so a web-root copy picks up the canary');
	else bad('auto-restore must run before step 9c', `refresh=${iRefresh} publish=${iPublish}`);
}

console.log('');
console.log('\u2500'.repeat(56));
if (fail === 0) {
	console.log(`\u2713 all ${pass} canary-dir-owner scenarios passed`);
} else {
	console.log(`\u2717 ${fail} FAILED, ${pass} passed`);
	process.exit(1);
}
