/**
 * Morphit indexer — the shared reputation join.
 *
 * The 🌱 new-trader chip, the ⭐ composite reputation score, the trade count and
 * the truncated posting-key anchor are the trust signals a reader uses to size
 * up a counterparty before opening a chat. Every surface that renders an order
 * card must therefore carry the same numbers — a card that shows a score in the
 * orderbook and nothing in the featured strip teaches users the signal is
 * unreliable.
 *
 * The aggregate below is NOT a simple COUNT/AVG: it excludes sock-puppet pairs
 * (suspicious_reciprocity, related_accounts), coordinated pile-ons (Signal C,
 * one_way_pile_on), review-concentration attackers (Signal D,
 * review_concentration), and untethered feedback with no order_permlink. It
 * time-decays ratings on a 365-day half-life. Getting one of those exclusions
 * wrong in a COPY of this SQL would silently publish sock-puppet-inflated
 * reputation on that surface only — so the SQL lives here, once, and callers
 * paste it in rather than re-derive it.
 *
 * Parameter-free by construction: it binds no placeholders, so a caller can
 * splice it into any query without disturbing its own $N numbering.
 */

import { computeReputationScore } from '$indexer/reputation/score';

/**
 * The four sock-puppet / brigading exclusions, plus the trade-bound filter.
 *
 * Written ONCE. Three queries need them: the orderbook + featured aggregate
 * (below), and the RSS feed's count-only `min_trades` subquery. A copy that
 * drifted would publish inflated reputation on whichever surface got the stale
 * clause — and the surfaces are exactly where a stranger sizes up whether to
 * hand a counterparty money.
 *
 * Assumes the feedback table is aliased `fb`.
 *
 *   1. suspicious_reciprocity — repetitive (reviewer, subject) pairs.
 *   2. related_accounts       — known-linked accounts.
 *   3. one_way_pile_on        — Signal C, coordinated pile-on attackers.
 *   4. review_concentration   — Signal D, reviewers who aim >=80% of their
 *                               reviews at a single subject.
 *
 * Also drops feedback with a NULL order_permlink (Finding G2.1): untethered
 * feedback doesn't drive the reputation signal, which closes the "real human
 * Alice writes vague positive feedback for stranger Bob she never traded with"
 * path that sock-puppet detection (which only catches REPETITIVE pairs) misses.
 */
export const FEEDBACK_EXCLUSIONS_SQL = `	    WHERE fb.order_permlink IS NOT NULL
	      AND NOT EXISTS (
	        SELECT 1 FROM suspicious_reciprocity sr
	         WHERE sr.account_a = LEAST(fb.reviewer, fb.subject)
	           AND sr.account_b = GREATEST(fb.reviewer, fb.subject)
	    )
	      AND NOT EXISTS (
	        SELECT 1 FROM related_accounts ra
	         WHERE ra.account_a = LEAST(fb.reviewer, fb.subject)
	           AND ra.account_b = GREATEST(fb.reviewer, fb.subject)
	    )
	      -- Signal C exclusion (Part 113): drop rows from
	      -- coordinated pile-on attackers (see one_way_pile_on
	      -- migration v31 + feedback.ts comments for design).
	      AND NOT EXISTS (
	        SELECT 1 FROM one_way_pile_on owpo,
	                     jsonb_array_elements(owpo.attacking_reviewers) attacker
	         WHERE owpo.subject = fb.subject
	           AND attacker->>'reviewer' = fb.reviewer
	    )
	      -- Signal D exclusion (cp123 H2): drop rows from
	      -- reviewers flagged for concentrating ≥80% of their
	      -- reviews on a single subject (closes Part 113 A4
	      -- residual).  See signals.ts: detectReviewConcentration.
	      AND NOT EXISTS (
	        SELECT 1 FROM review_concentration rc
	         WHERE rc.reviewer = fb.reviewer
	           AND rc.dominant_subject = fb.subject
	    )`;

/**
 * v1.5.5 — COMPLETED-TRADE count per account, sock-puppet filtered.
 *
 * Ken: "if an order was marked as completed (not canceled or expired), then
 * imo that counts as 1 completed trade even if no stars were left." So the
 * trade count is now grounded in COMPLETIONS, not reviews — a real trade where
 * nobody bothered to leave stars still counts, and a zero-review trade never
 * drags a score down (it isn't in the rating average at all).
 *
 * BOTH sides are credited: the order's OWNER, and the `counterparty` the owner
 * named in morphit_order_complete_v1. Without the second half only owners could
 * ever accrue trades — a taker owns no order and would read "0 trades" forever
 * however many trades they completed.
 *
 * EXCLUSIONS (Ken, cp472 tightening #2): the same sock-puppet PAIR signals the
 * rating aggregate applies —
 *   1. suspicious_reciprocity — flagged repetitive pairs
 *   2. related_accounts       — known-linked accounts
 *   3. trade_concentration    — Signal E (v1.5.5), the TRADE analogue of
 *                               Signal D: credits from a peer this account's
 *                               trades are >=80% concentrated on. Closes the
 *                               residual where one verified conversation lets
 *                               a pair mint unlimited trade credit at a
 *                               listing fee each (the per-pair provable-
 *                               counterparty bar is not per-trade).
 * so a puppet pair can't farm trades any more than they can farm ratings.
 *
 * Signals C (one_way_pile_on) and D (review_concentration) are deliberately NOT
 * applied here: both describe REVIEW patterns (attackers piling reviews onto a
 * subject; a reviewer aiming ≥80% of their REVIEWS at one subject). Neither has
 * a trade analogue in the data, and pretending otherwise would silently void
 * legitimate trades. See REVISIT for the documented residual (a pair with no
 * flag can still mint repeat trade credits at one listing fee each).
 *
 * A completion with NO named counterparty still credits the owner: there's no
 * pair to judge, so there's nothing to exclude.
 *
 * @param scopeAccountsSql optional SQL returning the ONLY accounts whose trades
 *   need counting (e.g. `SELECT bidder FROM winning_bids`). Mirrors {@link
 *   feedbackAggregateJoin}'s scope and exists for the same reason: the
 *   orderbook lists many accounts and needs the whole aggregate, but the
 *   featured strip returns at most three rows and is polled by every homepage
 *   visitor, so counting every completed order on the instance there would be a
 *   real cost for no benefit. Applied to the OUTER account, so it only ever
 *   REMOVES accounts — it can never relax a sock-puppet exclusion or change the
 *   count of an account it keeps.
 */
export function tradeCountSql(scopeAccountsSql?: string): string {
	const scope = scopeAccountsSql ? `\n\t       AND t.account IN (${scopeAccountsSql})` : '';
	return `
	    SELECT t.account, COUNT(*)::int AS c
	      FROM (
	        SELECT o.account AS account, o.completed_counterparty AS peer
	          FROM orders o
	         WHERE o.status = 'completed'
	        UNION ALL
	        SELECT o.completed_counterparty AS account, o.account AS peer
	          FROM orders o
	         WHERE o.status = 'completed'
	           AND o.completed_counterparty IS NOT NULL
	      ) t
	     WHERE (t.peer IS NULL
	        OR (
	             NOT EXISTS (
	               SELECT 1 FROM suspicious_reciprocity sr
	                WHERE sr.account_a = LEAST(t.account, t.peer)
	                  AND sr.account_b = GREATEST(t.account, t.peer)
	             )
	         AND NOT EXISTS (
	               SELECT 1 FROM related_accounts ra
	                WHERE ra.account_a = LEAST(t.account, t.peer)
	                  AND ra.account_b = GREATEST(t.account, t.peer)
	             )
	         -- Signal E (v1.5.5): drop credits from a peer this account's
	         -- trades are >=80% concentrated on. DIRECTED, not a pair check:
	         -- it voids the farmed account's inflated credits without voiding
	         -- the same trades for a legitimately busy counterparty who merely
	         -- happens to be their dominant peer.
	         AND NOT EXISTS (
	               SELECT 1 FROM trade_concentration tcx
	                WHERE tcx.account = t.account
	                  AND tcx.dominant_peer = t.peer
	             )
	           ))${scope}
	     GROUP BY t.account`;
}

/** The unscoped whole-instance trade count. Kept as a named export because the
 *  orderbook needs it for every listed account. */
export const TRADE_COUNT_SQL = tradeCountSql();

/**
 * The LEFT JOIN that attaches the sock-puppet-filtered, time-decayed feedback
 * aggregate to an orders row, exposing:
 *
 *   f.c                 int      — feedback count (0 via COALESCE at use site)
 *   f.r                 numeric  — time-decayed weighted rating, NULL when c = 0
 *   f.last_feedback_at  timestamptz
 *
 * @param orderAlias the alias of the `orders` table in the caller's query.
 * @param scopeSubjectsSql optional SQL returning the ONLY accounts whose
 *   feedback needs aggregating (e.g. `SELECT bidder FROM winning_bids`). The
 *   orderbook lists many accounts and needs the whole aggregate; the featured
 *   strip returns at most three rows but is polled by every homepage visitor,
 *   so letting it aggregate the entire feedback table would be a real cost for
 *   no benefit. This only ADDS a restriction — it can never relax an exclusion.
 */
export function feedbackAggregateJoin(orderAlias = 'o', scopeSubjectsSql?: string): string {
	const scope = scopeSubjectsSql ? `\n\t      AND fb.subject IN (${scopeSubjectsSql})` : '';
	return `	 LEFT JOIN (
	   -- Excludes feedback from (reviewer, subject) pairs
	   -- flagged in suspicious_reciprocity OR related_accounts.
	   -- Per Finding R2 — the displayed rating must not
	   -- include sock-puppet reviews.  Same shape as the
	   -- /v1/accounts/:account/feedback summary CTE.
	   --
	   -- Also excludes feedback rows with NULL order_permlink
	   -- (Finding G2.1).  Untethered feedback doesn't trigger
	   -- the welcome bonus (post-§F.12 G1.1) and doesn't drive
	   -- the orderbook reputation signal either — only trade-
	   -- bound feedback counts.  Sock-puppet detection only
	   -- catches REPETITIVE pairs; this filter closes the
	   -- "real human Alice writes vague positive feedback for
	   -- stranger Bob she never traded with" attack path.
	   SELECT subject, COUNT(*)::int AS c,
	          MAX(created_at) AS last_feedback_at,
	          -- cp123 H1: time-decay weighted rating with 365-day
	          -- half-life.  See indexer/reputation/decay.ts.
	          ROUND(
	            SUM(rating * POWER(0.5, EXTRACT(EPOCH FROM (NOW() - created_at)) / (365 * 86400.0))) /
	            NULLIF(SUM(POWER(0.5, EXTRACT(EPOCH FROM (NOW() - created_at)) / (365 * 86400.0))), 0),
	            2
	          )::numeric AS r
	     FROM feedback fb
${FEEDBACK_EXCLUSIONS_SQL}${scope}
	    GROUP BY subject
	 ) f ON f.subject = ${orderAlias}.account`;
}

/**
 * v1.5.5 — the LEFT JOIN attaching {@link TRADE_COUNT_SQL} to an orders row,
 * exposing `tc.c` (int) — the account's COMPLETED-TRADE count (0 via COALESCE
 * at the use site).
 *
 * Kept as its own join rather than folded into {@link feedbackAggregateJoin}
 * because trades and ratings are now DIFFERENT numbers with different sources:
 * trades come from completed ORDERS, ratings from FEEDBACK. Ken asked for them
 * shown side by side ("1 trade · ★5.00 (34)") precisely so the ratings count
 * still says how many ratings back the average — folding them together is what
 * would make "★5.00 (34)" imply 34 ratings when 34 might be trades.
 *
 * @param orderAlias alias of the `orders` table in the caller's query.
 * @param alias alias to give this join (default `tc`).
 * @param scopeAccountsSql optional restriction — see {@link tradeCountSql}.
 */
export function tradeCountJoin(orderAlias = 'o', alias = 'tc', scopeAccountsSql?: string): string {
	return `	 LEFT JOIN (
${tradeCountSql(scopeAccountsSql)}
	 ) ${alias} ON ${alias}.account = ${orderAlias}.account`;
}

/**
 * The SELECT columns every order-card surface needs. The caller MUST supply all
 * three joins these columns read:
 *
 *   {@link feedbackAggregateJoin}  → f.c, f.r, f.last_feedback_at
 *   {@link tradeCountJoin}         → tc.c
 *   {@link accountsJoin}           → a.first_trade_complete_at, a.posting_pubkey
 *
 * Keep in lockstep with {@link ReputationRow} and `reputationFieldsFromRow`.
 *
 * cp473 — `trade_count` and the trade-derived `is_new_trader` are emitted HERE
 * rather than left to each caller. v1.5.5 re-pointed both at real completions
 * (`tc.c`) on /v1/orderbook + /v1/orders/:account by hand-editing those two
 * queries, but this shared helper still read the FEEDBACK proxy (`f.c`) — so
 * the featured strip, its only caller, kept publishing the pre-v1.5.5
 * semantics: no trade count at all, and a 🌱 sprout that meant "fewer than 4
 * REVIEWS". Two surfaces, two meanings, one card component. Emitting the
 * trade-shaped columns from the shared helper is what makes that unable to
 * recur: a surface either uses this and gets the current semantics, or it does
 * not compile.
 *
 * @param orderAlias alias of the `orders` table.
 * @param accountsAlias alias of the joined `accounts` table.
 * @param tradeAlias alias given to {@link tradeCountJoin} (default `tc`).
 */
export function reputationSelectColumns(
	orderAlias = 'o',
	accountsAlias = 'a',
	tradeAlias = 'tc'
): string {
	return `COALESCE(f.c, 0)::int AS feedback_count,
	       CASE WHEN f.r IS NOT NULL THEN f.r::text ELSE NULL END AS weighted_rating,
	       f.last_feedback_at,
	       COALESCE(${tradeAlias}.c, 0)::int AS trade_count,
	       (COALESCE(${tradeAlias}.c, 0) < 4) AS is_new_trader,
	       ${accountsAlias}.first_trade_complete_at,
	       ${accountsAlias}.posting_pubkey`;
}

/** The accounts join that supplies first_trade_complete_at + posting_pubkey. */
/**
 * LEFT JOIN the poster's PROFILE so a listing row carries its own display name
 * and avatar. Exposes `<alias>.display_name` and `<alias>.json_metadata`.
 *
 * v1.8.13 (Ken) — WHY THIS IS A TRUST FIX, NOT A PERFORMANCE ONE.
 *
 * The orderbook returned `posting_pubkey` inline but not the profile, so the
 * browser had to make a SECOND round-trip for names and avatars. Cards
 * therefore painted with `@account` + identicon and swapped to the real
 * identity a few seconds later — Ken measured ~7s on morphit.io.
 *
 * His objection was not that it looked slow. It was that a card which rewrites
 * its own identity in front of you is indistinguishable from a scam: "if i were
 * an interested user in that order, i would think twice... it feels like i
 * could get scammed." On a marketplace where the counterparty's identity IS the
 * product, a visibly mutating identity is a trust defect.
 *
 * Joining it here means the row arrives complete and the card is correct on
 * FIRST paint. `profiles` is keyed by account and already LEFT JOINed the same
 * way elsewhere, so this adds no extra query and no fan-out.
 */
export function profileJoin(orderAlias = 'o', profileAlias = 'pr'): string {
	return `LEFT JOIN profiles ${profileAlias} ON ${profileAlias}.account = ${orderAlias}.account`;
}

export function accountsJoin(orderAlias = 'o', accountsAlias = 'a'): string {
	return `LEFT JOIN accounts ${accountsAlias} ON ${accountsAlias}.name = ${orderAlias}.account`;
}

/**
 * The LEFT JOIN that attaches the 24h engagement counter (distinct senders who
 * messaged this order's owner about THIS order). Exposes `e.distinct_senders_24h`.
 *
 * Parameter-free, like {@link feedbackAggregateJoin}.
 *
 * @param orderAlias the alias of the `orders` table in the caller's query.
 * @param scopeRecipientsSql optional SQL restricting which recipients need a
 *   24h engagement count — same rationale as `feedbackAggregateJoin`'s scope.
 */
export function engagementJoin(orderAlias = 'o', scopeRecipientsSql?: string): string {
	const scope = scopeRecipientsSql ? `\n\t      AND cm.recipient IN (${scopeRecipientsSql})` : '';
	return `	 LEFT JOIN (
	   -- Engagement counter (Q11 follow-up): distinct senders
	   -- who messaged this order's owner about THIS order in
	   -- the last 24h.  Uses the chat_messages.order_permlink
	   -- column (v25 migration) which Q11 made plaintext on
	   -- chain.  Order owners' OWN messages are excluded
	   -- (sender <> recipient is a NULL-on-self constraint
	   -- already; orders never have account = '' so the
	   -- sender = account exclusion is belt-and-suspenders).
	   --
	   -- Window: 24 hours.  Older messages don't count toward
	   -- the "right now" signal — a counterparty who messaged
	   -- yesterday and never came back isn't competing with
	   -- the current viewer.
	   --
	   -- BATCH14-2 audit fix — filter senders to those with
	   -- at least one prior received feedback row.  Sock
	   -- accounts start with feedback_count = 0, so this
	   -- demonetizes the cheapest sock-amplification path
	   -- (provision N sock accounts at $0.20 each, send a
	   -- message from each, get +N on the chip).  Real
	   -- counterparties with trade history pass the filter.
	   -- The feedback EXISTS subquery is index-supported via
	   -- feedback_subject_idx so this stays fast.  The
	   -- chat_messages_order_engagement_idx still drives
	   -- the outer aggregate.
	   --
	   -- Privacy: aggregated count only.  No counterparty
	   -- identities exposed.  The on-chain chat ops already
	   -- name signers + recipients + (post-Q11) order
	   -- permlinks, so this aggregate exposes no new
	   -- metadata vs scraping the chain.
	   SELECT recipient, order_permlink,
	          COUNT(DISTINCT sender)::int AS distinct_senders_24h
	     FROM chat_messages cm
	    WHERE order_permlink IS NOT NULL
	      AND created_at > NOW() - INTERVAL '24 hours'
	      AND sender <> recipient
	      AND EXISTS (
	        SELECT 1 FROM feedback fb_eng
	         WHERE fb_eng.subject = cm.sender
	           AND fb_eng.order_permlink IS NOT NULL
	      )
${scope}
	    GROUP BY recipient, order_permlink
	 ) e ON e.recipient = ${orderAlias}.account AND e.order_permlink = ${orderAlias}.permlink`;
}

/** Row shape produced by {@link reputationSelectColumns}. */
export interface ReputationRow {
	feedback_count: number;
	/** v1.5.5 — COMPLETED trades (both sides credited), sock-puppet filtered.
	 *  A DIFFERENT number from `feedback_count`: a trade nobody reviewed counts
	 *  here and not there. */
	trade_count: number;
	weighted_rating: string | null;
	last_feedback_at: Date | null;
	is_new_trader: boolean;
	first_trade_complete_at: Date | null;
	posting_pubkey: string | null;
}

/**
 * Map a {@link ReputationRow} to the OrderRecord fields the frontend order card
 * reads. The composite score is computed here, once, so every surface reports
 * the identical number for the same account at the same instant.
 */
export function reputationFieldsFromRow(r: ReputationRow): {
	feedback_count: number;
	trade_count: number;
	weighted_rating: number | null;
	reputation_score: number | null;
	is_new_trader: boolean;
	first_trade_at: string | null;
	posting_pubkey: string | null;
} {
	const weightedAvg = r.weighted_rating === null ? null : Number(r.weighted_rating);
	return {
		feedback_count: r.feedback_count,
		trade_count: r.trade_count,
		weighted_rating: weightedAvg,
		reputation_score: computeReputationScore({
			count: r.feedback_count,
			weightedAvg,
			lastFeedbackAtMs: r.last_feedback_at === null ? null : r.last_feedback_at.getTime()
		}),
		is_new_trader: r.is_new_trader,
		first_trade_at:
			r.first_trade_complete_at === null ? null : r.first_trade_complete_at.toISOString(),
		posting_pubkey: r.posting_pubkey ?? null
	};
}
