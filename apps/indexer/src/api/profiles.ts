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
	/** cp471 (D7/E): the account's posting public key (base58 TEXT),
	 *  joined from `accounts`, so profile cards can show the truncated
	 *  key under a display name. Null for an account we've never indexed
	 *  a key for. */
	posting_pubkey: string | null;
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

/** #2 — cache header for a batch response that OMITS at least one requested
 *  account (i.e. carries a negative "no profile for this account" result).
 *
 *  An absent account is only *provisionally* authoritative: the commonest
 *  cause is indexer lag — the account just broadcast its profile op (or just
 *  signed up) and the block hasn't been indexed yet, a 1–2 block window. If
 *  such a response is cached for 90s (+60s stale-while-revalidate), the
 *  browser's HTTP cache replays it on every subsequent load of the same URL,
 *  so the fresh profile stays invisible for up to two and a half minutes —
 *  and, crucially, SURVIVES A PAGE REFRESH (the client's in-memory cache is
 *  cleared by the reload, the browser's disk cache is not). The user sees
 *  their display name fall back to "@account" and their avatar to the
 *  identicon, refreshes, and nothing changes.
 *
 *  Positive results stay cacheable for the full 90s: a profile that exists
 *  can only be superseded by a later profile op, and 90s of staleness there
 *  is the documented, acceptable trade. Negative results must not be pinned.
 *  Mirrors the client-side soft-null policy (cp428) and the same reasoning as
 *  the dynamic-data service-worker exclusion (cp324). */
const BATCH_CACHE_CONTROL_PARTIAL = 'no-store';

function rowToProfile(r: ProfileRow) {
	return {
		account: r.account,
		display_name: r.display_name,
		json_metadata: r.json_metadata,
		source_block_num: parseInt(r.source_block_num, 10),
		updated_at: r.updated_at.toISOString(),
		posting_pubkey: r.posting_pubkey
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
			`SELECT p.account, p.display_name, p.json_metadata,
			        p.source_block_num::text, p.updated_at, a.posting_pubkey
			 FROM profiles p
			 LEFT JOIN accounts a ON a.name = p.account
			 WHERE p.account = ANY($1::text[])`,
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

		// #2 — only a COMPLETE batch (every requested account resolved to a
		// row) is safe to cache. A partial result carries negative entries
		// that are usually just indexer lag, and pinning them in the browser's
		// HTTP cache makes a fresh profile invisible across refreshes.
		const complete = result.rows.length === accounts.length;
		c.header('Cache-Control', complete ? BATCH_CACHE_CONTROL : BATCH_CACHE_CONTROL_PARTIAL);
		return c.json({ profiles });
	});

	app.get('/:account', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		const result = await db.query<ProfileRow>(
			`SELECT p.account, p.display_name, p.json_metadata,
			        p.source_block_num::text, p.updated_at, a.posting_pubkey
			 FROM profiles p
			 LEFT JOIN accounts a ON a.name = p.account
			 WHERE p.account = $1`,
			[account]
		);
		if (result.rowCount === 0) {
			// #2 — a bare 404 carries no cache header, and a 404 is
			// HEURISTICALLY cacheable: a shared cache is free to invent a
			// freshness lifetime for it. Same failure mode as the batch
			// endpoint's negative results — this account most likely just
			// broadcast its profile a block or two ago. Never let "no profile
			// yet" get pinned.
			c.header('Cache-Control', BATCH_CACHE_CONTROL_PARTIAL);
			return c.json(errorBody('not_found', 'no profile for that account'), 404);
		}

		return c.json(rowToProfile(result.rows[0]!));
	});

	return app;
}
