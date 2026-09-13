#!/usr/bin/env tsx
/**
 * apps/ops-cli/scripts/publish-path-execution-smoke.ts
 *
 * Runs ops/test/pin-indexer-snapshot-harness.sh, which EXECUTES the snapshot
 * publish script against stub kubo/systemd binaries.
 *
 * This exists because in one evening the publish path produced seven
 * production-only failures — missing execute bit, swallowed stderr, a
 * cross-device rename under PrivateTmp, sudo refusing to run under
 * NoNewPrivileges, an unset IPFS_PATH, discarded child output, and a probe with
 * no retry against a daemon the script itself restarts. Every single one was
 * green in the 130-odd text-matching assertions that already covered this code,
 * because all of them read the file and none of them ran it.
 *
 * So: run it. The harness is hermetic (temp dir, stub binaries on PATH, no
 * daemon, no network, no root) and each of the seven failures above has been
 * verified to make it fail.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const repo = join(import.meta.dirname, '..', '..', '..');
const harness = join(repo, 'ops', 'test', 'pin-indexer-snapshot-harness.sh');

if (!existsSync(harness)) {
	console.error(`✗ publish-path harness missing at ${harness}`);
	process.exit(1);
}

const r = spawnSync('bash', [harness], { encoding: 'utf8', timeout: 300_000 });
const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
process.stdout.write(out);

if (r.status !== 0) {
	console.error('\n✗ publish-path execution harness FAILED — the publish path does not run.');
	process.exit(1);
}

// Cheap sanity check that the harness actually did something, so a harness that
// silently no-ops can never be mistaken for a passing publish path.
const checks = (out.match(/✓/g) ?? []).length;
if (checks < 5) {
	console.error(`\n✗ harness reported only ${checks} checks — it is not exercising the publish path.`);
	process.exit(1);
}
// Final line follows the battery's convention: plain ASCII, starts with "✓ all ",
// no ANSI escapes. The harness colours its own output, and a coloured line does
// not match a runner looking for `^✓ all` — which showed up as a spurious
// failure in the battery while the harness itself passed standalone.
console.log(`✓ all ${checks} publish-path execution checks passed`);
