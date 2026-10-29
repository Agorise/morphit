/**
 * Morphit indexer — GET /v1/feedback/status?reviewer=&subject=&order_permlink=
 *
 * What became of a review: did this indexer index it, refuse it (and why), or
 * not see it at all? A review the indexer refuses simply never appears, so the
 * reviewer had no way to tell "still on its way" from "refused" — the
 * maintainer found the reviews of a newcomer's first trade refused on every
 * instance with nothing on screen saying so. The web UI asks this after a
 * review is sent and tells the reviewer.
 *
 * The answer comes from this indexer's own event log (`ops`): every
 * morphit_feedback_v1 op it applied or rejected, with the rejection's stable
 * slug (handler-contract.ts). The lookup is one probe of a partial index
 * (ops_feedback_status_idx, schema v70; the query repeats its expressions and
 * its op_id literal exactly, or the planner cannot use it). Everything read is
 * public: the op is on chain,
 * and the verdict is what any indexer replaying the chain reaches. Nothing is
 * stored, and the request names only accounts and an order permlink, which
 * the review op carries in the clear.
 *
 *   state 'indexed'  — a review from `reviewer` about `subject` citing
 *                      `order_permlink` (none when the parameter is absent)
 *                      was applied. Wins over any later refusal (a re-send
 *                      is refused as `duplicate_feedback`).
 *   state 'refused'  — every such review was refused; `reason` is the newest
 *                      one's slug.
 *   state 'unknown'  — no such review in this indexer's log (not broadcast,
 *                      or not in a block this indexer has applied yet).
 *
 * With a refusal, so the web form can offer to send the review again:
 *   resend_from — when the same review sent again would now be accepted:
 *                 refused for its citation, the order it cites now admits a
 *                 review from this pair (reviewCitation.ts, the very predicate
 *                 the feedback handler runs, read-only here: a first-buy WAIVER
 *                 order completed naming the other party with the qualifying
 *                 BLURT transfer — stamped at or after the activation time —
 *                 recorded, or a paid order, e.g. completed or verified since),
 *                 and the pair still clears the handler's conversation gate
 *                 (chatGates hasVerifiedChat, reciprocity flag included), both
 *                 judged at max(activation time, now). The value: the
 *                 activation time for a waiver citation asked about before it,
 *                 else the time of this answer. Absent otherwise. (The
 *                 handler's one other gate, the duplicate check, cannot fail
 *                 here: a refused state means no review of this triple was
 *                 indexed.) A review refused AFTER the activation time — sent
 *                 before the owner completed the order, or before the
 *                 partner's transfer — is offered again too.
 *   waiting_for_transfer — { from, to }, when the review was refused for its
 *                 citation, cites a first-buy WAIVER order completed naming
 *                 this pair (reviewCitation.ts waiverTradeOfThePair), still
 *                 clears the conversation gate, and only the proving transfer
 *                 is missing: `from` (the partner) has not sent `to` (the
 *                 order's owner) at least 50.000 BLURT in a block stamped at
 *                 or after the activation time. Once they do, the review can
 *                 be sent again. Never together with resend_from.
 *   rating, comment — what the refused op said, each only when it is
 *                 well-formed by the handler's own rules (a comment absent
 *                 from the op is `null`). Public on chain anyway.
 *
 * Authentication: none, like every read here.
 */
import { Hono } from 'hono';

import {
	FORBIDDEN_REVIEW_TEXT_CHARS,
	MAX_REVIEW_COMMENT_CODEPOINTS
} from '@morphit/asset-registry';

import type { Database } from '$db/pool';
import { errorBody, isAccountName } from '$api/shared';
import { CONSENSUS_V2_ACTIVATION_TIME } from '$indexer/consensusActivation';
import { reviewCitesFeePaidOrder, waiverTradeOfThePair } from '$indexer/reviewCitation';
import { hasVerifiedChat } from '$indexer/chatGates';

/** Permlink policy identical to handlers/feedback.ts: ≤32 chars, lowercase
 *  alphanumeric segments joined by single hyphens. */
const PERMLINK_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface FeedbackStatusBody {
	readonly state: 'indexed' | 'refused' | 'unknown';
	/** The refusal's slug (state 'refused' only). */
	readonly reason?: string;
	/** The op's block time and transaction (states 'indexed' / 'refused'). */
	readonly block_time?: string;
	readonly trx_id?: string;
	/** State 'refused' only: send it again from this time (ISO 8601) and it
	 *  counts. See the file header. */
	readonly resend_from?: string;
	/** State 'refused' only: the refused op's rating and comment, when
	 *  well-formed. */
	readonly rating?: number;
	readonly comment?: string | null;
	/** State 'refused' only: the review cites a first-buy waiver order
	 *  completed naming this pair, and only the partner's transfer is missing:
	 *  `from` must send `to` at least 50.000 BLURT (from the activation time on);
	 *  then the review can be sent again. See the file header. */
	readonly waiting_for_transfer?: { readonly from: string; readonly to: string };
}

/** The refusal a waiver citation got before the activation time (the
 *  handler checks the citation before the conversation, so a review whose
 *  only fault was coming too early is refused with exactly this). */
const CITATION_REFUSED = 'order_permlink_not_found_or_unverified';

/** The refused op's rating and comment, each only when the feedback handler
 *  would accept it as it stands (same rules: integer 1..5; a comment of at
 *  most MAX_REVIEW_COMMENT_CODEPOINTS after NFC, none of the forbidden
 *  characters). A comment absent from the op is null. */
export function writtenReview(payload: unknown): { rating?: number; comment?: string | null } {
	if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return {};
	const p = payload as Record<string, unknown>;
	const out: { rating?: number; comment?: string | null } = {};
	if (
		typeof p.rating === 'number' &&
		Number.isInteger(p.rating) &&
		p.rating >= 1 &&
		p.rating <= 5
	) {
		out.rating = p.rating;
	}
	if (p.comment === undefined || p.comment === null) {
		out.comment = null;
	} else if (typeof p.comment === 'string') {
		const c = p.comment.normalize('NFC');
		if ([...c].length <= MAX_REVIEW_COMMENT_CODEPOINTS && !FORBIDDEN_REVIEW_TEXT_CHARS.test(c)) {
			out.comment = c;
		}
	}
	return out;
}

/** The one lookup. Its WHERE repeats ops_feedback_status_idx (schema v70)
 *  exactly — the op_id literal (a parameter cannot prove a partial index's
 *  predicate) and the two expressions — so that one probe of the index answers
 *  it; exported for the test that checks the plan. */
export const FEEDBACK_STATUS_SQL = `SELECT status, reject_reason, block_time, trx_id, payload
	   FROM ops
	  WHERE signer = $1
	    AND op_id = 'morphit_feedback_v1'
	    AND payload->>'subject' = $2
	    AND COALESCE(payload->>'order_permlink', '') = $3
	  ORDER BY (status = 'applied') DESC, block_num DESC, trx_in_block DESC, op_in_trx DESC
	  LIMIT 1`;

/** A refusal slug as served: `handler_threw:<message>` carries an internal
 *  error message, which is not the reviewer's business — only its slug is. */
export function publicReason(reason: string | null): string {
	if (reason === null || reason === '') return 'unknown';
	const colon = reason.indexOf(':');
	return colon >= 0 ? reason.slice(0, colon) : reason;
}

export function feedbackStatusRoute(
	db: Pick<Database, 'query'>,
	/** "Now", for the resend check (tests pin it). Not a consensus input: it
	 *  only picks which recorded transfers a resend sent now could rely on. */
	now: () => Date = () => new Date()
): Hono {
	const app = new Hono();

	app.get('/status', async (c) => {
		const reviewer = c.req.query('reviewer');
		const subject = c.req.query('subject');
		const permlink = c.req.query('order_permlink');
		if (!isAccountName(reviewer)) {
			return c.json(errorBody('bad_request', 'invalid reviewer'), 400);
		}
		if (!isAccountName(subject)) {
			return c.json(errorBody('bad_request', 'invalid subject'), 400);
		}
		if (
			permlink !== undefined &&
			(permlink.length === 0 || permlink.length > 32 || !PERMLINK_RE.test(permlink))
		) {
			return c.json(errorBody('bad_request', 'invalid order_permlink'), 400);
		}

		const r = await db.query<{
			status: 'applied' | 'rejected';
			reject_reason: string | null;
			block_time: Date;
			trx_id: string;
			payload: unknown;
		}>(FEEDBACK_STATUS_SQL, [reviewer, subject, permlink ?? '']);
		const row = r.rows[0];
		let body: FeedbackStatusBody;
		if (row === undefined) {
			body = { state: 'unknown' };
		} else if (row.status === 'applied') {
			body = {
				state: 'indexed',
				block_time: row.block_time.toISOString(),
				trx_id: row.trx_id
			};
		} else {
			// A resend would be judged at a block time no earlier than the
			// activation time and no earlier than now.
			const activation = new Date(CONSENSUS_V2_ACTIVATION_TIME);
			const resendBlockTime = new Date(Math.max(activation.getTime(), now().getTime()));
			// Only a review refused for its citation can be helped by its
			// citation becoming valid (payload faults come before it in the
			// handler, and a resend would repeat them).
			const citationRefused = row.reject_reason === CITATION_REFUSED && permlink !== undefined;
			let resendFrom: Date | null = null;
			let waiting: { from: string; to: string } | null = null;
			if (citationRefused) {
				const citation = await reviewCitesFeePaidOrder(db, {
					permlink,
					subject,
					reviewer,
					pairBound: true,
					asOf: resendBlockTime
				});
				// The handler's next gate, which can change since: the pair's
				// conversation (≥2 each way over ≥15 min, not flagged for
				// reciprocity), at the time a resend would be judged.
				const conversation = await hasVerifiedChat(db, {
					a: reviewer,
					b: subject,
					asOf: resendBlockTime
				});
				if (citation !== null && conversation) {
					// A resend would be accepted. A first-buy waiver citation counts
					// only from the activation time; anything else (a paid order
					// completed or verified since, a waiver trade proven since):
					// from the time of this answer.
					resendFrom =
						citation === 'waived' && now().getTime() < activation.getTime() ? activation : now();
				} else if (citation === null && conversation) {
					// Everything but the partner's transfer: say who must send it.
					const trade = await waiverTradeOfThePair(db, { permlink, subject, reviewer });
					if (trade !== null) waiting = { from: trade.partner, to: trade.owner };
				}
			}
			body = {
				state: 'refused',
				reason: publicReason(row.reject_reason),
				block_time: row.block_time.toISOString(),
				trx_id: row.trx_id,
				...(resendFrom !== null ? { resend_from: resendFrom.toISOString() } : {}),
				...(waiting !== null ? { waiting_for_transfer: waiting } : {}),
				...writtenReview(row.payload)
			};
		}
		// The answer changes as blocks are applied: never cached.
		c.header('cache-control', 'no-store');
		return c.json(body);
	});

	return app;
}
