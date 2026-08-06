/**
 * Morphit indexer — /v1/chat-admission/:me/:peer endpoint.
 *
 * Returns whether a chat message from `me` to `peer` would
 * currently pass the chat handler's Finding H layer-2 gate.
 * Used by the frontend to decide whether to show a normal
 * composer or the pay-stranger-fee affordance when a user
 * opens a conversation with someone new.
 *
 * The derived state is a straightforward disjunction:
 *   1. Any chat_messages row between the pair (either
 *      direction), OR
 *   2. A stranger_fees row recording a paid admission.
 *
 * If either holds, admitted=true. Otherwise admitted=false
 * and the frontend should gate composing behind a pay flow.
 *
 * Authentication: none. Every feeder state is public on-chain
 * (chat message ciphertext is on Blurt, stranger-fee ops are
 * on Blurt). This endpoint just pre-aggregates.
 *
 * Response shape:
 *   {
 *     me: string,
 *     peer: string,
 *     admitted: boolean,
 *     reason: "prior_exchange" | "fee_paid" | "none"
 *   }
 *
 * reason:
 *   - "prior_exchange" → chat_messages row exists (admitted via
 *     deploy-safety / real-conversation branch).
 *   - "fee_paid"       → stranger_fees row exists (admitted via
 *     layer-2 paid branch).
 *   - "none"           → neither; admitted=false.
 *
 * When both are true, we report "prior_exchange" — the
 * conversation is alive regardless of whether a fee was ever
 * paid, so that's the UX-relevant signal.
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import { errorBody, isAccountName } from '$api/shared';

interface Row {
	has_exchange: boolean;
	has_fee: boolean;
}

export function chatAdmissionRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/:me/:peer', async (c) => {
		const me = c.req.param('me');
		const peer = c.req.param('peer');
		if (!isAccountName(me) || !isAccountName(peer)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}
		if (me === peer) {
			// Self-chat has no admission concept; return admitted=true
			// with reason="prior_exchange" so the client treats it as
			// a no-op (the chat handler rejects self-chat anyway, but
			// avoiding a false "pay fee to message yourself" UX is
			// the friendly behavior).
			return c.json({
				me,
				peer,
				admitted: true,
				reason: 'prior_exchange' as const
			});
		}

		const sql = `
			SELECT
			  EXISTS (
			    SELECT 1 FROM chat_messages
			     WHERE (sender = $1 AND recipient = $2)
			        OR (sender = $2 AND recipient = $1)
			  ) AS has_exchange,
			  EXISTS (
			    SELECT 1 FROM stranger_fees
			     WHERE sender = $1 AND recipient = $2
			  ) AS has_fee
		`;

		const result = await db.query<Row>(sql, [me, peer]);
		const row = result.rows[0] ?? { has_exchange: false, has_fee: false };

		const admitted = row.has_exchange || row.has_fee;
		const reason = row.has_exchange
			? ('prior_exchange' as const)
			: row.has_fee
				? ('fee_paid' as const)
				: ('none' as const);

		return c.json({ me, peer, admitted, reason });
	});

	return app;
}
