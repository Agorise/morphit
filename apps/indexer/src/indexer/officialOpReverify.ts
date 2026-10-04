/**
 * Morphit indexer — re-judge every stored release and rpc-directory op by its
 * signature, once, from a block RPC operators (counted by node name) agree on.
 *
 * WHY. Before officialOpTrust.ts, these two handlers trusted an op that merely
 * NAMED the official account, provided one RPC endpoint said that account's
 * key was the pinned one. So a node may hold:
 *   - a release recorded valid, or a directory merged and stored, that a
 *     hostile RPC node made up (unsigned) — a forged treasury pin, or attacker
 *     nodes counted as quorum operators;
 *   - a genuine release or directory op lost to an RPC blip at apply time
 *     (rejected `handler_threw:…`) or judged against whatever key the account
 *     held when it was applied (`pubkey_mismatch`) — so this node's treasury
 *     pin or RPC directory differs from its peers'.
 * The event log keeps no signatures, so the only way to re-judge is to read
 * the block again.
 *
 * WHAT IT DOES. For every official op not yet re-judged (`fee_reverify_done`,
 * the local one-shot bookkeeping table, keyed by the op's position):
 *   1. read its block from the RPC pool, agreed by trustedQuorumSize()
 *      operators, counted by node name (block id + the RECOMPUTED id of every
 *      transaction in it — a node cannot pair a real id with altered content);
 *   2. find the transaction whose recomputed id is the stored one. None: the
 *      op was never on chain — rejected `not_on_chain`, its release row made
 *      invalid, its directory row deleted;
 *   3. otherwise run the CURRENT handler on the op as the chain holds it, with
 *      the transaction (signatures and all), and record its verdict in place
 *      of the old one, exactly as a node applying the block today would.
 * When no quorum can be had the op is left for the next pass. Bounded per
 * pass; never throws.
 *
 * The newest valid release is the treasury pin in force; TreasurySource
 * re-reads it within its cache TTL and the poller rebuilds its fee verifiers. When any release
 * changed verdict, the per-order BTC address cache (btc_fee_address_log, a
 * pure function of ops + releases) is emptied so it is rebuilt.
 */
import type pg from 'pg';

import type { Database } from '$db/pool';
import type { BlockTransaction, BlurtClient } from '$blurt/client';
import type { Config } from '$config';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';
import { transactionIdOf } from '$blurt/snapshotOpTrust';
import { OP_IDS } from '$indexer/dispatcher';
import releaseHandler from '$indexer/handlers/release';
import rpcDirectoryHandler from '$indexer/handlers/rpcDirectory';
import { logger } from '$log';

const log = logger('official-op-reverify');

/** At most this many block reads per pass. */
export const MAX_BLOCK_READS_PER_PASS = 10;
/** Pause between passes while ops are waiting (a quorum was not had, or the
 *  budget ran out). */
export const BACKLOG_INTERVAL_MS = 60_000;
/** Pause between passes otherwise: new official ops are rare. */
export const INTERVAL_MS = 10 * 60_000;

const DONE_PREFIX = 'official_rejudged:';

type Chain = Pick<BlurtClient, 'condenserAgreed' | 'trustedQuorumSize' | 'mergeRpcEndpoints'>;

export interface OfficialReverifyDeps {
	readonly db: Pick<Database, 'query' | 'withTx'>;
	readonly blurt: Chain;
	readonly config: Config;
	readonly now?: () => number;
}

interface OpRow {
	readonly block_num: string;
	readonly trx_in_block: number;
	readonly op_in_trx: number;
	readonly block_time: Date;
	readonly trx_id: string;
	readonly signer: string;
	readonly op_id: string;
	readonly status: string;
	readonly reject_reason: string | null;
}

interface BlockLike {
	readonly block_id?: unknown;
	readonly timestamp?: unknown;
	readonly transactions?: unknown;
}

export interface OfficialReverifySummary {
	readonly checked: number;
	readonly changed: number;
	readonly unreachable: number;
	readonly backlog: boolean;
}

/** What operators (counted by node name) must agree on for a block: its id and the
 *  recomputed id of each transaction, in order. Null when the answer is not a
 *  block. */
export function blockContentKey(b: unknown): string | null {
	const blk = b as BlockLike | null;
	if (!blk || typeof blk !== 'object' || !Array.isArray(blk.transactions)) return null;
	const ids = (blk.transactions as unknown[]).map((t) => transactionIdOf(t) ?? '?');
	return `${typeof blk.block_id === 'string' ? blk.block_id : '?'}|${ids.join(',')}`;
}

const HANDLERS: Readonly<Record<string, Handler>> = {
	[OP_IDS.releaseDiscovery]: releaseHandler,
	[OP_IDS.rpcDirectory]: rpcDirectoryHandler
};

export class OfficialOpReverifier {
	private lastRunAt = Number.NEGATIVE_INFINITY;
	private backlog = true;

	constructor(private readonly deps: OfficialReverifyDeps) {}

	/** Self-throttling, never throws. */
	async maybeRun(): Promise<void> {
		const now = (this.deps.now ?? Date.now)();
		if (now - this.lastRunAt < (this.backlog ? BACKLOG_INTERVAL_MS : INTERVAL_MS)) return;
		this.lastRunAt = now;
		try {
			const s = await this.runOnce();
			this.backlog = s.backlog;
			if (s.checked + s.unreachable > 0) log.info('official_ops_rejudged', { ...s });
		} catch (err) {
			log.error('official_ops_rejudge_failed', {}, err instanceof Error ? err : undefined);
		}
	}

	/**
	 * One bounded pass, NEWEST first: the stored directory is one latest-wins
	 * row, so a forged newer op is removed before an older genuine one is
	 * re-applied into the empty slot (the handler never lets an older op
	 * overwrite a newer row). Releases are independent rows.
	 */
	async runOnce(): Promise<OfficialReverifySummary> {
		const { rows } = await this.deps.db.query<OpRow>(
			`SELECT o.block_num::text AS block_num, o.trx_in_block, o.op_in_trx, o.block_time,
			        o.trx_id, o.signer, o.op_id, o.status, o.reject_reason
			   FROM ops o
			  WHERE o.op_id = ANY($1::text[])
			    AND o.signer = $2
			    AND (o.reject_reason IS NULL OR o.reject_reason NOT IN ('invalid_text', 'malformed_json'))
			    AND NOT EXISTS (SELECT 1 FROM fee_reverify_done d
			                     WHERE d.block_num = o.block_num AND d.trx_in_block = o.trx_in_block
			                       AND d.op_in_trx = o.op_in_trx)
			  ORDER BY o.block_num DESC, o.trx_in_block DESC, o.op_in_trx DESC
			  LIMIT $3`,
			[
				[OP_IDS.releaseDiscovery, OP_IDS.rpcDirectory],
				this.deps.config.officialAccountName,
				MAX_BLOCK_READS_PER_PASS + 1
			]
		);
		let checked = 0;
		let changed = 0;
		let unreachable = 0;
		let releaseChanged = false;
		const blocks = new Map<string, BlockLike | null>();
		for (const row of rows.slice(0, MAX_BLOCK_READS_PER_PASS)) {
			let block = blocks.get(row.block_num);
			if (block === undefined) {
				block = await this.readAgreedBlock(Number(row.block_num));
				blocks.set(row.block_num, block);
			}
			if (block === null) {
				unreachable++;
				continue;
			}
			checked++;
			const verdict = await this.rejudge(row, block);
			if (verdict.changed) {
				changed++;
				if (row.op_id === OP_IDS.releaseDiscovery) releaseChanged = true;
				log.warn('official_op_verdict_changed', {
					block: row.block_num,
					op_id: row.op_id,
					was: row.reject_reason ?? row.status,
					now: verdict.outcome
				});
			}
		}
		if (releaseChanged) await this.deps.db.query('DELETE FROM btc_fee_address_log');
		return {
			checked,
			changed,
			unreachable,
			backlog: unreachable > 0 || rows.length > MAX_BLOCK_READS_PER_PASS
		};
	}

	private async readAgreedBlock(blockNum: number): Promise<BlockLike | null> {
		try {
			const agreed = await this.deps.blurt.condenserAgreed<BlockLike>(
				'get_block',
				[blockNum],
				blockContentKey,
				this.deps.blurt.trustedQuorumSize()
			);
			return agreed?.value ?? null;
		} catch {
			return null;
		}
	}

	/** Re-judge one op against the agreed block, in one transaction. */
	private async rejudge(
		row: OpRow,
		block: BlockLike
	): Promise<{ changed: boolean; outcome: string }> {
		const trxs = block.transactions as unknown[];
		const tx = trxs.find((t) => transactionIdOf(t) === row.trx_id) as BlockTransaction | undefined;
		const op = tx?.operations?.[row.op_in_trx] as
			| readonly [string, { id?: unknown; json?: unknown; required_posting_auths?: unknown }]
			| undefined;
		let payload: unknown = undefined;
		if (
			op !== undefined &&
			op[0] === 'custom_json' &&
			op[1]?.id === row.op_id &&
			typeof op[1]?.json === 'string'
		) {
			try {
				payload = JSON.parse(op[1].json);
			} catch {
				payload = undefined;
			}
		}
		const handler = HANDLERS[row.op_id];
		const isRelease = row.op_id === OP_IDS.releaseDiscovery;
		return this.deps.db.withTx(async (c) => {
			const before = isRelease ? await releaseVerdict(c, row.trx_id) : null;
			let result: HandlerResult;
			if (tx === undefined || payload === undefined || handler === undefined) {
				result = { ok: false, reason: 'not_on_chain' };
			} else {
				// The handler records the release afresh (ON CONFLICT DO NOTHING).
				if (isRelease) await c.query('DELETE FROM releases WHERE source_trx_id = $1', [row.trx_id]);
				result = await handler(this.ctxFor(row, payload, tx), c);
			}
			if (!result.ok) await forgetOp(c, row);
			const status = result.ok ? 'applied' : 'rejected';
			const reason = result.ok ? null : result.reason;
			await c.query(
				`UPDATE ops SET status = $4, reject_reason = $5
				  WHERE block_num = $1 AND trx_in_block = $2 AND op_in_trx = $3`,
				[row.block_num, row.trx_in_block, row.op_in_trx, status, reason]
			);
			// A release recorded valid=false is still `applied` in the event log,
			// exactly as at apply time: its verdict is the row.
			const after = isRelease ? await releaseVerdict(c, row.trx_id) : null;
			const outcome = reason ?? after ?? 'applied';
			await c.query(
				`INSERT INTO fee_reverify_done (block_num, trx_in_block, op_in_trx, op_id, outcome)
				 VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (block_num, trx_in_block, op_in_trx) DO NOTHING`,
				[
					row.block_num,
					row.trx_in_block,
					row.op_in_trx,
					row.op_id,
					`${DONE_PREFIX}${outcome}`.slice(0, 200)
				]
			);
			return {
				changed: status !== row.status || reason !== row.reject_reason || before !== after,
				outcome
			};
		});
	}

	private ctxFor(row: OpRow, payload: unknown, tx: BlockTransaction): OpContext {
		return {
			blockNum: Number(row.block_num),
			trxInBlock: row.trx_in_block,
			opInTrx: row.op_in_trx,
			blockTime: new Date(row.block_time),
			trxId: row.trx_id,
			signer: row.signer,
			payload,
			siblingOps: tx.operations,
			transaction: tx,
			blurt: this.deps.blurt as BlurtClient,
			config: this.deps.config,
			feeVerifiers: {},
			feeAmounts: {},
			fiatToUsd: () => null,
			recordOrderbookChange: () => {},
			recordChatChange: () => {}
		};
	}
}

/** A release row's verdict: 'valid', its invalid reason, or null (no row). */
async function releaseVerdict(c: pg.PoolClient, trxId: string): Promise<string | null> {
	const r = await c.query<{ valid: boolean; invalid_reason: string | null }>(
		'SELECT valid, invalid_reason FROM releases WHERE source_trx_id = $1',
		[trxId]
	);
	const row = r.rows[0];
	return row === undefined ? null : row.valid ? 'valid' : (row.invalid_reason ?? 'invalid');
}

/** Remove what an op that is not (or no longer) trusted left behind: its
 *  release is never valid, and a stored directory that came from it goes. */
async function forgetOp(c: pg.PoolClient, row: OpRow): Promise<void> {
	if (row.op_id === OP_IDS.releaseDiscovery) {
		await c.query(
			`UPDATE releases SET valid = false, invalid_reason = 'not_signed_by_pinned_key'
			  WHERE source_trx_id = $1 AND valid = true`,
			[row.trx_id]
		);
	} else {
		await c.query('DELETE FROM rpc_directory WHERE id = 1 AND block_num = $1', [row.block_num]);
	}
}
