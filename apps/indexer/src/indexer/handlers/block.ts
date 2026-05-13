/**
 * Handler: morphit_block_v1
 *
 * Payload shape:
 *   {
 *     "blocked": string (blurt account name),
 *     "action":  "block" | "unblock"
 *   }
 *
 * Effect: record (or reverse) a block from ctx.signer against
 * `blocked`. Writes or updates a row in `blocks` keyed on
 * (blocker = ctx.signer, blocked).
 *
 * Semantics:
 *   - action="block" on a fresh pair   → insert, state='blocked'.
 *   - action="block" on a blocked pair → idempotent no-op.
 *   - action="block" on an unblocked   → re-activate block;
 *                                       since_* MOVE to this op
 *                                       (new relationship).
 *   - action="unblock" on a blocked pair → flip state to 'unblocked'.
 *   - action="unblock" on unblocked → idempotent no-op.
 *   - action="unblock" on no prior row → reject (no_prior_block).
 *
 * Why reject action=unblock with no prior row:
 *   An unblock op against an account you've never blocked is
 *   either client confusion or a stale-replay attempt; there's
 *   no state to change. Accepting it would create a row with
 *   state='unblocked' that never had a 'blocked' phase —
 *   confusing and semantically empty. Reject cleanly, the
 *   client should refetch before retrying.
 *
 * Finding H belt-and-suspenders triad, layer 1 of 3.
 * Rate-limit and stranger-fee layers arrive in later migrations.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';

const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface BlocksRow {
	state: 'blocked' | 'unblocked';
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	if (!isPlainObject(ctx.payload)) {
		return { ok: false, reason: 'payload_not_object' };
	}

	const blocked = ctx.payload.blocked;
	if (typeof blocked !== 'string' || !ACCOUNT_NAME_RE.test(blocked)) {
		return { ok: false, reason: 'blocked_invalid' };
	}
	if (blocked === ctx.signer) {
		// Self-block is nonsense and the DB CHECK would reject
		// the INSERT anyway, but handling it here gives a nicer
		// reason code than a constraint violation would.
		return { ok: false, reason: 'self_block' };
	}

	const action = ctx.payload.action;
	if (action !== 'block' && action !== 'unblock') {
		return { ok: false, reason: 'action_invalid' };
	}

	// Look up the current state of this (blocker, blocked) pair.
	const existing = await client.query<BlocksRow>(
		`SELECT state FROM blocks WHERE blocker = $1 AND blocked = $2`,
		[ctx.signer, blocked]
	);
	const currentState = existing.rows[0]?.state ?? null;

	if (action === 'unblock' && currentState === null) {
		// See the top-of-file comment for why this is rejected
		// rather than treated as a silent no-op.
		return { ok: false, reason: 'no_prior_block' };
	}

	if (action === 'block' && currentState === 'blocked') {
		// Idempotent re-block. Accept silently with no DB
		// mutation — the row is already in the target state,
		// and we don't move `last_action_block_num` or
		// `updated_at` for a no-op. Keeps the audit trail
		// meaningful (a chain of re-blocks shouldn't rewrite
		// the timestamp on every one).
		return { ok: true };
	}
	if (action === 'unblock' && currentState === 'unblocked') {
		return { ok: true };
	}

	if (currentState === null) {
		// Fresh block. Insert with since_* and created_at
		// anchored to this op; last_action_block_num and
		// updated_at start at the same place.
		await client.query(
			`INSERT INTO blocks
			   (blocker, blocked, state, since_block_num, since_trx_id,
			    last_action_block_num, created_at, updated_at)
			 VALUES ($1, $2, 'blocked', $3, $4, $3, $5, $5)`,
			[ctx.signer, blocked, ctx.blockNum, ctx.trxId, ctx.blockTime]
		);
		return { ok: true };
	}

	// Existing row, state needs to flip. For block-after-unblock
	// we move since_* to this op (it's a new relationship). For
	// unblock-after-block we keep since_* (the ORIGINAL block
	// anchor stays valid as audit of when the relationship
	// started).
	if (action === 'block') {
		await client.query(
			`UPDATE blocks
			    SET state = 'blocked',
			        since_block_num = $3,
			        since_trx_id = $4,
			        last_action_block_num = $3,
			        created_at = $5,
			        updated_at = $5
			  WHERE blocker = $1 AND blocked = $2`,
			[ctx.signer, blocked, ctx.blockNum, ctx.trxId, ctx.blockTime]
		);
	} else {
		// action === 'unblock', currentState === 'blocked'
		await client.query(
			`UPDATE blocks
			    SET state = 'unblocked',
			        last_action_block_num = $3,
			        updated_at = $4
			  WHERE blocker = $1 AND blocked = $2`,
			[ctx.signer, blocked, ctx.blockNum, ctx.blockTime]
		);
	}

	return { ok: true };
};

export default handle;
