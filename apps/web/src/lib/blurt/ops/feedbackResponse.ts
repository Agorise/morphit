/**
 * Morphit — feedback-response op broadcaster.
 *
 * Builds a `morphit_feedback_response_v1` custom_json payload,
 * signs it with the user's posting key, and broadcasts via the
 * endpoint rotator. Parallels feedback.ts — same pattern, same
 * key role, same BroadcastError class.
 *
 * Responses are only valid when sent by the subject of the
 * original feedback (the account that was reviewed). The indexer
 * enforces this via `responder_not_subject` rejection; the UI
 * only offers the reply flow when the signed-in user IS the
 * subject, so the indexer check acts as a safety net against
 * stale UI state rather than as the primary authorization gate.
 *
 * Comment policy matches feedback.ts: 256 code points max, at
 * least 1 character (no empty responses — if you have nothing
 * to say, don't say it), no control/bidi/zero-width characters.
 */

import { broadcastCustomJson } from '../sign';
import { OP_IDS } from '$net/config';
import type { LiveIdentity } from '$crypto/keygen';
import { getUserBlurtAccount, BroadcastError } from './profile';
import { redactPrivateKeys } from '$lib/security/privateKeyDetector';

/** Must match the indexer handler's MAX_COMMENT_CODEPOINTS. */
const MAX_COMMENT_CODEPOINTS = 256;

/** Same injection-resistant character class as the feedback
 *  handler + profile display-name validation. */
const FORBIDDEN_COMMENT_CHARS =
	/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/;

/** Blurt trx_id is a 40-char hex string. The handler accepts
 *  1..64 to be generous about format (testnets sometimes use
 *  longer ids), so we mirror that range — but flag an invalid
 *  shape eagerly because it's almost always a bug. */
const TRX_ID_RE = /^[0-9a-f]{1,64}$/i;

export interface FeedbackResponsePayload {
	/** The trx_id of the original feedback op — comes from
	 *  `FeedbackRecord.source_trx_id` in the indexer response. */
	readonly feedback_trx_id: string;
	/** The response text. 1..256 code points. Empty responses
	 *  are rejected — respond substantively or not at all. */
	readonly comment: string;
}

export type FeedbackResponseValidationCode =
	| 'feedback_trx_id_invalid'
	| 'comment_empty'
	| 'comment_too_long'
	| 'comment_forbidden_char';

export class FeedbackResponseValidationError extends Error {
	constructor(
		public readonly code: FeedbackResponseValidationCode,
		message: string
	) {
		super(message);
		this.name = 'FeedbackResponseValidationError';
	}
}

/** Validate a response payload. Pure, no side effects — safe
 *  from reactive contexts. */
export function validateFeedbackResponse(payload: FeedbackResponsePayload): void {
	if (typeof payload.feedback_trx_id !== 'string' || !TRX_ID_RE.test(payload.feedback_trx_id)) {
		throw new FeedbackResponseValidationError(
			'feedback_trx_id_invalid',
			'Invalid feedback trx_id.'
		);
	}
	if (payload.comment.length < 1) {
		throw new FeedbackResponseValidationError('comment_empty', 'Response cannot be empty.');
	}
	if ([...payload.comment].length > MAX_COMMENT_CODEPOINTS) {
		throw new FeedbackResponseValidationError(
			'comment_too_long',
			`Response must be at most ${MAX_COMMENT_CODEPOINTS} characters.`
		);
	}
	if (FORBIDDEN_COMMENT_CHARS.test(payload.comment)) {
		throw new FeedbackResponseValidationError(
			'comment_forbidden_char',
			'Response contains forbidden characters.'
		);
	}
}

/** Pure body-builder for a feedback-response op. Takes the
 *  (already-validated) payload and returns the redacted body
 *  ready to hand to broadcastCustomJson.
 *
 *  Extracted from `broadcastFeedbackResponse` so redaction
 *  behavior is testable as a pure function. The broadcast
 *  wrapper handles the side-effects (account lookup, network).
 */
export function buildFeedbackResponseBody(payload: FeedbackResponsePayload): {
	feedback_trx_id: string;
	comment: string;
} {
	// Silent redactPrivateKeys on the comment — same chokepoint
	// pattern as buildFeedbackBody. Closes the gap if any path
	// reaches here without going through RespondToFeedbackForm.
	return {
		feedback_trx_id: payload.feedback_trx_id,
		comment: redactPrivateKeys(payload.comment)
	};
}

/** Broadcast a feedback-response op. Throws:
 *    - BroadcastError('no_account') if no Blurt account registered
 *    - FeedbackResponseValidationError on structural invalidity
 *    - Transport errors from broadcastCustomJson
 */
export async function broadcastFeedbackResponse(
	live: LiveIdentity,
	payload: FeedbackResponsePayload
): Promise<{ block_num: number; trx_id: string }> {
	const account = getUserBlurtAccount();
	if (!account) {
		throw new BroadcastError('no_account', 'No Blurt account registered yet.');
	}
	validateFeedbackResponse(payload);

	const body = buildFeedbackResponseBody(payload);

	return await broadcastCustomJson(live, OP_IDS.feedbackResponse, body, account);
}
