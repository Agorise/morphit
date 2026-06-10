/**
 * upgrade-frontend-deploy-smoke (cp211).
 *
 * `morphit-ops upgrade` now rebuilds + redeploys the static web frontend
 * (the Node services run from TS source via tsx, so only the SvelteKit
 * `vite build` output needs rebuilding + copying into the web root nginx
 * serves). This smoke covers the two new pieces of that logic:
 *
 *   - resolveWebRoot: MORPHIT_WEB_ROOT override + the /var/www/morphit-frontend
 *     default (matching docs/RUN-A-MORPHIT-NODE.md §8).
 *   - deployFrontendBuild: a REAL filesystem round-trip against temp dirs —
 *     fresh deploy lands index.html + nested assets; an overwrite updates
 *     index.html while leaving unrelated existing files; a missing build or a
 *     build with no index.html throws (so the caller rolls back rather than
 *     leaving a wrecked site live).
 *
 * Plus structural wiring assertions on upgrade.ts: the run flow actually
 * builds apps/web, calls deployFrontendBuild, honors MORPHIT_WEB_ROOT, restores
 * the previous frontend on rollback, and tells the operator (in the y/N prompt)
 * that the frontend will be redeployed. (The full upgrade flow needs a real
 * release + systemd, exercised on the operator's box; these are the portable
 * guards against the deploy logic regressing.)
 */

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { resolveWebRoot, deployFrontendBuild, planFrontendDeploy } from '../src/commands/upgrade.ts';

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

// ─── FD-9/10/11/12: planFrontendDeploy decision matrix (cp236) ──────
// The web build now ALWAYS runs; planFrontendDeploy decides how to PUBLISH
// it from two signals (bare-metal web root present, BunkerWeb frontend
// container present). Exhaust the four cases.
{
	const WR = '/var/www/morphit-frontend';
	const BD = '/opt/morphit/apps/web/build';

	// FD-9 bare-metal: web root exists, no BunkerWeb container → copy only.
	const bare = planFrontendDeploy({
		webRootExists: true,
		bunkerwebFrontendPresent: false,
		webRoot: WR,
		buildDir: BD
	});
	if (bare.copyToWebRoot && !bare.recreateBunkerwebFrontend && bare.warn === null) {
		ok('FD-9 bare-metal (web root, no container) → copy to web root, no warning');
	} else {
		bad('FD-9', JSON.stringify(bare));
	}

	// FD-10 BunkerWeb: no web root, container present → recreate only, no warn.
	// This is the regression case: pre-cap236 the frontend was silently
	// skipped here.
	const bw = planFrontendDeploy({
		webRootExists: false,
		bunkerwebFrontendPresent: true,
		webRoot: WR,
		buildDir: BD
	});
	if (!bw.copyToWebRoot && bw.recreateBunkerwebFrontend && bw.warn === null) {
		ok('FD-10 BunkerWeb (container, no web root) → recreate container, no warning');
	} else {
		bad('FD-10 (BunkerWeb frontend would be silently skipped!)', JSON.stringify(bw));
	}

	// FD-11 both present → do both, no warning.
	const both = planFrontendDeploy({
		webRootExists: true,
		bunkerwebFrontendPresent: true,
		webRoot: WR,
		buildDir: BD
	});
	if (both.copyToWebRoot && both.recreateBunkerwebFrontend && both.warn === null) {
		ok('FD-11 both targets → copy AND recreate, no warning');
	} else {
		bad('FD-11', JSON.stringify(both));
	}

	// FD-12 neither → no publish action, and a warning that names the build dir.
	const neither = planFrontendDeploy({
		webRootExists: false,
		bunkerwebFrontendPresent: false,
		webRoot: WR,
		buildDir: BD
	});
	if (
		!neither.copyToWebRoot &&
		!neither.recreateBunkerwebFrontend &&
		neither.warn !== null &&
		neither.warn.includes(BD)
	) {
		ok('FD-12 neither target → no publish, warns with the build dir path');
	} else {
		bad('FD-12', JSON.stringify(neither));
	}
}

// ─── FD-7/8: structural wiring assertions on upgrade.ts ─────────────
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
			re: /deployFrontendBuild\(\s*join\(installDir, 'apps', 'web', 'build'\),\s*webRoot\s*\)/,
			desc: 'runUpgrade calls deployFrontendBuild(<install>/apps/web/build, webRoot)'
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
			re: /planFrontendDeploy\(\{/,
			desc: 'runUpgrade decides how to publish via planFrontendDeploy({...})'
		},
		{
			id: 'FD-14',
			re: /recreateBunkerwebFrontend\(/,
			desc: 'runUpgrade recreates the BunkerWeb frontend container when present'
		}
	];
	for (const c of checks) {
		if (c.re.test(upgradeSrc)) {
			ok(`${c.id} ${c.desc}`);
		} else {
			bad(c.id, `wiring missing: ${c.desc}`);
		}
	}

	// FD-15 (cp236 regression guard): the web build must be UNCONDITIONAL.
	// The original bug nested `npm run build` inside an `if (webRoot exists)`
	// else, so a BunkerWeb host (no /var/www/morphit-frontend) silently
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
			'FD-15 web build is conditional again — BunkerWeb hosts would silently skip it',
			`oldSkipText=${oldSkipText} buildGatedBehindWebRoot=${buildGatedBehindWebRoot}`
		);
	}
}

console.log('');
console.log(`${pass} passed, ${fail} failed`);
if (fail > 0) {
	console.log('\u2717 upgrade-frontend-deploy smoke FAILED');
	process.exit(1);
}
console.log('\u2713 upgrade rebuilds + redeploys the static frontend, with rollback');
console.log(`\u2713 all ${pass} upgrade-frontend-deploy scenarios passed`);
