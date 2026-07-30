/**
 * Morphit indexer — /v1/chat-identity/:account endpoint.
 *
 * Returns the latest published X25519 chat public key for an
 * account, or 404 if the account has never published
 * `morphit_chat_identity_v1`.
 *
 * Authentication: none. Chat pubkeys are public by design — they
 * MUST be public so senders can encrypt to them. Exposing them
 * via a no-auth endpoint is equivalent to exposing on-chain data,
 * which is already public.
 *
 * Caching: the server does not set Cache-Control because response
 * validity depends on whether the user has rotated since the last
 * fetch. Clients are expected to cache briefly (per-conversation)
 * and refetch on next conversation open.
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import { errorBody, isAccountName } from '$api/shared';

interface ChatIdentityRow {
	account: string;
	chat_pub: Buffer;
	source_block_num: string; // Postgres bigint → JS string in pg driver
	source_trx_id: string;
	updated_at: Date;
}

export function chatIdentityRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/:account', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		const result = await db.query<ChatIdentityRow>(
			`SELECT account, chat_pub, source_block_num::text,
			        source_trx_id, updated_at
			 FROM chat_identities
			 WHERE account = $1`,
			[account]
		);

		if (result.rows.length === 0) {
			return c.json(errorBody('not_found', `no chat identity for @${account}`), 404);
		}

		const row = result.rows[0]!;
		// Block numbers are bigint in Postgres but in practice fit
		// comfortably in a JS Number — Blurt produces ~10M blocks/year
		// and the safe-integer ceiling is 2^53−1 (~900M years of
		// runway). parseInt is sound here.
		return c.json({
			account: row.account,
			// chat_pub is stored as raw bytes in Postgres (BYTEA);
			// pg returns it as a Buffer. Encode to base64 for JSON.
			chat_pub: row.chat_pub.toString('base64'),
			source_block_num: parseInt(row.source_block_num, 10),
			// source_trx_id lets clients (per ADR-0015 §S2 mitigation)
			// verify the chat-identity op directly against a Blurt
			// RPC, defending against an indexer that swaps chat_pub
			// values to MITM chat content.
			source_trx_id: row.source_trx_id,
			updated_at: row.updated_at.toISOString()
		});
	});

	return app;
}
