import { describe, expect, it } from 'vitest';

import {
	detectSuspiciousReciprocityInTx,
	detectRelatedAccountsInTx,
	detectOneWayPileOnInTx
} from '$indexer/signals';
import { makeMockClient } from '../testutils/mockClient';

describe('detectSuspiciousReciprocityInTx', () => {
	it('calls the detector SQL with expected thresholds', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO suspicious_reciprocity', rowCount: 0 }]);
		const inserted = await detectSuspiciousReciprocityInTx(mock.client);
		expect(inserted).toBe(0);
		expect(mock.queries).toHaveLength(1);
		// Thresholds threaded via $1 = minCount, $2 = avgRating.
		expect(mock.queries[0]!.params[0]).toBe(3);
		expect(mock.queries[0]!.params[1]).toBe(4.8);
	});

	it('returns the rowCount of newly inserted pairs', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO suspicious_reciprocity', rowCount: 2 }]);
		const inserted = await detectSuspiciousReciprocityInTx(mock.client);
		expect(inserted).toBe(2);
	});

	it('uses a 7-day window in the CTE', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO suspicious_reciprocity', rowCount: 0 }]);
		await detectSuspiciousReciprocityInTx(mock.client);
		// Spot-check that the SQL contains the 7-day interval
		// literal. Changing the window is a product decision and
		// should require an ADR edit plus test update.
		expect(mock.queries[0]!.text).toContain("INTERVAL '7 days'");
	});

	it('canonical-orders pairs (account_a < account_b)', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO suspicious_reciprocity', rowCount: 0 }]);
		await detectSuspiciousReciprocityInTx(mock.client);
		// Enforce the a < b canonical ordering in the WHERE clause
		// so each pair inserts only once regardless of which direction
		// matched first.
		expect(mock.queries[0]!.text).toContain('a.reviewer < a.subject');
	});

	it('filters to single-subject reviewers (no third-party feedback)', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO suspicious_reciprocity', rowCount: 0 }]);
		await detectSuspiciousReciprocityInTx(mock.client);
		// The "no third-party feedback" clause from ADR-0009 §5.
		expect(mock.queries[0]!.text).toContain('distinct_subjects = 1');
	});
});

describe('detectRelatedAccountsInTx', () => {
	it('calls the detector SQL with the proximity-window parameter', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO related_accounts', rowCount: 0 }]);
		const inserted = await detectRelatedAccountsInTx(mock.client);
		expect(inserted).toBe(0);
		expect(mock.queries).toHaveLength(1);
		// 5 minutes → 300 seconds as the proximity threshold.
		expect(mock.queries[0]!.params[0]).toBe(300);
	});

	it('returns the rowCount of newly flagged pairs', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO related_accounts', rowCount: 4 }]);
		expect(await detectRelatedAccountsInTx(mock.client)).toBe(4);
	});

	it('joins on shared creator', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO related_accounts', rowCount: 0 }]);
		await detectRelatedAccountsInTx(mock.client);
		// The join predicate defines the signal: same creator = same
		// purchaser of account-creation. Changing this breaks Signal A.
		expect(mock.queries[0]!.text).toContain('a.creator = b.creator');
	});

	it('canonical-orders pairs with a.name < b.name', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO related_accounts', rowCount: 0 }]);
		await detectRelatedAccountsInTx(mock.client);
		// Dedupe guard — without this, (alice, bob) and (bob, alice)
		// would both match and we'd violate the related_accounts PK.
		expect(mock.queries[0]!.text).toContain('a.name < b.name');
	});

	it('requires both accounts to have first_activity_at set', async () => {
		// An account whose first_activity_at is still NULL hasn't done
		// anything Morphit-visible yet. Signal A shouldn't flag it
		// until it acts.
		const mock = makeMockClient([{ match: 'INSERT INTO related_accounts', rowCount: 0 }]);
		await detectRelatedAccountsInTx(mock.client);
		expect(mock.queries[0]!.text).toContain('a.first_activity_at IS NOT NULL');
		expect(mock.queries[0]!.text).toContain('b.first_activity_at IS NOT NULL');
	});

	it('emits evidence JSONB with creator + gap seconds', async () => {
		// Operators reviewing a flagged pair want to know WHY it was
		// flagged. The evidence field captures the decisive data
		// (creator account, time gap in seconds) without forcing a
		// second query back to `accounts`.
		const mock = makeMockClient([{ match: 'INSERT INTO related_accounts', rowCount: 0 }]);
		await detectRelatedAccountsInTx(mock.client);
		expect(mock.queries[0]!.text).toContain('first_activity_gap_seconds');
	});
});

describe('detectOneWayPileOnInTx (Signal C)', () => {
	it('calls the detector SQL with expected thresholds', async () => {
		const mock = makeMockClient([{ match: 'INSERT INTO one_way_pile_on', rowCount: 0 }]);
		await detectOneWayPileOnInTx(mock.client);
		expect(mock.queries[0]!.text).toContain('INSERT INTO one_way_pile_on');
		// Threshold params bound to literals so tests stay tied to
		// the design constants in signals.ts.
		expect(mock.queries[0]!.params).toEqual([2.0, 2, 3, 14, 7]);
	});

	it('returns the rowCount of newly flagged subjects', async () => {
		const mock = makeMockClient([
			{ match: 'INSERT INTO one_way_pile_on', rowCount: 4 }
		]);
		const flagged = await detectOneWayPileOnInTx(mock.client);
		expect(flagged).toBe(4);
	});

	it('uses a 7-day window for the review pile-on activity', async () => {
		// Threshold tied to ADR-0009 Signal B's existing 7-day window,
		// keeping the operator's mental model consistent.
		const mock = makeMockClient([
			{ match: 'INSERT INTO one_way_pile_on', rowCount: 0 }
		]);
		await detectOneWayPileOnInTx(mock.client);
		expect(mock.queries[0]!.text).toContain("INTERVAL '7 days'");
	});

	it('uses a 30-day window for the reviewer-diversity check', async () => {
		// 30-day window is the false-positive guard: a reviewer with
		// only 1-2 distinct subjects in the last 30 days qualifies as
		// "focused on the target," vs a real user with diverse review
		// history.
		const mock = makeMockClient([
			{ match: 'INSERT INTO one_way_pile_on', rowCount: 0 }
		]);
		await detectOneWayPileOnInTx(mock.client);
		expect(mock.queries[0]!.text).toContain("INTERVAL '30 days'");
	});

	it('requires reviewers to have first_activity_at populated', async () => {
		// Joins through accounts.first_activity_at so the activity-
		// cluster span filter has something to compare.  Reviewers
		// whose first_activity_at is NULL get dropped before the
		// cluster check (defense-in-depth: real users predating our
		// startBlock have no accounts row, so they couldn't be
		// flagged even by accident).
		const mock = makeMockClient([
			{ match: 'INSERT INTO one_way_pile_on', rowCount: 0 }
		]);
		await detectOneWayPileOnInTx(mock.client);
		expect(mock.queries[0]!.text).toContain('first_activity_at IS NOT NULL');
	});

	it('filters on low average rating (≤ 2.0)', async () => {
		// Signal C is the DEFLATION mirror.  A pile-on of 5-star
		// reviews is Signal B's inflation problem; this detector
		// catches 1-2 star clusters.  Per-reviewer avg rating to the
		// target is bounded by SIGNAL_C_MAX_AVG_RATING.
		const mock = makeMockClient([
			{ match: 'INSERT INTO one_way_pile_on', rowCount: 0 }
		]);
		await detectOneWayPileOnInTx(mock.client);
		expect(mock.queries[0]!.text).toContain('avg_rating <= $1');
	});

	it('uses ON CONFLICT to dedupe same-day re-runs', async () => {
		// UNIQUE (subject, detection_date) means re-running the
		// detector the same day doesn't double-flag.  If new attackers
		// appear the next day, a new row is inserted with the
		// expanded set.
		const mock = makeMockClient([
			{ match: 'INSERT INTO one_way_pile_on', rowCount: 0 }
		]);
		await detectOneWayPileOnInTx(mock.client);
		expect(mock.queries[0]!.text).toContain('ON CONFLICT (subject, detection_date) DO NOTHING');
	});

	it('packs reviewer evidence into a JSONB array', async () => {
		// Each row's attacking_reviewers is a JSONB array of objects
		// describing each attacker — operators reviewing a flagged
		// subject want to see WHICH accounts attacked and WHEN.
		// jsonb_agg packs reviewer + rating_avg + count +
		// first_activity_at; jsonb_build_object provides the shape.
		const mock = makeMockClient([
			{ match: 'INSERT INTO one_way_pile_on', rowCount: 0 }
		]);
		await detectOneWayPileOnInTx(mock.client);
		expect(mock.queries[0]!.text).toContain('jsonb_agg');
		expect(mock.queries[0]!.text).toContain("'reviewer'");
		expect(mock.queries[0]!.text).toContain("'rating_avg'");
		expect(mock.queries[0]!.text).toContain("'first_activity_at'");
	});

	it('enforces the activity-cluster span via EXTRACT epoch math', async () => {
		// Cluster span: latest_activity - earliest_activity ≤
		// ACTIVITY_CLUSTER_DAYS in seconds.  The 86400 (seconds/day)
		// multiplier converts the day parameter to the seconds the
		// epoch difference returns.
		const mock = makeMockClient([
			{ match: 'INSERT INTO one_way_pile_on', rowCount: 0 }
		]);
		await detectOneWayPileOnInTx(mock.client);
		expect(mock.queries[0]!.text).toContain('EXTRACT(EPOCH FROM');
		expect(mock.queries[0]!.text).toContain('86400');
	});
});
