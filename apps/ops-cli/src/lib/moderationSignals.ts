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
