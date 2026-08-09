#!/usr/bin/env tsx
/**
 * ansible-offline-apt-gate — cp679.
 *
 * The offline bundle redirects apt to a bundled local repo so an air-gapped box
 * can install with no network. But that redirect makes Linux Mint's Update
 * Manager report "Please switch to another Linux Mint mirror / Your APT
 * configuration is corrupt" for the whole install — which is fine air-gapped but
 * needlessly alarming for an ONLINE operator installing from the same bundle.
 *
 * Invariant guarded here: the vendor role probes whether the apt mirrors are
 * reachable and only redirects apt when the box is genuinely offline (bundle
 * present AND mirrors unreachable) — never on a box that can reach its mirrors.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const vendor = readFileSync(join(REPO, 'ops/ansible/roles/vendor/tasks/main.yml'), 'utf8');

let passed = 0;
let failed = 0;
const check = (name: string, cond: boolean, detail = ''): void => {
	if (cond) {
		console.log(`  ✓ ${name}`);
		passed++;
	} else {
		console.log(`  ✗ ${name}${detail ? `: ${detail}` : ''}`);
		failed++;
	}
};

console.log('\n── ansible-offline-apt-gate (cp679) ───────────────────\n');

check(
	'vendor role probes apt-mirror reachability',
	/morphit_apt_mirror_probe/.test(vendor) && /ansible\.builtin\.uri/.test(vendor),
	'must test connectivity before deciding to redirect apt'
);
check(
	'a morphit_use_bundled_apt decision fact exists',
	/morphit_use_bundled_apt/.test(vendor)
);
check(
	'the decision requires BOTH a bundle present AND mirrors unreachable',
	/morphit_vendor_apt\.stat\.exists[\s\S]{0,120}morphit_apt_mirror_probe\.status[\s\S]{0,40}not in/.test(vendor)
);
check(
	'the apt-redirect block is gated on morphit_use_bundled_apt (NOT merely bundle presence)',
	/when:\s*morphit_use_bundled_apt \| bool[\s\S]{0,40}block:/.test(vendor),
	'redirect must not fire on an online box'
);
// negative: the redirect block must NOT be gated only on stat.exists anymore
const redirectOnStatOnly =
	/- name: Offline apt — redirect[\s\S]{0,80}when:\s*morphit_vendor_apt\.stat\.exists\s*\n\s*block:/.test(vendor);
check('the redirect is no longer gated on bundle-presence alone', !redirectOnStatOnly);

console.log(
	`\n${passed} passed, ${failed} failed\n${failed === 0 ? `✓ all ${passed} offline-apt-gate checks passed` : '✗ ansible-offline-apt-gate FAILED'}`
);
process.exit(failed === 0 ? 0 : 1);
