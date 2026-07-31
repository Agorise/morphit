#!/usr/bin/env tsx
/**
 * scripts/canary-setup-smoke.ts
 *
 * cp614 — the warrant-canary setup used to be a hand-rolled script living only
 * on the operator's laptop, so every new operator had to reinvent it. It now
 * ships in the repo as scripts/canary/setup.sh: one guided command that works
 * for BOTH a remote VPS (sign on your laptop, upload) and a home box (sign +
 * serve locally), offers to create a PGP key for operators who have none, and
 * arms a weekly refresh. This smoke locks in the pieces that make it work for
 * everyone and stay correct against the cp431 build/ lifecycle:
 *
 *   - the script exists, is executable, and asks which deployment you have;
 *   - it can create + publish a signing key (grandma has none);
 *   - the weekly refresh it writes delivers the signed canary into the SERVED
 *     apps/web/build/ dir (NOT static/) — locally by copy, remotely by upload;
 *   - it installs a weekly timer (systemd) with a cron fallback; and
 *   - morphit-ops points operators at it (init next-steps + upgrade reminder).
 */

import { readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');

console.log('\n── canary setup smoke ─────────────────────────────────\n');

let pass = 0;
const fails: string[] = [];
function check(desc: string, ok: boolean): void {
	if (ok) {
		pass++;
		console.log(`  ✓ ${desc}`);
	} else {
		fails.push(desc);
		console.log(`  ✗ ${desc}`);
	}
}

const setupPath = join(REPO, 'scripts/canary/setup.sh');
const setup = readFileSync(setupPath, 'utf8');
const initTs = readFileSync(join(REPO, 'apps/ops-cli/src/commands/init.ts'), 'utf8');
const upgradeTs = readFileSync(join(REPO, 'apps/ops-cli/src/commands/upgrade.ts'), 'utf8');

// ─── the script exists + is runnable ─────────────────────────────
check('setup.sh is executable', (statSync(setupPath).mode & 0o111) !== 0);
check('setup.sh is a bash script', /^#!.*\bbash\b/.test(setup));

// ─── works for BOTH deployments ──────────────────────────────────
check(
	'asks which deployment (home box vs remote server)',
	/Where does your Morphit instance run\?/.test(setup)
);
check('handles a LOCAL (home-hosting) mode', /MODE=local\b/.test(setup));
check('handles a REMOTE (VPS) mode', /MODE=remote\b/.test(setup));

// ─── grandma has no key: offer to make one, publish the public half ─
check('offers to CREATE a signing key when none exists', /--quick-generate-key/.test(setup));
check(
	'publishes the PUBLIC key to the served pgp_keys.asc',
	/gpg\s+--armor\s+--export[^\n]*pgp_keys\.asc/.test(setup) ||
		(/gpg --armor --export/.test(setup) && /pgp_keys\.asc/.test(setup))
);

// ─── the weekly refresh delivers to the SERVED build/ dir (cp431) ─
check('the refresh runs generate.sh to sign a fresh canary', /scripts\/canary\/generate\.sh/.test(setup));
check(
	'LOCAL mode places the canary into the served apps/web/build/ (not static/)',
	/apps\/web\/build[^\n]*canary\.txt/.test(setup) || /DEST=[^\n]*apps\/web\/build/.test(setup)
);
check(
	'REMOTE mode uploads the canary into the served apps/web/build/ over scp',
	/scp[\s\S]*apps\/web\/build\/canary\.txt/.test(setup)
);
check(
	'both modes also deliver pgp_keys.asc alongside the canary',
	/build\/pgp_keys\.asc|pgp_keys\.asc"?\s*$/m.test(setup) &&
		setup.includes('pgp_keys.asc')
);

// ─── automation: a weekly timer, with a cron fallback ────────────
check('installs a weekly systemd timer', /systemctl\s+--user/.test(setup) && /OnCalendar=Sun/.test(setup));
check('falls back to a weekly cron line when systemd is unavailable', /14 3 \* \* 0/.test(setup));

// ─── honours the OFF-SERVER signing model (OPERATIONS §36) ───────
check(
	'explains the strongest canary signs on a SEPARATE machine from the server',
	/separate (machine|computer)/i.test(setup) && /(seiz|forge)/i.test(setup)
);

// ─── morphit-ops points operators at it ──────────────────────────
check('morphit-ops init next-steps points at scripts/canary/setup.sh', initTs.includes('scripts/canary/setup.sh'));
check(
	'morphit-ops upgrade reminder points at the refresh script',
	upgradeTs.includes('update-canary.sh')
);

// ─── verdict ─────────────────────────────────────────────────────
const total = pass + fails.length;
console.log('\n──────────────────────────────────────────────────────');
if (fails.length > 0) {
	console.log(`✗ ${fails.length} of ${total} canary-setup checks FAILED`);
	process.exit(1);
}
console.log(`✓ all ${total} canary-setup scenarios passed`);
