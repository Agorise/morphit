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

/** How many flags are ACTIVE but fall outside the display window.
 *
 *  v1.8.12 (Ken) — THE OPERATOR BLIND SPOT. The flag lists above are windowed
 *  (`WHERE detected_at >= $1`, default 7d), but the reputation suppression in
 *  `apps/indexer/src/api/feedback.ts` has NO time filter: any row in these
 *  tables excludes that pair's feedback from the score forever. So a flag older
 *  than the window keeps a reputation suppressed while being INVISIBLE to the
 *  operator — who then cannot clear what they cannot see.
 *
 *  Ken hit this precisely: `morphit-ops moderation` reported "0 flags
 *  (0 reciprocity, 0 related-account)" while @kentest3's reputation card showed
 *  every review excluded. Reproduced against real Postgres: operator view 0,
 *  enforcement 1, resulting score count 0.
 *
 *  Reported as a count rather than silently widening the window: the window is
 *  a useful triage default, and quietly changing it would trade one surprise
 *  for another. The operator is told what is hidden and how to see it. */
export async function countActiveFlagsOutsideWindow(
	db: Database,
	cutoff: Date
): Promise<{ reciprocity: number; related: number; pile_on: number; concentration: number }> {
	const r = await db.query<{
		reciprocity: string;
		related: string;
		pile_on: string;
		concentration: string;
	}>(
		`SELECT
		   (SELECT COUNT(*) FROM suspicious_reciprocity WHERE detected_at < $1)::text AS reciprocity,
		   (SELECT COUNT(*) FROM related_accounts       WHERE detected_at < $1)::text AS related,
		   (SELECT COUNT(*) FROM one_way_pile_on        WHERE detected_at < $1)::text AS pile_on,
		   (SELECT COUNT(*) FROM review_concentration   WHERE detected_at < $1)::text AS concentration`,
		[cutoff]
	);
	const row = r.rows[0];
	return {
		reciprocity: Number(row?.reciprocity ?? 0),
		related: Number(row?.related ?? 0),
		pile_on: Number(row?.pile_on ?? 0),
		concentration: Number(row?.concentration ?? 0)
	};
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

/** Signal C — one-way pile-on. Subject-centric: a cluster of reviewers
 *  attacking one subject. Rendered as a pair (subject, attacker) so it fits the
 *  same shape as A/B and can be cleared with the same command.
 *
 *  v1.8.12 (Ken) — C and D were never listed by `morphit-ops moderation`, which
 *  queried only suspicious_reciprocity and related_accounts. They suppress
 *  reputation exactly like A and B, so an operator saw "0 flags" while a
 *  reputation sat suppressed. That is what cost Ken an afternoon. */
export async function fetchPileOnFlags(
	db: Database,
	cutoff: Date,
	limit: number
): Promise<RelatedFlag[]> {
	const r = await db.query<RelatedFlag>(
		`SELECT owpo.subject AS account_a,
		        attacker->>'reviewer' AS account_b,
		        owpo.detected_at,
		        'one-way pile-on: ' || (attacker->>'reviewer') || ' → ' || owpo.subject AS reason
		   FROM one_way_pile_on owpo,
		        jsonb_array_elements(owpo.attacking_reviewers) attacker
		  WHERE owpo.detected_at >= $1
		  ORDER BY owpo.detected_at DESC
		  LIMIT $2`,
		[cutoff, limit]
	);
	return r.rows;
}

/** Signal D — review concentration. Directional (reviewer → dominant_subject);
 *  reported as the pair so it reads like the others. */
export async function fetchConcentrationFlags(
	db: Database,
	cutoff: Date,
	limit: number
): Promise<RelatedFlag[]> {
	const r = await db.query<RelatedFlag>(
		`SELECT reviewer AS account_a,
		        dominant_subject AS account_b,
		        detected_at,
		        'review concentration: ' || concentration_pct || '% of '
		          || review_count || ' reviews on one subject' AS reason
		   FROM review_concentration
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

/** Every signal that can suppress a reputation. All four are clearable as of
 *  v1.8.12; before that only the first two were, which made C and D permanent. */
export type ModerationSignal = 'reciprocity' | 'related' | 'pile_on' | 'concentration';

const SIGNAL_TABLE: Record<ModerationSignal, string> = {
	reciprocity: 'suspicious_reciprocity',
	related: 'related_accounts',
	pile_on: 'one_way_pile_on',
	concentration: 'review_concentration'
};

/** The two columns holding the pair, per table. */
const SIGNAL_PAIR_COLUMNS: Record<ModerationSignal, readonly [string, string]> = {
	reciprocity: ['account_a', 'account_b'],
	related: ['account_a', 'account_b'],
	pile_on: ['subject', 'subject'],
	concentration: ['reviewer', 'dominant_subject']
};

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
		readonly signal: ModerationSignal;
		readonly accountA: string;
		readonly accountB: string;
		readonly note: string;
	}
): Promise<{ readonly cleared: number }> {
	const a = params.accountA.toLowerCase();
	const b = params.accountB.toLowerCase();
	const [lo, hi] = a < b ? [a, b] : [b, a];
	// v1.8.12 (Ken) — all FOUR signals, not two. Signals C and D suppress
	// reputation exactly like A and B, but had no clearance path at all: the
	// operator could not see them in `morphit-ops moderation` and could not
	// clear them, so a false positive suppressed a reputation permanently.
	// Deleting the row by hand did not help either — the detector simply
	// re-created it on the next pass (which is what Ken observed).
	const table = SIGNAL_TABLE[params.signal];

	// Signal B is behavioural, so capture WHERE the pair stands at clear time.
	// The detector forgives everything up to this mark and re-fires once they
	// add another full signal's worth on top — past forgiven, future watched.
	// Signal A keys on immutable account-creation facts, so it has no watermark
	// and its clearance is permanent; a re-arming one would re-flag the same
	// pair forever on evidence that can never change.
	let watermark: number | null = null;
	// v1.8.12 — Signal D is BEHAVIOURAL like Signal B, so its clearance must
	// re-arm too: forgive the concentration accumulated so far, but re-flag if
	// the pair keeps concentrating beyond it. A NULL watermark here would make
	// the clearance permanent, which is right for Signal A (immutable
	// account-creation facts) and wrong for a pattern that can resume.
	// Directional table, so take the higher of the two orientations — the pair
	// is what was cleared, not one direction of it.
	if (params.signal === 'concentration') {
		const cur = await db.query(
			`SELECT MAX(review_count) AS review_count FROM review_concentration
			  WHERE (reviewer = $1 AND dominant_subject = $2)
			     OR (reviewer = $2 AND dominant_subject = $1)`,
			[lo, hi]
		);
		const row = cur.rows[0] as { review_count?: number | null } | undefined;
		watermark = typeof row?.review_count === 'number' ? row.review_count : 0;
	}
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
	// Column names differ per table: A/B use (account_a, account_b); D uses
	// (reviewer, dominant_subject) and is DIRECTIONAL, so both orientations are
	// removed — the pair is what the operator cleared, not one direction of it.
	const cols = SIGNAL_PAIR_COLUMNS[params.signal];
	const del = await db.query(
		`DELETE FROM ${table} WHERE (${cols[0]} = $1 AND ${cols[1]} = $2)
		                         OR (${cols[0]} = $2 AND ${cols[1]} = $1)`,
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
		readonly signal: ModerationSignal;
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
