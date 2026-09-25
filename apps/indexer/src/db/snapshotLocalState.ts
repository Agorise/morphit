/**
 * apps/indexer/src/db/snapshotLocalState.ts — v1.18.0 deep-deep (rv2-5, rv2-1c)
 *
 * What a published indexer snapshot may carry, and what a restore must scrub.
 *
 * A snapshot is pinned on public IPFS and re-served by every instance, so it
 * must hold only state DERIVED FROM THE CHAIN — things any node could rebuild
 * by replaying blocks. The export used to dump the whole database, and the
 * relay shares that database: every push subscription (device endpoint token,
 * keys, user agent, locale) and the push queue went out with it, tying
 * pseudonymous accounts to push-provider device identities. The relay's
 * pending-transfer queue went out too — and a node restoring it would have had
 * its own relay pay out the PUBLISHER's queued welcome bonuses and refills from
 * its own wallet.
 *
 * `LOCAL_ONLY_TABLES` is the list whose rows are exported as EMPTY and wiped
 * on restore (an older snapshot still carries them). `CHAIN_DERIVED_TABLES` is
 * everything else. Every table in schema.sql must be in exactly one of the two
 * lists — the snapshot-local-state test fails on an unclassified table, so a
 * new table cannot leak by default.
 */
import type { Database } from './pool.js';

/** Tables whose rows never leave this box in a snapshot. */
export const LOCAL_ONLY_TABLES: readonly string[] = [
	// Relay push: device endpoints + keys + user agents, and the delivery queue.
	'push_subscriptions',
	'push_pending',
	// Relay payout queue: THIS operator's wallet's pending transfers.
	'relay_pending_transfers',
	// Local view counters served by this instance's API.
	'order_views',
	// This instance's own price observations (its peers, its feeds).
	'price_drift_baseline',
	'price_peer_observations',
	// This operator's moderation decisions.
	'moderation_flag_clearances',
	// The RPC directory row is chain-derived, but the RELAY merges it into its
	// pool at boot, before the indexer has re-verified it against the signed
	// op (rv2-4). A restored row is the publisher's word, so it never travels:
	// the node picks the directory up again from the next signed directory op.
	'rpc_directory'
];

/** Tables rebuilt from the chain (ops, derived views, detector output over
 *  chain data). `operator_blocks` is mixed: its `origin = 'local'` rows are
 *  this operator's own blocks and are handled row by row. */
export const CHAIN_DERIVED_TABLES: readonly string[] = [
	'account_loyalty',
	'account_loyalty_milestones',
	'accounts',
	'blocks',
	'chat_folders',
	'chat_identities',
	'chat_messages',
	'chat_read_state',
	'featured_slot_bids',
	'fee_attestations',
	'fee_transfers',
	'feedback',
	'feedback_responses',
	'indexer_state',
	'instance_payment_methods',
	'known_instances',
	'one_way_pile_on',
	'operator_attribution_events',
	'operator_blocks',
	'operator_earnings',
	'operator_registration_events',
	'operators',
	'ops',
	'orders',
	'profiles',
	'related_accounts',
	'releases',
	'review_concentration',
	'schema_migrations',
	'stranger_fees',
	'suspicious_reciprocity',
	'trade_concentration',
	'user_settings',
	'witness_fee_history'
];

/** `pg_dump` arguments that keep local-only rows out of the dump. */
export function exportExclusionArgs(): string[] {
	return [
		...LOCAL_ONLY_TABLES.map((t) => `--exclude-table-data=public.${t}`),
		// Mixed table: its chain rows are appended separately (snapshot-export).
		'--exclude-table-data=public.operator_blocks'
	];
}

/**
 * Wipe local-only state a restored snapshot brought with it (an older
 * snapshot, or one from a publisher on an older build, still carries it).
 * Returns the number of rows removed. Tables absent from an older schema are
 * skipped.
 */
export async function scrubRestoredLocalState(db: Database): Promise<number> {
	const present = await db.query<{ table_name: string }>(
		`SELECT table_name FROM information_schema.tables
		  WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'`
	);
	const have = new Set(present.rows.map((r) => r.table_name));
	let removed = 0;
	for (const t of LOCAL_ONLY_TABLES) {
		if (!have.has(t)) continue;
		const r = await db.query(`DELETE FROM ${t}`);
		removed += r.rowCount ?? 0;
	}
	if (have.has('operator_blocks')) {
		const col = await db.query(
			`SELECT 1 FROM information_schema.columns
			  WHERE table_schema = current_schema() AND table_name = 'operator_blocks' AND column_name = 'origin'`
		);
		if ((col.rowCount ?? 0) > 0) {
			const r = await db.query(`DELETE FROM operator_blocks WHERE origin = 'local'`);
			removed += r.rowCount ?? 0;
		}
	}
	return removed;
}

/** Function and trigger names schema.sql itself creates (kept on restore). */
export function schemaRoutineNames(schemaSql: string): {
	functions: Set<string>;
	triggers: Set<string>;
} {
	const functions = new Set<string>();
	const triggers = new Set<string>();
	const noComments = schemaSql.replace(/--[^\n]*/g, '');
	for (const m of noComments.matchAll(
		/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:FUNCTION|PROCEDURE)\s+(?:public\.)?"?([a-z_][a-z0-9_]*)"?\s*\(/gi
	)) {
		functions.add(m[1]!.toLowerCase());
	}
	for (const m of noComments.matchAll(
		/\bCREATE\s+(?:OR\s+REPLACE\s+)?(?:CONSTRAINT\s+)?TRIGGER\s+"?([a-z_][a-z0-9_]*)"?/gi
	)) {
		triggers.add(m[1]!.toLowerCase());
	}
	return { functions, triggers };
}

/**
 * Drop every routine, trigger, rule and event trigger a restored dump created
 * that schema.sql does not (rv2-1c). A snapshot is DATA; any code it carries
 * would otherwise run on this node — a trigger fires on the indexer's own
 * writes, an event trigger on its next migration. Returns what was dropped,
 * as human-readable names.
 */
export async function dropRoutinesNotInSchema(db: Database, schemaSql: string): Promise<string[]> {
	const keep = schemaRoutineNames(schemaSql);
	const dropped: string[] = [];

	// Event triggers first: they fire on the DDL below. Superuser-only to
	// create, so only a superuser restore can have any.
	const evt = await db
		.query<{ evtname: string }>(`SELECT evtname FROM pg_event_trigger`)
		.catch(() => ({
			rows: [] as Array<{ evtname: string }>
		}));
	for (const e of evt.rows) {
		await db.query(`DROP EVENT TRIGGER IF EXISTS ${quoteIdent(e.evtname)} CASCADE`);
		dropped.push(`event trigger ${e.evtname}`);
	}

	const trg = await db.query<{ tgname: string; rel: string }>(
		`SELECT t.tgname, format('%I.%I', n.nspname, c.relname) AS rel
		   FROM pg_trigger t
		   JOIN pg_class c ON c.oid = t.tgrelid
		   JOIN pg_namespace n ON n.oid = c.relnamespace
		  WHERE NOT t.tgisinternal
		    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
		    AND n.nspname NOT LIKE 'pg\\_%'`
	);
	for (const t of trg.rows) {
		if (keep.triggers.has(t.tgname.toLowerCase())) continue;
		await db.query(`DROP TRIGGER IF EXISTS ${quoteIdent(t.tgname)} ON ${t.rel} CASCADE`);
		dropped.push(`trigger ${t.tgname} on ${t.rel}`);
	}

	const rules = await db.query<{ rulename: string; rel: string }>(
		`SELECT r.rulename, format('%I.%I', n.nspname, c.relname) AS rel
		   FROM pg_rewrite r
		   JOIN pg_class c ON c.oid = r.ev_class
		   JOIN pg_namespace n ON n.oid = c.relnamespace
		  WHERE r.rulename <> '_RETURN'
		    AND n.nspname NOT IN ('pg_catalog', 'information_schema')
		    AND n.nspname NOT LIKE 'pg\\_%'`
	);
	for (const r of rules.rows) {
		await db.query(`DROP RULE IF EXISTS ${quoteIdent(r.rulename)} ON ${r.rel} CASCADE`);
		dropped.push(`rule ${r.rulename} on ${r.rel}`);
	}

	const fns = await db.query<{ name: string; sig: string; kind: string }>(
		`SELECT p.proname AS name, p.oid::regprocedure::text AS sig, p.prokind AS kind
		   FROM pg_proc p
		   JOIN pg_namespace n ON n.oid = p.pronamespace
		  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
		    AND n.nspname NOT LIKE 'pg\\_%'
		    AND NOT EXISTS (
		          SELECT 1 FROM pg_depend d
		           WHERE d.classid = 'pg_proc'::regclass AND d.objid = p.oid AND d.deptype = 'e')`
	);
	for (const f of fns.rows) {
		if (keep.functions.has(f.name.toLowerCase())) continue;
		const what = f.kind === 'p' ? 'PROCEDURE' : f.kind === 'a' ? 'AGGREGATE' : 'FUNCTION';
		await db.query(`DROP ${what} IF EXISTS ${f.sig} CASCADE`);
		dropped.push(`${what.toLowerCase()} ${f.sig}`);
	}
	return dropped;
}

function quoteIdent(s: string): string {
	return `"${s.replace(/"/g, '""')}"`;
}
