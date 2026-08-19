/**
 * apps/indexer/src/db/snapshotManifest.ts  (cp764)
 *
 * Indexer-DB snapshot bootstrap — the SAFETY CORE.
 *
 * WHY: syncing a fresh indexer by replaying ~3.5M blocks over hidden RPC (the
 * only transport a max-privacy tor-only box may use — it must not run a local
 * blurtd, whose p2p sync would leak its clearnet IP) takes days. A tor-only
 * operator who already runs a synced instance can instead RESTORE that instance's
 * indexer Postgres DB onto the new box and let it catch up only the small gap —
 * days → minutes, over any transport, with zero p2p footprint.
 *
 * TRUST MODEL (read this before widening it): restoring a snapshot means TRUSTING
 * the snapshot's derived state (orderbook, registrations, balances) instead of
 * re-deriving it from the chain. That is safe ONLY between an operator's OWN
 * boxes — you are trusting your own synced instance. This module deliberately
 * does NOT verify a third party's snapshot; a PUBLIC/federated snapshot would
 * need a signature + a trust decision about whose chain-view you accept, which is
 * a separate, deliberate step (tracked, not built here). The bootstrap script
 * refuses to run unless the operator explicitly acknowledges this (--i-trust-this-source).
 *
 * This file is PURE (no DB, no fs, no pg) so the compatibility rules that decide
 * whether a restore is SAFE are unit-tested exhaustively. A wrong "compatible"
 * verdict here could load a different chain's data or a schema this build can't
 * run — so every rule fails CLOSED.
 */

/** Bump when the on-disk snapshot layout changes incompatibly. */
export const SNAPSHOT_FORMAT_VERSION = 1;
export const MANIFEST_FILENAME = 'manifest.json';
export const DUMP_FILENAME = 'indexer.sql.gz';

/** What an exported snapshot records about the SOURCE DB it was taken from. */
export interface SnapshotManifest {
	readonly snapshotFormatVersion: number;
	/** Blurt chain id the source indexed. A mismatch is FATAL — the derived state
	 *  is meaningless (or dangerous) against a different chain. */
	readonly chainId: string;
	/** max(schema_migrations.version) on the source at export time. */
	readonly schemaVersion: number;
	/** indexer_state.last_applied_block on the source — where the target resumes. */
	readonly lastAppliedBlock: number;
	/** Postgres server major version of the source (dump portability guard). */
	readonly pgMajor: number;
	/** ISO timestamp of export. */
	readonly createdAt: string;
	/** Human label for provenance (e.g. the source instance origin). Advisory only. */
	readonly sourceLabel: string;
}

/** Facts about the TARGET box, read from its config + code at bootstrap time. */
export interface TargetFacts {
	/** MORPHIT_INDEXER_CHAIN_ID configured on the target. */
	readonly chainId: string;
	/** latestSchemaVersion() of the target's indexer BUILD. */
	readonly codeSchemaVersion: number;
	/** Postgres server major version on the target. */
	readonly pgMajor: number;
}

export interface VerifyResult {
	readonly ok: boolean;
	/** One line per failed rule, safe to print. Empty when ok. */
	readonly reasons: readonly string[];
	/** Non-fatal advisories (printed, don't block). */
	readonly warnings: readonly string[];
}

function isFiniteInt(n: unknown): n is number {
	return typeof n === 'number' && Number.isInteger(n) && Number.isFinite(n);
}

/** Parse + shape-validate a manifest read from disk. Returns null (never throws)
 *  on anything malformed, so the bootstrap treats a bad manifest as "refuse". */
export function parseManifest(raw: string): SnapshotManifest | null {
	let o: Record<string, unknown>;
	try {
		o = JSON.parse(raw) as Record<string, unknown>;
	} catch {
		return null;
	}
	if (!o || typeof o !== 'object') return null;
	const m = o as Partial<SnapshotManifest>;
	if (
		!isFiniteInt(m.snapshotFormatVersion) ||
		typeof m.chainId !== 'string' ||
		m.chainId.length === 0 ||
		!isFiniteInt(m.schemaVersion) ||
		m.schemaVersion < 0 ||
		!isFiniteInt(m.lastAppliedBlock) ||
		m.lastAppliedBlock < 0 ||
		!isFiniteInt(m.pgMajor) ||
		m.pgMajor <= 0 ||
		typeof m.createdAt !== 'string' ||
		typeof m.sourceLabel !== 'string'
	) {
		return null;
	}
	return {
		snapshotFormatVersion: m.snapshotFormatVersion,
		chainId: m.chainId,
		schemaVersion: m.schemaVersion,
		lastAppliedBlock: m.lastAppliedBlock,
		pgMajor: m.pgMajor,
		createdAt: m.createdAt,
		sourceLabel: m.sourceLabel
	};
}

export function buildManifest(facts: {
	chainId: string;
	schemaVersion: number;
	lastAppliedBlock: number;
	pgMajor: number;
	sourceLabel: string;
	now?: Date;
}): SnapshotManifest {
	return {
		snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
		chainId: facts.chainId,
		schemaVersion: facts.schemaVersion,
		lastAppliedBlock: facts.lastAppliedBlock,
		pgMajor: facts.pgMajor,
		createdAt: (facts.now ?? new Date()).toISOString(),
		sourceLabel: facts.sourceLabel
	};
}

/**
 * Decide whether `manifest` may be restored onto a box described by `target`.
 * Every rule fails CLOSED. Rules:
 *   - format version must be one this build understands;
 *   - chain id MUST match exactly (else the derived state is for another chain);
 *   - schema version must be <= the target build's version. A NEWER snapshot
 *     schema can't be run by this (older) code → refuse. An OLDER snapshot schema
 *     is fine: the indexer's own runMigrations forward-migrates it after restore
 *     (surfaced as a warning so the operator expects the migrate step);
 *   - a NEWER source Postgres major than the target's is refused (a dump from a
 *     newer server may not restore into an older one); older/equal is fine.
 */
export function verifyManifestCompatible(
	manifest: SnapshotManifest,
	target: TargetFacts
): VerifyResult {
	const reasons: string[] = [];
	const warnings: string[] = [];

	if (manifest.snapshotFormatVersion !== SNAPSHOT_FORMAT_VERSION) {
		reasons.push(
			`snapshot format v${manifest.snapshotFormatVersion} — this build only reads v${SNAPSHOT_FORMAT_VERSION}.`
		);
	}
	if (manifest.chainId !== target.chainId) {
		reasons.push(
			`chain mismatch: snapshot is for chain '${manifest.chainId}', this node indexes '${target.chainId}'. Restoring would load another chain's state.`
		);
	}
	if (manifest.schemaVersion > target.codeSchemaVersion) {
		reasons.push(
			`snapshot schema v${manifest.schemaVersion} is newer than this build's v${target.codeSchemaVersion} — upgrade this node before restoring.`
		);
	} else if (manifest.schemaVersion < target.codeSchemaVersion) {
		warnings.push(
			`snapshot schema v${manifest.schemaVersion} < build v${target.codeSchemaVersion}; the indexer will forward-migrate on first start.`
		);
	}
	if (manifest.pgMajor > target.pgMajor) {
		reasons.push(
			`snapshot came from PostgreSQL ${manifest.pgMajor}; this host runs ${target.pgMajor}. A dump from a newer server may not restore into an older one.`
		);
	}

	return { ok: reasons.length === 0, reasons, warnings };
}
