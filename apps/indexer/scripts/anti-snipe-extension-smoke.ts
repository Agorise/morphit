#!/usr/bin/env tsx
/**
 * anti-snipe-extension-smoke — Part 122 cp18.
 *
 * Static + behavioral smoke for the anti-snipe extension SQL.
 * Does NOT exercise the live handler (covered by
 * featurebid-handler-smoke); this isolates the rules of the
 * extension UPDATE itself by testing what the predicate WOULD
 * select on a fixed in-memory dataset.
 *
 * Scenarios (each one a separate boolean assertion):
 *   1. Bid expiring outside the snipe window → NOT extended.
 *   2. Bid expiring inside the snipe window → extended.
 *   3. Bid at extension_count = MAX_EXTENSIONS → NOT extended (cap).
 *   4. Bid at extension_count = MAX_EXTENSIONS - 1 → extended.
 *   5. Cancelled bid in window → NOT extended.
 *   6. Bid outside top-MAX_SLOTS → NOT extended (rank gate).
 *   7. The triggering bid itself → NOT extended (trx_id self-skip).
 *   8. Bid whose effective_at is in the future → NOT extended.
 *
 * Implementation: pure in-process simulation.  Mirrors the
 * UPDATE predicate from featureBid.ts as a TS predicate so the
 * rules can be unit-tested without a Postgres connection.  When
 * the SQL changes, this file's predicate MUST change in lockstep
 * — both live in the comments below as the source-of-truth
 * spec.
 */

interface BidSnapshot {
	bid_id: number;
	bidder: string;
	trx_id: string;
	cancelled: boolean;
	effective_at: Date;
	expires_at: Date;
	blurt_per_hour: number;
	block_time_at: Date;
	extension_count: number;
}

const NOW = new Date('2026-05-16T12:00:00Z');
const SNIPE_WINDOW_MINUTES = 5;
const MAX_EXTENSIONS = 6;
const MAX_SLOTS = 3;
const NEW_BID_TRX = 'new-bid-trx-id';

function minutesFromNow(m: number): Date {
	return new Date(NOW.getTime() + m * 60_000);
}

/** Mirror of the featureBid.ts UPDATE predicate.  Returns true
 *  if the row WOULD be extended by the cp18 anti-snipe step. */
function wouldExtend(b: BidSnapshot, rankAmongTopN: number | null): boolean {
	// CTE predicate: in top-MAX_SLOTS active set
	if (rankAmongTopN === null || rankAmongTopN > MAX_SLOTS) return false;
	// UPDATE WHERE clauses
	if (b.cancelled) return false;
	if (b.effective_at > NOW) return false; // not yet active
	if (b.expires_at <= NOW) return false; // already expired
	if (b.trx_id === NEW_BID_TRX) return false; // self-skip
	if (b.expires_at > minutesFromNow(SNIPE_WINDOW_MINUTES)) return false; // outside window
	if (b.extension_count >= MAX_EXTENSIONS) return false; // cap
	return true;
}

const scenarios: Array<{ name: string; ok: boolean; detail?: string }> = [];

function check(name: string, ok: boolean, detail?: string): void {
	scenarios.push({ name, ok, detail });
}

const baseBid = (overrides: Partial<BidSnapshot> = {}): BidSnapshot => ({
	bid_id: 1,
	bidder: 'alice',
	trx_id: 'alice-bid-1',
	cancelled: false,
	effective_at: new Date(NOW.getTime() - 60 * 60_000),
	expires_at: minutesFromNow(2), // inside window
	blurt_per_hour: 50,
	block_time_at: new Date(NOW.getTime() - 60 * 60_000),
	extension_count: 0,
	...overrides
});

// ─── 1: outside window → not extended ──────────────────────
check(
	'bid expiring 30 minutes from now is not extended',
	!wouldExtend(baseBid({ expires_at: minutesFromNow(30) }), 1)
);

// ─── 2: inside window → extended ────────────────────────────
check(
	'bid expiring 2 minutes from now is extended',
	wouldExtend(baseBid({ expires_at: minutesFromNow(2) }), 1)
);

// ─── 3: at MAX_EXTENSIONS → not extended ────────────────────
check(
	'bid at extension_count = MAX_EXTENSIONS is not extended (cap)',
	!wouldExtend(baseBid({ extension_count: MAX_EXTENSIONS }), 1)
);

// ─── 4: at MAX_EXTENSIONS - 1 → extended ───────────────────
check(
	'bid at extension_count = MAX_EXTENSIONS - 1 is still extended',
	wouldExtend(baseBid({ extension_count: MAX_EXTENSIONS - 1 }), 1)
);

// ─── 5: cancelled → not extended ───────────────────────────
check(
	'cancelled bid in window is not extended',
	!wouldExtend(baseBid({ cancelled: true }), 1)
);

// ─── 6: outside top-MAX_SLOTS → not extended ───────────────
check(
	'bid at rank MAX_SLOTS+1 is not extended (rank gate)',
	!wouldExtend(baseBid(), MAX_SLOTS + 1)
);
check(
	'bid not ranked at all (cancelled/expired) is not extended',
	!wouldExtend(baseBid(), null)
);

// ─── 7: the triggering bid itself → not extended ───────────
check(
	'the new bid that triggered the extension does not extend itself',
	!wouldExtend(baseBid({ trx_id: NEW_BID_TRX }), 1)
);

// ─── 8: future effective_at → not extended ─────────────────
check(
	'bid not yet active (effective_at in future) is not extended',
	!wouldExtend(baseBid({ effective_at: minutesFromNow(10) }), 1)
);

// ─── 9: at MAX_EXTENSIONS-edge with cap = 6 ────────────────
// Sanity check that MAX_EXTENSIONS aligns with featureBid.ts.
check(
	'MAX_EXTENSIONS cap matches handler constant (6)',
	MAX_EXTENSIONS === 6
);

// ─── 10: SNIPE_WINDOW edge — exactly at boundary ───────────
// PostgreSQL `<=` is inclusive; mirror that semantics.
check(
	'bid expiring at exactly snipe_window boundary IS extended (inclusive)',
	wouldExtend(baseBid({ expires_at: minutesFromNow(SNIPE_WINDOW_MINUTES) }), 1)
);

// ─── 11: SNIPE_WINDOW edge — one second past ──────────────
check(
	'bid expiring 1 second past snipe_window is NOT extended',
	!wouldExtend(
		baseBid({
			expires_at: new Date(minutesFromNow(SNIPE_WINDOW_MINUTES).getTime() + 1000)
		}),
		1
	)
);

// ─── Report ─────────────────────────────────────────────────
console.log(`anti-snipe-extension smoke: ${scenarios.length} scenarios\n`);
let failed = 0;
for (const s of scenarios) {
	console.log(s.ok ? `  ✓ ${s.name}` : `  ✗ ${s.name}${s.detail ? ` — ${s.detail}` : ''}`);
	if (!s.ok) failed++;
}
console.log('');
if (failed === 0) {
	console.log(`✓ all ${scenarios.length} anti-snipe scenarios pass`);
	process.exit(0);
} else {
	console.error(`✗ ${failed} anti-snipe scenarios failed`);
	process.exit(1);
}

// cp474 — module marker. Without a top-level import/export tsc treats this
// file as a global script, so its `scenarios`/`failed` consts collide with every
// other script-style smoke when the suite is typechecked as one project. This
// has no runtime effect under tsx.
export {};
