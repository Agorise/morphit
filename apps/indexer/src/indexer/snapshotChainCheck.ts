/**
 * Morphit indexer — Tier-2 snapshot check: a restored snapshot, spot-checked
 * against the chain. Run by scripts/snapshot-verify-oplog.ts (automatically
 * after a fast-sync restore).
 *
 * What is sampled:
 *   - ops: the newest quarter of the sample (the live-order tail, where a
 *     forged listing pays off) plus the first applied op at or after block
 *     heights drawn with a CSPRNG across the whole range. Each must be on the
 *     chain at its recorded position, with its op id, signer and permlink.
 *     (It used to take the OLDEST 5,000 ops and spread a fixed, predictable
 *     sample over them: anything newer, or off the fixed grid, was never
 *     looked at.)
 *   - orders: rows drawn at random must each have the applied order op that
 *     created them; that op is then checked on the chain like the others. A
 *     forged `orders` row with no op behind it used to pass, since only the
 *     op log was ever compared.
 *   - accounts: chain-created rows drawn at random must each have an
 *     account-creating op for that name in their recorded block.
 *
 * Verdict (oplogVerdict): any mismatch → 'quarantine'; fewer than
 * MIN_VERIFIED_FRACTION of the sample actually checked (chain unreachable) →
 * 'inconclusive'; else 'verified'. A pass means every sampled row matched: it
 * lowers the odds of fabricated data, it does not prove there is none.
 */
import type { Database } from '$db/pool';
import {
	newestShare,
	oplogVerdict,
	pickBlockTargets,
	randomDistinctIndices,
	verifyAccountCreatedInBlock,
	verifyStoredOpAgainstBlock,
	type OplogVerdict,
	type RandomInt,
	type StoredOpRef
} from '$db/snapshotOplogVerify';

export interface SnapshotCheckDeps {
	readonly db: Pick<Database, 'query'>;
	readonly chain: { getBlock(n: number): Promise<unknown> };
	/** Lowest block the ops sample may come from. */
	readonly startBlock: number;
	/** Highest block the ops sample may come from (all when undefined). */
	readonly upTo?: number;
	readonly samples: number;
	readonly randomInt: RandomInt;
	/** Progress lines. */
	readonly say: (line: string) => void;
}

export interface SnapshotCheckResult {
	readonly verdict: OplogVerdict;
	readonly sampled: number;
	readonly verified: number;
	readonly unreachable: number;
	readonly failures: readonly string[];
}

interface OpRow {
	block_num: string;
	trx_in_block: number;
	op_in_trx: number;
	signer: string;
	op_id: string;
	permlink: string | null;
}

const OP_COLS = `block_num::text, trx_in_block, op_in_trx, signer, op_id, (payload->>'permlink') AS permlink`;

const toRef = (r: OpRow): StoredOpRef => ({
	blockNum: parseInt(r.block_num, 10),
	trxInBlock: r.trx_in_block,
	opInTrx: r.op_in_trx,
	signer: r.signer,
	opId: r.op_id,
	permlink: r.permlink
});
const refKey = (r: StoredOpRef): string => `${r.blockNum}:${r.trxInBlock}:${r.opInTrx}`;
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function checkSnapshotAgainstChain(
	deps: SnapshotCheckDeps
): Promise<SnapshotCheckResult> {
	const { db, samples, upTo, randomInt, say } = deps;
	const upper = upTo !== undefined ? 'AND block_num <= $2' : '';
	const bounded = (lowest: number): unknown[] => [lowest, ...(upTo !== undefined ? [upTo] : [])];
	const opsToCheck = new Map<string, StoredOpRef>();
	const failures: string[] = [];
	const add = (r: StoredOpRef): void => void opsToCheck.set(refKey(r), r);

	// ── ops: the newest share, then CSPRNG block heights over the range ──
	const newest = await db.query<OpRow>(
		`SELECT ${OP_COLS} FROM ops
		  WHERE status = 'applied' AND block_num >= $1 ${upper}
		  ORDER BY block_num DESC, trx_in_block DESC, op_in_trx DESC
		  LIMIT ${newestShare(samples)}`,
		bounded(deps.startBlock)
	);
	newest.rows.map(toRef).forEach(add);
	const bounds = await db.query<{ lo: string | null; hi: string | null }>(
		`SELECT MIN(block_num)::text AS lo, MAX(block_num)::text AS hi FROM ops
		  WHERE status = 'applied' AND block_num >= $1 ${upper}`,
		bounded(deps.startBlock)
	);
	const lo = bounds.rows[0]?.lo;
	const hi = bounds.rows[0]?.hi;
	if (lo != null && hi != null) {
		for (const t of pickBlockTargets(
			Number(lo),
			Number(hi),
			samples - newestShare(samples),
			randomInt
		)) {
			const r = await db.query<OpRow>(
				`SELECT ${OP_COLS} FROM ops
				  WHERE status = 'applied' AND block_num >= $1 ${upper}
				  ORDER BY block_num, trx_in_block, op_in_trx LIMIT 1`,
				bounded(t)
			);
			if (r.rows[0]) add(toRef(r.rows[0]));
		}
	}

	// ── orders: every sampled row must come from an applied order op ──
	const derivedSample = Math.max(5, Math.floor(samples / 4));
	const orderCount = Number(
		(await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM orders`)).rows[0]?.n ?? '0'
	);
	for (const i of randomDistinctIndices(orderCount, derivedSample, randomInt)) {
		const o = (
			await db.query<{ account: string; permlink: string }>(
				`SELECT account, permlink FROM orders ORDER BY account, permlink OFFSET $1 LIMIT 1`,
				[i]
			)
		).rows[0];
		if (!o) continue;
		const src = (
			await db.query<OpRow>(
				`SELECT ${OP_COLS} FROM ops
				  WHERE status = 'applied' AND op_id = 'morphit_order_v1'
				    AND signer = $1 AND payload->>'permlink' = $2
				  ORDER BY block_num, trx_in_block, op_in_trx LIMIT 1`,
				[o.account, o.permlink]
			)
		).rows[0];
		if (src) add(toRef(src));
		else failures.push(`orders row ${o.account}/${o.permlink}: no applied order op created it`);
	}

	const sampledOps = [...opsToCheck.values()].sort((a, b) => a.blockNum - b.blockNum);
	say(
		`snapshot check: ${sampledOps.length} sampled ops and up to ${derivedSample} accounts against the chain…`
	);

	let sampled = 0;
	let verified = 0;
	let unreachable = 0;
	const fetchBlock = async (n: number): Promise<unknown> => {
		try {
			const b = await deps.chain.getBlock(n);
			if (!b) say(`  ? block ${n}: RPC returned no block`);
			return b ?? null;
		} catch (e) {
			say(`  ? block ${n}: could not be read: ${errMsg(e)}`);
			return null;
		}
	};

	// Group by block so each block is fetched once.
	const byBlock = new Map<number, StoredOpRef[]>();
	for (const r of sampledOps) byBlock.set(r.blockNum, [...(byBlock.get(r.blockNum) ?? []), r]);
	for (const [blockNum, refs] of byBlock) {
		sampled += refs.length;
		const block = await fetchBlock(blockNum);
		if (!block) {
			unreachable += refs.length;
			continue;
		}
		for (const ref of refs) {
			const m = verifyStoredOpAgainstBlock(ref, block as never);
			if (m.ok) verified++;
			else
				failures.push(
					`block ${blockNum} @${ref.signer} ${ref.opId}${ref.permlink ? ` permlink=${ref.permlink}` : ''}: ${m.reason}`
				);
		}
	}

	// ── accounts: chain-created rows must be created in their block ──
	const accountCount = Number(
		(
			await db.query<{ n: string }>(
				`SELECT COUNT(*)::text AS n FROM accounts WHERE created_block_num > 0`
			)
		).rows[0]?.n ?? '0'
	);
	for (const i of randomDistinctIndices(accountCount, derivedSample, randomInt)) {
		const a = (
			await db.query<{ name: string; created_block_num: string; created_trx_id: string }>(
				`SELECT name, created_block_num::text, created_trx_id FROM accounts
				  WHERE created_block_num > 0 ORDER BY name OFFSET $1 LIMIT 1`,
				[i]
			)
		).rows[0];
		if (!a) continue;
		sampled++;
		const block = await fetchBlock(Number(a.created_block_num));
		if (!block) {
			unreachable++;
			continue;
		}
		const m = verifyAccountCreatedInBlock(a.name, a.created_trx_id, block as never);
		if (m.ok) verified++;
		else failures.push(`accounts row ${a.name} (block ${a.created_block_num}): ${m.reason}`);
	}

	return {
		verdict: oplogVerdict({ sampled, verified, failures: failures.length }),
		sampled,
		verified,
		unreachable,
		failures
	};
}
