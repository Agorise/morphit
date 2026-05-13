/**
 * Morphit indexer — /v1/profiles endpoints.
 *
 * Two variants:
 *   GET /v1/profiles/:account     — single profile by account name.
 *                                   404 if the account has never
 *                                   broadcast a morphit_profile_v1 op.
 *   GET /v1/profiles?accounts=a,b — batch lookup, up to 100 accounts.
 *                                   Accounts without a profile row
 *                                   are silently dropped from the
 *                                   response.
 *
 * Rationale for the batch form: pages that render many usernames
 * (orderbook rows, feedback lists) used to have two bad options —
 * N+1 requests or N+1 identicons. See docs/BATCH-PROFILES-DESIGN.md.
 */

import { Hono } from 'hono';

import type { Database } from '$db/pool';
import { errorBody, isAccountName } from '$api/shared';

interface ProfileRow {
	account: string;
	display_name: string;
	json_metadata: unknown;
	source_block_num: string;
	updated_at: Date;
}

/** Max accounts per batch request. Caps worst-case query cost and
 *  prevents a hostile caller materializing thousands of rows. See
 *  docs/BATCH-PROFILES-DESIGN.md for the derivation. */
const MAX_BATCH_SIZE = 100;

/** Cache header for batch responses. 90 seconds matches ~90 Blurt
 *  blocks; a profile update propagates to orderbook-row avatars
 *  within 90s, which is acceptable for a nice-to-have surface.
 *  stale-while-revalidate lets the CDN serve slightly stale responses
 *  while refreshing in the background. */
const BATCH_CACHE_CONTROL = 'public, max-age=90, stale-while-revalidate=60';

function rowToProfile(r: ProfileRow) {
	return {
		account: r.account,
		display_name: r.display_name,
		json_metadata: r.json_metadata,
		source_block_num: parseInt(r.source_block_num, 10),
		updated_at: r.updated_at.toISOString()
	};
}

export function profilesRoute(db: Database): Hono {
	const app = new Hono();

	// Batch lookup — MUST be registered before the /:account route
	// so Hono resolves `/` (batch) before treating the empty segment
	// as a named parameter.
	app.get('/', async (c) => {
		const raw = c.req.query('accounts');
		if (typeof raw !== 'string' || raw.length === 0) {
			return c.json(errorBody('bad_request', 'missing accounts query parameter'), 400);
		}

		// Split, trim, filter empties, deduplicate. A caller passing
		// "alice,,bob" shouldn't fail — the empty slot is forgiving-
		// normalized. A caller passing "alice,bob,alice" gets one
		// lookup per distinct account.
		const split = raw
			.split(',')
			.map((s) => s.trim())
			.filter((s) => s.length > 0);
		const accounts = Array.from(new Set(split));

		if (accounts.length === 0) {
			return c.json(
				errorBody('bad_request', 'accounts parameter is empty after normalization'),
				400
			);
		}
		if (accounts.length > MAX_BATCH_SIZE) {
			return c.json(
				errorBody('bad_request', `batch exceeds max size of ${MAX_BATCH_SIZE} accounts`),
				400
			);
		}

		// Validate every account name before hitting the DB. A batch
		// containing a malformed name is 400 in whole — the caller
		// has a bug, and we'd rather tell them than silently drop
		// the bad entries (which would look like "those accounts
		// don't have profiles" from their perspective, a misleading
		// signal).
		for (const a of accounts) {
			if (!isAccountName(a)) {
				return c.json(errorBody('bad_request', `invalid account name: ${a}`), 400);
			}
		}

		// Parameterized ANY($1::text[]) is the idiomatic PG pattern
		// for "where X is in this list." Single placeholder regardless
		// of list size; Postgres plans it as a hash lookup for larger
		// arrays. Safe against SQL injection — the array is a bound
		// parameter, not interpolated into the query string.
		const result = await db.query<ProfileRow>(
			`SELECT account, display_name, json_metadata,
			        source_block_num::text, updated_at
			 FROM profiles WHERE account = ANY($1::text[])`,
			[accounts]
		);

		// Build the response map. Missing accounts (no row returned)
		// are silently absent — design decision to degrade gracefully
		// when a batch contains some accounts that haven't set a
		// profile yet.
		const profiles: Record<string, ReturnType<typeof rowToProfile>> = {};
		for (const row of result.rows) {
			profiles[row.account] = rowToProfile(row);
		}

		c.header('Cache-Control', BATCH_CACHE_CONTROL);
		return c.json({ profiles });
	});

	app.get('/:account', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		const result = await db.query<ProfileRow>(
			`SELECT account, display_name, json_metadata,
			        source_block_num::text, updated_at
			 FROM profiles WHERE account = $1`,
			[account]
		);
		if (result.rowCount === 0) {
			return c.json(errorBody('not_found', 'no profile for that account'), 404);
		}

		return c.json(rowToProfile(result.rows[0]!));
	});

	return app;
}
