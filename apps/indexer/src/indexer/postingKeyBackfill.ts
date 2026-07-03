/**
 * Morphit indexer — posting-key backfill (cp404, option A).
 *
 * Order cards show a trader's truncated posting public key ("(BLT5vw…7Bjw)")
 * as an identity anchor. Resolving that per-card from the chain for a whole
 * orderbook list would be N lookups on every load — against the tiny-footprint
 * priority — so instead the indexer stores each account's primary posting key
 * in accounts.posting_pubkey (migration v36) and the orderbook query serves it
 * inline.
 *
 * New accounts get their key at ingest, straight from the account_create op's
 * posting authority (see dispatcher.ts). This routine covers the rest: accounts
 * created before the column existed (their row has a NULL posting_pubkey). It
 * fills only NULL rows — it does NOT re-fetch keys that have since rotated on
 * chain (that would mean re-reading every account on every boot, against the
 * tiny-footprint priority). A stale display key is harmless: this value is
 * display-only, and signature verification always resolves the current key live
 * from the chain authority (blurt/verify.ts). It runs once per startup, in the
 * background, so it never blocks the poller.
 *
 * DISPLAY-ONLY: signature verification still resolves keys live from the chain
 * authority (blurt/verify.ts) and never trusts this column.
 *
 * On the collapsed-baseline migration phase: the migration runner tracks
 * versions by number and won't re-run v1 when schema.sql changes, and the
 * contract validator can't yet accept a separate additive version (that's a
 * launch-time un-collapse). So the column is delivered onto an already-migrated
 * beta DB by an idempotent ADD COLUMN IF NOT EXISTS, exported as
 * ensurePostingPubkeyColumn(). cp405: main.ts AWAITS that on the boot path,
 * right after runMigrations() and BEFORE the HTTP server binds — so the column
 * is guaranteed present before the orderbook query (which selects it) can ever
 * be served. Previously the ensure ran ONLY inside this fire-and-forget
 * backfill, so it raced the first request and, if the ADD COLUMN threw, left the
 * orderbook hard-down (500 on every load) while the indexer stayed up — the
 * "Can't reach the indexer" beta.44 regression. The awaited boot step removes
 * both hazards. This function still calls the ensure first, so it stays correct
 * when invoked standalone (tests). At launch this becomes a normal tracked
 * migration and the ensure-column step goes away.
 */

import type { BlurtClient } from '$blurt/client';
import type { Database } from '$db/pool';
import { logger } from '$log';

const log = logger('posting-key-backfill');

/** Chain batch size for condenser_api.get_accounts. */
const BATCH = 100;
/** Max accounts to backfill per startup. A beta typically clears in one
 *  run; a very large table converges over restarts (each run takes the
 *  next slice of NULLs). Keeps chain load bounded at boot. */
const DEFAULT_MAX = 5000;

export interface BackfillResult {
	readonly ensuredColumn: boolean;
	readonly scanned: number;
	readonly updated: number;
	readonly remaining: number;
}

/**
 * Extract the primary posting public key from a chain account's posting
 * authority. Defensive: returns null on any malformed/absent shape.
 */
export function primaryPostingKey(acc: {
	posting?: { key_auths?: readonly (readonly [string, number])[] };
}): string | null {
	const ka = acc.posting?.key_auths;
	if (Array.isArray(ka) && Array.isArray(ka[0]) && typeof ka[0][0] === 'string' && ka[0][0]) {
		return ka[0][0];
	}
	return null;
}

/**
 * Idempotently add accounts.posting_pubkey. AWAITED on the boot path (main.ts)
 * right after migrations and before the HTTP server binds, so the column always
 * exists before the orderbook query that selects it can be served — a missing
 * additive column can never bring the orderbook down. Idempotent (IF NOT
 * EXISTS): safe to run on every boot and from the backfill below.
 */
export async function ensurePostingPubkeyColumn(db: Database): Promise<void> {
	await db.query(`ALTER TABLE accounts ADD COLUMN IF NOT EXISTS posting_pubkey TEXT`);
}

export async function backfillPostingKeys(
	db: Database,
	blurt: BlurtClient,
	opts: { maxAccounts?: number } = {}
): Promise<BackfillResult> {
	// Idempotent ensure so this stays correct when invoked standalone (tests);
	// on the real boot path main.ts has already awaited ensurePostingPubkeyColumn()
	// before the server bound, so here it's a no-op.
	await ensurePostingPubkeyColumn(db);

	const max = opts.maxAccounts ?? DEFAULT_MAX;
	const pending = await db.query<{ name: string }>(
		`SELECT name FROM accounts WHERE posting_pubkey IS NULL ORDER BY created_block_num ASC LIMIT $1`,
		[max]
	);
	const names = pending.rows.map((r) => r.name);
	if (names.length === 0) {
		return { ensuredColumn: true, scanned: 0, updated: 0, remaining: 0 };
	}

	let updated = 0;
	for (let i = 0; i < names.length; i += BATCH) {
		const batch = names.slice(i, i + BATCH);
		let map;
		try {
			// Background priority — no hedging, don't compete with
			// user-facing chain calls.
			map = await blurt.getAccounts(batch, { userFacing: false });
		} catch (err) {
			// A batch failure is non-fatal; log and move on. The next
			// startup retries whatever's still NULL.
			log.warn('batch_fetch_failed', {
				from: batch[0],
				size: batch.length,
				error: err instanceof Error ? err.message : String(err)
			});
			continue;
		}
		for (const name of batch) {
			const key = primaryPostingKey(map.get(name) ?? {});
			if (key === null) continue;
			await db.query(
				`UPDATE accounts SET posting_pubkey = $2 WHERE name = $1 AND posting_pubkey IS NULL`,
				[name, key]
			);
			updated++;
		}
	}

	// How many NULLs remain beyond this run's slice (informational).
	const rem = await db.query<{ n: string }>(
		`SELECT COUNT(*)::text AS n FROM accounts WHERE posting_pubkey IS NULL`
	);
	const remaining = Number(rem.rows[0]?.n ?? '0');

	return { ensuredColumn: true, scanned: names.length, updated, remaining };
}
