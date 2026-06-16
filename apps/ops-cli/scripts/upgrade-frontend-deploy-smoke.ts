/**
 * upgrade-frontend-deploy-smoke (cp211; publish logic reworked beta11).
 *
 * `morphit-ops upgrade` rebuilds + redeploys the static web frontend (the
 * Node services run from TS source via tsx, so only the SvelteKit `vite
 * build` output needs rebuilding + publishing). This smoke covers:
 *
 *   - resolveWebRoot: MORPHIT_WEB_ROOT override + the /var/www/morphit-frontend
 *     default (matching docs/RUN-A-MORPHIT-NODE.md §8).
 *   - deployFrontendBuild: a REAL filesystem round-trip against temp dirs —
 *     fresh deploy lands index.html + nested assets; an overwrite updates
 *     index.html while leaving unrelated existing files; a missing build or a
 *     build with no index.html throws (so the caller rolls back rather than
 *     leaving a wrecked site live).
 *   - planFrontendDeploy: the publish decision matrix from two signals (web
 *     root exists; a container bind-mounts the build dir).
 *   - the bind-mount detection helpers (normalizeMountPath, parseMountSources,
 *     containerMountsBuildDir) that identify the frontend container by the
 *     apps/web/build mount it carries — NOT by a container name or compose
 *     file. beta11 replaces cp236, whose `morphit-frontend`-name +
 *     repo-example-compose assumptions broke on real deployments (a compose
 *     project names the container `<project>-frontend-1`, e.g.
 *     `bunkerweb-frontend-1`, and recreating it from the repo's example
 *     compose crash-looped on a cert path the operator's real stack didn't
 *     share). Restarting the exact container we detect — by its mount — fixes
 *     both.
 *
 * Plus structural wiring assertions on upgrade.ts: the run flow actually
 * builds apps/web, calls deployFrontendBuild, honors MORPHIT_WEB_ROOT, restores
 * the previous frontend on rollback, detects the frontend container by mount,
 * restarts it, and tells the operator (in the y/N prompt) that the frontend
 * will be redeployed. (The full upgrade flow needs a real release + systemd +
 * docker, exercised on the operator's box; these are the portable guards
 * against the deploy logic regressing.)
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	resolveWebRoot,
	deployFrontendBuild,
	planFrontendDeploy,
	normalizeMountPath,
	parseMountSources,
	containerMountsBuildDir,
	parseVerifyJsonVersion,
	classifyFrontendVerify
} from '../src/commands/upgrade.ts';

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

// ─── FD-1/2: resolveWebRoot ─────────────────────────────────────────
{
	const def = resolveWebRoot({});
	if (def === '/var/www/morphit-frontend') {
		ok('FD-1 resolveWebRoot default is /var/www/morphit-frontend');
	} else {
		bad('FD-1', `default was ${def}`);
	}

	const override = resolveWebRoot({ MORPHIT_WEB_ROOT: '/srv/site' });
	const trimmed = resolveWebRoot({ MORPHIT_WEB_ROOT: '  /srv/site  ' });
	const empty = resolveWebRoot({ MORPHIT_WEB_ROOT: '   ' });
	if (override === '/srv/site' && trimmed === '/srv/site' && empty === '/var/www/morphit-frontend') {
		ok('FD-2 resolveWebRoot honors override, trims whitespace, falls back on empty');
	} else {
		bad('FD-2', `override=${override} trimmed=${trimmed} empty=${empty}`);
	}
}

// ─── FD-3/4/5/6: deployFrontendBuild filesystem round-trip ──────────
function tmp(prefix: string): string {
	return mkdtempSync(join(tmpdir(), prefix));
}

// FD-3 fresh deploy: build → empty web root.
{
	const build = tmp('mfd-build-');
	const web = tmp('mfd-web-');
	mkdirSync(join(build, 'sub'), { recursive: true });
	writeFileSync(join(build, 'index.html'), '<!doctype html>NEW');
	writeFileSync(join(build, 'sub', 'app.js'), 'console.log(1)');
	try {
		deployFrontendBuild(build, web);
		const idx = existsSync(join(web, 'index.html'))
			? readFileSync(join(web, 'index.html'), 'utf8')
			: '';
		const asset = existsSync(join(web, 'sub', 'app.js'));
		if (idx === '<!doctype html>NEW' && asset) {
			ok('FD-3 fresh deploy copies index.html + nested asset into the web root');
		} else {
			bad('FD-3', `index="${idx}" assetPresent=${asset}`);
		}
	} catch (e) {
		bad('FD-3 threw unexpectedly', String(e));
	} finally {
		rmSync(build, { recursive: true, force: true });
		rmSync(web, { recursive: true, force: true });
	}
}

// FD-4 overwrite: web root already has an OLD index.html + an unrelated file.
{
	const build = tmp('mfd-build-');
	const web = tmp('mfd-web-');
	writeFileSync(join(build, 'index.html'), 'NEW-BUILD');
	writeFileSync(join(web, 'index.html'), 'OLD-BUILD');
	writeFileSync(join(web, 'robots.txt'), 'User-agent: *'); // operator-placed, unrelated
	try {
		deployFrontendBuild(build, web);
		const idx = readFileSync(join(web, 'index.html'), 'utf8');
		const robotsKept = existsSync(join(web, 'robots.txt'));
		if (idx === 'NEW-BUILD' && robotsKept) {
			ok('FD-4 overwrite updates index.html and leaves unrelated existing files in place');
		} else {
			bad('FD-4', `index="${idx}" robotsKept=${robotsKept}`);
		}
	} catch (e) {
		bad('FD-4 threw unexpectedly', String(e));
	} finally {
		rmSync(build, { recursive: true, force: true });
		rmSync(web, { recursive: true, force: true });
	}
}

// FD-5 missing build dir → throw.
{
	const web = tmp('mfd-web-');
	try {
		deployFrontendBuild(join(tmpdir(), 'mfd-does-not-exist-' + Date.now()), web);
		bad('FD-5', 'expected a throw for a missing build dir');
	} catch {
		ok('FD-5 throws when the build dir is missing (caller rolls back)');
	} finally {
		rmSync(web, { recursive: true, force: true });
	}
}

// FD-6 build present but no index.html → throw.
{
	const build = tmp('mfd-build-');
	const web = tmp('mfd-web-');
	writeFileSync(join(build, 'app.js'), 'x'); // assets but NO index.html
	try {
		deployFrontendBuild(build, web);
		bad('FD-6', 'expected a throw when the build has no index.html');
	} catch {
		ok('FD-6 throws when the build produced no index.html (caller rolls back)');
	} finally {
		rmSync(build, { recursive: true, force: true });
		rmSync(web, { recursive: true, force: true });
	}
}

// ─── FD-9/10/11/12: planFrontendDeploy decision matrix (beta11) ─────
// The web build now ALWAYS runs; planFrontendDeploy decides how to PUBLISH
// it from two signals: bare-metal web root present, and the NAME of the
// container bind-mounting the build dir (or null). Exhaust the four cases.
{
	const WR = '/var/www/morphit-frontend';
	const BD = '/opt/morphit/apps/web/build';

	// FD-9 bare-metal: web root exists, no container → copy only.
	const bare = planFrontendDeploy({
		webRootExists: true,
		frontendContainer: null,
		webRoot: WR,
		buildDir: BD
	});
	if (bare.copyToWebRoot && bare.restartContainer === null && bare.warn === null) {
		ok('FD-9 bare-metal (web root, no container) → copy to web root, no warning');
	} else {
		bad('FD-9', JSON.stringify(bare));
	}

	// FD-10 containerized: no web root, container present → restart that
	// container only, no warn. This is the regression case: pre-cp236 the
	// frontend was silently skipped here. The container name is whatever
	// `docker ps` reported — here a compose-style `bunkerweb-frontend-1`,
	// which cp236's hardcoded `morphit-frontend` filter would have MISSED.
	const bw = planFrontendDeploy({
		webRootExists: false,
		frontendContainer: 'bunkerweb-frontend-1',
		webRoot: WR,
		buildDir: BD
	});
	if (
		!bw.copyToWebRoot &&
		bw.restartContainer === 'bunkerweb-frontend-1' &&
		bw.warn === null
	) {
		ok('FD-10 containerized (compose-named container, no web root) → restart that container, no warning');
	} else {
		bad('FD-10 (frontend would be silently skipped / wrong container!)', JSON.stringify(bw));
	}

	// FD-11 both present → do both, no warning. (Container named the
	// canonical `morphit-frontend` here — also detected purely by mount.)
	const both = planFrontendDeploy({
		webRootExists: true,
		frontendContainer: 'morphit-frontend',
		webRoot: WR,
		buildDir: BD
	});
	if (both.copyToWebRoot && both.restartContainer === 'morphit-frontend' && both.warn === null) {
		ok('FD-11 both targets → copy AND restart container, no warning');
	} else {
		bad('FD-11', JSON.stringify(both));
	}

	// FD-12 neither → no publish action, and a warning that names the build dir.
	const neither = planFrontendDeploy({
		webRootExists: false,
		frontendContainer: null,
		webRoot: WR,
		buildDir: BD
	});
	if (
		!neither.copyToWebRoot &&
		neither.restartContainer === null &&
		neither.warn !== null &&
		neither.warn.includes(BD)
	) {
		ok('FD-12 neither target → no publish, warns with the build dir path');
	} else {
		bad('FD-12', JSON.stringify(neither));
	}
}

// ─── FD-16/17/18/19: bind-mount detection helpers (beta11) ──────────
// These are the robust, name-agnostic signal that a container serves OUR
// frontend build: it bind-mounts <install>/apps/web/build. cp236 matched a
// hardcoded container name instead and broke on real deployments.
{
	// FD-16 normalizeMountPath: strip a single trailing slash, keep bare "/",
	// trim surrounding whitespace.
	const n1 = normalizeMountPath('/opt/morphit/apps/web/build/');
	const n2 = normalizeMountPath('/opt/morphit/apps/web/build');
	const n3 = normalizeMountPath('  /opt/morphit/apps/web/build  ');
	const n4 = normalizeMountPath('/');
	if (
		n1 === '/opt/morphit/apps/web/build' &&
		n2 === '/opt/morphit/apps/web/build' &&
		n3 === '/opt/morphit/apps/web/build' &&
		n4 === '/'
	) {
		ok('FD-16 normalizeMountPath strips a trailing slash, trims, keeps bare "/"');
	} else {
		bad('FD-16', `n1=${n1} n2=${n2} n3=${n3} n4=${n4}`);
	}

	// FD-17 parseMountSources: split the `docker inspect --format` newline
	// list, trim each, drop blank lines (the template emits a trailing \n).
	const sources = parseMountSources(
		'/etc/letsencrypt\n/opt/morphit/apps/web/build\n\n  /var/log/nginx  \n'
	);
	if (
		sources.length === 3 &&
		sources[0] === '/etc/letsencrypt' &&
		sources[1] === '/opt/morphit/apps/web/build' &&
		sources[2] === '/var/log/nginx'
	) {
		ok('FD-17 parseMountSources splits, trims, and drops blank lines');
	} else {
		bad('FD-17', JSON.stringify(sources));
	}

	// FD-18 containerMountsBuildDir: exact match (with trailing-slash
	// normalization on both sides) hits; a parent, a sibling, and an
	// unrelated mount all miss (no false positives from prefix matching).
	const BD = '/opt/morphit/apps/web/build';
	const hit = containerMountsBuildDir(['/etc/letsencrypt', '/opt/morphit/apps/web/build/'], BD);
	const parentMiss = containerMountsBuildDir(['/opt/morphit/apps/web'], BD);
	const siblingMiss = containerMountsBuildDir(['/opt/morphit/apps/web/build-old'], BD);
	const unrelatedMiss = containerMountsBuildDir(['/etc/letsencrypt', '/var/log/nginx'], BD);
	const emptyMiss = containerMountsBuildDir([], BD);
	if (hit && !parentMiss && !siblingMiss && !unrelatedMiss && !emptyMiss) {
		ok('FD-18 containerMountsBuildDir matches the exact build dir only (no parent/sibling/prefix false positives)');
	} else {
		bad(
			'FD-18',
			`hit=${hit} parentMiss=${parentMiss} siblingMiss=${siblingMiss} unrelatedMiss=${unrelatedMiss} emptyMiss=${emptyMiss}`
		);
	}

	// FD-19 name-agnostic detection proof: a container whose inspect output
	// lists the build dir among OTHER mounts is detected regardless of its
	// name; a container mounting only a sibling dir is not. This is exactly
	// what lets us find `bunkerweb-frontend-1` (or any name) by its mount.
	const realStackInspect =
		'/etc/letsencrypt/live/morphit.io\n/opt/morphit/apps/web/build\n/var/cache/bunkerweb\n';
	const decoyInspect = '/opt/morphit/apps/web/build-staging\n/var/log\n';
	const detected = containerMountsBuildDir(parseMountSources(realStackInspect), BD);
	const notDetected = containerMountsBuildDir(parseMountSources(decoyInspect), BD);
	if (detected && !notDetected) {
		ok('FD-19 a container is detected by its apps/web/build mount among others, name-agnostically (and a decoy mount is not)');
	} else {
		bad('FD-19', `detected=${detected} notDetected=${notDetected}`);
	}
}

// ─── FD-7/8/13/14/20: structural wiring assertions on upgrade.ts ────
{
	const upgradeSrc = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'commands', 'upgrade.ts'),
		'utf8'
	);
	const checks: Array<{ id: string; re: RegExp; desc: string }> = [
		{
			id: 'FD-7a',
			re: /resolveWebRoot\(process\.env\)/,
			desc: 'runUpgrade resolves the web root via resolveWebRoot(process.env)'
		},
		{
			id: 'FD-7b',
			re: /runOrThrow\(\s*'npm',\s*\['run',\s*'build'\][\s\S]*?'apps',\s*'web'/,
			desc: 'runUpgrade builds apps/web (npm run build, cwd apps/web)'
		},
		{
			id: 'FD-7c',
			re: /deployFrontendBuild\(\s*buildDir,\s*webRoot\s*\)/,
			desc: 'runUpgrade calls deployFrontendBuild(buildDir, webRoot)'
		},
		{
			id: 'FD-7d',
			re: /cpSync\(web\.webRootBackup, web\.webRoot/,
			desc: 'rollback restores the previous web frontend from its backup'
		},
		{
			id: 'FD-8',
			re: /redeploy the web frontend/,
			desc: 'the confirmation prompt tells the operator the frontend will be redeployed'
		},
		{
			id: 'FD-13',
			re: /planFrontendDeploy\(\{[\s\S]*?frontendContainer:/,
			desc: 'runUpgrade decides how to publish via planFrontendDeploy({ frontendContainer, ... })'
		},
		{
			id: 'FD-14a',
			re: /findFrontendContainer\(buildDir\)/,
			desc: 'runUpgrade detects the frontend container by the build-dir mount (findFrontendContainer)'
		},
		{
			id: 'FD-14b',
			re: /restartFrontendContainer\(plan\.restartContainer\)/,
			desc: 'runUpgrade restarts the detected container (restartFrontendContainer)'
		},
		{
			id: 'FD-14c',
			re: /docker['"\],\s]+inspect[\s\S]*?\.Mounts[\s\S]*?\.Source/,
			desc: 'findFrontendContainer inspects container .Mounts .Source'
		}
	];
	for (const c of checks) {
		if (c.re.test(upgradeSrc)) {
			ok(`${c.id} ${c.desc}`);
		} else {
			bad(c.id, `wiring missing: ${c.desc}`);
		}
	}

	// FD-20 (beta11 regression guard): cp236's name/compose-based approach is
	// fully GONE — no `recreateBunkerwebFrontend`, no `bunkerwebFrontendPresent`,
	// no hardcoded `name=^/morphit-frontend$` docker filter, no
	// `--force-recreate frontend`. Their presence would mean the old broken
	// publish path crept back.
	const ghosts: Array<{ re: RegExp; what: string }> = [
		{ re: /recreateBunkerwebFrontend/, what: 'recreateBunkerwebFrontend()' },
		{ re: /bunkerwebFrontendPresent/, what: 'bunkerwebFrontendPresent()' },
		{ re: /name=\^\/morphit-frontend\$/, what: 'hardcoded morphit-frontend docker filter' },
		{ re: /--force-recreate/, what: 'docker compose --force-recreate' }
	];
	const ghostHits = ghosts.filter((g) => g.re.test(upgradeSrc)).map((g) => g.what);
	if (ghostHits.length === 0) {
		ok('FD-20 cp236 name/compose-based publish path fully removed (no recreate/name-filter/force-recreate ghosts)');
	} else {
		bad('FD-20 stale cp236 publish path present', ghostHits.join(', '));
	}

	// FD-15 (cp236 regression guard): the web build must be UNCONDITIONAL.
	// The original bug nested `npm run build` inside an `if (webRoot exists)`
	// else, so a container-served host (no /var/www/morphit-frontend) silently
	// skipped the frontend rebuild. Assert (a) the old skip text is gone and
	// (b) the build is NOT gated behind a webRoot-existence else.
	const oldSkipText = /skipping the frontend redeploy/.test(upgradeSrc);
	const buildGatedBehindWebRoot =
		/if\s*\(\s*!existsSync\(webRoot\)\s*\)[\s\S]*?else[\s\S]*?runOrThrow\(\s*'npm',\s*\['run',\s*'build'\]/.test(
			upgradeSrc
		);
	if (!oldSkipText && !buildGatedBehindWebRoot) {
		ok('FD-15 web build is unconditional (not skipped when the web root is absent)');
	} else {
		bad(
			'FD-15 web build is conditional again — container-served hosts would silently skip it',
			`oldSkipText=${oldSkipText} buildGatedBehindWebRoot=${buildGatedBehindWebRoot}`
		);
	}
}

// ─── FD-21/22: served-frontend freshness verification (beta14) ──────
{
	// parseVerifyJsonVersion pulls the `morphit_version` field out of
	// build/verify.json — the SAME field scripts/build-verify-json.mjs writes
	// and apps/web .../about-this-instance reads. (The old morphit-<token> SW
	// grep never survived minification, so the check always came back
	// "unknown"; reading the WRONG json field — a bare `version` — silently did
	// the exact same thing, which is what shipped in the first beta18 cut.
	// FD-21c below is the cross-file drift guard against that recurring.)
	// Fixture uses the REAL verify.json shape, not a hand-fabricated one.
	const verifyJson = JSON.stringify({
		schema_version: 1,
		morphit_version: '1.0.0-beta.20',
		git_commit: null,
		operator_tag: null,
		built_at: '2026-06-15T00:00:00.000Z',
		hash_manifest: {}
	});
	const v = parseVerifyJsonVersion(verifyJson);
	if (v === '1.0.0-beta.20') ok('FD-21a parseVerifyJsonVersion extracts morphit_version from the real verify.json shape');
	else bad('FD-21a', `got ${v}`);

	if (
		parseVerifyJsonVersion('not json') === null &&
		parseVerifyJsonVersion('{"no":"version"}') === null &&
		// A bare `version` field must NOT satisfy it — the real file keys on
		// morphit_version. This negative is what would have caught the bug.
		parseVerifyJsonVersion('{"version":"1.0.0-beta.20"}') === null
	)
		ok('FD-21b parseVerifyJsonVersion returns null on bad/missing/wrong-field json');
	else bad('FD-21b', 'expected null on bad/missing/wrong-field version');

	// FD-21c — DRIFT GUARD: the generator (writes), the upgrade parser (reads),
	// and the about-this-instance page (reads) must all key on the SAME field.
	// The first beta18 cut shipped a generator writing `morphit_version` and a
	// parser reading `.version` → always null → "unknown" forever. Assert the
	// literal field name is present in all three sources so they can't drift.
	const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
	const FIELD = 'morphit_version';
	const genSrc = readFileSync(join(repoRoot, 'scripts', 'build-verify-json.mjs'), 'utf8');
	const parserSrc = readFileSync(join(repoRoot, 'apps', 'ops-cli', 'src', 'commands', 'upgrade.ts'), 'utf8');
	const aboutSrc = readFileSync(
		join(repoRoot, 'apps', 'web', 'src', 'routes', '[lang]', 'about-this-instance', '+page.svelte'),
		'utf8'
	);
	const genWrites = genSrc.includes(`${FIELD}:`); // payload key
	const parserReads = parserSrc.includes(`.${FIELD}`) || parserSrc.includes(`{ ${FIELD}?:`);
	const aboutReads = aboutSrc.includes(FIELD);
	if (genWrites && parserReads && aboutReads)
		ok(`FD-21c verify.json field "${FIELD}" agrees across generator, upgrade parser, and about page`);
	else bad('FD-21c', `field drift: generator=${genWrites} parser=${parserReads} about=${aboutReads}`);

	// classifyFrontendVerify: fresh / stale / unknown.
	if (classifyFrontendVerify('abc', 'abc') === 'fresh') ok('FD-22a equal versions → fresh (snackbar will fire)');
	else bad('FD-22a');
	if (classifyFrontendVerify('newbuild', 'oldbuild') === 'stale')
		ok('FD-22b served ≠ built → stale (snackbar blocked, warn)');
	else bad('FD-22b');
	if (classifyFrontendVerify(null, 'x') === 'unknown' && classifyFrontendVerify('x', null) === 'unknown')
		ok('FD-22c either version unknown → unknown (best-effort note)');
	else bad('FD-22c');
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 upgrade-frontend-deploy smoke FAILED');
	process.exit(1);
}
console.log('\u2713 upgrade rebuilds + redeploys the static frontend, with rollback');
console.log(`\u2713 all ${pass} upgrade-frontend-deploy scenarios passed`);
