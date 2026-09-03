#!/usr/bin/env tsx
/**
 * os-support-parity-smoke.ts (v1.15.4)
 *
 * The v1.15.4 install bug was a SELF-CONTRADICTION across surfaces: the
 * one-command installer's wizard/docs implied Ubuntu 22.04 was fine, while the
 * playbook has only ever provisioned the Ubuntu 24.04 "noble" base — so a fresh
 * 22.04 box was waved through, then hard-failed several steps in on an assertion
 * the installer didn't recognise, dead-ending the admin at support.
 *
 * This smoke makes the three OS-support surfaces PROVE they agree, so the drift
 * can't come back silently:
 *   1. the installer's own pre-check  (checkNobleBase / NOBLE_ONLY_GUIDANCE)
 *   2. the playbook's hard assertion  (morphit_ubuntu_codename == "noble")
 *   3. the run-a-node guide            (must not sell 22.04 on the one-command path)
 *
 * It ALSO pins the deliberate two-tier boundary: systemCheck.ts stays advisory
 * (it green-lights Ubuntu/Debian-based OSes for MANUAL installs) — only the
 * one-command path (assembleInstall) is noble-only. If someone "fixes" the drift
 * by hard-blocking every non-noble OS in systemCheck, that regresses documented
 * manual-install support, so we assert the boundary is intact.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkNobleBase, NOBLE_ONLY_GUIDANCE } from '../src/init/assembleInstall.ts';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const read = (p: string): string => readFileSync(join(REPO, p), 'utf8');

let pass = 0;
const fails: string[] = [];
const check = (desc: string, ok: boolean): void => {
	if (ok) {
		pass++;
		console.log(`  \u2713 ${desc}`);
	} else {
		fails.push(desc);
		console.log(`  \u2717 ${desc}`);
	}
};

console.log('\n\u2500\u2500 os-support parity: installer \u21d4 playbook \u21d4 docs \u2500\u2500\n');

// ── 1 ⇔ 2: the installer pre-check agrees with the playbook assertion ──
const playbook = read('ops/ansible/playbook.yml');
// The playbook must assert exactly the noble base (this is the gate the
// pre-check mirrors). If the playbook widens its support, this string changes
// and the smoke fails until the pre-check is updated to match.
check(
	'playbook asserts the noble base (morphit_ubuntu_codename == "noble")',
	/morphit_ubuntu_codename\s*==\s*"noble"/.test(playbook)
);
check('installer pre-check ACCEPTS the same base the playbook accepts (noble)', checkNobleBase('UBUNTU_CODENAME=noble\n').ok);
check('installer pre-check REJECTS jammy, exactly as the playbook would', !checkNobleBase('UBUNTU_CODENAME=jammy\n').ok);
check(
	'installer pre-check REJECTS a Debian base (no UBUNTU_CODENAME), as the playbook would',
	!checkNobleBase('ID=debian\nVERSION_ID="12"\n').ok
);

// The playbook's fail_msg and the installer guidance must recommend the SAME
// upgrade target (24.04), so a box gets one consistent instruction wherever the
// gate trips.
check('playbook fail_msg names Ubuntu 24.04', /Ubuntu 24\.04/.test(playbook));
check('installer guidance names Ubuntu 24.04', /Ubuntu 24\.04/.test(NOBLE_ONLY_GUIDANCE));
check(
	'both name the same noble-based derivatives',
	/Linux Mint 22/.test(playbook) &&
		/Pop!_OS 24\.04/.test(playbook) &&
		/Linux Mint 22/.test(NOBLE_ONLY_GUIDANCE) &&
		/Pop!_OS 24\.04/.test(NOBLE_ONLY_GUIDANCE)
);

// ── 3: the run-a-node guide doesn't sell 22.04 on the one-command path ──
const guide = read('docs/RUN-A-MORPHIT-NODE.md');
check('run-a-node guide names Ubuntu 24.04 as the target', /Ubuntu 24\.04/.test(guide));
check(
	'run-a-node guide does NOT claim "22.04 or 24.04" for the one-command path',
	!/22\.04 or 24\.04/.test(guide) && !/Ubuntu\*\* \(22\.04/.test(guide)
);

// ── boundary: systemCheck stays advisory (manual-install support intact) ──
const systemCheck = read('apps/ops-cli/src/init/systemCheck.ts');
// classifyOs must still green-light a Debian/derivative OS as a usable server
// (status 'ok' for the derivative path) — it must NOT have been turned into a
// hard noble-only gate. We assert the Kicksecure/derivative "Debian-based" ok
// branch is still present.
check(
	'systemCheck still recognises Ubuntu/Debian derivatives (manual-install path intact)',
	/Debian-based/.test(systemCheck) && /derivative/.test(systemCheck)
);
check(
	'the noble hard-gate lives in the installer, not systemCheck (no classifyOs noble-only block)',
	!/classifyOs[\s\S]{0,400}only[\s\S]{0,40}noble/.test(systemCheck)
);

const total = pass + fails.length;
console.log('');
if (fails.length > 0) {
	console.log(`  \u2717 ${fails.length} of ${total} os-support-parity checks FAILED`);
	for (const f of fails) console.log(`      - ${f}`);
	process.exit(1);
}
console.log(`\u2713 all ${total} os-support-parity scenarios passed`);
