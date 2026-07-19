/**
 * Morphit indexer — GET /v1/orders/:owner/:permlink/counterparties
 *
 * Lists the accounts that contacted the order OWNER about a SPECIFIC
 * order — i.e. the people who sent a morphit_chat_v1 naming this order
 * (recipient = owner, order_permlink = this order). These are the
 * candidate trade partners the owner might leave feedback on from
 * /my/orders.
 *
 * Each item carries a single OPAQUE `reviewable` boolean:
 *
 *   reviewable = the owner↔peer conversation clears the SAME bar the
 *                feedback handler's gate requires — ≥2 morphit_chat_v1
 *                each way, ≥15-min span, and NOT a flagged
 *                suspicious-reciprocity pair (== has_verified_chat).
 *
 * This mirrors EXACTLY handlers/feedback.ts so the frontend never
 * offers a "Mark complete / review" the indexer would then drop. The
 * frontend uses it to gate the button + prefill the trade partner.
 *
 * Deliberately OPAQUE about WHY a peer is not reviewable: the boolean
 * folds "no reply yet" and "flagged pair" together, so it never tells a
 * would-be reputation-gamer that the sockpuppet detector fired on them.
 * (Anti-gaming: never hand the attacker the detector's state.)
 *
 * Authentication: none — same stance as /v1/conversations. Chat
 * sender/recipient/order_permlink are already public plaintext on the
 * Blurt chain; this endpoint just makes that on-chain metadata faster
 * to query. The reciprocity signal is NOT leaked (folded into the
 * opaque boolean, indistinguishable from "no reply yet").
 */
import { Hono } from 'hono';

import type { Database } from '$db/pool';
import { errorBody, isAccountName } from '$api/shared';

// /my/orders wants a manageable candidate list, so it omits ?limit and gets
// the default. The settlement auto-reply sender (settledElsewhere.ts) passes a
// generous ?limit so it can reach EVERY inquirer on a popular order rather than
// just the alphabetical first slice; the value is clamped to the hard cap.
const DEFAULT_COUNTERPARTIES = 50;
const MAX_COUNTERPARTIES = 500;

/** Permlink policy identical to handlers/feedback.ts: ≤32 chars,
 *  lowercase alnum segments joined by single hyphens. */
const PERMLINK_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
function isValidPermlink(s: string | undefined): s is string {
	return typeof s === 'string' && s.length > 0 && s.length <= 32 && PERMLINK_RE.test(s);
}

interface CounterpartyRow {
	peer: string;
	reviewable: boolean;
}

export function orderCounterpartiesRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/:owner/:permlink/counterparties', async (c) => {
		const owner = c.req.param('owner');
		const permlink = c.req.param('permlink');
		if (!isAccountName(owner)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}
		if (!isValidPermlink(permlink)) {
			return c.json(errorBody('bad_request', 'invalid permlink'), 400);
		}

		// Optional ?limit — omitted → the lean default for /my/orders; the
		// settlement auto-reply passes a high value to enumerate every inquirer.
		// Digits-only guard BEFORE parseInt: Number.parseInt('12abc', 10) === 12
		// would otherwise let a malformed value slip past validation.
		const rawLimit = c.req.query('limit');
		let limit = DEFAULT_COUNTERPARTIES;
		if (rawLimit !== undefined) {
			if (!/^\d+$/.test(rawLimit)) {
				return c.json(errorBody('bad_request', 'invalid limit'), 400);
			}
			const n = Number.parseInt(rawLimit, 10);
			if (n < 1) {
				return c.json(errorBody('bad_request', 'invalid limit'), 400);
			}
			limit = Math.min(n, MAX_COUNTERPARTIES);
		}

		// Candidate peers = DISTINCT senders who named THIS order when
		// messaging the owner (the Q11 order-response set). For each, the
		// opaque `reviewable` recomputes the EXACT handler gate over all
		// messages between owner and peer: ≥2 each way, ≥15-min span, and
		// not a flagged suspicious-reciprocity pair (== has_verified_chat).
		// The LATERAL runs the same conformance the feedback handler does.
		// Self (sender = owner) is excluded defensively.
		const sql = `
			SELECT
				cp.peer,
				(
					conf.from_owner >= 2
					AND conf.from_peer >= 2
					AND conf.span_seconds >= 900
					AND NOT EXISTS (
						SELECT 1 FROM suspicious_reciprocity sr
						 WHERE sr.account_a = LEAST($1::text, cp.peer)
						   AND sr.account_b = GREATEST($1::text, cp.peer)
					)
				) AS reviewable
			FROM (
				SELECT DISTINCT sender AS peer
				  FROM chat_messages
				 WHERE recipient = $1
				   AND order_permlink = $2
				   AND sender <> $1
			) cp
			CROSS JOIN LATERAL (
				SELECT
					COUNT(*) FILTER (WHERE m.sender = $1 AND m.recipient = cp.peer) AS from_owner,
					COUNT(*) FILTER (WHERE m.sender = cp.peer AND m.recipient = $1) AS from_peer,
					COALESCE(
						EXTRACT(EPOCH FROM (MAX(m.created_at) - MIN(m.created_at))),
						0
					) AS span_seconds
				  FROM chat_messages m
				 WHERE (m.sender = $1 AND m.recipient = cp.peer)
				    OR (m.sender = cp.peer AND m.recipient = $1)
			) conf
			ORDER BY cp.peer
			LIMIT $3
		`;

		const result = await db.query<CounterpartyRow>(sql, [owner, permlink, limit]);

		return c.json({
			owner,
			permlink,
			items: result.rows.map((r) => ({
				peer: r.peer,
				reviewable: r.reviewable === true
			}))
		});
	});

	return app;
}
