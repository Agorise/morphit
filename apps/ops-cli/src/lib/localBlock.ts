/**
 * Instance-local operator blocks (beta5).
 *
 * `morphit-ops block`/`unblock` write the `operator_blocks` table
 * DIRECTLY — no Blurt posting key, no chain broadcast. These blocks
 * affect only THIS instance's view (the orderbook/listing queries
 * exclude blocked accounts), are tagged `origin='local'`, and are not
 * federated. The on-chain `morphit_operator_block_v1` handler still
 * works independently for operators who DO publish blocks; the two
 * coexist in the same table, distinguished by `origin`.
 *
 * The pure `planLocalBlock` decides the write from the current row
 * state, mirroring the chain handler's insert/reblock/unblock logic
 * plus an idempotent reason-amend. `applyLocalBlock` performs the I/O.
 */

export type BlockAction = 'block' | 'unblock';
export type BlockState = 'blocked' | 'unblocked';
export type LocalBlockOp = 'insert' | 'reblock' | 'amend' | 'unblock' | 'noop';

export interface LocalBlockPlan {
	readonly op: LocalBlockOp;
	/** Human one-liner describing what will happen (for CLI output). */
	readonly summary: string;
}

// Canonical Blurt account-name regex — identical across every
// workspace (rejects a trailing '.'/'-'; 3–16 chars).  Pinned by
// blurt-account-regex-parity-smoke (cp175 F-007 / cp176); do not
// re-simplify to the old `{2,15}$` form (it admitted trailing punct).
const ACCOUNT_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

import type { Database } from '../db.ts';

/** Validate a Blurt account name (lowercased). Returns the normalized
 *  name or null if invalid. PURE. */
export function normalizeAccount(raw: string): string | null {
	const a = raw.trim().toLowerCase().replace(/^@/, '');
	return ACCOUNT_RE.test(a) ? a : null;
}

/** Decide the write for a local block/unblock from the current state.
 *  PURE — no I/O. */
export function planLocalBlock(args: {
	action: BlockAction;
	account: string;
	reason: string;
	currentState: BlockState | null;
	currentReason: string | null;
}): LocalBlockPlan {
	const { action, account, reason, currentState, currentReason } = args;
	if (action === 'block') {
		if (currentState === null) {
			return { op: 'insert', summary: `Blocking @${account} on this instance.` };
		}
		if (currentState === 'unblocked') {
			return { op: 'reblock', summary: `Re-blocking @${account} (was previously unblocked).` };
		}
		// already blocked
		if ((currentReason ?? '') !== reason) {
			return { op: 'amend', summary: `@${account} is already blocked; updating the reason.` };
		}
		return { op: 'noop', summary: `@${account} is already blocked with that reason — nothing to do.` };
	}
	// unblock
	if (currentState === 'blocked') {
		return { op: 'unblock', summary: `Unblocking @${account} on this instance.` };
	}
	return { op: 'noop', summary: `@${account} is not blocked on this instance — nothing to do.` };
}

/** Read the indexer's last-applied block (best-effort context for the
 *  local block's since_block_num). Returns 0 if no state row yet. */
async function currentIndexerBlock(db: Database): Promise<number> {
	try {
		const r = await db.query<{ last_applied_block: string | number }>(
			'SELECT last_applied_block FROM indexer_state WHERE id = 1'
		);
		const v = r.rows[0]?.last_applied_block;
		return v === undefined ? 0 : Number(v);
	} catch {
		return 0;
	}
}

export interface ApplyLocalBlockResult {
	readonly plan: LocalBlockPlan;
	readonly changed: boolean;
}

/** Apply a local block/unblock to operator_blocks. Reads the current
 *  state, plans, and performs the write (origin='local'). */
export async function applyLocalBlock(
	db: Database,
	args: { operator: string; account: string; action: BlockAction; reason: string }
): Promise<ApplyLocalBlockResult> {
	const { operator, account, action, reason } = args;
	const cur = await db.query<{ state: BlockState; reason: string }>(
		'SELECT state, reason FROM operator_blocks WHERE operator = $1 AND blocked = $2',
		[operator, account]
	);
	const row = cur.rows[0] ?? null;
	const plan = planLocalBlock({
		action,
		account,
		reason,
		currentState: row?.state ?? null,
		currentReason: row?.reason ?? null
	});

	if (plan.op === 'noop') return { plan, changed: false };

	const block = await currentIndexerBlock(db);
	const now = new Date();

	switch (plan.op) {
		case 'insert':
			await db.query(
				`INSERT INTO operator_blocks
				   (operator, blocked, state, reason,
				    since_block_num, since_trx_id, last_action_block_num,
				    created_at, updated_at, origin)
				 VALUES ($1, $2, 'blocked', $3, $4, 'local', $4, $5, $5, 'local')`,
				[operator, account, reason, block, now]
			);
			break;
		case 'reblock':
			await db.query(
				`UPDATE operator_blocks
				    SET state = 'blocked', reason = $3,
				        since_block_num = $4, since_trx_id = 'local',
				        last_action_block_num = $4,
				        created_at = $5, updated_at = $5, origin = 'local'
				  WHERE operator = $1 AND blocked = $2`,
				[operator, account, reason, block, now]
			);
			break;
		case 'amend':
			await db.query(
				`UPDATE operator_blocks
				    SET reason = $3, last_action_block_num = $4, updated_at = $5
				  WHERE operator = $1 AND blocked = $2`,
				[operator, account, reason, block, now]
			);
			break;
		case 'unblock':
			await db.query(
				`UPDATE operator_blocks
				    SET state = 'unblocked', last_action_block_num = $3, updated_at = $4
				  WHERE operator = $1 AND blocked = $2`,
				[operator, account, block, now]
			);
			break;
	}
	return { plan, changed: true };
}
