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
	/** v1.5.5: NULL when the account exists on-chain but has never set a
	 *  Morphit profile. See the batch query's accounts-anchored join. */
	display_name: string | null;
	json_metadata: unknown;
	/** v1.5.5: NULL for a profile-less account (no profile op to source). */
	source_block_num: string | null;
	/** v1.5.5: NULL for a profile-less account. */
	updated_at: Date | null;
	/** v1.5.5: does a `profiles` row actually exist for this account? Drives
	 *  the negative-caching decision, which must NOT key off row presence any
	 *  more — an accounts-anchored batch returns a row for every known
	 *  account. */
	has_profile: boolean;
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
		// v1.5.5 — both NULL for an account with no profile op. This used to
		// call parseInt()/toISOString() unconditionally, which was safe only
		// because the query could never return a profile-less row. Now it can.
		source_block_num: r.source_block_num === null ? null : parseInt(r.source_block_num, 10),
		updated_at: r.updated_at === null ? null : r.updated_at.toISOString(),
		posting_pubkey: r.posting_pubkey
	};
}

/** In-process positive-profile cache (t.txt avatar-latency batch).
 *
 *  Ken: profiles "STILL taking up to 7 seconds to appear for some accounts …
 *  the server itself can cache the user avatars and display name text". This
 *  query is PK-indexed and touches only THIS indexer's own DB (never the
 *  chain), so the latency is round-trip + Postgres contention while the poller
 *  hammers the DB applying blocks — not a slow plan. A tiny in-memory cache in
 *  front of the query lets a warm avatar/name return WITHOUT touching the DB at
 *  all, so profile reads stop queueing behind block-processing writes.
 *
 *  ONLY positive rows (an account that actually HAS a profile) are cached, for
 *  {@link PROFILE_MEM_TTL_MS}. A "no profile yet" negative is never cached — it
 *  is usually just indexer lag (the account signed up / broadcast a block or
 *  two ago), and caching it would hide a brand-new profile, the same trap the
 *  `no-store`-on-partial header avoids. Positives are the big, slow rows anyway
 *  (they carry the inline ~8 KB avatar); negatives are cheap to re-read.
 *  TTL-only, no explicit invalidation: 60s of staleness for a profile EDIT is
 *  within the 90s the Cache-Control header already promises, and the editor's
 *  own view is covered client-side by primeProfile. Per-route-instance (see
 *  {@link profilesRoute}) so tests get a fresh cache and an in-process second
 *  indexer can't share state. */
const PROFILE_MEM_TTL_MS = 60_000;

interface CachedProfileEntry {
	readonly value: ReturnType<typeof rowToProfile>;
	readonly at: number;
}

export function profilesRoute(db: Database): Hono {
	const app = new Hono();

	/** Per-instance warm-positive cache (see {@link PROFILE_MEM_TTL_MS}). */
	const memCache = new Map<string, CachedProfileEntry>();

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

		// Parameterized ANY($1::text[]) is the idiomatic PG pattern for "where X
		// is in this list." Single placeholder regardless of list size; safe
		// against SQL injection — the array is a bound parameter, not
		// interpolated. v1.5.5 (t155) — anchored on ACCOUNTS, not profiles, so a
		// key-only account (no display name / avatar) still returns a row with
		// the profile columns NULL and its posting key present; an account we've
		// never indexed still returns nothing, which is correct.
		//
		// Warm avatars/names come from the in-memory cache and skip the DB
		// entirely (the fix for Ken's "up to 7 seconds"): serve cached positives,
		// then query ONLY the accounts that missed. Every cache hit is a positive
		// (only positives are cached), so `accounts.length - toQuery.length` is
		// exactly the number served warm.
		const now = Date.now();
		const profiles: Record<string, ReturnType<typeof rowToProfile>> = {};
		const toQuery: string[] = [];
		for (const a of accounts) {
			const hit = memCache.get(a);
			if (hit && now - hit.at < PROFILE_MEM_TTL_MS) {
				profiles[a] = hit.value;
			} else {
				toQuery.push(a);
			}
		}

		let queriedWithProfile = 0;
		if (toQuery.length > 0) {
			const result = await db.query<ProfileRow>(
				`SELECT a.name AS account, p.display_name, p.json_metadata,
				        p.source_block_num::text, p.updated_at, a.posting_pubkey,
				        (p.account IS NOT NULL) AS has_profile
				 FROM accounts a
				 LEFT JOIN profiles p ON p.account = a.name
				 WHERE a.name = ANY($1::text[])`,
				[toQuery]
			);
			// Missing accounts (no row) are silently absent — graceful degrade
			// when a batch contains accounts that haven't set a profile yet.
			for (const row of result.rows) {
				const p = rowToProfile(row);
				profiles[row.account] = p;
				// Cache POSITIVES only (a real profile row). A key-only/no-profile
				// negative is never cached — it is usually indexer lag, and caching
				// it would hide a fresh profile (see PROFILE_MEM_TTL_MS).
				if (row.has_profile) {
					memCache.set(row.account, { value: p, at: now });
					queriedWithProfile++;
				}
			}
		}

		// #2 / v1.5.5 — a batch is COMPLETE (safe to pin in the browser HTTP
		// cache for the full 90s) only when EVERY requested account actually has
		// a profile: those served warm from cache (all positive) plus those the
		// query found with has_profile. This MUST key off has_profile, not row
		// presence — an accounts-anchored query returns a row for a profile-less
		// account too, and pinning that negative would keep a fresh profile
		// invisible across refreshes for 90s. Partial → no-store.
		const servedFromCache = accounts.length - toQuery.length;
		const complete = servedFromCache + queriedWithProfile === accounts.length;
		c.header('Cache-Control', complete ? BATCH_CACHE_CONTROL : BATCH_CACHE_CONTROL_PARTIAL);
		return c.json({ profiles });
	});

	app.get('/:account', async (c) => {
		const account = c.req.param('account');
		if (!isAccountName(account)) {
			return c.json(errorBody('bad_request', 'invalid account name'), 400);
		}

		// v1.5.5 — this route stays PROFILES-anchored, deliberately, unlike the
		// batch above. Its contract is "the profile for this account, or 404" —
		// a caller asking /v1/profiles/:account wants a profile, and inventing a
		// 200 with every field null would break that. The batch is different: it
		// is a bulk "tell me what you can render for these accounts" lookup, and
		// a posting key alone is renderable.
		//
		// `TRUE AS has_profile` is tautological here (the WHERE requires a
		// profiles row) but keeps the row honest against ProfileRow rather than
		// leaving the field undefined behind an unchecked query<> cast.
		const result = await db.query<ProfileRow>(
			`SELECT p.account, p.display_name, p.json_metadata,
			        p.source_block_num::text, p.updated_at, a.posting_pubkey,
			        TRUE AS has_profile
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
