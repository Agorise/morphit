/**
 * Handler: morphit_feedback_response_v1
 *
 * Payload shape:
 *   {
 *     "feedback_trx_id": string (the source_trx_id of the original feedback op),
 *     "comment": string (1..256 code points, no control/bidi/ZWJ)
 *   }
 *
 * Effect: attach a response to an existing feedback row. Only the
 * subject of the original feedback (i.e. the account that was
 * reviewed) can respond — anyone else's response is rejected.
 * One response per feedback: a second response from the same
 * subject is a replace-in-place, not a new row.
 *
 * Actually — for the simplest initial cut, we allow multiple
 * responses (e.g. subject edits). The UI displays latest-first.
 * Unique by source_trx_id prevents on-chain replays.
 *
 * Comment policy matches feedback.ts: 256 code points max, no
 * control/bidi/zero-width characters.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';

const MAX_COMMENT_CODEPOINTS = 256;
const FORBIDDEN_COMMENT_CHARS =
	/[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200B-\u200D\uFEFF]/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isUniqueViolation(err: unknown): boolean {
	return (
		typeof err === 'object' &&
		err !== null &&
		'code' in err &&
		(err as { code: unknown }).code === '23505'
	);
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	if (!isPlainObject(ctx.payload)) return { ok: false, reason: 'payload_not_object' };

	const trxId = ctx.payload.feedback_trx_id;
	if (typeof trxId !== 'string' || trxId.length === 0 || trxId.length > 64) {
		return { ok: false, reason: 'feedback_trx_id_invalid' };
	}
	// Defense-in-depth: blurt trxids are lowercase-hex.  Without this
	// check, a chain-direct submitter could spam feedback_response
	// ops citing arbitrary garbage strings — each one passes the
	// length cap, runs the SELECT, returns feedback_not_found, and
	// costs an indexer query.  Rate-limited by the chain's
	// per-signer-per-block budget, so the DoS surface is tiny, but
	// rejecting at intake is correct hygiene and matches the pattern
	// used by featureBid/order_permlink validation.
	if (!/^[0-9a-f]+$/.test(trxId)) {
		return { ok: false, reason: 'feedback_trx_id_invalid' };
	}

	const commentRaw = ctx.payload.comment;
	if (typeof commentRaw !== 'string') return { ok: false, reason: 'comment_not_string' };
	// O3.3 — NFC-normalize so codepoint-count check reflects user-
	// perceived length.  Mirrors feedback.ts.
	const comment = commentRaw.normalize('NFC');
	if (comment.length < 1) return { ok: false, reason: 'comment_empty' };
	if ([...comment].length > MAX_COMMENT_CODEPOINTS) {
		return { ok: false, reason: 'comment_too_long' };
	}
	if (FORBIDDEN_COMMENT_CHARS.test(comment)) {
		return { ok: false, reason: 'comment_forbidden_char' };
	}

	// Look up the feedback this response refers to.
	const fb = await client.query<{ id: string; subject: string }>(
		`SELECT id::text, subject FROM feedback WHERE source_trx_id = $1`,
		[trxId]
	);
	if (fb.rowCount === 0) return { ok: false, reason: 'feedback_not_found' };

	const row = fb.rows[0]!;
	if (row.subject !== ctx.signer) {
		// Only the account that was reviewed can respond. This is
		// where the contract's "authorization" check lives.
		return { ok: false, reason: 'responder_not_subject' };
	}

	try {
		await client.query(
			`INSERT INTO feedback_responses (
				feedback_id, responder, comment, created_at, source_trx_id
			) VALUES ($1, $2, $3, $4, $5)`,
			[parseInt(row.id, 10), ctx.signer, comment, ctx.blockTime, ctx.trxId]
		);
	} catch (err) {
		if (isUniqueViolation(err)) {
			return { ok: false, reason: 'duplicate_response' };
		}
		throw err;
	}

	return { ok: true };
};

export default handle;
