/**
 * Morphit indexer — database migrations.
 *
 * Simplest possible migration story: a numbered list of SQL files (or
 * inline SQL strings) each wrapped in a transaction, applied in
 * order, tracked in `schema_migrations`. No ORM, no framework. Works
 * the way `psql -f schema.sql` would, but idempotent and traceable.
 *
 * Run modes:
 *   - default: apply any migrations not yet recorded
 *   - --rebuild-materialized: drop and re-derive materialised tables
 *     from the event log, for class-2 migrations per ADR-0008.
 *
 * Called both from main.ts on boot (ensures DB is current before the
 * poller starts) and from the CLI via `npm run migrate`.
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import type pg from 'pg';
import { loadConfig } from '$config';
import { createDatabase, type Database } from '$db/pool';
import { logger } from '$log';

const log = logger('migrate');

const HERE = dirname(fileURLToPath(import.meta.url));

/** A migration is an (integer) version and the SQL that implements it.
 *  Versions must be strictly increasing and gap-free starting at 1.
 *
 *  `subsumesVersions`: if set, the runner records this list of
 *  additional versions in `schema_migrations` along with the migration's
 *  own version.  Used by the v1 collapsed schema to mark v2-v27 as
 *  applied (they were merged into v1 during the May 2026 audit).
 *  Without this, downstream code that checks "is v15 applied?" would
 *  break on a fresh deploy. */
interface Migration {
	readonly version: number;
	readonly description: string;
	readonly sqlPath?: string;
	readonly sql?: string;
	readonly subsumesVersions?: readonly number[];
}

const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		description: 'collapsed canonical schema (v1-v36 merged in-place; pre-launch baseline)',
		sqlPath: resolve(HERE, 'schema.sql'),
		// On a fresh DB, mark all the historical versions as applied
		// so any downstream check "is v15 applied?" sees true.  The
		// collapsed schema produces byte-for-byte the same end state
		// as applying v1-v36 incrementally; this list preserves the
		// version-tracking semantics.  The original per-version files
		// are archived under apps/indexer/src/db/historical/ for
		// archaeology.
		//
		// cp131 DEEP-002 — list extended 2..27 → 2..35 to match the
		// actual section markers in schema.sql (v28, v33.1/v33.2,
		// v34, v35 sections were added in-place during cp82+ work
		// rather than as separate migration entries, contrary to the
		// original cp82 "future migrations land here at v28" framing).
		// cp404 — extended 2..35 → 2..36 for the v36 accounts.posting_pubkey
		// section, likewise added in-place. A fresh DB gets the column from
		// this baseline schema.sql; an existing beta DB (already recorded at
		// v1, so the baseline won't re-run) gets it from the idempotent
		// ADD COLUMN in postingKeyBackfill.ts at boot.
		// The v1 collapsed schema is the pre-launch baseline; the
		// first separate additive migration will be assigned an
		// integer version at launch.
		subsumesVersions: [
			2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17,
			18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31,
			32, 33, 34, 35, 36
		]
	},
	// cp425 — the first separate additive migration after the v1 collapse
	// baseline (which subsumes 2..36), so this is version 37. Adds the barter
	// accepted-crypto set to `orders`. Idempotent (IF NOT EXISTS): on a fresh
	// DB the v1 schema.sql already created the column + index, so this is a
	// no-op there; on an existing beta deploy it adds them. Kept byte-aligned
	// with the same block in schema.sql.
	{
		version: 37,
		description: 'cp425: add orders.accepted_assets (barter accepted-crypto set) + partial GIN index',
		sql: `
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS accepted_assets TEXT[];

CREATE INDEX IF NOT EXISTS idx_orders_accepted_assets
    ON orders USING GIN (accepted_assets)
    WHERE accepted_assets IS NOT NULL;

COMMENT ON COLUMN orders.accepted_assets IS
    'cp425: for a BARTER (goods/services) order, the non-empty set of '
    'crypto tickers the seller accepts as settlement (e.g. '
    '{XMR,BTC,DOGE}).  Each is a real crypto ticker in ASSET_TICKERS '
    '(never BARTER itself, never a goods asset).  A buyer may only '
    'settle in a crypto on this list.  NULL for every crypto asset — '
    'those settle in themselves and have no accepted-set.';
`
	},
	{
		version: 38,
		description:
			'cp440: index accounts.posting_pubkey for the key-references reverse lookup (login auto-resolve)',
		// The posting_pubkey column (v36) had no index because it was only ever
		// SERVED (SELECT by account name, which is the PK / already indexed).
		// cp440 added a reverse lookup — SELECT name WHERE posting_pubkey = ANY(...)
		// in the /v1/chain/key-references union — which runs on every posting-key
		// login attempt; without this index it seq-scans the accounts table.
		// Partial (WHERE NOT NULL) since NULL rows (not yet backfilled) are never
		// a lookup target and the backfill's own `WHERE posting_pubkey IS NULL`
		// scan wants those rows excluded from this index anyway.
		sql: `
CREATE INDEX IF NOT EXISTS idx_accounts_posting_pubkey
    ON accounts (posting_pubkey)
    WHERE posting_pubkey IS NOT NULL;
`
	},
	{
		version: 39,
		description:
			'cp446: chat read-state is per THREAD (reader, peer, order), not per peer — like an email inbox',
		// Ken: "if I read one thread from a user, it should not mark other threads
		// with that user as read." A discussion is (peer, order); reading one must
		// not silence the others.
		//
		// WHY A SENTINEL AND NOT NULL: this column is in the primary key, and
		// Postgres treats NULLs as DISTINCT in a unique index — two NULL rows for
		// the same (reader, peer) would both be insertable, and the ON CONFLICT
		// upsert would never fire. So the key is always a non-null TEXT:
		//
		//    '*'  — a PEER-WIDE ack. What every pre-cp446 client sent (the op had
		//           no order field) and what an old client still sends today. It
		//           means "everything with this peer, up to last_read_at".
		//    ''   — the order-LESS thread: real messages that cite no order.
		//    else — the permlink of the order that thread is about.
		//
		// Neither '*' nor '' is a legal Blurt permlink, so no thread can collide
		// with the sentinel. Existing rows are peer-wide acks by definition, so the
		// backfill stamps them '*' and the old behaviour is preserved exactly for
		// anyone who upgrades mid-conversation. Unread is then evaluated against
		// MAX(thread ack, peer-wide ack), which is monotonic in both.
		sql: `
ALTER TABLE chat_read_state
    ADD COLUMN IF NOT EXISTS order_permlink TEXT NOT NULL DEFAULT '*';

ALTER TABLE chat_read_state
    DROP CONSTRAINT IF EXISTS chat_read_state_pkey;

ALTER TABLE chat_read_state
    ADD PRIMARY KEY (reader_account, peer_account, order_permlink);

COMMENT ON COLUMN chat_read_state.order_permlink IS
    'The discussion this ack is for: a permlink, or '''' for the order-less thread, or ''*'' for a legacy peer-wide ack.';
`
	},
	{
		version: 40,
		description:
			'cp450 (GAP A): per-subscription muted_categories so Web Push obeys the user’s per-category opt-in',
		// The push_subscriptions row had no notion of which categories the user
		// wants. The push-sender fanned every chat / order / feedback push out to
		// every subscribed device regardless of the account's Settings toggles —
		// so the per-category switch worked for the in-page (tab-open) path but
		// was silently ignored for Web Push (tab-closed). This adds the missing
		// state.
		//
		// A BLOCKLIST, not an allowlist: the array names the categories the user
		// has turned OFF. Empty '{}' therefore means "nothing muted = all on",
		// which is exactly the current behaviour — so every pre-existing row
		// keeps receiving everything until its client next re-syncs (no surprise
		// silence on upgrade). It's also future-proof: a brand-new category is on
		// by default for everyone until they explicitly mute it, with no further
		// migration. The push-sender skips a device whose muted_categories
		// contains the pending row's category.
		//
		// Idempotent with the inline column in the CREATE TABLE in schema.sql;
		// the ALTER is a no-op on a fresh install and runs on upgrade.
		sql: `
ALTER TABLE push_subscriptions
    ADD COLUMN IF NOT EXISTS muted_categories TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN push_subscriptions.muted_categories IS
    'Categories this device has OPTED OUT of (blocklist). Empty = all on. The push-sender skips a device whose array contains the notification''s category.';
`
	},
	{
		version: 41,
		description:
			'cp450: push_pending.notification_id — shared dedup tag so an order-signal Web Push and its in-page notification collapse into one',
		// An order-signal chat message (one that cites an order permlink) fires
		// TWO notifications for the recipient when their tab is open but not
		// focused: the in-page trade listener shows an OS notification tagged
		// `morphit-order-morphit-trade-<permlink>`, and — because the same
		// message is also enqueued as a category='order' Web Push — the service
		// worker shows a SECOND one tagged `morphit-order-<queue_row_id>`.
		// Different tags → the browser doesn't collapse them → the user sees the
		// same event twice.
		//
		// The fix gives the push the SAME tag id the in-page path uses. The SW
		// already builds `morphit-<category>-<eventId>`, so when the push carries
		// `notification_id = 'morphit-trade-<permlink>'` (exactly the client's
		// in-page notificationTag), the two tags are identical and the browser
		// shows ONE notification (the later one replaces the earlier in place).
		//
		// NULL for every push with no in-page counterpart (plain chat, feedback,
		// featured-bid) — the sender falls back to the queue-row id, so those keep
		// their per-event tag. Nullable + no backfill: push_pending is a
		// transient queue drained within seconds, so in-flight rows simply use
		// the fallback. Idempotent with the inline column in schema.sql.
		sql: `
ALTER TABLE push_pending
    ADD COLUMN IF NOT EXISTS notification_id TEXT;

COMMENT ON COLUMN push_pending.notification_id IS
    'Optional shared dedup tag matching the in-page notificationTag (e.g. ''morphit-trade-<permlink>'') so an order-signal push and its in-page notification collapse. NULL → the sender tags on the queue-row id.';
`
	},
	{
		version: 42,
		description:
			'cp462: chat_folders — per-account ENCRYPTED chat folder organization (Inbox/Starred; rest Archived), synced across devices. morphit_chat_folders_v1.',
		// t.txt (v1.4.9 #5). One row per account holding the ENCRYPTED folder
		// state — the client encrypts the thread lists with a posting-key-derived
		// key, so the indexer stores + serves OPAQUE ciphertext and never learns a
		// user's chat organization. Written ONLY by the morphit_chat_folders_v1
		// handler; the latest broadcast (by block) wins. Idempotent with the
		// CREATE TABLE in schema.sql.
		sql: `
CREATE TABLE IF NOT EXISTS chat_folders (
    account TEXT PRIMARY KEY,
    enc TEXT NOT NULL,
    source_block_num BIGINT NOT NULL,
    source_trx_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE chat_folders IS
    'Per-account ENCRYPTED chat folder organization (which threads are kept in Inbox/Starred; all others Archived). Opaque ciphertext — encrypted client-side with a posting-key-derived key, so the indexer never learns a user''s chat organization. Written only by morphit_chat_folders_v1; latest by block wins.';
`
	}
	// Future migrations land here.  The v1 collapsed schema is the
	// pre-launch baseline; from v37 forward, every new schema change is its
	// own additive migration with its own version number.  No further
	// collapse should happen until well after 1.0.0 ships.
];

/** Validate the MIGRATIONS array at load time:
 *    - versions strictly increasing
 *    - gap-free starting at 1
 *    - matching schema-vN.sql files exist (when sqlPath used)
 *    - subsumesVersions are gap-free and don't overlap with declared
 *      versions
 *
 *  G1 audit fix: a missing version (v24 was skipped between v23 and
 *  v25) caused the corresponding schema file to silently never be
 *  applied.  This check turns a silent gap into a loud boot-time
 *  error so the same kind of regression can't slip in again.
 *
 *  Throws on any violation.  Called once at module scope below. */
function validateMigrationsContract(): void {
	// Each migration's declared version must be exactly 1 + the highest
	// version COVERED by all prior migrations (their own version PLUS any
	// versions they subsume).  For the collapsed v1 baseline (version 1,
	// subsumes 2..36) the highest covered version is 36, so the next
	// migration must be version 37 — NOT index+1.  An index-based check
	// (`expected = i + 1`) would wrongly demand version 2 here, which is
	// already recorded as applied on every existing deploy (v1 subsumed it),
	// so that migration would be silently skipped and its schema change never
	// run.  The gap-free coverage of the subsumed ranges themselves is
	// enforced by the second loop below; here we only pin each declared
	// version to the coverage boundary so there's no gap or overlap.
	let coveredMax = 0;
	for (let i = 0; i < MIGRATIONS.length; i++) {
		const m = MIGRATIONS[i]!;
		const expected = coveredMax + 1;
		if (m.version !== expected) {
			throw new Error(
				`migrations contract violated: MIGRATIONS[${i}] has version=${m.version}, ` +
					`expected ${expected} (1 + the highest version covered by prior migrations). ` +
					`Versions must be strictly increasing and gap-free; a new migration after a ` +
					`collapse baseline takes the next version PAST the subsumed range.`
			);
		}
		const subMax =
			m.subsumesVersions && m.subsumesVersions.length > 0
				? Math.max(...m.subsumesVersions)
				: m.version;
		coveredMax = Math.max(m.version, subMax);
	}
	// Validate subsumesVersions across the array: each subsumed
	// version must be unique globally (no two migrations claim the
	// same historical version), must be > the migration's own
	// version, and the overall set (declared + subsumed) must be
	// gap-free starting at 1.  This guards against future collapse
	// operations introducing silent gaps.
	const declaredVersions = new Set(MIGRATIONS.map((m) => m.version));
	const subsumedSeen = new Map<number, number>(); // version → migration that subsumed it
	for (const m of MIGRATIONS) {
		for (const v of m.subsumesVersions ?? []) {
			if (declaredVersions.has(v)) {
				throw new Error(
					`migrations contract violated: version ${v} is both declared and ` +
						`listed in subsumesVersions of migration ${m.version}.  Pick one.`
				);
			}
			if (subsumedSeen.has(v)) {
				throw new Error(
					`migrations contract violated: version ${v} is subsumed by both ` +
						`migration ${subsumedSeen.get(v)} and migration ${m.version}.`
				);
			}
			if (v <= m.version) {
				throw new Error(
					`migrations contract violated: subsumesVersions of migration ` +
						`${m.version} contains ${v}, but subsumed versions must be > the ` +
						`migration's own version.`
				);
			}
			subsumedSeen.set(v, m.version);
		}
	}
	// Combined coverage: every integer from 1 to max(declared ∪ subsumed)
	// must be present as either declared or subsumed.
	const all = new Set<number>([...declaredVersions, ...subsumedSeen.keys()]);
	const maxVersion = Math.max(...all);
	for (let v = 1; v <= maxVersion; v++) {
		if (!all.has(v)) {
			throw new Error(
				`migrations contract violated: version ${v} is neither declared ` +
					`nor subsumed.  This would create a silent gap in schema_migrations.`
			);
		}
	}
}
validateMigrationsContract();

async function loadSql(migration: Migration): Promise<string> {
	if (migration.sql) return migration.sql;
	if (migration.sqlPath) return readFile(migration.sqlPath, 'utf8');
	throw new Error(`migration ${migration.version} has neither sql nor sqlPath`);
}

/** Check which migration versions are already applied. */
async function appliedVersions(db: Database): Promise<Set<number>> {
	// Create the tracking table if it's the first run. We do this
	// outside the migration transaction loop because the schema_migrations
	// table must exist before we can query it.
	await db.query(`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version INT PRIMARY KEY,
			applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			description TEXT NOT NULL
		)
	`);
	const res = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
	return new Set(res.rows.map((r) => r.version));
}

/** Apply every migration not yet recorded. Each migration runs in its
 *  own transaction — one failing migration doesn't partially commit
 *  subsequent ones. */
export async function runMigrations(db: Database): Promise<{
	applied: number[];
	skipped: number[];
}> {
	const already = await appliedVersions(db);
	const applied: number[] = [];
	const skipped: number[] = [];

	for (const m of MIGRATIONS) {
		if (already.has(m.version)) {
			skipped.push(m.version);
			continue;
		}
		const sql = await loadSql(m);
		await db.withTx(async (client: pg.PoolClient) => {
			await client.query(sql);
			await client.query(
				'INSERT INTO schema_migrations (version, description) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
				[m.version, m.description]
			);
			// Record any subsumed versions in the same transaction.
			// On a fresh DB this lets the v1 collapsed schema mark
			// v2-v27 as applied so downstream code "is v15 applied?"
			// still returns true.  On a DB that's already past the
			// collapse boundary, subsumed versions are unreachable
			// (they'd already be in schema_migrations).
			for (const v of m.subsumesVersions ?? []) {
				await client.query(
					'INSERT INTO schema_migrations (version, description) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
					[v, `subsumed by v${m.version} (${m.description})`]
				);
			}
		});
		applied.push(m.version);
	}

	return { applied, skipped };
}

/** Drop all materialised tables and re-derive their state by
 *  replaying the `ops` event log. Only the event log is sacred; any
 *  column we can compute from it can be dropped and rebuilt.
 *
 *  Called explicitly via `npm run migrate:rebuild`. Does NOT run on
 *  normal boot — this can take minutes on a fully-synced indexer. */
export async function rebuildMaterialized(db: Database): Promise<void> {
	// Empty in v1 — there are no class-2 migrations yet. This
	// placeholder lets future versions add rebuild logic without
	// renaming the CLI surface.
	await db.query('SELECT 1');
}

/** CLI entry point. Usage:
 *    tsx src/db/migrations.ts              → apply pending migrations
 *    tsx src/db/migrations.ts --rebuild-materialized
 */
async function main(): Promise<void> {
	const config = loadConfig();
	const db = createDatabase(config);
	try {
		if (process.argv.includes('--rebuild-materialized')) {
			log.info('rebuild_started');
			await rebuildMaterialized(db);
			log.info('rebuild_complete');
			return;
		}
		const { applied, skipped } = await runMigrations(db);
		if (applied.length > 0) {
			log.info('applied', { versions: applied });
		}
		if (skipped.length > 0) {
			log.info('already_applied', { versions: skipped });
		}
	} finally {
		await db.close();
	}
}

// Only run when invoked directly (not when imported by main.ts).
const invokedDirectly =
	process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (invokedDirectly) {
	main().catch((err) => {
		log.error('failed', {}, err);
		process.exit(1);
	});
}
