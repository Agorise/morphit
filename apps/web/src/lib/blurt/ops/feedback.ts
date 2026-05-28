/**
 * Morphit — feedback op broadcaster.
 *
 * Builds a `morphit_feedback_v1` custom_json payload, signs it with
 * the user's posting key (via LiveIdentity), and broadcasts through
 * the endpoint rotator. Parallels profile.ts — same pattern, same
 * key role, same BroadcastError class.
 *
 * Feedback is ADR-ratified on the posting key: no active-key prompt,
 * no fee transfer, no external dependencies. The indexer reads the
 * op and writes a row to the feedback table (unique on
 * (reviewer, subject, order_permlink) so repeat submissions reject).
 *
 * We duplicate the indexer handler's structural validation here for
 * fail-fast UX: a bad comment character, a self-review, or a rating
 * outside 1..5 gets rejected in the browser before we even build the
 * transaction. The indexer is authoritative — we don't trust this
 * check for anything — but it saves a round-trip on honest mistakes.
 *
 * Signed feedback can later be responded to by the subject via
 * morphit_feedback_response_v1 (different op id, same key, same
 * broadcast pattern).  See ./feedbackResponse.ts for the response
 * op-builder.
 */

// cp165 byte-budget: broadcastCustomJson is dynamically imported
// at the call site below so dblurt (a 2 MB chunk) doesn't land in
// the eager-load graph of routes that pull this ops file for its
// types/helpers but don't immediately trigger a broadcast.
import { OP_IDS } from '$net/config';
import type { LiveIdentity } from '$crypto/keygen';
import { getUserBlurtAccount, BroadcastError } from './profile';
import { redactPrivateKeys } from '$lib/security/privateKeyDetector';

/** Must match the indexer handler's ACCOUNT_NAME_RE. Graphene account
 *  names per Blurt's is_valid_account_name are dot-separated
 *  multi-segment.  Canonicalized to allow dots — see
 *  REVISIT-LIST.md "C-19 follow-on consistency pass" for context. */
const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{2,15}$/;

/** Must match the indexer handler's PERMLINK_RE. Lowercase alnum
 *  segments separated by single hyphens. */
const PERMLINK_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/** Same 256-codepoint budget as the indexer. Emoji count as one
 *  each (code-point count, not UTF-16 units). */
const MAX_COMMENT_CODEPOINTS = 256;

/** Same injection-resistant character class as the indexer + profile
 *  display-name validation: block C0/C1 controls, bidi overrides,
 *  zero-width joiners/spaces, and BOM. Centralizing would be nicer
 *  but since each handler stands alone we accept the duplication. */
const FORBIDDEN_COMMENT_CHARS =
	/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/;

export interface FeedbackPayload {
	/** The Blurt account name being reviewed. Must differ from
	 *  the broadcaster's own account (no self-reviews — the
	 *  indexer will reject `self_review` if attempted). */
	readonly subject: string;
	/** Integer 1..5. Out-of-range values are rejected both
	 *  client-side and by the indexer. */
	readonly rating: number;
	/** Optional free-text comment, up to 256 code points. Omit
	 *  for rating-only feedback. */
	readonly comment?: string;
	/** Optional link to the specific order this feedback is about.
	 *  Strongly recommended — without it the feedback is a generic
	 *  account-level rating and the (reviewer, subject, null)
	 *  uniqueness constraint kicks in after the first. With it,
	 *  a reviewer can leave one feedback per order. */
	readonly order_permlink?: string;
}

/** Structural error codes. These mirror the indexer's reject reasons
 *  so the UI can use one i18n key table for both client-side and
 *  server-side failures. */
export type FeedbackValidationCode =
	| 'subject_invalid'
	| 'self_review'
	| 'rating_out_of_range'
	| 'comment_too_long'
	| 'comment_forbidden_char'
	| 'order_permlink_bad_chars';

export class FeedbackValidationError extends Error {
	constructor(
		public readonly code: FeedbackValidationCode,
		message: string
	) {
		super(message);
		this.name = 'FeedbackValidationError';
	}
}

/** Validate a payload, throwing FeedbackValidationError on the first
 *  problem. Pure function — no side effects, safe to call from
 *  reactive contexts for live error display. */
export function validateFeedback(reviewer: string, payload: FeedbackPayload): void {
	if (!ACCOUNT_NAME_RE.test(payload.subject)) {
		throw new FeedbackValidationError(
			'subject_invalid',
			'Subject must be a valid Blurt account name.'
		);
	}
	if (payload.subject === reviewer) {
		throw new FeedbackValidationError('self_review', 'You cannot leave feedback about yourself.');
	}
	if (!Number.isInteger(payload.rating) || payload.rating < 1 || payload.rating > 5) {
		throw new FeedbackValidationError(
			'rating_out_of_range',
			'Rating must be an integer between 1 and 5.'
		);
	}
	if (payload.comment !== undefined && payload.comment !== null) {
		// Code-point count (not UTF-16 units) to match the indexer.
		if ([...payload.comment].length > MAX_COMMENT_CODEPOINTS) {
			throw new FeedbackValidationError(
				'comment_too_long',
				`Comment must be at most ${MAX_COMMENT_CODEPOINTS} characters.`
			);
		}
		if (FORBIDDEN_COMMENT_CHARS.test(payload.comment)) {
			throw new FeedbackValidationError(
				'comment_forbidden_char',
				'Comment contains forbidden characters.'
			);
		}
	}
	if (payload.order_permlink !== undefined && payload.order_permlink !== null) {
		if (!PERMLINK_RE.test(payload.order_permlink)) {
			throw new FeedbackValidationError(
				'order_permlink_bad_chars',
				'Order permlink contains invalid characters.'
			);
		}
	}
}

/** Pure body-builder for a feedback op. Takes the (already-
 *  validated) payload and returns the wire body with optional
 *  fields omitted + redaction applied to free-text.
 *
 *  Extracted from `broadcastFeedback` so redaction behavior is
 *  testable as a pure function. The broadcast wrapper handles
 *  side-effects (account lookup, validation, network).
 */
export function buildFeedbackBody(payload: FeedbackPayload): Record<string, unknown> {
	// Build the wire payload. Omit optional fields when absent so the
	// on-chain JSON stays minimal (saves Mana — formerly known
	// as "RC"; Blurt charges by serialized op size).
	// Silent redactPrivateKeys on the comment closes the gap if any
	// code path calls broadcastFeedback directly without going
	// through LeaveFeedbackForm (which also redacts upstream).
	const body: Record<string, unknown> = {
		subject: payload.subject,
		rating: payload.rating
	};
	if (payload.comment !== undefined && payload.comment !== null && payload.comment.length > 0) {
		body.comment = redactPrivateKeys(payload.comment);
	}
	if (payload.order_permlink !== undefined && payload.order_permlink !== null) {
		body.order_permlink = payload.order_permlink;
	}
	return body;
}

/** Broadcast a feedback op. Returns the chain's block_num/trx_id on
 *  success. The trx_id is specifically the identifier callers want to
 *  thread into follow-on actions (e.g. deriving the permlink for the
 *  automatic "I joined Morphit" post on first-trade feedback).
 *
 *  Throws:
 *    - BroadcastError('no_account') if the user isn't registered
 *    - FeedbackValidationError on structural invalidity
 *    - Underlying transport errors from broadcastCustomJson
 *      (network, RPC 5xx, Blurt chain rejection)
 */
export async function broadcastFeedback(
	live: LiveIdentity,
	payload: FeedbackPayload
): Promise<{ block_num: number; trx_id: string }> {
	const account = getUserBlurtAccount();
	if (!account) {
		throw new BroadcastError('no_account', 'No Blurt account registered yet.');
	}
	// Validate before signing anything. Cheaper than letting the
	// chain reject and showing a generic broadcast error.
	validateFeedback(account, payload);

	const body = buildFeedbackBody(payload);

	const { broadcastCustomJson } = await import('../sign');
	return await broadcastCustomJson(live, OP_IDS.feedback, body, account);
}
