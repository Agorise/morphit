#!/usr/bin/env tsx
/**
 * apps/indexer/scripts/snapshot-verify-oplog.ts  (cp767)
 *
 * Tier-2 snapshot hardening — the RUNNER.
 *
 * After a federated restore, spot-check that the snapshot's `ops` log (the
 * source of truth every view is derived from) genuinely matches the CHAIN.
 * Samples applied ops across the pre-tail range (preferring order/content ops
 * that carry a permlink), fetches each sampled block from the pool, and confirms
 * the recorded op is really there at its recorded position (see
 * snapshotOplogVerify.ts). If ANY sampled op is absent/altered on-chain, the
 * snapshot fabricated data → exit non-zero (QUARANTINE): the operator should wipe
 * and full-replay. All-pass ⇒ high confidence the derived state is authentic.
 *
 * Invoked automatically by snapshot-bootstrap.ts --from-chain (unless
 * --skip-verify). Also runnable standalone:
 *   set -a; . /etc/morphit/indexer.env; set +a
 *   node_modules/.bin/tsx --tsconfig tsconfig.smoke.json \
 *     apps/indexer/scripts/snapshot-verify-oplog.ts [--samples 40] [--up-to <block>]
 *
 * Exit 0 = verified. Exit 3 = QUARANTINE (a sampled op is not on the chain as
 * recorded). Exit 2 = inconclusive (chain unreachable, or nothing to sample) —
 * treated as NOT verified. Any other code (a crash) is inconclusive too.
 *
 * v1.18.0 deep-deep (rv2-6): quarantine used to be exit 1 — the same code Node
 * uses for an uncaught startup error, so a script that could not even load read
 * as "this snapshot is fabricated". And an empty ops log exited 0, "verified",
 * when nothing had been checked at all.
 */
import { loadConfig } from '../src/config/index.ts';
import { createDatabase } from '../src/db/pool.ts';
import { BlurtClient } from '../src/blurt/client.ts';
import {
	pickVerificationSample,
	verifyStoredOpAgainstBlock,
	type StoredOpRef
} from '../src/db/snapshotOplogVerify.ts';

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
	const blurt = new BlurtClient(config);

	try {
		// Candidate pool: applied ops in the pre-tail range. Pull a generous
		// candidate set (permlink-bearing first) and let the pure sampler spread it.
		const upperClause = upTo !== undefined ? 'AND block_num <= $2' : '';
		const params: unknown[] = [config.startBlock];
		if (upTo !== undefined) params.push(upTo);
		const res = await db.query<{
			block_num: string;
			trx_in_block: number;
			op_in_trx: number;
			signer: string;
			op_id: string;
			permlink: string | null;
		}>(
			`SELECT block_num::text, trx_in_block, op_in_trx, signer, op_id,
			        (payload->>'permlink') AS permlink
			   FROM ops
			  WHERE status = 'applied' AND block_num >= $1 ${upperClause}
			  ORDER BY (payload->>'permlink') IS NOT NULL DESC, block_num
			  LIMIT 5000`,
			params
		);
		const rows: StoredOpRef[] = res.rows.map((r) => ({
			blockNum: parseInt(r.block_num, 10),
			trxInBlock: r.trx_in_block,
			opInTrx: r.op_in_trx,
			signer: r.signer,
			opId: r.op_id,
			permlink: r.permlink
		}));

		if (rows.length === 0) {
			// rv2-6: nothing sampled is not a pass. A restored snapshot always has
			// applied ops; an empty log proves nothing about the rest of the data.
			process.stderr.write(
				'snapshot-verify-oplog: no applied ops in range — nothing could be checked, so this is\n' +
					'  INCONCLUSIVE, not a pass.\n'
			);
			process.exit(2);
		}

		const sample = pickVerificationSample(rows, samples);
		process.stderr.write(
			`snapshot-verify-oplog: checking ${sample.length} sampled ops against the chain ` +
				`(pool ${rows.length}, blocks ${sample[0]!.blockNum.toLocaleString()}–${sample[sample.length - 1]!.blockNum.toLocaleString()})…\n`
		);

		// Group by block so we fetch each block once.
		const byBlock = new Map<number, StoredOpRef[]>();
		for (const r of sample) {
			const arr = byBlock.get(r.blockNum) ?? [];
			arr.push(r);
			byBlock.set(r.blockNum, arr);
		}

		let verified = 0;
		let unreachable = 0;
		const failures: string[] = [];
		for (const [blockNum, refs] of byBlock) {
			let block: unknown = null;
			try {
				block = await blurt.getBlock(blockNum);
			} catch (e) {
				unreachable++;
				process.stderr.write(`  ? block ${blockNum}: could not fetch (${errMsg(e)})\n`);
				continue;
			}
			if (!block) {
				unreachable++;
				process.stderr.write(`  ? block ${blockNum}: RPC returned no block\n`);
				continue;
			}
			for (const ref of refs) {
				const m = verifyStoredOpAgainstBlock(ref, block as never);
				if (m.ok) {
					verified++;
				} else {
					const perm = ref.permlink ? ` permlink=${ref.permlink}` : '';
					failures.push(`block ${blockNum} @${ref.signer} ${ref.opId}${perm}: ${m.reason}`);
				}
			}
		}

		// ── verdict (fail closed) ─────────────────────────────────
		if (failures.length > 0) {
			process.stderr.write(`\n  ✗ ${failures.length} sampled op(s) are NOT on the chain as recorded:\n`);
			for (const f of failures.slice(0, 20)) process.stderr.write(`      ${f}\n`);
			process.stderr.write(
				`\n  QUARANTINE: this snapshot's op log does not match the chain — it was fabricated or\n` +
					`  corrupted. Do NOT serve from it. Wipe the DB and full-replay:\n` +
					`      set MORPHIT_INDEXER_START_BLOCK to genesis, then start the indexer.\n`
			);
			process.exit(3);
		}
		if (verified === 0) {
			process.stderr.write(
				`\n  ? could not verify any sampled op (chain unreachable for all ${unreachable} sampled block(s)).\n` +
					`  This is INCONCLUSIVE, not a pass. Re-run when the pool is reachable.\n`
			);
			process.exit(2);
		}
		const note = unreachable > 0 ? ` (${unreachable} block(s) unreachable, skipped)` : '';
		process.stderr.write(`\n  ✓ all ${verified} sampled ops verified on-chain${note}. Snapshot op log matches the chain.\n`);
		process.exit(0);
	} finally {
		await db.close();
	}
}

main().catch((e) => {
	console.error('snapshot-verify-oplog failed:', errMsg(e));
	process.exit(2);
});
