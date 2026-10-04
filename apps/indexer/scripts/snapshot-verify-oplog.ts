#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/snapshot-verify-oplog.ts
 *
 * Tier-2 snapshot hardening — the RUNNER.
 *
 * After a federated restore, spot-check the snapshot against the CHAIN — the
 * op log, sampled `orders` and `accounts` rows (src/indexer/snapshotChainCheck.ts).
 * Any mismatch → exit 3 (QUARANTINE): the operator should wipe and full-replay.
 *
 * It is a spot check. A pass means every sampled row matched the chain; it
 * lowers the odds that the snapshot carries fabricated data, it does not prove
 * there is none. Reads go through the service's router (bootChainClient.ts),
 * so a hidden-only node checks over Tor/I2P and never asks the system resolver
 * for a hidden name.
 *
 * Invoked automatically by snapshot-bootstrap.ts --from-chain (unless
 * --skip-verify). Also runnable standalone:
 *   set -a; . /etc/morphit/indexer.env; set +a
 *   node_modules/.bin/tsx --tsconfig tsconfig.smoke.json \
 *     apps/indexer/scripts/snapshot-verify-oplog.ts [--samples 40] [--up-to <block>]
 *
 * Exit 0 = every sampled row matched, and at least MIN_VERIFIED_FRACTION of
 * the sample could be checked. Exit 3 = QUARANTINE. Exit 2 = inconclusive
 * (too much of the chain unreachable, or nothing to sample) — treated as NOT
 * verified. Any other code (a crash) is inconclusive too.
 */
import { randomInt } from 'node:crypto';
import { loadConfig } from '../src/config/index.ts';
import { createDatabase } from '../src/db/pool.ts';
import { MIN_VERIFIED_FRACTION } from '../src/db/snapshotOplogVerify.ts';
import { bootChainClient } from '../src/indexer/bootChainClient.ts';
import { checkSnapshotAgainstChain } from '../src/indexer/snapshotChainCheck.ts';

function flag(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function main(): Promise<void> {
	const samples = Math.max(1, Math.min(500, parseInt(flag('samples') ?? '40', 10) || 40));
	const upTo = flag('up-to') ? parseInt(flag('up-to')!, 10) : undefined;

	const config = loadConfig();
	const db = createDatabase(config);
	const chain = bootChainClient(config);
	try {
		const r = await checkSnapshotAgainstChain({
			db,
			chain,
			startBlock: config.startBlock,
			...(upTo !== undefined ? { upTo } : {}),
			samples,
			randomInt,
			say: (line) => process.stderr.write(`${line}\n`)
		});
		if (r.verdict === 'quarantine') {
			process.stderr.write(`\n  ✗ ${r.failures.length} sampled row(s) do NOT match the chain:\n`);
			for (const f of r.failures.slice(0, 20)) process.stderr.write(`      ${f}\n`);
			process.stderr.write(
				`\n  QUARANTINE: this snapshot does not match the chain — it was fabricated or\n` +
					`  corrupted. Do NOT serve from it. Wipe the DB and full-replay:\n` +
					`      set MORPHIT_INDEXER_START_BLOCK to genesis, then start the indexer.\n`
			);
			process.exit(3);
		}
		if (r.verdict === 'inconclusive') {
			process.stderr.write(
				`\n  ? only ${r.verified} of ${r.sampled} sampled rows could be checked (${r.unreachable} unreachable);\n` +
					`  at least ${Math.round(MIN_VERIFIED_FRACTION * 100)}% must be. This is INCONCLUSIVE, not a pass.\n` +
					`  Re-run when the pool is reachable.\n`
			);
			process.exit(2);
		}
		const note = r.unreachable > 0 ? ` (${r.unreachable} unreachable, skipped)` : '';
		process.stderr.write(
			`\n  ✓ all ${r.verified} checked rows match the chain${note}. This is a spot check of a random\n` +
				`  sample: it lowers the odds of fabricated data in this snapshot, it does not rule it out.\n`
		);
		process.exit(0);
	} finally {
		await db.close();
	}
}

main().catch((e) => {
	console.error('snapshot-verify-oplog failed:', errMsg(e));
	process.exit(2);
});
