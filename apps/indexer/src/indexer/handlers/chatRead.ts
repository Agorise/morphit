/**
 * Handler: morphit_chat_read_v1
 *
 * Payload shape:
 *   {
 *     "peer": string (blurt account name),
 *     "last_read_at": string (ISO 8601 UTC timestamp),
 *     "order_permlink"?: string (cp446 — WHICH discussion was read:
 *        the order's permlink, or "" for the thread that cites no order.
 *        OMITTED by pre-cp446 clients, and that means what it always
 *        meant: everything with this peer. Stored as the '*' sentinel.
 *        A client may not send "*" itself — it would forge a peer-wide
 *        ack — and a permlink longer than 256 chars is rejected.)
 *   }
 *
 * Effect: record that ctx.signer has acknowledged reading their
 * conversation with `peer` up through `last_read_at`. Writes a
 * single row in `chat_read_state` keyed on (reader_account,
 * peer_account). An existing row is updated if and only if the
 * new `last_read_at` is strictly greater than the current value
 * — this monotonic-advance guard prevents out-of-order / replay
 * acks from regressing a user's read state.
 *
 * Why monotonic-advance matters:
 *   User reads through message at T+5 on their phone → phone
 *   broadcasts ack(T+5). Laptop was offline, comes back later,
 *   broadcasts a stale ack(T+2) based on what the laptop saw
 *   when it was last open. Without the guard, the T+2 ack
 *   would land in a later block and *regress* the read state,
 *   incorrectly re-marking the T+2..T+5 messages as unread.
 *   The guard rejects the stale ack; state stays correct.
 *
 * This handler is the ONLY place that writes chat_read_state.
 * The table is append-update only — there is no DELETE path.
 */

import type pg from 'pg';
import type { Handler, HandlerResult, OpContext } from '$indexer/handler-contract';

const ACCOUNT_NAME_RE = /^[a-z][a-z0-9.-]{1,14}[a-z0-9]$/;

/** Allow up to 60 seconds of clock skew past block time. Blurt's
 *  block producers stamp the block time; a well-behaved client
 *  could plausibly read a message that arrives mid-block and
 *  submit an ack within the same block, hence a small tolerance. */
const MAX_FUTURE_SKEW_MS = 60_000;

/** O3.5 — strict ISO-8601 shape match.  Pre-fix this used the
 *  permissive `new Date()` parser, which accepts engine-dependent
 *  formats like "12/31/2099" or "December 15 2025".  Different JS
 *  engines (V8 vs Spidermonkey) parse some strings differently —
 *  not a current consensus risk (the indexer is Node-only), but
 *  the strict shape eliminates the ambiguity surface.  Same regex
 *  the order.ts / orderReplace.ts handlers use. */
const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

function isPlainObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

const handle: Handler = async (ctx: OpContext, client: pg.PoolClient): Promise<HandlerResult> => {
	if (!isPlainObject(ctx.payload)) return { ok: false, reason: 'payload_not_object' };

	const peer = ctx.payload.peer;
	if (typeof peer !== 'string' || !ACCOUNT_NAME_RE.test(peer)) {
		return { ok: false, reason: 'peer_invalid' };
	}
	if (peer === ctx.signer) return { ok: false, reason: 'self_chat' };

	const lastReadRaw = ctx.payload.last_read_at;
	if (typeof lastReadRaw !== 'string') {
		return { ok: false, reason: 'last_read_at_not_string' };
	}
	// O3.5 — strict ISO-8601 shape check before parsing.
	if (!ISO_8601_RE.test(lastReadRaw)) {
		return { ok: false, reason: 'last_read_at_invalid' };
	}
	const lastReadMs = new Date(lastReadRaw).getTime();
	if (!Number.isFinite(lastReadMs)) {
		return { ok: false, reason: 'last_read_at_invalid' };
	}
	// Reject absurdly future-dated acks. Signed-but-stale ops can
	// sit in mempool for a few seconds; anything further out than
	// our skew budget is either malformed or malicious.
	const blockMs = ctx.blockTime.getTime();
	if (lastReadMs > blockMs + MAX_FUTURE_SKEW_MS) {
		return { ok: false, reason: 'last_read_at_in_future' };
	}
	// Reject absurdly past-dated acks too. Acking 1970 is never
	// legitimate; the chat_messages table can't have messages from
	// before the indexer started. Floor at 2020.
	if (lastReadMs < Date.parse('2020-01-01T00:00:00Z')) {
		return { ok: false, reason: 'last_read_at_too_old' };
	}

	// cp446 — WHICH DISCUSSION was read. Optional: a pre-cp446 client omits it,
	// and that op means exactly what it always meant — "everything with this peer".
	// We record that as the '*' sentinel rather than guessing a thread, so an old
	// client can never silently mark one thread and leave the rest looking read.
	//
	// A permlink is validated for shape only. It does not have to name a live
	// order: acking a discussion about an order that has since been cancelled is
	// perfectly legitimate, and the row is inert if the permlink is nonsense.
	const rawOrder = ctx.payload.order_permlink;
	let orderPermlink: string;
	if (rawOrder === undefined || rawOrder === null) {
		orderPermlink = '*'; // legacy peer-wide ack
	} else if (typeof rawOrder !== 'string' || rawOrder.length > 256 || rawOrder === '*') {
		// '*' is reserved: a client must not be able to forge a peer-wide ack by
		// naming it as a thread, and an over-long permlink is malformed.
		return { ok: false, reason: 'order_permlink_invalid' };
	} else {
		orderPermlink = rawOrder; // '' is the order-less thread; anything else is a permlink
	}

	// Insert or monotonic-advance update. The WHERE clause in the
	// DO UPDATE makes this atomic: concurrent acks can both execute
	// without a race, and only the later one wins if it arrives out
	// of order. If the incoming ack is not strictly greater, the
	// UPDATE is a no-op — we still return ok:true so the op is not
	// rejected as invalid (the signer did nothing wrong; their ack
	// was just superseded).
	await client.query(
		`INSERT INTO chat_read_state (
			reader_account, peer_account, order_permlink, last_read_at,
			source_block_num, source_trx_id, updated_at
		) VALUES ($1, $2, $3, $4, $5, $6, $7)
		ON CONFLICT (reader_account, peer_account, order_permlink) DO UPDATE SET
			last_read_at = EXCLUDED.last_read_at,
			source_block_num = EXCLUDED.source_block_num,
			source_trx_id = EXCLUDED.source_trx_id,
			updated_at = EXCLUDED.updated_at
		WHERE chat_read_state.last_read_at < EXCLUDED.last_read_at`,
		[ctx.signer, peer, orderPermlink, new Date(lastReadMs), ctx.blockNum, ctx.trxId, ctx.blockTime]
	);

	return { ok: true };
};

export default handle;
