/**
 * Morphit — operator-instance block op shape.
 *
 * Item 3 of the post-Batch-I task list.  An operator who runs a
 * Morphit instance can choose to filter specific accounts out of
 * THEIR instance's orderbook view by broadcasting a signed
 * `morphit_operator_block_v1` custom_json op.
 *
 * Critical scope clarifications:
 *
 *   • This is INSTANCE-LEVEL filtering, not chain-level censorship.
 *     The blocked user's orders, comments, balance, and identity
 *     remain on chain unchanged.  Other instances see them
 *     normally.  The block is just "this operator declines to
 *     surface this user in this instance's UI."
 *
 *   • The op is SIGNED BY THE OPERATOR ACCOUNT (e.g. @morphit on
 *     the canonical instance, or whoever runs another instance).
 *     The user being blocked has no signature on the op.  Blocks
 *     are publicly visible on chain — anyone can audit which
 *     accounts an operator has blocked and read the operator's
 *     stated reason.
 *
 *   • The blocked user is NOT prevented from accessing the
 *     instance (they can browse, view profiles, etc.).  Only
 *     their own listings are hidden from the orderbook view, and
 *     the operator can choose whether to also block their chats
 *     to other users on that instance (separate user-level block
 *     mechanism via `morphit_block_v1`).  This op affects only
 *     the orderbook surface.
 *
 *   • The blocked user gets a clear, friendly notification when
 *     they visit the instance — they can see the operator's
 *     stated reason and how to contact them.  Honest-and-narrow
 *     framing per the design pick.  The notification is generated
 *     client-side from chain data; no separate notification
 *     channel.
 *
 *   • Blocks are REVERSIBLE via an `unblock` action op.  The
 *     indexer applies them in chain order; the most recent action
 *     for any (operator, blocked) pair wins.
 *
 *   • The operator's reason is bounded.  Long enough to explain
 *     ("repeated reports of payment scams during October 2026"),
 *     short enough to display cleanly and short enough that
 *     storing every block reason permanently is cheap.
 */

/** Maximum length of the operator's stated reason, in characters
 *  (UTF-16 code units, since that's what `string.length` returns
 *  in JS).  Long enough for a paragraph or two; short enough to
 *  display cleanly in a banner. */
export const OPERATOR_BLOCK_REASON_MAX = 500;

/** On-wire payload of a `morphit_operator_block_v1` custom_json
 *  op.  Signed by the operator's posting key. */
export interface OperatorBlockPayload {
	readonly v: 1;
	/** Account being blocked.  Must be a valid Blurt account
	 *  name; the indexer rejects malformed values. */
	readonly blocked: string;
	readonly action: 'block' | 'unblock';
	/** Operator's stated reason.  Bounded to
	 *  OPERATOR_BLOCK_REASON_MAX chars.  Empty string is
	 *  PERMITTED (operator declines to give one) but the
	 *  notification UI nudges operators to provide one because
	 *  silent blocks erode trust. */
	readonly reason: string;
	/** Unix seconds at op production. */
	readonly ts: number;
}

/** Validate a parsed payload.  Returns null on success, an error
 *  string on failure.  Used by the indexer to gate writes and by
 *  ops-cli to gate broadcasts. */
export function validateOperatorBlockPayload(p: unknown): string | null {
	if (typeof p !== 'object' || p === null) return 'payload must be an object';
	const u = p as Record<string, unknown>;
	if (u.v !== 1) return `unsupported version: ${String(u.v)}`;
	if (typeof u.blocked !== 'string') return 'blocked must be a string';
	// Mirror the account-name regex used elsewhere in the codebase.
	if (!/^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/.test(u.blocked)) {
		return 'blocked has an invalid account-name shape';
	}
	if (u.action !== 'block' && u.action !== 'unblock') {
		return 'action must be "block" or "unblock"';
	}
	if (typeof u.reason !== 'string') return 'reason must be a string';
	if (u.reason.length > OPERATOR_BLOCK_REASON_MAX) {
		return `reason exceeds ${OPERATOR_BLOCK_REASON_MAX} chars`;
	}
	if (typeof u.ts !== 'number' || !Number.isFinite(u.ts) || u.ts <= 0) {
		return 'ts must be a positive number';
	}
	return null;
}

/** A persisted operator-block record as the indexer surfaces it.
 *  The shape mirrors the op but adds chain-context fields the
 *  indexer can vouch for. */
export interface OperatorBlockRecord {
	readonly operator: string;
	readonly blocked: string;
	readonly reason: string;
	/** Unix seconds — chain block time, NOT the op's self-reported
	 *  ts (which a malicious operator could backdate). */
	readonly created_at: number;
	readonly trx_id: string;
	readonly block_num: number;
}
