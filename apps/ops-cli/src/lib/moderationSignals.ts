/**
 * Moderation signal access (beta5) — shared by the merged `moderation`
 * screen, the main menu's "⚠ N to review" marker, and `flags` / `abuse`.
 *
 * ONE window and ONE set of signals for all of them (review, 2026-10-29: the
 * menu counted 2 signals over 30 days, the screen listed 4 over 7 days, so the
 * menu said "⚠ 2 to review" and the screen "0 flags"). The default is ALL TIME
 * (DEFAULT_MODERATION_SINCE): suppression is not time-limited, so every flag
 * still in the tables is one the operator may need to act on. Pile-on flags
 * (Signal C) are counted and listed per (subject, attacker) pair everywhere.
 *
 * The indexer raises four account-level abuse signals (A–D below; C and D
 * were added after this note was first written):
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

/** The window every moderation view uses unless told otherwise: all time. */
export const DEFAULT_MODERATION_SINCE = 'all';

/** The cutoff for a `--since` spec: null = no window (all time). PURE. */
export function cutoffFor(sinceSpec: string, sinceSec: number, now = Date.now()): Date | null {
	return sinceSpec.trim().toLowerCase() === 'all' ? null : new Date(now - sinceSec * 1000);
}

/** "all time" or "last 7d", for headings. PURE. */
export function windowLabel(
	cutoff: Date | null,
	sinceSec: number,
	fmt: (s: number) => string
): string {
	return cutoff === null ? 'all time' : `last ${fmt(sinceSec)}`;
}

export async function fetchReciprocityFlags(
	db: Database,
	cutoff: Date | null,
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
		 WHERE ($1::timestamptz IS NULL OR detected_at >= $1)
		 ORDER BY detected_at DESC
		 LIMIT $2`,
		[cutoff, limit]
	);
	return r.rows;
}

/** Every flag as a (signal, a, b) pair, newest pile-on row per pair — the one
 *  definition the counts below share. `$1` is the cutoff (NULL: all time). */
const FLAG_PAIRS_SQL = `
	SELECT 'reciprocity'::text AS signal, account_a AS a, account_b AS b
	  FROM suspicious_reciprocity WHERE ($1::timestamptz IS NULL OR detected_at >= $1)
	UNION ALL
	SELECT 'related', account_a, account_b
	  FROM related_accounts WHERE ($1::timestamptz IS NULL OR detected_at >= $1)
	UNION ALL
	SELECT DISTINCT 'pile_on', owpo.subject, attacker->>'reviewer'
	  FROM one_way_pile_on owpo, jsonb_array_elements(owpo.attacking_reviewers) attacker
	 WHERE ($1::timestamptz IS NULL OR owpo.detected_at >= $1)
	UNION ALL
	SELECT 'concentration', reviewer, dominant_subject
	  FROM review_concentration WHERE ($1::timestamptz IS NULL OR detected_at >= $1)`;

export interface FlagCounts {
	readonly reciprocity: number;
	readonly related: number;
	readonly pile_on: number;
	readonly concentration: number;
	readonly total: number;
	/** Flags where NEITHER account is blocked on this instance by `operator`:
	 *  the ones the operator has not acted on. The menu's "⚠ N to review". */
	readonly unresolved: number;
}

/** Exact counts per signal in the window (not capped like the lists), and how
 *  many are unresolved. The menu marker and the screen both use this. */
export async function countFlags(
	db: Database,
	operator: string,
	cutoff: Date | null
): Promise<FlagCounts> {
	const r = await db.query<{ signal: string; total: string; unresolved: string }>(
		`WITH pairs AS (${FLAG_PAIRS_SQL})
		 SELECT signal,
		        count(*)::text AS total,
		        count(*) FILTER (WHERE NOT EXISTS (
		          SELECT 1 FROM operator_blocks ob
		           WHERE ob.operator = $2 AND ob.state = 'blocked'
		             AND ob.blocked IN (pairs.a, pairs.b)))::text AS unresolved
		   FROM pairs GROUP BY signal`,
		[cutoff, operator]
	);
	const by = new Map(r.rows.map((x) => [x.signal, x]));
	const n = (sig: string): number => Number(by.get(sig)?.total ?? 0);
	return {
		reciprocity: n('reciprocity'),
		related: n('related'),
		pile_on: n('pile_on'),
		concentration: n('concentration'),
		total: r.rows.reduce((t, x) => t + Number(x.total), 0),
		unresolved: r.rows.reduce((t, x) => t + Number(x.unresolved), 0)
	};
}

/** How many flags are ACTIVE but fall outside the display window.
 *
 *  v1.8.12 — THE OPERATOR BLIND SPOT. The flag lists above are windowed
 *  (`WHERE detected_at >= $1`, default 7d), but the reputation suppression in
 *  `apps/indexer/src/api/feedback.ts` has NO time filter: any row in these
 *  tables excludes that pair's feedback from the score forever. So a flag older
 *  than the window keeps a reputation suppressed while being INVISIBLE to the
 *  operator — who then cannot clear what they cannot see.
 *
 *  The maintainer hit this precisely: `morphit-ops moderation` reported "0 flags
 *  (0 reciprocity, 0 related-account)" while @tester3's reputation card showed
 *  every review excluded. Reproduced against real Postgres: operator view 0,
 *  enforcement 1, resulting score count 0.
 *
 *  Reported as a count rather than silently widening the window: the window is
 *  a useful triage default, and quietly changing it would trade one surprise
 *  for another. The operator is told what is hidden and how to see it. */
export async function countActiveFlagsOutsideWindow(
	db: Database,
	cutoff: Date | null
): Promise<{ reciprocity: number; related: number; pile_on: number; concentration: number }> {
	if (cutoff === null) return { reciprocity: 0, related: 0, pile_on: 0, concentration: 0 };
	// Pile-on per (subject, attacker) pair whose NEWEST row is older than the
	// window — the same unit the lists and the menu count.
	const r = await db.query<{
		reciprocity: string;
		related: string;
		pile_on: string;
		concentration: string;
	}>(
		`SELECT
		   (SELECT COUNT(*) FROM suspicious_reciprocity WHERE detected_at < $1)::text AS reciprocity,
		   (SELECT COUNT(*) FROM related_accounts       WHERE detected_at < $1)::text AS related,
		   (SELECT COUNT(*) FROM (
		      SELECT owpo.subject, attacker->>'reviewer'
		        FROM one_way_pile_on owpo, jsonb_array_elements(owpo.attacking_reviewers) attacker
		       GROUP BY 1, 2 HAVING max(owpo.detected_at) < $1) p)::text AS pile_on,
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
	cutoff: Date | null,
	limit: number
): Promise<RelatedFlag[]> {
	const r = await db.query<RelatedFlag>(
		`SELECT account_a, account_b, detected_at, reason
		 FROM related_accounts
		 WHERE ($1::timestamptz IS NULL OR detected_at >= $1)
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
 *  v1.8.12 — C and D were never listed by `morphit-ops moderation`, which
 *  queried only suspicious_reciprocity and related_accounts. They suppress
 *  reputation exactly like A and B, so an operator saw "0 flags" while a
 *  reputation sat suppressed. That is what cost the maintainer an afternoon. */
export async function fetchPileOnFlags(
	db: Database,
	cutoff: Date | null,
	limit: number
): Promise<RelatedFlag[]> {
	// One line per (subject, attacker) pair — its newest detection — as the
	// counts count them (a pile-on re-detected on a later day is one flag).
	const r = await db.query<RelatedFlag>(
		`SELECT account_a, account_b, detected_at, reason FROM (
		   SELECT DISTINCT ON (owpo.subject, attacker->>'reviewer')
		          owpo.subject AS account_a,
		          attacker->>'reviewer' AS account_b,
		          owpo.detected_at,
		          'one-way pile-on: ' || (attacker->>'reviewer') || ' → ' || owpo.subject AS reason
		     FROM one_way_pile_on owpo,
		          jsonb_array_elements(owpo.attacking_reviewers) attacker
		    WHERE ($1::timestamptz IS NULL OR owpo.detected_at >= $1)
		    ORDER BY owpo.subject, attacker->>'reviewer', owpo.detected_at DESC) p
		  ORDER BY detected_at DESC
		  LIMIT $2`,
		[cutoff, limit]
	);
	return r.rows;
}

/** Signal D — review concentration. Directional (reviewer → dominant_subject);
 *  reported as the pair so it reads like the others. */
export async function fetchConcentrationFlags(
	db: Database,
	cutoff: Date | null,
	limit: number
): Promise<RelatedFlag[]> {
	const r = await db.query<RelatedFlag>(
		`SELECT reviewer AS account_a,
		        dominant_subject AS account_b,
		        detected_at,
		        'review concentration: ' || concentration_pct || '% of '
		          || review_count || ' reviews on one subject' AS reason
		   FROM review_concentration
		  WHERE ($1::timestamptz IS NULL OR detected_at >= $1)
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

/** The two columns holding the pair, per table. Pile-on is not here: its pair
 *  is (subject, one entry of attacking_reviewers) — see clearPileOnPair. (It was
 *  ['subject', 'subject'], so clearing deleted rows WHERE subject = a AND
 *  subject = b — never any; review 2026-10-29.) */
const SIGNAL_PAIR_COLUMNS: Record<
	Exclude<ModerationSignal, 'pile_on'>,
	readonly [string, string]
> = {
	reciprocity: ['account_a', 'account_b'],
	related: ['account_a', 'account_b'],
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
	// v1.8.12 — all FOUR signals, not two. Signals C and D suppress
	// reputation exactly like A and B, but had no clearance path at all: the
	// operator could not see them in `morphit-ops moderation` and could not
	// clear them, so a false positive suppressed a reputation permanently.
	// Deleting the row by hand did not help either — the detector simply
	// re-created it on the next pass (which is what the maintainer observed).
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
	if (params.signal === 'pile_on') return { cleared: await clearPileOnPair(db, lo, hi) };
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

/** Signal C, cleared for one pair: take the attacker out of
 *  attacking_reviewers in every pile-on row against the subject (either name
 *  may be the subject), and delete a row left with no attacker. The read paths
 *  (feedbackPairCountsSql) exclude a review only while its reviewer is listed
 *  there, so this restores it at once. Returns the attacker entries removed. */
async function clearPileOnPair(db: Database, lo: string, hi: string): Promise<number> {
	const r = await db.query<{ cleared: string }>(
		`WITH hit AS (
		   SELECT o.id,
		          (SELECT COALESCE(jsonb_agg(e), '[]'::jsonb)
		             FROM jsonb_array_elements(o.attacking_reviewers) e
		            WHERE lower(e->>'reviewer') IS DISTINCT FROM
		                  (CASE WHEN lower(o.subject) = $1 THEN $2 ELSE $1 END)) AS rest,
		          (SELECT count(*)
		             FROM jsonb_array_elements(o.attacking_reviewers) e
		            WHERE lower(e->>'reviewer') =
		                  (CASE WHEN lower(o.subject) = $1 THEN $2 ELSE $1 END)) AS removed
		     FROM one_way_pile_on o
		    WHERE lower(o.subject) IN ($1, $2)
		 ), upd AS (
		   UPDATE one_way_pile_on o SET attacking_reviewers = hit.rest
		     FROM hit
		    WHERE o.id = hit.id AND hit.removed > 0 AND jsonb_array_length(hit.rest) > 0
		   RETURNING hit.removed
		 ), del AS (
		   DELETE FROM one_way_pile_on o USING hit
		    WHERE o.id = hit.id AND hit.removed > 0 AND jsonb_array_length(hit.rest) = 0
		   RETURNING hit.removed
		 )
		 SELECT (COALESCE((SELECT sum(removed) FROM upd), 0)
		       + COALESCE((SELECT sum(removed) FROM del), 0))::text AS cleared`,
		[lo, hi]
	);
	return Number(r.rows[0]?.cleared ?? 0);
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
	readonly signal: ModerationSignal;
	readonly account_a: string;
	readonly account_b: string;
	readonly watermark: number | null;
	readonly note: string;
	readonly cleared_at: Date;
}
