#!/usr/bin/env tsx
/**
 * canary-serve-dir.
 *
 * On an ansible/home install the wizard runs canary setup from the SOURCE
 * tarball (~/Downloads/morphit) but the frontend container serves the DEPLOYED
 * build (/opt/morphit/apps/web/build). The canary must land in the SERVED dir,
 * not the source tree, or /canary.txt 404s (and the weekly refresh keeps missing
 * too). Guards that setup.sh honours a served-dir override and the wizard passes
 * it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (r: string): string => readFileSync(join(REPO, r), 'utf8');
let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
	if (c) { console.log(`  ✓ ${n}`); pass++; }
	else { console.log(`  ✗ ${n}${d ? `: ${d}` : ''}`); fail++; }
};

console.log('\n── canary-serve-dir (cp693) ───────────────────────────\n');
const setup = read('scripts/canary/setup.sh');
check(
	'setup.sh honours a MORPHIT_CANARY_SERVE_DIR override (defaults to the source build)',
	/SERVE_DIR="\$\{MORPHIT_CANARY_SERVE_DIR:-\$REPO_ROOT\/apps\/web\/build\}"/.test(setup)
);
check(
	'the generated weekly refresh writes to the served dir ($SERVE), not the source tree',
	/printf "SERVE='%s'\\n" "\$SERVE_DIR"/.test(setup) && /printf 'DEST="\$SERVE"\\n'/.test(setup)
);
const wiz = read('apps/ops-cli/src/init/runAnsibleInstall.ts');
check(
	'the wizard passes the DEPLOYED served build dir to the canary script',
	/MORPHIT_CANARY_SERVE_DIR: '\/opt\/morphit\/apps\/web\/build'/.test(wiz)
);
// ─── (2026-10-07) the weekly refresh runs the DEPLOYED tree's canary code ───
// morphitlat: the refresh's REPO was the unpacked source (~/Downloads/morphit),
// which upgrades never touch; its old canary code fetched the chain head from
// clearnet nodes the zero-clearnet box no longer reaches, and every weekly run
// failed. setup.sh's canary_run_repo picks the tree; run it against real dirs.
{
	const m = /^canary_run_repo\(\) \{[\s\S]*?^\}$/m.exec(setup);
	check('setup.sh defines canary_run_repo', m !== null);
	check(
		'the refresh script records the tree canary_run_repo picked',
		/^RUN_REPO="\$\(canary_run_repo "\$REPO_ROOT" "\$SERVE_DIR"\)"$/m.test(setup) &&
			/printf "REPO='%s'\\n" "\$RUN_REPO"/.test(setup) &&
			!/printf "REPO='%s'\\n" "\$REPO_ROOT"/.test(setup)
	);
	if (m) {
		const t = mkdtempSync(join(tmpdir(), 'canary-run-repo-'));
		const mk = (d: string, withCanary: boolean): string => {
			mkdirSync(join(t, d, 'apps', 'web', 'build'), { recursive: true });
			if (withCanary) {
				mkdirSync(join(t, d, 'scripts', 'canary'), { recursive: true });
				writeFileSync(join(t, d, 'scripts', 'canary', 'generate.sh'), '#!/bin/sh\n');
			}
			return join(t, d);
		};
		const src = mk('Downloads/morphit', true);
		const deployed = mk('opt/morphit', true);
		const bare = mk('srv/www', false);
		const pick = (root: string, serve: string): string =>
			spawnSync('bash', ['-c', `${m[0]}\ncanary_run_repo "$1" "$2"`, '_', root, serve], {
				encoding: 'utf8'
			}).stdout;
		check(
			'run from the unpacked source, serving the deployed build → the DEPLOYED tree',
			pick(src, join(deployed, 'apps', 'web', 'build')) === deployed
		);
		check(
			'serving its own build (a source install, or a laptop that uploads) → the source tree',
			pick(src, join(src, 'apps', 'web', 'build')) === src
		);
		check(
			'a served dir that is not a Morphit tree → the source tree',
			pick(src, join(bare, 'apps', 'web', 'build')) === src
		);
		rmSync(t, { recursive: true, force: true });
	}
}
console.log(`\n${pass} passed, ${fail} failed\n${fail === 0 ? `✓ all ${pass} canary-serve-dir checks passed` : '✗ FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
