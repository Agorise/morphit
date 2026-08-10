#!/usr/bin/env tsx
/**
 * canary-serve-dir — cp693.
 *
 * On an ansible/home install the wizard runs canary setup from the SOURCE
 * tarball (~/Downloads/morphit) but the frontend container serves the DEPLOYED
 * build (/opt/morphit/apps/web/build). The canary must land in the SERVED dir,
 * not the source tree, or /canary.txt 404s (and the weekly refresh keeps missing
 * too). Guards that setup.sh honours a served-dir override and the wizard passes
 * it.
 */
import { readFileSync } from 'node:fs';
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
console.log(`\n${pass} passed, ${fail} failed\n${fail === 0 ? `✓ all ${pass} canary-serve-dir checks passed` : '✗ FAILED'}`);
process.exit(fail === 0 ? 0 : 1);
