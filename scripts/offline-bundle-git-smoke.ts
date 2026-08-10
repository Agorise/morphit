#!/usr/bin/env tsx
/**
 * offline-bundle-git — cp689.
 *
 * A truly offline (air-gapped) install must not reach the network for ANY step.
 * The bundle ships git in its apt closure, but morphit-setup.sh used to install
 * git with a plain online `apt-get install -y git`, so on an air-gapped box git
 * was skipped and on an online box it wasted a download. It must install git
 * FROM the bundled apt repo (vendor/apt) when a bundle is present.
 *
 * Guards: (1) git is in the bundle's apt closure, and (2) morphit-setup.sh
 * installs git from vendor/apt on the offline path, reaching the network only
 * when there is no bundle.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel: string): string => readFileSync(join(REPO, rel), 'utf8');

let pass = 0;
let fail = 0;
const check = (n: string, c: boolean, d = ''): void => {
	if (c) {
		console.log(`  ✓ ${n}`);
		pass++;
	} else {
		console.log(`  ✗ ${n}${d ? `: ${d}` : ''}`);
		fail++;
	}
};

console.log('\n── offline-bundle-git (cp689) ─────────────────────────\n');

const bundle = read('scripts/build-offline-bundle.sh');
const pkgsMatch = /PKGS="([^"]*)"/s.exec(bundle);
const pkgs = pkgsMatch?.[1] ?? '';
check('git is in the offline bundle apt closure (build-offline-bundle.sh PKGS)', /\bgit\b/.test(pkgs));

const setup = read('morphit-setup.sh');
// find the git-install block
const gitBlockStart = setup.indexOf('command -v git');
const gitBlock = gitBlockStart !== -1 ? setup.slice(gitBlockStart, gitBlockStart + 1200) : '';
check(
	'morphit-setup.sh installs git from the bundled repo (vendor/apt) when present',
	/vendor\/apt/.test(gitBlock) && /file:\/\//.test(gitBlock),
	'must resolve git from the bundle, not the network, on the offline path'
);
check(
	'the git install falls back to the bundled .deb closure via dpkg',
	/dpkg -i vendor\/apt\/git/.test(gitBlock)
);
check(
	'a plain online `apt-get install -y git` runs ONLY when there is no bundle',
	// the online apt-get for git must be in the else (no-bundle) branch, i.e.
	// it appears AFTER a `vendor/apt/Packages` guard, not as the first action.
	/vendor\/apt\/Packages[\s\S]*else[\s\S]*apt-get install -y git/.test(gitBlock),
	'offline path must never reach the registry for git'
);

// cp690 — ansible + its galaxy collections must also be bundled + installed
// offline (they were being fetched from the Ubuntu archive + Ansible Galaxy).
check('ansible is in the offline bundle apt closure (PKGS)', /\bansible\b/.test(pkgs));
check(
	'the bundle downloads the ansible galaxy collections into vendor/ansible-collections',
	/ansible-galaxy collection download/.test(bundle) && /vendor\/ansible-collections/.test(bundle)
);
const assemble = read('apps/ops-cli/src/init/assembleInstall.ts');
check(
	'ansible is installed from the bundled apt repo (vendorApt) when present',
	/vendorApt/.test(assemble) && /Dir::Etc::SourceList=\$\{bl\}/.test(assemble),
	'the online apt-get install of ansible must be gated behind a no-bundle check'
);
check(
	'ansible collections install from the bundled vendor/ansible-collections when present',
	/vendor.*ansible-collections/.test(assemble) && /bundledReqs/.test(assemble)
);
check(
	'the online ansible apt install runs ONLY when there is no bundled repo',
	/existsSync\(join\(vendorApt, 'Packages'\)\)[\s\S]*else[\s\S]*apt-get['\s,]*.*install.*ansible/.test(
		assemble
	),
	'offline path must never reach the archive for ansible'
);

console.log(
	`\n${pass} passed, ${fail} failed\n${fail === 0 ? `✓ all ${pass} offline-bundle-git checks passed` : '✗ FAILED'}`
);
process.exit(fail === 0 ? 0 : 1);
