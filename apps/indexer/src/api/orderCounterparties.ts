/**
 * Morphit indexer — GET /v1/orders/:owner/:permlink/counterparties
 * (and GET /v1/orders/:owner/counterparty_lists?permlinks=…, the same
 * lists for several orders at once)
 *
 * Lists the accounts that contacted the order OWNER about a SPECIFIC
 * order — i.e. the people who sent a morphit_chat_v1 naming this order
 * (recipient = owner, order_permlink = this order). These are the
 * candidate trade partners the owner might leave feedback on from
 * /my/orders.
 *
 * Each item carries a single `reviewable` boolean:
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
 * What the flag reveals: the boolean does not say WHY a peer is not
 * reviewable, but the chat counts and times it is computed from are
 * public on chain. Anyone who sees that a pair has exchanged two
 * messages each way over fifteen minutes and still reads `false` learns
 * that the pair is in suspicious_reciprocity. That table is derived from
 * public reviews by a published rule (signals.ts), so this is not a
 * secret the endpoint keeps; it is stated here so nobody relies on the
 * flag to hide it.
 *
 * Authentication: none — same stance as /v1/conversations. Chat
 * sender/recipient/order_permlink are already public plaintext on the
 * Blurt chain; this endpoint just makes that on-chain metadata faster
 * to query.
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

/**
 * Candidate peers = DISTINCT senders who named the order when messaging the
 * owner ($1) (the Q11 order-response set). For each, the opaque `reviewable`
 * recomputes the EXACT handler gate over all messages between owner and peer:
 * ≥2 each way, ≥15-min span, and not a flagged suspicious-reciprocity pair
 * (== has_verified_chat). The LATERAL runs the same conformance the feedback
 * handler does. Self (sender = owner) is excluded defensively.
 * `permlinkPredicate` selects the order(s) on chat_messages.order_permlink.
 */
function counterpartiesSql(permlinkPredicate: string): string {
	return `
			SELECT
				cp.permlink,
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
				SELECT DISTINCT order_permlink AS permlink, sender AS peer
				  FROM chat_messages
				 WHERE recipient = $1
				   AND ${permlinkPredicate}
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
			) conf`;
}

/** Most orders one batch request may name. */
const MAX_BATCH_PERMLINKS = 50;

export function orderCounterpartiesRoute(db: Database): Hono {
	const app = new Hono();

	// Batch: the candidate lists for several of the owner's orders in one
	// request (?permlinks=a,b,…; at most MAX_BATCH_PERMLINKS, each list at
	// most DEFAULT_COUNTERPARTIES long). /my/orders asked once per order, and
	// those requests alone used up a shared-address visitor's rate limit.
	// An underscore path cannot collide with a permlink.
	app.get('/:owner/counterparty_lists', async (c) => {
		const owner = c.req.param('owner');
		if (!isAccountName(owner)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}
		const permlinks = [
			...new Set((c.req.query('permlinks') ?? '').split(',').map((p) => p.trim()))
		].filter((p) => p.length > 0);
		if (
			permlinks.length === 0 ||
			permlinks.length > MAX_BATCH_PERMLINKS ||
			!permlinks.every((p) => isValidPermlink(p))
		) {
			return c.json(errorBody('bad_request', 'invalid permlinks'), 400);
		}
		const result = await db.query<CounterpartyRow & { permlink: string }>(
			`${counterpartiesSql('order_permlink = ANY($2::text[])')}
			ORDER BY cp.permlink, cp.peer`,
			[owner, permlinks]
		);
		const lists: Record<string, { peer: string; reviewable: boolean }[]> = {};
		for (const p of permlinks) lists[p] = [];
		for (const r of result.rows) {
			const list = lists[r.permlink]!;
			if (list.length < DEFAULT_COUNTERPARTIES) {
				list.push({ peer: r.peer, reviewable: r.reviewable === true });
			}
		}
		return c.json({ owner, lists });
	});

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

		const sql = `${counterpartiesSql('order_permlink = $2')}
			ORDER BY cp.peer
			LIMIT $3`;

		const result = await db.query<CounterpartyRow & { permlink: string }>(sql, [
			owner,
			permlink,
			limit
		]);

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
