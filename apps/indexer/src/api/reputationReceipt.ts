/**
 * Morphit indexer — /v1/accounts/:account/reputation-receipt
 *
 * The "show your work" endpoint (cp124, H4).  Returns the FULL set
 * of inputs that go into the published weighted_rating, so any
 * third party can re-derive the score locally and verify it matches.
 *
 * WHY THIS ENDPOINT EXISTS
 * ────────────────────────
 * Pre-cp124, a reader trusted the indexer's weighted_rating output
 * blindly.  Different indexers maintain their own signal tables
 * (suspicious_reciprocity, related_accounts, one_way_pile_on,
 * review_concentration), so two indexers viewing the same chain
 * state could publish slightly-different scores for the same
 * account based on which signals each had detected locally.
 *
 * The receipt endpoint exposes:
 *   1. Every feedback row about the subject (including filtered ones)
 *   2. Each row's exclusion reason if filtered (or null if counted)
 *   3. Each row's age and decay weight at the `as_of` moment
 *   4. The computed weighted_rating + the formula used
 *   5. The decay half-life used
 *
 * A reader can:
 *   - Independently fetch the chain feedback ops for this account
 *   - Apply the documented exclusion rules
 *   - Run `computeWeightedRating()` from
 *     apps/indexer/src/indexer/reputation/decay.ts
 *   - Verify the score matches
 *
 * Without this endpoint, "provable reputation" requires running an
 * indexer.  WITH this endpoint, "provable reputation" requires only
 * the ability to read the chain.
 *
 * AS_OF PARAMETER
 * ───────────────
 * Default: NOW() (current wall clock).
 *
 * Optional: any ISO timestamp.  Used for deterministic comparison
 * (e.g. archival re-verification).  Note: signal-table flags are
 * snapshotted at REQUEST time (we don't time-travel the flags
 * backward to match historic `as_of` queries) — so as_of in the
 * past will use TODAY's flag set against historic feedback ages.
 * This limitation is documented; future enhancement could store
 * signal-table history with detection timestamps.
 *
 * PRIVACY POSTURE
 * ───────────────
 * The receipt for account X reveals which (X, Y) pairs are flagged
 * by the signal tables.  This information is already implicitly
 * visible to anyone viewing X's profile (the flagged feedback
 * doesn't appear in the aggregate).  No new privacy leak.
 *
 * The receipt does NOT reveal flags for pairs (Y, Z) that don't
 * involve X.  Each account's receipt is scoped to its own
 * relationships.
 *
 * HONEST LIMITATIONS
 * ──────────────────
 * - For deterministic verification, both parties must agree on:
 *   (a) the chain feedback ops (immutable on Blurt — OK)
 *   (b) the signal-table state (per-indexer — receipt exposes ours)
 *   (c) the as_of timestamp (caller-controlled — OK)
 *   (d) the decay formula (documented constant — OK)
 * - Two indexers with different signal-table states will produce
 *   different receipts.  Comparing receipts across indexers
 *   surfaces the disagreement explicitly — better than silently
 *   showing different numbers in the headline UI.
 */

import { Hono } from 'hono';
import { z } from 'zod';

import type { Database } from '$db/pool';
import { errorBody, isAccountName } from '$api/shared';
import {
	reputationDecayWeight,
	REPUTATION_DECAY_HALF_LIFE_DAYS
} from '$indexer/reputation/decay';

const querySchema = z.object({
	as_of: z.string().datetime().optional()
});

/** Exclusion reason — null means the row counts toward the score. */
type ExclusionReason =
	| null
	| 'no_order_permlink'
	| 'suspicious_reciprocity'
	| 'related_accounts'
	| 'one_way_pile_on'
	| 'review_concentration';

interface ReceiptRow {
	source_trx_id: string;
	reviewer: string;
	rating: number;
	created_at: string; // ISO
	order_permlink: string | null;
	age_days: number;
	decay_weight: number;
	included: boolean;
	excluded_reason: ExclusionReason;
}

interface ReceiptResponse {
	account: string;
	as_of: string; // ISO
	decay_half_life_days: number;
	formula: string;
	summary: {
		count_total: number; // ALL feedback rows about this subject
		count_included: number; // rows that count toward weighted_rating
		count_excluded: number;
		weight_sum: number; // sum of decay weights of included rows
		weighted_rating: number | null; // null when count_included = 0
	};
	rows: ReceiptRow[];
}

interface FeedbackQueryRow {
	source_trx_id: string;
	reviewer: string;
	subject: string;
	rating: number;
	created_at: Date;
	order_permlink: string | null;
}

/** Membership-test helper: does (reviewer, subject) appear in the
 *  given signal-table set?  Both tables use canonical (a < b)
 *  ordering; we canonicalize the lookup key. */
function isFlaggedPair(
	set: Set<string>,
	reviewer: string,
	subject: string
): boolean {
	const [a, b] = reviewer < subject ? [reviewer, subject] : [subject, reviewer];
	return set.has(`${a}|${b}`);
}

export function reputationReceiptRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/:account/reputation-receipt', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		const parsed = querySchema.safeParse(
			Object.fromEntries(new URL(c.req.url).searchParams)
		);
		if (!parsed.success) {
			return c.json(
				errorBody('bad_request', parsed.error.issues.map((i) => i.message).join('; ')),
				400
			);
		}

		const asOf = parsed.data.as_of ? new Date(parsed.data.as_of) : new Date();
		if (Number.isNaN(asOf.getTime())) {
			return c.json(errorBody('bad_request', 'invalid as_of timestamp'), 400);
		}

		// ─── Pull every feedback row about the subject ─────────────
		// No ordering or pagination — receipts are inherently
		// proportional to the feedback count.  A subject with 10,000
		// reviews has a 10,000-row receipt; that's the cost of
		// transparency.  Future versions could paginate but the
		// formula relies on summing across ALL rows so any partial
		// receipt would need to surface that limitation explicitly.
		const rowsRes = await db.query<FeedbackQueryRow>(
			`SELECT source_trx_id, reviewer, subject, rating, created_at, order_permlink
			   FROM feedback
			  WHERE subject = $1
			  ORDER BY created_at ASC, id ASC`,
			[account]
		);

		// ─── Pull flag sets in parallel ─────────────────────────────
		// All four signal tables are queried; for each, build a set
		// of canonical "a|b" pair strings for O(1) membership tests.
		const [sr, ra, owpo, rc] = await Promise.all([
			db.query<{ account_a: string; account_b: string }>(
				`SELECT account_a, account_b FROM suspicious_reciprocity
				  WHERE account_a = $1 OR account_b = $1`,
				[account]
			),
			db.query<{ account_a: string; account_b: string }>(
				`SELECT account_a, account_b FROM related_accounts
				  WHERE account_a = $1 OR account_b = $1`,
				[account]
			),
			db.query<{ reviewer: string }>(
				`SELECT attacker->>'reviewer' AS reviewer
				   FROM one_way_pile_on,
				        jsonb_array_elements(attacking_reviewers) attacker
				  WHERE subject = $1`,
				[account]
			),
			db.query<{ reviewer: string; dominant_subject: string }>(
				`SELECT reviewer, dominant_subject FROM review_concentration
				  WHERE dominant_subject = $1`,
				[account]
			)
		]);

		const srSet = new Set(sr.rows.map((r) => `${r.account_a}|${r.account_b}`));
		const raSet = new Set(ra.rows.map((r) => `${r.account_a}|${r.account_b}`));
		const owpoSet = new Set(owpo.rows.map((r) => r.reviewer));
		const rcSet = new Set(rc.rows.map((r) => r.reviewer));

		// ─── Annotate each row + compute weighted rating ────────────
		const asOfMs = asOf.getTime();
		const MS_PER_DAY = 24 * 60 * 60 * 1000;
		let countIncluded = 0;
		let weightSum = 0;
		let weightedSum = 0;
		const receiptRows: ReceiptRow[] = [];

		for (const row of rowsRes.rows) {
			const ageMs = Math.max(0, asOfMs - row.created_at.getTime());
			const ageDays = ageMs / MS_PER_DAY;
			const weight = reputationDecayWeight(ageMs);

			let reason: ExclusionReason = null;
			if (row.order_permlink === null) {
				reason = 'no_order_permlink';
			} else if (isFlaggedPair(srSet, row.reviewer, row.subject)) {
				reason = 'suspicious_reciprocity';
			} else if (isFlaggedPair(raSet, row.reviewer, row.subject)) {
				reason = 'related_accounts';
			} else if (owpoSet.has(row.reviewer)) {
				reason = 'one_way_pile_on';
			} else if (rcSet.has(row.reviewer)) {
				reason = 'review_concentration';
			}

			const included = reason === null;
			if (included) {
				countIncluded++;
				weightSum += weight;
				weightedSum += row.rating * weight;
			}

			receiptRows.push({
				source_trx_id: row.source_trx_id,
				reviewer: row.reviewer,
				rating: row.rating,
				created_at: row.created_at.toISOString(),
				order_permlink: row.order_permlink,
				age_days: Math.round(ageDays * 100) / 100,
				decay_weight: Math.round(weight * 100000) / 100000,
				included,
				excluded_reason: reason
			});
		}

		const weightedRating =
			weightSum > 0 ? Math.round((weightedSum / weightSum) * 100) / 100 : null;

		const response: ReceiptResponse = {
			account,
			as_of: asOf.toISOString(),
			decay_half_life_days: REPUTATION_DECAY_HALF_LIFE_DAYS,
			formula:
				'weighted_rating = SUM(rating × decay_weight) / SUM(decay_weight) ' +
				'where decay_weight = 0.5 ^ (age_days / decay_half_life_days). ' +
				'Rows excluded when order_permlink is null OR the (reviewer, subject) pair ' +
				'is in suspicious_reciprocity OR related_accounts OR one_way_pile_on.attacking_reviewers ' +
				'OR review_concentration with dominant_subject = subject. ' +
				'See apps/indexer/src/indexer/reputation/decay.ts and ADR-0038.',
			summary: {
				count_total: rowsRes.rows.length,
				count_included: countIncluded,
				count_excluded: rowsRes.rows.length - countIncluded,
				weight_sum: Math.round(weightSum * 100000) / 100000,
				weighted_rating: weightedRating
			},
			rows: receiptRows
		};

		// ETag based on the rows' source_trx_id list + as_of, so
		// caches can validate without re-downloading.  Cheap to
		// compute; ~32 chars hex.
		const etagInput =
			account + '|' + asOf.toISOString() + '|' + receiptRows.map((r) => r.source_trx_id).join(',');
		const etag = `"${simpleHash(etagInput)}"`;
		c.header('ETag', etag);
		c.header('Cache-Control', 'public, max-age=60');

		const ifNoneMatch = c.req.header('if-none-match');
		if (ifNoneMatch === etag) {
			return c.body(null, 304);
		}

		return c.json(response);
	});

	return app;
}

/** Cheap deterministic hash for ETag — not cryptographic.
 *  djb2 variant; 32-bit hex string. */
function simpleHash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) {
		h = ((h * 33) ^ s.charCodeAt(i)) | 0;
	}
	return (h >>> 0).toString(16).padStart(8, '0');
}
