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
 *     account-creating op for that name in their recorded block, by their
 *     recorded creator, at their recorded creation time (the creator is
 *     what Signal A compares in the fee-attestation quorum).
 *   - waiver_trade_transfers (v70): rows drawn at random must each be, in a
 *     block read with agreement (BlurtClient.condenserAgreed, the trusted
 *     quorum), a transfer at their recorded position, in the transaction with
 *     their recorded id (recomputed from its content), from their sender to
 *     their recipient, of their amount (at least the minimum), at their block
 *     time (at or after the consensus activation time) — and the recipient
 *     must hold a first-buy waiver order posted at or before it. A row is evidence a review can be admitted on
 *     (reviewCitation.ts), so a planted one is what this looks for. Whether a
 *     row is the pair's EARLIEST transfer is not checked (that needs the
 *     account history): a real but later transfer can only make a review
 *     refused, never admit one.
 *
 * Verdict (oplogVerdict): any mismatch → 'quarantine'; fewer than
 * MIN_VERIFIED_FRACTION of the sample actually checked (chain unreachable) →
 * 'inconclusive'; else 'verified'. A pass means every sampled row matched: it
 * lowers the odds of fabricated data, it does not prove there is none.
 */
import type { Database } from '$db/pool';
import { transactionIdOf } from '$blurt/snapshotOpTrust';
import { blockTimeOf } from '$indexer/blockTime';
import { parseBlurtMilli } from '$indexer/fee';
import { WAIVER_TRADE_MIN_TRANSFER_BLURT } from '$indexer/waiverTradeTransfers';
import { consensusV2Active } from '$indexer/consensusActivation';
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
	readonly chain: {
		getBlock(n: number): Promise<unknown>;
		/** BlurtClient's agreed read, for the rows checked against an agreed
		 *  block (waiver_trade_transfers). Without it those use getBlock. */
		condenserAgreed?<T>(
			method: string,
			params: readonly unknown[],
			keyOf: (answer: T) => string | null,
			minAgree: number
		): Promise<{ readonly value: T; readonly key: string } | null>;
		trustedQuorumSize?(): number;
	};
	/** Lowest block the ops sample may come from. */
	readonly startBlock: number;
	/** Highest block the ops sample may come from (all when undefined). */
	readonly upTo?: number;
	readonly samples: number;
	readonly randomInt: RandomInt;
	/** Progress lines. */
	readonly say: (line: string) => void;
	/** Called before each chain read: "block 3 of 41", then "account 1 of 10".
	 *  The reads take minutes over a pool with slow or dead nodes, and without
	 *  this nothing moved on screen (2026-10-12). */
	readonly progress?: (where: string) => void;
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

/** A waiver_trade_transfers row as the check reads it. */
export interface WaiverRow {
	readonly recipient: string;
	readonly sender: string;
	readonly block_num: string;
	readonly trx_in_block: number;
	readonly op_in_trx: number;
	readonly block_time: Date;
	readonly trx_id: string;
	/** NUMERIC(18,3) as Postgres returns it, e.g. '2750.125'. */
	readonly amount_blurt: string;
}

/** The transaction and operation a row names, in an answer to get_block. */
function rowTarget(
	row: Pick<WaiverRow, 'trx_in_block' | 'op_in_trx'>,
	block: unknown
): { tx: unknown; op: unknown; timestamp: unknown } | null {
	const b = block as { timestamp?: unknown; transactions?: unknown } | null;
	if (!b || !Array.isArray(b.transactions)) return null;
	const tx = b.transactions[row.trx_in_block] as { operations?: unknown } | undefined;
	if (!tx || !Array.isArray(tx.operations)) return null;
	return { tx, op: tx.operations[row.op_in_trx], timestamp: b.timestamp };
}

/** What operators must agree on for one row's block: its time, and the id of
 *  the transaction at the row's position, RECOMPUTED from its content (so
 *  agreeing on it is agreeing on the transfer inside). An answer without a
 *  transaction there, or one whose id cannot be computed, does not count. */
export function waiverRowBlockKey(row: WaiverRow, block: unknown): string | null {
	const t = rowTarget(row, block);
	if (t === null || typeof t.timestamp !== 'string') return null;
	const id = transactionIdOf(t.tx);
	return id === null ? null : `${t.timestamp}|${id}`;
}

/** Is `row` the transfer at its recorded position in `block`? PURE; fails
 *  closed. (Whether the recipient holds a waiver order is the database's
 *  question, asked by the caller.) */
export function verifyWaiverRowAgainstBlock(
	row: WaiverRow,
	block: unknown
): { ok: true } | { ok: false; reason: string } {
	const t = rowTarget(row, block);
	if (t === null) return { ok: false, reason: 'no transaction at the recorded position' };
	if (transactionIdOf(t.tx) !== row.trx_id) {
		return { ok: false, reason: 'the transaction there is not the recorded one' };
	}
	const op = t.op as [unknown, Record<string, unknown>] | undefined;
	if (!Array.isArray(op) || op[0] !== 'transfer' || !op[1]) {
		return { ok: false, reason: 'no transfer at the recorded position' };
	}
	if (op[1].from !== row.sender || op[1].to !== row.recipient) {
		return { ok: false, reason: `the transfer is ${String(op[1].from)} → ${String(op[1].to)}` };
	}
	const milli = typeof op[1].amount === 'string' ? parseBlurtMilli(op[1].amount) : null;
	const recorded = parseBlurtMilli(`${row.amount_blurt} BLURT`);
	if (milli === null || milli !== recorded) {
		return { ok: false, reason: `the transfer is ${String(op[1].amount)}` };
	}
	if (milli < WAIVER_TRADE_MIN_TRANSFER_BLURT * 1000) {
		return { ok: false, reason: 'below the minimum a row may hold' };
	}
	// Nothing stamped before the consensus activation time is ever recorded
	// (waiverTradeTransfers.ts).
	const rowBlockTime = row.block_time;
	if (!consensusV2Active(rowBlockTime)) {
		return { ok: false, reason: 'stamped before the consensus activation time' };
	}
	if (
		typeof t.timestamp !== 'string' ||
		blockTimeOf(t.timestamp).getTime() !== row.block_time.getTime()
	) {
		return { ok: false, reason: `the block's time is ${String(t.timestamp)}` };
	}
	return { ok: true };
}
const errMsg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function checkSnapshotAgainstChain(
	deps: SnapshotCheckDeps
): Promise<SnapshotCheckResult> {
	const { db, samples, upTo, randomInt, say } = deps;
	const progress = deps.progress ?? ((): void => undefined);
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
	let nth = 0;
	for (const [blockNum, refs] of byBlock) {
		sampled += refs.length;
		progress(`block ${++nth} of ${byBlock.size}`);
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
	const accountPicks = randomDistinctIndices(accountCount, derivedSample, randomInt);
	let nthAccount = 0;
	for (const i of accountPicks) {
		const a = (
			await db.query<{
				name: string;
				created_block_num: string;
				created_trx_id: string;
				creator: string;
				created_block_time: Date;
			}>(
				`SELECT name, created_block_num::text, created_trx_id, creator, created_block_time FROM accounts
				  WHERE created_block_num > 0 ORDER BY name OFFSET $1 LIMIT 1`,
				[i]
			)
		).rows[0];
		if (!a) continue;
		sampled++;
		progress(`account ${++nthAccount} of ${accountPicks.length}`);
		const block = await fetchBlock(Number(a.created_block_num));
		if (!block) {
			unreachable++;
			continue;
		}
		const m = verifyAccountCreatedInBlock(a.name, a.created_trx_id, block as never, {
			creator: a.creator,
			createdBlockTime: new Date(a.created_block_time)
		});
		if (m.ok) verified++;
		else failures.push(`accounts row ${a.name} (block ${a.created_block_num}): ${m.reason}`);
	}

	// ── waiver_trade_transfers: each sampled row is that transfer, agreed ──
	const hasWaiver = await db.query<{ t: string | null }>(
		`SELECT to_regclass('waiver_trade_transfers')::text AS t`
	);
	// Only when the RESTORED schema is at v70. A pre-v70 snapshot restored over
	// a v70 database leaves this node's own rows behind (a restore drops only
	// the tables in its dump), and they describe this node's orders, not the
	// snapshot's — so they are not the snapshot's to be judged by. The v70
	// migration then runs again on the next start and empties the table.
	const restoredAtV70 =
		hasWaiver.rows[0]?.t != null &&
		((await db.query(`SELECT 1 FROM schema_migrations WHERE version = 70`)).rowCount ?? 0) > 0;
	if (hasWaiver.rows[0]?.t != null && !restoredAtV70) {
		say(
			'  waiver_trade_transfers: not sampled (the snapshot predates schema v70; the table is emptied when v70 runs)'
		);
	}
	const waiverCount = !restoredAtV70
		? 0
		: Number(
				(await db.query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM waiver_trade_transfers`))
					.rows[0]?.n ?? '0'
			);
	const waiverPicks = randomDistinctIndices(waiverCount, derivedSample, randomInt);
	let nthWaiver = 0;
	for (const i of waiverPicks) {
		const w = (
			await db.query<WaiverRow>(
				`SELECT recipient, sender, block_num::text, trx_in_block, op_in_trx, block_time,
				        trx_id, amount_blurt::text
				   FROM waiver_trade_transfers ORDER BY recipient, sender OFFSET $1 LIMIT 1`,
				[i]
			)
		).rows[0];
		if (!w) continue;
		sampled++;
		progress(`waiver transfer ${++nthWaiver} of ${waiverPicks.length}`);
		const n = Number(w.block_num);
		let block: unknown = null;
		if (deps.chain.condenserAgreed && deps.chain.trustedQuorumSize) {
			try {
				const agreed = await deps.chain.condenserAgreed<unknown>(
					'get_block',
					[n],
					(b) => waiverRowBlockKey(w, b),
					deps.chain.trustedQuorumSize()
				);
				if (agreed === null) say(`  ? block ${n}: the RPC operators did not agree on it`);
				block = agreed?.value ?? null;
			} catch (e) {
				say(`  ? block ${n}: could not be read: ${errMsg(e)}`);
			}
		} else {
			block = await fetchBlock(n);
		}
		if (!block) {
			unreachable++;
			continue;
		}
		const m = verifyWaiverRowAgainstBlock(w, block);
		const owner = await db.query(
			`SELECT 1 FROM orders WHERE account = $1 AND fee_method = 'waived_first_buy'
			   AND created_at <= $2 LIMIT 1`,
			[w.recipient, w.block_time]
		);
		const where = `waiver_trade_transfers row ${w.sender} → ${w.recipient} (block ${n})`;
		if (!m.ok) failures.push(`${where}: ${m.reason}`);
		else if ((owner.rowCount ?? 0) === 0)
			failures.push(`${where}: the recipient holds no waiver order posted by then`);
		else verified++;
	}

	return {
		verdict: oplogVerdict({ sampled, verified, failures: failures.length }),
		sampled,
		verified,
		unreachable,
		failures
	};
}
