/**
 * Handler: morphit_operator_block_v1  (Item 3)
 *
 * Payload shape (validated):
 *   {
 *     v: 1,
 *     blocked: <account>,
 *     action: "block" | "unblock",
 *     reason: <string, ≤500 chars>,
 *     ts: <unix seconds>
 *   }
 *
 * Effect: if `ctx.signer === ctx.config.operatorAccountName`, record
 * (or reverse) an operator-instance block of `blocked`.  Anyone
 * else's signature is rejected with `not_operator` — the operator-
 * block surface is gated to the configured operator account, since
 * "operator @bob blocked alice" only makes sense when bob is THIS
 * INSTANCE's actual operator.
 *
 * Storage: `operator_blocks` table.  Schema mirrors the existing
 * user-level `blocks` table: keyed on (operator, blocked), keeps
 * since_* anchors and a current state.  Reasons live alongside.
 *
 * The blocked user is NOT prevented from accessing the instance's
 * UI — orderbook view simply filters their listings out.  Other
 * surfaces (chat, profile pages) are unaffected; this is
 * specifically a curation tool for the orderbook.
 *
 * The reason field is operator-supplied free text bounded at 500
 * chars.  The frontend renders it with text-only escaping (no
 * HTML interpretation) and the indexer validates UTF-8 length.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';

const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;
const MAX_REASON_LEN = 500;

/** Codepoints stripped from operator-supplied reasons before
 *  storage.  Mirrors apps/web/src/lib/crypto/profile.ts's
 *  FORBIDDEN_CODEPOINTS set — the codebase convention is to
 *  duplicate constants across independently-deployable apps
 *  rather than introduce a shared dependency.
 *
 *  Why we STRIP rather than REJECT (unlike display names): a
 *  display name is a user's chosen identifier and should obey
 *  strict rules.  An operator-supplied moderation reason is free
 *  text the operator may have copy-pasted from elsewhere; a hard
 *  reject for an accidental zero-width-joiner is hostile UX for
 *  the operator.  Strip the dangerous codepoints, accept what's
 *  left.
 *
 *  The set covers:
 *    - Bidirectional override / formatting (could re-order the
 *      reason's display, e.g. operator writes a benign reason
 *      that visually appears to be praise of the blocked user).
 *    - Zero-width joiners / spaces / no-break spaces (invisible
 *      content that could be used to fingerprint a copy of the
 *      reason or to make two visually-identical reasons differ
 *      byte-wise).
 *    - C0/C1 control characters (null, escape, etc.) except
 *      newline and tab which are kept — the banner UI collapses
 *      whitespace anyway, and a multi-line reason is legitimate. */
const FORBIDDEN_REASON_CODEPOINTS = new Set<number>([
	// Bidi
	0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069,
	// Zero-width
	0x200b, 0x200c, 0x200d, 0xfeff,
	// Invisible math/language
	0x2060, 0x2061, 0x2062, 0x2063, 0x2064
]);

/** Strip dangerous/invisible codepoints from an operator reason.
 *  Preserves newline (0x0a) and tab (0x09) since they're
 *  legitimate in multi-line reasons; strips everything else in
 *  the C0/C1 control ranges.  Returns the cleaned string.
 *
 *  cp138 A-5: NFC-normalize before stripping so the codepoint
 *  iteration sees canonical sequences.  Without NFC, an NFD-
 *  decomposed input could carry visually-equivalent characters
 *  with different codepoint values, and the strip loop would
 *  hit the WRONG codepoints (e.g. NFD-decomposed bidi marks
 *  might miss).  Matches the NFC-first pattern used by
 *  order.ts, feedback.ts, profile.ts, operatorRegister.ts. */
function sanitizeReason(raw: string): string {
	const normalized = raw.normalize('NFC');
	let out = '';
	for (const ch of normalized) {
		const cp = ch.codePointAt(0)!;
		// Strip explicit forbidden set.
		if (FORBIDDEN_REASON_CODEPOINTS.has(cp)) continue;
		// Strip C0 control chars except LF (0x0a) and TAB (0x09).
		// CR (0x0d) is also stripped — banner renders LF; CRLF
		// becomes LF after strip, which is fine.
		if (cp >= 0x00 && cp <= 0x1f && cp !== 0x0a && cp !== 0x09) continue;
		// Strip C1 control chars (0x7f–0x9f).
		if (cp >= 0x7f && cp <= 0x9f) continue;
		out += ch;
	}
	return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface OperatorBlocksRow {
	state: 'blocked' | 'unblocked';
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	// Gate: only the configured operator account can sign these.
	// Uses operatorAccountName (per-instance) rather than
	// officialAccountName (federation-wide release-signer); see
	// B3 audit note for the rationale on splitting these roles.
	if (ctx.signer !== ctx.config.operatorAccountName) {
		return { ok: false, reason: 'not_operator' };
	}

	if (!isPlainObject(ctx.payload)) {
		return { ok: false, reason: 'payload_not_object' };
	}

	const v = ctx.payload.v;
	if (v !== 1) return { ok: false, reason: 'unsupported_version' };

	const blocked = ctx.payload.blocked;
	if (typeof blocked !== 'string' || !ACCOUNT_NAME_RE.test(blocked)) {
		return { ok: false, reason: 'blocked_invalid' };
	}
	if (blocked === ctx.signer) {
		// Self-block makes no sense; refuse cleanly.
		return { ok: false, reason: 'self_block' };
	}

	const action = ctx.payload.action;
	if (action !== 'block' && action !== 'unblock') {
		return { ok: false, reason: 'action_invalid' };
	}

	const reasonRaw = ctx.payload.reason;
	if (typeof reasonRaw !== 'string') {
		return { ok: false, reason: 'reason_invalid' };
	}
	if (reasonRaw.length > MAX_REASON_LEN) {
		return { ok: false, reason: 'reason_too_long' };
	}
	// Audit finding #10: strip bidi-override + zero-width + control
	// chars from the operator's reason BEFORE storage.  This is the
	// canonical defense; the banner also strips on render as belt-
	// and-braces (#15).  We strip rather than reject because a
	// reason copy-pasted from elsewhere may incidentally include
	// these chars; we shouldn't fail the whole moderation op over
	// it.  Length cap was applied to the raw input, so the
	// sanitized form is by definition <= MAX_REASON_LEN.
	const reason = sanitizeReason(reasonRaw);

	// Look up the current state of this (operator, blocked) pair.
	const existing = await client.query<OperatorBlocksRow>(
		`SELECT state FROM operator_blocks WHERE operator = $1 AND blocked = $2`,
		[ctx.signer, blocked]
	);
	const currentState = existing.rows[0]?.state ?? null;

	if (action === 'unblock' && currentState === null) {
		return { ok: false, reason: 'no_prior_block' };
	}
	if (action === 'block' && currentState === 'blocked') {
		// Idempotent re-block; update reason if it changed but
		// don't move since_* timestamps.  The operator may want
		// to amend the stated reason without resetting the audit
		// trail.
		await client.query(
			`UPDATE operator_blocks
			    SET reason = $3,
			        last_action_block_num = $4,
			        updated_at = $5
			  WHERE operator = $1 AND blocked = $2`,
			[ctx.signer, blocked, reason, ctx.blockNum, ctx.blockTime]
		);
		return { ok: true };
	}
	if (action === 'unblock' && currentState === 'unblocked') {
		return { ok: true };
	}

	if (currentState === null) {
		// Fresh block.
		await client.query(
			`INSERT INTO operator_blocks
			   (operator, blocked, state, reason,
			    since_block_num, since_trx_id,
			    last_action_block_num, created_at, updated_at)
			 VALUES ($1, $2, 'blocked', $3, $4, $5, $4, $6, $6)`,
			[ctx.signer, blocked, reason, ctx.blockNum, ctx.trxId, ctx.blockTime]
		);
		return { ok: true };
	}

	if (action === 'block') {
		// Was 'unblocked', now 'blocked' again — new relationship.
		await client.query(
			`UPDATE operator_blocks
			    SET state = 'blocked',
			        reason = $3,
			        since_block_num = $4,
			        since_trx_id = $5,
			        last_action_block_num = $4,
			        created_at = $6,
			        updated_at = $6
			  WHERE operator = $1 AND blocked = $2`,
			[ctx.signer, blocked, reason, ctx.blockNum, ctx.trxId, ctx.blockTime]
		);
	} else {
		// Unblock-after-block: keep the since_* anchor (the
		// audit-trail "this relationship started here" stays
		// pointing at the original block) but flip state.
		await client.query(
			`UPDATE operator_blocks
			    SET state = 'unblocked',
			        reason = $3,
			        last_action_block_num = $4,
			        updated_at = $5
			  WHERE operator = $1 AND blocked = $2`,
			[ctx.signer, blocked, reason, ctx.blockNum, ctx.blockTime]
		);
	}

	return { ok: true };
};

export default handle;
