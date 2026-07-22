/**
 * Moderation signal access (beta5) — shared by the merged
 * `moderation` screen.
 *
 * The indexer raises two account-level abuse signals:
 *   - suspicious_reciprocity (Self-trade Signal B): two accounts
 *     mutually exchanging high-star reviews with no other
 *     counterparties.  No free-text reason column — synthesize one
 *     from mutual_review_count + avg_rating.
 *   - related_accounts (Self-trade Signal A): accounts created in
 *     close temporal proximity by the same creator.  Has reason +
 *     evidence.
 *
 * This module exposes the queries + the pure aggregation helpers so
 * the moderation screen can present both signals plus each flagged
 * account's instance-local block status, and the smoke can unit-test
 * the aggregation without a database.
 */

import type { Database } from '../db.ts';

export interface ReciprocityFlag {
	account_a: string;
	account_b: string;
	detected_at: Date;
	reason: string | null;
}

export interface RelatedFlag {
	account_a: string;
	account_b: string;
	detected_at: Date;
	reason: string;
}

export interface BlockStatus {
	account: string;
	state: 'blocked' | 'unblocked';
	origin: 'chain' | 'local';
}

export async function fetchReciprocityFlags(
	db: Database,
	cutoff: Date,
	limit: number
): Promise<ReciprocityFlag[]> {
	const r = await db.query<ReciprocityFlag>(
		`SELECT
		   account_a,
		   account_b,
		   detected_at,
		   'mutual reviews: ' || mutual_review_count
		     || ' (avg rating ' || round(avg_rating::numeric, 2) || ')' AS reason
		 FROM suspicious_reciprocity
		 WHERE detected_at >= $1
		 ORDER BY detected_at DESC
		 LIMIT $2`,
		[cutoff, limit]
	);
	return r.rows;
}

export async function fetchRelatedFlags(
	db: Database,
	cutoff: Date,
	limit: number
): Promise<RelatedFlag[]> {
	const r = await db.query<RelatedFlag>(
		`SELECT account_a, account_b, detected_at, reason
		 FROM related_accounts
		 WHERE detected_at >= $1
		 ORDER BY detected_at DESC
		 LIMIT $2`,
		[cutoff, limit]
	);
	return r.rows;
}

/** Distinct accounts named across both signal streams, sorted.
 *  PURE. */
export function collectFlaggedAccounts(
	reciprocity: readonly { account_a: string; account_b: string }[],
	related: readonly { account_a: string; account_b: string }[]
): string[] {
	const set = new Set<string>();
	for (const r of reciprocity) {
		set.add(r.account_a);
		set.add(r.account_b);
	}
	for (const r of related) {
		set.add(r.account_a);
		set.add(r.account_b);
	}
	return [...set].sort();
}

/** Look up the instance-local block status of the given accounts for
 *  this operator. Returns a map keyed by account (only blocked OR
 *  previously-unblocked rows are present; absent = never recorded). */
export async function fetchBlockStatuses(
	db: Database,
	operator: string,
	accounts: readonly string[]
): Promise<Map<string, BlockStatus>> {
	const map = new Map<string, BlockStatus>();
	if (accounts.length === 0) return map;
	const r = await db.query<BlockStatus>(
		`SELECT blocked AS account, state, origin
		   FROM operator_blocks
		  WHERE operator = $1 AND blocked = ANY($2::text[])`,
		[operator, [...accounts]]
	);
	for (const row of r.rows) map.set(row.account, row);
	return map;
}

/** Clear a self-trade flag for a pair and stop the detector re-raising it.
 *
 *  Both halves matter. Deleting the flag row is what restores the account
 *  immediately — the reputation card comes back and the reviews stop being
 *  subdued, because every read path still reads the flag tables and the pair
 *  is simply no longer in them. Recording the clearance is what makes it LAST:
 *  the detectors re-run and would otherwise re-insert the identical row on
 *  their next pass, which is why a plain DELETE looks like it worked and then
 *  quietly undoes itself.
 *
 *  Instance-local, like blocking: nothing is broadcast and no other instance's
 *  view changes. Reversible in turn via `unclearFlag`.
 *
 *  Pairs are stored canonically (account_a < account_b) by both detectors, so
 *  the two names are normalised here and the operator can type them in either
 *  order.
 */
export async function clearFlag(
	db: Database,
	params: {
		readonly signal: 'reciprocity' | 'related';
		readonly accountA: string;
		readonly accountB: string;
		readonly note: string;
	}
): Promise<{ readonly cleared: number }> {
	const a = params.accountA.toLowerCase();
	const b = params.accountB.toLowerCase();
	const [lo, hi] = a < b ? [a, b] : [b, a];
	const table = params.signal === 'reciprocity' ? 'suspicious_reciprocity' : 'related_accounts';

	// Signal B is behavioural, so capture WHERE the pair stands at clear time.
	// The detector forgives everything up to this mark and re-fires once they
	// add another full signal's worth on top — past forgiven, future watched.
	// Signal A keys on immutable account-creation facts, so it has no watermark
	// and its clearance is permanent; a re-arming one would re-flag the same
	// pair forever on evidence that can never change.
	let watermark: number | null = null;
	if (params.signal === 'reciprocity') {
		const cur = await db.query(
			`SELECT mutual_review_count FROM suspicious_reciprocity
			  WHERE account_a = $1 AND account_b = $2`,
			[lo, hi]
		);
		const row = cur.rows[0] as { mutual_review_count?: number } | undefined;
		// No flag row (clearing pre-emptively) → 0, i.e. any future activity that
		// earns the flag outright will still raise it.
		watermark = typeof row?.mutual_review_count === 'number' ? row.mutual_review_count : 0;
	}

	await db.query(
		`INSERT INTO moderation_flag_clearances (signal, account_a, account_b, watermark, note)
		 VALUES ($1, $2, $3, $4, $5)
		 ON CONFLICT (signal, account_a, account_b)
		 DO UPDATE SET watermark = EXCLUDED.watermark, note = EXCLUDED.note, cleared_at = NOW()`,
		[params.signal, lo, hi, watermark, params.note.slice(0, 500)]
	);
	const del = await db.query(
		`DELETE FROM ${table} WHERE account_a = $1 AND account_b = $2`,
		[lo, hi]
	);
	return { cleared: del.rowCount ?? 0 };
}

/** Undo a clearance: the pair becomes eligible for flagging again on the
 *  detector's next pass. Does NOT re-insert the flag by hand — if the
 *  behaviour genuinely warrants one, the detector will say so itself. */
export async function unclearFlag(
	db: Database,
	params: {
		readonly signal: 'reciprocity' | 'related';
		readonly accountA: string;
		readonly accountB: string;
	}
): Promise<{ readonly removed: number }> {
	const a = params.accountA.toLowerCase();
	const b = params.accountB.toLowerCase();
	const [lo, hi] = a < b ? [a, b] : [b, a];
	const r = await db.query(
		`DELETE FROM moderation_flag_clearances
		  WHERE signal = $1 AND account_a = $2 AND account_b = $3`,
		[params.signal, lo, hi]
	);
	return { removed: r.rowCount ?? 0 };
}

/** Clearances currently in force, newest first — so the operator can see what
 *  they have forgiven and undo it. */
export async function fetchClearances(
	db: Database,
	limit: number
): Promise<readonly ClearanceRow[]> {
	const r = await db.query(
		`SELECT signal, account_a, account_b, watermark, note, cleared_at
		   FROM moderation_flag_clearances
		  ORDER BY cleared_at DESC
		  LIMIT $1`,
		[limit]
	);
	return r.rows as ClearanceRow[];
}

export interface ClearanceRow {
	readonly signal: 'reciprocity' | 'related';
	readonly account_a: string;
	readonly account_b: string;
	readonly watermark: number | null;
	readonly note: string;
	readonly cleared_at: Date;
}
