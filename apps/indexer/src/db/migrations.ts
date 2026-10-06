/**
 * Morphit indexer — database migrations.
 *
 * Simplest possible migration story: a numbered list of SQL files (or
 * inline SQL strings) each wrapped in a transaction, applied in
 * order, tracked in `schema_migrations`. No ORM, no framework. Works
 * the way `psql -f schema.sql` would, but idempotent and traceable.
 *
 * Applies any migrations not yet recorded. Two runners at once (a boot
 * racing `npm run migrate`, two containers) are serialised by a
 * transaction-scoped advisory lock, and each re-reads what is applied
 * under it, so neither fails nor applies a migration twice.
 *
 * There is no rebuild mode: `--rebuild-materialized` existed only as a
 * placeholder that did nothing and logged success; it now refuses.
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
	/**
	 * Data changes run after `sql`, in the same transaction, each logged with
	 * the number of rows it touched — for a one-shot repair an operator should
	 * be able to see the size of in the log. Not mirrored in schema.sql: a
	 * fresh database has no rows to repair.
	 */
	readonly dataSteps?: readonly { readonly label: string; readonly sql: string }[];
}

const MIGRATIONS: readonly Migration[] = [
	{
		version: 1,
		description: 'collapsed canonical schema (v1-v36 merged in-place; pre-launch baseline)',
		sqlPath: resolve(HERE, 'schema.sql'),
		// On a fresh DB, mark all the historical versions as applied
		// so any downstream check "is v15 applied?" sees true.  The
		// collapsed schema stands in for v1-v36 (and carries a section
		// for each later version too — see the header of schema.sql);
		// this list preserves the version-tracking semantics.  The
		// original per-version files are archived under
		// apps/indexer/src/db/historical/ for archaeology.
		//
		// list extended 2..27 → 2..35 to match the
		// actual section markers in schema.sql (v28, v33.1/v33.2,
		// v34, v35 sections were added in-place during later work
		// rather than as separate migration entries, contrary to the
		// original "future migrations land here at v28" framing).
		// extended 2..35 → 2..36 for the v36 accounts.posting_pubkey
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
	// the first separate additive migration after the v1 collapse
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
		// A later change added a reverse lookup — SELECT name WHERE posting_pubkey = ANY(...)
		// in the /v1/chain/key-references union — which runs on every posting-key
		// login attempt; without this index it seq-scans the accounts table.
		// Partial (WHERE NOT NULL) since NULL rows (not yet backfilled) are never
		// a lookup target and the backfill's own `WHERE posting_pubkey IS NULL`
		// scan wants those rows excluded from this index anyway.
		//
		// v1.18.0 review (D8): the column itself is delivered by
		// ensurePostingPubkeyColumn, which main.ts runs AFTER the migrations —
		// so on a database old enough to predate the column, this index failed
		// with "column posting_pubkey does not exist" on every boot and the
		// ensure step never got to run. The same idempotent ADD COLUMN here
		// first makes the order irrelevant.
		sql: `
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS posting_pubkey TEXT;
CREATE INDEX IF NOT EXISTS idx_accounts_posting_pubkey
    ON accounts (posting_pubkey)
    WHERE posting_pubkey IS NOT NULL;
`
	},
	{
		version: 39,
		description:
			'cp446: chat read-state is per THREAD (reader, peer, order), not per peer — like an email inbox',
		// Requirement: reading one thread with a user must not mark that user's other threads
		// as read. A discussion is (peer, order); reading one must
		// not silence the others.
		//
		// WHY A SENTINEL AND NOT NULL: this column is in the primary key, and
		// Postgres treats NULLs as DISTINCT in a unique index — two NULL rows for
		// the same (reader, peer) would both be insertable, and the ON CONFLICT
		// upsert would never fire. So the key is always a non-null TEXT:
		//
		//    '*'  — a PEER-WIDE ack. What every older client sent (the op had
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
		// One row per account holding the ENCRYPTED folder
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
	},
	{
		version: 43,
		description:
			'cp471: push_pending.source_trx_id — per-message dedup key so the fast head-block enqueue and the durable enqueue of the SAME chat message produce exactly ONE notification (fast when the tailer wins).',
		// Fast notifications. The head-block tailer now enqueues the chat
		// Web Push ~5s after send, alongside the durable handler (~irreversible).
		// Both set source_trx_id = the on-chain trx id; the partial UNIQUE index
		// makes the second INSERT a no-op, so the recipient gets ONE push, fast.
		// featureBid/feedback leave source_trx_id NULL (single-path, no dedup);
		// the partial index ignores NULLs. Idempotent with schema.sql.
		// (True at v43 only: feedback became two-path and keyed in v1.5.5, and
		// its key is namespaced since v1.18.0 — v60 corrects the column comment.
		// This SQL is left as it shipped; migrations are history.)
		sql: `
ALTER TABLE push_pending
    ADD COLUMN IF NOT EXISTS source_trx_id TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS push_pending_account_source_trx_uidx
    ON push_pending (account, source_trx_id)
    WHERE source_trx_id IS NOT NULL;

COMMENT ON COLUMN push_pending.source_trx_id IS
    'cp471 fast-notifications dedup key: the on-chain trx id of the source message. The fast head-block enqueue and the durable enqueue of the same message share it; the partial UNIQUE (account, source_trx_id) makes the later INSERT a no-op so exactly one push is delivered. NULL for single-path pushes (featureBid/feedback); the partial index ignores NULLs.';
`
	},
	{
		version: 44,
		description:
			'v1.5.0: orders.status += "completed" — the morphit_order_complete_v1 op flips a finished trade\'s order from live to completed so it leaves the public orderbook (second removal path parallel to cancel).',
		// New order-complete op (order owner marks a settled trade done).
		// Postgres can't modify a CHECK in place; drop and re-add. The re-add
		// validates existing rows — safe because 'completed' is strictly
		// additive. Idempotent with schema.sql.
		sql: `
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check CHECK (
    status IN ('live', 'cancelled', 'expired', 'completed')
);
`
	},
	{
		version: 45,
		description:
			'v1.5.0: user_settings — one ENCRYPTED blob per account mirroring device-local settings (notifications/quiet-hours, privacy, syndication, hidden accounts, preferences) so they follow the user to a fresh device. Posting-key-derived key; the indexer stores only opaque ciphertext. Same shape as chat_folders.',
		sql: `
CREATE TABLE IF NOT EXISTS user_settings (
    account TEXT PRIMARY KEY,
    enc TEXT NOT NULL,
    source_block_num BIGINT NOT NULL,
    source_trx_id TEXT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`
	},
	{
		version: 46,
		description:
			'v1.5.5: orders.completed_counterparty — the OTHER party of a completed trade, named by the owner in morphit_order_complete_v1. Without it only the order OWNER could ever be credited a trade: the counterparty owns no order, so they would sit at "0 trades" forever no matter how many trades they completed. Optional (NULL) — older clients omit it and older completed rows keep NULL.',
		sql: `
ALTER TABLE orders ADD COLUMN IF NOT EXISTS completed_counterparty TEXT;

COMMENT ON COLUMN orders.completed_counterparty IS
    'v1.5.5: the account the owner traded WITH on this completed order, as named in the morphit_order_complete_v1 payload. Lets the counterparty (who owns no order of their own) be credited the completed trade. NULL when the completing client did not name one, or for pre-v1.5.5 completions.';

-- Trade credit is looked up BY counterparty ("how many completed trades does
-- account X have?"), which no existing index serves: the orders PK leads with
-- the owner account, so a counterparty lookup would seq-scan the whole table
-- on every profile/order card render.
CREATE INDEX IF NOT EXISTS orders_completed_counterparty_idx
    ON orders (completed_counterparty)
    WHERE status = 'completed' AND completed_counterparty IS NOT NULL;
`
	},
	{
		version: 47,
		description:
			'v1.5.5: push_pending.sent_at — the fast/durable dedup was structurally broken. The relay drained a row and DELETED it (~5s), so when the durable handler enqueued the SAME trx ~60s later, ON CONFLICT (account, source_trx_id) had nothing left to conflict with and inserted a SECOND push — the duplicate notification the maintainer hit. The row must OUTLIVE delivery for the dedup key to work, so the sender now stamps sent_at instead of deleting, a pruner reclaims later, and the durable insert lands on a real conflict.',
		sql: `
ALTER TABLE push_pending ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

COMMENT ON COLUMN push_pending.sent_at IS
    'v1.5.5: when this row was delivered (or dropped as undeliverable/expired). NULL = still queued. The sender claims rows WHERE sent_at IS NULL and stamps this instead of deleting, so the row survives as the dedup tombstone for (account, source_trx_id) until a pruner reclaims it. Deleting on send is what caused duplicate notifications.';

-- The sender now claims only unsent rows; without this it would re-scan every
-- retained tombstone on every poll tick.
CREATE INDEX IF NOT EXISTS push_pending_unsent_idx
    ON push_pending (enqueued_at)
    WHERE sent_at IS NULL;

-- The pruner reclaims by sent_at.
CREATE INDEX IF NOT EXISTS push_pending_sent_at_idx
    ON push_pending (sent_at)
    WHERE sent_at IS NOT NULL;
`
	},
	{
		version: 48,
		description:
			'v1.5.5: trade_concentration — Signal E. v1.5.5 grounds the trade count in COMPLETED ORDERS and credits the counterparty the owner names, which opens a farming shape the review signals do not watch: once a pair has ONE verified conversation, an owner can keep completing orders naming the same confederate at a listing fee each, minting trade credit forever. suspicious_reciprocity only watches mutual REVIEWS, so it never fires. Signal E is the trade analogue of Signal D (review_concentration): flag an account whose completed-trade credits are >=80% concentrated on a single peer over the window.',
		sql: `
CREATE TABLE IF NOT EXISTS trade_concentration (
    account          TEXT NOT NULL,
    dominant_peer    TEXT NOT NULL,
    detected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    concentration_pct NUMERIC(5, 2) NOT NULL CHECK (concentration_pct >= 0 AND concentration_pct <= 100),
    trade_count      INTEGER NOT NULL CHECK (trade_count >= 0),
    window_days      INTEGER NOT NULL,
    PRIMARY KEY (account, dominant_peer)
);

CREATE INDEX IF NOT EXISTS trade_concentration_peer_idx
    ON trade_concentration (dominant_peer);
`
	},
	{
		version: 49,
		description:
			"v1.8.9: operator_blocks.origin — REPAIR. The column was added to the fresh-install CREATE TABLE in schema.sql (distinguishing a federated on-chain block from an instance-local `morphit-ops block`) but NO migration ever added it to databases created before that change. Fresh installs had it; every existing instance did not. The gap surfaced when `morphit-ops` → Moderation crashed with `column \"origin\" does not exist`, because fetchBlockStatuses selects it — so on a long-lived instance the entire moderation screen was unreachable, which is precisely where an operator goes to undo a bad flag. Idempotent: ADD COLUMN IF NOT EXISTS with the same default the baseline declares, so a fresh DB is a no-op and an old one converges on the identical shape. The CHECK is added separately and guarded, since Postgres has no ADD CONSTRAINT IF NOT EXISTS.",
		sql: `
ALTER TABLE operator_blocks
    ADD COLUMN IF NOT EXISTS origin varchar(8) NOT NULL DEFAULT 'chain';

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'operator_blocks'::regclass
           AND conname  = 'operator_blocks_origin_check'
    ) THEN
        ALTER TABLE operator_blocks
            ADD CONSTRAINT operator_blocks_origin_check
            CHECK (origin IN ('chain', 'local'));
    END IF;
END
$$;
`
	},
	{
		version: 50,
		description:
			"v1.8.9: moderation_flag_clearances — make a self-trade flag REVERSIBLE. Signals A/B are heuristics, and a legitimate operator can trip them (the maintainer flagged his own account testing two handles on one LAN), which hides the reputation card and subdues every review behind a \"reviewers flagged as related\" pill. Until now a flag could only be lived with: `morphit-ops` Moderation offered block/unblock and nothing else, and simply DELETING the rows does not hold because the detector re-inserts them on its next pass. A clearance is therefore a permanent instance-local decision the DETECTOR consults before inserting, so the delete sticks. Deliberately NOT read by the ~10 reputation/review query paths: they keep reading the flag tables exactly as before, and clearing works by removing the row and preventing its return. Instance-local only — never broadcast, no effect on any other instance's view. Two lifetimes, because the two signals differ in kind: Signal A keys on immutable account-CREATION facts, so its clearance is PERMANENT (a re-arming one would re-flag the same pair forever on evidence that can never change); Signal B is behavioural, so its clearance stores a WATERMARK of the mutual-review count at clear time and re-fires once the pair adds another full signal's worth beyond it — forgiving the past without going blind to the future.",
		sql: `
CREATE TABLE IF NOT EXISTS moderation_flag_clearances (
    -- Which detector's flag this clears.  Scoped per signal so clearing a
    -- reciprocity flag does not silently also clear a related-accounts one.
    signal      varchar(16)  NOT NULL CHECK (signal IN ('reciprocity', 'related')),
    -- Canonically ordered (account_a < account_b), matching how both detectors
    -- store their pairs, so a clearance matches regardless of which way round
    -- the operator typed the two names.
    account_a   varchar(16)  NOT NULL,
    account_b   varchar(16)  NOT NULL,
    -- Signal B ONLY: the mutual-review count at the moment of clearing.
    -- Signal B is BEHAVIOURAL, so a clearance forgives what has happened
    -- without blinding the detector to what happens next: it re-fires once the
    -- pair accumulates another full signal's worth of mutual reviews beyond
    -- this mark.  Signal A leaves it NULL and the clearance is permanent --
    -- that signal keys on account-CREATION facts (same creator, first activity
    -- minutes apart) which are immutable, so a re-arming clearance would
    -- re-flag the same pair forever on evidence that can never change.
    watermark   integer      NULL CHECK (watermark IS NULL OR watermark >= 0),
    note        text         NOT NULL DEFAULT '',
    cleared_at  timestamptz  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (signal, account_a, account_b),
    CHECK (account_a < account_b),
    CHECK (length(note) <= 500)
);
`
	}	,
	{
		version: 51,
		description:
			"v1.8.12: widen moderation_flag_clearances.signal to all FOUR suppression signals. The clearance table shipped in v1.8.9 permitted only 'reciprocity' and 'related' — but the reputation summary in apps/indexer/src/api/feedback.ts suppresses on FOUR tables: it also excludes feedback matched by one_way_pile_on (Signal C) and review_concentration (Signal D). Those two were therefore unclearable at the DATABASE level, not merely missing from the CLI: an operator could delete the row by hand, and the detector re-created it on its next pass, so a false positive suppressed a reputation permanently with no recourse. The maintainer hit exactly that — two review_concentration rows on his own test accounts, invisible to `morphit-ops moderation` (which only ever queried two of the four tables), deleted by hand, reputations restored, and suppressed again on the next detector run. Widening the CHECK is the schema half; detectReviewConcentrationInTx now consults the table like Signals A and B already did, and clearFlag/unclearFlag accept all four. No data migration: existing rows keep their values and every previously-valid signal stays valid, so this only ADDS permitted values.",
		sql: `
ALTER TABLE moderation_flag_clearances
    DROP CONSTRAINT IF EXISTS moderation_flag_clearances_signal_check;

ALTER TABLE moderation_flag_clearances
    ADD CONSTRAINT moderation_flag_clearances_signal_check
    CHECK (signal IN ('reciprocity', 'related', 'pile_on', 'concentration'));
`
	}	,
	{
		version: 52,
		description:
			"v1.9.0: add orders.specific_barter_title. For a BARTER (goods/services) listing, the seller's own short label for WHAT they're offering (e.g. 'bananas'), typed inline where the order summary would otherwise read the generic 'goods/services'. It flows into the order title ('…of bananas') and the on-chain Blurt announcement. Letters-only, ≤24 chars, validated on ingest (order.ts / orderReplace.ts); NULL for every crypto order and for a blank barter title. Additive + backward-compatible: older payloads omit it, older indexers ignore it. No index — it's a display label, never a filter key.",
		sql: `
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS specific_barter_title TEXT;

COMMENT ON COLUMN orders.specific_barter_title IS
    'v1.9.0: for a BARTER (goods/services) order, the seller''s short '
    'letters-only (<=24 chars) label for what is on offer (e.g. bananas), '
    'shown inline in place of the generic goods/services text and folded '
    'into the order title + on-chain announcement. NULL for crypto orders.';
`
	}	,
	{
		version: 53,
		description:
			"v1.9.x: add releases.distribution (JSONB, nullable). The optional decentralized-distribution anchor from morphit_release_v1 (source_sha256, gpg_fingerprint, ipfs_cid, ipns_name, mirrors) was validated on ingest since cp556 but NOT stored (\"downloaders read it from the chain\"). It is now persisted so (a) /v1/release can surface ipfs_cid/ipns_name, and (b) every instance's built-in IPFS release-pinning service can read the current release's ipfs_cid from its OWN indexer and `ipfs pin add` it — decentralizing release availability off any single pinning provider. Additive + backward-compatible: pre-existing rows get NULL (back-filled naturally as new releases are indexed / after a reindex); older indexers ignore the column. No index — read one-row-latest alongside the existing valid/created_at path.",
		sql: `
ALTER TABLE releases
    ADD COLUMN IF NOT EXISTS distribution JSONB;

COMMENT ON COLUMN releases.distribution IS
    'v1.9.x: optional decentralized-distribution anchor from '
    'morphit_release_v1 (source_sha256, gpg_fingerprint, ipfs_cid, '
    'ipns_name, mirrors). Surfaced via /v1/release; read by each '
    'instance''s IPFS release-pinning service to pin ipfs_cid. NULL when '
    'the release op carried no distribution block.';
`
	},
	{
		version: 54,
		description:
			'v1.12.0: rpc_directory — persist the latest trusted on-chain RPC-node directory (morphit_rpc_v1) so hidden nodes it added survive an indexer restart. Single row (id=1); the handler upserts on each trusted op, the indexer merges it into the pool at startup.',
		// The morphit_rpc_v1 handler merges directory nodes into the live pool, but
		// a restart re-indexes FORWARD from the last block, so it wouldn't re-see an
		// older directory op → directory-only nodes were lost until re-broadcast.
		// This table persists the latest trusted directory (a single row, latest-
		// wins by block) so startup can reload + re-merge it. The baked
		// DEFAULT_HIDDEN_BLURT_RPC_ENDPOINTS already cover Star/Jade regardless;
		// this closes the gap for any node added ONLY via the directory.
		sql: `
CREATE TABLE IF NOT EXISTS rpc_directory (
    id            SMALLINT     PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    endpoints     TEXT[]       NOT NULL,
    node_count    INT          NOT NULL,
    published_ts  TIMESTAMPTZ  NOT NULL,
    block_num     BIGINT       NOT NULL,
    updated_at    TIMESTAMPTZ  NOT NULL DEFAULT now()
);

COMMENT ON TABLE rpc_directory IS
    'v1.12.0: the latest TRUSTED on-chain RPC-node directory (morphit_rpc_v1 from '
    '@morphit). Single row (id=1), latest-wins by block_num. endpoints = the '
    'flattened .onion/.b32.i2p URLs; the indexer merges them into its hidden RPC '
    'pool at startup so directory-only nodes survive a restart.';
`
	},

	{
		version: 55,
		description:
			'rpc_directory.node_names — persist each directory node\'s OPTIONAL operator handle (url→name), so a misbehaving node can be identified on the /v1/rpc-endpoints JSON. Cosmetic + untrusted; empty {} when no node set a name. Idempotent additive column.',
		sql: `
ALTER TABLE rpc_directory
    ADD COLUMN IF NOT EXISTS node_names JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN rpc_directory.node_names IS
    'Optional per-node operator handles from the morphit_rpc_v1 op: a sparse '
    'url→name map (both of a node''s addresses share its name). Cosmetic + '
    'untrusted; never used to route/dedupe/trust. {} when no node published a name.';
`
	},
	{
		version: 56,
		description:
			'orders.lang — the language an order is written in (one of the 10 supported locale codes), for the orderbook language filter. Optional/additive: NULL on every order created before this feature, and those untagged orders are always shown (never hidden by the filter).',
		sql: `
ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS lang TEXT;

CREATE INDEX IF NOT EXISTS idx_orders_lang
    ON orders (lang)
    WHERE lang IS NOT NULL;

COMMENT ON COLUMN orders.lang IS
    'Language the order text is written in (a SUPPORTED_LOCALES code: en/es/de/'
    'pl/fr/it/ru/fa/zh-CN/zh-HK). NULL = untagged (created before the feature, '
    'or unspecified); untagged orders are NEVER hidden by the language filter.';
`
	},

	{
		version: 57,
		description:
			'operators.reg_alt_networks — hidden-service addresses (Tor/I2P/Lokinet/ENS) an operator publishes ON-CHAIN via morphit_operator_register_v1, so the federation can reach a clearnet-censored node over Tor without first completing a (blocked) clearnet probe. Optional/additive: NULL for operators that published none.',
		sql: `
ALTER TABLE operators
    ADD COLUMN IF NOT EXISTS reg_alt_networks JSONB;

COMMENT ON COLUMN operators.reg_alt_networks IS
    'On-chain-published hidden-service addresses {tor,i2p_b32,i2p_name,lokinet,ens} '
    '(host strings, no scheme). Lets the federation probe a censored node over Tor/I2P. '
    'NULL when the operator published none.';
`
	},

	{
		version: 58,
		description:
			'operators.last_action_block_num — block of the most recent morphit op this operator account signed. The v1.15.3 federation probe (clearnet_blocked "Fix B") SELECTed o.last_action_block_num from operators before this column existed, which threw on EVERY probe scan (column ... does not exist) — so no instance was ever re-probed and directory cached fields went stale. This adds the column (additive/nullable) and backfills it to registered_in_block so existing operators start with a sane baseline.',
		sql: `
ALTER TABLE operators
    ADD COLUMN IF NOT EXISTS last_action_block_num BIGINT;

UPDATE operators
    SET last_action_block_num = registered_in_block
    WHERE last_action_block_num IS NULL;

COMMENT ON COLUMN operators.last_action_block_num IS
    'Block of the most recent morphit op this operator account signed (advanced '
    'on every register; seeded to registered_in_block). The federation probe '
    'compares it to chain head to tell a clearnet-censored-but-alive node '
    '(clearnet_blocked) from a dead one (unreachable). v1.15.3 SELECTed this '
    'column before it existed, crashing every probe scan; v58 adds it.';
`
	}

	,{
		version: 59,
		description:
			'known_instances.cached_clearnet_eliminated — the peer\'s clearnet-elimination gate, captured by the federation probe from its /v1/instance so the directory card can show the strong "Zero use of clearnet internet" claim (v1.16.1). Additive/nullable with a false default; the probe overwrites it every cycle, older peers that don\'t report it stay false.',
		sql: `
ALTER TABLE known_instances
    ADD COLUMN IF NOT EXISTS cached_clearnet_eliminated BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN known_instances.cached_clearnet_eliminated IS
    'The peer''s clearnet_eliminated gate (from its /v1/instance), cached by the '
    'federation probe. TRUE only when the peer proved every private-transport leg '
    '(chain/Tor/I2P/price/frontend/upgrade/matrix). Drives the strong '
    '"Zero use of clearnet internet" directory label. v1.16.1.';
`
	}

	,{
		version: 60,
		description:
			'push_pending.source_trx_id — correct the column comment. v43 described it as "the on-chain trx id" and said feedback left it NULL. Feedback became two-path and keyed in v1.5.5, and since v1.18.0 its key is namespaced (feedback:<trx id>) so a review and a chat message carried by ONE transaction no longer collide on (account, source_trx_id) and silently drop one notification (F17b). Comment only; no data or index change.',
		// Why a migration for a comment: `\d+ push_pending` is what an operator
		// reads when a notification goes missing, and the v43 text sends them
		// looking for a NULL that is not there and a bare trx id that no longer is.
		// COMMENT ON is idempotent, so this is safe on fresh and upgraded DBs alike.
		sql: `
COMMENT ON COLUMN push_pending.source_trx_id IS
    'Dedup key shared by the fast (head-block) and durable enqueues of ONE source '
    'operation; the partial UNIQUE (account, source_trx_id) makes the later INSERT '
    'a no-op, so exactly one push is delivered. Chat: the on-chain trx id. Feedback: '
    '''feedback:'' || trx id — namespaced because one transaction can carry a chat '
    'op and a review for the same account (F17b, v1.18.0). NULL for single-path '
    'pushes (featureBid outbid); the partial index ignores NULLs. A dedup key only: '
    'nothing reads it back as a trx id.';
`
	}

	,{
		version: 61,
		description:
			'accounts.posting_key_reconciled — FALSE until this row\'s posting_pubkey has been confirmed against the chain. Rows written before v1.18.0 recorded the key at first observation and never again, so an account that rotated its posting key away from a LEAKED key before upgrading still holds the leaked key here, and the fast path verifies pushed chat against this column. Every existing row starts FALSE; the dispatcher writes TRUE with the keys it records; the boot backfill reconciles the rest against the chain; the fast path asks the chain before trusting a FALSE row. Additive, with a default.',
		// A column rather than a one-off sweep: the sweep alone would leave a
		// window — minutes on a big table — in which the leaked key still
		// verified, and the flag is what lets the fast path refuse to trust an
		// unconfirmed key during that window. ADD COLUMN IF NOT EXISTS is
		// idempotent, and the DEFAULT gives every existing row FALSE.
		sql: `
ALTER TABLE accounts
    ADD COLUMN IF NOT EXISTS posting_key_reconciled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN accounts.posting_key_reconciled IS
    'TRUE once posting_pubkey is known to match the chain: written by the '
    'dispatcher from an account create or account_update op, or by the boot '
    'backfill from a chain read. FALSE rows date from before v1.18.0, when the '
    'key was recorded once and never updated, and may hold a key the owner has '
    'since rotated away from; the fast path re-reads the chain before trusting one.';
`
	}

	,{
		version: 62,
		description:
			'accounts: partial index on unconfirmed posting keys, and corrected posting_key_reconciled and operators.last_action_block_num comments. Since v1.20.0 (E1) the dispatcher records every posting key it reads from a block (create or rotation) UNCONFIRMED — a block is one RPC endpoint\'s word and nothing re-checks its signatures — and the reconcile confirms them against two agreeing operators every minute for the life of the process; the index keeps that idle pass cheap. Additive; comment-and-index only.',
		sql: `
-- Every posting key the dispatcher records — from an account create or an
-- account_update — is now UNCONFIRMED (a block is one RPC endpoint's word;
-- v1.20.0, E1), and the reconcile runs every minute
-- for the life of the process to confirm them against two agreeing operators.
-- This partial index keeps that idle pass one cheap lookup instead of a scan of
-- every account.
CREATE INDEX IF NOT EXISTS idx_accounts_posting_key_unreconciled
    ON accounts (name)
    WHERE posting_key_reconciled = FALSE;

COMMENT ON COLUMN accounts.posting_key_reconciled IS
    'TRUE once posting_pubkey is known to match the chain as confirmed by two '
    'agreeing RPC operators (the reconcile loop, or the boot fill of a NULL key). '
    'A key read from a block (an account create or an account_update) is written '
    'FALSE: blocks come from ONE endpoint, so it is that endpoint''s word until the '
    'reconcile confirms it (v1.20.0). The fast path re-reads the chain, through its '
    'quorum refresher, before trusting a FALSE row.';

COMMENT ON COLUMN operators.last_action_block_num IS
    'Block of the most recent applied Morphit op this operator account signed '
    '(any op — the dispatcher advances it; the register op too). The federation '
    'probe compares it to chain head to tell a clearnet-censored-but-alive node '
    '(clearnet_blocked) from a dead one (unreachable). Until v1.20.0 only the '
    'register op moved it, so it measured time since the last registration.';
`
	},
	{
		version: 63,
		description:
			'orders.fee_rechecked_at + partial index: the BTC/XMR external-fee re-check persists when it last asked the explorers about an order and selects least-recently-checked in SQL, with a per-account share and a cap on `missing` rows per pass (v1.20.0, G3 — an in-memory schedule let a flood of fake orders starve a real payer). Additive; nullable column, no backfill.',
		sql: `
-- The BTC/XMR fee re-check (apps/indexer/src/indexer/fee/externalFeeRecheck.ts)
-- records WHEN it last asked the explorers about an order, in the row, so it
-- can visit candidates least-recently-checked first IN SQL and survive a
-- restart. Before (v1.20.0, G3) the schedule lived in process memory and took
-- the oldest / never-checked rows first, so a steady or bursty flood of fake
-- orders starved a real payer's order forever. NULL = never re-checked.
-- Deliberately separate from updated_at, which the orderbook stream polls:
-- a re-check that changes nothing must not look like an order change.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS fee_rechecked_at TIMESTAMPTZ;

COMMENT ON COLUMN orders.fee_rechecked_at IS
    'When the BTC/XMR external-fee re-check last queried the explorers for this '
    'order (NULL = never). Drives least-recently-checked scheduling and the '
    'per-order spacing; never touches updated_at (v1.20.0, G3).';

-- Candidate lookup for the re-check: live BTC/XMR rows with a txid, in the
-- states the re-check visits, ordered by last check.
CREATE INDEX IF NOT EXISTS idx_orders_fee_recheck
    ON orders (fee_rechecked_at NULLS FIRST, created_at)
    WHERE status = 'live'
      AND fee_method IN ('btc', 'xmr')
      AND external_tx_id IS NOT NULL
      AND fee_status IN ('pending_external', 'verified_by_attestation', 'missing');
`
	}

	,{
		version: 64,
		description:
			'operator_fee_recipients (append-only on-chain fee_recipient history per operator, v1.20.0 G1: BLURT fees paid through another instance verify here), fee_reverify_done (local one-shot bookkeeping) and a partial index on underpaid live BLURT orders. Additive; no existing row changes (the boot reconcile back-fills the history from ops).',
		sql: `
-- v1.20.0 (G1) — cross-instance BLURT fees. The account each operator's
-- instance pays the 90 % owner leg of BLURT fees to, as registered on chain in
-- morphit_operator_register_v1's optional fee_recipient. APPEND-ONLY history:
-- one row per accepted register op carrying the field, at that op's block, so
-- a fee op is judged against the value in force AS OF its block and a later
-- change never flips an older verdict (replay-deterministic). Rows written live
-- by the register handler and rows back-filled at boot from ops (register
-- ops an older build applied without reading the field) are identical.
CREATE TABLE IF NOT EXISTS operator_fee_recipients (
    account TEXT NOT NULL,
    fee_recipient TEXT NOT NULL,
    effective_block BIGINT NOT NULL,
    effective_trx TEXT NOT NULL,
    -- Position inside the block, so "the latest row before block N" is
    -- chain order even with two registrations by one account in one block.
    trx_in_block INT NOT NULL DEFAULT 0,
    op_in_trx INT NOT NULL DEFAULT 0,
    PRIMARY KEY (account, effective_block, effective_trx)
);
CREATE INDEX IF NOT EXISTS operator_fee_recipients_latest_idx
    ON operator_fee_recipients (account, effective_block DESC, trx_in_block DESC, op_in_trx DESC);

COMMENT ON TABLE operator_fee_recipients IS
    'On-chain fee_recipient history per operator account (morphit_operator_register_v1, '
    'v1.20.0 G1). The owner leg of a BLURT fee op at block N may go to the tagged '
    'operator''s latest row with effective_block < N. Append-only.';

-- The one-shot G1 re-verification (apps/indexer/src/indexer/blurtFeeReverify.ts)
-- re-judges, with the original transaction fetched again from the chain, BLURT
-- fee ops this node judged BEFORE it knew the tagged operator's fee account
-- (orders stored underpaid, stranger fees rejected fee_underpaid). This
-- records which op it already re-judged, so each is fetched once. Local
-- bookkeeping: never exported in a snapshot.
CREATE TABLE IF NOT EXISTS fee_reverify_done (
    block_num BIGINT NOT NULL,
    trx_in_block INT NOT NULL,
    op_in_trx INT NOT NULL,
    op_id TEXT NOT NULL,
    outcome TEXT NOT NULL,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (block_num, trx_in_block, op_in_trx)
);

-- Candidate lookup for the order re-verification: live BLURT-fee orders this
-- node stored as underpaid.
CREATE INDEX IF NOT EXISTS idx_orders_blurt_underpaid
    ON orders (created_at DESC)
    WHERE status = 'live' AND fee_method = 'blurt' AND fee_status = 'underpaid';
`
	}

	,{
		version: 65,
		description:
			'MK-H2 (v1.20.0): per-order BTC fee addresses. btc_fee_address_log (chain-order numbering of BTC-fee order ops under the pinned treasury xpub, a rebuildable cache of ops + releases), orders.btc_fee_{xpub,index,address,sats,received_sats,unconfirmed_sats}, fee_status \'awaiting_payment\', a unique index so an address belongs to one order, and the re-check index for awaiting rows. M-X1: orders.xmr_tx_key (XMR fees are proven with the tx private key), bound-XMR columns xmr_payment_id / xmr_fee_address, the one-claim-per-txid index narrowed to unbound rows, and fee_status \'proof_unsupported\' set on stored OutProof-only XMR orders (they can never verify).',
		sql: `
-- v1.20.0 (MK-H2) — per-order BTC fee addresses. Once a release op pins the
-- treasury's BIP84 account xpub (treasury.btc.xpub), each BTC-fee order op
-- without a txid gets its own receive address n of that xpub, n numbered in
-- chain order from the event log (apps/indexer/src/indexer/fee/
-- btcFeeAddressIndex.ts). A payment to address n only ever verifies the order
-- that owns n, so a watcher can no longer claim someone else's payment.

-- The numbering, one row per participating order op (allocated or refused).
-- A CACHE of a pure function of \`ops\` + \`releases\`: safe to truncate, it is
-- rebuilt in chain order on the next BTC-fee order.
CREATE TABLE IF NOT EXISTS btc_fee_address_log (
    block_num BIGINT NOT NULL,
    trx_in_block INT NOT NULL,
    op_in_trx INT NOT NULL,
    block_time TIMESTAMPTZ NOT NULL,
    account TEXT NOT NULL,
    permlink TEXT NOT NULL,
    -- The treasury xpub in force for this op (canonical xpub… spelling).
    xpub TEXT NOT NULL,
    -- Receive index allocated, or NULL when refused.
    idx INT,
    -- Why no index: btc_fee_permlink_reused | btc_fee_daily_limit.
    refused TEXT,
    PRIMARY KEY (block_num, trx_in_block, op_in_trx),
    CHECK ((idx IS NULL) <> (refused IS NULL))
);
-- One owner per address, ever.
CREATE UNIQUE INDEX IF NOT EXISTS btc_fee_address_log_idx_uniq
    ON btc_fee_address_log (xpub, idx) WHERE idx IS NOT NULL;
CREATE INDEX IF NOT EXISTS btc_fee_address_log_account_time_idx
    ON btc_fee_address_log (account, block_time);
CREATE INDEX IF NOT EXISTS btc_fee_address_log_account_permlink_idx
    ON btc_fee_address_log (account, permlink);

COMMENT ON TABLE btc_fee_address_log IS
    'MK-H2 (v1.20.0): chain-order numbering of BTC-fee order ops that pay to a '
    'per-order address of the pinned treasury xpub. Derived from ops + releases '
    'only (never from instance settings), so every indexer numbers alike; a cache '
    'that is rebuilt from the event log when truncated.';

-- The order's own copy of its address and what has been seen paid to it.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS btc_fee_xpub TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS btc_fee_index INT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS btc_fee_address TEXT;
-- Amount asked for when the order was posted (the pin in force at its block).
ALTER TABLE orders ADD COLUMN IF NOT EXISTS btc_fee_sats BIGINT;
-- Last explorer answer: confirmed total received, and still-unconfirmed total.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS btc_fee_received_sats BIGINT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS btc_fee_unconfirmed_sats BIGINT;

COMMENT ON COLUMN orders.btc_fee_address IS
    'MK-H2: this order''s own BTC fee address (receive index btc_fee_index of '
    'btc_fee_xpub). NULL for every other fee path, incl. txid-mode BTC orders.';

-- An address belongs to exactly one order.
CREATE UNIQUE INDEX IF NOT EXISTS orders_btc_fee_address_uniq
    ON orders (btc_fee_address) WHERE btc_fee_address IS NOT NULL;

-- New fee_status values: 'awaiting_payment' (M-X1 adds 'proof_unsupported',
-- below). 'awaiting_payment': the order is posted and waiting for its BTC payment. Not
-- 'pending_external' on purpose — that state can be promoted by attestation,
-- and a per-order address needs no attestation: the explorers answer.
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_fee_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_fee_status_check CHECK (
    fee_status IN (
        'unverified',
        'verified',
        'missing',
        'underpaid',
        'pending_external',
        'verified_by_attestation',
        'reused',
        'awaiting_payment',
        'proof_unsupported'
    )
);

-- Candidate lookup for the re-check of per-order addresses.
CREATE INDEX IF NOT EXISTS idx_orders_btc_fee_awaiting
    ON orders (fee_rechecked_at NULLS FIRST, created_at)
    WHERE status = 'live'
      AND fee_method = 'btc'
      AND btc_fee_address IS NOT NULL
      AND fee_status = 'awaiting_payment';

-- (v1.20.0, M-X1) XMR fees are proven with the payer's transaction PRIVATE
-- key: the upstream explorer's txprove mode parses exactly a 64-hex key, so
-- the OutProof strings orders carried until now could never verify.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS xmr_tx_key TEXT;
-- (MK-H2) Bound XMR fees: the payment ID the payment must carry (16 hex) and
-- the pinned primary address it was proven at. NULL for unbound orders.
ALTER TABLE orders ADD COLUMN IF NOT EXISTS xmr_payment_id TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS xmr_fee_address TEXT;

COMMENT ON COLUMN orders.xmr_payment_id IS
    'MK-H2: for an XMR fee paid after the treasury primary address was pinned, '
    'the order''s payment ID (keccak256("morphit-fee-v1|account/permlink")[0..8], hex). '
    'The payment only verifies if its encrypted payment ID decrypts to this.';

-- A bound payment can only ever verify for the order whose payment ID it
-- carries, so it needs no first-claim-wins rule — and must not have one: a
-- front-runner copying the txid would otherwise make the real payer's row
-- collide. The one-claim-per-txid index now covers unbound rows only.
DROP INDEX IF EXISTS orders_external_tx_id_uniq;
CREATE UNIQUE INDEX IF NOT EXISTS orders_external_tx_id_uniq
    ON orders (fee_method, external_tx_id)
    WHERE external_tx_id IS NOT NULL AND xmr_payment_id IS NULL;
-- ...and among bound rows, one (txid, payment ID) pair pays one order: two
-- permlinks of one account can be made to share an 8-byte payment ID by a
-- birthday search, and one payment would otherwise pay for both. The order
-- handler stores the later claim as 'reused' (txid NULL) before this fires.
CREATE UNIQUE INDEX IF NOT EXISTS orders_xmr_bound_payment_uniq
    ON orders (external_tx_id, xmr_payment_id)
    WHERE external_tx_id IS NOT NULL AND xmr_payment_id IS NOT NULL;

-- Stored XMR orders that carry only an OutProof can never verify (see above):
-- say so with their own status instead of the misleading 'missing' /
-- 'pending_external', and take them out of the re-check rotation. A pure
-- function of each row, so every node lands on the same status; a node that
-- replays the op stores the same row at intake. The txid is released (NULL,
-- like a 'reused' row) so the payer can re-post the same payment with its tx
-- key; the proof string stays for the record.
UPDATE orders
   SET fee_status = 'proof_unsupported', external_tx_id = NULL, updated_at = NOW()
 WHERE fee_method = 'xmr'
   AND xmr_tx_key IS NULL
   AND tx_proof LIKE 'OutProof%'
   AND fee_status IN ('unverified', 'missing', 'pending_external', 'verified_by_attestation');
`
	}

	,{
		version: 66,
		description:
			'Indexes for chat sender/recipient lookups, Signal A (creator, first_activity_at) and avatar uniqueness; at most one queued dust_refill per recipient (duplicates removed); push_subscriptions keep no User-Agent and only a supported locale code; order_views keeps no view time; operator_attribution_events no longer unique on trx_id; every confirmed posting key re-confirmed by the two-operator quorum; account_loyalty.canonical_blurt_paid for the attestor loyalty gate. Idempotent.',
		dataSteps: [
			{
				// until this release a posting key could be CONFIRMED by a
				// quorum that had shrunk to one RPC operator, and those rows cannot
				// be told apart from ones two operators confirmed. All go back to
				// unconfirmed; the reconcile loop re-confirms them with the fixed
				// two-operator quorum, and until then the fast path asks the chain.
				label: 'posting keys set to unconfirmed for re-confirmation',
				sql: `UPDATE accounts SET posting_key_reconciled = FALSE WHERE posting_key_reconciled`
			}
		],
		sql: `
-- Chat lookups by sender and by recipient. The stranger gate, the fan-in and
-- per-pair limits and the verified-chat gate run inside the block transaction
-- for every incoming chat message, and the inbox query filters on
-- \`sender = $1 OR recipient = $1\`; chat_pair_idx (LEAST/GREATEST) serves none
-- of those predicates, so each was a full scan of chat_messages.
CREATE INDEX IF NOT EXISTS chat_messages_sender_idx
    ON chat_messages (sender, recipient, created_at);
CREATE INDEX IF NOT EXISTS chat_messages_recipient_idx
    ON chat_messages (recipient, created_at);

-- Signal A groups accounts by creator and compares first-activity times.
CREATE INDEX IF NOT EXISTS accounts_creator_first_activity_idx
    ON accounts (creator, first_activity_at)
    WHERE first_activity_at IS NOT NULL;

-- At most one queued (not yet broadcast) low-balance refill per recipient.
-- The scanner's INSERT ... WHERE NOT EXISTS is not atomic under READ
-- COMMITTED, so two scanners could both queue one. Existing duplicates are
-- removed first (the oldest queued row is kept) so the index can be built.
DELETE FROM relay_pending_transfers d
 USING relay_pending_transfers k
 WHERE d.reason = 'dust_refill' AND d.broadcast_at IS NULL
   AND k.reason = 'dust_refill' AND k.broadcast_at IS NULL
   AND k.recipient = d.recipient
   AND k.id < d.id;
CREATE UNIQUE INDEX IF NOT EXISTS relay_pending_transfers_dust_refill_queued_uidx
    ON relay_pending_transfers (recipient)
    WHERE reason = 'dust_refill' AND broadcast_at IS NULL;

-- Avatar uniqueness: the profile handler looks for another account holding
-- the same image on every profile op. Hash indexes, because an avatar value
-- can be several KB, more than a B-tree entry may hold.
CREATE INDEX IF NOT EXISTS profiles_avatar_svg_hash_idx
    ON profiles USING hash ((json_metadata->>'avatar_svg'))
    WHERE json_metadata->>'avatar_svg' IS NOT NULL;
CREATE INDEX IF NOT EXISTS profiles_avatar_data_uri_hash_idx
    ON profiles USING hash ((json_metadata->>'avatar_data_uri'))
    WHERE json_metadata->>'avatar_data_uri' IS NOT NULL;

-- Push subscriptions no longer keep the browser's User-Agent (nothing reads
-- it), and keep the language only as one of the 10 supported locale codes,
-- mapped the way the push localizer maps it (pushLocalize.normalizeLocale).
UPDATE push_subscriptions SET user_agent = NULL WHERE user_agent IS NOT NULL;
UPDATE push_subscriptions
   SET locale = CASE
           WHEN split_part(locale, '-', 1) IN ('en', 'es', 'fr', 'de', 'it', 'pl', 'ru', 'fa')
               THEN split_part(locale, '-', 1)
           WHEN split_part(locale, '-', 1) = 'zh'
               THEN CASE WHEN locale ~ '(Hant|TW|HK)' THEN 'zh-HK' ELSE 'zh-CN' END
           ELSE 'en'
       END
 WHERE locale NOT IN ('en', 'es', 'fr', 'de', 'it', 'pl', 'ru', 'fa', 'zh-CN', 'zh-HK');
COMMENT ON COLUMN push_subscriptions.user_agent IS
    'Not stored: always NULL. Kept only so an older relay that still writes '
    'the column does not fail.';
COMMENT ON COLUMN push_subscriptions.locale IS
    'One of the 10 supported locale codes, used to localize push text.';

-- Order view counter: no time of any view is kept or served, only the count.
ALTER TABLE order_views ALTER COLUMN updated_at DROP NOT NULL;
ALTER TABLE order_views ALTER COLUMN updated_at DROP DEFAULT;
UPDATE order_views SET updated_at = NULL WHERE updated_at IS NOT NULL;
COMMENT ON COLUMN order_views.updated_at IS
    'Not stored: always NULL. A last-view time would let anyone correlate '
    'views with outside events.';

-- One transaction may carry two fee-paid orders, each with its own operator
-- attribution; a UNIQUE trx_id made the second one's earnings row collide and
-- go missing. (order_account, order_permlink) stays unique, which is what
-- keeps a replayed block from crediting an order twice.
ALTER TABLE operator_attribution_events
    DROP CONSTRAINT IF EXISTS operator_attribution_events_trx_id_key;

-- The directory's zero-clearnet badge is the peer's own claim. An instance
-- registered at a clearnet origin serves clearnet, so its claim is never kept
-- (federationProbe.clearnetEliminatedClaimAccepted); clear any stored before.
UPDATE known_instances SET cached_clearnet_eliminated = FALSE
 WHERE cached_clearnet_eliminated
   AND lower(coalesce(substring(origin from '^[A-Za-z][A-Za-z0-9+.-]*://([^/:?#]+)'), ''))
       !~ '(^[a-z2-7]{56}\\.onion|\\.i2p|\\.loki)$';
COMMENT ON COLUMN known_instances.cached_clearnet_eliminated IS
    'The peer''s own clearnet_eliminated claim from its /v1/instance, kept TRUE '
    'only for an instance whose registered origin is an onion, I2P or Lokinet '
    'address: one registered at a clearnet origin serves clearnet.';

-- The attestor loyalty gate's measure: BLURT this account paid to the
-- canonical treasury in listing fees from CONSENSUS_V2_ACTIVATION_TIME on. No
-- backfill: the legs of older fees are not stored anywhere chain-derived, so an
-- upgraded node and a fresh replay hold the same value.
ALTER TABLE account_loyalty
    ADD COLUMN IF NOT EXISTS canonical_blurt_paid NUMERIC NOT NULL DEFAULT 0
    CHECK (canonical_blurt_paid >= 0);
COMMENT ON COLUMN account_loyalty.canonical_blurt_paid IS
    'BLURT this account paid to the canonical treasury in listing fees from '
    'CONSENSUS_V2_ACTIVATION_TIME on; the attestor loyalty gate reads this, not '
    'cumulative_blurt_paid (an owner leg can go to an account the payer controls).';
`
	}

	// Future migrations land here.  The v1 collapsed schema is the
	// pre-launch baseline; from v37 forward, every new schema change is its
	// own additive migration with its own version number.  No further
	// collapse should happen until well after 1.0.0 ships.
	,{
		version: 67,
		description:
			'orders.lang — correct the column comment: since v1.21.1 a language filter lists only orders tagged with one of its languages (untagged orders, posted before v1.15.0, show only with no language chosen). Comment only; no data or index change.',
		// Why a migration for a comment: `\d+ orders` must not tell an operator
		// the opposite of what the orderbook does. COMMENT ON is idempotent.
		sql: `
COMMENT ON COLUMN orders.lang IS
    'Language the order text is written in (a SUPPORTED_LOCALES code: en/es/de/'
    'pl/fr/it/ru/fa/zh-CN/zh-HK). NULL = untagged (created before the feature, '
    'or unspecified). A language filter lists only orders tagged with one of its '
    'languages (v1.21.1); with no language chosen, untagged orders show too.';
`
	}
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

/** Advisory-lock key serialising migration runners ("morphit-migrate"). */
const MIGRATION_LOCK_KEY = 0x6d6f7270_6d696772n;

/** Check which migration versions are already applied. */
async function appliedVersions(db: Database): Promise<Set<number>> {
	// Create the tracking table if it's the first run, under the runners'
	// lock (two concurrent CREATE TABLE IF NOT EXISTS can still collide).
	// We do this outside the migration transaction loop because the schema_migrations
	// table must exist before we can query it.
	await db.withTx(async (client) => {
		await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
		await client.query(`
			CREATE TABLE IF NOT EXISTS schema_migrations (
				version INT PRIMARY KEY,
				applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				description TEXT NOT NULL
			)
		`);
	});
	const res = await db.query<{ version: number }>('SELECT version FROM schema_migrations');
	return new Set(res.rows.map((r) => r.version));
}

/** The highest schema version this build knows how to run — the declared
 *  version of the last migration (versions are strictly increasing and
 *  gap-free by the contract validated above; subsumed versions are lower).
 *  Used by the snapshot bootstrap to REFUSE a snapshot whose schema is newer
 *  than this code could run, and to confirm a restored DB matches this build. */
export function latestSchemaVersion(): number {
	const last = MIGRATIONS[MIGRATIONS.length - 1];
	return last ? last.version : 0;
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
		const stepRows: { label: string; rows: number }[] = [];
		const ran = await db.withTx(async (client: pg.PoolClient) => {
			// One runner at a time; under the lock, re-check — another runner
			// may have applied this version while we waited.
			await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATION_LOCK_KEY.toString()]);
			const done = await client.query('SELECT 1 FROM schema_migrations WHERE version = $1', [
				m.version
			]);
			if ((done.rowCount ?? 0) > 0) return false;
			await client.query(sql);
			for (const step of m.dataSteps ?? []) {
				const r = await client.query(step.sql);
				stepRows.push({ label: step.label, rows: r.rowCount ?? 0 });
			}
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
			return true;
		});
		if (!ran) {
			skipped.push(m.version);
			continue;
		}
		for (const st of stepRows) {
			log.info('migration_data_step', { version: m.version, step: st.label, rows: st.rows });
		}
		applied.push(m.version);
	}

	return { applied, skipped };
}

/** CLI entry point. Usage:
 *    tsx src/db/migrations.ts              → apply pending migrations
 */
async function main(): Promise<void> {
	if (process.argv.includes('--rebuild-materialized')) {
		// Never implemented: it used to do nothing and report success.
		log.error('rebuild_materialized_not_available', {
			hint: 'nothing is rebuilt; to re-derive the database, reset it and let the indexer re-sync from the chain'
		});
		process.exitCode = 2;
		return;
	}
	const config = loadConfig();
	const db = createDatabase(config);
	try {
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
