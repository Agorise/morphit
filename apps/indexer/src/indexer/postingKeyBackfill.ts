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
 * runs once per startup, in the background, so it never blocks the poller.
 *
 * NO LONGER DISPLAY-ONLY (v1.18.0). This header used to say signature
 * verification never trusts this column. The federated fast path does: it
 * verifies a pushed chat message against `posting_pubkey` and nothing else. So
 * a stale key here is a security fault, not a cosmetic one. F27 made the
 * dispatcher record rotations from then on, and F37 is the rest of it: rows
 * written BEFORE that still hold whatever key they were first seen with,
 * including a key the owner has since rotated away from because it leaked.
 * `reconcilePostingKeys` below confirms every such row against the chain
 * (`posting_key_reconciled`, migration v61), and the fast path re-reads the
 * chain before trusting a row not yet confirmed. Since v1.20.0 (E1) every key
 * the dispatcher records from a block — an account create's as well as a
 * rotation's — is unconfirmed too (a block is one RPC endpoint's word), so
 * `keepReconcilingPostingKeys` runs for the life of the process rather than once.
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
	/** v1.18.0 (F37) — the reconcile pass over rows never confirmed. */
	readonly reconciled?: ReconcileResult;
}

export interface ReconcileResult {
	/** Rows confirmed against the chain this run. */
	readonly checked: number;
	/** Of those, rows whose stored key differed from the chain's, and was fixed. */
	readonly corrected: number;
	/** Rows still unconfirmed: a batch the chain did not answer. Retried next boot. */
	readonly remaining: number;
}

/** The one chain call the reconcile makes. BlurtClient satisfies it; a test
 *  can supply it without faking the whole client. */
export interface AccountKeySource {
	getAccounts(
		names: readonly string[],
		options?: { userFacing?: boolean }
	): Promise<ReadonlyMap<string, Parameters<typeof primaryPostingKey>[0]>>;
	/**
	 * The same read, answered only when two independent endpoints AGREE on
	 * what `agreeOn` extracts; null when they did not. BlurtClient provides
	 * it, and the reconcile and NULL fill use it whenever it is there: their
	 * answers become CONFIRMED keys the fast path trusts without asking again,
	 * so one lagging or hostile node must not be able to write one (D1).
	 */
	getAccountsAgreed?(
		names: readonly string[],
		agreeOn: (account: Parameters<typeof primaryPostingKey>[0] | undefined) => string
	): Promise<ReadonlyMap<string, Parameters<typeof primaryPostingKey>[0]> | null>;
}

/** What two endpoints must agree on for one account: its signing key, or the
 *  fact that it has none, or the fact that the endpoint does not know it — the
 *  last kept distinct so a node that is behind DISAGREES instead of silently
 *  agreeing that the account has no key. */
function keyAgreement(acc: Parameters<typeof primaryPostingKey>[0] | undefined): string {
	if (acc === undefined) return '\u2205 unknown account';
	return primaryPostingKey(acc) ?? '\u2205 no single key';
}

/** One batch read for the reconcile and the fill: agreed when the source can
 *  agree, a single answer otherwise (tests; a source without the quorum read). */
async function readKeysFor(
	blurt: AccountKeySource,
	names: readonly string[]
): Promise<ReadonlyMap<string, Parameters<typeof primaryPostingKey>[0]> | null> {
	if (blurt.getAccountsAgreed !== undefined) return blurt.getAccountsAgreed(names, keyAgreement);
	return blurt.getAccounts(names, { userFacing: false });
}

/** Pause between reconcile batches: background work, gentle on the chain. */
const RECONCILE_PAUSE_MS = 250;

/**
 * Confirm every unconfirmed row's posting key against the chain (F37).
 *
 * Runs over ALL of them, not a per-boot slice like the NULL fill above: a row
 * left unconfirmed is a row the fast path must re-read the chain for, and every
 * boot that skips it extends the time a leaked key could be tried against it.
 * Batches of `BATCH`, one `get_accounts` each, at background priority with a
 * pause between them.
 *
 *   - chain key differs  → the column takes the chain's key (the fix);
 *   - chain key matches  → confirmed as it is;
 *   - chain names NO single key (an authority delegated to another account,
 *     or an account the chain does not return) → the column is set NULL. A
 *     stored key the chain no longer vouches for is exactly the leak this
 *     exists to close, and NULL makes the fast path refuse and fall back to
 *     chain delivery: slower, never wrong;
 *   - batch not answered → left unconfirmed; the fast path keeps re-reading
 *     those accounts itself, and the next pass of keepReconcilingPostingKeys
 *     tries again.
 *
 * The UPDATE is guarded on the row being exactly as it was read: still
 * unconfirmed AND still holding the key this pass started from. Since v1.20.0
 * (E1) the dispatcher records a rotation UNCONFIRMED — it is one RPC
 * endpoint's word — so the flag alone no longer shows that the row moved; the
 * key does. A rotation recorded meanwhile is left for the next pass, which
 * reads it and asks the chain about it.
 */
export async function reconcilePostingKeys(
	db: Database,
	blurt: AccountKeySource,
	opts: { pauseMs?: number } = {}
): Promise<ReconcileResult> {
	const pauseMs = opts.pauseMs ?? RECONCILE_PAUSE_MS;
	const pending = await db.query<{ name: string; posting_pubkey: string | null }>(
		`SELECT name, posting_pubkey FROM accounts
		  WHERE posting_key_reconciled = FALSE
		  ORDER BY name`
	);
	let checked = 0;
	let corrected = 0;
	let remaining = 0;
	for (let i = 0; i < pending.rows.length; i += BATCH) {
		if (i > 0 && pauseMs > 0) await new Promise((r) => setTimeout(r, pauseMs));
		const batch = pending.rows.slice(i, i + BATCH);
		let map;
		try {
			map = await readKeysFor(
				blurt,
				batch.map((r) => r.name)
			);
		} catch (err) {
			remaining += batch.length;
			log.warn('reconcile_batch_failed', {
				from: batch[0]?.name,
				size: batch.length,
				error: err instanceof Error ? err.message : String(err)
			});
			continue;
		}
		if (map === null) {
			// No two endpoints agreed. Nothing is learned and nothing is written;
			// the rows stay unconfirmed and the next pass asks again.
			remaining += batch.length;
			log.warn('reconcile_batch_no_quorum', { from: batch[0]?.name, size: batch.length });
			continue;
		}
		for (const row of batch) {
			const acc = map.get(row.name);
			// AN ACCOUNT THE ANSWER DOES NOT CONTAIN IS NOT AN ANSWER (D7). It used
			// to be read as "no key" and written NULL + confirmed — so a node that
			// did not know newer accounts, or returned an empty list, cleared the
			// keys of a whole batch. Left unconfirmed, it is asked about again.
			if (acc === undefined) {
				remaining++;
				continue;
			}
			const chainKey = primaryPostingKey(acc);
			const res = await db.query(
				`UPDATE accounts SET posting_pubkey = $2, posting_key_reconciled = TRUE
				  WHERE name = $1 AND posting_key_reconciled = FALSE
				    AND posting_pubkey IS NOT DISTINCT FROM $3`,
				[row.name, chainKey, row.posting_pubkey]
			);
			if ((res.rowCount ?? 0) === 0) continue; // the dispatcher got there first
			checked++;
			if (chainKey !== row.posting_pubkey) corrected++;
		}
	}
	return { checked, corrected, remaining };
}

/** A posting authority as the chain serves it (and as an account op carries it). */
export interface PostingAuthorityShape {
	readonly weight_threshold?: unknown;
	readonly key_auths?: unknown;
}

/**
 * The key that can sign for this posting authority ALONE, or null.
 *
 * THE ONE RULE, used by every writer of `accounts.posting_pubkey` — the account
 * create ingest, the account_update ingest, the boot reconcile, the NULL fill
 * and the fast path's chain re-read — because since v1.18.0 that column is
 * what a pushed chat message is verified against, and a key it holds is a key
 * the fast path will accept a signature from with no further check.
 *
 * So it must hold only a key the CHAIN would accept on its own: the first
 * `[key, weight]` whose weight meets `weight_threshold`. The rule it replaces,
 * "`key_auths[0][0]`", was right for the single-key account almost everyone has
 * and wrong in the two cases that matter (v1.18.0 review, R2):
 *
 *   - THRESHOLD ABOVE ONE. `{threshold 2, [[A,1],[B,1]]}` needs both
 *     signatures on chain; storing A let whoever held A alone impersonate the
 *     account on the fast path. The chain sorts key_auths, so the owner does
 *     not even choose which key that is.
 *   - NO KEYS. An owner who kills a leaked key by moving posting authority to
 *     another account (`key_auths: []`) was read as "posting did not change",
 *     and the leaked key went on verifying.
 *
 * Null means "no single key vouches for this account" — the fast path then
 * refuses and the message goes by chain: slower, never wrong. A missing or
 * non-numeric threshold is null too; the chain always sends one, so a shape
 * without it is not one to trust a key from.
 */
export function signingPostingKey(
	authority: PostingAuthorityShape | null | undefined
): string | null {
	if (authority === null || authority === undefined || typeof authority !== 'object') return null;
	const threshold = authority.weight_threshold;
	if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 1) return null;
	const ka = authority.key_auths;
	if (!Array.isArray(ka)) return null;
	for (const pair of ka) {
		if (!Array.isArray(pair)) continue;
		const [key, weight] = pair as unknown[];
		if (typeof key !== 'string' || key.length === 0) continue;
		if (typeof weight !== 'number' || !Number.isFinite(weight)) continue;
		if (weight >= threshold) return key;
	}
	return null;
}

/**
 * The posting key to store for a chain account — see {@link signingPostingKey}.
 * Defensive: null on any malformed or absent shape.
 */
export function primaryPostingKey(acc: { posting?: PostingAuthorityShape | null }): string | null {
	return signingPostingKey(acc.posting);
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
	// v1.18.0 deep-deep (rv2-11): only rows never CONFIRMED. A row that is NULL
	// and confirmed is an owner who disowned their key (authority moved to
	// another account, or no single key): the reconcile wrote that NULL on
	// purpose. Selecting it here refilled it with whatever key two lagging
	// nodes still agreed on — re-arming exactly the key the owner killed.
	const pending = await db.query<{ name: string }>(
		`SELECT name FROM accounts
		  WHERE posting_pubkey IS NULL AND posting_key_reconciled = FALSE
		  ORDER BY created_block_num ASC LIMIT $1`,
		[max]
	);
	const names = pending.rows.map((r) => r.name);
	if (names.length === 0) {
		return {
			ensuredColumn: true,
			scanned: 0,
			updated: 0,
			remaining: 0,
			reconciled: await reconcilePostingKeys(db, blurt)
		};
	}

	let updated = 0;
	for (let i = 0; i < names.length; i += BATCH) {
		const batch = names.slice(i, i + BATCH);
		let map;
		try {
			// Background priority — no hedging, don't compete with
			// user-facing chain calls. AGREED where the source can agree: what
			// this writes is marked confirmed, exactly as the reconcile's is.
			map = await readKeysFor(blurt, batch);
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
		if (map === null) {
			log.warn('batch_fetch_no_quorum', { from: batch[0], size: batch.length });
			continue;
		}
		for (const name of batch) {
			const key = primaryPostingKey(map.get(name) ?? {});
			if (key === null) continue;
			// Read from the chain just now, so confirmed as well as filled (F37).
			// Guarded on the flag too (rv2-11): a confirmed NULL stays NULL, and a
			// rotation the dispatcher confirmed meanwhile is never overwritten.
			const res = await db.query(
				`UPDATE accounts SET posting_pubkey = $2, posting_key_reconciled = TRUE
				  WHERE name = $1 AND posting_pubkey IS NULL AND posting_key_reconciled = FALSE`,
				[name, key]
			);
			updated += res.rowCount ?? 0;
		}
	}

	// How many NULLs remain beyond this run's slice (informational).
	const rem = await db.query<{ n: string }>(
		`SELECT COUNT(*)::text AS n FROM accounts WHERE posting_pubkey IS NULL AND posting_key_reconciled = FALSE`
	);
	const remaining = Number(rem.rows[0]?.n ?? '0');

	return {
		ensuredColumn: true,
		scanned: names.length,
		updated,
		remaining,
		reconciled: await reconcilePostingKeys(db, blurt)
	};
}

/**
 * Keep reconciling for the life of the process (v1.18.0 review, D5; v1.20.0, E1).
 *
 * The reconcile used to run ONCE per boot. A box whose RPC was not ready at
 * boot — a hidden-only node whose Tor is still building circuits, the common
 * case right after an upgrade — failed every batch in seconds and then waited
 * for the next restart, which can be weeks. Every unconfirmed sender costs the
 * fast path a budgeted chain read (30 a minute across all accounts), so until
 * then fast chat quietly fell back to chain timing for most people.
 *
 * It no longer stops when nothing is left (E1). The dispatcher records every
 * posting key it reads from a block (account create or rotation) UNCONFIRMED,
 * because a block is one RPC endpoint's word;
 * those rows appear at runtime and are what this loop is for. So: failures and
 * leftovers back off — a minute, doubling, capped at thirty — and a pass that
 * leaves nothing unconfirmed schedules the next one at the steady cadence
 * (a minute), where an idle pass is one indexed query that finds no rows.
 * The timer is unref'd so it never holds a shutdown. Returns a stop function.
 */
export function keepReconcilingPostingKeys(
	db: Database,
	blurt: AccountKeySource,
	opts: {
		readonly firstDelayMs?: number;
		readonly maxDelayMs?: number;
		/** Delay after a pass that left nothing unconfirmed. */
		readonly steadyDelayMs?: number;
		/** Passed to each reconcile pass (tests use 0). */
		readonly pauseMs?: number;
		readonly onPass?: (r: ReconcileResult) => void;
	} = {}
): () => void {
	const maxDelay = opts.maxDelayMs ?? 30 * 60 * 1000;
	const steadyDelay = opts.steadyDelayMs ?? 60 * 1000;
	let delay = opts.firstDelayMs ?? 60 * 1000;
	let stopped = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	const schedule = (): void => {
		if (stopped) return;
		timer = setTimeout(() => {
			void pass();
		}, delay);
		timer.unref?.();
	};
	const pass = async (): Promise<void> => {
		if (stopped) return;
		let r: ReconcileResult;
		try {
			r = await reconcilePostingKeys(
				db,
				blurt,
				opts.pauseMs !== undefined ? { pauseMs: opts.pauseMs } : {}
			);
		} catch (err) {
			log.warn('reconcile_retry_failed', {
				error: err instanceof Error ? err.message : String(err)
			});
			delay = Math.min(delay * 2, maxDelay);
			schedule();
			return;
		}
		opts.onPass?.(r);
		// Nothing left: wait the steady cadence for rotations recorded meanwhile.
		delay = r.remaining === 0 ? steadyDelay : Math.min(delay * 2, maxDelay);
		schedule();
	};
	schedule();
	return () => {
		stopped = true;
		if (timer !== undefined) clearTimeout(timer);
	};
}

/**
 * Withdraw every posting-key confirmation a restored snapshot brought with it
 * (v1.18.0 review, D4).
 *
 * A fast-sync restores another instance's whole database, and since v1.18.0
 * that includes `posting_key_reconciled = TRUE` on rows the fast path then
 * trusts with no chain read. The snapshot's integrity check spot-checks the
 * `ops` log against the chain because everything else is derived from it — but
 * a posting key is not derived from `ops`; it comes from account creates and
 * updates. So a compromised or simply wrong publisher could plant confirmed
 * keys that nothing here would ever question. Marking them unconfirmed hands
 * every row to THIS node's own reconcile, which asks the chain (agreed) before
 * trusting any of them.
 *
 * Returns how many rows were withdrawn. A snapshot from before v61 has no such
 * column: the migration adds it as FALSE on first boot, which is the same
 * outcome, so there is nothing to do.
 */
export async function distrustRestoredPostingKeys(db: Database): Promise<number> {
	const col = await db.query(
		`SELECT 1 FROM information_schema.columns
		  WHERE table_schema = current_schema()
		    AND table_name = 'accounts'
		    AND column_name = 'posting_key_reconciled'`
	);
	if ((col.rowCount ?? 0) === 0) return 0;
	const r = await db.query(
		'UPDATE accounts SET posting_key_reconciled = FALSE WHERE posting_key_reconciled'
	);
	return r.rowCount ?? 0;
}
