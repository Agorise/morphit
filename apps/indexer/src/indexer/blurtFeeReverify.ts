/**
 * Morphit indexer — one-shot re-verification of BLURT fee ops judged before
 * this node knew the tagged operator's fee account (v1.20.0, G1).
 *
 * WHY. Cross-instance fee verification (see $indexer/feeRecipients) needs the
 * fee account an operator registered on chain. During the rollout an operator
 * B upgrades first and its upgrade re-registers with `fee_recipient` at block
 * X, while THIS node still runs v1.19.x: its register handler applies that op
 * without reading the field (the payload is kept in `ops`), and every fee paid
 * through B after X is judged the old way — an order stored `underpaid`
 * (hidden), a stranger fee rejected `fee_underpaid` (the first-contact DM
 * dropped). After this node upgrades, the boot reconcile back-fills the history
 * from `ops`; THIS job then re-judges exactly those ops with the new rule.
 *
 * WHY A CHAIN RE-FETCH. The verdict needs the sibling transfers of the
 * original transaction. This node stores only transfers to ITS OWN fee
 * account (`fee_transfers`) — never the leg to @b-fees — and `orders` keeps no
 * trx. The `ops` row does keep the op's block, position and trx id, so the job
 * fetches that block through the indexer's own BlurtClient (the full RPC pool,
 * best node first; a hidden-only node's pool is hidden-only) and requires the
 * transaction's id — a hash of its content — to equal the id this node indexed.
 * A node serving an altered transaction is caught and the op is left alone
 * (retried on a later pass, at most FETCH_FAILURES_PER_OP times per process).
 *
 * DETERMINISM. Each op is judged AS OF ITS BLOCK: the owner set uses history
 * rows before the op's block, the listing floor uses the BLURT base pinned
 * before it, and the Sybil tier counts the payer's orders the live handler had already stored:
 * those whose creating op precedes this one in CHAIN ORDER (block, trx, op —
 * from the event log; V3-9), still live then (from status / updated_at /
 * expires_at). The stranger fee is re-run through its own handler, which is
 * block-time-deterministic (its escalating price is bounded to the block).
 *
 * WHAT IS SELECTED. Only ops whose verdict CAN change: live, unexpired BLURT
 * orders stored `underpaid` (≤ 365 days old — orders never live longer) and
 * stranger fees rejected `fee_underpaid` in the last 30 days, whose
 * `operator_tag` names an active operator that has registered a fees account
 * (its first registration at block R; E = R + 1 is the first block at which
 * the strict as-of-block rule accepts it), and either
 *  - the op is at/after E and a fee account other than ours was registered
 *    before it (the rollout window — strict as-of-block rule), or
 *  - the op is BEFORE E (LEGACY GRACE, below).
 * Each op is judged ONCE (`fee_reverify_done`).
 *
 * LEGACY GRACE (v1.20.0). Orders paid through an operator before it had ever
 * registered a fees account (on v1.19 every order went 90 % to the operator's
 * own fees account, which no other instance could know) can never pass the
 * strict as-of-block rule. Below E such an op is judged as if the FIRST
 * account the operator registered had been in force at its block:
 * accepted only if the 90 % leg went EXACTLY to that account and everything
 * else (the canonical 10 % leg, the amount by the listing base and the Sybil
 * tier by chain position, the memo) passes as the live handler would. A leg
 * paid to an account the operator used BEFORE it first registered and then
 * changed away from matches nothing and stays underpaid, by design — nothing
 * on chain ties that account to the operator.
 *
 * WHY E. The boundary is where the strict rule starts accepting the operator,
 * so every op falls under exactly one rule and none is left in a gap. E
 * depends only on chain data (the first history row), and once it exists it
 * never moves. So every node — one that indexed the op on v1.19 and upgraded
 * (history back-filled from `ops`), a fresh v1.20 node that synced from before
 * the op, a fast-synced node (whose snapshot carries the verdict of its
 * source, and an empty local `fee_reverify_done`) — computes the same E and
 * the same grace account, and ends with the same verdict once the
 * registration exists. An operator that never registered a fees account has no
 * E and nothing of it is selected.
 *
 * Pre-G1 stranger fees carried no `operator_tag` (the v1.19 payload is
 * {v, recipient, amount_blurt}), so they cannot be attributed and are never
 * selected; an expired or closed order is not re-judged (it no longer shows).
 *
 * WHAT IT DOES NOT DO. A chat message this node dropped for want of the
 * stranger fee is not recovered (it was never stored); once the fee is applied
 * the sender's next message is admitted.
 *
 * WHEN. A pass runs at once when a fees-account registration lands (see
 * maybeRun), then every BACKLOG_INTERVAL_MS while
 * candidates remain, else every INTERVAL_MS. A hidden-only node re-fetches
 * through its own (hidden-only) pool.
 *
 * BOUNDED. At most MAX_FETCHES_PER_PASS block fetches per pass, called from
 * the poller loop after each caught-up tick.
 */

import type pg from 'pg';

import type { BlurtClient, BlockTransaction, ChainOperation } from '$blurt/client';
import type { Config } from '$config';
import type { Database } from '$db/pool';
import { transactionIdOf } from '$blurt/snapshotOpTrust';
import { CANONICAL_TREASURY } from '../config/canonicalTreasury';
import { listingFeeStatus, sumFeeTransfers } from '$indexer/fee';
import { graceRecipientAt, operatorTagOf, ownerRecipientsFor } from '$indexer/feeRecipients';
import { trackVerifiedBlurtFee } from '$indexer/loyalty';
import { attributeBlurtFeeToOperator } from '$indexer/operatorEarnings';
import strangerFeeHandler from '$indexer/handlers/strangerFee';
import type { Handler, OpContext } from '$indexer/handler-contract';
import { logger } from '$log';

const log = logger('blurtFeeReverify');

const ORDER_OP_ID = 'morphit_order_v1';
const STRANGER_FEE_OP_ID = 'morphit_stranger_fee_v1';

/** One pass every 10 minutes when idle. */
export const INTERVAL_MS = 10 * 60_000;
/** While candidates are left over, the next pass comes this soon. */
export const BACKLOG_INTERVAL_MS = 30_000;
/** Chain block fetches per pass (orders first, then stranger fees). */
export const MAX_FETCHES_PER_PASS = 20;
/** A block fetch that fails, or returns a transaction that is not the one this
 *  node indexed, is retried on later passes up to this many times per process. */
export const FETCH_FAILURES_PER_OP = 3;
/** Stranger fees older than this are not re-judged (the sender has long since
 *  re-paid or given up). */
export const STRANGER_FEE_WINDOW_DAYS = 30;

/** Operators that registered a fees account, with E — the first block at
 *  which the strict rule accepts it (first registration block + 1). */
const ACCEPTED_SQL = `SELECT account, MIN(effective_block) + 1 AS estar
	   FROM operator_fee_recipients GROUP BY account`;

export interface ReverifyDeps {
	readonly db: Pick<Database, 'query' | 'withTx'>;
	/** The poller's BlurtClient: getBlock goes through the full RPC pool. */
	readonly blurt: BlurtClient;
	readonly config: Config;
	/** Called (after commit) for every order flipped to verified. */
	readonly onOrderVerified?: (orderId: string) => void;
	readonly now?: () => number;
}

export interface ReverifySummary {
	/** True when the pass stopped on its fetch budget with candidates left. */
	readonly budgetExhausted: boolean;
	readonly orders: { checked: number; verified: number };
	readonly strangerFees: { checked: number; applied: number };
	/** Fetches that failed or returned a transaction other than the indexed one. */
	readonly fetchFailures: number;
}

interface OpRef {
	readonly block_num: string;
	readonly trx_in_block: number;
	readonly op_in_trx: number;
	readonly trx_id: string;
	readonly block_time: Date;
}

interface OrderCandidate extends OpRef {
	readonly account: string;
	readonly permlink: string;
	/** The account owning the order's operator_tag, and the block from which
	 *  its fees account is accepted (legacy grace applies below it). */
	readonly operator_account: string;
	readonly estar: string;
}

interface StrangerFeeCandidate extends OpRef {
	readonly signer: string;
	readonly payload: unknown;
	readonly operator_account: string;
	readonly estar: string;
}

export class BlurtFeeReverifier {
	private lastRunAt = Number.NEGATIVE_INFINITY;
	private readonly failures = new Map<string, number>();
	/** Did the last pass stop on its budget with candidates left? */
	private backlog = false;
	/** Fingerprint of the fees-account history, at the last pass. */
	private lastSignature: string | null = null;

	constructor(private readonly deps: ReverifyDeps) {}

	/**
	 * Self-throttling, never throws. A pass runs:
	 *  - IMMEDIATELY when a fees-account registration landed since the last
	 *    pass (e.g. the operator's upgrade just published its first fees
	 *    account), so the orders it unlocks are re-judged without waiting for
	 *    the rotation;
	 *  - every BACKLOG_INTERVAL_MS while the previous pass left candidates
	 *    (an operator with hundreds of legacy orders drains in minutes, not
	 *    days);
	 *  - otherwise every INTERVAL_MS.
	 */
	async maybeRun(): Promise<void> {
		const now = (this.deps.now ?? Date.now)();
		let signature: string | null = null;
		try {
			signature = await this.registrationSignature();
		} catch {
			signature = null;
		}
		const changed = signature !== null && signature !== this.lastSignature;
		const interval = this.backlog ? BACKLOG_INTERVAL_MS : INTERVAL_MS;
		if (!changed && now - this.lastRunAt < interval) return;
		this.lastRunAt = now;
		this.lastSignature = signature;
		try {
			const s = await this.runOnce();
			this.backlog = s.budgetExhausted;
			if (s.orders.checked + s.strangerFees.checked + s.fetchFailures > 0) {
				log.info('reverify_pass', {
					orders_checked: s.orders.checked,
					orders_verified: s.orders.verified,
					stranger_fees_checked: s.strangerFees.checked,
					stranger_fees_applied: s.strangerFees.applied,
					fetch_failures: s.fetchFailures,
					backlog: s.budgetExhausted
				});
			}
		} catch (err) {
			log.error('reverify_pass_failed', {}, err instanceof Error ? err : undefined);
		}
	}

	/** One bounded pass. */
	async runOnce(): Promise<ReverifySummary> {
		const own = this.deps.config.feeRecipient;
		let budget = MAX_FETCHES_PER_PASS;
		let fetchFailures = 0;
		const orders = { checked: 0, verified: 0 };
		const strangerFees = { checked: 0, applied: 0 };

		// Only ops of operators that registered a fees account can flip: below
		// E (first registration block + 1) by LEGACY GRACE, from E on by the
		// strict as-of-block rule (the rollout window).
		const orderRows = await this.deps.db.query<OrderCandidate>(
			`SELECT o.account, o.permlink, t.account AS operator_account, acc.estar::text AS estar,
			        op.block_num::text AS block_num, op.trx_in_block, op.op_in_trx, op.trx_id, op.block_time
			   FROM orders o
			   JOIN operators t ON t.tag = o.operator_tag AND t.is_active = TRUE
			   JOIN (${ACCEPTED_SQL}) acc ON acc.account = t.account
			   JOIN LATERAL (
			        SELECT block_num, trx_in_block, op_in_trx, trx_id, block_time
			          FROM ops
			         WHERE ops.signer = o.account AND ops.op_id = $1 AND ops.status = 'applied'
			           AND ops.payload->>'permlink' = o.permlink
			         ORDER BY block_num ASC, trx_in_block ASC, op_in_trx ASC
			         LIMIT 1) op ON TRUE
			  WHERE o.status = 'live' AND o.fee_method = 'blurt' AND o.fee_status = 'underpaid'
			    AND (o.expires_at IS NULL OR o.expires_at > NOW())
			    AND o.created_at > NOW() - INTERVAL '365 days'
			    AND (op.block_num < acc.estar
			         OR EXISTS (SELECT 1 FROM operator_fee_recipients f
			                     WHERE f.account = t.account AND f.effective_block < op.block_num
			                       AND f.fee_recipient <> $2))
			    AND NOT EXISTS (SELECT 1 FROM fee_reverify_done dn
			                     WHERE dn.block_num = op.block_num AND dn.trx_in_block = op.trx_in_block
			                       AND dn.op_in_trx = op.op_in_trx)
			  ORDER BY o.created_at DESC
			  LIMIT $3`,
			[ORDER_OP_ID, own, MAX_FETCHES_PER_PASS * 2]
		);
		let budgetExhausted = false;
		for (const row of orderRows.rows) {
			if (budget <= 0) {
				budgetExhausted = true;
				break;
			}
			if (this.gaveUp(row)) continue;
			budget--;
			const trx = await this.fetchIndexedTrx(row);
			if (trx === null) {
				fetchFailures++;
				continue;
			}
			orders.checked++;
			if (await this.reverifyOrder(row, trx)) orders.verified++;
		}

		if (budget > 0) {
			const sfRows = await this.deps.db.query<StrangerFeeCandidate>(
				`SELECT ops.block_num::text AS block_num, ops.trx_in_block, ops.op_in_trx, ops.trx_id,
				        ops.block_time, ops.signer, ops.payload,
				        t.account AS operator_account, acc.estar::text AS estar
				   FROM ops
				   JOIN operators t ON t.tag = ops.payload->>'operator_tag' AND t.is_active = TRUE
				   JOIN (${ACCEPTED_SQL}) acc ON acc.account = t.account
				  WHERE ops.op_id = $1 AND ops.status = 'rejected' AND ops.reject_reason = 'fee_underpaid'
				    AND jsonb_typeof(ops.payload) = 'object' AND ops.payload ? 'operator_tag'
				    AND ops.block_time > NOW() - make_interval(days => $2::int)
				    AND (ops.block_num < acc.estar
				         OR EXISTS (SELECT 1 FROM operator_fee_recipients f
				                     WHERE f.account = t.account AND f.effective_block < ops.block_num
				                       AND f.fee_recipient <> $3))
				    AND NOT EXISTS (SELECT 1 FROM fee_reverify_done dn
				                     WHERE dn.block_num = ops.block_num AND dn.trx_in_block = ops.trx_in_block
				                       AND dn.op_in_trx = ops.op_in_trx)
				  ORDER BY ops.block_num DESC
				  LIMIT $4`,
				[STRANGER_FEE_OP_ID, STRANGER_FEE_WINDOW_DAYS, own, budget * 2]
			);
			for (const row of sfRows.rows) {
				if (budget <= 0) {
					budgetExhausted = true;
					break;
				}
				if (this.gaveUp(row)) continue;
				budget--;
				const trx = await this.fetchIndexedTrx(row);
				if (trx === null) {
					fetchFailures++;
					continue;
				}
				strangerFees.checked++;
				if (await this.reapplyStrangerFee(row, trx)) strangerFees.applied++;
			}
		} else {
			// The budget ran out on orders: stranger-fee
			// candidates may be waiting, so come back soon.
			budgetExhausted = true;
		}

		return { budgetExhausted, orders, strangerFees, fetchFailures };
	}

	/** Cheap fingerprint of the fees-account history (see maybeRun). */
	private async registrationSignature(): Promise<string> {
		const r = await this.deps.db.query<{ sig: string }>(
			`SELECT count(*)::text AS sig FROM operator_fee_recipients`
		);
		return r.rows[0]?.sig ?? '';
	}

	private key(ref: OpRef): string {
		return `${ref.block_num}:${ref.trx_in_block}:${ref.op_in_trx}`;
	}

	private gaveUp(ref: OpRef): boolean {
		return (this.failures.get(this.key(ref)) ?? 0) >= FETCH_FAILURES_PER_OP;
	}

	/** The transaction this node indexed at `ref`, re-fetched from the chain and
	 *  proven identical by its content hash; null (and a failure counted) when
	 *  the block is unavailable or the transaction is not the indexed one. */
	private async fetchIndexedTrx(ref: OpRef): Promise<BlockTransaction | null> {
		const fail = (why: string): null => {
			this.failures.set(this.key(ref), (this.failures.get(this.key(ref)) ?? 0) + 1);
			log.warn('reverify_fetch_failed', { block_num: ref.block_num, trx_id: ref.trx_id, why });
			return null;
		};
		let block;
		try {
			block = await this.deps.blurt.getBlock(Number(ref.block_num));
		} catch (err) {
			return fail(err instanceof Error ? err.message.slice(0, 120) : 'fetch_error');
		}
		const trx = block?.transactions?.[ref.trx_in_block];
		if (!trx) return fail('transaction_absent');
		const recomputed = transactionIdOf({
			...trx,
			extensions: (trx as BlockTransaction & { extensions?: unknown[] }).extensions ?? []
		});
		if (recomputed !== ref.trx_id) return fail('transaction_id_mismatch');
		return trx;
	}

	/**
	 * LEGACY GRACE. The fees account an op below its operator's E (first
	 * registration block + 1, from which the strict rule accepts it) is judged
	 * against: graceRecipientAt — in practice the FIRST account registered.
	 * Empty from E on (the strict as-of-block rule applies, via
	 * ownerRecipientsFor).
	 */
	private async graceOwners(
		client: pg.PoolClient,
		row: { block_num: string; operator_account: string; estar: string }
	): Promise<string[]> {
		if (!(Number(row.block_num) < Number(row.estar))) return [];
		const r = await graceRecipientAt(client, row.operator_account, row.block_num);
		return r === null ? [] : [r];
	}

	/** Owner-leg recipients for an order: ours plus the tagged operator's
	 *  account as of the block (strict), plus the grace account below E. */
	private async ownersFor(
		client: pg.PoolClient,
		row: OrderCandidate,
		payload: Record<string, unknown>,
		blockNum: number
	): Promise<string[]> {
		const strict = await ownerRecipientsFor(
			client,
			this.deps.config.feeRecipient,
			payload,
			blockNum
		);
		const grace = await this.graceOwners(client, row);
		return [...new Set([...strict, ...grace])];
	}

	/** Re-judge one order. True when it flipped to verified. */
	private async reverifyOrder(row: OrderCandidate, trx: BlockTransaction): Promise<boolean> {
		const blockNum = Number(row.block_num);
		const blockTime = row.block_time;
		const payload = customJsonPayload(trx.operations[row.op_in_trx], ORDER_OP_ID, row.account);
		const cfg = this.deps.config;
		const verified = await this.deps.db.withTx(async (client) => {
			let outcome = 'still_underpaid';
			let flipped = false;
			if (payload !== null && payload.permlink === row.permlink) {
				const owners = await this.ownersFor(client, row, payload, blockNum);
				const fee = sumFeeTransfers(
					trx.operations,
					row.account,
					owners,
					CANONICAL_TREASURY.blurt,
					`morphit-fee:${row.permlink}`
				);
				if (fee !== null) {
					const nth = (await sybilCountAsOf(client, row.account, row.permlink, blockTime, row)) + 1;
					const base = (await pinnedBlurtBaseAsOf(client, blockNum)) ?? cfg.feeBaseBlurt;
					if (listingFeeStatus(fee, nth, base, cfg.feeTolerance) === 'verified') {
						const upd = await client.query(
							`UPDATE orders SET fee_status = 'verified', updated_at = NOW()
							  WHERE account = $1 AND permlink = $2 AND fee_status = 'underpaid'
							    AND status = 'live' AND fee_method = 'blurt'`,
							[row.account, row.permlink]
						);
						if ((upd.rowCount ?? 0) > 0) {
							flipped = true;
							outcome = 'verified';
							// Exactly what the live handler does on a verified fee.
							const tag = operatorTagOf(payload);
							await trackVerifiedBlurtFee(
								client,
								row.account,
								fee.totalBlurt,
								blockNum,
								blockTime,
								tag,
								cfg.instanceOperatorTag,
								fee.toCanonicalBlurt
							);
							await attributeBlurtFeeToOperator({
								client,
								operatorTagRaw: payload.operator_tag,
								orderAccount: row.account,
								orderPermlink: row.permlink,
								feeBlurt: fee.totalBlurt,
								trxId: row.trx_id,
								blockNum,
								blockTime,
								instanceOperatorTag: cfg.instanceOperatorTag
							});
						}
					}
				}
			} else {
				outcome = 'op_mismatch';
			}
			await markDone(client, row, ORDER_OP_ID, outcome);
			return flipped;
		});
		if (verified) {
			log.info('order_fee_reverified', {
				order: `${row.account}/${row.permlink}`,
				block_num: blockNum
			});
			this.deps.onOrderVerified?.(`${row.account}/${row.permlink}`);
		}
		return verified;
	}

	/** Re-run one rejected stranger fee through its handler. True when applied. */
	private async reapplyStrangerFee(
		row: StrangerFeeCandidate,
		trx: BlockTransaction
	): Promise<boolean> {
		const onChain = customJsonPayload(
			trx.operations[row.op_in_trx],
			STRANGER_FEE_OP_ID,
			row.signer
		);
		const handler: Handler = strangerFeeHandler;
		return this.deps.db.withTx(async (client) => {
			let outcome: string;
			let applied = false;
			if (
				onChain === null ||
				JSON.stringify(normalise(onChain)) !== JSON.stringify(normalise(row.payload))
			) {
				outcome = 'op_mismatch';
			} else {
				const ctx: OpContext = {
					blockNum: Number(row.block_num),
					trxInBlock: row.trx_in_block,
					opInTrx: row.op_in_trx,
					blockTime: row.block_time,
					trxId: row.trx_id,
					signer: row.signer,
					payload: onChain,
					siblingOps: trx.operations,
					blurt: this.deps.blurt,
					config: this.deps.config,
					feeVerifiers: {},
					feeAmounts: {},
					fiatToUsd: () => null,
					recordOrderbookChange: () => {},
					recordChatChange: () => {},
					extraOwnerRecipients: await this.graceOwners(client, row)
				};
				await client.query('SAVEPOINT reverify_sf');
				const r = await handler(ctx, client);
				if (r.ok) {
					await client.query('RELEASE SAVEPOINT reverify_sf');
					await client.query(
						`UPDATE ops SET status = 'applied', reject_reason = NULL
						  WHERE block_num = $1 AND trx_in_block = $2 AND op_in_trx = $3 AND status = 'rejected'`,
						[row.block_num, row.trx_in_block, row.op_in_trx]
					);
					applied = true;
					outcome = 'applied';
				} else {
					await client.query('ROLLBACK TO SAVEPOINT reverify_sf');
					outcome = `still_rejected:${r.reason ?? 'unknown'}`.slice(0, 80);
				}
			}
			await markDone(client, row, STRANGER_FEE_OP_ID, outcome);
			if (applied) {
				log.info('stranger_fee_reapplied', { sender: row.signer, block_num: row.block_num });
			}
			return applied;
		});
	}
}

/** The parsed JSON payload of `op` when it is the `opId` custom_json signed by
 *  `signer`, else null. */
function customJsonPayload(
	op: ChainOperation | undefined,
	opId: string,
	signer: string
): Record<string, unknown> | null {
	if (!op || op[0] !== 'custom_json') return null;
	const b = op[1] as {
		id?: unknown;
		json?: unknown;
		required_auths?: unknown;
		required_posting_auths?: unknown;
	};
	if (b.id !== opId || typeof b.json !== 'string') return null;
	const auths = [
		...(Array.isArray(b.required_auths) ? b.required_auths : []),
		...(Array.isArray(b.required_posting_auths) ? b.required_posting_auths : [])
	];
	if (auths[0] !== signer) return null;
	try {
		const p = JSON.parse(b.json) as unknown;
		return typeof p === 'object' && p !== null && !Array.isArray(p)
			? (p as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/** Key-sorted deep copy, so a JSONB round-trip (which reorders keys) compares
 *  equal to the chain's JSON. */
function normalise(v: unknown): unknown {
	if (Array.isArray(v)) return v.map(normalise);
	if (typeof v === 'object' && v !== null) {
		return Object.fromEntries(
			Object.keys(v as Record<string, unknown>)
				.sort()
				.map((k) => [k, normalise((v as Record<string, unknown>)[k])])
		);
	}
	return v;
}

async function markDone(
	client: pg.PoolClient,
	ref: OpRef,
	opId: string,
	outcome: string
): Promise<void> {
	await client.query(
		`INSERT INTO fee_reverify_done (block_num, trx_in_block, op_in_trx, op_id, outcome)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (block_num, trx_in_block, op_in_trx) DO NOTHING`,
		[ref.block_num, ref.trx_in_block, ref.op_in_trx, opId, outcome]
	);
}

/**
 * The payer's order count toward the Sybil tier AS IT STOOD when the live
 * handler judged the op at `pos` (the order handler's countForSybilTier,
 * reconstructed). (V3-9) An order counts when its CREATING op came earlier in
 * CHAIN ORDER — block, then transaction, then op, read from the event log —
 * exactly the orders the live handler had already stored; an order with no
 * event-log row falls back to created_at strictly before the block. It must
 * also have been live then (still live, or changed after the block, and not
 * expired by then), or created in the 24 h before it. Excludes the order
 * itself. (Counting by created_at alone counted orders later in the SAME
 * block, so a re-check refused a fee the live pass accepted.)
 */
async function sybilCountAsOf(
	client: pg.PoolClient,
	account: string,
	permlink: string,
	blockTime: Date,
	pos: OpRef
): Promise<number> {
	const cutoff = new Date(blockTime.getTime() - 24 * 3600 * 1000);
	const res = await client.query<{ n: string }>(
		`SELECT COUNT(*)::text AS n
		   FROM orders o2
		   LEFT JOIN LATERAL (
		        SELECT block_num, trx_in_block, op_in_trx FROM ops
		         WHERE ops.signer = o2.account AND ops.op_id = $5 AND ops.status = 'applied'
		           AND ops.payload->>'permlink' = o2.permlink
		         ORDER BY block_num ASC, trx_in_block ASC, op_in_trx ASC
		         LIMIT 1) c ON TRUE
		  WHERE o2.account = $1 AND o2.permlink <> $2
		    AND (CASE WHEN c.block_num IS NOT NULL
		              THEN (c.block_num, c.trx_in_block, c.op_in_trx) < ($6::bigint, $7::int, $8::int)
		              ELSE o2.created_at < $3 END)
		    AND (((o2.status = 'live' OR o2.updated_at > $3) AND (o2.expires_at IS NULL OR o2.expires_at > $3))
		         OR o2.created_at >= $4)`,
		[
			account,
			permlink,
			blockTime,
			cutoff,
			ORDER_OP_ID,
			pos.block_num,
			pos.trx_in_block,
			pos.op_in_trx
		]
	);
	return parseInt(res.rows[0]?.n ?? '0', 10);
}

/** The chain-pinned BLURT fee base in force before `blockNum` (the newest valid
 *  release op carrying a treasury.blurt.base), or null for "none — use the env
 *  fallback", as TreasurySource resolves it. */
async function pinnedBlurtBaseAsOf(
	client: pg.PoolClient,
	blockNum: number
): Promise<number | null> {
	const res = await client.query<{ treasury: { blurt?: { base?: unknown } | null } | null }>(
		`SELECT treasury FROM releases
		  WHERE valid = true AND treasury IS NOT NULL AND source_block_num < $1
		  ORDER BY created_at DESC
		  LIMIT 1`,
		[blockNum]
	);
	const base = res.rows[0]?.treasury?.blurt?.base;
	return typeof base === 'number' && Number.isFinite(base) && base > 0 ? base : null;
}
