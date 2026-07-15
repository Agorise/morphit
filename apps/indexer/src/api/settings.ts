/**
 * GET /v1/settings/:account
 *
 * Returns the account's ENCRYPTED settings blob (v1.5.0 settings-to-chain
 * mirroring), or `enc: null` if they've never saved one (client then keeps its
 * device-local defaults). The blob is opaque ciphertext — the indexer only
 * stores and serves it; it's decrypted client-side with a posting-key-derived
 * key, so this endpoint reveals nothing about a user's preferences or which
 * accounts they've hidden.
 *
 * Response: `{ account, enc: string | null, updated_at: string | null }`.
 * Same shape + contract as GET /v1/chat-folders/:account.
 */
import { Hono } from 'hono';

import type { Database } from '$db/pool';
import { errorBody, isAccountName } from '$api/shared';

interface Row {
	enc: string;
	updated_at: Date;
}

export function settingsRoute(db: Database): Hono {
	const app = new Hono();

	app.get('/:account', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		const result = await db.query<Row>(
			`SELECT enc, updated_at FROM user_settings WHERE account = $1 LIMIT 1`,
			[account]
		);

		const row = result.rows[0];
		return c.json({
			account,
			enc: row ? row.enc : null,
			updated_at: row ? row.updated_at.toISOString() : null
		});
	});

	return app;
}
